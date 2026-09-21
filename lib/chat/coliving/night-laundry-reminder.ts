import { z } from "zod";
import {
  EMPTY_FEATURE_USAGE,
  FEATURE_COMPOSE_MAX_OUTPUT_TOKENS,
  FEATURE_EXTRACT_MAX_OUTPUT_TOKENS,
  structuredCall,
} from "./feature-llm";
import type {
  ApprovedFeature,
  FeatureContext,
  FeatureDeps,
  FeatureExecution,
  FeatureExtraction,
} from "./feature-types";
import type { LanguageDecision, ResidentLanguage } from "./language";
import { deliverSms, resolveNamedRecipient, smsRecipientIneligibleReply } from "./sms-delivery";

/**
 * **已批准功能之一：夜间洗衣提醒。**
 *
 * 老板 2026-09-13 定稿后这是一个**真正的独立功能入口**，不是给主生成模型的工具、
 * 也不是"正文关键词验证器"：
 *
 *   1. `extract`：路由（`features.ts`，一次白名单调用）已经确认这是明确交办本功能后，
 *      由本功能自己的小 schema 只抽取**三个有限的类别字段**（设备类别 / 时段 /
 *      是否影响休息），**不收任何原始细节文本**。
 *   2. `execute`：收件人由**代码**从住户原话里绑定（点名且唯一），模型改不了；
 *      再把**只有这几个中性类别 + 收件人姓名**的输入交给模型写正文与短回执——
 *      **生成阶段看不到原始请求，看不到住户顺带夹带的其它诉求，也看不到来源情境**。
 *   3. 最后调纯代码的 `deliverSms` 落库投递。
 *
 * 不做大正则中文分类，不写死正文模板。语气质量靠 doctrine + 真实语料人工阅读
 * （见 `docs/USER_FACING_CAPABILITY_TRUTH.md`），机械检查只证明结构。
 */

export const NIGHT_LAUNDRY_FEATURE_ID = "night_laundry";
export const NIGHT_LAUNDRY_FEATURE_LABEL = "夜间洗衣提醒";
/**
 * 同一个功能的**自然英文显示名**（`feature-types.ts` 的 `labelEn`）。只在住户这一轮
 * 说英文时用于给住户看的正文与 grounding 校验；台账、`purposeLabel`、数据库那一侧仍用
 * `label`。**与 `label` 并排登记在这一处**，不是第二份清单。
 */
export const NIGHT_LAUNDRY_FEATURE_LABEL_EN = "night-time laundry reminder";

/**
 * 抽取阶段的小 schema：只保留本功能获准字段，不再回答 match（路由已判定）。
 *
 * **只收窄成有限的结构字段（枚举 / 布尔），不收任何原始细节文本**：生成阶段因此
 * 看不到「我房间」「我被吵醒」「机器挨着那面墙」这类来源情境，也就不可能把它们写进
 * 发给室友的正文（老板 2026-09-13 返工要求：AI 是协调员，不是受影响的住户）。
 *
 * 字段是 **required 枚举 / 布尔**（不是 optional）：缺字段会被 `safeParse` 拒绝，
 * 安全不发送。未知一律落到 `unspecified` / `false` 这类中性值。
 */
export const nightLaundryExtractionSchema = z.object({
  machine: z
    .enum(["washer", "dryer", "both", "unspecified"])
    .describe(
      "原话针对的设备：washer=洗衣机，dryer=烘干机，both=洗衣机和烘干机都要，unspecified=没指明。必填"
    ),
  timeWindow: z
    .enum(["late_night", "pre_dawn", "unspecified"])
    .describe(
      "希望避开的时段：late_night=深夜/夜里，pre_dawn=凌晨（如凌晨四点），unspecified=没指明。必填"
    ),
  affectsRest: z
    .boolean()
    .describe("原话是否表达了这件事影响到休息/睡觉；没有表达就填 false。必填"),
});

type NightMachine = z.infer<typeof nightLaundryExtractionSchema>["machine"];
type NightTimeWindow = z.infer<typeof nightLaundryExtractionSchema>["timeWindow"];

/** 生成阶段的 schema：发给收件人的正文 + 回给发起人的短回执。 */
const nightLaundryComposeSchema = z.object({
  message: z.string().describe("发给那位室友的短信正文"),
  receipt: z.string().describe("回给托你办事的住户的一句短回执"),
});

function extractSystem(): string {
  return [
    "你是合租房短信系统的一个功能入口。这个功能只有一件事：",
    "住户交办你去提醒某位同住人「深夜别用洗衣机或烘干机」。",
    "",
    "系统已经确认这句话是在明确交办这一件，你只负责**抽取几个中性的类别字段**，不要再判断是不是。",
    "住户顺带提到的其它诉求（清理头发、分摊水费、立全屋规矩等）**一个字都不要写进任何字段**。",
    "住户描述自己怎么被打扰的细节（「我房间」「我被吵醒」「机器挨着那面墙」）也**不要**提取——",
    "你只需要判断这三件事：设备是哪类、要避开的时段、有没有表达影响到休息。",
    "",
    "最终**只输出一个 JSON 对象**，字段固定为 machine / timeWindow / affectsRest（三个字段都必须出现）：",
    '{"machine": "both", "timeWindow": "pre_dawn", "affectsRest": true}',
    "machine 只能是 washer / dryer / both / unspecified；timeWindow 只能是 late_night / pre_dawn / unspecified；",
    "affectsRest 只能是 true 或 false。",
    "不要输出 JSON 以外的任何文字、解释或 markdown 代码块标记。",
  ].join("\n");
}

function composeSystem(): string {
  return [
    "你是这套合租房的 AI 协调员，替住户写一条发给室友的短信，只办一件事：",
    "提醒他尽量别在给定时段用洗衣机 / 烘干机。",
    "你只拿到几个**中立的类别字段**（收件人姓名、设备类别、希望避开的时段、是否影响到休息），",
    "没有原始请求，也不知道是谁提出来的。**不要猜、不要补任何原始细节。**",
    "",
    "message：发给那位室友的短信正文。短、自然、纯文本、不要 markdown。",
    "  - 用**第三人称、中立的协调员口吻**：你是替这栋房子传话的协调员，不是受影响的住户。",
    "    绝对不能写「我被吵醒」「我房间」「我那面墙」「吵到我了」这类把自己当成住户的话。",
    "  - 说清是什么事（在给定时段用洗衣 / 烘干设备）、希望他具体怎么做（尽量避开该时段）。",
    "  - 理由只用**中立、普遍成立**的说法，例如「夜深了机器声音容易影响别人休息」；",
    "    没有给你的具体事实就不要编。",
    "  - **不要写现在几点、不要写「今晚 / 现在 / 已经」这类对当前时间或事件的断言**；",
    "    那个时段字段只表示你希望他避开的时段，不代表「现在就是那个时段」。",
    "  - 不要提是谁让你说的，不要写别的事，不要说教。",
    "receipt：回给托你办事那位住户的一句短回执，只交代联系了谁、在等谁回话，不复述正文。",
    "",
    "最终**只输出一个 JSON 对象**，字段固定为 message 和 receipt（两个字段都必须出现，都是字符串）：",
    '{"message": "发给室友的短信正文", "receipt": "回给托你办事的住户的一句短回执"}',
    "不要输出 JSON 以外的任何文字、解释或 markdown 代码块标记。",
  ].join("\n");
}

/** 把有限枚举映射成中立的类别说法；生成阶段只看到这几个词。 */
function machineLabel(machine: NightMachine): string {
  switch (machine) {
    case "washer":
      return "洗衣机";
    case "dryer":
      return "烘干机";
    case "both":
      return "洗衣机和烘干机";
    default:
      return "洗衣机或烘干机";
  }
}

function timeWindowLabel(window: NightTimeWindow): string {
  switch (window) {
    case "late_night":
      return "深夜";
    case "pre_dawn":
      return "凌晨";
    default:
      return "深夜或凌晨";
  }
}

function composeUser(
  name: string,
  machine: NightMachine,
  window: NightTimeWindow,
  affectsRest: boolean
): string {
  return [
    `收件人：${name}`,
    `涉及的设备：${machineLabel(machine)}`,
    `希望避开的时段：${timeWindowLabel(window)}`,
    `这件事是否影响到别人休息：${affectsRest ? "是" : "未说明"}`,
  ].join("\n");
}

/**
 * 模型回执不可用时的兜底短句（只在模型没写出安全短句时用）。
 *
 * `language` 是本轮住户语言判定（缺省中文，与加语言闸之前逐字一致）：英文写法与中文
 * 同义、同分寸，**不是另一套话术**。住户用英文交办、模型又没写出可用回执时回一段中文，
 * 正是「用对方的语言回答」最容易被代码兜底破坏的地方。
 */
export function nightLaundryFallbackReceipt(
  recipientName: string,
  language: ResidentLanguage = "zh"
): string {
  if (language === "en") {
    return `Okay — I've asked ${recipientName} to avoid using the washer or dryer late at night.`;
  }
  return `好，已经提醒${recipientName}了，请他深夜尽量别用洗衣机或烘干机。`;
}

/**
 * 回执可用性：非空且不长；生成阶段只看到收窄字段，不做中文大正则。
 *
 * 上限**按语言取**：同一条「一句短回执」在英文里字符数本来就多，按中文上限卡会让
 * 英文回执几乎必然被换成兜底——与 `feature-qa.ts` 的 `FEATURE_QA_MAX_CHARS_EN` 同一
 * 条口径，只放宽英文，中文一字不动。
 */
const RECEIPT_MAX_CHARS = 80;
const RECEIPT_MAX_CHARS_EN = 160;

function safeReceipt(
  receipt: string,
  fallback: string,
  language: ResidentLanguage = "zh"
): string {
  const t = receipt.trim();
  const max = language === "en" ? RECEIPT_MAX_CHARS_EN : RECEIPT_MAX_CHARS;
  return t && t.length <= max ? t : fallback;
}

export const nightLaundryFeature: ApprovedFeature = {
  id: NIGHT_LAUNDRY_FEATURE_ID,
  label: NIGHT_LAUNDRY_FEATURE_LABEL,
  labelEn: NIGHT_LAUNDRY_FEATURE_LABEL_EN,
  routeDescription: "提醒某位同住人：深夜别用洗衣机或烘干机",

  async extract(text, llm, language): Promise<FeatureExtraction> {
    const { value, usage } = await structuredCall(llm, {
      stage: `feature:${NIGHT_LAUNDRY_FEATURE_ID}:extract`,
      name: "night_laundry_extract",
      schema: nightLaundryExtractionSchema,
      system: extractSystem(),
      user: text,
      language,
      // 推理 token 计入上限：给足「推理 + 两个短字段的 JSON」。
      maxOutputTokens: FEATURE_EXTRACT_MAX_OUTPUT_TOKENS,
    });
    const fields = value as z.infer<typeof nightLaundryExtractionSchema>;
    return {
      usage,
      payload: {
        machine: fields.machine,
        timeWindow: fields.timeWindow,
        affectsRest: fields.affectsRest,
      },
    };
  },

  async execute(
    extraction: FeatureExtraction,
    ctx: FeatureContext,
    deps: FeatureDeps
  ): Promise<FeatureExecution> {
    // 收件人只由代码从原话绑定；模型没有机会改人。语言取轮次判定（经前门注入
    // `ctx.language`），因为这两句澄清句会被当成本轮回复发给住户。
    const language = ctx.language?.language ?? "zh";
    const resolved = resolveNamedRecipient(
      ctx.text,
      ctx.members,
      ctx.senderPersonId,
      language
    );
    if (!resolved.ok) return { handling: null, usage: EMPTY_FEATURE_USAGE };
    const { recipient } = resolved;

    const ineligible = smsRecipientIneligibleReply(recipient, language);
    if (ineligible) {
      return {
        handling: {
          status: "handled",
          reply: ineligible,
          sms: null,
          decisionId: null,
        },
        usage: EMPTY_FEATURE_USAGE,
      };
    }

    // 生成阶段只拿得到这三个中立类别字段，看不到任何原始细节。
    const fields = (extraction.payload ?? {}) as {
      machine?: NightMachine;
      timeWindow?: NightTimeWindow;
      affectsRest?: boolean;
    };
    const composed = await structuredCall(deps.llm, {
      stage: `feature:${NIGHT_LAUNDRY_FEATURE_ID}:compose`,
      name: "night_laundry_message",
      schema: nightLaundryComposeSchema,
      system: composeSystem(),
      user: composeUser(
        recipient.name,
        fields.machine ?? "unspecified",
        fields.timeWindow ?? "unspecified",
        fields.affectsRest ?? false
      ),
      // `user` 是拼出来的中文字段清单、**不是住户原话**：语言只能取轮次判定（经前门
      // 注入 `ctx.language`），从 `user` 现推必然推成中文。
      language: ctx.language,
      // 推理 token 计入上限：给足「推理 + 一条短信正文 + 一句回执」。
      maxOutputTokens: FEATURE_COMPOSE_MAX_OUTPUT_TOKENS,
    });
    const out = composed.value as z.infer<typeof nightLaundryComposeSchema>;
    const message = (out.message ?? "").trim();
    if (!message) return { handling: null, usage: composed.usage };

    const sent = await deliverSms(
      {
        householdId: ctx.householdId,
        channel: ctx.channel,
        senderIsTest: ctx.senderIsTest,
        purposeLabel: NIGHT_LAUNDRY_FEATURE_LABEL,
        recipient,
        text: message,
      },
      deps.delivery
    );

    return {
      handling: {
        status: "handled",
        reply: safeReceipt(
          out.receipt ?? "",
          nightLaundryFallbackReceipt(recipient.name, ctx.language?.language),
          ctx.language?.language
        ),
        sms: {
          to: sent.to,
          personId: recipient.personId,
          text: sent.text,
          communicationId: sent.communicationId,
        },
        decisionId: sent.decisionId,
      },
      usage: composed.usage,
    };
  },
};
