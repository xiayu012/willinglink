/**
 * **用户可见功能事实源——一个运行时可直接读取、可打包的单点数据文件。**
 *
 * 老板 2026-09-13 纠正上一版理解过窄：能力说明**不是给每种未开放事项各写一套程序**，
 * 而是让 AI **读取一份长期维护的功能事实源**后回答。以后新增功能（开放或尚未开放）
 * 都**只改数据、不改问答引擎**（见 `feature-qa.ts`）。
 *
 * 本文件只回答两件事，都是**住户能感知**的：
 *
 * 1. **当前开放功能清单**：**单一登记点仍是 `features.ts` 的 `APPROVED_FEATURES`**
 *    （新增功能 = 在那里加一行 + 一个朴素模块）。这里**不复制**一份：问答入口直接把
 *    `APPROVED_FEATURES` 传进来（`buildFeatureQaFacts` 的 `openFeatures`），所以开放
 *    名称**自动进入回答**，本文件与 `feature-qa.ts` 都不用改。
 * 2. **尚未开放、且住户可感知的请求**：`UNAVAILABLE_CAPABILITIES` 里每条给一个**具名
 *    名称**与**代码能站得住的原因**。今天只登记了「卫生整改」（看不到现场程度，无法
 *    可靠判断是否达到要求别人整改的标准）。**没有登记具体原因的请求一律落到通用边界
 *    `GENERIC_UNAVAILABLE`**——诚实说它不在能力范围内，**绝不编造具体原因**。
 *
 * ## 为什么是「数据」不是「程序分支」
 *
 * 上一版把「未开放主题」做成代码枚举（`hygiene` / `other`）并按主题硬编码各自的关键词
 * 分类器与正文覆盖正则——每多一种未开放事项就要多一段程序。现在只有一张数据表 + 一个
 * **通用查找**：新增/改写住户可见解释 = 在 `UNAVAILABLE_CAPABILITIES` 加/改一行数据，
 * **问答引擎一行都不动**。表里的 `keywords` 是数据，只用来把问句关联到对应条目，不是
 * 每个主题一段程序。
 *
 * 本文件**不 import 任何东西**（`features.ts` 会经 `unsupported.ts` 间接依赖它，反向
 * import 会成环）；开放功能由调用方注入。
 */

/**
 * 一条未开放条目的**验证元数据**：让通用 grounding 校验（`feature-qa.ts`）能用**同一段
 * 逻辑**核对正文有没有丢掉这条事实的名称与理由——主题差异全在这份数据里，引擎里没有
 * 任何 `if (id === …)` 分支。新增 / 改写条目只改这里的数据。
 */
export type UnavailableValidation = {
  /**
   * 正文里必须**同时出现**的锚点词：取自 `reason` 里换句话也绕不开的核心词，用来证明
   * 模型保留了这条事实的**理由**（允许自然改写措辞，不要求逐字复述整句 reason）。
   */
  reasonAnchors: readonly string[];
};

/** 一条**住户可感知的、目前办不了的**请求：具名 + 代码站得住的原因。 */
export type UnavailableCapability = {
  /** 稳定 id（台账 / 结构化状态用），不是给模型选的枚举 */
  id: string;
  /** 住户可见的名称 */
  label: string;
  /** 为什么办不了——**代码能站得住的原因**，不是说辞 */
  reason: string;
  /** 数据：用于把问句关联到本条目；不是按主题分叉的程序 */
  keywords: readonly string[];
  /** 数据：通用 grounding 校验的验证元数据（见 `UnavailableValidation`） */
  validation: UnavailableValidation;
};

/**
 * **尚未开放、但住户可感知的请求。** 只登记代码能给出稳定具名原因的条目；判不出具体
 * 原因的一律不登记（落到 `GENERIC_UNAVAILABLE`）。
 */
export const UNAVAILABLE_CAPABILITIES: readonly UnavailableCapability[] = [
  {
    id: "hygiene",
    label: "卫生整改",
    reason: "我看不到现场的程度，没法可靠判断是不是到了需要要求别人整改的地步",
    keywords: [
      "卫生",
      "清洁",
      "地漏",
      "头发",
      "毛发",
      "打扫",
      "保洁",
      "浴室",
      "厕所",
      "马桶",
      "垃圾",
      "异味",
    ],
    // 「看不到现场」是这条理由换句话也绕不开的核心；模型可自由改写整句，但这两点不能丢。
    validation: { reasonAnchors: ["看不到", "现场"] },
  },
];

/**
 * **通用边界：没有登记具体原因的请求，就诚实使用这句。** 不假装知道是哪一类、也不编
 * 造一个具体原因——只是如实说这类「替住户去联系别人办事」目前不在范围里。
 */
export const GENERIC_UNAVAILABLE = {
  label: "这件事",
  reason: "这件事目前不在我能替你转达给别人的范围里",
} as const;

/** 把一段文本关联到**第一条**命中的未开放条目（数据查找，不是按主题分叉的程序）。 */
export function matchUnavailableCapabilityId(text: string): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  for (const c of UNAVAILABLE_CAPABILITIES) {
    if (c.keywords.some((k) => t.includes(k))) return c.id;
  }
  return null;
}

/**
 * 选出与**这次问的问题**有关的未开放条目：问句本身命中的，加上（若提供）**上一轮刚被
 * 拒绝**的那一条（`lastRejectedCapabilityId`，由调用方从结构化的 decision payload 取出，
 * 用来理解「刚才」）。两者都为空时返回空数组——调用方据此使用通用边界。
 */
export function selectUnavailableCapabilities(
  question: string,
  lastRejectedCapabilityId?: string | null
): UnavailableCapability[] {
  const t = (question ?? "").trim();
  const out: UnavailableCapability[] = [];
  for (const c of UNAVAILABLE_CAPABILITIES) {
    if ((t && c.keywords.some((k) => t.includes(k))) || c.id === lastRejectedCapabilityId) {
      out.push(c);
    }
  }
  return out;
}

/**
 * **交给模型的那一份用户可见事实**（结构化、可打包）：当前开放功能 + 与本次问题有关的
 * 未开放条目 + 通用边界。开放功能由调用方从 `APPROVED_FEATURES` 注入，**不在这里复制**。
 */
export type FeatureQaFactBundle = {
  /** 当前开放功能（含 id 供台账；正文只用 label） */
  openFeatures: readonly { id: string; label: string }[];
  /** 与本次问题有关的未开放条目；可能为空 */
  unavailable: readonly UnavailableCapability[];
  /** 没有具名原因时使用的通用边界 */
  generic: { label: string; reason: string };
};

export function buildFeatureQaFacts(args: {
  openFeatures: readonly { id: string; label: string }[];
  question: string;
  lastRejectedCapabilityId?: string | null;
}): FeatureQaFactBundle {
  return {
    openFeatures: args.openFeatures,
    unavailable: selectUnavailableCapabilities(args.question, args.lastRejectedCapabilityId),
    generic: GENERIC_UNAVAILABLE,
  };
}
