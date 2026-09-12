/**
 * 合租房大脑的语料回归 runner。
 *
 * 用法：
 *   pnpm coliving-eval                          # 跑全部语料，并发 4
 *   pnpm coliving-eval -- --scenario kitchen-procrastination-2026-09-05
 *   pnpm coliving-eval -- --concurrency 8
 *   pnpm coliving-eval -- --limit 3
 *   pnpm coliving-eval -- --judge-off        # 跳过语义验收，只跑结构性
 *   pnpm coliving-eval -- --judge-advisory   # 语义验收照跑，但 high 不计入门禁
 *   pnpm coliving-eval -- --guidance concise-coordination-v1   # 实验组：加成功轨迹
 *   pnpm coliving-eval -- --max-cost-usd 0.5 --max-generations 200   # 预算闸
 *
 * `--max-cost-usd` / `--max-generations`（旧名 `--max-model-calls`，语义一直是
 * 这个）是**仅评测**的开支闸（见 `lib/chat/coliving/gateway-ledger.ts`）：
 * 两个都不传就是原来不设限的完整跑批；generation 数是硬上限，金额按 gateway
 * 实际回报的花费判断（软硬混合）。**两个上限都是整次跑批共享的总上限**
 * （只建一份 `BatchBudget`），不是每个场景各一份——否则 N 个场景会把总预算
 * 放大 N 倍。每个场景仍保有自己的本地台账（stage/model 分解 + 逐 generation
 * 明细），终端汇总不会重复计费。
 *
 * **generation ≠ HTTP 请求**：一个 generation 内部还有多个 step（带工具往返）
 * 和 SDK 的 transport retry；后者本 SDK 不可观测，报告里记 `null` 并注明，
 * 不猜、也不拿 generation 数冒充请求数。报告与终端汇总都记 generation 数、
 * 已完成 step 数、tokens/cache、已知花费、拿不到 cost 的 generation 数；
 * 预算中途触限也会把已花的钱和已跑完的轮次写进报告，并附上整批共享预算的
 * 停止原因。
 *
 * `--guidance` 默认不启用；只接受 `lib/chat/coliving/evals/guidance.ts` 里
 * 已登记的 id，未知 id 立即报错。报告会记录本次用的是哪个 guidance id
 * （没启用记 null），基线和实验结果不会混淆。
 *
 * 设计对照 docs/coliving-parallel-testing-plan.md 阶段一 + 阶段二：
 * - 每个场景一个独立测试屋，household_id 天然隔离，不需要
 *   `pnpm coliving:db --purge` 这个串行点，场景之间可以并发跑。
 * - 判定全部是**结构性**检查（工具有没有调、回复/出站消息有没有命中
 *   某个正则），不引入额外的模型调用做语义判分——语义判断留给人工
 *   或者阶段三的子代理审查，这里只做代码能确定性判的那部分。
 * - 语料**只增不减**：抓到新的真实 bug，对应的复现场景整理成一份
 *   JSON 提交进 `scenarios/`，以后每次跑批默认全量跑，自动重新验证
 *   过去踩过的所有坑。
 *
 * 退出码：结构性断言失败，或语义验收（judge）报了 high → 1，否则 0。
 * `--judge-advisory` 可以让 judge 只旁听、不参与退出码（默认参与，见下）。
 * 报告：终端打印 + 写一份 JSON 到 tests/coliving-eval/reports/（gitignored，
 * 目录不存在会自动建）。
 */

import { config } from "dotenv";
config({ path: ".env.local" });
process.env.COLIVING_LOCAL_WRITE = "1";

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { JudgeResult } from "../lib/chat/coliving/evals/judge";
import type {
  EvalScenario,
  TurnOutcome,
} from "../lib/chat/coliving/evals/schema";
import {
  evaluateTurnExpectation,
  evaluateTurnReplyReviews,
  validateScenario,
} from "../lib/chat/coliving/evals/schema";
import type { ReplyReview } from "../lib/chat/coliving/turn";
import {
  isMissingGuidanceArg,
  knownGuidanceIds,
  resolveGuidanceArg,
} from "../lib/chat/coliving/evals/guidance";
import {
  BatchBudget,
  GatewayCostLedger,
  isEvalBudgetExceeded,
  mergeLedgerSnapshots,
  runWithEvalLedger,
  runWithLedgerLabels,
  type LedgerSnapshot,
} from "../lib/chat/coliving/gateway-ledger";
import {
  formatKnownCost,
  formatTokenTotal,
  summarizeGenerations,
  TRANSPORT_UNOBSERVABLE,
} from "../lib/chat/coliving/ledger-report";

// ── CLI args ─────────────────────────────────────────────────────────────
function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const SCENARIO_FILTER = argValue("scenario");
const CONCURRENCY = Number(argValue("concurrency") ?? 4);
const LIMIT = Number(argValue("limit") ?? Number.POSITIVE_INFINITY);
/**
 * 语义验收（L2/L3）默认开。关掉的场合：只想快速看结构性断言、或者
 * 判定器本身正在被调试——它每个场景多一次模型调用，跑批会慢一点。
 */
const JUDGE_OFF = process.argv.includes("--judge-off");
/**
 * 默认 judge 的 high 参与总门禁（结构性通过 ≠ 整体通过）。
 * 想让它只旁听、不影响退出码，显式传这个 flag——**不能是默认行为**，
 * 否则又会退回"judge 说了不算、报告却好像判过"的老样子。
 */
const JUDGE_ADVISORY = process.argv.includes("--judge-advisory");
/**
 * 实验 guidance（Golden Trace A/B）。**默认不启用**：不传这个 flag 时
 * `GUIDANCE_TEXT` 是 undefined，`runColivingTurn` 收到的 system 内容与
 * 模块跟生产逐字一致，跑出来就是基线。
 *
 * 只接受已登记的 id（`evals/guidance.ts`）。未知 id、或 `--guidance`
 * 只给 flag 不给值（包括后面紧跟另一个 flag，如 `--guidance --judge-off`，
 * 后者会被当成缺值而非未知 id），都在跑任何场景之前立即报错——不静默退回基线，
 * 否则报告会把"跑错了实验"记成"基线结果"，基线和实验组就混了。
 */
const GUIDANCE_FLAG_PRESENT = process.argv.includes("--guidance");
const GUIDANCE_ID = argValue("guidance");
if (GUIDANCE_FLAG_PRESENT && isMissingGuidanceArg(GUIDANCE_ID)) {
  console.error(
    `--guidance 需要一个已登记的 id；已登记：${knownGuidanceIds().join("、")}`
  );
  process.exit(2);
}
let GUIDANCE_TEXT: string | undefined;
try {
  GUIDANCE_TEXT = resolveGuidanceArg(GUIDANCE_ID);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
/** 写进报告的实验版本标识：没启用是 null（基线）。 */
const GUIDANCE_LABEL = GUIDANCE_ID && GUIDANCE_TEXT ? GUIDANCE_ID.trim() : null;

/**
 * **评测预算闸（仅评测，生产不经过这里）。**
 *
 * `--max-cost-usd <正数>` / `--max-generations <正整数>` 都是可选的；两个都
 * 不传就是原来"不设上限"的完整跑批行为，逐字不变。非法值（0、负数、非数）
 * 立即报错退出，**不静默退回不设限**——那会把"以为有闸"记成"没闸"。
 *
 * `names[0]` 是首选名，其余是**兼容旧名**（`--max-model-calls` 的语义一直
 * 就是 generation 上限，只是名字不准）。同时只接受传其中一个：两个都传且
 * 值不同时报错，不静默取其一。
 *
 * 上限语义见 `lib/chat/coliving/gateway-ledger.ts`：generation 数是硬上限；
 * 金额是软硬混合（按 gateway 实际回报的已知花费判断，达到线后拦下一次）。
 * **两者都只管 generation**——管不住一个 generation 内部的 step 与 transport
 * retry，别当 HTTP 请求级配额看。
 */
function parseOptionalLimit(
  names: readonly [string, ...string[]],
  options: { integer: boolean }
): number | null {
  // 没传任何一个才是"不设限"；传了却缺值/给错值一律报错退出，
  // 不静默当成没传——那会把"以为有闸"记成"没闸"。
  const present = names.filter((n) => process.argv.includes(`--${n}`));
  if (present.length === 0) return null;
  if (present.length > 1) {
    console.error(
      `--${names[0]} 与旧名 ${present
        .slice(1)
        .map((n) => `--${n}`)
        .join("、")} 不能同时传；只传 --${names[0]} 即可`
    );
    process.exit(2);
  }
  const name = present[0];
  const raw = argValue(name);
  const value = Number(raw);
  const valid =
    raw !== null &&
    !raw.startsWith("--") &&
    (options.integer ? Number.isInteger(value) && value > 0 : Number.isFinite(value) && value > 0);
  if (!valid) {
    console.error(
      `--${name} 需要一个${options.integer ? "正整" : "正"}数，实际收到「${raw ?? "（没给值）"}」`
    );
    process.exit(2);
  }
  return value;
}
const MAX_COST_USD = parseOptionalLimit(["max-cost-usd"], { integer: false });
const MAX_MODEL_CALLS = parseOptionalLimit(
  ["max-generations", "max-model-calls"],
  { integer: true }
);

/**
 * **整批共享预算（唯一一份）。** 两个上限的语义是**整次跑批**的总上限，
 * 不是每个场景各一份——所以只在这里建一个 `BatchBudget`，所有场景的本地
 * 台账都指向它。两个 flag 都不传时不建预算：各场景本地台账照记收据，
 * 但谁也不限流，与原来"不设限"的完整跑批行为一致。生产路径不经过这里。
 */
const BATCH_BUDGET =
  MAX_COST_USD !== null || MAX_MODEL_CALLS !== null
    ? new BatchBudget({
        maxCostUsd: MAX_COST_USD,
        maxModelCalls: MAX_MODEL_CALLS,
      })
    : undefined;

// ── 加载 + 校验语料 ──────────────────────────────────────────────────────
const SCENARIOS_DIR = path.join(
  process.cwd(),
  "lib/chat/coliving/evals/scenarios"
);
function loadScenarios(): EvalScenario[] {
  const files = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".json"));
  const scenarios = files.map((f) => {
    const raw = JSON.parse(readFileSync(path.join(SCENARIOS_DIR, f), "utf8"));
    return validateScenario(raw, f);
  });
  const filtered = SCENARIO_FILTER
    ? scenarios.filter((s) => s.id === SCENARIO_FILTER)
    : scenarios;
  return filtered.slice(0, LIMIT);
}

// ── 简单的并发限制（不引入 p-limit 依赖，量级不需要） ───────────────────
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}

// ── 单个场景的结果 ───────────────────────────────────────────────────────
/**
 * 一轮的完整记录。**每一轮都存，不只是最后一轮**——报告页要按聊天记录
 * 的形式给人看（`scripts/coliving-report.ts`），语义验收器也要读完整
 * 上下文才能判"这句话是不是泄漏了上一轮才说的事"。
 */
type TurnRecord = {
  fromName: string;
  fromRole: string;
  said: string;
  reply: string;
  replyReview: ReplyReview;
  toolsUsed: string[];
  scheduleFacts: string[];
  outbound: Array<{
    toName: string;
    text: string;
    blocked: boolean;
    blockReason?: string;
  }>;
};

type ScenarioResult = {
  id: string;
  source: string;
  /**
   * 本次跑批用的实验 guidance id（`--guidance <id>`），没启用记 null。
   * **基线和实验组靠这个字段区分**——否则两份报告长得一样，无法归因。
   */
  guidance: string | null;
  pass: boolean;
  failures: string[];
  /** 完整文字稿，给报告页和语义验收用 */
  turns: TurnRecord[];
  /**
   * 大模型语义验收（L2/L3）。**永远有值，不再是可选的**——`--judge-off`
   * 或判定器挂了，`verified` 是 false，`pass` 恒为 false，调用方必须显式
   * 处理"没验收"这个状态，不能因为字段不存在就悄悄当没发生过、算作通过。
   */
  judge: JudgeResult;
  /** 最终回复最后一次核对的结论——见 lib/chat/coliving/turn.ts 的 ReplyReview */
  replyReview: ReplyReview;
  lastReply: string;
  toolsUsed: string[];
  outboundTexts: string[];
  /**
   * **本场景这一次的真实 Gateway 计费台账**（本地收据：本场调用数、
   * stage/model 分解）。`--max-cost-usd` / `--max-model-calls` 启用与否
   * 都记；生产路径没有台账。
   */
  cost: LedgerSnapshot;
  /**
   * **整批共享预算快照**：全局调用数、已知花费、未知花费调用数、是否因
   * 触限停止及停止原因。限额来自 CLI，是整次跑批的总上限（见
   * `BATCH_BUDGET`）。由 `main()` 在所有场景跑完后统一填入，没设预算时
   * 是 null。各场景的本地账在 `cost`，这里放的是**共享**那一份。
   */
  budget?: LedgerSnapshot | null;
  ms: number;
};

async function runScenario(
  scenario: EvalScenario,
  ledger: GatewayCostLedger
): Promise<ScenarioResult> {
  const start = Date.now();
  const repo = await import("../lib/chat/coliving/repo");
  const turn = await import("../lib/chat/coliving/turn");

  let householdId: string;
  /** 快照场景专用：槽位号 → 本次恢复实际可用的号 */
  let phoneRewrite: Record<string, string> = {};
  if (scenario.snapshot) {
    // ── 快照重放：状态是冻住恢复出来的，不重演历史轮次 ──────────────
    const { restoreSnapshot } = await import(
      "../lib/chat/coliving/evals/snapshot"
    );
    const snapPath = path.join(
      process.cwd(),
      "lib/chat/coliving/evals/snapshots",
      `${scenario.snapshot}.json`
    );
    const snap = JSON.parse(readFileSync(snapPath, "utf8"));
    const restored = await restoreSnapshot(snap);
    householdId = restored.householdId;
    // 场景里写的是**槽位号**（稳定、可提交进 git），实际发消息要用这次
    // 恢复现生成的号——不换就会认成陌生号码，走完全不同的路径，
    // 静默测了个寂寞。写错号直接报错，不静默跳过。
    phoneRewrite = restored.phoneMap;
    for (const [i, t] of scenario.turns.entries()) {
      if (!phoneRewrite[t.from]) {
        throw new Error(
          `场景 ${scenario.id} 的 turns[${i}].from（${t.from}）不是快照 ` +
            `${scenario.snapshot} 里的槽位号。可用槽位号：${Object.keys(phoneRewrite).join("、")}`
        );
      }
    }
  } else {
    const created = await repo.createTestHousehold(
      `evals-${scenario.id}-${Date.now()}`
    );
    householdId = created.householdId;
    // 场景里写的号码是**槽位号**，每次跑换成本次独有的真号——
    // 写死号码反复跑批会让同一个号挂上多栋屋子，`resolveSender` 的
    // `limit 1` 就会任意认进旧屋子，测的是被上次污染过的状态。
    // 详见 evals/phones.ts 开头那次真实事故。
    const { makeLivePhones, collectSlotPhones } = await import(
      "../lib/chat/coliving/evals/phones"
    );
    phoneRewrite = makeLivePhones(
      collectSlotPhones({ people: scenario.people, turns: scenario.turns })
    );
    for (const p of scenario.people ?? []) {
      await repo.addResident({
        householdId,
        phone: phoneRewrite[p.phone] ?? p.phone,
        name: p.name,
        role: p.role,
        note: null,
      });
    }
    await repo.setDeclaredSize(householdId, (scenario.people ?? []).length);
  }

  // 正文里的号码也要换：`addresident-greeting` 那条场景把号码写在消息里
  // （"一个电话是 155…"），只换 from 不换正文，模型会去加一个上次跑批
  // 留下的旧号，等于没测到"加人"这个动作
  const { rewritePhonesInText } = await import(
    "../lib/chat/coliving/evals/phones"
  );
  // 名字/角色查一次就够，用来把 person_id 翻译成人能读的名字
  const members = await repo.getMembers(householdId);
  const nameOf = (personId: string) =>
    members.find((m) => m.personId === personId)?.name ?? "（未知）";
  const roleOf = (phone: string) =>
    members.find((m) => m.address === phone)?.role ?? "tenant";

  for (const name of scenario.setup?.confirmedNames ?? []) {
    const person = members.find((m) => m.name === name);
    if (!person) {
      throw new Error(`场景 ${scenario.id} 找不到要确认姓名的成员「${name}」`);
    }
    await repo.renamePerson({ personId: person.personId, name, confirmed: true });
    person.nameConfirmed = true;
  }

  // 需要精确复现“某个结构化状态后的下一轮”时，直接预置测试状态，
  // 不让额外一轮模型输出把前提改写掉；所有写入仍只发生在本次测试屋。
  for (const openCase of scenario.setup?.openCases ?? []) {
    const caseId = await repo.openCase({
      householdId,
      kind: openCase.kind,
      title: openCase.title,
      severity: openCase.severity ?? null,
    });
    for (const position of openCase.positions ?? []) {
      const person = members.find((m) => m.name === position.person);
      if (!person) {
        throw new Error(
          `场景 ${scenario.id} 预置表态找不到成员「${position.person}」`
        );
      }
      await repo.recordCasePosition({
        caseId,
        householdId,
        personId: person.personId,
        kind: position.kind,
        statement: position.statement,
      });
    }
  }
  for (const message of scenario.setup?.priorMessages ?? []) {
    const person = members.find((m) => m.name === message.person);
    if (!person) {
      throw new Error(
        `场景 ${scenario.id} 预置历史找不到成员「${message.person}」`
      );
    }
    const conversationId = await repo.getOrCreateConversation({
      personId: person.personId,
      householdId,
      channel: "sms",
    });
    await repo.appendMessage({
      conversationId,
      personId: person.personId,
      direction: message.direction,
      channel: "sms",
      body: message.body,
    });
  }

  let last: Awaited<ReturnType<typeof turn.runColivingTurn>> | null = null;
  const transcript: TurnRecord[] = [];
  /**
   * 预算在某一轮中途触限 → 记下原因、跳出循环。**不丢已经跑完的轮次和
   * 已经花掉的钱**：下面据此返回一份带 `cost` 的失败结果，报告照写。
   */
  let loopBudgetStop: string | null = null;
  for (const [i, t] of scenario.turns.entries()) {
    const livePhone = phoneRewrite[t.from] ?? t.from;
    const said = rewritePhonesInText(t.text, phoneRewrite);
    // guidance 只有显式 `--guidance <id>` 时才有值；不传就是基线，
    // 生成器看到的 system 与生产逐字一致（见 turn.ts 里共用的
    // buildGeneratorSystemMessages：无 guidance 时严格 doctrine → runtime）。
    try {
      // 每轮单独打 turnIndex 标签：这一轮里所有 generation（主生成、
      // 强制发信、重写、事实复核、最终修正、工具里的 embedding）都继承
      // 它；run/scenario 标签由外层继承。turn 边界只在这一次调用内生效，
      // 出了这个 run 就回到 scenario 级，判定器（judge）不会被误标成某轮。
      last = await runWithLedgerLabels({ turnIndex: i }, () =>
        turn.runColivingTurn({
          from: livePhone,
          text: said,
          guidance: GUIDANCE_TEXT,
        })
      );
    } catch (error) {
      if (isEvalBudgetExceeded(error)) {
        loopBudgetStop = error.message;
        console.log(`[budget] ${scenario.id} 预算停止：${error.message}`);
        break;
      }
      throw error;
    }
    transcript.push({
      fromName:
        members.find((m) => m.address === livePhone)?.name ?? livePhone,
      fromRole: roleOf(livePhone),
      said,
      reply: last.reply,
      replyReview: last.replyReview,
      toolsUsed: last.toolsUsed,
      scheduleFacts: last.scheduleFacts,
      // 用 allOutbound 而不是 outbound：被审稿拦下的那些也要进文字稿，
      // 它们是复核时最该看的部分（"这条为什么没发出去"）
      outbound: last.allOutbound.map((o) => ({
        toName: nameOf(o.personId),
        text: o.text,
        blocked: Boolean(o.blocked),
        blockReason: o.blockReason,
      })),
    });
    // 隔离评测不调用 Twilio，但下一轮必须看到与生产一致的“已经发出、
    // 正在等回复”状态。否则 buildContext 的阻塞清单为空，模型会把上一轮
    // 已问过的问题再问一遍，测出来的是评测器失真，不是产品行为。
    for (const message of last.outbound) {
      await repo.markCommunication({
        communicationId: message.communicationId,
        status: "sent",
      });
    }
    if (last.replyCommunicationId) {
      await repo.markCommunication({
        communicationId: last.replyCommunicationId,
        status: "sent",
      });
    }
  }
  /**
   * 预算在轮次中途停下：不做期望值/语义验收（这一轮根本没跑完，拿残缺
   * 文字稿去判只会产生噪音），直接返回带台账的失败结果。已跑完的轮次、
   * 已花的钱都在里面，报告不丢。
   */
  if (loopBudgetStop) {
    const lastTurn = transcript.at(-1);
    return {
      id: scenario.id,
      source: scenario.source,
      guidance: GUIDANCE_LABEL,
      pass: false,
      failures: [`评测预算停止：${loopBudgetStop}`],
      turns: transcript,
      judge: { pass: false, verified: false, findings: [] },
      replyReview: {
        mode: "generation-only",
        verified: false,
        pass: false,
        broke: "",
        why: `评测预算停止：${loopBudgetStop}`,
      },
      lastReply: lastTurn?.reply ?? "",
      toolsUsed: lastTurn?.toolsUsed ?? [],
      outboundTexts: lastTurn?.outbound.map((o) => o.text) ?? [],
      cost: ledger.snapshot(),
      ms: Date.now() - start,
    };
  }
  if (!last) {
    throw new Error(`场景 ${scenario.id} 没有任何 turns`);
  }

  const failures: string[] = [];
  const exp = scenario.expect ?? {};
  const toolsUsed = last.toolsUsed;
  const outboundTexts = last.outbound.map((o) => o.text);

  // 场景级 expect 照旧只查最后一轮；逐轮 expect 只在该轮自己声明时生效。
  // 两边共用同一个纯函数，不另写一份判法。
  const outcomes: TurnOutcome[] = transcript.map((t) => ({
    toolsUsed: t.toolsUsed,
    reply: t.reply,
    outbound: t.outbound,
  }));
  failures.push(
    ...evaluateTurnExpectation(scenario.expect, outcomes[outcomes.length - 1])
  );
  for (const [i, t] of scenario.turns.entries()) {
    if (!t.expect) continue;
    failures.push(
      ...evaluateTurnExpectation(t.expect, outcomes[i]).map(
        (failure) => `第${i + 1}轮：${failure}`
      )
    );
  }
  /**
   * **代码可证的确定性核对命中时，最终回复照样发了——这个门禁堵这个漏洞。**
   * `runColivingTurn` 已经把确定性核对的真实结论算成了 `replyReview`；这里
   * 不重新判断，只核对这个结论本身站不站得住。生产是只生成（`verified:false`
   * 属设计如此，不再算失败）；只有 `pass:false`（确定性核对不合格）计入结构性
   * 失败，让"核对命中红灯但总门禁绿色"不再可能发生。
   */
  failures.push(...evaluateTurnReplyReviews(transcript.map((turn) => turn.replyReview)));

  if (exp.minBlockedComms !== undefined) {
    const blockedAfter = await repo.getBlockedComms(householdId);
    if (blockedAfter.length < exp.minBlockedComms) {
      failures.push(
        `阻塞清单应该至少有 ${exp.minBlockedComms} 条，实际 ${blockedAfter.length} 条`
      );
    }
  }

  /**
   * **语义验收（L2/L3）：结构性断言抓不到的那一层。**
   *
   * 上面那些断言查的是"工具调没调、正则匹不匹配"——确定性、便宜、可靠，
   * 但看不出"这句话虽然没违反任何正则，但读起来在拱火"，也看不出
   * "AI 没直接点名，可是透露的信息足以让乙推断出是甲投诉的"。
   * 那类问题只有读懂人话才能发现，所以交给一次独立的模型判定。
   *
   * `pass` 这个字段本身**只反映结构性断言**，judge 的结果单独放在
   * `judge` 字段里——这样报告页才能分别显示"结构性失败"和"语义失败"，
   * 而不是混成一个不知道具体是哪层的红叉。
   *
   * **但总门禁（`main()` 算的退出码）默认把 `judge.pass`（只看 high）
   * 也算进去**——一个场景语义验收报了 high，整批就不该显示"全部通过"。
   * 这一层确实有误报（子代理自己指出过：它看不到 pickSchedule 的候选，
   * "排得不近人情"这类判断最容易误伤，`real-kitchen-incident` 场景
   * 复测时也见过），想让它只旁听、不影响退出码，传 `--judge-advisory`。
   */
  // **`--judge-off` 或判定失败，都是"没验收"，不是"通过"**——直接标成
  // `verified:false, pass:false`，不能让调用方因为拿不到 judge 结果就
  // 默认当没发生过、把总结果算成绿。
  let judge: JudgeResult = { pass: false, verified: false, findings: [] };
  /** 语义验收那一步撞上预算闸时记原因；正常情况是 null。 */
  let judgeBudgetStop: string | null = null;
  if (!JUDGE_OFF) {
    try {
      const { judgeConversation } = await import(
        "../lib/chat/coliving/evals/judge"
      );
      judge = await judgeConversation({
        scenarioId: scenario.id,
        source: scenario.source,
        roster: members.map((m) => ({ name: m.name, role: m.role })),
        turns: transcript.map((t) => ({
          fromName: t.fromName,
          said: t.said,
          reply: t.reply,
          facts: t.scheduleFacts,
          outbound: t.outbound.map((o) => ({
            toName: o.toName,
            text: o.text,
            blocked: o.blocked,
          })),
        })),
      });
    } catch (error) {
      // 预算触限发生在判定这一步：文字稿已经跑完、钱也花在别处了，
      // 不能当成一次普通的"判定器挂了"。记成结构性失败，并把台账一起写进报告。
      if (isEvalBudgetExceeded(error)) {
        judgeBudgetStop = error.message;
        console.log(`[budget] ${scenario.id} 语义验收被预算停止：${error.message}`);
      } else {
        // 判定器挂了不该让整个跑批直接崩溃退出——但这一场景的语义层
        // 确确实实没验收过，`judge` 保持上面初始化的未验收态，不当通过。
        console.log(
          `[judge] ${scenario.id} 判定失败（标记未验收）：`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }
  if (judgeBudgetStop) failures.push(`评测预算停止（语义验收）：${judgeBudgetStop}`);

  return {
    id: scenario.id,
    source: scenario.source,
    guidance: GUIDANCE_LABEL,
    pass: failures.length === 0,
    failures,
    turns: transcript,
    judge,
    replyReview: last.replyReview,
    lastReply: last.reply,
    toolsUsed,
    outboundTexts,
    cost: ledger.snapshot(),
    ms: Date.now() - start,
  };
}

/**
 * 单个场景的基础设施故障也必须落进报告。否则模型网关超时会让整批直接
 * 退出，已经完成的场景和失败原因一起丢失，看起来反而像“没有红灯”。
 */
async function runScenarioSafely(
  scenario: EvalScenario,
  batchBudget?: BatchBudget
): Promise<ScenarioResult> {
  const start = Date.now();
  /**
   * **每个场景一份独立本地台账**，挂在 `runWithEvalLedger` 开的异步上下文里，
   * 各记各的收据（stage/model 分解、本场调用数），互不串场。**上限不在这里**：
   * 本地台账指向整批唯一的 `batchBudget`，由它统一执行全局调用数硬上限和
   * 金额软上限——否则 N 个场景各带一份 CLI 上限，总预算会被放大 N 倍。
   * 没设预算（`batchBudget` 为 undefined）时本地台账自建无上限的内部预算，
   * 行为与原来"不设限"逐字一致。
   */
  const ledger = new GatewayCostLedger({}, batchBudget);
  try {
    // scenario 标签包住整场：这场里每一轮、每一次判定（judge）都继承
    // scenarioId；turnIndex 由 `runScenario` 在轮边界单独打。并发场景
    // 各在自己的异步上下文里，标签不串场。runId 由 `main()` 在整批外层
    // 继承下来（这里不覆盖）。
    return await runWithEvalLedger(ledger, () =>
      runWithLedgerLabels({ scenarioId: scenario.id }, () =>
        runScenario(scenario, ledger)
      )
    );
  } catch (error) {
    const reason = (() => {
      if (error instanceof Error) {
        const own = [error.name, error.message.trim()].filter(Boolean).join(": ");
        const aggregate = error instanceof AggregateError
          ? error.errors
              .map((item) =>
                item instanceof Error
                  ? [item.name, item.message.trim()].filter(Boolean).join(": ")
                  : String(item)
              )
              .filter(Boolean)
              .join(" | ")
          : "";
        const cause = error.cause instanceof Error
          ? [error.cause.name, error.cause.message.trim()].filter(Boolean).join(": ")
          : error.cause
            ? String(error.cause)
            : "";
        return [own, aggregate && `errors=${aggregate}`, cause && `cause=${cause}`]
          .filter(Boolean)
          .join("; ") ||
          "Error（无错误文本）";
      }
      const text = String(error).trim();
      if (text) return text;
      try {
        return JSON.stringify(error) || "未知异常（无错误文本）";
      } catch {
        return "未知异常（无法序列化）";
      }
    })();
    console.log(`[scenario] ${scenario.id} 执行失败（写入红灯报告）：${reason}`);
    return {
      id: scenario.id,
      source: scenario.source,
      guidance: GUIDANCE_LABEL,
      pass: false,
      failures: [`场景执行异常：${reason}`],
      turns: [],
      judge: { pass: false, verified: false, findings: [] },
      replyReview: {
        mode: "generation-only",
        verified: false,
        pass: false,
        broke: "",
        why: `场景执行异常：${reason}`,
      },
      lastReply: "",
      toolsUsed: [],
      outboundTexts: [],
      // 异常也要把已经花的钱带上，不然报告里这场看起来"零成本"，实际不是。
      cost: ledger.snapshot(),
      ms: Date.now() - start,
    };
  }
}

async function main() {
  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    console.log("没有匹配的场景（检查 --scenario 参数或 scenarios/ 目录）");
    process.exit(1);
  }
  console.log(
    `跑 ${scenarios.length} 个场景，并发 ${CONCURRENCY}；` +
      `guidance=${GUIDANCE_LABEL ?? "无（基线）"}${
        GUIDANCE_LABEL ? "（实验组）" : ""
      }；` +
      `预算=${
        MAX_COST_USD === null && MAX_MODEL_CALLS === null
          ? "不设限"
          : `金额上限 ${MAX_COST_USD ?? "无"}、generation 上限 ${MAX_MODEL_CALLS ?? "无"}`
      }…\n`
  );

  /**
   * 整批的 runId：只用来把同一次跑批的 generation 归到一起，**不含任何
   * 住户内容**（就是时间戳）。整批包一层标签上下文，各场景在里面继承；
   * 并发场景仍各在自己的 scenario 上下文里，互不串场。
   */
  const RUN_ID = `run-${new Date().toISOString()}`;
  const start = Date.now();
  const results = await runWithLedgerLabels({ runId: RUN_ID }, () =>
    runWithConcurrency(scenarios, CONCURRENCY, (s) =>
      runScenarioSafely(s, BATCH_BUDGET)
    )
  );
  const totalMs = Date.now() - start;

  /**
   * 所有场景跑完后取**共享预算的最终快照**，贴到每个场景结果上（报告页
   * 只认已知字段，多一个 `budget` 不影响渲染）。这样报告既能看各场景
   * 本地账（`cost`），也能看到整批共享预算的停止原因。
   */
  const budgetSnapshot = BATCH_BUDGET?.snapshot() ?? null;
  for (const r of results) r.budget = budgetSnapshot;

  /**
   * 四种情况分开算，报告和终端输出都要能区分开：
   * - `structFail`：结构性断言失败（`r.pass === false`）。
   * - `judgeHighFail`：语义验收**真的判过**（`verified`）且报了至少一条 high。
   * - `judgeUnverified`：`--judge-off` 或判定器挂了——**没验收过，
   *   不是通过**，跟"判过、没问题"必须分开显示，否则一个真正没做语义
   *   验收的场景会在汇总里显示成"通过"，这正是这次要堵的漏洞。
   * - `overallFail`：总门禁，决定这一行是 ✓ 还是 ✗、决定退出码。
   *   `JUDGE_ADVISORY` 时 judgeHighFail/judgeUnverified 都只旁听，不影响
   *   退出码，但依然打印出来，不能假装没发生。
   */
  let structFailCount = 0;
  let judgeHighFailCount = 0;
  let judgeUnverifiedCount = 0;
  let overallFailCount = 0;
  for (const r of results) {
    const judgeHighFail = r.judge.verified && !r.judge.pass;
    const judgeUnverified = !r.judge.verified;
    const overallFail =
      !r.pass || ((judgeHighFail || judgeUnverified) && !JUDGE_ADVISORY);
    if (!r.pass) structFailCount++;
    if (judgeHighFail) judgeHighFailCount++;
    if (judgeUnverified) judgeUnverifiedCount++;
    if (overallFail) overallFailCount++;

    const tag = overallFail ? "✗" : "✓";
    const judgeNote = judgeUnverified
      ? JUDGE_ADVISORY
        ? "（语义验收未验收，advisory 模式不计入门禁）"
        : "（语义验收未验收）"
      : judgeHighFail
        ? JUDGE_ADVISORY
          ? "（语义验收未通过，advisory 模式不计入门禁）"
          : "（语义验收未通过）"
        : "";
    console.log(`${tag} [${r.id}] ${r.ms}ms${judgeNote}`);
    if (!r.pass) {
      for (const f of r.failures) console.log(`    - 结构性：${f}`);
    }
    if (judgeHighFail) {
      for (const f of r.judge.findings.filter((x) => x.severity !== "low")) {
        console.log(`    - 语义-${f.severity}：${f.issue}（「${f.quote.slice(0, 60)}」）`);
      }
    }
    if (overallFail) {
      console.log(`    最终回复：${r.lastReply}`);
    }
  }
  console.log(
    `\n结构性 ${results.length - structFailCount}/${results.length} 通过；` +
      `语义验收未通过 ${judgeHighFailCount} 个、未验收 ${judgeUnverifiedCount} 个` +
      `${JUDGE_ADVISORY ? "（advisory，不计入门禁）" : ""}；` +
      `总门禁 ${results.length - overallFailCount}/${results.length} 通过，` +
      `总耗时 ${(totalMs / 1000).toFixed(1)}s`
  );

  /**
   * **真实计费汇总。** 金额是 gateway 逐次回报的 `providerMetadata.gateway.
   * cost` 之和，不是按价目表估算——换模型/网关调价都不用改这里。
   * `unknownCostCalls > 0` 表示有调用拿不到 cost（**不是 0 花费**），
   * 这时"已知花费"是下界，别当总额看。
   *
   * 本地账合并相加 = 整批总数（每个场景只记自己的调用，**不重复计费**），
   * 但本地账不带整批上限。所以全局 calls/cost/停止原因以**共享预算快照**
   * 为准（没设预算时退回合并结果，行为与原来一致）；stage/model 分解只有
   * 本地账有，用合并结果。
   */
  const merged = mergeLedgerSnapshots(results.map((r) => r.cost));
  const totals = budgetSnapshot ?? merged;
  const summary = summarizeGenerations(merged.generationRecords);
  const caps =
    totals.maxCostUsd === null && totals.maxModelCalls === null
      ? "不设限"
      : `金额上限 ${totals.maxCostUsd ?? "无"}、generation 上限 ${totals.maxModelCalls ?? "无"}`;
  console.log(
    `\n计费（Gateway 实际回报）：预算 ${caps}；` +
      `generation ${totals.generations} 个（模型生成批次，**不是 HTTP 请求数**）；` +
      `已完成 step ${summary.completedSteps} 个；` +
      `已知花费 ${formatKnownCost(totals.knownCostUsd, totals.unknownCostGenerations > 0)}；` +
      `未知花费 generation ${totals.unknownCostGenerations} 个` +
      `${totals.unknownCostGenerations > 0 ? "（已知金额只是下界）" : ""}` +
      `${totals.stopped ? `；**已因触限停止**（${totals.stopReason ?? ""}）` : ""}`
  );
  console.log(
    `    token：非缓存输入 ${formatTokenTotal(summary.tokens.inputUncachedTokens)}、` +
      `缓存读 ${formatTokenTotal(summary.tokens.cacheReadTokens)}、` +
      `缓存写 ${formatTokenTotal(summary.tokens.cacheWriteTokens)}、` +
      `输出 ${formatTokenTotal(summary.tokens.outputTokens)}、` +
      `推理 ${formatTokenTotal(summary.tokens.reasoningTokens)}`
  );
  // transport 次数本 SDK 不可观测 → 永远 null；这里明确写"不可观测"，
  // 不显示成 0，也不拿 generation 数顶替。
  console.log(
    `    transport attempts：${TRANSPORT_UNOBSERVABLE}——${summary.transportObservability}`
  );
  for (const bucket of [...merged.byStage].sort(
    (a, b) => b.generations - a.generations
  )) {
    console.log(
      `    - stage ${bucket.key}：${bucket.generations} 个 generation，${formatKnownCost(bucket.knownCostUsd, bucket.unknownCostCalls > 0)}` +
        `${bucket.unknownCostCalls ? `，未知 ${bucket.unknownCostCalls} 个` : ""}`
    );
  }
  for (const bucket of [...merged.byModel].sort(
    (a, b) => b.generations - a.generations
  )) {
    console.log(
      `    - model ${bucket.key}：${bucket.generations} 个 generation，${formatKnownCost(bucket.knownCostUsd, bucket.unknownCostCalls > 0)}` +
        `${bucket.unknownCostCalls ? `，未知 ${bucket.unknownCostCalls} 个` : ""}`
    );
  }

  const reportDir = path.join(process.cwd(), "tests/coliving-eval/reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(
    reportDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`报告已写入 ${reportPath}`);

  process.exit(overallFailCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("跑批失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
