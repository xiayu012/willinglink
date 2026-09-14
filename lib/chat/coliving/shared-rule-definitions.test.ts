/**
 * shared-rule-definitions.ts（共同规则定义登记册）纯 Node 单测。
 *
 * 运行：`pnpm.cmd exec tsx lib/chat/coliving/shared-rule-definitions.test.ts`
 *
 * 不调 LLM、不连 DB、不发送：只跑登记册的纯函数（`node:assert`，无测试框架）。
 *
 * 覆盖（对应任务要求）：
 * - **命中**：全屋共同规则提案被识别，且只带回登记册固定的 id / 事实 / 功能映射；
 * - **完整复述后否定**：复述里含全部识别信号，但整句是否决 / 劝阻 → 不命中；
 * - **引用 / 假设 / 举例**：复述规则但只是引用、设想或打比方 → 不命中；
 * - **只问看法**：问别人怎么看 / 好不好，未提出建立规则 → 不命中；
 * - **单方面点名**：交办 AI 要求某一位点名室友整改，不是共同规则 → 不命中；
 * - **墙面头发**：有共同范围 + 立规则，但没有地漏 → 不命中；
 * - **地漏疏通**：有地漏、有洗澡，但没有头发 → 不命中；
 * - **带条件不同规则**：同话题但动作不同（提醒 / 商量），不是这条规则 → 不命中；
 * - **来源隐私**：命中结果即使用户原句带姓名 / 指责，也只带固定中性事实。
 */

import assert from "node:assert/strict";
import { blacklistedCapabilityById } from "./blacklist";
import {
  recognizeSharedRuleDefinition,
  sharedRuleDefinitionById,
  SHARED_RULE_DEFINITIONS,
  SHOWER_DRAIN_HAIR_AFTER_USE_CANONICAL_FACT,
  SHOWER_DRAIN_HAIR_AFTER_USE_GRANTS_FEATURE_ID,
  SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID,
} from "./shared-rule-definitions";

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

/** 登记册固定事实（本文件是唯一事实源 `SHARED_SHOWER_DRAIN_HAIR_RULE_FACT`）。 */
const EXPECTED_FACT = "每个人洗完澡后清理地漏里的头发";
/** 登记册映射到的功能 id（blacklist.ts 那条）。 */
const EXPECTED_FEATURE_ID = "ask-named-roommate-clean-shower-drain-hair";

test("登记册：当前正式只登记这一条，且精确映射到黑名单里真实存在的功能 id", () => {
  assert.equal(SHARED_RULE_DEFINITIONS.length, 1, "当前正式定义只有一条");
  const def = SHARED_RULE_DEFINITIONS.find(
    (d) => d.id === SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID
  );
  assert.ok(def, "必须登记 shower-drain-hair-after-use-v1");
  assert.equal(def.id, "shower-drain-hair-after-use-v1");
  assert.equal(def.canonicalFact, SHOWER_DRAIN_HAIR_AFTER_USE_CANONICAL_FACT);
  assert.equal(def.canonicalFact, EXPECTED_FACT);
  assert.equal(def.grantsFeatureId, SHOWER_DRAIN_HAIR_AFTER_USE_GRANTS_FEATURE_ID);
  assert.equal(def.grantsFeatureId, EXPECTED_FEATURE_ID);
  // 映射必须精确落在黑名单里真实存在的那条功能上（放行前会这样核对）。
  assert.ok(
    blacklistedCapabilityById(def.grantsFeatureId),
    "映射的功能 id 必须在黑名单表里存在"
  );
});

test("命中：全屋共同规则提案被识别，只带回登记册固定 id / 事实 / 功能映射", () => {
  for (const text of [
    "咱们能不能定一个规则，每个人洗完澡后把地漏里的头发清掉。",
    "咱们商量好，以后大家洗完澡都把地漏头发清理一下。",
    "定个规矩：每个人淋浴完把地漏里的毛发清干净。",
    // 正常提案即使带「好不好」这类征询语气，只要有明确建立规则动词仍应命中。
    "咱们能不能定个规则，每个人洗完澡后把地漏里的头发清掉，好不好？",
  ]) {
    const def = recognizeSharedRuleDefinition(text);
    assert.ok(def, `共同规则提案必须命中：${text}`);
    assert.equal(def.id, SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID);
    assert.equal(def.canonicalFact, EXPECTED_FACT);
    assert.equal(def.grantsFeatureId, EXPECTED_FEATURE_ID);
  }
});

test("来源隐私：命中只带固定中性事实，不带发起人原句的姓名 / 指责 / 私人理由", () => {
  const accusatory =
    "阿川总不清理地漏的头发，烦死了，咱们定个规则，每个人洗完澡后把地漏里的头发清掉。";
  const def = recognizeSharedRuleDefinition(accusatory);
  assert.ok(def, "含姓名 / 指责的共同规则提案仍应被识别");
  assert.equal(def.canonicalFact, EXPECTED_FACT);
  const serialized = JSON.stringify(def);
  for (const leak of ["阿川", "烦", "总不清理"]) {
    assert.equal(
      serialized.includes(leak),
      false,
      `命中结果不得携带住户原句片段：${leak}`
    );
  }
});

test("单方面点名：交办 AI 要求某一位点名室友整改，不是共同规则 → null", () => {
  for (const text of [
    "请叫阿川把地漏里的头发清干净。",
    "阿川最近老把地漏堵住，你让阿川把地漏里的头发弄掉。",
    "叫阿川把地漏里的头发捡走。",
  ]) {
    assert.equal(
      recognizeSharedRuleDefinition(text),
      null,
      `单方面点名要求不得命中登记册：${text}`
    );
  }
});

test("墙面头发：有共同范围 + 立规则，但没有地漏 → null", () => {
  for (const text of [
    "咱们定个规则，每个人洗完澡后把墙面的头发清掉。",
    "大家约定一下，以后都洗完澡把墙上的头发收拾干净。",
  ]) {
    assert.equal(
      recognizeSharedRuleDefinition(text),
      null,
      `墙面头发不得命中：${text}`
    );
  }
});

test("地漏疏通：有地漏、有洗澡，但没有头发 → null", () => {
  for (const text of [
    "大家定个规矩，洗完澡后地漏堵了要疏通。",
    "咱们定个规则，每个人洗完澡发现地漏下水慢就报修。",
  ]) {
    assert.equal(
      recognizeSharedRuleDefinition(text),
      null,
      `地漏疏通不得命中：${text}`
    );
  }
});

test("带条件的不同规则：同话题但动作不同（提醒 / 商量），不是这条规则 → null", () => {
  for (const text of [
    "咱们定个规则，每个人洗完澡后如果发现地漏里有头发，就提醒下一位洗澡的人。",
    "大家定个规矩，谁洗完澡后地漏有头发，就在群里说一声。",
  ]) {
    assert.equal(
      recognizeSharedRuleDefinition(text),
      null,
      `不同的条件规则不得命中：${text}`
    );
  }
});

test("完整复述后否定：复述里含全部识别信号，但整句是否决 / 劝阻 → null", () => {
  for (const text of [
    "咱们定个规则，每个人洗完澡后清理地漏里的头发，但是我不同意。",
    "我反对，每个人洗完澡后清理地漏里的头发这种事，咱们别定成规则。",
    "大家不要定这种规矩：每个人洗完澡后清理地漏里的头发，太麻烦。",
    "为什么不能定个规则，让每个人洗完澡后清理地漏里的头发？这不公平。",
  ]) {
    assert.equal(
      recognizeSharedRuleDefinition(text),
      null,
      `复述后否定不得命中：${text}`
    );
  }
});

test("引用 / 假设 / 举例：复述规则但只是引用、设想或打比方 → null", () => {
  for (const text of [
    "你刚才说的『咱们定个规则，每个人洗完澡后清理地漏里的头发』是什么意思？",
    "假设咱们定个规则，每个人洗完澡后清理地漏里的头发，会怎么样？",
    "我只是举个例子：咱们定个规则，每个人洗完澡后清理地漏里的头发。",
    "引用一下别人的话——大家定个规矩，每个人洗完澡后清理地漏里的头发。",
  ]) {
    assert.equal(
      recognizeSharedRuleDefinition(text),
      null,
      `引用 / 假设 / 举例不得命中：${text}`
    );
  }
});

test("只问看法但未提出建立规则 → null（没有建立规则动词，就不算提案）", () => {
  for (const text of [
    "大家觉得每个人洗完澡后清理地漏里的头发这事合理吗？",
    "咱们怎么看每个人洗完澡后清理地漏里的头发这件事？",
    "每个人洗完澡后清理地漏里的头发，大家觉得好不好？",
  ]) {
    assert.equal(
      recognizeSharedRuleDefinition(text),
      null,
      `只问看法不得命中：${text}`
    );
  }
});

test("引用 / 否定：引用规则提问、或明确反对，都不是在立规则 → null", () => {
  for (const text of [
    "你说的那条『洗完澡清地漏头发』的规则是什么意思？",
    "咱们之前不是定过每个人洗完澡清地漏头发吗？",
    "我反对，凭什么要求所有人洗完澡后都去清地漏里的头发。",
  ]) {
    assert.equal(
      recognizeSharedRuleDefinition(text),
      null,
      `引用 / 否定不得命中：${text}`
    );
  }
});

test("空串 / 纯空白 → null（不命中任何定义）", () => {
  assert.equal(recognizeSharedRuleDefinition(""), null);
  assert.equal(recognizeSharedRuleDefinition("   \n  "), null);
});

test("按稳定 id 精确取回：完全相等才命中，未知 id → null", () => {
  const def = sharedRuleDefinitionById(SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID);
  assert.ok(def);
  assert.equal(def.id, SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID);
  assert.equal(sharedRuleDefinitionById("shower-drain-hair-after-use-v2"), null);
  assert.equal(
    sharedRuleDefinitionById("ask-named-roommate-clean-shower-drain-hair"),
    null,
    "按定义 id 查表不认功能 id"
  );
  assert.equal(sharedRuleDefinitionById(""), null);
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
