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
 * **已批准功能之一：个人物品使用提醒。**
 *
 * 跟 `night-laundry-reminder.ts` 同构，但**各写各的朴素代码**（老板 2026-09-13：
 * 功能是最小产品单位，允许重复、不强行抽象）：这个文件就是「用我的个人物品前先问我」
 * 这一个功能的全部判据与入口。
 *
 *   1. `extract`：路由（`features.ts`，一次白名单调用）已确认这是明确交办本功能后，
 *      由本功能自己的小 schema 只抽取获准字段（是哪件物品、用完有没有归位），
 *      **不收任何原始细节文本**。
 *   2. `execute`：代码从原话绑定唯一收件人；只把收窄字段交给模型写正文与短回执，
 *      生成阶段看不到原始请求与夹带的其它诉求，也不会用第一人称冒充物品主人。
 *   3. 纯代码 `deliverSms` 落库投递。
 *
 * 不做大正则分类，不写死正文模板。语气质量靠 doctrine + 人工阅读。
 */

export const PERSONAL_ITEM_FEATURE_ID = "personal_item";
export const PERSONAL_ITEM_FEATURE_LABEL = "个人物品使用提醒";

/**
 * 抽取阶段的小 schema：只保留本功能获准字段，不再回答 match（路由已判定）。
 *
 * **不放任意的 `detail` 原文**：只留「是哪件物品」与「用完有没有归位」两个中性字段，
 * 生成阶段因此看不到「我搁在客厅」「他没跟我说一声」这类来源情境，也不会被写成
 * 第一人称（老板 2026-09-13 返工要求：AI 是协调员，不能用第一人称冒充物品主人）。
 *
 * `item` required + nullable（「没有」显式写 null）；`notPutBack` 是 required 布尔，
 * 没有表达就填 false。缺字段会被 `safeParse` 拒绝，安全不发送。
 */
export const personalItemExtractionSchema = z.object({
  item: z
    .string()
    .nullable()
    .describe(
      "原话里指的是哪件个人物品，只写物品本身（如「充电器」「放在客厅的充电器」）；" +
        "不要带「我的」「我搁在」这类第一人称；没有就填 null。必填"
    ),
  notPutBack: z
    .boolean()
    .describe("原话是否表达了用完没有放回原位；没有表达就填 false。必填"),
});

/** 生成阶段的 schema：发给收件人的正文 + 回给发起人的短回执。 */
const personalItemComposeSchema = z.object({
  message: z.string().describe("发给那位室友的短信正文"),
  receipt: z.string().describe("回给托你办事的住户的一句短回执"),
});

function extractSystem(): string {
  return [
    "你是合租房短信系统的一个功能入口。这个功能只有一件事：",
    "住户交办你去提醒某位同住人「用（这位住户的）个人物品之前先问一声」。",
    "",
    "系统已经确认这句话是在明确交办这一件，你只负责**抽取两个中性字段**，不要再判断是不是。",
    "住户顺带提到的其它诉求（清理头发、分摊水费、立全屋规矩等）**一个字都不要写进任何字段**。",
    "住户描述物品时带的「我的」「我搁在」这类第一人称，提取时去掉，只留物品本身。",
    "本功能无关的内容（浴室头发、卫生清洁、水费、电视音量、深夜洗衣等）一律不要提取。",
    "",
    "最终**只输出一个 JSON 对象**，字段固定为 item 和 notPutBack（两个字段都必须出现）：",
    '{"item": "放在客厅的充电器", "notPutBack": true}',
    "item 是字符串或 null；notPutBack 只能是 true 或 false。",
    "不要输出 JSON 以外的任何文字、解释或 markdown 代码块标记。",
  ].join("\n");
}

function composeSystem(): string {
  return [
    "你是这套合租房的 AI 协调员，替住户写一条发给室友的短信，只办一件事：",
    "请他用**别人的个人物品**之前先问一声。",
    "你只拿到几个**中立的字段**（收件人、是哪件物品、用完有没有归位），",
    "没有原始请求，也不知道是谁提出来的。**不要猜、不要补任何原始细节。**",
    "",
    "message：发给那位室友的短信正文。短、自然、纯文本、不要 markdown。",
    "  - 用**第三人称、中立的协调员口吻**：物品是这位室友的，不是你（AI）的，也不是收件人的。",
    "    绝不能写「我的个人物品」「我的东西」——那会让人以为东西是发短信的协调员自己的。",
    "    也不要点名是哪位室友（不披露是谁提出来的）。",
    "  - 说清希望他怎么做：用之前先跟物品主人说一声。",
    "  - 给一个**中立、不冒犯**的理由，例如「物品主人自己有时候也要用，先问一声能避免影响安排」；",
    "    没有给你的具体事实就不要编。",
    "  - 不要写别的事，不要说教。",
    "receipt：回给托你办事那位住户的一句短回执，只交代联系了谁、在等谁回话，不复述正文。",
    "",
    "最终**只输出一个 JSON 对象**，字段固定为 message 和 receipt（两个字段都必须出现，都是字符串）：",
    '{"message": "发给室友的短信正文", "receipt": "回给托你办事的住户的一句短回执"}',
    "不要输出 JSON 以外的任何文字、解释或 markdown 代码块标记。",
  ].join("\n");
}

function composeUser(name: string, item: string, notPutBack: boolean): string {
  return [
    `收件人：${name}`,
    `涉及的物品：${item.trim() || "（未指明，写「室友的个人物品」）"}`,
    `用完是否归位：${notPutBack ? "没有归位" : "未提及"}`,
  ].join("\n");
}

/**
 * 模型回执不可用时的兜底短句（只在模型没写出安全短句时用）。
 *
 * `language` 是本轮住户语言判定（缺省中文，与加语言闸之前逐字一致）：英文写法与中文
 * 同义、同分寸，**不是另一套话术**。住户用英文交办、模型又没写出可用回执时回一段中文，
 * 正是「用对方的语言回答」最容易被代码兜底破坏的地方。
 */
export function personalItemFallbackReceipt(
  recipientName: string,
  language: ResidentLanguage = "zh"
): string {
  if (language === "en") {
    return `Okay — I've asked ${recipientName} to check with you before using your things.`;
  }
  return `好，已经提醒${recipientName}了，让他用你的个人物品前先跟你说一声。`;
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

export const personalItemFeature: ApprovedFeature = {
  id: PERSONAL_ITEM_FEATURE_ID,
  label: PERSONAL_ITEM_FEATURE_LABEL,
  routeDescription: "提醒某位同住人：用这位住户的个人物品之前先问一声",

  async extract(text, llm, language): Promise<FeatureExtraction> {
    const { value, usage } = await structuredCall(llm, {
      stage: `feature:${PERSONAL_ITEM_FEATURE_ID}:extract`,
      name: "personal_item_extract",
      schema: personalItemExtractionSchema,
      system: extractSystem(),
      user: text,
      language,
      // 推理 token 计入上限：给足「推理 + 两个短字段的 JSON」。
      maxOutputTokens: FEATURE_EXTRACT_MAX_OUTPUT_TOKENS,
    });
    const fields = value as z.infer<typeof personalItemExtractionSchema>;
    return {
      usage,
      payload: {
        item: (fields.item ?? "").trim(),
        notPutBack: fields.notPutBack,
      },
    };
  },

  async execute(
    extraction: FeatureExtraction,
    ctx: FeatureContext,
    deps: FeatureDeps
  ): Promise<FeatureExecution> {
    // 收件人只由代码从原话绑定；模型没有机会改人。
    const resolved = resolveNamedRecipient(
      ctx.text,
      ctx.members,
      ctx.senderPersonId
    );
    if (!resolved.ok) return { handling: null, usage: EMPTY_FEATURE_USAGE };
    const { recipient } = resolved;

    const ineligible = smsRecipientIneligibleReply(recipient);
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

    const fields = (extraction.payload ?? {}) as {
      item?: string;
      notPutBack?: boolean;
    };
    const composed = await structuredCall(deps.llm, {
      stage: `feature:${PERSONAL_ITEM_FEATURE_ID}:compose`,
      name: "personal_item_message",
      schema: personalItemComposeSchema,
      system: composeSystem(),
      user: composeUser(recipient.name, fields.item ?? "", fields.notPutBack ?? false),
      // `user` 是拼出来的中文字段清单、**不是住户原话**：语言只能取轮次判定（经前门
      // 注入 `ctx.language`），从 `user` 现推必然推成中文。
      language: ctx.language,
      // 推理 token 计入上限：给足「推理 + 一条短信正文 + 一句回执」。
      maxOutputTokens: FEATURE_COMPOSE_MAX_OUTPUT_TOKENS,
    });
    const out = composed.value as z.infer<typeof personalItemComposeSchema>;
    const message = (out.message ?? "").trim();
    if (!message) return { handling: null, usage: composed.usage };

    const sent = await deliverSms(
      {
        householdId: ctx.householdId,
        channel: ctx.channel,
        senderIsTest: ctx.senderIsTest,
        purposeLabel: PERSONAL_ITEM_FEATURE_LABEL,
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
          personalItemFallbackReceipt(recipient.name, ctx.language?.language),
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
