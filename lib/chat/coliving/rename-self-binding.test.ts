/**
 * `renamePerson` 的 **`self: true` 认人绑定**——源码哨兵（只读文本，不调模型、
 * 不连库、不发消息）。
 *
 * 运行：`pnpm.cmd exec tsx lib/chat/coliving/rename-self-binding.test.ts`
 *
 * 为什么需要这一条：老板 2026-10-06 要求第一次接触也问「他本人怎么称呼」，
 * 于是**住户自己报的名字**得落到**正在说话的那个人**头上。而 `renamePerson`
 * 本来是按 `currentName` 找人的（`findPersonByName`）——**名字是给人看的一栏，
 * 不是身份**：同名的可以有两个（名册上可以有人顶着生成的占位名），按名字找
 * 就可能把**别人的**名字改掉。所以本人那一次必须按 `sender.personId` 认，
 * `self: true` 不是可选的修饰。
 *
 * 钉住四件事：
 *   ① schema 里真的有 `self`，而且 `currentName` 变成可省（否则带不出 self）；
 *   ② `self` 那一支用 `sender.personId`（并核过 `sender.householdId` 这一栋），
 *      **不**走 `findPersonByName`；
 *   ③ 非 self 的那一支照旧按名字找——老路径没有被删掉；
 *   ④ 第一次接触的准则里说明了**本人报名字要带 `self: true`**。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const src = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

function main() {
  const turnSrc = src("lib/chat/coliving/turn.ts");
  const onboarding = src(
    "lib/ai/brains/coliving/doctrine/domain/onboarding.md"
  );

  const toolAt = turnSrc.indexOf("renamePerson: tool({");
  assert(toolAt > 0, "找不到 renamePerson 工具");
  const toolEnd = turnSrc.indexOf("\n    remember: tool({", toolAt);
  assert(toolEnd > toolAt, "找不到 renamePerson 工具的结尾");
  const tool = turnSrc.slice(toolAt, toolEnd);

  const selfAt = tool.indexOf("if (self) {");
  assert(selfAt > 0, "★ renamePerson 里没有 self 分支——本人报的名字没法绑本人");
  const fallbackAt = tool.indexOf("// 改别人");
  assert(fallbackAt > selfAt, "找不到「改别人」那一支");
  const selfBranch = tool.slice(selfAt, fallbackAt);
  const fallbackBranch = tool.slice(fallbackAt);

  check("schema 里有 self，且 currentName 变成可省", () => {
    const schema = tool.slice(tool.indexOf("inputSchema"), tool.indexOf("execute:"));
    assert(schema.includes("self: z"), "schema 里没有 self");
    const currentNameField = schema.slice(
      schema.indexOf("currentName: z"),
      schema.indexOf("newName: z")
    );
    assert(
      currentNameField.includes(".optional()"),
      "currentName 必须可省——不然 self 那一支还要模型先猜一个占位名"
    );
  });

  check("self 那一支按 sender.personId 认人，不按名字找", () => {
    assert(
      selfBranch.includes("sender.personId"),
      "★ self 那一支必须绑 sender.personId"
    );
    assert(
      !selfBranch.includes("findPersonByName"),
      "★ self 那一支不许再按名字找——重名时那正是改错人的那条路"
    );
    assert(
      selfBranch.includes("sender.householdId"),
      "认人前必须核他确实还在这一栋的活跃名册里"
    );
    assert(
      /personId:\s*me\.personId/.test(selfBranch),
      "写回的名字必须落在认出来的那一个人身上"
    );
    assert(
      !selfBranch.includes("currentName"),
      "self 那一支不该看 currentName（名字不是身份）"
    );
  });

  check("非 self 那一支照旧按名字找（老路径没被删掉）", () => {
    assert(
      fallbackBranch.includes("findPersonByName"),
      "改别人仍然按名字唯一定位"
    );
    assert(
      fallbackBranch.includes("currentName"),
      "改别人仍然要 currentName"
    );
  });

  check("第一次接触的准则里说明了本人报名字要带 self: true", () => {
    assert(
      onboarding.includes("self: true"),
      "★ domain/onboarding.md 里没写 self: true"
    );
    assert(
      onboarding.includes("本人说的"),
      "self: true 的理由（这是本人说的，不是我们编的）必须写在准则里"
    );
  });

  console.log(`\nrename self binding：${passed} 项检查全部通过`);
}

main();
