import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * **评测专用的 Gateway 真实计费台账（只读账本 + 预算闸 + 逐层计费证据）。**
 *
 * 为什么要有这个：`coliving-eval` 一次跑批会发起几百次 Gateway 调用，之前
 * 只能事后看账单，跑之前**没法说"最多花多少、最多调几次"**。这里把每一次
 * `generateText` 调用登记下来，累计 gateway 真实回报的 `providerMetadata.
 * gateway.cost`，在达到上限时**在发起下一次之前**抛错停下。
 *
 * ## 三层计数不能互相冒充（本文件的核心口径）
 *
 * 一次"钱花在哪"的追问横跨三层，任何一层的数字都不能当成另一层：
 *
 * 1. **generation**：一次 `trackedGatewayCall` 包住的调用（`generateText` /
 *    `embed`）。这是本台账 `calls` / `generations` 和预算闸真正限制的单位。
 *    **一个 generation 不是一次 HTTP 请求**——SDK 内部会对失败请求做
 *    transport retry，重试发生在同一个 generation 内。
 * 2. **step**：一次带工具的 `generateText` 会多次往返模型（每次调完工具再问
 *    一遍），每一步是一个 step。`generateText` 的 `result.steps` 与
 *    `onStepFinish` 都按 step 给用量与 `gateway.cost`。一个 step 里还可能发生
 *    多个工具调用（工具执行期间的 embedding 是**另一次 generation**）。
 * 3. **transport attempt**：SDK 对单次 HTTP 请求的内部重试次数。**本版本
 *    （ai@6.0.0-beta.159）没有暴露这个数字**：`onStepFinish` 只在重试全部
 *    结束后按 step 触发一次，看不到中间过程。因此台账里
 *    `transportAttempts` 一律是 `null`（并附 `transportObservability`
 *    说明），**绝不拿 generation 数冒充 HTTP 请求数**。
 *
 * 逐层证据存在 `GenerationRecord.steps[]` 里（每步 tokens/cache/cost/
 * finishReason/provider id），缺字段一律 `null`——**null 是"上游没回报"，
 * 不是 0 花费**；明确回报字符串 `"0"` 的才是已知的 0。
 *
 * ## 三条安全性质
 *
 * 1. **生产不受影响**：`trackedGatewayCall` 只在 `AsyncLocalStorage` 里有
 *    台账时记账；生产路径没有台账（`currentEvalLedger()` 为 undefined），
 *    直接透传 `run(空 recorder)`，不登记、不加 `onStepFinish`（调用方用
 *    `recorder.stepOptions` 展开，空对象 = 参数逐字不变）。
 * 2. **并发隔离**：本地台账挂在 `AsyncLocalStorage` 上，`runWithEvalLedger`
 *    给每个场景开一份独立上下文；run/scenario/turn 标签另挂在
 *    `runWithLedgerLabels` 的上下文里，嵌套异步调用继承、并发不串场。
 * 3. **缺钱不当作 0**：`gateway` 没回报 `cost` 时标记 `unknown`，绝不把
 *    缺失当 0 累加后声称"花费已知"。金额上限用已知累计判断（诚实口径：
 *    能算的算准，算不到的明说算不到），是软硬混合——达到线后拦住下一次，
 *    单次请求可能略微越过；不宣称是绝对硬上限，也不宣称管得住 transport。
 *
 * ## 两种上限口径：整批共享预算 vs 单份台账
 *
 * `--max-cost-usd` / `--max-generations`（旧名 `--max-model-calls`）的语义是
 * **整次跑批**的总上限，**不是每个场景各一份**——否则 5 个场景会把 4 美元
 * 放大到 20 美元。因此上限只放在一个 `BatchBudget`（整批唯一）里，所有场景的
 * `GatewayCostLedger` 都指向它：本地只管记录收据，全局计数与限流由
 * `BatchBudget` 独有。`GatewayCostLedger` 单独用时（没有共享预算）会为
 * 自己建一份私有 `BatchBudget`，行为与旧版逐字一致。
 *
 * ## 调用数上限是硬的（但只硬到 generation 这一层）
 *
 * `maxModelCalls`（= generation 上限）是严格硬上限：第 N 次之后、第 N+1 次
 * **发起前**即抛 `EvalBudgetExceededError`，不会真的发出去。
 * `BatchBudget.beforeCall` 是**同步**的（检查与自增之间没有 await），所以
 * 并发场景下全局调用数依然是硬上限，不会因为并发窗口多放一次。**它管不住
 * 一个 generation 内部的 step 与 transport retry**——那些不经过这里。
 *
 * 注释里记的这些边界都是**评测口径**，不要拿它当生产配额系统用。
 */

/** 新快照的结构版本。旧报告没有这个字段（按 1 处理），读取方必须容忍缺席。 */
export const LEDGER_SCHEMA_VERSION = 2;

/** 一次调用的种类：文本生成走 step hook，embedding 没有 hook、单独记一笔。 */
export type LedgerOperationKind = "text-generation" | "embedding";

/** 一个调用维度（stage 或 model）下累计到的账。 */
export type LedgerBucket = {
  key: string;
  /**
   * generation 数（历史字段名 `calls`，保留兼容）。**不是 HTTP 请求数**，
   * 也不含一个 generation 内部的 step 与 transport retry。
   */
  calls: number;
  /** 准确别名：等于 `calls`，让 JSON 自己说得清这是什么。 */
  generations: number;
  knownCostUsd: number;
  unknownCostCalls: number;
};

/**
 * 一个**已完成 step** 的计费读数。字段全部可能为 `null`——`null` 表示
 * 上游没回报（未知），**不是 0**。
 *
 * 刻意不记录 prompt/回复正文、密钥、电话号码：这是计费证据，不是内容副本。
 */
export type StepUsageRecord = {
  /** 该 generation 内第几步（从 0 起）。 */
  index: number;
  /**
   * 输入总量（上游回报口径）。注意 Anthropic 的 `input_tokens` 是**非缓存**
   * 输入，与总量不同；能算出总量时给值，算不出就是 `null`（不是 0，也不由
   * 费用反推）。
   */
  inputTotalTokens: number | null;
  /** 非缓存输入 token；Anthropic 折叠在 `input_tokens`，别家走 normalized 明细。 */
  inputUncachedTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** Gateway 实际回报的单步金额；`null` = 未知（不是 0）。 */
  costUsd: number | null;
  finishReason: string | null;
  /**
   * 单步耗时。**本 SDK 不提供逐步计时**（`onStepFinish` 只在 step 完成后
   * 触发，给不出起止点），所以恒为 `null`，不编造。generation 总耗时在
   * `GenerationRecord.durationMs`，那个是真测的。
   */
  durationMs: number | null;
  /** 响应模型 id（`step.response.modelId`，退回网关原始 body 的 `modelId`）。 */
  providerId: string | null;
  /**
   * 上游实际路由到的供应商 id（如 `deepseek` / `openai`），**只作定位用**，
   * 不含正文或密钥；上游没回报就是 `null`。
   */
  upstreamProviderId: string | null;
  /** 响应 id（`step.response.id`；gateway 若在 metadata 里给了 generationId 也认）。 */
  generationId: string | null;
  /** 传输层请求 id（`x-vercel-id` header），可用于跟 Vercel 侧对账。 */
  requestId: string | null;
};

/** 一次 generation 的完整证据。 */
export type GenerationRecord = {
  /** 台账内自增序号。 */
  seq: number;
  /** 标签（run/scenario/turn）——只放标识，不放住户正文。 */
  runId: string | null;
  scenarioId: string | null;
  turnIndex: number | null;
  stage: string;
  modelId: string;
  operationKind: LedgerOperationKind;
  /**
   * `completed` = 正常返回；`partial` = 中途抛错但已有完成的 step；
   * `error` = 抛错且一步都没完成。partial/error 都带 `unknownCost: true`。
   */
  status: "completed" | "partial" | "error";
  /** 已完成的 step（error 时是抛错前跑完的那些，不清零）。 */
  steps: StepUsageRecord[];
  completedSteps: number;
  /** 已知金额合计；partial/error 时是下界。 */
  knownCostUsd: number;
  unknownCostSteps: number;
  /** 有任何部分不可知（含中途失败本身）。 */
  unknownCost: boolean;
  durationMs: number;
  /** 异常类型名（只留 name，不带可能含正文的 message）。 */
  errorName?: string;
  /** transport 重试次数：本 SDK 不可观测 → 恒为 `null`。 */
  transportAttempts: number | null;
  /** 为什么是 null——写给报告读者看，不让人误以为"重试 0 次"。 */
  transportObservability: string;
};

/** transport 计数不可观测的固定说明。 */
export const TRANSPORT_OBSERVABILITY_NOTE =
  "不可观测：ai@6.0.0-beta.159 的 onStepFinish 只在重试全部结束后按 step 触发，" +
  "SDK 未暴露 transport retry 次数；这里记 null，不猜测也不拿 generation 数冒充。";

/** 台账的只读快照，直接进报告 JSON。 */
export type LedgerSnapshot = {
  /** 结构版本：新增字段用它区分；旧报告缺这个字段按 1 读。 */
  schemaVersion: number;
  /** 金额上限（美元）；没设置是 null。 */
  maxCostUsd: number | null;
  /** 旧的调用数上限字段名；语义是 **generation** 上限，保留兼容。 */
  maxModelCalls: number | null;
  /** 准确名称：generation（模型生成批次）上限；等于 `maxModelCalls`。 */
  maxGenerations: number | null;
  /** 已发起（且未被拒）的 generation 数（旧字段名）。**不是 HTTP 请求数。** */
  calls: number;
  /** 准确别名：等于 `calls`。 */
  generations: number;
  /** 已回报金额之和（美元）；有未知项时是下界。 */
  knownCostUsd: number;
  /** 有 generation 拿不到完整金额的个数（旧字段名）——不是 0 花费，是未知。 */
  unknownCostCalls: number;
  /** 准确别名：等于 `unknownCostCalls`。 */
  unknownCostGenerations: number;
  /** 是否因触限而停止。 */
  stopped: boolean;
  /** 停止原因；没停是 null。 */
  stopReason: string | null;
  /** 按 stage 聚合。 */
  byStage: LedgerBucket[];
  /** 按 model 聚合。 */
  byModel: LedgerBucket[];
  /** 可审计明细：每次 generation 一条。旧快照没有这个字段（空数组/undefined）。 */
  generationRecords: GenerationRecord[];
};

/** 单次响应的计费读数。`unknown` 表示至少一步没回报 cost，不能当 0。 */
export type GatewayCostReading = {
  costUsd: number;
  unknown: boolean;
};

/** 台账标签：run/scenario/turn 边界由调用方（coliving-eval）提供。 */
export type EvalLedgerLabels = {
  runId: string | null;
  scenarioId: string | null;
  turnIndex: number | null;
};

const EMPTY_LABELS: EvalLedgerLabels = {
  runId: null,
  scenarioId: null,
  turnIndex: null,
};

/**
 * 预算触限错误。**继承 Error**，带当前快照，方便上层把已花的钱连同
 * 已完成的文字稿一起写进报告，而不是整个跑批崩掉、什么都留不下。
 */
export class EvalBudgetExceededError extends Error {
  readonly stage: string;
  readonly modelId: string;
  readonly snapshot: LedgerSnapshot;

  constructor(args: {
    stage: string;
    modelId: string;
    reason: string;
    snapshot: LedgerSnapshot;
  }) {
    super(
      `评测预算已停止（${args.reason}）；拒绝发起 stage=${args.stage} ` +
        `model=${args.modelId} 的调用。已发起 ${args.snapshot.generations} 次 ` +
        `generation、已知花费 $${args.snapshot.knownCostUsd}、未知花费 ` +
        `generation ${args.snapshot.unknownCostGenerations} 个。`
    );
    this.name = "EvalBudgetExceededError";
    this.stage = args.stage;
    this.modelId = args.modelId;
    this.snapshot = args.snapshot;
  }
}

/** 类型收窄，给各 catch 块判断"这是我们自己的预算错误，必须向上抛"。 */
export function isEvalBudgetExceeded(
  error: unknown
): error is EvalBudgetExceededError {
  return error instanceof EvalBudgetExceededError;
}

function numOrNull(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 只接受普通对象；数组/字符串/数字/null 一律 null（不解析、不猜）。 */
function asObject(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function readGatewayCost(metadata: unknown): number | null {
  const meta = metadata as { gateway?: { cost?: unknown } } | undefined;
  const raw = meta?.gateway?.cost;
  if (raw === undefined || raw === null || raw === "") return null;
  return numOrNull(raw);
}

/**
 * 从一次 `generateText` 结果里读出**整轮**的真实花费。
 *
 * **必须逐步累加**：带工具时一轮有多次往返，只看最后一步会严重低估
 * （与 turn.ts 的 `sumUsage` 同一口径）。如果结果里连 `steps` 都没有，
 * 退回顶层 `providerMetadata`。
 *
 * 任何一步读不到 cost → `unknown: true`：已知的部分照常累加，但这一笔
 * 不能算作"花费已知"。这是 `trackedGatewayCall` 在没有 step 明细时的兜底，
 * 也是旧行为逐字保留的入口。
 */
export function gatewayCostFromResult(result: {
  steps?: ReadonlyArray<{ providerMetadata?: unknown }>;
  providerMetadata?: unknown;
}): GatewayCostReading {
  const steps = result.steps ?? [];
  let costUsd = 0;
  let anyKnown = false;
  let anyUnknown = false;
  const consume = (metadata: unknown) => {
    const cost = readGatewayCost(metadata);
    if (cost === null) anyUnknown = true;
    else {
      costUsd += cost;
      anyKnown = true;
    }
  };
  if (steps.length > 0) {
    for (const step of steps) consume(step.providerMetadata);
  } else {
    consume(result.providerMetadata);
  }
  return { costUsd, unknown: anyUnknown || !anyKnown };
}

/**
 * 传给 `generateText` 的 step 回调能看到的字段（结构子集）。
 * 用宽松类型是为了让各种 TOOLS 泛型的 `StepResult` 都能赋进来。
 */
export type RecordableStep = {
  finishReason?: unknown;
  usage?: unknown;
  providerMetadata?: unknown;
  response?: unknown;
};

/**
 * 调用方把 `recorder.stepOptions` 直接展开进 `generateText` 的 options：
 *
 * ```ts
 * trackedGatewayCall("main", modelId, (rec) =>
 *   generateText({ ..., ...rec.stepOptions })
 * )
 * ```
 *
 * **生产（无台账）时 `stepOptions` 是 `{}`**，展开后参数与不加这层逐字一致。
 */
export type GenerationRecorder = {
  stepOptions: {
    onStepFinish?: (step: RecordableStep) => void;
  };
};

const NOOP_RECORDER: GenerationRecorder = { stepOptions: {} };

/** 一个 generation 的内部草稿；step hook 往里追加，结束时定稿。 */
type GenerationDraft = {
  seq: number;
  labels: EvalLedgerLabels;
  stage: string;
  modelId: string;
  kind: LedgerOperationKind;
  startedAt: number;
  hookSteps: StepUsageRecord[];
};

const NULL_TOKENS = {
  inputTotalTokens: null,
  inputUncachedTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  outputTokens: null,
  reasoningTokens: null,
} as const;

/** 一个 usage 对象里能读出的六类 token；每类独立，读不到就是 `null`。 */
type RawUsageFields = {
  inputTotalTokens: number | null;
  inputUncachedTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
};

const USAGE_FIELD_KEYS: ReadonlyArray<keyof RawUsageFields> = [
  "inputTotalTokens",
  "inputUncachedTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningTokens",
];

/**
 * 从**任意一个** usage 对象里读六类 token，兼容四种真实形状：
 *
 * 1. AI SDK 归一化扁平形状（`step.usage` 正常时）：
 *    `inputTokens: number` + `inputTokenDetails.{noCache,cacheRead,cacheWrite}Tokens`
 *    + `outputTokens: number` + `outputTokenDetails.reasoningTokens` / `reasoningTokens`
 * 2. 供应商 spec v3 嵌套形状：
 *    `inputTokens.{total,noCache,cacheRead,cacheWrite}` / `outputTokens.{total,reasoning}`
 * 3. 供应商 spec v2 扁平形状：
 *    `inputTokens/outputTokens/cachedInputTokens/reasoningTokens`（都是 number）
 * 4. 供应商 snake_case（Anthropic 原始、OpenAI/DeepSeek 兼容层）：
 *    `prompt_tokens`/`completion_tokens`/`input_tokens`/`output_tokens`/
 *    `cache_read_input_tokens`/`cache_creation_input_tokens`/
 *    `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` 等。
 *
 * 规则：一个数字都读不到就返回 `null`（调用方继续试下一个来源）；
 * **绝不填 0，也绝不按 cost 反推 token**。确认是 Anthropic 语义的
 * `input_tokens`（同时有 cache 读/写字段）才当非缓存输入，否则当输入总量。
 */
function readUsageObject(raw: unknown): RawUsageFields | null {
  const u = asObject(raw);
  if (!u) return null;
  const inNested = asObject(u.inputTokens);
  const outNested = asObject(u.outputTokens);
  const inDetails = asObject(u.inputTokenDetails);
  const outDetails = asObject(u.outputTokenDetails);
  const promptDetails = asObject(u.prompt_tokens_details);
  const inputDetailsSnake = asObject(u.input_tokens_details);
  const completionDetails = asObject(u.completion_tokens_details);
  const outputDetailsSnake = asObject(u.output_tokens_details);

  const cacheReadTokens =
    numOrNull(inDetails?.cacheReadTokens) ??
    numOrNull(inNested?.cacheRead) ??
    numOrNull(u.cachedInputTokens) ??
    numOrNull(u.cache_read_input_tokens) ??
    numOrNull(u.prompt_cache_hit_tokens) ??
    numOrNull(promptDetails?.cached_tokens) ??
    numOrNull(inputDetailsSnake?.cached_tokens);

  const cacheWriteTokens =
    numOrNull(inDetails?.cacheWriteTokens) ??
    numOrNull(inNested?.cacheWrite) ??
    numOrNull(u.cache_creation_input_tokens);

  let inputTotalTokens =
    numOrNull(u.inputTokens) ??
    numOrNull(inNested?.total) ??
    numOrNull(u.prompt_tokens) ??
    null;

  let inputUncachedTokens =
    numOrNull(inDetails?.noCacheTokens) ??
    numOrNull(inNested?.noCache) ??
    numOrNull(u.prompt_cache_miss_tokens) ??
    null;

  const outputTokens =
    numOrNull(u.outputTokens) ??
    numOrNull(outNested?.total) ??
    numOrNull(u.completion_tokens) ??
    numOrNull(u.output_tokens);

  const reasoningTokens =
    numOrNull(outDetails?.reasoningTokens) ??
    numOrNull(outNested?.reasoning) ??
    numOrNull(u.reasoningTokens) ??
    numOrNull(u.reasoning_output_tokens) ??
    numOrNull(completionDetails?.reasoning_tokens) ??
    numOrNull(outputDetailsSnake?.reasoning_tokens);

  // snake_case `input_tokens`：Anthropic 语义是「非缓存输入」，别家可能当总量。
  const snakeInput = numOrNull(u.input_tokens);
  const anthropicStyleInput =
    numOrNull(u.cache_read_input_tokens) !== null ||
    numOrNull(u.cache_creation_input_tokens) !== null;
  if (snakeInput !== null) {
    if (anthropicStyleInput) {
      inputUncachedTokens = inputUncachedTokens ?? snakeInput;
    } else {
      inputTotalTokens = inputTotalTokens ?? snakeInput;
    }
  }

  // 总量兜底：total_tokens 减输出；再不行用「非缓存 + 缓存读 + 缓存写」。
  if (inputTotalTokens === null) {
    const total = numOrNull(u.total_tokens);
    if (total !== null && outputTokens !== null) {
      inputTotalTokens = Math.max(total - outputTokens, 0);
    }
  }
  if (inputTotalTokens === null) {
    const parts = [inputUncachedTokens, cacheReadTokens, cacheWriteTokens];
    if (parts.some((p) => p !== null)) {
      inputTotalTokens = parts.reduce<number>((sum, p) => sum + (p ?? 0), 0);
    }
  }
  // 非缓存输入兜底（维持旧口径）：
  // - 有缓存读 → 总量 − 缓存读；
  // - 没有缓存信息（spec v2 的 inputTokens/prompt_tokens 未分缓存）→ 整段
  //   输入都算非缓存。这是既有 `readStepTokens` 的行为，不能因为新增来源
  //   而把这类 step 退化成 null。
  if (inputUncachedTokens === null && inputTotalTokens !== null) {
    inputUncachedTokens =
      cacheReadTokens !== null
        ? Math.max(inputTotalTokens - cacheReadTokens, 0)
        : inputTotalTokens;
  }

  const fields: RawUsageFields = {
    inputTotalTokens,
    inputUncachedTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
  };
  if (USAGE_FIELD_KEYS.every((k) => fields[k] === null)) return null;
  return fields;
}

/** 按来源优先级逐字段取第一个非 null 值，缺字段继续往下一个来源找。 */
function mergeUsageCandidates(
  candidates: readonly unknown[]
): RawUsageFields {
  const result: RawUsageFields = {
    inputTotalTokens: null,
    inputUncachedTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
  };
  for (const candidate of candidates) {
    const fields = readUsageObject(candidate);
    if (!fields) continue;
    for (const key of USAGE_FIELD_KEYS) {
      if (result[key] === null && fields[key] !== null) result[key] = fields[key];
    }
  }
  return result;
}

/** 从 providerMetadata 里收集各供应商的 `usage` 对象（gateway 优先）。 */
function providerUsageObjects(metadata: unknown): unknown[] {
  const meta = asObject(metadata);
  if (!meta) return [];
  const out: unknown[] = [];
  const gatewayUsage = asObject(meta.gateway)?.usage;
  if (gatewayUsage !== undefined) out.push(gatewayUsage);
  for (const [key, value] of Object.entries(meta)) {
    if (key === "gateway") continue;
    const usage = asObject(value)?.usage;
    if (usage !== undefined) out.push(usage);
  }
  return out;
}

/**
 * 网关原始响应体里的 usage：`step.response.body.usage` 与
 * `body.providerMetadata.<provider>.usage`。只读数字字段，**绝不保留正文**。
 */
function responseBodyUsageObjects(response: unknown): unknown[] {
  const body = asObject(asObject(response)?.body);
  if (!body) return [];
  const out: unknown[] = [];
  if (body.usage !== undefined) out.push(body.usage);
  out.push(...providerUsageObjects(body.providerMetadata));
  return out;
}

/**
 * 逐步读取 token 明细。来源按优先级：
 *   1. `providerMetadata.anthropic.usage`（Anthropic 原始字段，最全，行为不变）
 *   2. `step.usage`（AI SDK 归一化；形状对得上时最省事）
 *   3. `step.usage.raw`（SDK 归一化时保留的原始 usage，若上游给了）
 *   4. `providerMetadata.<provider>.usage`（gateway / DeepSeek / OpenAI …）
 *   5. `step.response.body.usage`（网关原始响应体：**DeepSeek 经网关时
 *      step.usage 被压塌为空，真正数值在这里**）
 * 每个字段独立取第一个非 null 值；一个数字都读不到就是 `null`，**不填 0、
 * 不按 cost 反推**。
 */
function readStepTokens(
  step: RecordableStep
): Pick<
  StepUsageRecord,
  | "inputTotalTokens"
  | "inputUncachedTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "outputTokens"
  | "reasoningTokens"
> {
  const meta = asObject(step.providerMetadata);
  const anthropicUsage = asObject(asObject(meta?.anthropic)?.usage);
  if (anthropicUsage) {
    const inputUncachedTokens = numOrNull(anthropicUsage.input_tokens);
    const cacheReadTokens = numOrNull(anthropicUsage.cache_read_input_tokens);
    const cacheWriteTokens = numOrNull(
      anthropicUsage.cache_creation_input_tokens
    );
    const parts = [inputUncachedTokens, cacheReadTokens, cacheWriteTokens];
    return {
      // Anthropic 的 input_tokens 是非缓存输入，总量要自己加回来。
      inputTotalTokens: parts.some((p) => p !== null)
        ? parts.reduce<number>((sum, p) => sum + (p ?? 0), 0)
        : null,
      inputUncachedTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens: numOrNull(anthropicUsage.output_tokens),
      reasoningTokens: numOrNull(anthropicUsage.reasoning_output_tokens),
    };
  }
  return mergeUsageCandidates([
    step.usage,
    asObject(step.usage)?.raw,
    ...providerUsageObjects(step.providerMetadata),
    ...responseBodyUsageObjects(step.response),
  ]);
}

function readStepIdentity(step: RecordableStep): {
  providerId: string | null;
  upstreamProviderId: string | null;
  generationId: string | null;
  requestId: string | null;
} {
  const resp = asObject(step.response);
  const headers = (asObject(resp?.headers) ?? {}) as Record<string, unknown>;
  const body = asObject(resp?.body);
  const meta = asObject(step.providerMetadata);
  const gateway = asObject(meta?.gateway);
  const bodyGateway = asObject(asObject(body?.providerMetadata)?.gateway);
  const responseId = typeof resp?.id === "string" ? resp.id : null;
  const metaId =
    typeof gateway?.generationId === "string" ? gateway.generationId : null;
  const bodyMetaId =
    typeof bodyGateway?.generationId === "string"
      ? bodyGateway.generationId
      : null;
  const providerFromGateway =
    typeof gateway?.provider === "string" ? gateway.provider : null;
  const providerFromBody =
    typeof body?.provider === "string" ? body.provider : null;
  const providerFromBodyGateway =
    typeof bodyGateway?.provider === "string" ? bodyGateway.provider : null;
  return {
    providerId:
      (typeof resp?.modelId === "string" ? resp.modelId : null) ??
      (typeof body?.modelId === "string" ? body.modelId : null),
    upstreamProviderId:
      providerFromGateway ?? providerFromBody ?? providerFromBodyGateway ?? null,
    generationId: responseId ?? metaId ?? bodyMetaId,
    requestId:
      typeof headers["x-vercel-id"] === "string" ? headers["x-vercel-id"] : null,
  };
}

function stepRecordFromStep(
  step: RecordableStep,
  index: number
): StepUsageRecord {
  return {
    index,
    ...readStepTokens(step),
    costUsd: readGatewayCost(step.providerMetadata),
    finishReason:
      typeof step.finishReason === "string" ? step.finishReason : null,
    durationMs: null,
    ...readStepIdentity(step),
  };
}

/** embedding 没有 step hook：整个调用就是一步，tokens 只有总量。 */
function embeddingStepRecord(result: unknown): StepUsageRecord {
  const r = asObject(result);
  const response = asObject(r?.response);
  const headers = (asObject(response?.headers) ?? {}) as Record<string, unknown>;
  const body = asObject(response?.body);
  const gateway = asObject(asObject(r?.providerMetadata)?.gateway);
  const bodyGateway = asObject(asObject(body?.providerMetadata)?.gateway);
  const usageFields = mergeUsageCandidates([
    asObject(r?.usage),
    ...providerUsageObjects(r?.providerMetadata),
    ...responseBodyUsageObjects(r?.response),
  ]);
  const tokens = numOrNull(asObject(r?.usage)?.tokens);
  const providerFromGateway =
    typeof gateway?.provider === "string" ? gateway.provider : null;
  const providerFromBody =
    typeof body?.provider === "string" ? body.provider : null;
  const providerFromBodyGateway =
    typeof bodyGateway?.provider === "string" ? bodyGateway.provider : null;
  return {
    index: 0,
    ...NULL_TOKENS,
    // embedding 的 `usage.tokens` 就是输入总量（无缓存概念时两栏同源）。
    inputTotalTokens: tokens ?? usageFields.inputTotalTokens,
    inputUncachedTokens: tokens ?? usageFields.inputUncachedTokens,
    cacheReadTokens: usageFields.cacheReadTokens,
    cacheWriteTokens: usageFields.cacheWriteTokens,
    outputTokens: usageFields.outputTokens,
    reasoningTokens: usageFields.reasoningTokens,
    costUsd: readGatewayCost(r?.providerMetadata),
    finishReason: null,
    durationMs: null,
    providerId: null,
    upstreamProviderId:
      providerFromGateway ?? providerFromBody ?? providerFromBodyGateway ?? null,
    generationId:
      (typeof gateway?.generationId === "string"
        ? gateway.generationId
        : null) ??
      (typeof bodyGateway?.generationId === "string"
        ? bodyGateway.generationId
        : null),
    requestId:
      typeof headers["x-vercel-id"] === "string"
        ? headers["x-vercel-id"]
        : null,
  };
}

/**
 * text generation 成功返回、却既没有 `result.steps` 又没有 hook 步骤时的兜底：
 * 把顶层 result 当唯一步读一次，**至少保留 Gateway cost 证据**（与旧入口
 * `gatewayCostFromResult` 的顶层口径一致）。读不到的字段仍是 `null`，不编 0。
 */
function topLevelStepRecord(result: unknown, index: number): StepUsageRecord {
  const r = result as
    | {
        finishReason?: unknown;
        usage?: unknown;
        providerMetadata?: unknown;
        response?: unknown;
      }
    | undefined;
  return stepRecordFromStep(
    {
      finishReason: r?.finishReason,
      usage: r?.usage,
      providerMetadata: r?.providerMetadata,
      response: r?.response,
    },
    index
  );
}

function bump(
  buckets: Map<string, LedgerBucket>,
  key: string,
  reading: GatewayCostReading | null
): void {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      key,
      calls: 0,
      generations: 0,
      knownCostUsd: 0,
      unknownCostCalls: 0,
    };
    buckets.set(key, bucket);
  }
  if (reading === null) {
    bucket.calls += 1;
    bucket.generations += 1;
    return;
  }
  bucket.knownCostUsd += reading.costUsd;
  if (reading.unknown) bucket.unknownCostCalls += 1;
}

/**
 * **整批唯一的共享预算协调器。** 上限（`--max-cost-usd` /
 * `--max-generations`，旧名 `--max-model-calls`）挂在这里，所有场景的本地
 * 台账都指向同一份——这样 5 个场景共享一个总上限，而不是各拿一份 CLI 上限。
 *
 * `beforeCall` 是同步的：检查与 `calls += 1` 之间没有 await，所以并发场景
 * 同时抢额度时，全局 generation 数不会超过硬上限。金额按已知累计判断
 * （软上限，单次在途请求可能小幅越线）。两者都只管 generation：管不住一个
 * generation 内部的 step 与 transport retry。
 */
export class BatchBudget {
  private calls = 0;
  private knownCostUsd = 0;
  private unknownCostCalls = 0;
  private stopped = false;
  private stopReason: string | null = null;

  constructor(
    readonly options: {
      maxCostUsd?: number | null;
      /**
       * generation 硬上限（旧字段名 `maxModelCalls`，语义一直是这个）。
       * **不是 HTTP 请求数**，也不含 step/transport retry。
       */
      maxModelCalls?: number | null;
    } = {}
  ) {}

  /** 全局登记一次调用；触限则抛错，**不发起**这次调用。 */
  beforeCall(stage: string, modelId: string): void {
    if (this.stopped) {
      throw this.budgetError(stage, modelId, this.stopReason ?? "预算已停止");
    }
    const maxCalls = this.options.maxModelCalls ?? null;
    if (maxCalls !== null && this.calls >= maxCalls) {
      const reason =
        `已达 generation 硬上限 ${maxCalls} 次（模型生成批次，` +
        `不是 HTTP 请求数、也不含一个 generation 内部的 step 与重试），` +
        `拒绝第 ${this.calls + 1} 次调用`;
      this.markStopped(reason);
      throw this.budgetError(stage, modelId, reason);
    }
    const maxCost = this.options.maxCostUsd ?? null;
    if (maxCost !== null && this.knownCostUsd >= maxCost) {
      const reason =
        `已知累计花费 $${this.knownCostUsd} 已达金额上限 $${maxCost}，拒绝下一次调用`;
      this.markStopped(reason);
      throw this.budgetError(stage, modelId, reason);
    }
    this.calls += 1;
  }

  /**
   * 全局累计一笔已知花费；`reading` 为 null 表示这次调用抛错且没有任何
   * 已完成的 step（花费完全未知）。
   */
  afterCall(reading: GatewayCostReading | null): void {
    const normalized = reading ?? { costUsd: 0, unknown: true };
    this.knownCostUsd += normalized.costUsd;
    if (normalized.unknown) this.unknownCostCalls += 1;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private markStopped(reason: string): void {
    this.stopped = true;
    this.stopReason = reason;
  }

  private budgetError(
    stage: string,
    modelId: string,
    reason: string
  ): EvalBudgetExceededError {
    return new EvalBudgetExceededError({
      stage,
      modelId,
      reason,
      snapshot: this.snapshot(),
    });
  }

  /**
   * 全局快照：只有总计与停止原因，stage/model 分解与逐 generation 明细在
   * 本地台账里（所以这里 `generationRecords` 是空数组）。
   */
  snapshot(): LedgerSnapshot {
    const maxModelCalls = this.options.maxModelCalls ?? null;
    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      maxCostUsd: this.options.maxCostUsd ?? null,
      maxModelCalls,
      maxGenerations: maxModelCalls,
      calls: this.calls,
      generations: this.calls,
      knownCostUsd: this.knownCostUsd,
      unknownCostCalls: this.unknownCostCalls,
      unknownCostGenerations: this.unknownCostCalls,
      stopped: this.stopped,
      stopReason: this.stopReason,
      byStage: [],
      byModel: [],
      generationRecords: [],
    };
  }
}

/**
 * 一份**本地**台账。每个并发场景各持一份（由 `runWithEvalLedger` 挂到该场景
 * 自己的异步上下文里），负责记这个场景自己的 generation 数、stage/model
 * 分解与逐 generation 明细。
 *
 * 限流交给共享预算：有 `sharedBudget`（整批唯一）时只记收据、不各自设限；
 * 没有时**自建一份私有 `BatchBudget`**，行为与旧版逐字一致（单份台账自己
 * 就是一个"批"）。
 */
export class GatewayCostLedger {
  private calls = 0;
  private knownCostUsd = 0;
  private unknownCostCalls = 0;
  private seq = 0;
  private readonly stages = new Map<string, LedgerBucket>();
  private readonly models = new Map<string, LedgerBucket>();
  private readonly generations: GenerationRecord[] = [];
  private readonly budget: BatchBudget;

  constructor(
    readonly options: {
      maxCostUsd?: number | null;
      maxModelCalls?: number | null;
    } = {},
    sharedBudget?: BatchBudget
  ) {
    this.budget = sharedBudget ?? new BatchBudget(options);
  }

  /** 发起一次调用前登记；触限（本地或共享）则抛错，**不发起**这次调用。 */
  beforeCall(stage: string, modelId: string): void {
    // 先过（本地或共享的）预算闸；被拒就不记本地收据。
    this.budget.beforeCall(stage, modelId);
    this.calls += 1;
    bump(this.stages, stage, null);
    bump(this.models, modelId, null);
  }

  /** 一次调用结束后记账；`reading` 为 null 表示这次调用抛错了。 */
  afterCall(
    stage: string,
    modelId: string,
    reading: GatewayCostReading | null
  ): void {
    const normalized = reading ?? { costUsd: 0, unknown: true };
    this.knownCostUsd += normalized.costUsd;
    if (normalized.unknown) this.unknownCostCalls += 1;
    bump(this.stages, stage, normalized);
    bump(this.models, modelId, normalized);
    this.budget.afterCall(normalized);
  }

  /** 开一个 generation 草稿；step hook 落到它上面。 */
  openGeneration(
    stage: string,
    modelId: string,
    kind: LedgerOperationKind,
    labels: EvalLedgerLabels
  ): GenerationDraft {
    this.seq += 1;
    return {
      seq: this.seq,
      labels,
      stage,
      modelId,
      kind,
      startedAt: Date.now(),
      hookSteps: [],
    };
  }

  /**
   * step hook 回调：**完成一步就留证据**。这一步的 tokens/cost 记下来，
   * 之后即使后面的 step、工具或请求抛错，前面完成的 step 也不会丢。
   */
  captureStep(draft: GenerationDraft, step: RecordableStep): void {
    draft.hookSteps.push(stepRecordFromStep(step, draft.hookSteps.length));
  }

  /**
   * 定稿一个 generation。
   *
   * - 成功返回：从 `result.steps` 生成明细（与 hook 看到的是同一批 step，
   *   只取一边，**不重复累计**）；没有 steps 且是 embedding 时按 embedding 读；
   *   text generation 没有 steps 时退回 hook 已捕获的 step，hook 也没有才用
   *   顶层 result 兜底（至少保住 Gateway cost 证据）。
   * - 抛错：用 hook 已捕获的步骤，标 `partial`（有步骤）或 `error`（无），
   *   已完成步骤的费用保留，尾部不可知部分标 `unknownCost`。
   */
  finishGeneration(
    draft: GenerationDraft,
    args: { status: "completed"; result: unknown; error?: undefined } | {
      status: "partial" | "error";
      result: null;
      error: unknown;
    }
  ): GenerationRecord {
    const durationMs = Math.max(Date.now() - draft.startedAt, 0);
    let steps: StepUsageRecord[];
    if (args.result !== null && args.result !== undefined) {
      const r = args.result as { steps?: unknown };
      if (Array.isArray(r.steps) && r.steps.length > 0) {
        // 正常路径：`result.steps` 是权威来源；hook 看到的是同一批 step，
        // 只取一边，**不重复累计**。
        steps = r.steps.map((s, i) =>
          stepRecordFromStep(s as RecordableStep, i)
        );
      } else if (draft.kind === "embedding") {
        steps = [embeddingStepRecord(args.result)];
      } else if (draft.hookSteps.length > 0) {
        // 成功返回但 `result.steps` 缺失/为空：不能丢掉 hook 已捕获的 step。
        steps = draft.hookSteps;
      } else {
        // hook 也没有：兼容旧入口，从顶层 providerMetadata 至少保留 cost 证据。
        steps = [topLevelStepRecord(args.result, 0)];
      }
    } else {
      steps = draft.hookSteps;
    }
    const knownCostUsd = steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    const unknownCostSteps = steps.filter((s) => s.costUsd === null).length;
    // 失败（partial/error）时尾部费用不可知，一律标 unknown。
    const unknownCost =
      args.status !== "completed" || unknownCostSteps > 0 || steps.length === 0;
    const record: GenerationRecord = {
      seq: draft.seq,
      runId: draft.labels.runId,
      scenarioId: draft.labels.scenarioId,
      turnIndex: draft.labels.turnIndex,
      stage: draft.stage,
      modelId: draft.modelId,
      operationKind: draft.kind,
      status: args.status,
      steps,
      completedSteps: steps.length,
      knownCostUsd,
      unknownCostSteps,
      unknownCost,
      durationMs,
      transportAttempts: null,
      transportObservability: TRANSPORT_OBSERVABILITY_NOTE,
    };
    if (args.status !== "completed") {
      record.errorName =
        args.error instanceof Error ? args.error.name : typeof args.error;
    }
    this.generations.push(record);
    return record;
  }

  get isStopped(): boolean {
    return this.budget.isStopped;
  }

  snapshot(): LedgerSnapshot {
    const budget = this.budget.snapshot();
    const maxModelCalls = this.options.maxModelCalls ?? null;
    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      maxCostUsd: this.options.maxCostUsd ?? null,
      maxModelCalls,
      maxGenerations: maxModelCalls,
      calls: this.calls,
      generations: this.calls,
      knownCostUsd: this.knownCostUsd,
      unknownCostCalls: this.unknownCostCalls,
      unknownCostGenerations: this.unknownCostCalls,
      // 本地自己不设限时，停止状态来自共享预算（报告要能显示整批停止原因）。
      stopped: budget.stopped,
      stopReason: budget.stopReason,
      byStage: [...this.stages.values()].map((b) => ({ ...b })),
      byModel: [...this.models.values()].map((b) => ({ ...b })),
      generationRecords: this.generations.map((g) => ({
        ...g,
        steps: g.steps.map((s) => ({ ...s })),
      })),
    };
  }
}

const storage = new AsyncLocalStorage<GatewayCostLedger>();
const labelStorage = new AsyncLocalStorage<EvalLedgerLabels>();

/** 在这个台账的异步上下文里跑一段逻辑（通常是整个场景）。 */
export function runWithEvalLedger<T>(
  ledger: GatewayCostLedger,
  fn: () => Promise<T>
): Promise<T> {
  return storage.run(ledger, fn);
}

/** 当前异步上下文里的台账；生产路径没有，返回 undefined。 */
export function currentEvalLedger(): GatewayCostLedger | undefined {
  return storage.getStore();
}

/**
 * 在 run/scenario/turn 标签上下文里跑一段逻辑。标签只放**标识**
 * （runId / scenarioId / turnIndex），**绝不复制住户正文**。
 *
 * 与台账的 AsyncLocalStorage 同理：嵌套异步调用继承，并发场景互不串场。
 * 未提供的字段沿用外层（turn 边界只设 turnIndex，scenario 标签照旧继承）。
 */
export function runWithLedgerLabels<T>(
  labels: Partial<EvalLedgerLabels>,
  fn: () => Promise<T>
): Promise<T> {
  const prev = labelStorage.getStore() ?? EMPTY_LABELS;
  return labelStorage.run({ ...prev, ...labels }, fn);
}

/** 当前标签；没有就全 null。 */
export function currentLedgerLabels(): EvalLedgerLabels {
  return labelStorage.getStore() ?? EMPTY_LABELS;
}

/**
 * 主生成输出上限的**评测专用开关**。
 *
 * ⚠️ **只用于一次性的定向成本实验，不是已采纳的生产优化，也绝不是生产默认。**
 * 实验假设：单回合主生成的 output / reasoning 占了大头，给主生成显式加
 * `maxOutputTokens` 或许能显著降本；先用一个可关、可在报告里看到的开关量一次，
 * 再决定值不值得做成生产默认（production 不读这个变量）。
 *
 * 两道闸**缺一不可**，任何一道不满足就当没开：
 *
 * 1. **异步上下文里必须有评测台账**（`runWithEvalLedger`）。生产路径没有台账，
 *    `evalMaxOutputTokensOption()` 直接返回空对象，**连环境变量都不读**——
 *    所以哪怕 shell 里设了这个变量，生产/本地正常对话的参数也逐字不变。
 * 2. **`COLIVING_EVAL_MAX_OUTPUT_TOKENS` 必须是合法正整数**。未设、空串、
 *    `0`、负数、小数、非数、超过安全上限，一律当作没开。
 *
 * 注意这是**参数级开关**，不是计价开关：它只在评测 runner 显式设了变量时生效，
 * SDK 内部的 step / transport retry 不在它管辖范围（同 budget 的既有边界）。
 */
export const EVAL_MAX_OUTPUT_TOKENS_ENV = "COLIVING_EVAL_MAX_OUTPUT_TOKENS";

/**
 * 安全上限（**笔误闸，不是模型能力断言**）：正常实验只会在几千这个量级；
 * 超过它几乎只可能是打错（比如多敲了几个 0），拒绝比默默按超大值跑更安全。
 */
export const EVAL_MAX_OUTPUT_TOKENS_CEILING = 131072;

export type EvalMaxOutputTokensParse =
  | { status: "unset" }
  | { status: "invalid"; raw: string; reason: string }
  | { status: "valid"; value: number };

/**
 * 解析环境变量原文。**纯函数**，不读 `process.env`、不看台账，方便离线测试。
 * `unset` 与 `invalid` 分开：CLI 可以把"设了但非法"明确报错，而"没设"是正常的基线。
 */
export function parseEvalMaxOutputTokens(
  raw: string | undefined | null
): EvalMaxOutputTokensParse {
  if (raw === undefined || raw === null) return { status: "unset" };
  const text = raw.trim();
  if (text === "") return { status: "invalid", raw, reason: "是空值" };
  const value = Number(text);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return { status: "invalid", raw, reason: "不是正整数" };
  }
  if (value > EVAL_MAX_OUTPUT_TOKENS_CEILING) {
    return {
      status: "invalid",
      raw,
      reason: `超过安全上限 ${EVAL_MAX_OUTPUT_TOKENS_CEILING}`,
    };
  }
  return { status: "valid", value };
}

/**
 * 给主生成 `generateText` 展开的参数片段：只有「台账在 **且** 变量合法」才返回
 * `{ maxOutputTokens }`，否则返回 `{}`——展开空对象等于没写，生产参数逐字不变。
 * **不抛错**：非法值在评测 runner 启动时会被拦下，这里只当没开，绝不让生产路径因
 * 一个环境变量而失败。
 */
export function evalMaxOutputTokensOption(): { maxOutputTokens?: number } {
  if (!currentEvalLedger()) return {}; // 生产：无台账，不读环境变量、不传参数
  const parsed = parseEvalMaxOutputTokens(
    process.env[EVAL_MAX_OUTPUT_TOKENS_ENV]
  );
  return parsed.status === "valid" ? { maxOutputTokens: parsed.value } : {};
}

/**
 * 包住一次 Gateway `generateText` / `embed` 调用。
 *
 * - 上下文里没有台账（生产）→ **原样透传**：`run({ stepOptions: {} })`，
 *   调用方展开空对象，参数逐字不变；不登记、不建持久账。
 * - 有台账 → 发起前登记/查限（触限抛 `EvalBudgetExceededError`），
 *   给 `run` 一个 recorder（文本生成把 `rec.stepOptions` 展开进
 *   `generateText` 就能逐步留证），返回后按 step 明细记账；抛错时保留
 *   已完成步骤、标 partial/error。
 *
 * `stage`/`modelId` 是报告用的标签，模型字符串由调用方显式传入
 * （`getLanguageModel` 之后拿不回 id，见 lib/ai/providers.ts）。
 */
export async function trackedGatewayCall<T>(
  stage: string,
  modelId: string,
  run: (recorder: GenerationRecorder) => Promise<T>,
  options: { kind?: LedgerOperationKind } = {}
): Promise<T> {
  const ledger = storage.getStore();
  if (!ledger) return run(NOOP_RECORDER);
  const kind = options.kind ?? "text-generation";
  ledger.beforeCall(stage, modelId);
  const draft = ledger.openGeneration(
    stage,
    modelId,
    kind,
    currentLedgerLabels()
  );
  let result: T;
  try {
    result = await run({
      stepOptions: {
        onStepFinish: (step) => ledger.captureStep(draft, step),
      },
    });
  } catch (error) {
    const record = ledger.finishGeneration(draft, {
      status: draft.hookSteps.length > 0 ? "partial" : "error",
      result: null,
      error,
    });
    // 抛错：尾部不可知，标 unknown；但已完成步骤的已知费用照进账，不清零。
    ledger.afterCall(stage, modelId, {
      costUsd: record.knownCostUsd,
      unknown: true,
    });
    throw error;
  }
  const record = ledger.finishGeneration(draft, {
    status: "completed",
    result,
  });
  ledger.afterCall(stage, modelId, {
    costUsd: record.knownCostUsd,
    unknown: record.unknownCost,
  });
  return result;
}

/** 兼容旧快照（v1 没有 `generationRecords`），读成数组。 */
function generationsOf(snap: LedgerSnapshot): GenerationRecord[] {
  return Array.isArray(snap.generationRecords) ? snap.generationRecords : [];
}

/** 把多份快照合并成一份总计，给终端汇总用。 */
export function mergeLedgerSnapshots(
  snapshots: readonly LedgerSnapshot[]
): LedgerSnapshot {
  const stages = new Map<string, LedgerBucket>();
  const models = new Map<string, LedgerBucket>();
  const generationRecords: GenerationRecord[] = [];
  let calls = 0;
  let knownCostUsd = 0;
  let unknownCostCalls = 0;
  let stopped = false;
  let stopReason: string | null = null;
  for (const snap of snapshots) {
    calls += snap.calls;
    knownCostUsd += snap.knownCostUsd;
    unknownCostCalls += snap.unknownCostCalls;
    generationRecords.push(...generationsOf(snap));
    if (snap.stopped) {
      stopped = true;
      stopReason = stopReason ? `${stopReason}；${snap.stopReason ?? ""}` : snap.stopReason;
    }
    for (const bucket of snap.byStage) {
      let target = stages.get(bucket.key);
      if (!target) {
        target = {
          key: bucket.key,
          calls: 0,
          generations: 0,
          knownCostUsd: 0,
          unknownCostCalls: 0,
        };
        stages.set(bucket.key, target);
      }
      target.calls += bucket.calls;
      target.generations += bucket.generations ?? bucket.calls;
      target.knownCostUsd += bucket.knownCostUsd;
      target.unknownCostCalls += bucket.unknownCostCalls;
    }
    for (const bucket of snap.byModel) {
      let target = models.get(bucket.key);
      if (!target) {
        target = {
          key: bucket.key,
          calls: 0,
          generations: 0,
          knownCostUsd: 0,
          unknownCostCalls: 0,
        };
        models.set(bucket.key, target);
      }
      target.calls += bucket.calls;
      target.generations += bucket.generations ?? bucket.calls;
      target.knownCostUsd += bucket.knownCostUsd;
      target.unknownCostCalls += bucket.unknownCostCalls;
    }
  }
  const first = snapshots[0];
  const maxModelCalls = first?.maxModelCalls ?? null;
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    maxCostUsd: first?.maxCostUsd ?? null,
    maxModelCalls,
    maxGenerations: first?.maxGenerations ?? maxModelCalls,
    calls,
    generations: calls,
    knownCostUsd,
    unknownCostCalls,
    unknownCostGenerations: unknownCostCalls,
    stopped,
    stopReason,
    byStage: [...stages.values()],
    byModel: [...models.values()],
    generationRecords,
  };
}
