/**
 * rule-consultation.ts（共同规则协商状态机）纯函数单测。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination/rule-consultation.test.ts`
 *
 * 不调 LLM、不落库、不读环境变量：只喂事件 / 意图，断言状态机的不变量。
 *
 * 覆盖（对应任务要求的状态机保证）：
 * - 提出 → 向尚未表态的人逐个征询；发起人视为同意、不重复征询；
 * - 未全员同意前**绝不**定案；
 * - 同意过的人不被重复征询（ask_status 只补没问过的人）；
 * - 有人不同意 → 永不定案（objected），后续同意也不翻转；
 * - 全员同意 → 定案 + 向全员宣布，每人不重复宣布；定案后是终态；
 * - 投影里**没有发起人身份**（来源隐私）；
 * - checkRuleInvariants 对机器产出的日志通过，对「少一人同意就定案」的手工日志报错。
 */

import assert from "node:assert/strict";
import {
  checkRuleInvariants,
  foldRule,
  projectRule,
  receiptEventFor,
  reduceRule,
  stepRule,
} from "./rule-consultation";
import type { RuleEvent, RuleIntent } from "./rule-consultation";
import type { PersonId } from "./types";

/* ------------------------------------------------------------------ *
 * 极简测试骨架（避免引入任何框架，`tsx 文件` 直接跑）
 * ------------------------------------------------------------------ */

interface TestCase {
  name: string;
  fn: () => void;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

const A: PersonId = "阿菲";
const B: PersonId = "小周";
const C: PersonId = "阿凯";
const PARTICIPANTS = [A, B, C];

const RULE = "每个人洗完澡后把地漏里的头发清掉";
const propose = (rule = RULE): RuleIntent => ({ type: "propose_rule", rule });
const agree = (): RuleIntent => ({ type: "state_position", position: "agree" });
const disagree = (): RuleIntent => ({ type: "state_position", position: "disagree" });
const askStatus = (): RuleIntent => ({ type: "ask_status" });

function step(
  events: readonly RuleEvent[],
  intent: RuleIntent,
  sender: PersonId,
  participants: readonly PersonId[] = PARTICIPANTS
): { events: RuleEvent[]; actions: ReturnType<typeof stepRule>["actions"] } {
  return stepRule(events, intent, { participants, sender });
}

/**
 * 模拟「动作都成功送达」：把每个出站动作的成功回执事件追加进日志。真机上回执只有在
 * 短信 / 本人回复确实落账后才写（见 session 的 `deliverRuleActions`）；纯函数单测在这里
 * 用一个等价的「全部送达」假设，好让后续步骤看到与线上一致的日志形状。
 */
function withReceipts(
  events: RuleEvent[],
  actions: ReturnType<typeof stepRule>["actions"]
): RuleEvent[] {
  const extra: RuleEvent[] = [];
  for (const a of actions) {
    const ev = receiptEventFor(a);
    if (ev) extra.push(ev);
  }
  return [...events, ...extra];
}

/** 把一组 step 串起来跑（每步应用上一步产出的事实事件 + 送达回执）。 */
function run(steps: Array<{ intent: RuleIntent; sender: PersonId }>): RuleEvent[] {
  let events: RuleEvent[] = [];
  for (const s of steps) {
    const r = step(events, s.intent, s.sender);
    events = withReceipts([...events, ...r.events], r.actions);
  }
  return events;
}

test("提出：只向尚未表态的其他人征询；发起人视为同意、不被征询", () => {
  const r = step([], propose(), A);
  // 只有「事实」立即产出；consulted 是**送达回执**，不在这一步（等短信真发出去才记）。
  assert.deepEqual(r.events, [{ type: "rule_proposed", rule: RULE, initiator: A }]);
  assert.deepEqual(r.actions, [
    { type: "consult", person: B },
    { type: "consult", person: C },
  ]);
  const snap = foldRule(r.events);
  assert.equal(snap.positions.get(A), "agree", "发起人提出即视为同意");
  assert.equal(snap.consulted.has(A), false, "发起人不被假记征询（他本来就不该被征询）");
  assert.equal(reduceRule(r.events), "proposed");
});

test("未全员同意前绝不定案；同意过的人不被重复征询", () => {
  const afterPropose = run([{ intent: propose(), sender: A }]);
  assert.equal(reduceRule(afterPropose), "proposed");

  // B 同意：仍不定案（C 还没表态）。
  const b = step(afterPropose, agree(), B);
  assert.deepEqual(b.events, [{ type: "position_recorded", person: B, position: "agree" }]);
  assert.deepEqual(b.actions, [{ type: "none" }]);
  const afterB = [...afterPropose, ...b.events];
  assert.equal(reduceRule(afterB), "proposed", "少一人同意绝不能定案");

  // ask_status：所有人都已征询（A 发起即免问、B/C 提及时已问），不再补问。
  const ask = step(afterB, askStatus(), C);
  assert.deepEqual(ask.events, [], "已征询过的人不得重复征询");
  assert.deepEqual(ask.actions, [{ type: "none" }]);

  // C 同意 → 定案 + 向全员宣布（含发起人），每人不重复。
  const c = step(afterB, agree(), C);
  assert.equal(c.events.filter((e) => e.type === "rule_settled").length, 1);
  assert.deepEqual(
    c.actions,
    [
      { type: "announce", person: A },
      { type: "announce", person: B },
      { type: "announce", person: C },
    ],
    "定案要向全员宣布"
  );
  const afterAll = [...afterB, ...c.events];
  assert.equal(reduceRule(afterAll), "settled");
  assert.deepEqual(checkRuleInvariants(afterAll), []);
});

test("ask_status 只补「还没表态、也还没被征询」的人", () => {
  // 先由 A 提出：facts 一条 rule_proposed；送达回执给出 consulted B、C（假设都发成功）。
  const afterPropose = run([{ intent: propose(), sender: A }]);
  // 手工去掉 C 的 consulted 回执，模拟「给 C 的征询短信没发出去 / 还没问过」。
  const withoutC = afterPropose.filter((e) => !(e.type === "consulted" && e.person === C));
  const ask = step(withoutC, askStatus(), A);
  // 事实层不追加事件；consulted 回执等投递成功后由调用方另记。
  assert.deepEqual(ask.events, []);
  assert.deepEqual(ask.actions, [{ type: "consult", person: C }]);
  // B 已同意 → 不在补问名单。
  const withB = [...withoutC, { type: "position_recorded", person: B, position: "agree" } as RuleEvent];
  const ask2 = step(withB, askStatus(), A);
  assert.deepEqual(ask2.actions, [{ type: "consult", person: C }], "已同意的人不补问");
});

test("有人不同意：绝不定案，之后的同意也不翻转", () => {
  const afterPropose = run([{ intent: propose(), sender: A }]);
  const bNo = step(afterPropose, disagree(), B);
  assert.deepEqual(bNo.events, [{ type: "position_recorded", person: B, position: "disagree" }]);
  assert.deepEqual(bNo.actions, [{ type: "none" }], "有人反对不得定案、不得宣布");
  const afterBNo = [...afterPropose, ...bNo.events];
  assert.equal(reduceRule(afterBNo), "objected");

  // C 同意也救不回来：原规则绝不被强行定案。
  const c = step(afterBNo, agree(), C);
  assert.equal(c.events.some((e) => e.type === "rule_settled"), false);
  assert.deepEqual(c.actions, [{ type: "none" }]);
  const afterAll = [...afterBNo, ...c.events];
  assert.equal(reduceRule(afterAll), "objected");
  assert.deepEqual(checkRuleInvariants(afterAll), [], "反对日志本身不违反不变量");
});

test("重复提出同一条规则 = 该住户明确同意，不重复追加 rule_proposed", () => {
  const afterPropose = run([{ intent: propose(), sender: A }]);
  const again = step(afterPropose, propose(), A);
  assert.deepEqual(again.events, [], "发起人已同意，重复提出不再追加事件");
  const bAgain = step(afterPropose, propose(), B);
  assert.deepEqual(bAgain.events, [
    { type: "position_recorded", person: B, position: "agree" },
  ]);
});

test("重复表态不重复记（首次表态为准）", () => {
  const afterPropose = run([{ intent: propose(), sender: A }]);
  const b1 = step(afterPropose, agree(), B);
  const afterB = [...afterPropose, ...b1.events];
  const b2 = step(afterB, agree(), B);
  assert.deepEqual(b2.events, []);
  const b3 = step(afterB, disagree(), B);
  assert.deepEqual(b3.events, [], "已表过态不得改口覆盖");
});

test("定案是终态：之后任何意图都不再驱动转移", () => {
  const settled = run([
    { intent: propose(), sender: A },
    { intent: agree(), sender: B },
    { intent: agree(), sender: C },
  ]);
  assert.equal(reduceRule(settled), "settled");
  for (const intent of [agree(), disagree(), propose(), askStatus()]) {
    const r = step(settled, intent, A);
    assert.deepEqual(r.events, [], "终态不得再追加事件");
    assert.deepEqual(r.actions, [{ type: "none" }]);
  }
});

test("非参与人的消息一律不驱动转移", () => {
  const outsider: PersonId = "路人";
  const r = step([], propose(), outsider);
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.actions, [{ type: "none" }]);
});

test("投影里没有发起人身份（来源隐私）", () => {
  const events = run([
    { intent: propose(), sender: A },
    { intent: agree(), sender: B },
  ]);
  const proj = projectRule(events, { participants: PARTICIPANTS, sender: B });
  assert.equal(proj.rule, RULE);
  assert.equal(proj.state, "proposed");
  assert.deepEqual(proj.agreed, [A, B]);
  assert.deepEqual(proj.waiting, [C]);
  assert.deepEqual(proj.awaitingReply, [C]);
  assert.deepEqual(proj.notYetAsked, []);
  assert.equal("initiator" in (proj as unknown as Record<string, unknown>), false);
  // 投影里没有任何「谁发起的」标记字段（发起人只是参与者之一，不被打上来源标签）。
  assert.equal(
    JSON.stringify(proj).includes("initiator"),
    false,
    "投影不得带任何来源身份字段"
  );
  // 投影里除「规则文本」外，不出现发起人独有的来源情境。
  assert.equal(proj.rule, RULE, "投影只带规则事实文本，不带来源情境");
  // 出站动作只带「发给谁」，不含规则文本、不含来源。
  const actions = step(events, askStatus(), A).actions;
  assert.equal(JSON.stringify(actions).includes(RULE), false, "动作不带规则文本");
});

test("单成员房子：提出即全员同意、直接定案", () => {
  const solo: PersonId = "独住";
  const r = step([], propose(), solo, [solo]);
  // 事实：提出 + 定案；announced 是送达回执，不在事实里。
  assert.deepEqual(r.events, [
    { type: "rule_proposed", rule: RULE, initiator: solo },
    { type: "rule_settled" },
  ]);
  assert.deepEqual(r.actions, [{ type: "announce", person: solo }]);
  assert.deepEqual(checkRuleInvariants(r.events), []);
  assert.deepEqual(receiptEventFor(r.actions[0]), { type: "announced", person: solo });
});

test("回执映射：consult→consulted、announce→announced、none→null", () => {
  assert.deepEqual(receiptEventFor({ type: "consult", person: B }), {
    type: "consulted",
    person: B,
  });
  assert.deepEqual(receiptEventFor({ type: "announce", person: C }), {
    type: "announced",
    person: C,
  });
  assert.equal(receiptEventFor({ type: "none" }), null);
});

test("征询失败可重试：没送达就不算 consulted", () => {
  // A 提出 → 打算问 B、C；但给 C 的短信没发出去（只给 B 记了送达回执）。
  const proposeResult = step([], propose(), A);
  const events: RuleEvent[] = [...proposeResult.events, { type: "consulted", person: B }];
  assert.equal(reduceRule(events), "proposed");
  // 问进度：C 还没被成功征询 → 重新发 consult C；B 已问过 → 不重复。
  const retry = step(events, askStatus(), A);
  assert.deepEqual(retry.actions, [{ type: "consult", person: C }], "失败的人可重试");
  assert.deepEqual(retry.events, [], "重试只发动作、不产生事实事件");
});

test("宣布失败可重试：没送达就不算 announced", () => {
  // 全员同意的**事实**（含定案）都在；但宣布只成功送达 A、B，C 那条失败。
  const events: RuleEvent[] = [
    { type: "rule_proposed", rule: RULE, initiator: A },
    { type: "consulted", person: B },
    { type: "consulted", person: C },
    { type: "position_recorded", person: B, position: "agree" },
    { type: "position_recorded", person: C, position: "agree" },
    { type: "rule_settled" },
    { type: "announced", person: A },
    { type: "announced", person: B },
  ];
  assert.equal(reduceRule(events), "settled");
  // 问进度：只补发没收到宣布的 C。
  assert.deepEqual(
    step(events, askStatus(), A).actions,
    [{ type: "announce", person: C }],
    "没送达的人可补发"
  );
  // 全部送达后，再问进度无动作。
  const done = [...events, { type: "announced", person: C } as RuleEvent];
  assert.deepEqual(step(done, askStatus(), A).actions, [{ type: "none" }]);
});

test("checkRuleInvariants：机器产出的日志通过；少一人同意就定案的手工日志报错", () => {
  const good = run([
    { intent: propose(), sender: A },
    { intent: agree(), sender: B },
    { intent: agree(), sender: C },
  ]);
  assert.deepEqual(checkRuleInvariants(good), []);

  // 手工构造：C 还没同意就出现 rule_settled（有人把状态机写坏 / 手工改日志）。
  const bad: RuleEvent[] = [
    { type: "rule_proposed", rule: RULE, initiator: A },
    { type: "consulted", person: B },
    { type: "consulted", person: C },
    { type: "position_recorded", person: B, position: "agree" },
    { type: "rule_settled" },
  ];
  const violations = checkRuleInvariants(bad);
  assert.ok(
    violations.some((v) => v.includes(C) && v.includes("没有明确同意")),
    `少一人同意就定案必须报错：${violations.join(" | ")}`
  );

  // 已表态者被重复征询也要报错。
  const reConsult: RuleEvent[] = [
    { type: "rule_proposed", rule: RULE, initiator: A },
    { type: "position_recorded", person: B, position: "agree" },
    { type: "consulted", person: B },
  ];
  assert.ok(
    checkRuleInvariants(reConsult).some((v) => v.includes(B) && v.includes("重复征询")),
    "同意过的人被重复征询必须报错"
  );

  // 有反对却定案：报错。
  const objectThenSettle: RuleEvent[] = [
    { type: "rule_proposed", rule: RULE, initiator: A },
    { type: "position_recorded", person: B, position: "disagree" },
    { type: "position_recorded", person: C, position: "agree" },
    { type: "rule_settled" },
  ];
  assert.ok(
    checkRuleInvariants(objectThenSettle).some((v) => v.includes(B)),
    "有人反对却定案必须报错"
  );
});

/* ------------------------------------------------------------------ *
 * 汇总输出
 * ------------------------------------------------------------------ */

function main(): void {
  let failures = 0;
  for (const t of tests) {
    try {
      t.fn();
      console.log(`PASS  ${t.name}`);
    } catch (err) {
      failures += 1;
      console.log(`FAIL  ${t.name}`);
      console.log(`      ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} 通过`);
  if (failures > 0) process.exitCode = 1;
}

main();
