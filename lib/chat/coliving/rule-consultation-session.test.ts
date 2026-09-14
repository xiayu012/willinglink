/**
 * rule-consultation-session.ts（共同规则协商的可测试运行路径）纯 Node 单测。
 *
 * 运行：`pnpm.cmd exec tsx lib/chat/coliving/rule-consultation-session.test.ts`
 *
 * 不调 LLM、不连 DB、不发送：只用 node 临时目录 + `node:assert`，推进事件日志并断言
 * 状态机不变量、「共同规则 vs 单方面整改」的区分，以及**事实事件 vs 送达回执**的拆分。
 *
 * 覆盖（对应任务要求）：
 * - 三位住户多轮：发起人提出 → 另外两人分别明确同意 → 观察规则定案 + 向全员宣布；
 * - 同意过的人不被重复征询；未全员同意前绝不定案；
 * - 「单方面要求阿川清理地漏头发」**不会**进入共同规则状态机（仍走原黑名单路径）；
 * - 相邻卫生话题（墙面头发 / 地漏疏通 / 一般打扫 / 异味 / 抱怨）也都不进入；
 * - 投影里没有发起人身份；
 * - **失败注入**：征询短信发失败不得记成 `consulted`、宣布短信发失败不得记成 `announced`，
 *   且失败者会在之后问进度时被重新征询 / 补发（可重试）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  advanceRuleConsultationSession,
  deliverRuleActions,
  parseOpenRuleSessionIntent,
  recognizeSharedShowerDrainHairRule,
  resolveRuleActionRecipients,
  ruleSessionEventsFile,
  SHARED_SHOWER_DRAIN_HAIR_RULE_FACT,
} from "./rule-consultation-session";
import { projectRule } from "../../coordination/rule-consultation";
import type { RuleEvent, RuleProjection } from "../../coordination/rule-consultation";
import type { PersonId } from "../../coordination/types";

/* ------------------------------------------------------------------ *
 * 极简测试骨架（避免引入任何框架，`tsx 文件` 直接跑；支持 async 用例）
 * ------------------------------------------------------------------ */

interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

const A: PersonId = "阿菲";
const B: PersonId = "小周";
const C: PersonId = "阿凯";
const PARTICIPANTS = [A, B, C];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-consultation-session-"));
const HOUSE = "eval-house-043";
const eventsFile = ruleSessionEventsFile(tmpDir, HOUSE);
const PROPOSAL = "咱们能不能定一个规则，每个人洗完澡后把地漏里的头发清掉。";

/** 读某户的事件日志（不存在返回空数组）。 */
function readEvents(file: string = eventsFile): RuleEvent[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RuleEvent);
}
const countLines = (file: string = eventsFile): number => readEvents(file).length;

function advance(sender: PersonId, text: string, house: string = HOUSE) {
  return advanceRuleConsultationSession(house, sender, text, {
    participants: PARTICIPANTS,
    dir: tmpDir,
  });
}

/** 投递全部动作，`send` 全部成功（模拟正常送达）。 */
function deliverAll(actions: Parameters<typeof deliverRuleActions>[1], house: string = HOUSE) {
  return deliverRuleActions(house, actions, async () => {}, {
    participants: PARTICIPANTS,
    dir: tmpDir,
  });
}

const project = (house: string = HOUSE): RuleProjection =>
  projectRule(readEvents(ruleSessionEventsFile(tmpDir, house)), { participants: PARTICIPANTS });

test("窄识别：只认这条共同规则；单方面点名要求 / 相邻卫生话题都不命中", () => {
  const hit = recognizeSharedShowerDrainHairRule(PROPOSAL);
  assert.equal(hit.ok, true, "共同规则提案必须被识别");
  assert.equal(hit.ok && hit.rule.includes("地漏"), true);
  assert.equal(hit.ok && hit.rule.includes("头发"), true);

  // 单方面点名要求某人清理地漏头发：没有共同范围 / 立规则框架 → **不得**进入本路径。
  for (const single of [
    "请叫阿川把地漏的头发清干净。",
    "阿川最近老把地漏堵住，你让阿川把地漏里的头发弄掉。",
    "叫阿川把地漏里的头发捡走。",
  ]) {
    assert.equal(
      recognizeSharedShowerDrainHairRule(single).ok,
      false,
      `单方面点名要求不得进入共同规则状态机：${single}`
    );
  }

  // 相邻卫生话题 / 征询 / 抱怨：都不命中（不扩大成「卫生一类」）。
  for (const adjacent of [
    "咱们把浴室墙面的头发清掉吧。", // 墙面，没有地漏
    "大家说地漏堵了要疏通，我们定个规则吧。", // 地漏疏通，没有头发
    "咱们定个规则，大家轮流打扫客厅卫生。", // 一般打扫，没有地漏 + 头发
    "大家觉得屋里的味道怎么处理？", // 异味 + 征询
    "每个人洗完澡后地漏里有头发，你怎么看？", // 抱怨 / 问看法，没有清走动作
  ]) {
    assert.equal(
      recognizeSharedShowerDrainHairRule(adjacent).ok,
      false,
      `相邻话题不得进入：${adjacent}`
    );
  }
});

test("三位住户多轮：提出 → 两人分别同意 → 定案 + 向全员宣布", async () => {
  assert.equal(countLines(), 0, "初始没有事件");

  // 第 1 轮：阿菲提出 → 只向小周、阿凯征询；发起人视为同意、不被征询。
  const r1 = advance(A, PROPOSAL);
  assert.ok(r1, "提案必须进入本路径");
  assert.equal(r1.state, "proposed");
  assert.deepEqual(r1.actions, [
    { type: "consult", person: B },
    { type: "consult", person: C },
  ]);
  // 只落了事实：rule_proposed；consulted 是**送达回执**，还没发就没写。
  assert.equal(countLines(), 1, "提出只落事实 rule_proposed");
  assert.equal(
    JSON.stringify(r1.projection).includes("initiator"),
    false,
    "投影不得带任何来源身份字段"
  );

  // 征询短信都发成功 → 才记两条 consulted 回执。
  await deliverAll(r1.actions);
  assert.equal(countLines(), 3, "两条征询成功后才记 consulted 回执");

  // 开着会话，但这句话既不是表态也不是问进度 → 落回普通流程（不劫持）。
  assert.equal(advance(A, "今天晚上吃什么"), null);

  // 第 2 轮：小周明确同意 → 仍不定案（阿凯没表态）。
  const r2 = advance(B, "可以啊");
  assert.ok(r2);
  assert.deepEqual(r2.actions, [{ type: "none" }]);
  assert.equal(r2.state, "proposed", "少一人同意绝不能定案");
  assert.deepEqual(r2.projection.agreed, [A, B]);
  assert.deepEqual(r2.projection.awaitingReply, [C]);

  // 问进度：所有人都已被征询过 → 不重复征询，action 为 none。
  const rAsk = advance(A, "现在怎么样了？");
  assert.ok(rAsk);
  assert.deepEqual(rAsk.actions, [{ type: "none" }], "同意 / 已征询的人不重复征询");

  // 第 3 轮：阿凯明确同意 → 全员同意，定案 + 向全员宣布。
  const r3 = advance(C, "我同意");
  assert.ok(r3);
  assert.equal(r3.state, "settled");
  assert.deepEqual(
    r3.actions,
    [
      { type: "announce", person: A },
      { type: "announce", person: B },
      { type: "announce", person: C },
    ],
    "定案要向全员宣布"
  );

  // 宣布都发成功 → 记 announced 回执，投影里全员已宣布。
  await deliverAll(r3.actions);
  const proj = project();
  assert.deepEqual(proj.disagreed, []);
  assert.deepEqual(proj.announced, [A, B, C]);

  // 定案全部送达后是终态：之后再说话不再进入本路径（交给普通流程）。
  assert.equal(advance(A, "好的"), null);
});

test("有人不同意：原规则绝不定案（另起一栋房子）", () => {
  const house = "eval-house-043-objected";
  const op = (sender: PersonId, text: string) => advance(sender, text, house);
  const p = op(A, PROPOSAL);
  assert.ok(p);
  const no = op(B, "我不同意");
  assert.ok(no);
  assert.equal(no.state, "objected");
  assert.deepEqual(no.actions, [{ type: "none" }], "有人反对不得定案 / 宣布");
  const yes = op(C, "同意");
  assert.ok(yes);
  assert.equal(yes.state, "objected", "有人反对后，其余人同意也不翻转");
  assert.equal(yes.actions.every((a) => a.type !== "announce"), true);
});

test("parseOpenRuleSessionIntent：不同意优先于同意；无规则字眼的长句不当表态", () => {
  assert.deepEqual(parseOpenRuleSessionIntent("我不同意"), {
    type: "state_position",
    position: "disagree",
  });
  assert.deepEqual(parseOpenRuleSessionIntent("同意"), {
    type: "state_position",
    position: "agree",
  });
  assert.deepEqual(parseOpenRuleSessionIntent("都同意了吗？"), { type: "ask_status" });
  assert.deepEqual(
    parseOpenRuleSessionIntent("我不同意这个规则"),
    { type: "state_position", position: "disagree" },
    "「不同意」必须先于「同意」判断"
  );
  assert.equal(
    parseOpenRuleSessionIntent("我今天下班挺晚的还要去买菜"),
    null,
    "无规则字眼的长句不得被当成同意"
  );
});

test("单方面点名要求不会进入状态机：事件日志不增长", () => {
  const house = "eval-house-043-single";
  const file = ruleSessionEventsFile(tmpDir, house);
  const res = advance(A, "请叫阿川把地漏的头发清干净。", house);
  assert.equal(res, null, "单方面整改必须落回原黑名单 / 完整流程，不进共同规则状态机");
  assert.equal(fs.existsSync(file), false, "不得写下任何事件");
});

test("征询失败不记 consulted，且失败者之后问进度会被重新征询（可重试）", async () => {
  const house = "eval-house-043-consult-fail";
  const file = ruleSessionEventsFile(tmpDir, house);
  const op = (sender: PersonId, text: string) => advance(sender, text, house);

  const p = op(A, PROPOSAL);
  assert.ok(p);
  // 给小周发成功、给阿凯发失败（模拟收件人不可达 / 写入被拦）。
  const res = await deliverRuleActions(
    house,
    p.actions,
    async (action) => {
      if (action.type === "consult" && action.person === C) {
        throw new Error("模拟：给阿凯的征询短信发送失败");
      }
    },
    { participants: PARTICIPANTS, dir: tmpDir }
  );
  assert.deepEqual(res.delivered, [{ type: "consult", person: B }]);
  assert.deepEqual(res.failed, [{ type: "consult", person: C }]);

  const consulted = readEvents(file)
    .filter((e) => e.type === "consulted")
    .map((e) => (e as Extract<RuleEvent, { type: "consulted" }>).person);
  assert.deepEqual(consulted, [B], "发送失败的那条**不得**变成 consulted 回执");

  // 失败者留在待办：之后问进度会重新征询阿凯，且不重复问小周。
  const retry = op(A, "都同意了吗");
  assert.ok(retry);
  assert.deepEqual(retry.actions, [{ type: "consult", person: C }], "失败的人可重试");
});

test("宣布失败不记 announced，且失败者之后问进度会被补发（可重试）", async () => {
  const house = "eval-house-043-announce-fail";
  const file = ruleSessionEventsFile(tmpDir, house);
  const op = (sender: PersonId, text: string) => advance(sender, text, house);

  const p = op(A, PROPOSAL);
  assert.ok(p);
  await deliverAll(p.actions, house); // 提出后两条征询都送达
  const b = op(B, "可以");
  assert.ok(b);
  const c = op(C, "我同意");
  assert.ok(c);
  assert.equal(c.state, "settled");

  // 宣布：阿菲、阿凯成功，小周失败。
  const res = await deliverRuleActions(
    house,
    c.actions,
    async (action) => {
      if (action.type === "announce" && action.person === B) {
        throw new Error("模拟：给小周的定案通知发送失败");
      }
    },
    { participants: PARTICIPANTS, dir: tmpDir }
  );
  assert.deepEqual(res.failed, [{ type: "announce", person: B }]);

  const announced = readEvents(file)
    .filter((e) => e.type === "announced")
    .map((e) => (e as Extract<RuleEvent, { type: "announced" }>).person);
  assert.equal(announced.includes(B), false, "发送失败的那条**不得**变成 announced 回执");
  assert.deepEqual([...announced].sort(), [A, C].sort());

  // 失败者留在待办：之后问进度会补发小周，其它人不再重复。
  const retry = op(A, "都同意了吗");
  assert.ok(retry);
  assert.deepEqual(retry.actions, [{ type: "announce", person: B }], "没送达的人可补发");
});

test("同名住户按 personId 区分：仍分别表态、分别收到（不合并 / 不串收）", async () => {
  const house = "eval-house-043-same-name";
  const idA = "person-阿川-A";
  const idB = "person-阿川-B";
  const idC = "person-阿川-C";
  // 三位**显示名完全相同**，只有 personId 不同。
  const roster = [
    { personId: idA, name: "阿川" },
    { personId: idB, name: "阿川" },
    { personId: idC, name: "阿川" },
  ];
  const participants = roster.map((m) => m.personId);
  const op = (sender: PersonId, text: string) =>
    advanceRuleConsultationSession(house, sender, text, { participants, dir: tmpDir });

  const p = op(idA, PROPOSAL);
  assert.ok(p);
  // 按 id 各自被征询——不会因为都叫「阿川」而被合并成一个人。
  assert.deepEqual(p.actions, [
    { type: "consult", person: idB },
    { type: "consult", person: idC },
  ]);
  const r1 = resolveRuleActionRecipients(p.actions, roster);
  assert.deepEqual(r1.map((r) => r.member.personId), [idB, idC], "按 personId 解析收件人");
  assert.equal(new Set(r1.map((r) => r.member.name)).size, 1, "这三位显示名确实相同");

  await deliverRuleActions(house, p.actions, async () => {}, { participants, dir: tmpDir });

  const b = op(idB, "同意");
  assert.ok(b);
  assert.equal(b.state, "proposed");
  assert.deepEqual(b.projection.agreed, [idA, idB], "同名不影响谁已表态（按 id 记）");
  const c = op(idC, "我同意");
  assert.ok(c);
  assert.equal(c.state, "settled");
  assert.deepEqual(c.actions, [
    { type: "announce", person: idA },
    { type: "announce", person: idB },
    { type: "announce", person: idC },
  ]);
  const recipients = resolveRuleActionRecipients(c.actions, roster);
  assert.deepEqual(
    recipients.map((r) => r.member.personId),
    [idA, idB, idC],
    "宣布分别解析到各自的 personId，不串收"
  );
});

test("来源隐私：规则事实是中性固定语义，不带发起人原句的姓名 / 指责 / 理由", () => {
  const accusatory =
    "阿川总不清理地漏的头发，烦死了，所以咱们定个规则，每个人洗完澡后把地漏里的头发清掉。";
  const rec = recognizeSharedShowerDrainHairRule(accusatory);
  assert.equal(rec.ok, true, "共同规则提案仍应被识别");
  assert.equal(rec.ok && rec.rule, SHARED_SHOWER_DRAIN_HAIR_RULE_FACT);
  assert.equal(
    rec.ok && /阿川|烦|总不|不清理/.test(rec.rule),
    false,
    "规则事实不得保留姓名 / 指责 / 私人理由"
  );

  const house = "eval-house-043-privacy";
  const p = advance(A, accusatory, house);
  assert.ok(p);
  assert.equal(
    p.projection.rule,
    SHARED_SHOWER_DRAIN_HAIR_RULE_FACT,
    "存进状态机 / 投影的也是中性事实"
  );
  assert.equal(
    JSON.stringify(p.projection).includes("阿川"),
    false,
    "投影不得泄露住户姓名"
  );
});

test("定案后问进度：仍回当前发言人、零第三方出站，不重复通知也不回落普通流程", async () => {
  const house = "eval-house-043-settled-status";
  const op = (sender: PersonId, text: string) => advance(sender, text, house);

  const p = op(A, PROPOSAL);
  assert.ok(p);
  await deliverAll(p.actions, house);
  const b = op(B, "同意");
  assert.ok(b);
  const c = op(C, "我同意");
  assert.ok(c);
  assert.equal(c.state, "settled");
  await deliverAll(c.actions, house); // A、B、C 的宣布都送达

  // 全都收到了，再问进度：仍由本路径处理（不落回旧主流程），但不再向任何人发通知。
  const ask = op(A, "那咱们现在都同意了吗？");
  assert.ok(ask, "定案后问进度仍由共同规则路径回答（否则会落回旧主流程）");
  assert.deepEqual(ask.actions, [{ type: "none" }], "不应再向任何人重复通知");
  assert.deepEqual(ask.factEvents, [], "问进度不产生新事实事件");

  // 非「问进度」的消息（普通表态 / 闲聊）仍交回普通流程。
  assert.equal(op(A, "好的"), null);
  assert.equal(op(A, "我今天下班挺晚的"), null);
});

/* ------------------------------------------------------------------ *
 * 汇总输出
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  let failures = 0;
  try {
    for (const t of tests) {
      try {
        await t.fn();
        console.log(`PASS  ${t.name}`);
      } catch (err) {
        failures += 1;
        console.log(`FAIL  ${t.name}`);
        console.log(`      ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`\n${tests.length - failures}/${tests.length} 通过`);
  if (failures > 0) process.exitCode = 1;
}

main();
