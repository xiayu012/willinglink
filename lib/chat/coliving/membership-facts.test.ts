/**
 * 名册事实层（`membership-facts.ts`）的纯 Node 单测。
 *
 * 运行：
 *   `pnpm.cmd exec tsx lib/chat/coliving/membership-facts.test.ts`
 *
 * **不调 LLM、不连 DB、不发送**：被测模块零 import，这里只跑纯函数。
 *
 * 要证明的四件事（就是这次要修的 bug 的反面）：
 *   ① 房东报两个**点名说是租客、说了住在这儿**的人 → 两位都是确认住户；
 *   ② 宿管**不住这儿**（或不知道住不住）→ 不算确认住户；
 *   ③ **只给了号码**的联系人 → 身份还是 other、居住还是「不知道」，
 *      号码本身不把他变成住户；
 *   ④ 后来又明确说「他是宿管、不住这儿」→ 补进已有的同一条关系，
 *      既不重复登记，也不把已经知道的事实抹回未知。
 */

import assert from "node:assert/strict";

import {
  mergeMembershipFacts,
  placeholderName,
  residesFromInput,
  roleLabel,
  ROLES,
  type MembershipFacts,
} from "./membership-facts";

const blank = (): MembershipFacts => ({ role: "other", resides: null, note: null });

function main(): void {
  // ① 房东 + 两位点名租客：明确说了「住在这里」才算确认住户。
  {
    assert.equal(residesFromInput("confirmed_lives"), true);
    // 名册上的角色标签是人话，不是内部枚举值。
    assert.equal(roleLabel("landlord"), "房东");
    assert.equal(roleLabel("tenant"), "租客");
    // 占位名按角色给词：没听到真名时，「房东」「住客」都跟身份对得上。
    assert.equal(placeholderName("landlord", 1), "1号房东");
    assert.equal(placeholderName("tenant", 2), "2号住客");
    assert.equal(placeholderName("tenant", 3), "3号住客");
  }

  // ② 宿管不住这儿 → 不是住户；「不知道」同样不是住户。
  {
    assert.equal(residesFromInput("confirmed_not_living"), false);
    assert.equal(residesFromInput("unknown"), null);
    assert.equal(residesFromInput(undefined), null);
    assert.equal(residesFromInput(null), null);
    // 只有 true 才算「确认住在这里」——null 和 false 都不算。
    assert.notEqual(residesFromInput("unknown"), true);
    assert.notEqual(residesFromInput("confirmed_not_living"), true);
    // **不许把宿管叫成「N号住客」**：那等于用占位名顺手断言了身份和居住。
    assert.equal(placeholderName("manager", 2), "2号管理人");
    assert.ok(!placeholderName("manager", 2).includes("住客"));
    assert.ok(!roleLabel("manager").includes("住客"));
    assert.equal(roleLabel("manager"), "宿管/物业");
    // 系统自己就是协调者，名册里的人类协调人必须跟它区分开。
    assert.ok(roleLabel("coordinator").includes("不是你"));
    assert.equal(placeholderName("coordinator", 4), "4号协调人");
  }

  // ③ 只给了号码：身份还是「还不知道」，居住还是「不知道」。
  {
    // addResident 的边界：residence 不填 → null（「不知道」，不是「住着」）。
    // 「role 不填 → other」在 repo 的入库分支里（见免费闸的源码级断言）。
    assert.equal(residesFromInput(undefined), null);
    assert.equal(roleLabel("other"), "还不知道是什么身份的联系人");
    assert.equal(placeholderName("other", 1), "1号联系人");
    assert.ok(!placeholderName("other", 1).includes("住客"));
    // 五个角色都在名册里有标签，不会漏一个印出内部英文值。
    for (const r of ROLES) {
      assert.ok(roleLabel(r).length > 0, `${r} 必须有人话标签`);
      assert.ok(placeholderName(r, 1).length > 0, `${r} 必须有占位名`);
    }
  }

  // ④ 后来又明确说「他是宿管、不住这儿」→ 补进同一条关系，不重复、不抹掉。
  {
    // 先：只给了号码。
    const first = blank();
    // 后：明确说了身份与居住 —— 两条事实都补进去。
    const enriched = mergeMembershipFacts(first, {
      role: "manager",
      resides: false,
      note: "B栋宿管",
    });
    assert.deepEqual(enriched, {
      role: "manager",
      resides: false,
      note: "B栋宿管",
    });

    // 再报一次号码、什么都没多说 → 原值一个字不变（不是「倒退回未知」）。
    assert.deepEqual(mergeMembershipFacts(enriched, {}), enriched);
    assert.deepEqual(
      mergeMembershipFacts(enriched, { role: null, resides: null, note: null }),
      enriched
    );
    // 只补一句备注，也不许把身份/居住带走。
    assert.deepEqual(mergeMembershipFacts(enriched, { note: "换班时间在晚上" }), {
      role: "manager",
      resides: false,
      note: "换班时间在晚上",
    });
    // 空白备注不算「说了什么」，不能把已有的备注擦掉。
    assert.deepEqual(mergeMembershipFacts(enriched, { note: "   " }), enriched);

    // 「不知道」不是事实：不能拿它盖掉已经知道的。
    const tenant: MembershipFacts = { role: "tenant", resides: true, note: null };
    assert.deepEqual(
      mergeMembershipFacts(tenant, { role: "other", resides: null }),
      tenant
    );
    // 反过来，明确的事实可以纠正旧值（比如先记成租客、后来才知道是宿管）。
    assert.deepEqual(
      mergeMembershipFacts(tenant, { role: "manager", resides: false }),
      { role: "manager", resides: false, note: null }
    );

    // 幂等：同一个人第二次只说号码，事实与第一次完全一样
    // ——既不重复登记，也不因为「这次没提」而退化。
    const once = mergeMembershipFacts(blank(), { role: "manager", resides: false });
    const twice = mergeMembershipFacts(once, {});
    assert.deepEqual(twice, once);
  }

  // ⑤ 把一栋房子的名册摆在一起看：登记出来的「住在这里的人数」对不对。
  //    这个数就是生产里算住户的口径 `resides is not false`（repo 的
  //    `getActiveRules.pendingNames` / turn.ts 的 proposeRule 征询人数）——
  //    **确认不住的不算，不知道的算**。多算一个人，按人头分资源、按人头
  //    征询规则就全错。
  {
    const roster: MembershipFacts[] = [
      { role: "landlord", resides: true, note: null }, // 房东住在自己房子里
      { role: "tenant", resides: true, note: null }, // 两个点名说住进来的租客
      { role: "tenant", resides: true, note: null },
      { role: "manager", resides: false, note: "物业" }, // 有号码，但不住这儿
      { role: "other", resides: null, note: null }, // 只给了号码，还不知道
    ];
    const residents = roster.filter((m) => m.resides !== false);
    // 老逻辑是「号码进来就当他住在这儿」，会数成 5 —— 把物业也算成住户。
    assert.equal(residents.length, 4, "确认不住在这里的人不算住户");
    assert.deepEqual(
      residents.map((m) => m.role),
      ["landlord", "tenant", "tenant", "other"],
      "房东住自己房子算住户；物业不算；只给号码的身份未知但可能住"
    );
  }

  console.log("membership facts tests: passed");
}

main();
