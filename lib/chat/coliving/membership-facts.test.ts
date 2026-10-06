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
 *   ⑤（2026-10-06 加）`selfNameUnknown`：要不要问「他本人怎么称呼」，只认
 *      **占位名 + 没人确认过**两条同时成立——已经知道真名的人不会再被问一遍。
 *   ⑥（2026-10-06 复审加）`nameProvenanceMark`：名册上那个标注与上面这个判据
 *      **必须判据一致、话必须两句**——真名但没人确认过 ≠ 占位名。
 */

import assert from "node:assert/strict";

import {
  isPlaceholderName,
  mergeMembershipFacts,
  nameProvenanceMark,
  placeholderName,
  residesFromInput,
  roleLabel,
  selfNameUnknown,
  PLACEHOLDER_NAME_MARK,
  ROLES,
  UNCONFIRMED_NAME_MARK,
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

  // ⑥ 要不要问「怎么称呼你」——判据是**占位名 + 没人确认过**两条同时成立。
  //    只认其中一条都会错，两个方向各有一批反例。
  {
    // 生成与识别是同一份词表：`placeholderName` 造出来的每一个都是占位名。
    // （这条断言就是防那次静默失效的——识别端另抄一份格式，词表一分家就失效。）
    for (const r of ROLES) {
      for (const i of [1, 2, 13]) {
        assert.ok(
          isPlaceholderName(placeholderName(r, i)),
          `${placeholderName(r, i)} 必须被认成占位名`
        );
      }
    }
    assert.ok(isPlaceholderName("  3号住客  "), "两端空白不算名字的一部分");
    assert.ok(isPlaceholderName("10号管理人"));

    // 真名一律不是占位名——哪怕里面带「号」、带「住客」。
    for (const real of [
      "小王",
      "Alex",
      "3号楼的王师傅",
      "二号住客",
      "住客小李",
      "12",
      "",
      "   ",
    ]) {
      assert.ok(!isPlaceholderName(real), `「${real}」不是占位名`);
    }
    assert.ok(!isPlaceholderName(null));
    assert.ok(!isPlaceholderName(undefined));

    // ① 名下是个内部编号、也没人确认过 → **不知道，要问**。
    assert.equal(
      selfNameUnknown({ name: "1号联系人", nameConfirmed: false }),
      true
    );
    // ② 名册上根本没有他这一条 → 同样不知道（宁可不问不漏：缺着这一条时
    //    问一句是自然的）。
    assert.equal(selfNameUnknown(undefined), true);
    assert.equal(selfNameUnknown(null), true);

    // ③ **他自己报过名字**（他说的 → confirmed）→ 一个字都不再问。
    assert.equal(selfNameUnknown({ name: "小王", nameConfirmed: true }), false);
    // ④ **名字是别人转述来的、或者名册里导入的真名**（`addResident` 只写
    //    `display_name`，从不把 `name_confirmed` 置真 → 这里读出来是 false）
    //    → **照样不再问**。只看 `nameConfirmed` 会把这些已经知道的名字再问一遍，
    //    正是老板说的「不要重复收已经知道的」要避免的。
    assert.equal(selfNameUnknown({ name: "Jordan", nameConfirmed: false }), false);
    // ⑤ 占位名但被确认过（有人明确说「就叫他 3号住客」）→ 那是他要的称呼，不问。
    assert.equal(
      selfNameUnknown({ name: "3号住客", nameConfirmed: true }),
      false
    );
  }

  // ⑦ 名册渲染的标注（`context.ts` 的 `describeMember` 贴的那一句）：
  //    **真名但没人确认过**与**占位名**必须标成两句不同的话。
  //    这两件事曾经共用一个「占位名，不是真名，不可念出口」，于是室友转述来的
  //    真名既被禁止念出口、又被 `selfNameUnknown` 判成「已经知道、不必再问」——
  //    提示词自己跟自己打架（2026-10-06 复审第 2 条）。
  {
    // 三态：确认过 → 不标；占位名 → 占位名标注；真名未确认 → 未确认标注。
    assert.equal(nameProvenanceMark({ name: "Dana", nameConfirmed: true }), "");
    assert.equal(
      nameProvenanceMark({ name: "1号联系人", nameConfirmed: false }),
      PLACEHOLDER_NAME_MARK
    );
    assert.equal(
      nameProvenanceMark({ name: "Jordan", nameConfirmed: false }),
      UNCONFIRMED_NAME_MARK
    );
    // 两个标注必须是**两句不同的话**——合并回一句就是这次复审要修的那个 bug。
    assert.notEqual(PLACEHOLDER_NAME_MARK, UNCONFIRMED_NAME_MARK);
    // 真名那一句不许出现「不可念出口 / 不是真名」这类话：名字是真的，可以念。
    assert.ok(!UNCONFIRMED_NAME_MARK.includes("不可念出口"));
    assert.ok(!UNCONFIRMED_NAME_MARK.includes("不是真名"));
    // 占位名那一句必须保留「不可念出口」这条硬线。
    assert.ok(PLACEHOLDER_NAME_MARK.includes("不可念出口"));

    // 与 `selfNameUnknown` 必须**判据一致**（同一套 `isPlaceholderName`）：
    // 标了「还没经他本人确认」的人，一定是「名字已经知道、不必再问」的人；
    // 标了占位名标注（或压根没有名字）的人，才是要问的人。
    for (const m of [
      { name: "Dana", nameConfirmed: true },
      { name: "Jordan", nameConfirmed: false },
      { name: "1号联系人", nameConfirmed: false },
      { name: "3号住客", nameConfirmed: true },
    ]) {
      assert.equal(
        nameProvenanceMark(m) === UNCONFIRMED_NAME_MARK,
        m.nameConfirmed === false && !isPlaceholderName(m.name),
        `${m.name} 的标注与判据不一致`
      );
      assert.equal(
        selfNameUnknown(m),
        nameProvenanceMark(m) === PLACEHOLDER_NAME_MARK,
        `${m.name} 的「要不要问」与标注不一致`
      );
    }
  }

  console.log("membership facts tests: passed");
}

main();
