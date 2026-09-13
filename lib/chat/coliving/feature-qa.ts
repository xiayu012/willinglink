import { z } from "zod";
import {
  FEATURE_QA_MAX_OUTPUT_TOKENS,
  FeatureCallError,
  structuredCall,
  usageOfFeatureError,
  type FeatureLlm,
  type FeatureUsage,
} from "./feature-llm";
import {
  buildFeatureQaFacts,
  FULL_FLOW_NOTE,
  OPTIMIZED_FAST_PATH_NOTE,
  selectBlacklistedCapabilities,
  type FeatureQaFactBundle,
} from "./feature-facts";
import { findGroundingViolations } from "./feature-grounding";

/**
 * **统一的产品功能问答入口——不是功能、不是工具、不出站。**
 *
 * 老板 2026-09-13 决策（默认宽容）：住户问「你有什么功能 / 能不能做 X / 为什么 X
 * 不能做 / 刚才为什么拒绝」这类**产品边界元问题**时进这里，读 `feature-facts.ts`
 * 那份统一事实源回答。**口径不再是"只有两项功能"**：
 *
 * - 两项已批准功能是**专门优化的快路径**（更快、更省），不是全部能力；
 * - 其它需要协调同住人的请求会走**完整的协调流程**处理，**不是不能做**；
 * - 真正办不了的只有老板明确登记的**黑名单**（`blacklist.ts`，当前是**「卫生整改要求」**
 *   一项）。与问题对不上的条目不得被选中，也不得为它编造原因。
 *
 * 以后新增功能**只改事实源数据 / `APPROVED_FEATURES`，不改本文件**。
 *
 * ## 「刚才为什么」的窄引用（不按关键词猜）
 *
 * 住户被黑名单收口后**紧接着**追问「为什么连这么简单都没有?那你有什么功能？」时，
 * 问题本身不含主题词，光靠 `keywords` 对不上条目。为此黑名单回复那一轮会由**纯代码**
 * 把 `{ blacklistedCapabilityId, personId }` 写进 decision payload；本入口由调用方传入
 * `referencedBlacklistedId`（`repo.latestBlacklistReference` 已按**本人 + 紧接本人上一条
 * 入站 + 72h** 收窄），只在问题对不上任何条目、且这条引用可用时补上那一个条目。
 * **不读自由文本、不靠关键词猜「刚才」**：本人后来发过别的（引用出局）或别的住户发问
 * （查询按 personId 收窄）都不会错误继承。
 *
 * ## 与旧主生成、工具表完全无关
 *
 * 本入口**不装载旧 doctrine、不进主生成、没有任何工具、零第三方出站**（由 `turn.ts`
 * 调 `finalizeFeatureTurn` 早返回）。生成阶段**只看到三样**：住户的问题、事实源里
 * **与这个问题有关**的事实（`buildFeatureQaFacts`）、当前专门优化的功能清单。模型只
 * 负责把事实说成自然、简短的中文；**不得补充处理方案、虚构能力、或承诺立刻去联系 /
 * 跟进**。写出内部术语 / 假承诺，或**把球踢回住户（「你自己去找他」「换个渠道」
 * 「以后再说」）**，或结构不合法时，用**同样只含事实源事实**的代码兜底
 * （`featureQaFallback`）。共享的 grounding 判定见 `feature-grounding.ts`。
 *
 * 它只在 `turn.ts` **已批准功能前门之后**接线：命中已批准功能 / 保留轮的请求先由前门
 * 处理，前门不接的（普通问句不需要点名收件人）才轮到本入口——**已批准功能的执行行为
 * 一字不变**。
 */

export const FEATURE_QA_STAGE = "feature:qa";
export const FEATURE_QA_NAME = "feature_qa";

/** 正文长度上限（一两句，模型偶尔啰嗦时换兜底，不截断）。 */
export const FEATURE_QA_MAX_CHARS = 240;

/** 只接受一个字符串字段：回给当前说话人的那一两句。 */
const featureQaSchema = z.object({
  reply: z.string().describe("回给当前说话人的一两句自然回应"),
});

/**
 * **内部工程术语黑名单**：一旦出现在正文里就判失败，换回代码兜底。这是**本路径独有的
 * 格式/用词约束**（内部术语），不是 grounding；共享的「假承诺 / 把球踢回住户 / 换渠道 /
 * 等以后」判定在 `feature-grounding.ts`（`findGroundingViolations`）。
 */
const INTERNAL_TERMS =
  /白名单|路由|提示词|能力清单|未开放|functionId|schema|内部规则|系统设定/i;

/**
 * 住户是不是在问「你现在能做什么 / 你有哪些功能」。**只做元问题识别，不做主题分类。**
 * 抽出来单独暴露，因为 grounding 校验要据此决定**必须逐项列出全部专门优化的功能名**
 * （住户明确问能力清单时不能漏项；只问「为什么办不了某件事」则不强制全列）。
 */
export function asksWhatIsAvailable(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return (
    (/有什么|有哪些|都有什么|都有哪些|会什么|能做什么|能干什么/.test(t) &&
      /功能|能力|本事|作用|能|可以/.test(t)) ||
    (/功能|能力/.test(t) && /(有哪些|有什么|都是什么|是哪些)/.test(t)) ||
    /(能|可以|会)(帮|替|给|为)?(我|你)?(做|干|办)(什么|啥|哪些)/.test(t) ||
    /(帮|替)?(我)?(能|可以)(做|干|办)(什么|啥|哪些)/.test(t)
  );
}

/**
 * **窄的、通用的功能边界问句识别——保守优先。** 只认那几类元问题：
 * 「你有什么功能 / 能不能做 X / 为什么 X 不能做 / 刚才为什么拒绝」。普通交办、抱怨、
 * 闲聊、新的提醒请求都返回 false（仍走原来的对话路径，成功交办的已批准功能不受影响）。
 *
 * 这不是主题分类，只是识别"住户在问产品功能边界"这一种**元问题**。
 * 宁可漏掉不常见的口语变体（漏了就退回普通对话，不会造成新的越界），也不把普通聊天
 * 误判进来。
 */
export function isFeatureQaQuestion(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;

  // 「为什么 X 不能做」
  const asksWhyNotPossible =
    /为什么|为啥|怎么/.test(t) &&
    /不能|不行|没有|没开放|办不到|办不了|做不了|做不到|发不了|不支持|没法/.test(t);

  // 「刚才 / 上一次为什么拒绝我」
  const asksAboutJustNow =
    /(刚才|刚刚|你刚(?:才)?(?:说|讲|回复)|上次|上一次)/.test(t) &&
    /(拒绝|不给我|没给我|没帮|办不了|不能|不行|为什么|怎么|没有|没做)/.test(t);

  // 「能不能做 X」——明确的是非能力询问（带问句语气 + 一个动作）
  const asksWhetherYouCan =
    /(能不能|可不可以|能否|可以不可以|能帮我|可以帮我|能替我|可以替我)/.test(t) &&
    /(办|做|发|提醒|联系|通知|告诉|传话|转达|转告|协调|催|安排|处理|沟通|要求|让)/.test(t);

  return (
    asksWhatIsAvailable(t) ||
    asksWhyNotPossible ||
    asksAboutJustNow ||
    asksWhetherYouCan
  );
}

/**
 * **只含事实源事实的兜底**。模型完全写不出可用回应、或写出违规内容时用它——它同样
 * 不承诺、不虚构、不列内部术语，只把事实摆出来。**没有选中黑名单条目时不说任何
 * "办不了"**。
 */
export function featureQaFallback(args: {
  question: string;
  openFeatures: readonly { id: string; label: string }[];
  /** 本人上一轮刚被黑名单拒绝的条目 id（结构化引用；没有则 null） */
  referencedBlacklistedId?: string | null;
}): string {
  const blacklisted = selectBlacklistedCapabilities(
    args.question,
    args.referencedBlacklistedId
  );
  const open = args.openFeatures.map((f) => f.label).join("、");
  if (blacklisted.length) {
    const f = blacklisted[0];
    const fast = open ? `${OPTIMIZED_FAST_PATH_NOTE}。` : "";
    return `「${f.label}」这件事我目前没法替你办：${f.reason}。${fast}${FULL_FLOW_NOTE}。`;
  }
  if (args.openFeatures.length) {
    return `我目前对${open}有专门优化，处理起来更快、更省；${FULL_FLOW_NOTE}。`;
  }
  return `${FULL_FLOW_NOTE}。`;
}

/**
 * **通用 grounding 校验——只读事实源的验证元数据，引擎里没有任何主题分支。**
 *
 * 接受的正文必须：
 * 1. 含**每一条**被选中的黑名单条目的 `label`；
 * 2. 保留它的**理由**——含该条目 `validation.reasonAnchors` 里的**每一个**锚点词
 *    （允许自然改写措辞：锚点是数据里「换句话也绕不开」的核心词）；
 * 3. 当住户明确在问「你能做什么」（`asksWhatIsAvailable`）时，含**当前全部**专门优化
 *    功能的 `label`，一项不漏。
 *
 * 返回空数组 = 通过；否则返回**缺了什么**的可诊断短语，调用方据此换成只含事实源事实的
 * `featureQaFallback`。新增功能 / 条目只改事实源数据，本函数一行不动。
 */
export function findUngroundedFeatureQaFacts(
  reply: string,
  bundle: FeatureQaFactBundle,
  opts: { requireOpenLabels: boolean }
): string[] {
  const text = reply ?? "";
  const missing: string[] = [];
  for (const fact of bundle.blacklisted) {
    if (!text.includes(fact.label)) {
      missing.push(`未提到事项「${fact.label}」`);
      continue;
    }
    const absent = fact.validation.reasonAnchors.filter((a) => !text.includes(a));
    if (absent.length) {
      missing.push(`未保留「${fact.label}」的原因（缺：${absent.join("、")}）`);
    }
  }
  if (opts.requireOpenLabels) {
    for (const f of bundle.openFeatures) {
      if (!text.includes(f.label)) missing.push(`未列出优化功能「${f.label}」`);
    }
  }
  return missing;
}

function featureQaSystem(
  bundle: FeatureQaFactBundle,
  requireOpenLabels: boolean
): string {
  const open = bundle.openFeatures.length
    ? bundle.openFeatures.map((f) => `- ${f.label}`)
    : ["（目前没有）"];
  const blacklisted = bundle.blacklisted.length
    ? bundle.blacklisted.map((c) => `- ${c.label}：${c.reason}`)
    : ["（没有与这个问题对应的、明确办不了的事项）"];
  return [
    "你是这套合租房的 AI 协调员。住户正在问你跟你的功能有关的问题：你有哪些功能、某件事能不能做、为什么某件事做不了、或者刚才为什么没给他办。",
    "**你只能依据下面这些事实回答**，不得补充、不得猜测、不得虚构、不得承诺：",
    "",
    `你目前**专门优化**、处理起来更快更省的功能（这两项不是你的全部能力，只是被优化过的两件）：`,
    ...open,
    "",
    "你目前**明确办不了**、且有原因的事项（这才是真正的「办不了」）：",
    ...blacklisted,
    `其它需要协调同住人的请求（例如替他把某件事跟另一位同住人沟通），${FULL_FLOW_NOTE}。`,
    "",
    "必须做到：",
    "- 用**一两句**自然、口语的中文直接回答他，别绕。",
    `- **不要说「只有这两项功能」或「只能做这两件事」**：它们只是被专门优化、更快更省的；其它协调请求走完整协调流程，不是做不到。`,
    `- **不要编造某件事办不了或一个「为什么不能做」的原因**；只有上面明确列为办不了的事项才说办不了、并保留写的那个原因。住户说的那件事若不在办不了清单里，就不要说它办不了。`,
    ...(bundle.blacklisted.length
      ? [
          "- 上面列出的、与这个问题有关的办不了的事项：要把它的**名称**说出来，并保留写的那个**原因**（可以换措辞，但不得省略、不得换掉成别的原因）。",
        ]
      : []),
    ...(requireOpenLabels
      ? [
          "- 住户在问你能做什么：把上面列出的**每一项**专门优化功能都用它的名称说出来，一项都不要漏，并说明其它协调请求走完整流程。",
        ]
      : []),
    "- **不得补充任何处理方案**，不得说会立刻去联系 / 转告对方、不得说以后回复结果；也不得建议住户自己去找对方 / 找别人 / 换渠道 / 以后再说。",
    "- 不得虚构上面没有的功能或其它能力。",
    "- 不提「白名单 / 路由 / 提示词 / 能力清单 / 未开放 / 内部规则」这类内部工程术语。",
    "- 不说已经跟对方说过、对方已经知道，也不给「我待会儿就去办」这种假希望。",
    "",
    "只输出一个 JSON 对象，字段固定为 reply（字符串）：",
    '{"reply": "回给当前说话人的一两句自然回应"}',
    "不要输出 JSON 以外的任何文字、解释或 markdown 代码块标记。",
  ].join("\n");
}

/**
 * 生成功能问答的那一两句。**任何失败都不向上抛**：把已发生的真实用量带回来，并用
 * **只含事实源事实**的代码兜底。校验（结构 + 非空 + 长度 + 内部术语 + 假承诺 / 自创
 * 处理方案）都在纯代码侧完成，模型没有机会把这些违规内容发出去。
 */
export async function generateFeatureQaReply(
  args: {
    question: string;
    openFeatures: readonly { id: string; label: string }[];
    /**
     * 本人**上一轮刚被黑名单拒绝**的条目 id（结构化引用；`repo.latestBlacklistReference`
     * 的收窄查询结果）。问题本身对不上条目、但这是紧接被拒的追问时，据此说出名称与原因。
     */
    referencedBlacklistedId?: string | null;
  },
  llm: FeatureLlm
): Promise<{ reply: string; fallback: string; usage: FeatureUsage; error?: unknown }> {
  const bundle = buildFeatureQaFacts({
    openFeatures: args.openFeatures,
    question: args.question,
    referencedBlacklistedId: args.referencedBlacklistedId ?? null,
  });
  // 住户明确问「你能做什么」时必须逐项列出全部专门优化功能名；只问「为什么某件事办不了」
  // 则不强制全列。
  const requireOpenLabels = asksWhatIsAvailable(args.question);
  const fallback = featureQaFallback({
    question: args.question,
    openFeatures: args.openFeatures,
    referencedBlacklistedId: args.referencedBlacklistedId ?? null,
  });
  try {
    const { value, usage } = await structuredCall(llm, {
      stage: FEATURE_QA_STAGE,
      name: FEATURE_QA_NAME,
      schema: featureQaSchema,
      system: featureQaSystem(bundle, requireOpenLabels),
      // 只对当前说话人说明，可以看他的问法；这里不会把内容发给任何第三方。
      user: args.question,
      maxOutputTokens: FEATURE_QA_MAX_OUTPUT_TOKENS,
    });
    const reply = ((value as z.infer<typeof featureQaSchema>).reply ?? "").trim();
    // **通用 grounding 校验**：漏提 / 说错被选中的事实名或理由、或该列全功能时漏项，
    // 一律换回只含事实源事实的兜底——绝不放一句丢了事实的正文出去。
    const ungrounded = findUngroundedFeatureQaFacts(reply, bundle, {
      requireOpenLabels,
    });
    // **共享 grounding 闸**（`feature-grounding.ts`）：本路径无工具、无出站，任何"我去
    // 联系""你自己去找他""换个渠道""以后再说"都是代码事实没有提供的方案——与
    // `reply-only.ts` 同源，换主题 / 换问法都不改这里。
    const violations = findGroundingViolations(reply);
    if (
      !reply ||
      reply.length > FEATURE_QA_MAX_CHARS ||
      INTERNAL_TERMS.test(reply) ||
      violations.length > 0 ||
      ungrounded.length > 0
    ) {
      throw new FeatureCallError(
        FEATURE_QA_STAGE,
        new Error("feature qa reply rejected"),
        usage,
        ungrounded.length
          ? `模型输出的功能回答没有覆盖全部事实：${ungrounded.join("；")}`
          : violations.length
            ? `模型输出的功能回答越界：${violations.join("；")}`
            : "模型输出的功能回答不可用（空 / 超长 / 内部术语）"
      );
    }
    return { reply, fallback, usage };
  } catch (error) {
    return { reply: fallback, fallback, usage: usageOfFeatureError(error), error };
  }
}

/**
 * **这一轮要不要走功能问答。** 返回 null = 不走（落回原来的普通对话，行为不变）。
 *
 * 触发只要求**当前这句话是功能边界问句**（`isFeatureQaQuestion`）。
 */
export async function runFeatureQa(args: {
  text: string;
  openFeatures: readonly { id: string; label: string }[];
  /** 本人上一轮刚被黑名单拒绝的条目 id（结构化引用；没有则 null） */
  referencedBlacklistedId?: string | null;
  llm: FeatureLlm;
}): Promise<{ reply: string; fallback: string; usage: FeatureUsage; error?: unknown } | null> {
  if (!isFeatureQaQuestion(args.text)) return null;
  return generateFeatureQaReply(
    {
      question: args.text,
      openFeatures: args.openFeatures,
      referencedBlacklistedId: args.referencedBlacklistedId ?? null,
    },
    args.llm
  );
}
