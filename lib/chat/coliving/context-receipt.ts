/**
 * **上下文回执的形状与工具名单**（纯模块：零 import、不碰 server-only / 数据库 /
 * 模型，运行时、评测脚本与报告渲染层都能安全复用）。
 *
 * 这个模块只定义"回执长什么样"，不负责产生它，也不负责渲染它：
 * - 运行时段落（sections）由 `context.ts` 的 `buildContext` 逐节产出；
 * - 按需检索工具名由 `turn.ts` 在主生成收尾时补上（那时才知道模型调了什么）；
 * - 渲染与归一化在 `ledger-report.ts`。
 *
 * ⚠️ 隐私纪律：回执**永远只有名字和数字**，没有承载正文的字段。这份类型定义是
 * 硬边界——它没有 body/text 之类的字段，所以住户原话、名册、规则文本、电话号
 * 在结构上就进不了回执；离线回归直接拿它和渲染层验证（见
 * `scripts/coliving-quality-inspect.ts`）。
 */

/**
 * 上下文分节的**收据**：只记分节 id 与字符数，**绝不记分节正文**。
 *
 * 与 `turn.ts` 的 `PromptComposition` 同一条纪律：观测只回答"这一轮运行时
 * 上下文由哪些节构成、各占多少"，不回答"里面写了什么"。
 */
export type ContextReceiptSection = {
  /** 分节 id，由代码写死、与文案无关（改措辞不会改 id）。 */
  id: string;
  /**
   * 这一节贡献的字符数。按最终运行时正文的换行口径算，只含本节自己的行
   * （含节尾空行），**不含**与下一节之间的那个连接换行。
   */
  chars: number;
};

/** `buildContext` 能确定的那部分回执：本轮上下文由哪些稳定分节拼成。 */
export type ContextSectionsReceipt = {
  /** 这一轮真正出现的分节，按出现顺序；条件分节没出现就不在列表里。 */
  sections: ContextReceiptSection[];
};

/**
 * 一轮的**完整上下文回执**（随 `TurnOutcome` 落到评测报告）：
 * 分节清单 + 本轮**真的跑过**的按需检索工具名。
 *
 * `retrievalToolNames` 由 `turn.ts` 在主生成收尾时补上——`buildContext` 那一刻
 * 还不知道模型会调什么工具。两者都只是名字/数字，绝无正文。
 */
export type ContextReceipt = ContextSectionsReceipt & {
  /** 本轮真正跑过的按需检索工具名（去重、稳定顺序）。没有跑就是空数组。 */
  retrievalToolNames: string[];
};

/**
 * **按需检索类工具**：只读、拉取额外上下文——不写字、不出站、不改状态。
 * 模型要靠自己判断"这轮要不要额外查"，所以它们默认不摆出来（见 `turn.ts`
 * 里 activeTools 的查询/观察组），命中结构或话题信号才给。
 *
 * 回执只报这些工具里**本轮真的跑过**的名字：名单写死在代码里，模型无法通过
 * 任何输入让回执带上别的字符串——报告渲染层也照这份名单过筛（`isContextRetrievalToolName`），
 * 所以连"旧报告 JSON 被人塞了别的字符串"都不会显示出来。
 */
export const CONTEXT_RETRIEVAL_TOOL_NAMES = [
  "checkEnvironment",
  "findSimilarCases",
  "lookupHistory",
  "recall",
] as const;

/** 某个名字是不是代码写死的按需检索工具。报告渲染层用它过筛。 */
export function isContextRetrievalToolName(name: string): boolean {
  return (CONTEXT_RETRIEVAL_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * 从本轮真实调用过的工具名里挑出按需检索类，**只留名字**：
 * 去重、按上面写死的名单顺序返回（顺序稳定，报告前后可比）。
 * 参数与查询正文一概不带——调用方只传 `toolsUsed` 这样的名字数组。
 */
export function retrievalToolNamesUsed(toolsUsed: readonly string[]): string[] {
  return CONTEXT_RETRIEVAL_TOOL_NAMES.filter((name) => toolsUsed.includes(name));
}

