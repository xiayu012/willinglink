import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { householdFeatureGrantsFile } from "./household-feature-grants";
import {
  SHOWER_DRAIN_HAIR_AFTER_USE_GRANTS_FEATURE_ID,
  SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID,
} from "./shared-rule-definitions";
import { settleSharedRuleGrant } from "./shared-rule-grant-settlement";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-rule-grant-settlement-"));
const T1 = "2026-01-01T00:00:00.000Z";

const lines = (file: string): string[] =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()) : [];

test("非 settled 一律 not-eligible 且不建目录", () => {
  const dir = path.join(tmpDir, "never-created-not-settled");
  const out = settleSharedRuleGrant({
    dir,
    householdId: "house-a",
    projection: { state: "proposed", ruleDefinitionId: SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID },
  });
  assert.deepEqual(out, { status: "not-eligible", reason: "not-settled" });
  assert.equal(fs.existsSync(dir), false);
});

test("settled + null id 一律 not-eligible 且不建目录", () => {
  const dir = path.join(tmpDir, "never-created-null-id");
  const out = settleSharedRuleGrant({
    dir,
    householdId: "house-a",
    projection: { state: "settled", ruleDefinitionId: null },
  });
  assert.deepEqual(out, { status: "not-eligible", reason: "missing-rule-definition-id" });
  assert.equal(fs.existsSync(dir), false);
});

test("settled + 未知 id 一律 not-eligible 且不建目录", () => {
  const dir = path.join(tmpDir, "never-created-unknown-id");
  const out = settleSharedRuleGrant({
    dir,
    householdId: "house-a",
    projection: { state: "settled", ruleDefinitionId: "no-such-rule-def" },
  });
  assert.deepEqual(out, { status: "not-eligible", reason: "unknown-rule-definition" });
  assert.equal(fs.existsSync(dir), false);
});

test("命中定义 id 与请求 id 对不上：not-eligible 且 grant spy 0 次", () => {
  const dir = path.join(tmpDir, "never-created-id-mismatch");
  let grantCalls = 0;
  const out = settleSharedRuleGrant({
    dir,
    householdId: "house-a",
    projection: { state: "settled", ruleDefinitionId: "requested-rule" },
    deps: {
      definitionById: () => ({ id: "different-rule", grantsFeatureId: "fake-feature" }),
      blacklistedById: () => ({ id: "fake-feature" }),
      grant: () => {
        grantCalls += 1;
        throw new Error("grant must not be called");
      },
    },
  });
  assert.deepEqual(out, { status: "not-eligible", reason: "unknown-rule-definition" });
  assert.equal(grantCalls, 0);
  assert.equal(fs.existsSync(dir), false);
});

test("正式规则首次 granted 精确记三字段；重复 already-granted 且只一行", () => {
  const house = "house-granted";
  const file = householdFeatureGrantsFile(tmpDir, house);
  const projection = {
    state: "settled" as const,
    ruleDefinitionId: SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID,
  };

  const first = settleSharedRuleGrant({ dir: tmpDir, householdId: house, projection, grantedAt: T1 });
  assert.equal(first.status, "granted");
  assert.equal(first.status === "granted" && first.grant.householdId, house);
  assert.equal(first.status === "granted" && first.grant.featureId, SHOWER_DRAIN_HAIR_AFTER_USE_GRANTS_FEATURE_ID);
  assert.equal(first.status === "granted" && first.grant.sourceRuleDefinitionId, SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID);
  assert.equal(lines(file).length, 1);

  const dup = settleSharedRuleGrant({ dir: tmpDir, householdId: house, projection, grantedAt: T1 });
  assert.equal(dup.status, "already-granted");
  assert.equal(lines(file).length, 1);
});

test("A 户 grant 在 B 户查询不到，B 户 settle 后独立获得", () => {
  const a = "house-settle-a";
  const b = "house-settle-b";
  const projection = {
    state: "settled" as const,
    ruleDefinitionId: SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID,
  };

  assert.equal(settleSharedRuleGrant({ dir: tmpDir, householdId: a, projection }).status, "granted");
  assert.equal(lines(householdFeatureGrantsFile(tmpDir, b)).length, 0);

  assert.equal(settleSharedRuleGrant({ dir: tmpDir, householdId: b, projection }).status, "granted");
  assert.equal(lines(householdFeatureGrantsFile(tmpDir, b)).length, 1);
});

test("映射不在黑名单：feature-not-blacklisted 且 grant spy 0 次", () => {
  const dir = path.join(tmpDir, "never-created-not-blacklisted");
  let grantCalls = 0;
  const out = settleSharedRuleGrant({
    dir,
    householdId: "house-a",
    projection: { state: "settled", ruleDefinitionId: "fake-rule-def" },
    deps: {
      definitionById: () => ({ id: "fake-rule-def", grantsFeatureId: "fake-feature" }),
      blacklistedById: () => null,
      grant: () => {
        grantCalls += 1;
        throw new Error("grant must not be called");
      },
    },
  });
  assert.deepEqual(out, { status: "not-eligible", reason: "feature-not-blacklisted" });
  assert.equal(grantCalls, 0);
  assert.equal(fs.existsSync(dir), false);
});

test("黑名单 id 对不上：也拒绝且 grant spy 0 次", () => {
  let grantCalls = 0;
  const out = settleSharedRuleGrant({
    dir: tmpDir,
    householdId: "house-a",
    projection: { state: "settled", ruleDefinitionId: "fake-rule-def" },
    deps: {
      definitionById: () => ({ id: "fake-rule-def", grantsFeatureId: "fake-feature" }),
      blacklistedById: () => ({ id: "some-other-feature" }),
      grant: () => {
        grantCalls += 1;
        throw new Error("grant must not be called");
      },
    },
  });
  assert.deepEqual(out, { status: "not-eligible", reason: "feature-not-blacklisted" });
  assert.equal(grantCalls, 0);
});

test("deps.grant 抛出的同一个 Error 原样冒泡", () => {
  const thrown = new Error("disk on fire");
  assert.throws(
    () =>
      settleSharedRuleGrant({
        dir: tmpDir,
        householdId: "house-a",
        projection: { state: "settled", ruleDefinitionId: "fake-rule-def" },
        deps: {
          definitionById: () => ({ id: "fake-rule-def", grantsFeatureId: "fake-feature" }),
          blacklistedById: () => ({ id: "fake-feature" }),
          grant: () => {
            throw thrown;
          },
        },
      }),
    (err) => err === thrown
  );
});

async function main(): Promise<void> {
  let failures = 0;
  try {
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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(`\n${tests.length - failures}/${tests.length} 通过`);
  if (failures > 0) process.exitCode = 1;
}

main();
