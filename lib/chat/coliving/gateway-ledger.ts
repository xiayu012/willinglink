import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * **评测专用的 Gateway 真实计费台账（只读账本 + 预算闸）。**
 *
 * 为什么要有这个：`coliving-eval` 一次跑批会发起几百次 Gateway 调用，之前
 * 只能事后看账单，跑之前**没法说"最多花多少、最多调几次"**。这里把每一次
 * `generateText` 调用登记下来，累计 gateway 真实回报的 `providerMetadata.
 * gateway.cost`，在达到上限时**在发起下一次之前**抛错停下。
 *
 * ## 三条安全性质
 *
 * 1. **生产不受影响**：`trackedGatewayCall` 只在 `AsyncLocalStorage` 里有
 *    台账时记账；生产路径没有台账（`currentEvalLedger()` 为 undefined），
 *    直接透传 `generateText`，行为与不加这层逐字一致。
 * 2. **并发隔离**：本地台账挂在 `AsyncLocalStorage` 上，`runWithEvalLedger`
 *    给每个场景开一份独立上下文。并发跑的多个场景**各记各的收据**
 *    （`GatewayCostLedger`），不互相污染 stage/model 分解。
 * 3. **缺钱不当作 0**：`gateway` 没回报 `cost` 时标记 `unknown`，绝不把
 *    缺失当 0 累加后声称"花费已知"。金额上限用已知累计判断（诚实口径：
 *    能算的算准，算不到的明说算不到），是软硬混合——达到线后拦住下一次，
 *    单次请求可能略微越过；不宣称是绝对硬上限。
 *
 * ## 两种上限口径：整批共享预算 vs 单份台账
 *
 * `--max-cost-usd` / `--max-model-calls` 的语义是**整次跑批**的总上限，
 * **不是每个场景各一份**——否则 5 个场景会把 4 美元放大到 20 美元。
 * 因此上限只放在一个 `BatchBudget`（整批唯一）里，所有场景的
 * `GatewayCostLedger` 都指向它：本地只管记录收据，全局计数与限流由
 * `BatchBudget` 独有。`GatewayCostLedger` 单独用时（没有共享预算）会为
 * 自己建一份私有 `BatchBudget`，行为与旧版逐字一致。
 *
 * ## 调用数上限是硬的
 *
 * `maxModelCalls` 是严格硬上限：第 N 次之后、第 N+1 次**发起前**即抛
 * `EvalBudgetExceededError`，不会真的发出去。`BatchBudget.beforeCall` 是
 * **同步**的（检查与自增之间没有 await），所以并发场景下全局调用数依然
 * 是硬上限，不会因为并发窗口多放一次。
 *
 * 注释里记的这些边界都是**评测口径**，不要拿它当生产配额系统用。
 */

/** 一个调用维度（stage 或 model）下累计到的账。 */
export type LedgerBucket = {
  key: string;
  calls: number;
  knownCostUsd: number;
  unknownCostCalls: number;
};

/** 台账的只读快照，直接进报告 JSON。 */
export type LedgerSnapshot = {
  /** 金额上限（美元）；没设置是 null。 */
  maxCostUsd: number | null;
  /** 调用数上限；没设置是 null。 */
  maxModelCalls: number | null;
  /** 已发起（且未被拒）的调用次数。 */
  calls: number;
  /** 已回报金额之和（美元）。 */
  knownCostUsd: number;
  /** 有调用但拿不到金额的次数——**不是 0 花费，是未知**。 */
  unknownCostCalls: number;
  /** 是否因触限而停止。 */
  stopped: boolean;
  /** 停止原因；没停是 null。 */
  stopReason: string | null;
  /** 按 stage 聚合。 */
  byStage: LedgerBucket[];
  /** 按 model 聚合。 */
  byModel: LedgerBucket[];
};

/** 单次响应的计费读数。`unknown` 表示至少一步没回报 cost，不能当 0。 */
export type GatewayCostReading = {
  costUsd: number;
  unknown: boolean;
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
        `model=${args.modelId} 的调用。已发起 ${args.snapshot.calls} 次、` +
        `已知花费 $${args.snapshot.knownCostUsd}、未知花费调用 ` +
        `${args.snapshot.unknownCostCalls} 次。`
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

function readGatewayCost(metadata: unknown): number | null {
  const meta = metadata as { gateway?: { cost?: unknown } } | undefined;
  const raw = meta?.gateway?.cost;
  if (raw === undefined || raw === null || raw === "") return null;
  const cost = Number(raw);
  return Number.isFinite(cost) ? cost : null;
}

/**
 * 从一次 `generateText` 结果里读出**整轮**的真实花费。
 *
 * **必须逐步累加**：带工具时一轮有多次往返，只看最后一步会严重低估
 * （与 turn.ts 的 `sumUsage` 同一口径）。如果结果里连 `steps` 都没有，
 * 退回顶层 `providerMetadata`。
 *
 * 任何一步读不到 cost → `unknown: true`：已知的部分照常累加，但这一笔
 * 不能算作"花费已知"。
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

function bump(
  buckets: Map<string, LedgerBucket>,
  key: string,
  reading: GatewayCostReading | null
): void {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { key, calls: 0, knownCostUsd: 0, unknownCostCalls: 0 };
    buckets.set(key, bucket);
  }
  if (reading === null) {
    bucket.calls += 1;
    return;
  }
  bucket.knownCostUsd += reading.costUsd;
  if (reading.unknown) bucket.unknownCostCalls += 1;
}

/**
 * **整批唯一的共享预算协调器。** 上限（`--max-cost-usd` /
 * `--max-model-calls`）挂在这里，所有场景的本地台账都指向同一份——
 * 这样 5 个场景共享一个总上限，而不是各拿一份 CLI 上限。
 *
 * `beforeCall` 是同步的：检查与 `calls += 1` 之间没有 await，所以并发场景
 * 同时抢额度时，全局调用数不会超过硬上限。金额按已知累计判断（软上限，
 * 单次在途请求可能小幅越线）。
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
        `已达模型调用硬上限 ${maxCalls} 次，拒绝第 ${this.calls + 1} 次调用`;
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

  /** 全局累计一笔已知花费；`reading` 为 null 表示这次调用抛错了。 */
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

  /** 全局快照：只有总计与停止原因，stage/model 分解在本地台账里。 */
  snapshot(): LedgerSnapshot {
    return {
      maxCostUsd: this.options.maxCostUsd ?? null,
      maxModelCalls: this.options.maxModelCalls ?? null,
      calls: this.calls,
      knownCostUsd: this.knownCostUsd,
      unknownCostCalls: this.unknownCostCalls,
      stopped: this.stopped,
      stopReason: this.stopReason,
      byStage: [],
      byModel: [],
    };
  }
}

/**
 * 一份**本地**台账。每个并发场景各持一份（由 `runWithEvalLedger` 挂到该场景
 * 自己的异步上下文里），负责记这个场景自己的调用数与 stage/model 分解。
 *
 * 限流交给共享预算：有 `sharedBudget`（整批唯一）时只记收据、不各自设限；
 * 没有时**自建一份私有 `BatchBudget`**，行为与旧版逐字一致（单份台账自己
 * 就是一个"批"）。
 */
export class GatewayCostLedger {
  private calls = 0;
  private knownCostUsd = 0;
  private unknownCostCalls = 0;
  private readonly stages = new Map<string, LedgerBucket>();
  private readonly models = new Map<string, LedgerBucket>();
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

  get isStopped(): boolean {
    return this.budget.isStopped;
  }

  snapshot(): LedgerSnapshot {
    const budget = this.budget.snapshot();
    return {
      maxCostUsd: this.options.maxCostUsd ?? null,
      maxModelCalls: this.options.maxModelCalls ?? null,
      calls: this.calls,
      knownCostUsd: this.knownCostUsd,
      unknownCostCalls: this.unknownCostCalls,
      // 本地自己不设限时，停止状态来自共享预算（报告要能显示整批停止原因）。
      stopped: budget.stopped,
      stopReason: budget.stopReason,
      byStage: [...this.stages.values()].map((b) => ({ ...b })),
      byModel: [...this.models.values()].map((b) => ({ ...b })),
    };
  }
}

const storage = new AsyncLocalStorage<GatewayCostLedger>();

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
 * 包住一次 Gateway `generateText` 调用。
 *
 * - 上下文里没有台账（生产）→ **原样透传**，不登记、不改行为。
 * - 有台账 → 发起前登记/查限（触限抛 `EvalBudgetExceededError`），
 *   返回后按真实 cost 记账（读不到记 unknown）。
 *
 * `stage`/`modelId` 是报告用的标签，模型字符串由调用方显式传入
 * （`getLanguageModel` 之后拿不回 id，见 lib/ai/providers.ts）。
 */
export async function trackedGatewayCall<T>(
  stage: string,
  modelId: string,
  run: () => Promise<T>
): Promise<T> {
  const ledger = storage.getStore();
  if (!ledger) return run();
  ledger.beforeCall(stage, modelId);
  let result: T;
  try {
    result = await run();
  } catch (error) {
    // 调用真的发出去了但抛错：花费未知，不能当 0。
    ledger.afterCall(stage, modelId, null);
    throw error;
  }
  ledger.afterCall(
    stage,
    modelId,
    gatewayCostFromResult(
      result as unknown as {
        steps?: ReadonlyArray<{ providerMetadata?: unknown }>;
        providerMetadata?: unknown;
      }
    )
  );
  return result;
}

/** 把多份快照合并成一份总计，给终端汇总用。 */
export function mergeLedgerSnapshots(
  snapshots: readonly LedgerSnapshot[]
): LedgerSnapshot {
  const stages = new Map<string, LedgerBucket>();
  const models = new Map<string, LedgerBucket>();
  let calls = 0;
  let knownCostUsd = 0;
  let unknownCostCalls = 0;
  let stopped = false;
  let stopReason: string | null = null;
  for (const snap of snapshots) {
    calls += snap.calls;
    knownCostUsd += snap.knownCostUsd;
    unknownCostCalls += snap.unknownCostCalls;
    if (snap.stopped) {
      stopped = true;
      stopReason = stopReason ? `${stopReason}；${snap.stopReason ?? ""}` : snap.stopReason;
    }
    for (const bucket of snap.byStage) {
      let target = stages.get(bucket.key);
      if (!target) {
        target = { key: bucket.key, calls: 0, knownCostUsd: 0, unknownCostCalls: 0 };
        stages.set(bucket.key, target);
      }
      target.calls += bucket.calls;
      target.knownCostUsd += bucket.knownCostUsd;
      target.unknownCostCalls += bucket.unknownCostCalls;
    }
    for (const bucket of snap.byModel) {
      let target = models.get(bucket.key);
      if (!target) {
        target = { key: bucket.key, calls: 0, knownCostUsd: 0, unknownCostCalls: 0 };
        models.set(bucket.key, target);
      }
      target.calls += bucket.calls;
      target.knownCostUsd += bucket.knownCostUsd;
      target.unknownCostCalls += bucket.unknownCostCalls;
    }
  }
  return {
    maxCostUsd: snapshots[0]?.maxCostUsd ?? null,
    maxModelCalls: snapshots[0]?.maxModelCalls ?? null,
    calls,
    knownCostUsd,
    unknownCostCalls,
    stopped,
    stopReason,
    byStage: [...stages.values()],
    byModel: [...models.values()],
  };
}
