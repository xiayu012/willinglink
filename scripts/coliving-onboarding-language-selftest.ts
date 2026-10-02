/**
 * **首次接触（陌生号码第一句 `Hi` / `Hello`）的语言判定自检——零模型、零短信、零数据库。**
 *
 *   NODE_OPTIONS=--conditions=react-server pnpm exec tsx scripts/coliving-onboarding-language-selftest.ts
 *
 * 老板 2026-10-01 的口径：陌生号码第一句英文招呼，**介绍就该是英文**。而这条链路的
 * 判定全在语言闸里（`lib/chat/coliving/language.ts`）——`decideLanguage` 原本把
 * `hi` 当歧义、空历史又默认中文，于是英文住户第一次接触就收到一段中文介绍。
 * 这个脚本只钉住**语言闸这一层的判词**，不碰 onboarding / turn / repo：
 *
 *   1. **全新的 `Hi` / `Hello`（没有任何可用历史）→ 英文**，且来源是 `default`
 *      （不是 `direct`——一个词撑不起「原话自己就能定」）；
 *   2. **会话里已经看得出语言时，招呼语听会话的**：中文对话里回一个 `hi` 仍是中文；
 *   3. **不许把「一个拉丁词」整体当成英文**：`ok` / `yes` / `thanks` / 人名 / 号码 /
 *      短标签 / 日期在空历史下仍然是默认中文；
 *   4. **旧行为一字不动**：英文对话里的 `ok` 仍然英文，中文原话仍然中文。
 *
 * 这里**不调用任何模型**（不花钱、不需要 key）、**不发任何短信**、**不连数据库**；
 * 只 import 语言闸一个模块。语气好不好仍然证明不了——那要靠 `pnpm coliving-eval`
 * 的入门场景（`lib/chat/coliving/evals/scenarios/corpus-050-*`）。
 */
import assert from "node:assert/strict";

import {
  classifyDirectLanguage,
  containsHan,
  decideLanguage,
  isUnambiguousEnglishGreeting,
  languageInstruction,
} from "../lib/chat/coliving/language";

const checks: Array<[string, () => void]> = [];
const check = (name: string, fn: () => void) => checks.push([name, fn]);

/** 一轮历史：只有语言判定关心 role，内容随便给一条判得出来的话。 */
const ZH_HISTORY = [{ role: "user" as const, content: "提醒阿川晚上十点后别开洗衣机" }];
const EN_HISTORY = [
  { role: "user" as const, content: "please remind Alex not to use the dryer late" },
];

// ── 一、全新的英文招呼：空历史 → 英文 ──────────────────────────────────────
check("全新的 Hi / Hello / hey（没有任何历史）判成英文，来源是 default 不是 direct", () => {
  for (const text of ["Hi", "hi", "Hello", "HELLO", "hey", "Hi!", " hello ", "Hello!!"]) {
    const d = decideLanguage(text, []);
    assert.equal(d.language, "en", `「${text}」应当判成英文`);
    assert.equal(d.source, "default", `「${text}」不该谎称原话自己定得了语言`);
    assert.equal(d.direct, null, "`direct` 必须仍是 null：一个词撑不起原话判定");
  }
  // 历史是空的、或历史里一条都读不出来，都算「没有可用历史」。
  const unreadable = decideLanguage("Hi", [
    { role: "user", content: "ok" },
    { role: "assistant", content: "13800138000" },
  ]);
  assert.equal(unreadable.language, "en", "历史读不出语言时，招呼语照样定英文");
  assert.equal(unreadable.source, "default");
});

check("招呼语给出的是英文回复指令，且不含汉字", () => {
  const instruction = languageInstruction(decideLanguage("Hi", []));
  assert.ok(instruction.includes("English"), "英文轮次的指令要说英文");
  assert.equal(containsHan(instruction), false, "英文指令里不许夹汉字");
});

// ── 二、会话优先：有中文历史时，招呼语不回英文 ────────────────────────────
check("已有中文会话时，再来一个 hi / ok / yes 仍然走中文（招呼语听会话的）", () => {
  for (const text of ["hi", "ok", "yes", "Hello"]) {
    const d = decideLanguage(text, ZH_HISTORY);
    assert.equal(d.language, "zh", `中文会话里的「${text}」不该翻成英文`);
    assert.equal(d.source, "conversation-fallback", "依据是会话，不是默认值");
  }
  assert.equal(
    containsHan(languageInstruction(decideLanguage("hi", ZH_HISTORY))),
    true,
    "中文轮次仍然给中文指令"
  );
});

check("已有英文会话时，ok 仍然英文（旧行为一字不动）", () => {
  const d = decideLanguage("ok", EN_HISTORY);
  assert.equal(d.language, "en");
  assert.equal(d.source, "conversation-fallback");
  assert.equal(decideLanguage("hi", EN_HISTORY).language, "en");
  assert.equal(decideLanguage("hi", EN_HISTORY).source, "conversation-fallback");
});

// ── 三、不许把「一个拉丁词」整体当成英文 ──────────────────────────────────
check("空历史下，孤立的拉丁单词/人名/号码/短标签仍然是默认中文", () => {
  // 同一个词，中文住户也在打：`ok` / `yes` / `thanks` 不因为「是英文拼写」就翻成英文。
  const stillAmbiguous = [
    "ok",
    "OK!",
    "yes",
    "no",
    "thanks",
    "sure",
    "thanks!",
    "Mary",
    "Ah Chuan",
    "13800138000",
    "+86 138 0013 8000",
    "2026-09-20",
    "Wi-Fi",
    "Room 3B",
    "3B",
    "",
    "   ",
    "？？？",
  ];
  for (const text of stillAmbiguous) {
    const d = decideLanguage(text, []);
    assert.equal(d.language, "zh", `「${text}」没有证据说明是英文，必须留在默认中文`);
    assert.equal(d.source, "default", `「${text}」不该有别的依据`);
    assert.equal(
      isUnambiguousEnglishGreeting(text),
      false,
      `「${text}」不是招呼语，不许走招呼那条窄路`
    );
  }
});

check("招呼那条窄路只认整句，不做包含匹配（人名 / 标签结构上命中不了）", () => {
  assert.equal(isUnambiguousEnglishGreeting("hi"), true);
  assert.equal(isUnambiguousEnglishGreeting("Hello!"), true);
  assert.equal(isUnambiguousEnglishGreeting("hi there"), false, "两词的招呼走短句清单，不走这里");
  assert.equal(isUnambiguousEnglishGreeting("Hi, I'm Mary"), false, "整句不等就不算");
  assert.equal(isUnambiguousEnglishGreeting("say hi to Alex"), false, "包含匹配一律不收");
  assert.equal(isUnambiguousEnglishGreeting("HI-FI"), false, "标识符不是招呼");
  assert.equal(isUnambiguousEnglishGreeting("你好"), false, "有汉字就不是英文招呼");
  assert.equal(decideLanguage("你好", []).language, "zh", "中文招呼照旧中文");
  assert.equal(decideLanguage("你好", []).source, "direct");
});

// ── 四、原话判定侧没有被招呼语改动 ────────────────────────────────────────
check("classifyDirectLanguage 对孤立招呼语仍然是 null（歧义），不越权定 direct", () => {
  for (const text of ["hi", "Hello", "hey"]) {
    assert.equal(
      classifyDirectLanguage(text),
      null,
      `「${text}」必须仍是歧义：能定 direct 就会压过会话历史`
    );
  }
  // 旧口径的核心断言，一字不动：三个词以上的英文、中文、混写各归各位。
  assert.equal(
    classifyDirectLanguage("please remind Alex not to use the dryer late"),
    "en"
  );
  assert.equal(classifyDirectLanguage("提醒 Alex 晚上别洗衣"), "zh");
  assert.equal(classifyDirectLanguage("introduce yourself"), "en");
  assert.equal(classifyDirectLanguage("ok"), null);
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`✗ ${name}`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(
  failed === 0
    ? `\n首次接触语言自检：${checks.length} 项全过（零模型、零短信、零数据库）`
    : `\n首次接触语言自检：${failed}/${checks.length} 项失败`
);
process.exit(failed === 0 ? 0 : 1);
