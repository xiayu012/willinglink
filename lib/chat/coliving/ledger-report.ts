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
  inputUncachedTokens: LedgerTokenTotal;
  cacheReadTokens: LedgerTokenTotal;
  cacheWriteTokens: LedgerTokenTotal;
  outputTokens: LedgerTokenTotal;
  reasoningTokens: LedgerTokenTotal;
};

/** 一份没有明细可用时的 token 汇总：每类都是"未知"，不是 0。 */
export const NO_TOKEN_TOTALS: LedgerTokenTotals = {
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
function sumTokenTotal(values: readonly (number | null)[]): LedgerTokenTotal {
  let sum = 0;
  let knownCount = 0;
  let hasUnknown = false;
  for (const v of values) {
    if (v === null) {
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
        `<th>非缓存输入</th><th>缓存读</th><th>缓存写</th><th>输出</th><th>推理</th>` +
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
