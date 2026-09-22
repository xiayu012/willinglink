/**
 * **内容 Markdown 的解析契约**——只测 `parseCoordinatorCopy` 这一件事。
 *
 * 运行：
 *   `pnpm.cmd exec tsx lib/chat/coliving/coordinator-copy.test.ts`
 *
 * 为什么只剩这一件事：住户会读到的四段文案落在
 * `lib/ai/brains/coliving/doctrine/content/coordinator-self-description.md`，
 * 于是**这份文件本身就是一个产品输入**——它写坏了，住户就直接收到一句坏话。
 * 文件层面的检查（位置在 doctrine 树内、四个标题各一次、四段非空且逐字取用、
 * TypeScript 里没有副本）在 `scripts/coliving-quality-inspect.ts` 里有一条常驻闸；
 * 问答行为（只读身份段 / 只读能力段 / 兜底不说清单 / 被拒事项只说它自己）在同处与
 * `language.test.ts` 里。**这里不重复那些**，只补它们在结构上够不着的一层：
 * 改文案的人把文件写坏时，解析器**必须当场报错**，而不是悄悄回一句空白、
 * 少给一段、或把旧的那句留着——"自检会直接报错"是这个设计的全部安全性所在。
 *
 * 不调 LLM、不连 DB、不发送；纯函数 + 内存里的夹具字符串。
 */

import assert from "node:assert/strict";
import { parseCoordinatorCopy } from "./coordinator-copy";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** 一份合法的四段夹具（每段一句话，便于逐段改动做反例）。 */
const VALID = [
  "# 说明性大标题（不是住户可见文案）",
  "",
  "一些编辑须知，解析器应当忽略。",
  "",
  "## identity.zh",
  "",
  "甲版本身份，我是 AI。",
  "",
  "## identity.en",
  "",
  "I'm the AI coordinator.",
  "",
  "## capabilities.zh",
  "",
  "我能帮忙协调。",
  "",
  "## capabilities.en",
  "",
  "I can help coordinate.",
].join("\n");

console.log("coordinator copy（内容 Markdown 的解析契约）");

check("按标题把整段取出来：标题外的说明文字不是住户可见文案", () => {
  assert.deepEqual(parseCoordinatorCopy(VALID, "fixture.md"), {
    "identity.zh": "甲版本身份，我是 AI。",
    "identity.en": "I'm the AI coordinator.",
    "capabilities.zh": "我能帮忙协调。",
    "capabilities.en": "I can help coordinate.",
  });
});

check("换一份内容，解析结果就跟着换（代码里没有第二份文案）", () => {
  const v2 = VALID.replace("我能帮忙协调。", "甲版本能力。").replace(
    "I'm the AI coordinator.",
    "Identity v1 (AI)."
  );
  const parsed = parseCoordinatorCopy(v2, "fixture.md");
  assert.equal(parsed["capabilities.zh"], "甲版本能力。");
  assert.equal(parsed["identity.en"], "Identity v1 (AI).");
  // 没改到的两段照旧——解析是逐段读文件，不是整体替换。
  assert.equal(parsed["identity.zh"], "甲版本身份，我是 AI。");
  assert.equal(parsed["capabilities.en"], "I can help coordinate.");
});

check("一个标题下的多行算同一段，换行原样保留", () => {
  const multi = parseCoordinatorCopy(
    VALID.replace("甲版本身份，我是 AI。", "第一行，我是 AI。\n第二行。").replace(
      "I'm the AI coordinator.",
      "AI line one.\nline two."
    ),
    "fixture.md"
  );
  assert.equal(multi["identity.zh"], "第一行，我是 AI。\n第二行。");
  assert.equal(multi["identity.en"], "AI line one.\nline two.");
});

check("缺任何一段都直接报错，并指出是哪一段（不静默回空白）", () => {
  const missing = VALID.replace(/## capabilities\.en[\s\S]*$/, "");
  assert.throws(() => parseCoordinatorCopy(missing, "fixture.md"), /capabilities\.en/);
});

check("某一段留空直接报错（住户那一侧会读到这段话）", () => {
  const empty = VALID.replace("我能帮忙协调。", "   \n");
  assert.throws(() => parseCoordinatorCopy(empty, "fixture.md"), /空的/);
});

check("同一个标题出现两次直接报错（否则改一处、另一处还是旧的）", () => {
  const duplicated = VALID.replace(
    "## capabilities.zh",
    "## identity.zh\n我是第二遍。\n## capabilities.zh"
  );
  assert.throws(() => parseCoordinatorCopy(duplicated, "fixture.md"), /两次/);
});

check("身份段少了「AI」直接报错；能力段没有这条要求", () => {
  const role = VALID.replace("甲版本身份，我是 AI。", "我是这套房的协调员。");
  assert.throws(() => parseCoordinatorCopy(role, "fixture.md"), /AI/);

  // 能力段说的是能帮上什么忙，不是"我是谁"——同一条锚点不该被套到这里，
  // 否则改文案的人会被一条与本节无关的规则挡住。
  const noAnchorInCapabilities = VALID.replace("我能帮忙协调。", "我能帮忙协调家里的事。");
  assert.doesNotThrow(() => parseCoordinatorCopy(noAnchorInCapabilities, "fixture.md"));
});

console.log(`\ncoordinator copy：${passed} 项检查全部通过`);
