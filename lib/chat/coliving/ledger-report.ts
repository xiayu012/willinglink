/**
 * 计费台账的**展示层**（纯函数，无副作用、不 import server-only）。
 *
 * 终端（`scripts/coliving-eval.ts`）和 HTML 报告（`scripts/coliving-report.ts`）
 * 共用这里的汇总与渲染，保证两边口径一致：
 *
 * - 三件东西分得清：**generation**（模型生成批次）、**step**（一轮工具往返）、
 *   **transport attempts**（本 SDK 不可观测 → `null`）。
 * - `null` / 缺失一律显示成"未知"，**绝不显示成 0**；明确回报的 0 才显示 0。
 * - 文本用 `import type` 引，运行时不依赖 `server-only` 的 gateway-ledger，
 *   因此普通 `tsx` 脚本（coliving-report）也能安全 import。
 */

import type { GenerationRecord, LedgerSnapshot } from "./gateway-ledger";
// 纯模块（零 import）：上下文回执里"哪些工具算按需检索"这份名单只有一处定义。
import { isContextRetrievalToolName } from "./context-receipt";

/** "上游未回报"的统一措辞——用在 token 这种可以为 null 的字段上。 */
export const TOKEN_UNKNOWN = "未知（上游未回报）";
/** 金额未知（≠ 0 花费）。 */
export const COST_UNKNOWN = "未知";
export const TRANSPORT_UNOBSERVABLE = "不可观测（null）";

/**
 * 一类 token 的汇总。`known` 是**已知项之和**（一个已知项都没有时是 `null`），
 * `hasUnknown` 表示**有 step 没回报这一类 token**——此时 `known` 只是下界，
 * 展示必须标"部分已知"，不能当完整总数（可能夸大或低估）。
 */
export type LedgerTokenTotal = {
  known: number | null;
  hasUnknown: boolean;
};

export type LedgerTokenTotals = {
  inputTotalTokens: LedgerTokenTotal;
  inputUncachedTokens: LedgerTokenTotal;
  cacheReadTokens: LedgerTokenTotal;
  cacheWriteTokens: LedgerTokenTotal;
  outputTokens: LedgerTokenTotal;
  reasoningTokens: LedgerTokenTotal;
};

/** 一份没有明细可用时的 token 汇总：每类都是"未知"，不是 0。 */
export const NO_TOKEN_TOTALS: LedgerTokenTotals = {
  inputTotalTokens: { known: null, hasUnknown: false },
  inputUncachedTokens: { known: null, hasUnknown: false },
  cacheReadTokens: { known: null, hasUnknown: false },
  cacheWriteTokens: { known: null, hasUnknown: false },
  outputTokens: { known: null, hasUnknown: false },
  reasoningTokens: { known: null, hasUnknown: false },
};

export type LedgerSummary = {
  generations: number;
  completedSteps: number;
  /** 本 SDK 不可观测 → 恒为 null；不要当 0。 */
  transportAttempts: number | null;
  transportObservability: string;
  tokens: LedgerTokenTotals;
  knownCostUsd: number;
  unknownCostGenerations: number;
  hasUnknownCost: boolean;
};

/**
 * 汇总一类 token：已知项相加，但**只要有 null（未回报）就记 `hasUnknown`**，
 * 让展示层能把"部分已知"和"完整总数"分开。全 null → `known` 是 null（未知），
 * 不显示成 0。
 */
function sumTokenTotal(
  values: readonly (number | null | undefined)[]
): LedgerTokenTotal {
  let sum = 0;
  let knownCount = 0;
  let hasUnknown = false;
  for (const v of values) {
    // 旧报告（v1/v2 早期）没有新字段：undefined 与 null 一样是"未回报"，
    // 不能当 0 参与求和（否则会出现 NaN）。
    if (v === null || v === undefined) {
      hasUnknown = true;
      continue;
    }
    sum += v;
    knownCount += 1;
  }
  return { known: knownCount > 0 ? sum : null, hasUnknown };
}

/** 把逐 generation 明细汇总成一份可展示的总账。 */
export function summarizeGenerations(
  records: readonly GenerationRecord[]
): LedgerSummary {
  const steps = records.flatMap((g) => g.steps);
  const knownCostUsd = records.reduce((sum, g) => sum + g.knownCostUsd, 0);
  const unknownCostGenerations = records.filter((g) => g.unknownCost).length;
  return {
    generations: records.length,
    completedSteps: records.reduce((sum, g) => sum + g.completedSteps, 0),
    transportAttempts: null,
    transportObservability:
      records.find((g) => g.transportObservability)?.transportObservability ??
      "不可观测（本 SDK 未暴露 transport retry 次数）",
    tokens: {
      inputTotalTokens: sumTokenTotal(steps.map((s) => s.inputTotalTokens)),
      inputUncachedTokens: sumTokenTotal(
        steps.map((s) => s.inputUncachedTokens)
      ),
      cacheReadTokens: sumTokenTotal(steps.map((s) => s.cacheReadTokens)),
      cacheWriteTokens: sumTokenTotal(steps.map((s) => s.cacheWriteTokens)),
      outputTokens: sumTokenTotal(steps.map((s) => s.outputTokens)),
      reasoningTokens: sumTokenTotal(steps.map((s) => s.reasoningTokens)),
    },
    knownCostUsd,
    unknownCostGenerations,
    hasUnknownCost: unknownCostGenerations > 0,
  };
}

/**
 * 一类 token 汇总的显示：
 * - 一个已知项都没有 → "未知"；
 * - 有已知也有未知 → 保留已知小计，并**明确标"部分已知（下界）"**，
 *   不显示成貌似完整的总数；
 * - 全部 step 都回报了 → 直接显示总数。
 */
export function formatTokenTotal(total: LedgerTokenTotal): string {
  if (total.known === null) return TOKEN_UNKNOWN;
  return total.hasUnknown
    ? `${total.known}（部分已知，下界）`
    : String(total.known);
}

/** 金额：null → "未知"；0 → "$0.000000"（已知的 0）。 */
export function formatUsd(value: number | null): string {
  return value === null ? COST_UNKNOWN : `$${value.toFixed(6)}`;
}

/**
 * "已知金额"这一栏的显示：**有未知项且已知合计恰好是 0 时显示"未知"，
 * 不显示 `$0.000000`**——那会被读成"这笔没花钱"，但真相是上游没回报
 * （不是 0）。有已知金额时照常显示；调用方可自行补"（下界）"说明。
 */
export function formatKnownCost(knownUsd: number, hasUnknown: boolean): string {
  if (hasUnknown && knownUsd === 0) return COST_UNKNOWN;
  return formatUsd(knownUsd);
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 一行 key/value。 */
function cell(label: string, value: string): string {
  return (
    `<div class="cost-item"><span class="ck">${escapeHtml(label)}</span>` +
    `<span class="cv">${escapeHtml(value)}</span></div>`
  );
}

const KIND_LABEL: Record<string, string> = {
  "text-generation": "文本生成",
  embedding: "向量化",
};

const STATUS_LABEL: Record<string, string> = {
  completed: "完成",
  partial: "部分（中途失败）",
  error: "失败",
};

/**
 * 渲染一个场景的计费证据面板。
 *
 * 兼容三态输入：
 * - 新版快照（有 `generationRecords`）→ 完整明细。
 * - 旧版快照（v1：只有 `calls`/`knownCostUsd`，没有明细）→ 显示 generation
 *   数与金额，step/token 标"未知（旧快照无逐 step 明细）"，**不当 0**。
 * - 没有快照 → 明说"本报告无计费明细"，不空白也不假装 0。
 */
export function renderLedgerPanelHtml(
  snapshot: LedgerSnapshot | null | undefined
): string {
  if (!snapshot) {
    return (
      `<details class="cost legacy"><summary>计费证据</summary>` +
      `<div class="cost-body"><div class="cost-note">` +
      `本报告没有计费台账（旧格式报告，或该路径未纳管）。未知就是未知，` +
      `不按 0 计。</div></div></details>`
    );
  }

  const hasRecords = Array.isArray(snapshot.generationRecords);
  const records = hasRecords ? snapshot.generationRecords : [];
  const generations = snapshot.generations ?? snapshot.calls ?? 0;
  const unknownCostGenerations =
    snapshot.unknownCostGenerations ?? snapshot.unknownCostCalls ?? 0;

  let summary: LedgerSummary | null = null;
  if (records.length > 0) summary = summarizeGenerations(records);

  const stepsText =
    summary !== null
      ? String(summary.completedSteps)
      : generations > 0
        ? "未知（旧快照无逐 step 明细）"
        : "0";
  const tokens = summary?.tokens ?? NO_TOKEN_TOTALS;
  const transportText =
    summary?.transportAttempts === null || summary === null
      ? TRANSPORT_UNOBSERVABLE
      : String(summary.transportAttempts);

  const items = [
    cell("generation（模型生成批次，不是 HTTP 请求数）", String(generations)),
    cell("已完成 step", stepsText),
    cell("transport attempts", transportText),
    cell("输入总量 token", formatTokenTotal(tokens.inputTotalTokens)),
    cell("非缓存输入 token", formatTokenTotal(tokens.inputUncachedTokens)),
    cell("缓存读 token", formatTokenTotal(tokens.cacheReadTokens)),
    cell("缓存写 token", formatTokenTotal(tokens.cacheWriteTokens)),
    cell("输出 token", formatTokenTotal(tokens.outputTokens)),
    cell("推理 token", formatTokenTotal(tokens.reasoningTokens)),
    cell(
      "已知 Gateway 花费",
      formatKnownCost(snapshot.knownCostUsd ?? 0, unknownCostGenerations > 0)
    ),
    cell(
      "未知花费 generation",
      `${unknownCostGenerations} 个${unknownCostGenerations > 0 ? "（已知金额是下界）" : ""}`
    ),
  ].join("");

  const bucketRow = (b: LedgerSnapshot["byStage"][number]) =>
    `<tr><td>${escapeHtml(b.key)}</td><td>${b.generations ?? b.calls ?? 0}</td>` +
    `<td>${escapeHtml(
      formatKnownCost(b.knownCostUsd ?? 0, (b.unknownCostCalls ?? 0) > 0)
    )}</td>` +
    `<td>${b.unknownCostCalls ?? 0}</td></tr>`;
  const stageRows = (snapshot.byStage ?? []).map(bucketRow).join("");
  const modelRows = (snapshot.byModel ?? []).map(bucketRow).join("");

  const detailRows = records
    .map((g) => {
      const stepTokens = summarizeGenerations([g]).tokens;
      return (
        `<tr>` +
        `<td>${g.seq}</td>` +
        `<td>${escapeHtml(g.stage)}</td>` +
        `<td>${escapeHtml(g.modelId)}</td>` +
        `<td>${escapeHtml(KIND_LABEL[g.operationKind] ?? g.operationKind)}</td>` +
        `<td>${escapeHtml(STATUS_LABEL[g.status] ?? g.status)}` +
        `${g.errorName ? `（${escapeHtml(g.errorName)}）` : ""}</td>` +
        `<td>${g.completedSteps}</td>` +
        `<td>${escapeHtml(
          g.steps.find((s) => s.upstreamProviderId)?.upstreamProviderId ??
            "未知"
        )}</td>` +
        `<td>${escapeHtml(formatTokenTotal(stepTokens.inputTotalTokens))}</td>` +
        `<td>${escapeHtml(formatTokenTotal(stepTokens.inputUncachedTokens))}</td>` +
        `<td>${escapeHtml(formatTokenTotal(stepTokens.cacheReadTokens))}</td>` +
        `<td>${escapeHtml(formatTokenTotal(stepTokens.cacheWriteTokens))}</td>` +
        `<td>${escapeHtml(formatTokenTotal(stepTokens.outputTokens))}</td>` +
        `<td>${escapeHtml(formatTokenTotal(stepTokens.reasoningTokens))}</td>` +
        `<td>${escapeHtml(formatKnownCost(g.knownCostUsd, g.unknownCost))}` +
        `${g.unknownCost && g.knownCostUsd > 0 ? "（下界）" : ""}</td>` +
        `<td>${g.durationMs}ms</td>` +
        `<td>${g.unknownCost ? "是" : "否"}</td>` +
        `</tr>`
      );
    })
    .join("");

  const stageTable =
    stageRows.length > 0
      ? `<table class="cost-table"><thead><tr><th>stage</th><th>generation</th>` +
        `<th>已知金额</th><th>未知</th></tr></thead><tbody>${stageRows}</tbody></table>`
      : "";
  const modelTable =
    modelRows.length > 0
      ? `<table class="cost-table"><thead><tr><th>model</th><th>generation</th>` +
        `<th>已知金额</th><th>未知</th></tr></thead><tbody>${modelRows}</tbody></table>`
      : "";
  const detailTable =
    detailRows.length > 0
      ? `<div class="cost-sub">逐 generation 明细</div>` +
        `<table class="cost-table wide"><thead><tr>` +
        `<th>#</th><th>stage</th><th>model</th><th>类型</th><th>状态</th><th>step</th>` +
        `<th>上游 provider</th><th>输入总量</th><th>非缓存输入</th>` +
        `<th>缓存读</th><th>缓存写</th><th>输出</th><th>推理</th>` +
        `<th>已知金额</th><th>耗时</th><th>未知</th>` +
        `</tr></thead><tbody>${detailRows}</tbody></table>`
      : "";

  return (
    `<details class="cost"><summary>计费证据（generation / step / token / cost）</summary>` +
    `<div class="cost-body">` +
    `<div class="cost-grid">${items}</div>` +
    `<div class="cost-note">transport attempts：${escapeHtml(
      summary?.transportObservability ??
        "不可观测（本 SDK 未暴露 transport retry 次数）"
    )}</div>` +
    stageTable +
    modelTable +
    detailTable +
    `</div></details>`
  );
}

// ── 提示词组成观测（观察层，不是计费层） ─────────────────────────────────
//
// 每轮 prompt 由什么构成：doctrine 多长、运行时状态多长、加载了哪些情境
// 模块、主生成摆了哪些工具。**只记长度和名称，不含任何提示词正文**。
// 和计费面板同一套纪律：未知一律显示"未知"，**绝不显示成 0/NaN**；
// 旧报告没有这个字段就不展示，不猜。

/** 归一化后的观测；每个字段都可能"未知"（null），不是 0。 */
export type NormalizedPromptComposition = {
  doctrineChars: number | null;
  runtimeChars: number | null;
  systemChars: number | null;
  moduleIds: string[] | null;
  toolNames: string[] | null;
  toolCount: number | null;
};

const PCOMP_UNKNOWN = "未知";

/** 只接受有限、非负的数字；其余（NaN/Infinity/负数/字符串）一律当未知。 */
function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function stringArrayOrNull(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

/**
 * 把报告里原始的观测字段归一化成可展示的三态：
 * - `undefined`：**旧报告没有这个字段** → 调用方不展示（不猜、不补 0）；
 * - `null`：这一轮没走模型（未知号码/短路/接管），**不是 0 字符**；
 * - 对象：逐字段归一化，坏字段记 null → 显示"未知"。
 *
 * 形状完全不认识的对象也当 `undefined`（不展示），避免把别的东西渲染成观测。
 */
export function normalizePromptComposition(
  raw: unknown
): NormalizedPromptComposition | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const toolNames = stringArrayOrNull(o.toolNames);
  const moduleIds = stringArrayOrNull(o.moduleIds);
  return {
    doctrineChars: finiteNonNegative(o.doctrineChars),
    runtimeChars: finiteNonNegative(o.runtimeChars),
    systemChars: finiteNonNegative(o.systemChars),
    moduleIds,
    toolNames,
    // 优先用实际报上来的数量；缺了就用工具名数组长度兜底；都没有=未知。
    toolCount: finiteNonNegative(o.toolCount) ?? (toolNames ? toolNames.length : null),
  };
}

/**
 * 渲染一轮的「提示词组成观测」块。
 *
 * **仅用于解释每轮 prompt 由什么构成，不构成删除/精简 doctrine 的依据**——
 * 报告里的抬头明说这一点，避免后人拿一个体量数字当"这段可以删"的证明。
 * 旧报告（字段缺席）返回空串；`null` 明说"本轮未调用模型"。
 */
export function renderPromptCompositionHtml(raw: unknown): string {
  const comp = normalizePromptComposition(raw);
  if (comp === undefined) return "";
  if (comp === null) {
    return (
      `<details class="cost pcomp"><summary>提示词组成观测</summary>` +
      `<div class="cost-body"><div class="cost-note">` +
      `本轮未调用模型（未构建提示词）——未知号码、简单肯定短路或状态机接管等` +
      `确定性路径。这里不是"0 字符"，是"没有这一层"。` +
      `</div></div></details>`
    );
  }
  const num = (v: number | null) => (v === null ? PCOMP_UNKNOWN : String(v));
  const list = (v: string[] | null) =>
    v === null ? PCOMP_UNKNOWN : v.length > 0 ? v.join("、") : "（无）";
  const items = [
    cell("常驻 + 情境 doctrine 字符", num(comp.doctrineChars)),
    cell("运行时状态字符", num(comp.runtimeChars)),
    cell("system 总字符", num(comp.systemChars)),
    cell("已加载 doctrine 模块", list(comp.moduleIds)),
    cell(
      "暴露给模型的工具数",
      comp.toolCount === null ? PCOMP_UNKNOWN : String(comp.toolCount)
    ),
  ].join("");
  return (
    `<details class="cost pcomp">` +
    `<summary>提示词组成观测（只记长度与名称，不含提示词正文）</summary>` +
    `<div class="cost-body">` +
    `<div class="cost-grid">${items}</div>` +
    `<div class="cost-note">暴露给模型的工具：${escapeHtml(list(comp.toolNames))}</div>` +
    `<div class="cost-note">system 总字符 ≈ doctrine + runtime（还含两者之间的` +
    `固定分隔符）；不含评测 guidance（--guidance 实验专用，生产不传）。</div>` +
    `<div class="cost-note">这是观测：只用于解释每轮 prompt 由什么构成，` +
    `单独不构成删除或精简 doctrine 的依据。</div>` +
    `</div></details>`
  );
}

// ── 上下文回执（观察层，与上面的 prompt 观测同一条纪律） ─────────────────
//
// 每轮上下文由哪些分节拼成、各占多少字符，本轮真跑过哪些**按需检索**工具、
// 各调了几次、拉回的字符串有多少字符，本轮判成了哪种语言、依据是什么，
// 以及本轮喂给主生成的对话历史有多少条 / 多少字符（有界化丢了多少）。
// **没有正文**——回执形状里根本没有承载正文的字段，所以渲染层也无从泄漏分节
// 内容、工具返回或住户原话；这里再防御四层：
//   1. 分节只认 `id`（字符串）和 `chars`（有限非负数），多余字段一律不读；
//   2. 检索工具名**只认代码写死在 `context-receipt.ts` 里的那几个名字**，
//      报告 JSON 里即使被塞了别的字符串（例如某段正文），也不会渲染出来；
//   3. 次数与字符数只接受有限非负数，其余（NaN/负数/字符串/缺席）记"未知"，
//      **不显示成 0**；
//   4. 语言那一栏的两个字段都是**代码认识的枚举**（en/zh、三种来源），
//      不匹配就整栏记未知——报告 JSON 里塞什么字符串都进不了渲染。
// 未知照旧显示"未知"，不显示成 0；旧报告没这个字段就不展示（旧版回执只有
// 名字数组 `retrievalToolNames`，照样认：名字照渲染，次数与字符数记未知）。

/** 归一化后的一节：`chars` 可能"未知"（null），不是 0。 */
export type NormalizedContextSection = {
  id: string;
  chars: number | null;
};

/** 归一化后的一类按需检索工具的观测：两个数字都可能"未知"（null），不是 0。 */
export type NormalizedRetrievalObservation = {
  name: string;
  /** `null` = 旧报告只记了名字、没记次数（未知），不是"0 次"。 */
  calls: number | null;
  /** `null` = 旧报告没记 / 这次读不出字符数（未知），不是"0 字符"。 */
  returnedChars: number | null;
};

/** 归一化后的语言判定：两个字段都是**代码认识的枚举值**，不可能是任意字符串。 */
export type NormalizedLanguageObservation = {
  language: "en" | "zh";
  source: "direct" | "conversation-fallback" | "default";
};

/** 归一化后的历史有界化观测：每个计数都可能"未知"（null），不是 0。 */
export type NormalizedHistoryObservation = {
  consideredTurns: number | null;
  keptTurns: number | null;
  droppedTurns: number | null;
  keptChars: number | null;
  droppedChars: number | null;
};

/** 归一化后的回执；`null` = 这一轮没构建上下文。 */
export type NormalizedContextReceipt = {
  sections: NormalizedContextSection[];
  /**
   * 本轮跑过的按需检索观测（已按写死的名单过筛、去重）；
   * `null` = 这一栏整个未知（旧报告连名字都没有），
   * 空数组 = 明确没跑任何按需检索。
   */
  retrievalObservations: NormalizedRetrievalObservation[] | null;
  /** 本轮语言判定；`null` = 旧报告没记 / 形状不认识（未知，不猜一种语言出来）。 */
  language: NormalizedLanguageObservation | null;
  /** 本轮历史有界化；`null` = 旧报告没记这一栏（未知，不按 0 条算）。 */
  history: NormalizedHistoryObservation | null;
};

/**
 * 把报告里原始的收据字段归一化成三态（与 `normalizePromptComposition` 同规矩）：
 * - `undefined`：旧报告没有这个字段 → 调用方不展示（不猜、不补 0）；
 * - `null`：这一轮没走主提示词 → 不是"0 个分节"；
 * - 对象：逐节归一化，只取 `id` + `chars`，坏节丢弃 / 坏字符数记 null；
 *   检索工具名只保留代码认识的（见 `isContextRetrievalToolName`）。
 *
 * 形状完全不认识的（`sections` 不是数组）也当 `undefined`，避免把别的东西
 * 渲染成收据。**id 只当字符串渲染，不做任何语义解释。**
 */
export function normalizeContextReceipt(
  raw: unknown
): NormalizedContextReceipt | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const sections = o.sections;
  if (!Array.isArray(sections)) return undefined;
  const normalized: NormalizedContextSection[] = [];
  for (const entry of sections) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0) continue;
    normalized.push({
      id,
      chars: finiteNonNegative((entry as Record<string, unknown>).chars),
    });
  }
  // 只留代码认识的检索工具名：这是"渲染层绝不显示任意字符串"的结构性保证，
  // 也让工具的增删只发生在 `context-receipt.ts` 一处。
  const retrieval = normalizeRetrievalObservations(o);
  return {
    sections: normalized,
    retrievalObservations: retrieval,
    language: normalizeLanguageObservation(o.language),
    history: normalizeHistoryObservation(o.history),
  };
}

/**
 * 归一化"本轮语言判定"这一栏。
 *
 * **只认代码写死的枚举**，做法与检索工具名同一条：报告 JSON 里即使被塞了任意
 * 字符串（`language: "住户原话……"`），也进不了渲染——两个字段各自按白名单取值，
 * 不匹配就整栏记**未知**（`null`）。旧报告没有这一栏，同样是未知，
 * **绝不替它猜一种语言**。
 */
function normalizeLanguageObservation(
  raw: unknown
): NormalizedLanguageObservation | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const language = o.language;
  const source = o.source;
  if (language !== "en" && language !== "zh") return null;
  if (
    source !== "direct" &&
    source !== "conversation-fallback" &&
    source !== "default"
  ) {
    return null;
  }
  // 显式逐字段取值：多出来的字段（哪怕名字叫 text）一律不带出去。
  return { language, source };
}

/**
 * 归一化"本轮历史有界化"这一栏：五个计数各自归一化，坏了记**未知**（null），
 * **不显示成 0**（"0 条被丢"和"没记这件事"是两件事）。整栏形状不认识（旧报告
 * 没有这一栏）→ `null`。
 */
function normalizeHistoryObservation(
  raw: unknown
): NormalizedHistoryObservation | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    consideredTurns: finiteNonNegative(o.consideredTurns),
    keptTurns: finiteNonNegative(o.keptTurns),
    droppedTurns: finiteNonNegative(o.droppedTurns),
    keptChars: finiteNonNegative(o.keptChars),
    droppedChars: finiteNonNegative(o.droppedChars),
  };
}

/**
 * 归一化"本轮按需检索观测"这一栏，**两种报告格式都认**：
 * - 新版：`retrievalObservations: [{ name, calls, returnedChars }]` —— 名字过筛，
 *   两个数字各自归一化（坏值记未知）；
 * - 旧版：只有 `retrievalToolNames: string[]` —— 名字照渲染，次数与字符数记
 *   **未知**（那时确实没记，不能拿 1 或 0 冒充）；
 * - 两栏都没有：整栏 `null`（未知）——旧报告本来就没这项观测。
 *
 * 同名只留第一条；名单外的字符串（报告 JSON 若被人塞了正文）一律丢弃。
 */
function normalizeRetrievalObservations(
  o: Record<string, unknown>
): NormalizedRetrievalObservation[] | null {
  const raw = o.retrievalObservations;
  if (Array.isArray(raw)) {
    const seen = new Set<string>();
    const out: NormalizedRetrievalObservation[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const name = record.name;
      if (
        typeof name !== "string" ||
        !isContextRetrievalToolName(name) ||
        seen.has(name)
      ) {
        continue;
      }
      seen.add(name);
      out.push({
        name,
        calls: finiteNonNegative(record.calls),
        returnedChars: finiteNonNegative(record.returnedChars),
      });
    }
    return out;
  }
  const rawNames = stringArrayOrNull(o.retrievalToolNames);
  if (rawNames === null) return null;
  const seen = new Set<string>();
  const out: NormalizedRetrievalObservation[] = [];
  for (const name of rawNames.filter(isContextRetrievalToolName)) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, calls: null, returnedChars: null });
  }
  return out;
}

/**
 * 渲染一轮的「上下文回执」块：
 * - **分节清单**：一个紧凑列表，每行是节 id、字符数、占运行时上下文的份额；
 * - **按需检索足迹**：本轮真跑过哪几类，各调了几次、拉回多少字符串字符。
 *
 * 旧报告（字段缺席）返回空串；`null` 明说"本轮未构建上下文"。
 * 列表项只取归一化后的 id/chars，工具名只取代码认识的名字，因此收据对象上
 * 即使被塞进了额外字段（例如某段正文），也**不会**出现在输出里。
 */
export function renderContextReceiptHtml(raw: unknown): string {
  const receipt = normalizeContextReceipt(raw);
  if (receipt === undefined) return "";
  if (receipt === null) {
    return (
      `<details class="cost ctx-receipt"><summary>上下文回执</summary>` +
      `<div class="cost-body"><div class="cost-note">` +
      `本轮未构建上下文（未走主提示词）——未知号码、简单肯定短路、功能前门或` +
      `状态机接管等确定性路径。这里不是"0 个分节"，是"没有这一层"。` +
      `</div></div></details>`
    );
  }
  // 份额的分子分母都只用**已知**字符数：有任一节没回报就标"部分已知"，
  // 不把分母悄悄换成一个看起来完整的数。
  const knownChars = receipt.sections
    .map((s) => s.chars)
    .filter((c): c is number => c !== null);
  const sectionTotal = knownChars.reduce((sum, c) => sum + c, 0);
  const sectionTotalUnknown = knownChars.length !== receipt.sections.length;
  const share = (chars: number | null): string => {
    if (chars === null) return PCOMP_UNKNOWN;
    if (sectionTotal <= 0) return "—";
    return `${Math.round((chars / sectionTotal) * 100)}%`;
  };
  const items =
    receipt.sections.length > 0
      ? receipt.sections
          .map(
            (s) =>
              `<li><span class="ck">${escapeHtml(s.id)}</span>` +
              `<span class="cv">${s.chars === null ? PCOMP_UNKNOWN : s.chars}</span>` +
              `<span class="cs">${share(s.chars)}</span></li>`
          )
          .join("")
      : `<li><span class="ck">（无分节）</span><span class="cv">${PCOMP_UNKNOWN}</span><span class="cs"></span></li>`;

  const retrieval = receipt.retrievalObservations;
  const retrievalItems =
    retrieval === null
      ? ""
      : retrieval
          .map(
            (o) =>
              `<li><span class="ck">${escapeHtml(o.name)}</span>` +
              `<span class="cv">${o.calls === null ? PCOMP_UNKNOWN : o.calls}</span>` +
              `<span class="cs">${
                o.returnedChars === null
                  ? PCOMP_UNKNOWN
                  : `${o.returnedChars} 字符`
              }</span></li>`
          )
          .join("");
  // 合计分三种情形，**"全都没记"绝不写成 0**：
  //  - 有已知项、也有未知项 → 数字 + "部分已知，是下界"（下界是诚实的）；
  //  - **一项都没记** → 只写"未知"，一个数字都不给：此时按 0 求和得到的是
  //    "共 0 次调用"，而事实是"跑了、但没记次数"，两者读起来正好相反
  //    （旧版回执只记工具名，走的就是这条路）；
  //  - 全都有 → 直接给数字。
  const callValues = retrieval?.map((o) => o.calls) ?? [];
  const knownCalls = callValues.filter((c): c is number => c !== null);
  const callsTotal = knownCalls.reduce((sum, c) => sum + c, 0);
  const charsValues = retrieval?.map((o) => o.returnedChars) ?? [];
  const knownReturnedChars = charsValues.filter((c): c is number => c !== null);
  const charsTotal = knownReturnedChars.reduce((sum, c) => sum + c, 0);
  const callsTotalText =
    knownCalls.length === 0
      ? `${PCOMP_UNKNOWN}（没有任何一条记了次数，不按 0 算）`
      : `${callsTotal}${knownCalls.length < callValues.length ? "（部分已知，是下界）" : ""}`;
  const charsTotalText =
    knownReturnedChars.length === 0
      ? `${PCOMP_UNKNOWN}（没有任何一条记了字符数，不按 0 算）`
      : `${charsTotal}${knownReturnedChars.length < charsValues.length ? "（部分已知，是下界）" : ""}`;
  const retrievalSummary =
    retrieval === null
      ? `本轮真正跑过的按需检索工具：${PCOMP_UNKNOWN}（旧报告没记这一栏）`
      : retrieval.length === 0
        ? "本轮真正跑过的按需检索工具：（无——本轮没有额外按需检索，0 次调用）"
        : `本轮真正跑过的按需检索工具：调用次数 ${callsTotalText}、` +
          `返回字符串字符数 ${charsTotalText}`;

  // 语言那一栏只渲染**代码认识的枚举**：显示名在这里翻译，绝不放任意字符串。
  const LANGUAGE_LABELS: Record<string, string> = { en: "英文", zh: "中文" };
  const LANGUAGE_SOURCE_LABELS: Record<string, string> = {
    direct: "原话自己就能定",
    "conversation-fallback": "原话定不了，读会话里最近判得出来的那条",
    default: "原话与会话都定不了，用默认",
  };
  const language = receipt.language;
  const languageSummary =
    language === null
      ? `本轮回复语言：${PCOMP_UNKNOWN}（旧报告没记这一栏，不猜是哪种语言）`
      : `本轮回复语言：${language.language}（${
          LANGUAGE_LABELS[language.language] ?? PCOMP_UNKNOWN
        }）· 判定来源：${language.source}（${
          LANGUAGE_SOURCE_LABELS[language.source] ?? PCOMP_UNKNOWN
        }）`;

  const history = receipt.history;
  const count = (v: number | null) => (v === null ? PCOMP_UNKNOWN : String(v));
  const historySummary =
    history === null
      ? `本轮对话历史：${PCOMP_UNKNOWN}（旧报告没记这一栏，不按 0 条算）`
      : `本轮对话历史：仓库给了 ${count(history.consideredTurns)} 条 / ` +
        `进主生成 ${count(history.keptTurns)} 条 / 有界化丢掉 ` +
        `${count(history.droppedTurns)} 条；保留正文 ${count(
          history.keptChars
        )} 字符 / 丢掉 ${count(history.droppedChars)} 字符`;

  return (
    `<details class="cost ctx-receipt">` +
    `<summary>上下文回执（只记分节 id / 字符数、检索工具名 / 次数 / 返回字符数、` +
    `语言判定与来源、历史条数 / 字符数，不含正文）</summary>` +
    `<div class="cost-body">` +
    `<ul class="ctx-sections">${items}</ul>` +
    `<div class="cost-note">运行时上下文分节合计：${
      receipt.sections.length === 0
        ? `${PCOMP_UNKNOWN}（本轮没有分节）`
        : knownChars.length === 0
          ? `${PCOMP_UNKNOWN}（没有一节回报字符数，不按 0 算；份额也因此算不出来）`
          : `${sectionTotal} 字符${sectionTotalUnknown ? "（部分已知，下界）" : ""}` +
            `（份额按这个合计算）`
    }</div>` +
    `<div class="cost-note">${escapeHtml(retrievalSummary)}</div>` +
    `<div class="cost-note">${escapeHtml(languageSummary)}</div>` +
    `<div class="cost-note">${escapeHtml(historySummary)}</div>` +
    (retrievalItems
      ? `<ul class="ctx-sections">${retrievalItems}</ul>` +
        `<div class="cost-note">检索三列依次是：工具名 / 本轮调用次数 / 返回内容里的` +
        `字符串字符数（含键名，不含 JSON 标点，只用于横向比较，不是精确字节数）。` +
        `读不出字符数就记${PCOMP_UNKNOWN}，不拿偏小的和冒充总数。</div>`
      : retrieval === null
        ? ""
        : `<div class="cost-note">本轮一次按需检索都没跑（不是${PCOMP_UNKNOWN}）。</div>`) +
    `<div class="cost-note">这是观测：只用于解释每轮上下文由哪些分节拼成、` +
    `模型额外去查了几类、拉回多少，单独不构成增删分节或增减工具的依据。字符数按各节` +
    `自身口径算，不含节与节之间的连接换行。</div>` +
    `</div></details>`
  );
}

// ── 逐轮账（观察层，评测报告专用） ───────────────────────────────────────
//
// 把**已经记好的**评测台账按 `turnIndex` 标签折成"这一轮花了多少"。
// 这里不新增任何埋点、不改运行时：数据源就是台账里已有的 `GenerationRecord`
// （标签只有 run/scenario/turn 这类标识，**绝无住户正文**）。
//
// 三态是这条设计的重点，不能糊成两个：
//  1. 这一轮**没有主生成**（未知号码 / 简单肯定短路 / 功能前门 / 状态机接管 /
//     共同规则协商）→ **null**（"没有这一层"）。这几条路径里有的确实调过模型
//     （功能前门的路由与写正文、状态机措辞），但那不是主生成，把它们算进
//     "本轮主生成的上下文成本"会直接把结论带偏；
//  2. **不可用**（旧报告没有这个字段、或整轮没有记账）→ 同样不出数字；
//  3. **真实的 0**（跑过主生成、上游如实回报了 0）→ 照实显示 0。
// 判据只看代码写死的 `stage === "main"`，不靠"这一轮有没有记录"猜。

/** 一轮主生成的账（评测报告专用）。字段口径与场景级台账一致。 */
export type TurnLedgerSummary = {
  /** 本轮已记账的 **generation 总数**（含兜底补回复 `forced-sendReply`、
   *  以及工具里触发的向量化 `embed`）——**不是 HTTP 请求数**。 */
  generations: number;
  /** 其中主生成（`stage === "main"`）的个数；为 0 → 整份摘要是 `null`。 */
  mainGenerations: number;
  /** 本轮已完成的 step 数（带工具时一轮主生成不止一次往返）。 */
  completedSteps: number;
  tokens: LedgerTokenTotals;
  /** 已知金额合计；有未知项时是下界。 */
  knownCostUsd: number;
  unknownCostGenerations: number;
  hasUnknownCost: boolean;
};

/**
 * 按 `turnIndex` 标签把台账折成**这一轮**的账。
 *
 * 返回 `null` 的两种情形都表示"没有这一层的数字"，不是 0：
 * - 这一轮一条记录都没有（确定性路径，压根没调模型）；
 * - 这一轮有记录、但**没有一条是主生成**（功能前门 / 状态机接管这类只调了
 *   窄路径模型）。
 *
 * 只按标签筛，不猜别的：`turnIndex` 由评测 runner 在轮边界打（`runWithLedgerLabels`），
 * 判定器（judge）跑在轮外、标签是 null，因此**不在任何一轮的账里**——
 * 各轮之和不等于场景总计，这是设计如此（报告里明说）。
 */
export function summarizeTurnLedger(
  records: readonly GenerationRecord[],
  turnIndex: number
): TurnLedgerSummary | null {
  const mine = records.filter((r) => r.turnIndex === turnIndex);
  const mainGenerations = mine.filter((r) => r.stage === "main").length;
  if (mainGenerations === 0) return null;
  const summary = summarizeGenerations(mine);
  return {
    generations: summary.generations,
    mainGenerations,
    completedSteps: summary.completedSteps,
    tokens: summary.tokens,
    knownCostUsd: summary.knownCostUsd,
    unknownCostGenerations: summary.unknownCostGenerations,
    hasUnknownCost: summary.hasUnknownCost,
  };
}

/** 归一化后的一轮账；每个数字都可能"未知"（null），不是 0。 */
export type NormalizedTurnLedger = {
  generations: number | null;
  mainGenerations: number | null;
  completedSteps: number | null;
  tokens: LedgerTokenTotals;
  knownCostUsd: number | null;
  unknownCostGenerations: number | null;
};

/**
 * 归一化报告里的一轮账（三态，与 `normalizePromptComposition` 同规矩）：
 * - `undefined`：旧报告没有这个字段 → 调用方不展示；
 * - `null`：这一轮没有主生成 / 不可用 → 明说，**不显示成 0**；
 * - 对象：逐字段归一化，坏值（NaN/负数/非数/字符串）记 null → 显示"未知"。
 *
 * 形状完全不认识的（不是对象）也当 `undefined`，避免把别的东西渲染成账。
 */
export function normalizeTurnLedgerSummary(
  raw: unknown
): NormalizedTurnLedger | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  // tokens 是 `{known, hasUnknown}` 逐类结构（就是 `summarizeGenerations` 的产出）。
  // 照原样读回来：`known` 坏值 → null（未知）；`hasUnknown` 只认布尔 true。
  // 缺失/形状不对的整类当成"未知"，不补 0。
  const tokensRaw =
    typeof o.tokens === "object" && o.tokens !== null && !Array.isArray(o.tokens)
      ? (o.tokens as Record<string, unknown>)
      : {};
  const token = (key: string): LedgerTokenTotal => {
    const raw = tokensRaw[key];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { known: null, hasUnknown: false };
    }
    const t = raw as Record<string, unknown>;
    return {
      known: finiteNonNegative(t.known),
      hasUnknown: t.hasUnknown === true,
    };
  };
  return {
    generations: finiteNonNegative(o.generations),
    mainGenerations: finiteNonNegative(o.mainGenerations),
    completedSteps: finiteNonNegative(o.completedSteps),
    tokens: {
      inputTotalTokens: token("inputTotalTokens"),
      inputUncachedTokens: token("inputUncachedTokens"),
      cacheReadTokens: token("cacheReadTokens"),
      cacheWriteTokens: token("cacheWriteTokens"),
      outputTokens: token("outputTokens"),
      reasoningTokens: token("reasoningTokens"),
    },
    knownCostUsd: finiteNonNegative(o.knownCostUsd),
    unknownCostGenerations: finiteNonNegative(o.unknownCostGenerations),
  };
}

/**
 * 渲染一轮的「本轮账（主生成）」块。**只记数量与 token，不含任何提示词/正文。**
 *
 * 旧报告（字段缺席）返回空串；`null` 明说"本轮没有主生成账"——这与"花了 0"
 * 是两件事，措辞上必须分开，否则读报告的人会把"这一轮没走主生成"记成"这一轮
 * 不要钱"。
 */
export function renderTurnLedgerHtml(raw: unknown): string {
  const ledger = normalizeTurnLedgerSummary(raw);
  if (ledger === undefined) return "";
  if (ledger === null) {
    return (
      `<details class="cost turn-ledger"><summary>本轮账（主生成）</summary>` +
      `<div class="cost-body"><div class="cost-note">` +
      `本轮没有主生成账：要么这一轮根本没跑主生成（未知号码、简单肯定短路、` +
      `功能前门、状态机接管等确定性路径），要么这一轮没有记账（不可用）。` +
      `两种都不是"花了 0"——这里不显示 0。` +
      `</div></div></details>`
    );
  }
  const num = (v: number | null) => (v === null ? PCOMP_UNKNOWN : String(v));
  const known = ledger.knownCostUsd;
  const unknownCost = ledger.unknownCostGenerations;
  // 已知金额为 null（这一栏整个没记）→ "未知"；**不走 formatKnownCost(0, …)**，
  // 否则 `unknownCost` 也是 null 时会渲染成 `$0.000000`——那是凭空造出来的 0。
  const costText =
    known === null
      ? COST_UNKNOWN
      : formatKnownCost(known, (unknownCost ?? 0) > 0);
  const unknownCostText =
    unknownCost === null
      ? PCOMP_UNKNOWN
      : `${unknownCost} 个${unknownCost > 0 ? "（已知金额是下界）" : ""}`;
  const items = [
    cell("本轮 generation（含兜底补回复与工具内向量化）", num(ledger.generations)),
    cell("其中主生成", num(ledger.mainGenerations)),
    cell("已完成 step", num(ledger.completedSteps)),
    cell("输入总量 token", formatTokenTotal(ledger.tokens.inputTotalTokens)),
    cell("非缓存输入 token", formatTokenTotal(ledger.tokens.inputUncachedTokens)),
    cell("缓存读 token", formatTokenTotal(ledger.tokens.cacheReadTokens)),
    cell("输出 token", formatTokenTotal(ledger.tokens.outputTokens)),
    cell("推理 token", formatTokenTotal(ledger.tokens.reasoningTokens)),
    cell("本轮已知花费", costText),
    cell("未知花费 generation", unknownCostText),
  ].join("");
  return (
    `<details class="cost turn-ledger">` +
    `<summary>本轮账（按 turn 标签折出来的主生成成本）</summary>` +
    `<div class="cost-body">` +
    `<div class="cost-grid">${items}</div>` +
    `<div class="cost-note">口径：只算打了本轮标签的 generation——即这一轮` +
    `主生成及其兜底补回复、工具里触发的向量化；语义验收（judge）跑在轮外、` +
    `不带轮标签，所以各轮之和不等于场景总计，差额在场景计费面板里。</div>` +
    `<div class="cost-note">这是观测：只用于比较各轮的上下文/生成成本，` +
    `单独不构成改动提示词、工具或模型的依据。</div>` +
    `</div></details>`
  );
}

// ── Context Engineering 面板（把三块观测并到一起看） ─────────────────────
//
// 这一轮"模型实际背了多重的上下文、额外去查了什么、为此花了多少"是三个分开
// 记录的事实，但要**并排看**才有意义（单看任一项都无法判断优化该往哪走）。
// 这里只做拼接与抬头，不改任何一块自己的口径；三块各自仍是三态（缺席/null/值），
// 缺失一律**明说**，不补 0、不判对错，也不触发任何告警或阻断。

/**
 * 渲染一轮的「Context Engineering」面板：提示词组成 + 上下文回执（含检索足迹）
 * + 本轮账。三块各自处理三态；**三块都缺席**（旧格式报告）时给一句明说的说明，
 * 而不是空白、也不是"0"。
 */
export function renderContextEngineeringPanelHtml(raw: {
  promptComposition?: unknown;
  contextReceipt?: unknown;
  turnLedger?: unknown;
}): string {
  const inner =
    renderPromptCompositionHtml(raw.promptComposition) +
    renderContextReceiptHtml(raw.contextReceipt) +
    renderTurnLedgerHtml(raw.turnLedger);
  if (inner === "") {
    return (
      `<div class="ce-panel"><div class="ce-title">Context Engineering（逐轮观测）</div>` +
      `<div class="cost-note">本报告的这一轮没有 Context Engineering 观测` +
      `（旧格式报告）——缺席就是缺席，不是"这轮没有成本、没有检索"。</div></div>`
    );
  }
  return (
    `<div class="ce-panel">` +
    `<div class="ce-title">Context Engineering（逐轮观测：提示词组成 / 上下文` +
    `分节 / 按需检索足迹 / 本轮账；只记名字与数字，不含正文）</div>` +
    inner +
    `<div class="cost-note">三块都是观测：可用来横向比较各轮的上下文与生成` +
    `负担，本身不做正确性判断、不触发告警，也不构成增删提示词或工具的依据。` +
    `"未知 / 没有这一层"与"0"是两件事，报告里分开写。</div>` +
    `</div>`
  );
}
