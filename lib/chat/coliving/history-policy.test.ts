/**
 * 对话历史有界化（`history-policy.ts`）的**确定性反例**：纯 Node 单测。
 *
 * 运行：
 *   `pnpm.cmd exec tsx lib/chat/coliving/history-policy.test.ts`
 *
 * **不调 LLM、不连 DB、不发送、不读环境变量**：只跑纯函数。这条模块零 import，
 * 所以这条测试连 react-server 条件都不需要。
 *
 * 三个反例对应这条政策的三个必须成立的性质（题目要求逐条钉住）：
 *
 * 1. **最新的相关往来一定留下**（哪怕整体超预算）：丢了最新那条，模型就会把
 *    上一轮已经问过、已经答过的事再问一遍——这个项目反复踩过的坑；
 * 2. **长历史有界**：条数与字符数都收在预算内，且**只从最旧那头整条地丢**
 *    （留下来的必须是原序列的一段连续后缀，中间不许出现窟窿）。**长度不均匀**时
 *    这条要有牙齿：第一条收不进来的更旧条目就把分界线钉死，再往旧的一条都不许
 *    因为"它更短、装得下"补回来（单独一条反例盯着，见「不均匀长度」）；
 * 3. **结构化运行时事实不受影响**：政策只吃**对话文本**，未结的事 / 现行规则 /
 *    在等谁回话这些事实由 `buildContext` 拼进运行时状态、压根不经过它的入参——
 *    这里用一个"事实块"夹具证明它不管怎么截都原样还在，且历史里那段被丢掉的
 *    长文本不会被伪装成事实留下。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  HISTORY_BUDGET,
  planHistory,
  type HistoryTurn,
} from "./history-policy";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** 去掉注释后的源码：注释里提 `repo.getRecentTurns` 是文档，不是访问。 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** 造一段正常长度的往来（一条短信量级），交替 user / assistant。 */
function conversation(turns: number, charsPerTurn = 120): HistoryTurn[] {
  return Array.from({ length: turns }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `第${i}条：${"呵".repeat(charsPerTurn)}`,
  }));
}

function main(): void {
  console.log("history policy（对话历史有界化）");

  check("空历史 / 单条历史：考虑 0 条不报错，单条原样保留且不丢", () => {
    const empty = planHistory([]);
    assert.deepEqual(empty.kept, []);
    assert.deepEqual(
      [
        empty.consideredTurns,
        empty.keptTurns,
        empty.droppedTurns,
        empty.keptChars,
        empty.droppedChars,
      ],
      [0, 0, 0, 0, 0]
    );

    const one = planHistory([{ role: "user", content: "晚上十点后别用烘干机。" }]);
    assert.equal(one.kept.length, 1);
    assert.equal(one.consideredTurns, 1);
    assert.equal(one.droppedTurns, 0);
    assert.equal(one.keptChars, "晚上十点后别用烘干机。".length);
  });

  check("反例一：预算不够时，**最新的那些**留下，最旧的先走（不是随机丢）", () => {
    // 10 条 × 120 字符：字符预算 2000 装得下前 8 条（960）+ 第 9 条（1080）…
    // 真正钉住的是"从最旧那头丢"这个方向，而不是具体数字。
    const history = conversation(10, 120);
    const plan = planHistory(history);
    // 保留的是原序列的一段**连续后缀**：第 keptTurns 条之后一条不少。
    assert.deepEqual(
      plan.kept,
      history.slice(history.length - plan.keptTurns),
      "留下来的必须是原序列的连续后缀（中间不许有窟窿）"
    );
    assert.equal(plan.kept.at(-1), history.at(-1), "最新那条一定在最后");
    assert.equal(
      plan.keptTurns,
      // 逐条收：120 的倍数。8 条 = 960 ≤ 2000；第 9 条会到 1080 ≤ 2000；
      // 第 10 条 1200 ≤ 2000——但条数上限 8 先到，所以停在 8。
      HISTORY_BUDGET.maxTurns,
      "条数上限 8 先拦住：正常长度的往来最多留 8 条（与 getRecentTurns 默认一致）"
    );
    assert.equal(plan.droppedTurns, 10 - plan.keptTurns);
    assert.equal(plan.droppedChars, history.slice(0, plan.droppedTurns).reduce((s, t) => s + t.content.length, 0));
  });

  check("反例二：长历史有界——条数 ≤ maxTurns 且字符 ≤ maxChars（含超长单条）", () => {
    // 50 条 × 500 字符 = 25000 字符：远超预算。要证明的是**上界真的成立**。
    const history = conversation(50, 500);
    const plan = planHistory(history);
    assert.ok(plan.keptTurns <= HISTORY_BUDGET.maxTurns, "条数不得超过上限");
    assert.ok(
      plan.keptChars <= HISTORY_BUDGET.maxChars,
      `字符数不得超过上限（实际 ${plan.keptChars}）`
    );
    assert.equal(plan.consideredTurns, 50, "考虑条数照实记（不是保留条数）");
    assert.equal(
      plan.keptTurns + plan.droppedTurns,
      plan.consideredTurns,
      "保留 + 丢弃 = 考虑，账要对得上"
    );
    assert.equal(
      plan.keptChars + plan.droppedChars,
      history.reduce((s, t) => s + t.content.length, 0),
      "字符账也要对得上（观测里那四个数字必须能相加）"
    );
    // **超长单条**：最新那条自己就超字符预算——仍然留下（连续性优先），
    // 但更旧的**一条都不留**，不能出现"留着新的又塞回一屋子旧的"。
    const huge: HistoryTurn[] = [
      { role: "user", content: "呵".repeat(5000) },
      { role: "assistant", content: "好" },
      { role: "user", content: "呵".repeat(HISTORY_BUDGET.maxChars + 100) },
    ];
    const hugePlan = planHistory(huge);
    assert.equal(hugePlan.kept.length, 1, "最新那条超预算也留下，其余一条不留");
    assert.equal(hugePlan.kept[0], huge[2], "留下的正是最新那条，且逐字原样");
    assert.equal(hugePlan.droppedChars, 5000 + 1);
  });

  check("反例二之二：**长度不均匀**时，被拒的那条之后一条都不许补回来（连续后缀）", () => {
    // 这条钉的是「拒绝必须是终点」：只丢装不下的那条、下一轮又把更旧的短条目
    // 按"它更短、装得下"补回来，留下的就不是连续后缀了——中间会凭空缺一段。
    // 旧写法（`withinBudget` 每轮重算、不记"已经收不动了"）在这里会真的留下
    // 第 1 条与第 3 条，把中间那条 200 字的丢掉，`deepEqual` 直接炸。
    const budget = { maxTurns: 8, maxChars: 100 };
    const uneven: HistoryTurn[] = [
      { role: "user", content: `最旧短条 ${"短".repeat(2)}` }, // 3+4=7 字，装得下
      { role: "assistant", content: `中间长条 ${"长".repeat(200)}` }, // 5+200=205 字，装不下
      { role: "user", content: `最新条 ${"新".repeat(43)}` }, // 4+43=47 字，最新必须留
    ];
    const plan = planHistory(uneven, budget);
    assert.equal(plan.kept.at(-1), uneven[2], "最新那条仍然留下");
    assert.deepEqual(
      plan.kept,
      uneven.slice(2),
      "留下的必须是**连续后缀**：中间那条装不下之后，更旧的一条也不许再塞回来"
    );
    assert.equal(plan.keptTurns, 1, "分界线一定，往旧的一条都不留");
    assert.equal(plan.droppedTurns, 2);
    // 账目照旧自洽：三条的字符一分不多一分不少。
    assert.equal(plan.keptChars, uneven[2].content.length);
    assert.equal(
      plan.droppedChars,
      uneven[0].content.length + uneven[1].content.length,
      "被拒的长条与它更旧的短条都要计进丢弃（不许因为没留下就不记账）"
    );
    assert.equal(
      plan.keptChars + plan.droppedChars,
      uneven.reduce((s, t) => s + t.content.length, 0),
      "字符账对得上"
    );

    // 同一件事吹成一条长历史：拒绝点在中间，后面每条都更短——一条都不许回填。
    const spiky: HistoryTurn[] = [
      ...conversation(4, 1), // 最旧四条：每条 5 字（"第0条：呵"），共 20 字
      { role: "user", content: "呵".repeat(90) }, // 拒绝点：任何已收的组合都装不下它
      ...conversation(3, 1), // 三条 5 字
      { role: "assistant", content: "呵".repeat(30) }, // 最新
    ];
    const spikyPlan = planHistory(spiky, budget);
    assert.equal(spikyPlan.kept.at(-1), spiky.at(-1), "最新那条仍然留下");
    assert.deepEqual(
      spikyPlan.kept,
      spiky.slice(spiky.length - spikyPlan.keptTurns),
      "连续后缀：拒绝点定在 90 字那条，更旧的短条一条都不许回填"
    );
    // 30 + 3×5 = 45 ≤ 100 收下；再来 90 就 135 > 100 → 分界线落在这条。
    assert.equal(spikyPlan.keptTurns, 4, "最新 1 条 + 它前面三条 5 字短条");
    assert.equal(
      spiky[spiky.length - spikyPlan.keptTurns - 1]?.content.length,
      90,
      "紧挨着保留段的那条（第一条被拒的）正是 90 字那条——说明没有越过它回填更旧的"
    );
    assert.equal(spikyPlan.droppedTurns, 5, "90 字那条 + 更旧四条，全部计进丢弃");
    assert.equal(
      spikyPlan.keptChars + spikyPlan.droppedChars,
      spiky.reduce((s, t) => s + t.content.length, 0)
    );
  });

  check("反例三：结构化运行时事实不经这条政策——它只吃对话文本，事实块原样还在", () => {
    // 这条政策**只**接受对话数组：模块零 import、没有第二个入参能塞进事实。
    const src = readFileSync(
      path.join("lib", "chat", "coliving", "history-policy.ts"),
      "utf8"
    );
    const importLines = src
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^import\b/.test(line) || /^} from /.test(line));
    assert.deepEqual(
      importLines,
      [],
      "history-policy.ts 必须零 import：结构上碰不到数据库/模型/出站（也就不可能新增一次模型调用）"
    );
    // 注释里点名 `repo.getRecentTurns` / `buildContext` 是**文档**（说明它为什么
    // 存在），不算访问；所以只在**去掉注释之后**的源码上查这些记号。
    const body = code(src);
    for (const forbidden of [
      "runtime",
      "generateText",
      "repo.",
      "ctx.",
      "await",
      "fetch(",
    ]) {
      assert(
        !body.includes(forbidden),
        `历史政策的代码里不许出现 ${forbidden}——结构化事实与外部调用都不是它的射程`
      );
    }

    // 事实块（未结的事 / 现行规则 / 在等谁回话）与对话历史是两份互不相干的东西：
    // 无论历史被截成什么样，事实块一个字都不变，也不会"漏"进历史里被当成一条。
    const factsBlock =
      "## 还没了结的事\n- 厨房晚间时段冲突（case_1）\n" +
      "## 这栋房子的现行规则\n- [shared] 洗完澡清地漏头发（rule_9）\n" +
      "## 你在等谁回话\n- 在等 Jordan 回：烘干机清空时限";
    const history = conversation(40, 400);
    const plan = planHistory(history);
    assert.equal(factsBlock.includes("case_1"), true, "夹具：事实块里有结构化 id");
    assert(
      plan.kept.every((t) => !factsBlock.includes(t.content)),
      "留下来的每一条都来自对话历史，事实块没有被当成历史条目塞进来"
    );
    assert(
      !JSON.stringify(plan.kept).includes("case_1") &&
        !JSON.stringify(plan.kept).includes("rule_9"),
      "被丢掉的长文本不会把结构化事实带出去（事实本来就不在历史里）"
    );
    // 事实块自己的字符数不进历史的账——两本账分开算。
    assert.equal(
      plan.keptChars,
      plan.kept.reduce((s, t) => s + t.content.length, 0),
      "历史字符数只数历史自己的正文"
    );
  });

  check("不改写、不摘要、不重排：留下的条目逐字等于原条目，顺序不变", () => {
    const history = conversation(12, 300);
    const plan = planHistory(history);
    for (const [i, turn] of plan.kept.entries()) {
      assert.equal(
        turn.content,
        history[history.length - plan.keptTurns + i]?.content,
        "留下的正文必须逐字原样（这条模块不做摘要、不重写）"
      );
    }
    assert.deepEqual(
      plan.kept.map((t) => t.role),
      history.slice(history.length - plan.keptTurns).map((t) => t.role),
      "角色顺序原样"
    );
  });

  check("预算可注入：自定义预算按同一套不变量生效（便于以后调参不改语义）", () => {
    const history = conversation(6, 10);
    const plan = planHistory(history, { maxTurns: 2, maxChars: 1000 });
    assert.equal(plan.keptTurns, 2);
    assert.deepEqual(plan.kept, history.slice(4));
    const tight = planHistory(history, { maxTurns: 8, maxChars: 25 });
    assert.ok(tight.keptChars <= 25 || tight.keptTurns === 1);
    assert.equal(tight.kept.at(-1), history.at(-1), "收紧字符预算也不许丢掉最新那条");
  });

  console.log(`\nhistory policy：${passed} 项检查全部通过`);
}

main();
