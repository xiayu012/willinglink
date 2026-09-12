/**
 * 逐层计费证据台账的**离线行为测试**：stub / fake result 驱动真实台账 API。
 *
 * 不发任何模型调用、不连数据库、不写生产、不碰 `public/sw.js`。这里只调
 * `lib/chat/coliving/gateway-ledger.ts` 的真实函数，用伪造的 step / result
 * 跑一遍 `captureStep` / `finishGeneration` / `afterCall`，逐条验证：
 *
 * - 三层口径不互相冒充：**generation（生成批次）/ step（工具往返）/
 *   transport attempts（本 SDK 不可观测 → null）**；
 * - `null` 是"上游没回报"，**不是 0**；明确回报的字符串 `"0"` 才是已知的 0；
 * - 中途失败保留已完成 step 的证据，尾部不可知费用标 unknown，不清零不重复；
 * - 主生成里的工具 embedding 是**另一条 operation**，各自计费不重复；
 * - 生产（无台账）完全透传；并发场景/嵌套标签不串场；
 * - 旧快照（v1）仍可读；HTML 不把 unknown/null 显示成 0。
 *
 * 运行：`pnpm coliving:ledger-inspect`
 * （gateway-ledger import 了 server-only，需要 NODE_OPTIONS=--conditions=react-server；
 *   展示层的 ledger-report 是纯模块，普通 tsx 也能 import。）
 */
import assert from "node:assert/strict";
import {
  currentEvalLedger,
  GatewayCostLedger,
  gatewayCostFromResult,
  LEDGER_SCHEMA_VERSION,
  mergeLedgerSnapshots,
  runWithEvalLedger,
  runWithLedgerLabels,
  trackedGatewayCall,
  TRANSPORT_OBSERVABILITY_NOTE,
  type GenerationRecorder,
  type LedgerSnapshot,
} from "../lib/chat/coliving/gateway-ledger";
import {
  COST_UNKNOWN,
  formatKnownCost,
  formatTokenTotal,
  formatUsd,
  renderLedgerPanelHtml,
  summarizeGenerations,
  TOKEN_UNKNOWN,
  TRANSPORT_UNOBSERVABLE,
} from "../lib/chat/coliving/ledger-report";

// ── 伪造 step / result（结构上够 generateText 的 step 用） ──────────────
type FakeStepInput = {
  /** gateway 回报的字符串 cost；undefined = 该步缺 cost 字段（未知）。 */
  cost?: string;
  /** Anthropic 原始 usage（providerMetadata.anthropic.usage）。 */
  anthropic?: Record<string, unknown>;
  usage?: unknown;
  finishReason?: string;
  modelId?: string;
  responseId?: string;
};

function fakeStep(input: FakeStepInput = {}) {
  const providerMetadata: Record<string, unknown> = {};
  if (input.cost !== undefined) providerMetadata.gateway = { cost: input.cost };
  if (input.anthropic !== undefined) {
    providerMetadata.anthropic = { usage: input.anthropic };
  }
  return {
    finishReason: input.finishReason ?? "stop",
    usage: input.usage,
    providerMetadata,
    response: {
      id: input.responseId ?? "resp-1",
      modelId: input.modelId ?? "m",
      headers: { "x-vercel-id": "req-1" },
    },
  };
}

/** 伪造一次 generateText：按顺序触发真实 step hook，再返回带 steps 的结果。 */
async function fakeGenerateText(
  recorder: GenerationRecorder,
  steps: ReturnType<typeof fakeStep>[]
) {
  for (const s of steps) recorder.stepOptions.onStepFinish?.(s);
  return { steps };
}

async function main() {
  let count = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    count++;
    console.log(`PASS ${name}`);
  };
  const checkAsync = async (name: string, fn: () => Promise<void>) => {
    await fn();
    count++;
    console.log(`PASS ${name}`);
  };

  // ── 六个正常例（来自任务卡"可反驳的正常例"） ──────────────────────────

  await checkAsync(
    "例1 一次 3-step generation：generation=1、steps=3、金额与 token 对得上、不重复累计",
    async () => {
      const ledger = new GatewayCostLedger({});
      const result = await runWithEvalLedger(ledger, () =>
        trackedGatewayCall("main", "m", (rec) =>
          fakeGenerateText(rec, [
            fakeStep({
              cost: "0.10",
              anthropic: {
                input_tokens: 1000,
                cache_read_input_tokens: 200,
                cache_creation_input_tokens: 50,
                output_tokens: 300,
                reasoning_output_tokens: 10,
              },
            }),
            fakeStep({ cost: "0.20" }),
            fakeStep({ cost: "0.30", finishReason: "tool-calls" }),
          ])
        )
      );
      assert.equal(result.steps.length, 3);

      const snap = ledger.snapshot();
      assert.equal(snap.generations, 1, "3 个 step 仍然是 1 个 generation");
      assert.equal(snap.calls, 1);
      assert.equal(snap.generationRecords.length, 1);
      const g = snap.generationRecords[0];
      assert.equal(g.completedSteps, 3);
      assert.equal(g.steps.length, 3);
      assert.equal(g.unknownCostSteps, 0);
      assert.equal(g.unknownCost, false);
      assert.ok(
        Math.abs(g.knownCostUsd - 0.6) < 1e-9,
        `3 步金额应为 0.60，实际 ${g.knownCostUsd}`
      );
      assert.ok(Math.abs(snap.knownCostUsd - 0.6) < 1e-9);
      assert.equal(snap.unknownCostGenerations, 0);

      // token/cache 逐步读取：Anthropic 原始 usage 优先。
      const s0 = g.steps[0];
      assert.equal(s0.inputUncachedTokens, 1000);
      assert.equal(s0.cacheReadTokens, 200);
      assert.equal(s0.cacheWriteTokens, 50);
      assert.equal(s0.outputTokens, 300);
      assert.equal(s0.reasoningTokens, 10);
      assert.equal(s0.finishReason, "stop");
      assert.equal(s0.providerId, "m");
      assert.equal(s0.generationId, "resp-1");
      assert.equal(s0.requestId, "req-1");
      assert.equal(g.steps[2].finishReason, "tool-calls");
      // 单步耗时本 SDK 给不出：恒 null，不编造。
      assert.equal(s0.durationMs, null);
    }
  );

  await checkAsync(
    "例2 SDK 内部重试不可观测：attempts=null + 说明，不写 1/3、不拿 generation 数冒充",
    async () => {
      const ledger = new GatewayCostLedger({});
      await runWithEvalLedger(ledger, () =>
        trackedGatewayCall("main", "m", (rec) =>
          fakeGenerateText(rec, [fakeStep({ cost: "0.01" })])
        )
      );
      const g = ledger.snapshot().generationRecords[0];
      assert.equal(g.transportAttempts, null, "transport retry 次数不可观测 → null");
      assert.equal(g.transportObservability, TRANSPORT_OBSERVABILITY_NOTE);
      assert.match(g.transportObservability, /不可观测/);
    }
  );

  await checkAsync(
    "例3 第一步完成、第二步抛错：第一步证据保留、标 partial、尾部 unknown，不清零不重复",
    async () => {
      const ledger = new GatewayCostLedger({});
      await assert.rejects(
        runWithEvalLedger(ledger, () =>
          trackedGatewayCall("main", "m", async (rec) => {
            rec.stepOptions.onStepFinish?.(
              fakeStep({
                cost: "0.10",
                anthropic: { input_tokens: 10, output_tokens: 5 },
              })
            );
            throw new Error("boom");
          })
        ),
        /boom/
      );
      const snap = ledger.snapshot();
      assert.equal(snap.generations, 1);
      const g = snap.generationRecords[0];
      assert.equal(g.status, "partial", "有已完成 step 的失败标 partial");
      assert.equal(g.completedSteps, 1, "抛错前的第一步必须保留，且只保留一次");
      assert.equal(g.steps.length, 1);
      assert.equal(g.steps[0].inputUncachedTokens, 10, "第一步 token 证据不丢");
      assert.ok(
        Math.abs(g.knownCostUsd - 0.1) < 1e-9,
        "已知金额是下界，不清零"
      );
      assert.equal(g.unknownCostSteps, 0, "已完成那步的 cost 是已知的");
      assert.equal(g.unknownCost, true, "尾部费用不可知 → 整笔标 unknown");
      assert.equal(g.errorName, "Error", "只留异常类型名，不带正文");
      assert.equal(snap.unknownCostCalls, 1, "台账把这笔记成 unknown，不当 0 花费");
      assert.ok(
        Math.abs(snap.knownCostUsd - 0.1) < 1e-9,
        "已花的 0.10 照记，不因失败抹掉"
      );
    }
  );

  await checkAsync(
    '例4 某步 cost 明确为字符串 "0"：是已知 0，不是 unknown（缺字段才是 unknown）',
    async () => {
      const ledger = new GatewayCostLedger({});
      await runWithEvalLedger(ledger, () =>
        trackedGatewayCall("main", "m", (rec) =>
          fakeGenerateText(rec, [fakeStep({ cost: "0" })])
        )
      );
      const g = ledger.snapshot().generationRecords[0];
      assert.equal(g.steps[0].costUsd, 0, '字符串 "0" 读成已知 0');
      assert.equal(g.unknownCostSteps, 0);
      assert.equal(g.unknownCost, false, 'cost "0" 是已知 0，整笔不该标 unknown');
      assert.equal(ledger.snapshot().unknownCostCalls, 0);
      assert.equal(formatUsd(0), "$0.000000", "已知的 0 显示成 0");
      assert.equal(formatKnownCost(0, false), "$0.000000");

      // 对照：**缺** cost 字段才是 unknown（显示成"未知"，不是 0）。
      const ledger2 = new GatewayCostLedger({});
      await runWithEvalLedger(ledger2, () =>
        trackedGatewayCall("redo", "m", (rec) =>
          fakeGenerateText(rec, [fakeStep({})])
        )
      );
      const g2 = ledger2.snapshot().generationRecords[0];
      assert.equal(g2.steps[0].costUsd, null);
      assert.equal(g2.unknownCost, true);
      assert.equal(formatKnownCost(g2.knownCostUsd, g2.unknownCost), COST_UNKNOWN);
    }
  );

  await checkAsync(
    "例5 主生成调工具、工具里单独 embedding：两条 operation 各自计费，主 generation 不重复包含",
    async () => {
      const ledger = new GatewayCostLedger({});
      await runWithEvalLedger(ledger, () =>
        trackedGatewayCall("main", "big", async (rec) => {
          // 工具执行期间的 embedding：**独立 generation**。
          await trackedGatewayCall(
            "embed",
            "small",
            async () => ({
              usage: { tokens: 42 },
              providerMetadata: { gateway: { cost: "0.001" } },
            }),
            { kind: "embedding" }
          );
          // 主生成本身只有一个 step。
          return fakeGenerateText(rec, [fakeStep({ cost: "0.50" })]);
        })
      );
      const snap = ledger.snapshot();
      assert.equal(snap.generations, 2, "主生成 + embedding 是两条 generation");
      const main = snap.generationRecords.find((g) => g.stage === "main");
      const embed = snap.generationRecords.find((g) => g.stage === "embed");
      assert.ok(main, "主生成那条 operation 必须登记");
      assert.ok(embed, "embedding 那条 operation 必须登记");
      assert.equal(main.operationKind, "text-generation");
      assert.equal(embed.operationKind, "embedding");
      assert.equal(main.completedSteps, 1);
      assert.equal(embed.completedSteps, 1, "embedding 整个调用算一步");
      assert.ok(
        Math.abs(main.knownCostUsd - 0.5) < 1e-9,
        "主 generation 不含 embedding 的 0.001"
      );
      assert.ok(Math.abs(embed.knownCostUsd - 0.001) < 1e-9);
      assert.ok(
        Math.abs(snap.knownCostUsd - 0.501) < 1e-9,
        "两条都在，相加不重复"
      );
      assert.equal(embed.steps[0].inputUncachedTokens, 42);
      assert.equal(embed.transportAttempts, null);
    }
  );

  await checkAsync(
    "例6 无 eval ledger 的生产调用：完全透传，不建持久账、stepOptions 为空对象",
    async () => {
      assert.equal(currentEvalLedger(), undefined, "顶层上下文没有台账（生产）");
      let seen: GenerationRecorder | null = null;
      const marker = { value: 7 };
      const returned = await trackedGatewayCall("main", "m", async (rec) => {
        seen = rec;
        return marker;
      });
      assert.equal(returned, marker, "返回值原样透传，不包不改");
      assert.deepEqual(
        seen!.stepOptions,
        {},
        "无台账时 stepOptions 是空对象，展开进 generateText 后参数逐字不变"
      );
      assert.equal(currentEvalLedger(), undefined, "透传不会创建持久账");
    }
  );

  // ── 并发场景不串账 ────────────────────────────────────────────────────
  await checkAsync(
    "并发 scenario 不串账：账目与 run/scenario 标签互不污染",
    async () => {
      const ledgerA = new GatewayCostLedger({});
      const ledgerB = new GatewayCostLedger({});
      await Promise.all([
        runWithEvalLedger(ledgerA, () =>
          runWithLedgerLabels({ runId: "run-1", scenarioId: "sa" }, async () => {
            await trackedGatewayCall("main", "ma", async (rec) =>
              fakeGenerateText(rec, [fakeStep({ cost: "0.10" })])
            );
            await trackedGatewayCall("redo", "ma", async (rec) =>
              fakeGenerateText(rec, [fakeStep({ cost: "0.20" })])
            );
          })
        ),
        runWithEvalLedger(ledgerB, () =>
          runWithLedgerLabels({ runId: "run-1", scenarioId: "sb" }, async () => {
            await trackedGatewayCall("main", "mb", async (rec) =>
              fakeGenerateText(rec, [fakeStep({ cost: "0.05" })])
            );
          })
        ),
      ]);
      const a = ledgerA.snapshot();
      const b = ledgerB.snapshot();
      assert.equal(a.generations, 2, "A 只记自己的两次");
      assert.equal(b.generations, 1, "B 只记自己的一次");
      assert.ok(
        a.generationRecords.every((g) => g.scenarioId === "sa"),
        "A 的每条记录都挂 sa"
      );
      assert.ok(
        b.generationRecords.every((g) => g.scenarioId === "sb"),
        "B 的每条记录都挂 sb"
      );
      assert.ok(a.generationRecords.every((g) => g.runId === "run-1"));
      assert.ok(Math.abs(a.knownCostUsd - 0.3) < 1e-9);
      assert.ok(Math.abs(b.knownCostUsd - 0.05) < 1e-9);
    }
  );

  // ── 嵌套标签不跨边界 ──────────────────────────────────────────────────
  await checkAsync(
    "标签嵌套不串：turn 标签只在该轮内生效，出了该轮 turnIndex 回到 null、外层标签照旧继承",
    async () => {
      const ledger = new GatewayCostLedger({});
      await runWithEvalLedger(ledger, () =>
        runWithLedgerLabels({ runId: "r", scenarioId: "s" }, async () => {
          await runWithLedgerLabels({ turnIndex: 0 }, () =>
            trackedGatewayCall("main", "m", async (rec) =>
              fakeGenerateText(rec, [fakeStep({ cost: "0.01" })])
            )
          );
          // 出轮之后的调用（例如 judge）：仍继承 run/scenario，但不在某一轮里。
          await trackedGatewayCall("judge", "m", async (rec) =>
            fakeGenerateText(rec, [fakeStep({ cost: "0.02" })])
          );
        })
      );
      const recs = ledger.snapshot().generationRecords;
      const turn0 = recs.find((g) => g.stage === "main");
      const judge = recs.find((g) => g.stage === "judge");
      assert.equal(turn0!.turnIndex, 0);
      assert.equal(turn0!.scenarioId, "s");
      assert.equal(turn0!.runId, "r");
      assert.equal(judge!.turnIndex, null, "判定不属于某一轮，turnIndex 必须是 null");
      assert.equal(judge!.scenarioId, "s", "但 scenario 标签照旧继承");
      assert.equal(judge!.runId, "r");
    }
  );

  // ── 预算兼容：命名准确、金额闸不因明细记录而放宽 ──────────────────────
  check(
    "预算兼容：maxModelCalls 仍按 generation 限，错误消息说 generation 不是 HTTP；金额闸照旧",
    () => {
      const ledger = new GatewayCostLedger({ maxModelCalls: 1 });
      ledger.beforeCall("main", "m");
      ledger.afterCall("main", "m", { costUsd: 0.01, unknown: false });
      let message = "";
      try {
        ledger.beforeCall("redo", "m");
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      assert.match(message, /generation 硬上限/, "消息要点名 generation 硬上限");
      assert.match(message, /不是 HTTP 请求数/, "不得再含糊成「调用次数」");
      assert.equal(ledger.snapshot().generations, 1, "被拒的那次不计入");

      // 金额闸照旧：已知累计达线后拦下一次，且不被逐 step 明细放宽。
      const costLedger = new GatewayCostLedger({ maxCostUsd: 0.25 });
      costLedger.beforeCall("main", "m");
      costLedger.afterCall("main", "m", { costUsd: 0.3, unknown: false });
      assert.throws(
        () => costLedger.beforeCall("redo", "m"),
        (error: unknown) =>
          error instanceof Error && /\$0\.25|金额上限|已知累计/.test(error.message)
      );
    }
  );

  // ── 旧报告 / 旧快照兼容 ───────────────────────────────────────────────
  check(
    "旧 v1 快照可读：缺 schemaVersion/generationRecords/generations 也不炸、不当 0",
    () => {
      const v1 = {
        maxCostUsd: null,
        maxModelCalls: 5,
        calls: 3,
        knownCostUsd: 0.12,
        unknownCostCalls: 1,
        stopped: false,
        stopReason: null,
        byStage: [{ key: "main", calls: 2, knownCostUsd: 0.1, unknownCostCalls: 0 }],
        byModel: [{ key: "m", calls: 3, knownCostUsd: 0.12, unknownCostCalls: 1 }],
      } as unknown as LedgerSnapshot;

      const html = renderLedgerPanelHtml(v1);
      assert.ok(html.includes("计费证据"));
      assert.ok(html.includes(">3<"), "旧快照的 generation 数退回 calls");
      assert.ok(html.includes("旧快照无逐 step 明细"), "step 明细缺失要明说");
      assert.ok(html.includes(TOKEN_UNKNOWN), "token 缺失显示未知");
      assert.ok(html.includes(TRANSPORT_UNOBSERVABLE), "transport 显示不可观测");

      const merged = mergeLedgerSnapshots([v1]);
      assert.equal(merged.calls, 3);
      assert.equal(merged.generations, 3);
      assert.equal(merged.unknownCostCalls, 1);
      assert.equal(merged.unknownCostGenerations, 1);
      assert.equal(merged.generationRecords.length, 0);
      assert.ok(Math.abs(merged.knownCostUsd - 0.12) < 1e-9);
      assert.equal(
        merged.byStage.find((x) => x.key === "main")!.generations,
        2,
        "旧 bucket 缺 generations 时退回 calls"
      );
    }
  );

  // ── HTML：unknown / null 不显示成 0 ───────────────────────────────────
  check(
    "HTML 不把 unknown/null 显示为 0：null token 显示未知、未知金额不显示 $0.000000、transport 显示不可观测",
    () => {
      const snapshot: LedgerSnapshot = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        maxCostUsd: null,
        maxModelCalls: null,
        maxGenerations: null,
        calls: 1,
        generations: 1,
        knownCostUsd: 0,
        unknownCostCalls: 1,
        unknownCostGenerations: 1,
        stopped: false,
        stopReason: null,
        byStage: [
          { key: "main", calls: 1, generations: 1, knownCostUsd: 0, unknownCostCalls: 1 },
        ],
        byModel: [
          { key: "m", calls: 1, generations: 1, knownCostUsd: 0, unknownCostCalls: 1 },
        ],
        generationRecords: [
          {
            seq: 1,
            runId: "r",
            scenarioId: "s",
            turnIndex: 0,
            stage: "main",
            modelId: "m",
            operationKind: "text-generation",
            status: "completed",
            steps: [
              {
                index: 0,
                inputUncachedTokens: null,
                cacheReadTokens: null,
                cacheWriteTokens: null,
                outputTokens: null,
                reasoningTokens: null,
                costUsd: null,
                finishReason: "stop",
                durationMs: null,
                providerId: "m",
                generationId: "g",
                requestId: "rq",
              },
            ],
            completedSteps: 1,
            knownCostUsd: 0,
            unknownCostSteps: 1,
            unknownCost: true,
            durationMs: 5,
            transportAttempts: null,
            transportObservability: TRANSPORT_OBSERVABILITY_NOTE,
          },
        ],
      };

      const html = renderLedgerPanelHtml(snapshot);
      assert.ok(
        html.includes(`<span class="cv">${TOKEN_UNKNOWN}</span>`),
        `null token 显示「${TOKEN_UNKNOWN}」，不是 0`
      );
      assert.ok(
        html.includes(`<span class="cv">${COST_UNKNOWN}</span>`),
        "有未知项且已知合计为 0 时显示「未知」，不显示 $0.000000"
      );
      assert.ok(!html.includes("$0.000000"), "不得把未知花费显示成 $0.000000");
      assert.ok(html.includes(TRANSPORT_UNOBSERVABLE), "transport 显示不可观测");
      assert.ok(html.includes("<td>是</td>"), "明细行把未知标成「是」");

      // 汇总层的口径一致：null 就是 null，不是 0。
      const s = summarizeGenerations(snapshot.generationRecords);
      assert.equal(s.tokens.inputUncachedTokens.known, null);
      assert.equal(s.tokens.inputUncachedTokens.hasUnknown, true);
      assert.equal(
        formatTokenTotal(s.tokens.inputUncachedTokens),
        TOKEN_UNKNOWN
      );
      assert.equal(s.tokens.outputTokens.known, null);
      assert.equal(s.transportAttempts, null);
      assert.equal(s.completedSteps, 1);
      assert.equal(s.hasUnknownCost, true);
    }
  );

  // 旧报告的"没有 cost 字段"这一态走纯 display 层；顺带证明 gatewayCostFromResult
  // 这个旧入口没被新逻辑改坏（既有行为逐字保留）。
  check(
    "无台账/无明细兜底：gatewayCostFromResult 逐步累加、缺字段记 unknown（旧入口不变）",
    () => {
      const reading = gatewayCostFromResult({
        steps: [
          { providerMetadata: { gateway: { cost: "0.10" } } },
          { providerMetadata: {} },
        ],
      });
      assert.ok(Math.abs(reading.costUsd - 0.1) < 1e-9);
      assert.equal(reading.unknown, true);
      assert.equal(gatewayCostFromResult({ steps: [] }).unknown, true);

      const noLedgerHtml = renderLedgerPanelHtml(undefined);
      assert.ok(noLedgerHtml.includes("没有计费台账"));
      assert.ok(noLedgerHtml.includes("不按 0 计"));
    }
  );

  // ── 复审 V8：token 汇总不得把「部分已知」显示成完整总数 ──────────────
  await checkAsync(
    "V8-1 token 汇总：一步有数、一步未知 → 标「部分已知，下界」并保留已知小计，不当完整总数",
    async () => {
      const ledger = new GatewayCostLedger({});
      await runWithEvalLedger(ledger, () =>
        trackedGatewayCall("main", "m", (rec) =>
          fakeGenerateText(rec, [
            fakeStep({
              cost: "0.10",
              anthropic: {
                input_tokens: 100,
                output_tokens: 40,
                cache_read_input_tokens: 5,
                cache_creation_input_tokens: 2,
                reasoning_output_tokens: 1,
              },
            }),
            // 第二步没回报任何 token：这一类就是「有未回报项」。
            fakeStep({ cost: "0.20" }),
          ])
        )
      );
      const g = ledger.snapshot().generationRecords[0];
      const s = summarizeGenerations([g]);

      assert.equal(s.tokens.inputUncachedTokens.known, 100);
      assert.equal(
        s.tokens.inputUncachedTokens.hasUnknown,
        true,
        "存在未回报的 step → 不能当完整总数"
      );
      assert.equal(
        formatTokenTotal(s.tokens.inputUncachedTokens),
        "100（部分已知，下界）",
        "已知小计要保留，但必须标成部分已知/下界"
      );
      assert.equal(
        formatTokenTotal(s.tokens.outputTokens),
        "40（部分已知，下界）"
      );
      assert.equal(
        formatTokenTotal(s.tokens.cacheReadTokens),
        "5（部分已知，下界）"
      );

      // 全部 step 都回报 → 才是完整总数，不标下界。
      const ledgerFull = new GatewayCostLedger({});
      const full = (n: number) => ({
        input_tokens: n,
        output_tokens: n + 1,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 1,
        reasoning_output_tokens: 1,
      });
      await runWithEvalLedger(ledgerFull, () =>
        trackedGatewayCall("main", "m", (rec) =>
          fakeGenerateText(rec, [
            fakeStep({ cost: "0.01", anthropic: full(10) }),
            fakeStep({ cost: "0.01", anthropic: full(20) }),
          ])
        )
      );
      const sFull = summarizeGenerations(
        ledgerFull.snapshot().generationRecords
      );
      assert.equal(sFull.tokens.inputUncachedTokens.known, 30);
      assert.equal(sFull.tokens.inputUncachedTokens.hasUnknown, false);
      assert.equal(formatTokenTotal(sFull.tokens.inputUncachedTokens), "30");

      // 一个已知项都没有 → 未知，不是 0。
      const ledgerNone = new GatewayCostLedger({});
      await runWithEvalLedger(ledgerNone, () =>
        trackedGatewayCall("main", "m", (rec) =>
          fakeGenerateText(rec, [fakeStep({ cost: "0.01" })])
        )
      );
      const sNone = summarizeGenerations(
        ledgerNone.snapshot().generationRecords
      );
      assert.equal(sNone.tokens.inputUncachedTokens.known, null);
      assert.equal(
        formatTokenTotal(sNone.tokens.inputUncachedTokens),
        TOKEN_UNKNOWN
      );

      // HTML 展示口径一致：混合场景显示下界标注，不显示成裸的完整总数。
      const html = renderLedgerPanelHtml(ledger.snapshot());
      assert.ok(
        html.includes("100（部分已知，下界）"),
        "HTML 必须标出部分已知/下界，保留已知小计"
      );
    }
  );

  // ── 复审 V8：成功返回但 result.steps 缺失/为空时不丢证据 ─────────────
  await checkAsync(
    "V8-2a 成功返回无 result.steps、hook 有一步：保留 hook 的 step，不丢不清零",
    async () => {
      const ledger = new GatewayCostLedger({});
      await runWithEvalLedger(ledger, () =>
        trackedGatewayCall("main", "m", async (rec) => {
          rec.stepOptions.onStepFinish?.(
            fakeStep({
              cost: "0.42",
              anthropic: { input_tokens: 70, output_tokens: 8 },
            })
          );
          return {}; // 成功返回，但没有 result.steps
        })
      );
      const g = ledger.snapshot().generationRecords[0];
      assert.equal(g.status, "completed");
      assert.equal(
        g.completedSteps,
        1,
        "hook 捕获的 step 不能因 result.steps 缺失而丢"
      );
      assert.equal(g.steps.length, 1);
      assert.equal(g.steps[0].costUsd, 0.42);
      assert.equal(g.steps[0].inputUncachedTokens, 70);
      assert.ok(Math.abs(g.knownCostUsd - 0.42) < 1e-9);
      assert.equal(g.unknownCost, false, "已知 cost 的这一步不该被标 unknown");
    }
  );

  await checkAsync(
    "V8-2b 成功返回无 result.steps、hook 无步骤但顶层有 Gateway cost：至少保留 cost 证据",
    async () => {
      const ledger = new GatewayCostLedger({});
      await runWithEvalLedger(ledger, () =>
        trackedGatewayCall("main", "m", async () => ({
          finishReason: "stop",
          usage: { inputTokens: 33, outputTokens: 4 },
          providerMetadata: { gateway: { cost: "0.07" } },
          response: {
            id: "resp-top",
            modelId: "m",
            headers: { "x-vercel-id": "rq-top" },
          },
        }))
      );
      const g = ledger.snapshot().generationRecords[0];
      assert.equal(g.status, "completed");
      assert.equal(
        g.completedSteps,
        1,
        "连 hook 都没有时，用顶层 result 至少保留一步 cost 证据"
      );
      assert.equal(g.steps[0].costUsd, 0.07, "顶层 Gateway cost 不能丢");
      assert.equal(g.steps[0].inputUncachedTokens, 33);
      assert.equal(g.steps[0].generationId, "resp-top");
      assert.equal(g.steps[0].requestId, "rq-top");
      assert.ok(Math.abs(g.knownCostUsd - 0.07) < 1e-9);
      assert.equal(g.unknownCost, false);

      // 顶层连 cost 都没有 → 未知，不当 0 花费。
      const ledger2 = new GatewayCostLedger({});
      await runWithEvalLedger(ledger2, () =>
        trackedGatewayCall("main", "m", async () => ({ finishReason: "stop" }))
      );
      const g2 = ledger2.snapshot().generationRecords[0];
      assert.equal(g2.completedSteps, 1);
      assert.equal(g2.steps[0].costUsd, null);
      assert.equal(g2.unknownCost, true, "顶层也没回报 cost → unknown，不是 0");
    }
  );

  await checkAsync(
    "V8-2c 正常 result.steps 与 hook 是同一批 step：不重复累计（不变成两倍 step/cost）",
    async () => {
      const ledger = new GatewayCostLedger({});
      const step = fakeStep({
        cost: "0.10",
        anthropic: { input_tokens: 11, output_tokens: 3 },
      });
      await runWithEvalLedger(ledger, () =>
        // fakeGenerateText 先触发 hook 再返回同一批 steps（模拟真实 SDK）。
        trackedGatewayCall("main", "m", (rec) =>
          fakeGenerateText(rec, [step])
        )
      );
      const g = ledger.snapshot().generationRecords[0];
      assert.equal(g.completedSteps, 1, "只记一次，不能 hook + result.steps 各记一次");
      assert.equal(g.steps.length, 1);
      assert.ok(
        Math.abs(g.knownCostUsd - 0.1) < 1e-9,
        "金额不能重复累计成 0.20"
      );
      assert.equal(g.steps[0].inputUncachedTokens, 11);
    }
  );

  console.log(
    `\n${count} ledger behavior checks passed (offline; no model calls, no DB, no send).`
  );
}

main().catch((e) => {
  console.error("台账行为测试失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
