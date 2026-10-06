/**
 * `display-name.ts` 的**确定性反例**：纯 Node 单测（不调模型、不连库、不发消息）。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination-history/display-name.test.ts`
 *
 * 老板 2026-10-06 的要求：左栏那套房现在叫「这栋房子」（导入名单里没读到房号，
 * `household.label` 落了默认值），要让**已记录的房号**当名字。改的是只读页的
 * 展示名（`display-name.ts` + `read.ts` 那一条查询），这条测试只钉住**取名这一层**
 * 的判词；后半段是**源码哨兵**（只读 `readFileSync`），钉住查询侧没有被改回去：
 *
 *   1. **有房号就用房号**，且是记录原样（只 trim）——不归一化、不拼「Unit 」前缀；
 *   2. **没房号（缺列 / null / 空串 / 纯空白）原样回退 `household.label`**——
 *      导入的「Maple Court A 座 101」这类真名字不能丢；
 *   3. **房号变了，显示名跟着变**（不是把第一次读到的名字缓存住）；
 *   4. **两栋不同的房子可以是同一个房号，绝不合并**——这是这条路最危险的做法
 *      （按房号收拢会让两组人的记录在页面上塌成一条）。
 *
 * 页面长什么样、英文文案对不对，这条测试证明不了——那要靠打开
 * `/coordination-history` 人工看。语气/措辞更与它无关：这里一个字都不发给住户。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { unitDisplayName } from "./display-name";

function main() {
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  // ── ① 有房号：用记录原样，不加工 ────────────────────────────────────────
  check("有房号就用房号，只去掉首尾空白，不加前缀、不归一化", () => {
    assert.equal(unitDisplayName("A208", "这栋房子"), "A208");
    assert.equal(unitDisplayName("  A208  ", "这栋房子"), "A208");
    // 住户说的就是「A 208」这种带空格的写法：显示照原样，不能被 `normalizeUnit`
    // 那套（NFKC + 去空白 + 转小写）压成 `a208`——那是匹配键，不是给人看的名字。
    assert.equal(unitDisplayName("A 208", "Maple Court"), "A 208");
    assert.equal(unitDisplayName("１２－３", "这栋房子"), "１２－３");
  });

  // ── ② 没房号：原样回退 label ────────────────────────────────────────────
  check("没记录过房号（null / 缺列 / 空串 / 纯空白）原样回退 household.label", () => {
    const label = "Maple Court A 座 101";
    assert.equal(unitDisplayName(null, label), label);
    assert.equal(unitDisplayName(undefined, label), label);
    assert.equal(unitDisplayName("", label), label);
    assert.equal(unitDisplayName("   ", label), label);
    // 导入没读到房号时的默认名也照样回退，不变成空字符串
    assert.equal(unitDisplayName(null, "这栋房子"), "这栋房子");
    // label 本身不被 trim / 改写：它是别人给这套房起的名字
    assert.equal(unitDisplayName(" ", " 401-1 "), " 401-1 ");
  });

  // ── ③ 房号改了，名字跟着改 ──────────────────────────────────────────────
  check("同一栋房后来记下（或改了）房号，显示名跟着变，不是缓存住的旧名", () => {
    const label = "这栋房子";
    assert.equal(unitDisplayName(null, label), "这栋房子");
    assert.equal(unitDisplayName("B12", label), "B12");
    assert.equal(unitDisplayName("B13", label), "B13");
  });

  // ── ④ 正常反例：不同房 id 可以共用同一房号，绝不合并 ────────────────────
  check("两栋不同的房子共用同一房号时各自成行，不按房号去重", () => {
    // 每行独立取名——把同一个房号喂两次，得到两个各自独立的名字，没有任何跨行
    // 状态（真按房号收拢的话，这里就该只剩一行）。
    const rows = [
      { id: "house-1", unit: "A208", label: "这栋房子" },
      { id: "house-2", unit: "A208", label: "Maple Court A 座 101" },
    ];
    const named = rows.map((r) => ({
      id: r.id,
      name: unitDisplayName(r.unit, r.label),
    }));
    assert.equal(named.length, 2, "两栋房子必须还是两行");
    assert.deepEqual(
      named.map((r) => r.id),
      ["house-1", "house-2"]
    );
    assert.equal(named[0].name, "A208");
    assert.equal(named[1].name, "A208");
  });

  // ── ⑤ 查询侧同一条性质（源码哨兵）──────────────────────────────────────
  check("read.ts 那条查询：left join 取房号、不收拢行、排除判据仍按 label", () => {
    const src = readFileSync("lib/coordination-history/read.ts", "utf8").replace(
      /\r\n/g,
      "\n"
    );
    const start = src.indexOf("select h.id, h.label");
    const end = src.indexOf("order by h.created_at desc");
    assert.ok(start > 0 && end > start, "找不到按房子取行的那条查询");
    const query = src.slice(start, end);

    assert.ok(
      query.includes("left join coliving.dwelling d on d.id = h.dwelling_id"),
      "取房号要 left join dwelling——inner join 会把没 dwelling 的房子整栋弄丢"
    );
    assert.ok(
      !/group\s+by|distinct/i.test(query),
      "按房子取行不许 group by / distinct：两栋房子可以是同一个房号"
    );
    assert.ok(
      query.includes("h.label not like '影子验证%'"),
      "合成数据排除仍按 household.label，不跟房号走"
    );
    // join 之后 id / label / created_at 两边都有，必须带表别名，否则报 ambiguous
    assert.ok(
      query.includes(
        "select h.id, h.label, h.status, h.is_test, h.created_at, d.unit"
      ),
      "join 之后每一列都要带表别名"
    );
    assert.ok(
      src.includes("label: unitDisplayName(h.unit, h.label)"),
      "展示名必须走 unitDisplayName，而不是直接用 h.label"
    );
  });

  console.log(
    `\n协调历史显示名：${passed} 项全过（零模型、零短信、零数据库、零 schema 改动）`
  );
}

main();
