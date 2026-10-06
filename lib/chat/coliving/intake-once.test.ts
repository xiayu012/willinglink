/**
 * `intake-once.ts` 的**确定性反例**：纯 Node 单测（不调模型、不连库、不发消息）。
 *
 * 运行：`pnpm.cmd exec tsx lib/chat/coliving/intake-once.test.ts`
 *
 * 判据本身零 import；后半段是**源码哨兵**（只读 `readFileSync`），钉住运行时两个
 * 调用点用的是同一个判据、且边界没有被改回去。反例对应老板 2026-10-06 那条要求
 * 的四面：**有人报过就停**（含"报的人自己不住这儿"那条）、**停了不会因为有人搬走
 * 又重开**，但**全新的一户照旧收**、**停止收集 ≠ 名册齐全**。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  householdIntakeSupplied,
  shouldCollectRoster,
  type HouseholdRosterState,
} from "./intake-once";

function main() {
  /**
   * 名册结构：`historicalCount` 是**历史上记过的人**（含已离开 / 不住这儿的），
   * `complete` 是"有人说过总人数且够数"。判据只读这两个。
   */
  const roster = (
    historicalCount: number,
    complete: boolean
  ): HouseholdRosterState => ({ historicalCount, complete });

  // ── ① 有人报过 → 停 ──────────────────────────────────────────────────────
  {
    // 复审反例之一：**不住这儿的宿管**报了唯一一位住户的姓名 + 号码。
    // 当前住户数还是 1（宿管 `resides=false`），但"这一户已经有人报过了"已经发生。
    assert.equal(
      householdIntakeSupplied(roster(2, false)),
      true,
      "★ 角色不设门槛：报的人自己不住这儿，也算有人报过"
    );
    assert.equal(
      shouldCollectRoster(roster(2, false)),
      false,
      "★ 宿管报了一位住户之后，名册照旧不许再收（只数确认住户就会漏掉这一条）"
    );

    // 复审反例之二：这一户**曾经**记过三个人，如今只剩一个人在册（两个已离开）。
    // 按**当前**在册人数算，收名册会重新开口——老板要的是「彻底结束」。
    assert.equal(
      householdIntakeSupplied(roster(3, false)),
      true,
      "★ 停下来是**永久**的：有人搬走不重新开口（历史人数只增不减）"
    );
    assert.equal(
      shouldCollectRoster(roster(3, false)),
      false,
      "★ 只剩一个人在册也不许重开名册"
    );

    // 现场那一户（2026-10-06 只读 DB 证据）：房号已知、名册 3 人、
    // **从来没人报过总人数**，所以 `complete` 永远是 false。
    assert.equal(
      shouldCollectRoster(roster(3, false)),
      false,
      "★ 主回归：房号已知 + 名册 3 人 + 没人报过总人数 → 后来开口的成员不再被收一遍"
    );
  }

  // ── ② 但这是一户一次，不是"全局不问" ────────────────────────────────────
  {
    // 全新的一户：一个陌生号码刚开口，这一户历史上只有他自己。
    assert.equal(shouldCollectRoster(roster(1, false)), true, "全新的一户照旧收（房号 + 室友）");
    assert.equal(
      householdIntakeSupplied(roster(1, false)),
      false,
      "只有他自己：还不是「有人报过」"
    );

    // 只报了房号、还没给过任何室友：历史上仍然只有他自己 → 原来那次室友问话照旧发生。
    assert.equal(
      shouldCollectRoster(roster(1, false)),
      true,
      "只报房号不算：老板两步收集的第一步不能被这条一起关掉"
    );
  }

  // ── ③ 停止收集 ≠ 名册齐全：别把"不问了"说成"齐了" ───────────────────────
  {
    // 本人说过「就我一个」：名册 1/1，齐全 → 不收；但这不是"有人报过"。
    assert.equal(
      shouldCollectRoster(roster(1, true)),
      false,
      "★ 已确认的一人户：本来就不该收——判据必须仍然吃 `complete`，不能只看 supplied=false"
    );
    assert.equal(
      householdIntakeSupplied(roster(1, true)),
      false,
      "一人户不是「有人报过」：两者由 complete 区分，不能混成一条"
    );

    // 名册齐全（3/3）：本来就不该再问。
    assert.equal(shouldCollectRoster(roster(3, true)), false, "名册齐全：不问");
    assert.equal(
      householdIntakeSupplied(roster(3, true)),
      true,
      "齐全当然也算已报过——但反过来不成立（现场那一户就不齐全）"
    );

    // 现场那一户：停止收集之后 `complete` 仍然是假——名册照旧可能漏人。
    assert.equal(roster(3, false).complete, false, "「不再问了」不蕴含「齐了」");
  }

  // ── ④ 运行时两个调用点都走同一个判据（源码哨兵）─────────────────────────
  const src = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const turnSrc = src("lib/chat/coliving/turn.ts");
  const ctxSrc = src("lib/chat/coliving/context.ts");
  const repoSrc = src("lib/chat/coliving/repo.ts");

  {
    // `firstEnrollmentTurn`：名册那一半必须挂判据（只看 `complete` = 现场那个 bug：
    // 房号已知 + 名册没齐 → 每个新成员都被重新问一遍）；房号那一半不受影响。
    const gateAt = turnSrc.indexOf("const firstEnrollmentTurn =");
    assert(gateAt > 0, "找不到 firstEnrollmentTurn 这道闸");
    const gate = turnSrc.slice(gateAt, turnSrc.indexOf(";", gateAt));
    assert(gate.includes("shouldCollectRoster("), "firstEnrollmentTurn 必须走判据");
    assert(gate.includes("sender.unit"), "房号那一半照旧：没人说过 Unit 时该问就问");

    const openAt = turnSrc.indexOf("enrollmentOpen:");
    assert(openAt > 0, "找不到 enrollmentOpen 结构信号");
    assert(
      turnSrc
        .slice(openAt, turnSrc.indexOf("\n  };", openAt))
        .includes("shouldCollectRoster(ctx.roster)"),
      "enrollmentOpen（补充轮）也必须走同一个判据"
    );

    // 阈值只写一处：不许在 turn.ts / context.ts 里另写一套。
    for (const [name, text] of [
      ["turn.ts", turnSrc],
      ["context.ts", ctxSrc],
    ] as const) {
      assert(
        !/historicalCount\s*>\s*1|memberCount\s*>\s*1|knownCount\s*>\s*1/.test(text),
        `${name} 里不许再写一遍人数阈值——判据只在 intake-once.ts`
      );
    }

    // `repo.rosterStatus` 必须把**历史人数**喂给判据（不是「确认住户」数、
    // 也不是**当前在册**人数——那两种都会让人搬走之后重新开口）。
    assert(
      repoSrc.includes("householdIntakeSupplied({ historicalCount, complete })"),
      "rosterStatus 必须用 historicalCount 推导 intakeSupplied"
    );
    const histAt = repoSrc.indexOf('as "historicalCount"');
    assert(histAt > 0, "找不到历史人数那一段 SQL");
    const histSql = repoSrc.slice(repoSrc.lastIndexOf("(select", histAt), histAt);
    assert(
      histSql.includes("count(distinct mb.person_id)"),
      "历史人数必须按人去重（同一人可能不止一行 membership）"
    );
    assert(
      !histSql.includes("valid_to") && !histSql.includes("resides"),
      "★ 历史人数不许按有效期 / 是否住户过滤——搬走的人、宿管都算「报过」"
    );

    // 第一次接触那一节的缺项清单：名册那一项走判据，房号那一项照旧。
    const missingAt = ctxSrc.indexOf("const missing: string[] = [];");
    assert(missingAt > 0, "找不到第一次接触的缺项清单");
    const missing = ctxSrc.slice(missingAt, ctxSrc.indexOf("if (missing.length)", missingAt));
    assert(missing.includes("shouldCollectRoster(roster)"), "缺项清单里的名册那一项必须走判据");
    assert(missing.includes("sender.unit"), "缺项清单里房号那一项照旧");

    // 名册那一节：`intakeSupplied` 那一支必须**排在** `declaredSize !== null` 之前
    // （反过来的话，"有人说过总人数、但这一户已经不再收"会落回「还差 N 个，问到了加进来」）。
    const suppliedAt = ctxSrc.indexOf("roster.intakeSupplied");
    const declaredAt = ctxSrc.indexOf("roster.declaredSize !== null");
    assert(suppliedAt > 0 && declaredAt > 0, "名册那两节都必须在");
    assert(suppliedAt < declaredAt, "「不再收名册」那一支必须排在「还差 N 个」之前");

    const suppliedBranch = ctxSrc.slice(suppliedAt, declaredAt);
    for (const solicitation of [
      "先问一句这屋一共住几个人",
      "confirmRoster 记下来",
      "问到了就用 addResident 加进来",
    ]) {
      assert(
        !suppliedBranch.includes(solicitation),
        `停止收集的那一支里不许出现收名册的句子：「${solicitation}」`
      );
    }
    assert(suppliedBranch.includes("不再向住户收"), "那一支必须说出「不再收」");
    assert(
      suppliedBranch.includes("还没确认过完整性"),
      "停止收集 ≠ 名册齐全：那一支必须照实说名册还没确认过完整性"
    );

    // `confirmRoster` 的回执：不再收名册之后不许回「还差 N 个」。
    const confirmAt = turnSrc.indexOf("const status = await repo.rosterStatus(sender.householdId);");
    assert(confirmAt > 0, "找不到 confirmRoster 的回执");
    assert(
      turnSrc.slice(confirmAt, turnSrc.indexOf("});", confirmAt)).includes("status.intakeSupplied"),
      "confirmRoster 的回执必须区分「这一户已经不再收」"
    );

    // **必要的问题照旧**：停止收名册**不关**任何办事入口。基础工具表里
    // `addResident` / `contactPerson` 是无条件给的（住户交办要联系谁、缺号码要问，
    // 都在主生成里正常发生），本任务不动那一段。
    const toolsAt = turnSrc.indexOf("const activeTools: Record<string, (typeof tools)");
    assert(toolsAt > 0, "找不到基础工具表");
    const baseTools = turnSrc.slice(toolsAt, turnSrc.indexOf("if (ctx.openCaseIds.length > 0)", toolsAt));
    for (const tool of ["addResident: tools.addResident", "contactPerson: tools.contactPerson"]) {
      assert(baseTools.includes(tool), `停止收名册不许关掉办事工具：${tool}`);
    }
  }

  console.log("intake once tests: passed");
}

main();
