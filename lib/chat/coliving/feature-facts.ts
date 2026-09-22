import {
  BLACKLISTED_CAPABILITIES,
  blacklistedCapabilityById,
  blacklistDisplayName,
  blacklistReason,
  blacklistReasonAnchors,
  type BlacklistedCapability,
} from "./blacklist";
import { coordinatorCopyText } from "./coordinator-copy";
import type { LanguageDecision, ResidentLanguage } from "./language";

/**
 * **用户可见功能事实源——一个运行时可直接读取、可打包的单点数据文件。**
 *
 * 老板 2026-09-22 决策（文案与数据分开）：**给住户看的通用话不再写在 TypeScript 里**，
 * 而是放在一份人可以直接编辑的 Markdown 里（`coordinator-copy.ts` 读取的
 * `doctrine/content/coordinator-self-description.md`）。本文件只负责**数据查找**：
 *
 * 1. **通用自我介绍 / 能力说明**：整段原文从 Markdown 取（`blocks`），本文件
 *    **不复制、不改写、不润色**，也不在代码里留一份"兜底措辞"。
 * 2. **已批准功能**（`features.ts` 的 `APPROVED_FEATURES` 单一登记点，调用方注入）是
 *    专门优化的快路径。问「你能做什么」时把它们作为一份**索引**（`featureIndex`）交给
 *    模型：名称按本轮语言取、来自那次登记，**不是本文件或 Markdown 里的第二份清单**。
 *    模型自己判断该提哪几条、提几条（条目只是**举例**，不是全部能力）；问身份 /
 *    只问到某件办不到的事时**不带索引**（那种回答里冒出功能名就判不通过，
 *    `forbiddenFeatureNames`）。
 * 3. **真正办不了的事只有一个来源**：老板明确登记的**黑名单**
 *    （`blacklist.ts` 的 `BLACKLISTED_CAPABILITIES`）。与问题**对不上**的条目不得被选中，
 *    也不得为它编造原因。
 *
 * **四段各自只服务一种问法**（选段逻辑收在 `selectFeatureQaBlocks` 一处，问答引擎与代码
 * 兜底共用同一个结果，不会出现"事实包给了两段、兜底只回一段"）：
 *
 * - 问「你是谁 / 介绍一下你自己」→ **只** `identity.*`（不列功能、不讲办不到的事）；
 * - 问「你能做什么」→ **只** `capabilities.*`（外加那份功能索引）；
 * - 住户**明确问到**某件已登记为办不到的事 → 只给那件事的名称与登记原因；同一句里若同时
 *   问能力，才把 `capabilities.*` 一并给出。
 *
 * 本文件只做数据查找，不做主题分叉：黑名单条目自带 `keywords`（关联预筛）、
 * `qualifier`（与执行阻断同一份精确资格判据）与 `validation.reasonAnchors`（通用
 * grounding 用）。以后新增 / 改写：只改 `blacklist.ts` 的数据、`APPROVED_FEATURES`
 * 登记，或那份 Markdown 文案，问答引擎一行不动。
 *
 * 本文件只 import 同目录的 `blacklist.ts`、`coordinator-copy.ts` 与 `language.ts` 的
 * **纯类型**（运行时不产生 require），不会成环。
 */

/**
 * **已批准功能的两个显示名——住户那一侧唯一的取名处。**
 *
 * 每个功能在**自己的模块里**（`night-laundry-reminder.ts` / `personal-item-reminder.ts`）
 * 与 `label` 并排登记 `labelEn`，`APPROVED_FEATURES` 仍是唯一登记点：
 *
 * - `label`：**老板登记的中文名**——台账、`deliverSms` 的 `purposeLabel`、数据库那一侧
 *   与中文正文都用它，**一字不动**；
 * - `labelEn`：同一个功能的**自然英文显示名**，在住户这一轮说英文时按同一份语言判定取用。
 *
 * 为什么两个名字都要是**登记好的数据**：名字一旦交给模型即兴翻译，同一个功能在两轮里就
 * 会有两种叫法，台账与住户看到的也对不上。所以取用一律走下面 `featureDisplayName` 这
 * 一个函数（按本轮语言取一次），代码里不出现第二处取名逻辑。
 *
 * 它**是显示名，不是标识符**：`id`、`purposeLabel`、台账与内部路由一律仍用 `label` / `id`。
 * 黑名单条目的名称与理由**也不经这里，但有各自成对的登记英文说法**（`blacklist.ts` 的
 * `blacklistDisplayName` / `blacklistReason`）——口径相同、数据各登记在各条目上。
 */
export type FeatureDisplayName = {
  /** 只用于台账与对照，不进正文。 */
  id: string;
  /** 老板登记的中文名（台账 / 数据库标签 / 中文正文） */
  label: string;
  /** 同一个功能的自然英文显示名（只在住户说英文时用） */
  labelEn: string;
};

/**
 * **按本轮语言取显示名**——住户那一侧唯一的取名函数。中文取登记名，英文取自然英文
 * 显示名。**不在这里翻译任何东西**：两个名字都是登记好的数据。
 */
export function featureDisplayName(
  feature: FeatureDisplayName,
  language: ResidentLanguage
): string {
  return language === "en" ? feature.labelEn : feature.label;
}

/**
 * **这一轮答案可以（且只可以）表达的整段原文**：`text` 直接来自内容 Markdown，代码
 * 一字不改。`kind` 只用于诊断与 grounding 报缺时说清是哪一段。
 */
export type FeatureQaBlock = {
  kind: "identity" | "capabilities";
  /** 该段在**本轮语言**下的原文（`identity.zh` / `capabilities.en` …）。 */
  text: string;
};

/**
 * **索引里的一条**：本轮语言下的登记显示名 + 稳定 id（id 只用于台账与检查，不进正文）。
 */
export type FeatureQaIndexEntry = {
  id: string;
  name: string;
};

/**
 * **交给模型的那一份用户可见事实**（结构化、可打包）：本轮允许表达的整段原文 +
 * 本轮可以参考的功能索引 + 与本次问题有关的黑名单条目。**代码里没有任何一份"备用措辞"**
 * ——原文只有 Markdown 这一个出处，兜底也从同一个结果里取。
 */
export type FeatureQaFactBundle = {
  /**
   * 本轮答案**可以且只可以**表达的整段原文（按本轮语言取好）。**可能为空**：住户只问到
   * 某件登记为办不到的事时，答案就是那件事的名称与原因，没有别的段落可讲。
   */
  blocks: readonly FeatureQaBlock[];
  /**
   * 与本次问题有关的黑名单条目；**可能为空**（空 = 这个问题没有对得上的"办不了"）。
   * 名称、理由与 grounding 锚点**都已按本轮语言取好**（`blacklistFact`），消费方
   * 不再自己挑字段——否则很容易出现"名称取了英文、锚点还核对中文"这种半截英文。
   */
  blacklisted: readonly FeatureQaBlacklistFact[];
  /**
   * **专门优化过的快路径索引**（`APPROVED_FEATURES`，按本轮语言取好），只有住户问到
   * 「你能做什么」时才给。它**只是举例**：模型自己挑与住户问题相关的那几条自然带出来，
   * 提几条不限，其余日常合住的事照旧可以办（走完整流程）。
   *
   * **可能为空**：问身份、只问到某件办不到的事时不给索引——那两种回答里出现功能名
   * 就判不通过（见 `forbiddenFeatureNames`）。
   */
  featureIndex: readonly FeatureQaIndexEntry[];
  /**
   * **本类回答里不得出现的功能名**（同样是 `APPROVED_FEATURES` 的登记名，按规则取）：
   *
   * - 问了能力（`featureIndex` 非空）→ 只禁**另一种语言**的登记名：本语言的名字是索引、
   *   允许出现，另一种语言的冒出来就是语言串了（英文轮次里夹中文名）；
   * - 没问能力（问身份 / 只问到某件办不到的事）→ **两种语言的登记名都禁**：这一轮本就
   *   不该提具体功能。
   *
   * 它是**纯代码守卫**，让上面那条"什么时候能提功能"成为一条能验的规则，而不是一句嘱咐。
   */
  forbiddenFeatureNames: readonly string[];
};

/**
 * 黑名单条目在**问答事实包**里的形状：三个字段都已按本轮语言取好（与功能显示名同一条
 * 口径），理由与锚点**必须来自同一次语言判定**。
 */
export type FeatureQaBlacklistFact = {
  /** 稳定 id：只用于台账与结构化引用，不进正文。 */
  id: string;
  /** 住户可见的名称（中文原话 / 英文说法，按本轮语言取）。 */
  displayName: string;
  /** 原因（同上）。 */
  reason: string;
  /** grounding 核对用的理由锚点（同上，与 `reason` 同语言）。 */
  reasonAnchors: readonly string[];
};

/**
 * 把一个黑名单条目**按本轮语言**展开成事实包里的形状。取用一律走这里：名称、理由、
 * 锚点三者同时取到同一份语言，消费方没有机会只换一半。
 */
export function blacklistFact(
  cap: BlacklistedCapability,
  language: ResidentLanguage
): FeatureQaBlacklistFact {
  return {
    id: cap.id,
    displayName: blacklistDisplayName(cap, language),
    reason: blacklistReason(cap, language),
    reasonAnchors: blacklistReasonAnchors(cap, language),
  };
}

/**
 * 与**这次问的问题**有关的黑名单条目（数据查找；没有对得上的条目时为空数组）。
 *
 * **本次问题命中关键词优先**，且要与**执行阻断同一份精确资格**（`qualifier`）一起满足：
 * 这样"为什么要我清墙面头发 / 疏通地漏 / 打扫卫生"这类**相邻主题的问题**不会被错误地
 * 关联到本条目、也就不会被说成"办不了"。只有问题本身对不上任何条目、但住户**上一轮刚被**
 * 这条黑名单拒绝（`referencedId`，代码写入的结构化 id，不是自由文本）时，才用那一条——
 * 于是「为什么连这么简单都没有?那你有什么功能？」这种**紧接被拒的追问**也能说出名称
 * 与登记原因。**不按关键词猜「刚才」**：引用是否可用由 `repo.latestBlacklistReference`
 * 的收窄查询（本人 + 紧接本人上一条入站 + 72h）决定，这里只做数据查找。
 */
export function selectBlacklistedCapabilities(
  question: string,
  referencedId?: string | null
): BlacklistedCapability[] {
  const t = (question ?? "").trim();
  const fromQuestion = t
    ? BLACKLISTED_CAPABILITIES.filter(
        (c) => c.keywords.some((k) => t.includes(k)) && c.qualifier(t)
      )
    : [];
  if (fromQuestion.length) return fromQuestion;
  const ref = referencedId ? blacklistedCapabilityById(referencedId) : null;
  return ref ? [ref] : [];
}

/**
 * **本轮该读哪几段**——问答引擎与代码兜底**共用这一个函数**，两边不会各挑一套。
 *
 * 规则（老板 2026-09-22，按问法分开，不是按主题分叉）：
 *
 * - 问「你是谁」→ `identity.*`；同一句里**还**问了能力，才把 `capabilities.*` 一并给出；
 * - 问「你能做什么」→ `capabilities.*`；
 * - 住户问到某件**已登记**为办不到的事 → 不给通用段（答案就是那件事的名称与原因）；
 *   同一句里**还**问了能力，才补上 `capabilities.*`；
 * - 其余功能边界问句（例如「为什么某某做不了」而这件事根本没被登记）→ `capabilities.*`：
 *   如实说我能帮上什么忙，**不编造限制**。
 */
export function selectFeatureQaBlocks(args: {
  selfIntro: boolean;
  wantsCapabilities: boolean;
  hasBlacklisted: boolean;
  language: ResidentLanguage;
}): readonly FeatureQaBlock[] {
  const blocks: FeatureQaBlock[] = [];
  if (args.selfIntro) {
    blocks.push({ kind: "identity", text: coordinatorCopyText("identity", args.language) });
  }
  const wantCapabilities =
    args.wantsCapabilities || (!args.selfIntro && !args.hasBlacklisted);
  if (wantCapabilities) {
    blocks.push({
      kind: "capabilities",
      text: coordinatorCopyText("capabilities", args.language),
    });
  }
  return blocks;
}

export function buildFeatureQaFacts(args: {
  openFeatures: readonly FeatureDisplayName[];
  question: string;
  /** 本人上一轮刚被黑名单拒绝的条目 id（代码写入的结构化引用；没有则 null） */
  referencedBlacklistedId?: string | null;
  /**
   * 住户这一句是不是在问**你自己**。由调用方（`feature-qa.ts` 的窄识别器）判，
   * **不在这里按关键词猜**：本文件只做数据查找，问题分类留在问答引擎一处。
   */
  selfIntro?: boolean;
  /** 住户这一句是不是在问**你能做什么**。同上，由问答引擎的窄识别器判。 */
  wantsCapabilities?: boolean;
  /**
   * 本轮住户语言判定（`turn.ts` 在轮次边界判一次）。**决定读哪一份原文**——英文轮次
   * 只读到英文段，中文轮次逐字读中文段。缺省中文，既有离线调用一行不改。
   */
  language?: LanguageDecision;
}): FeatureQaFactBundle {
  const language = args.language?.language ?? "zh";
  const blacklisted = selectBlacklistedCapabilities(
    args.question,
    args.referencedBlacklistedId
  ).map((c) => blacklistFact(c, language));
  const blocks = selectFeatureQaBlocks({
    selfIntro: args.selfIntro === true,
    wantsCapabilities: args.wantsCapabilities === true,
    hasBlacklisted: blacklisted.length > 0,
    language,
  });
  // 索引与能力段**同进同出**：选段函数说了这一轮要读 `capabilities.*`，才把这份索引
  // 交给模型（问身份 / 只问到某件办不到的事时都不给），避免"两处各判一次"再次跑偏。
  const asksCapabilities = blocks.some((b) => b.kind === "capabilities");
  const other: ResidentLanguage = language === "en" ? "zh" : "en";
  return {
    blocks,
    blacklisted,
    featureIndex: asksCapabilities
      ? args.openFeatures.map((f) => ({
          id: f.id,
          name: featureDisplayName(f, language),
        }))
      : [],
    forbiddenFeatureNames: asksCapabilities
      ? // 问了能力：本语言的登记名是索引（允许出现），只禁另一种语言的名字。
        args.openFeatures.map((f) => featureDisplayName(f, other))
      : // 没问能力：这一轮不该提具体功能，两种语言的登记名都禁。
        args.openFeatures.flatMap((f) => [f.label, f.labelEn]),
  };
}
