import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activeHouseholdFeatureIds,
  grantHouseholdFeature,
  hasHouseholdFeatureGrant,
  householdFeatureGrantsFile,
} from "./household-feature-grants";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "household-feature-grants-"));
const H = "house-a";
const F = "feature-shared-drain";
const F2 = "feature-shared-kitchen";
const R1 = "rule-def-1";
const R2 = "rule-def-2";
const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";

const grant = (
  householdId: string,
  featureId: string,
  sourceRuleDefinitionId: string,
  grantedAt = T1
): { appended: boolean } =>
  grantHouseholdFeature({ dir: tmpDir, householdId, featureId, sourceRuleDefinitionId, grantedAt });

const lines = (file: string): string[] =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()) : [];

test("首次 grant appended=true；同三元组重复 appended=false 且文件只一行", () => {
  const house = "house-first";
  const file = householdFeatureGrantsFile(tmpDir, house);
  const first = grantHouseholdFeature({
    dir: tmpDir,
    householdId: house,
    featureId: F,
    sourceRuleDefinitionId: R1,
    grantedAt: T1,
  });
  assert.equal(first.appended, true);
  assert.equal(first.grant.householdId, house);
  assert.equal(lines(file).length, 1);
  assert.equal(hasHouseholdFeatureGrant(tmpDir, house, F), true);

  const dup = grant(house, F, R1, T2);
  assert.equal(dup.appended, false);
  assert.equal(lines(file).length, 1);
});

test("同户第二个 feature 独立成行", () => {
  const house = "house-two-features";
  const file = householdFeatureGrantsFile(tmpDir, house);
  assert.equal(grant(house, F, R1).appended, true);
  assert.equal(grant(house, F2, R1, T2).appended, true);
  assert.equal(lines(file).length, 2);
  assert.deepEqual(activeHouseholdFeatureIds(tmpDir, house), [F, F2].sort());
  assert.equal(hasHouseholdFeatureGrant(tmpDir, house, F2), true);
});

test("active ids 去重且顺序确定", () => {
  const house = "house-order";
  grant(house, "zeta", R1);
  grant(house, "alpha", R1);
  grant(house, "zeta", R2); // 同 feature 不同 rule
  assert.deepEqual(activeHouseholdFeatureIds(tmpDir, house), ["alpha", "zeta"]);
  grant(house, "mid", R1);
  assert.deepEqual(activeHouseholdFeatureIds(tmpDir, house), ["alpha", "mid", "zeta"]);
});

test("A 户记录不影响 B 户", () => {
  const a = "house-iso-a";
  const b = "house-iso-b";
  grant(a, F, R1);
  assert.equal(hasHouseholdFeatureGrant(tmpDir, a, F), true);
  assert.equal(hasHouseholdFeatureGrant(tmpDir, b, F), false);
  assert.deepEqual(activeHouseholdFeatureIds(tmpDir, b), []);
});

test("别户合法行 / 坏 JSON / 未知 type / 缺字段手写进 A 文件都不得放行", () => {
  const house = "house-poison";
  const other = "house-poison-other";
  const file = householdFeatureGrantsFile(tmpDir, house);
  fs.writeFileSync(
    file,
    [
      "not-json",
      JSON.stringify({ type: "granted", householdId: other, featureId: F, sourceRuleDefinitionId: R1, grantedAt: T1 }),
      JSON.stringify({ type: "revoked", householdId: house, featureId: F, sourceRuleDefinitionId: R1, revokedAt: T1 }),
      JSON.stringify({ type: "unknown", householdId: house, featureId: F, sourceRuleDefinitionId: R1 }),
      JSON.stringify({ type: "granted", householdId: house, featureId: F, sourceRuleDefinitionId: R1 }),
      JSON.stringify({ type: "granted", householdId: house, featureId: "", sourceRuleDefinitionId: R1, grantedAt: T1 }),
    ].join("\n") + "\n",
    "utf8"
  );
  assert.equal(lines(file).length, 6);
  assert.equal(hasHouseholdFeatureGrant(tmpDir, house, F), false);
  assert.deepEqual(activeHouseholdFeatureIds(tmpDir, house), []);

  // 追加一条真实 grant 后仍能读到，证明前面只是不放行而非文件损坏
  assert.equal(grant(house, F, R1).appended, true);
  assert.deepEqual(activeHouseholdFeatureIds(tmpDir, house), [F]);
});

test("字段非空校验抛 TypeError", () => {
  assert.throws(
    () => grantHouseholdFeature({ dir: "", householdId: H, featureId: F, sourceRuleDefinitionId: R1 }),
    TypeError
  );
  assert.throws(
    () => grantHouseholdFeature({ dir: tmpDir, householdId: " ", featureId: F, sourceRuleDefinitionId: R1 }),
    TypeError
  );
  assert.throws(
    () => grantHouseholdFeature({ dir: tmpDir, householdId: H, featureId: "", sourceRuleDefinitionId: R1 }),
    TypeError
  );
  assert.throws(
    () => grantHouseholdFeature({ dir: tmpDir, householdId: H, featureId: F, sourceRuleDefinitionId: " " }),
    TypeError
  );
  assert.throws(() => hasHouseholdFeatureGrant("", H, F), TypeError);
  assert.throws(() => activeHouseholdFeatureIds(tmpDir, ""), TypeError);
});

test("文件名安全：非法字符不逃逸目录", () => {
  const p = householdFeatureGrantsFile(tmpDir, "../house-a");
  assert.equal(path.dirname(p), tmpDir);
  assert.equal(path.basename(p).includes(".."), false);
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
