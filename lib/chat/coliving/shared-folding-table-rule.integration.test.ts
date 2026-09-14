import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  projectRule,
  stepRule,
  type RuleEvent,
} from "../../coordination/rule-consultation";
import { blacklistedCapabilityById } from "./blacklist";
import {
  activeHouseholdFeatureIds,
  grantHouseholdFeature,
} from "./household-feature-grants";
import { settleSharedRuleGrant } from "./shared-rule-grant-settlement";
import { sharedRuleDefinitionById } from "./shared-rule-definitions";

const corpusPath = new URL(
  "./evals/scenarios/corpus-044-shared-folding-table-rule-2026-09-14.json",
  import.meta.url
);

/** 语料里一条住户口语。 */
interface CorpusTurn {
  /** 发话人的手机号（真实 phone）。 */
  from: string;
  /** 这条口语的自然文本。 */
  text: string;
}

/** 语料里一位住户。 */
interface CorpusPerson {
  phone: string;
  name: string;
}

/** 本测试复用得到的语料结构（只声明用得到的字段）。 */
interface Corpus {
  people: CorpusPerson[];
  turns: CorpusTurn[];
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;

/** 语料里的三位住户 phone，用作共同规则协商的参与全员。 */
const PARTICIPANTS = corpus.people.map((person) => person.phone);

const TEST_RULE_ID = "test-folding-table-after-use-v1";
const TEST_FEATURE_ID =
  "test-ask-named-roommate-fold-and-return-shared-table";

/** 固定中性测试事实：只陈述规则内容，不针对任何住户、不含成品话术。 */
const TEST_RULE_FACT =
  "公共折叠桌用完后需折起并放回阳台门左边，不得摊在过道。";

/**
 * 纯函数，只在测试本地使用：仅当一条口语同时满足这条精确的全屋折叠桌规则时返回 true。
 * 必须同时包含：全屋范围、定规则/规矩/约定框架、折叠桌、谁用完后折起、阳台门左边、不挡过道。
 * 出现“别定/不同意/反对/只是举例/假设/只讨论/先讨论/怎么看”则一律为 false。
 */
function qualifiesProposal(text: string): boolean {
  const hasFullHouseScope = /(大家|咱们|咱|所有人|全屋)/.test(text);
  const hasRuleFraming = /(规矩|规则|约定)/.test(text);
  const hasFoldingTable = /折叠桌/.test(text);
  const hasFoldAfterUse = /(用完.{0,8}折|折起来|折好)/.test(text);
  const hasBalconyDoorLeft = /阳台门左边/.test(text);
  const hasNotBlocking = /过道/.test(text) && /挡/.test(text);
  const hasNegation =
    /(别定|不同意|反对|只是举例|举例|假设|只讨论|先讨论|怎么看)/.test(text);

  return (
    !hasNegation &&
    hasFullHouseScope &&
    hasRuleFraming &&
    hasFoldingTable &&
    hasFoldAfterUse &&
    hasBalconyDoorLeft &&
    hasNotBlocking
  );
}

/**
 * 纯函数，只在测试本地使用：仅当一条口语是在要求提醒某个住户去执行这条精确的折叠桌规则时返回 true。
 * 必须同时包含：点名对象（本语料是阿远）、提醒/请/让、用完后仍未折或未放回的违约事实、
 * 折起/折起来、放回阳台门左边。出现“擦桌面”或“挪餐椅”则一律为 false。
 */
function qualifiesExecution(text: string): boolean {
  const hasNamedTarget = /阿远/.test(text);
  const hasRequest = /(提醒|请|让)/.test(text);
  const hasViolation =
    /(用完[\s\S]{0,20}(没|未|还是|仍然|仍|还)|没折|未折|没放回|未放回)/.test(
      text
    );
  const hasFold = /(折起|折起来)/.test(text);
  const hasReturn = /放回阳台门左边/.test(text);
  const hasOtherChore = /(擦桌面|挪餐椅)/.test(text);

  return (
    !hasOtherChore &&
    hasNamedTarget &&
    hasRequest &&
    hasViolation &&
    hasFold &&
    hasReturn
  );
}

test("corpus-044 恰好包含四条非空 text 的 turn", () => {
  const turns = corpus.turns;

  assert.ok(Array.isArray(turns), "turns 必须是数组");
  assert.equal(turns.length, 4, "turns 必须恰好 4 条");

  for (const [index, turn] of turns.entries()) {
    assert.equal(
      typeof turn.text,
      "string",
      `第 ${index + 1} 条 turn 的 text 必须是字符串`
    );
    assert.ok(
      turn.text.trim().length > 0,
      `第 ${index + 1} 条 turn 的 text 必须非空`
    );
  }
});

test(`qualifiesProposal 只认第 1 轮那条精确的全屋折叠桌规则（${TEST_RULE_ID} / ${TEST_FEATURE_ID}）`, () => {
  const turns = (corpus as { turns?: Array<{ text?: string }> }).turns;
  const firstTurnText = turns?.[0]?.text ?? "";

  assert.equal(
    qualifiesProposal(firstTurnText),
    true,
    "语料第 1 轮应当命中这条精确规则"
  );

  const negativeCases: ReadonlyArray<readonly [string, string]> = [
    [
      "否定",
      "咱们别定规矩了，折叠桌谁用完还是折起来放回阳台门左边别挡过道，大家不用管。",
    ],
    [
      "举例",
      "我只是举例：假设咱们定个规矩，折叠桌谁用完就折起来放回阳台门左边，别挡过道。",
    ],
    [
      "只讨论",
      "咱们先讨论一下折叠桌的规矩吧：谁用完折起来放回阳台门左边别挡过道，大家觉得呢。",
    ],
    [
      "擦桌面",
      "咱们定个规矩吧：谁擦完桌面就把抹布放回阳台门左边，别挡过道。",
    ],
    [
      "挪餐椅",
      "咱们定个规矩吧：谁用完餐椅就挪回阳台门左边，别挡过道。",
    ],
    ["只提折叠桌", "阳台门左边那张折叠桌一直摊在过道挡路。"],
  ];

  for (const [label, text] of negativeCases) {
    assert.equal(qualifiesProposal(text), false, `${label} 必须判为 false`);
  }
});

test("qualifiesExecution 只认第 4 轮那条提醒阿远执行折叠桌规则的请求", () => {
  const turns = (corpus as { turns?: Array<{ text?: string }> }).turns;
  const fourthTurnText = turns?.[3]?.text ?? "";

  assert.equal(
    qualifiesExecution(fourthTurnText),
    true,
    "语料第 4 轮应当命中这条执行提醒"
  );

  const negativeCases: ReadonlyArray<readonly [string, string]> = [
    ["擦桌面", "提醒阿远擦桌面。"],
    ["挪餐椅", "让阿远挪餐椅。"],
    ["只是评价折叠桌", "折叠桌看起来挺方便。"],
    ["只是举例", "只是举例让阿远折桌子。"],
  ];

  for (const [label, text] of negativeCases) {
    assert.equal(qualifiesExecution(text), false, `${label} 必须判为 false`);
  }
});

test("全屋折叠桌规则：逐轮全员同意才定案，定案后只对本户精确开放对应功能", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coliving-shared-rule-"));
  try {
    const sender1 = PARTICIPANTS[0];
    const sender2 = PARTICIPANTS[1];
    const sender3 = PARTICIPANTS[2];
    assert.ok(sender1, "语料必须提供第 1 位住户 phone 作为参与者");
    assert.ok(sender2, "语料必须提供第 2 位住户 phone 作为参与者");
    assert.ok(sender3, "语料必须提供第 3 位住户 phone 作为参与者");

    const houseA = "house-a";
    const houseB = "house-b";

    // 测试注入的登记册 / 黑名单：只精确认这两个测试 id，绝不落到生产表。
    const testDeps = {
      definitionById: (id: string) =>
        id === TEST_RULE_ID
          ? { id: TEST_RULE_ID, grantsFeatureId: TEST_FEATURE_ID }
          : null,
      blacklistedById: (id: string) =>
        id === TEST_FEATURE_ID ? { id: TEST_FEATURE_ID } : null,
      grant: grantHouseholdFeature,
    };

    // 每轮新 events 必须累加进同一条日志。
    let events: RuleEvent[] = [];

    // ── turn1：sender1 提出这条精确规则 ──────────────────────────────
    const turn1Text = corpus.turns[0]?.text ?? "";
    assert.equal(qualifiesProposal(turn1Text), true, "turn1 必须命中提案");

    const step1 = stepRule(
      [],
      { type: "propose_rule", rule: TEST_RULE_FACT, ruleDefinitionId: TEST_RULE_ID },
      { participants: PARTICIPANTS, sender: sender1 }
    );
    events = [...events, ...step1.events];

    const projection1 = projectRule(events, {
      participants: PARTICIPANTS,
      sender: sender1,
    });
    assert.equal(projection1.settled, false, "仅 1/3 同意时不得定案");
    assert.notEqual(projection1.state, "settled");

    const settle1 = settleSharedRuleGrant({
      dir,
      householdId: houseA,
      projection: projection1,
      deps: testDeps,
    });
    assert.deepEqual(
      settle1,
      { status: "not-eligible", reason: "not-settled" },
      "未定案的投影不得放行"
    );
    assert.deepEqual(activeHouseholdFeatureIds(dir, houseA), [], "未定案不得有授权");
    assert.deepEqual(readdirSync(dir), [], "未定案不得创建任何授权文件");

    // ── turn2：sender2 同意，仍缺 sender3 ───────────────────────────
    const step2 = stepRule(
      events,
      { type: "state_position", position: "agree" },
      { participants: PARTICIPANTS, sender: sender2 }
    );
    events = [...events, ...step2.events];

    const projection2 = projectRule(events, {
      participants: PARTICIPANTS,
      sender: sender2,
    });
    assert.equal(projection2.settled, false, "2/3 同意时不得定案");
    assert.deepEqual(
      settleSharedRuleGrant({
        dir,
        householdId: houseA,
        projection: projection2,
        deps: testDeps,
      }),
      { status: "not-eligible", reason: "not-settled" }
    );
    assert.deepEqual(activeHouseholdFeatureIds(dir, houseA), [], "仍未定案：无授权");
    assert.deepEqual(readdirSync(dir), [], "仍未定案：不建授权文件");

    // ── turn3：sender3 同意 → 全员同意、定案 ────────────────────────
    const step3 = stepRule(
      events,
      { type: "state_position", position: "agree" },
      { participants: PARTICIPANTS, sender: sender3 }
    );
    events = [...events, ...step3.events];

    const projection3 = projectRule(events, {
      participants: PARTICIPANTS,
      sender: sender3,
    });
    assert.equal(projection3.settled, true, "全员同意必须定案");
    assert.equal(projection3.state, "settled");
    assert.equal(projection3.ruleDefinitionId, TEST_RULE_ID, "投影必须带精确 id");
    assert.equal(projection3.rule, TEST_RULE_FACT, "规则事实必须是提交的那句");

    const settle3 = settleSharedRuleGrant({
      dir,
      householdId: houseA,
      projection: projection3,
      deps: testDeps,
    });
    assert.equal(settle3.status, "granted", "定案 + 精确 id 链必须放行");

    const settle3Repeat = settleSharedRuleGrant({
      dir,
      householdId: houseA,
      projection: projection3,
      deps: testDeps,
    });
    assert.equal(settle3Repeat.status, "already-granted", "重复收口不得新增授权");

    assert.deepEqual(
      activeHouseholdFeatureIds(dir, houseA),
      [TEST_FEATURE_ID],
      "houseA 恰好开放这一个精确功能 id"
    );

    // ── houseB 未定案：active IDs 为空 ─────────────────────────────
    assert.deepEqual(activeHouseholdFeatureIds(dir, houseB), [], "houseB 不得被授权");

    // ── turn4：执行提醒成立，且只有 houseA 含精确功能 id ───────────
    const turn4Text = corpus.turns[3]?.text ?? "";
    assert.equal(qualifiesExecution(turn4Text), true, "turn4 必须命中执行提醒");
    assert.equal(
      activeHouseholdFeatureIds(dir, houseA).includes(TEST_FEATURE_ID),
      true,
      "只有 houseA 的 active ids 含这条精确 feature id"
    );
    assert.equal(
      activeHouseholdFeatureIds(dir, houseB).includes(TEST_FEATURE_ID),
      false,
      "houseB 不含这条精确 feature id"
    );

    // 相邻行为（擦桌面 / 挪餐椅）不得被误判为执行提醒。
    assert.equal(qualifiesExecution("提醒阿远擦桌面。"), false);
    assert.equal(qualifiesExecution("让阿远挪餐椅。"), false);

    // ── 生产表里没有这些测试 id（本用例纯靠注入，不污染生产） ──────
    assert.equal(sharedRuleDefinitionById(TEST_RULE_ID), null);
    assert.equal(blacklistedCapabilityById(TEST_FEATURE_ID), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
