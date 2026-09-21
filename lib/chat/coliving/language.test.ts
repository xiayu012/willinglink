/**
 * 轮次语言闸（`language.ts`）与它在**功能 / 自称问答及其兜底**里的贯通：纯 Node 单测。
 *
 * 运行：
 *   `NODE_OPTIONS=--conditions=react-server pnpm.cmd exec tsx lib/chat/coliving/language.test.ts`
 *
 * （功能问答链路 import 了 `feature-llm.ts`，后者带 `server-only`，需要 react-server 条件。）
 *
 * **不调 LLM、不连 DB、不发送**：只跑纯函数 + 一个把调用参数记下来的离线 mock。
 *
 * 覆盖（对应任务要求）：
 * - **英文自称问句**：`What does this AI do?` 必须被认成自称问句、走进问答，且兜底用的是
 *   **既有的英文事实措辞**（`COORDINATOR_ROLE_NOTE_EN`），不是中文那段；
 * - **中文一字不动**：同一入口的中文问句仍回中文事实（`COORDINATOR_ROLE_NOTE`）；
 * - **歧义 / 中英混写的回退**：原话定不了时按**会话里最近判得出来的那一条**定，
 *   都读不出来才落默认中文；`direct` 为 null 表示"这一轮的依据不是原话"；
 * - **贯通**：正文上限、模型硬指令、代码兜底都读**轮次判定**（含回退），
 *   不是各自拿这一句文本再推一遍——`"ok"` 单看是定不了的，但回退能定；
 * - **判定差遣**：`direct` 与回退给模型的措辞不同（不谎称原话就是那种语言），正文一字不差；
 * - **观测不带正文**：`observeLanguage` 只记判定与来源。
 */

import assert from "node:assert/strict";
import { blacklistedCapabilityById, blacklistedReply } from "./blacklist";
import {
  asksAboutSelf,
  featureQaFallback,
  featureQaMaxChars,
  isFeatureQaQuestion,
  runFeatureQa,
  FEATURE_QA_MAX_CHARS,
  FEATURE_QA_MAX_CHARS_EN,
  FEATURE_QA_NAME,
} from "./feature-qa";
import {
  COORDINATOR_ROLE_NOTE,
  COORDINATOR_ROLE_NOTE_EN,
  FULL_FLOW_NOTE,
} from "./feature-facts";
import {
  EMPTY_FEATURE_USAGE,
  type FeatureCallBase,
  type FeatureLlm,
} from "./feature-llm";
import {
  classifyDirectLanguage,
  decideLanguage,
  languageInstruction,
  observeLanguage,
} from "./language";
import { REPLY_ONLY_FALLBACK, REPLY_ONLY_FALLBACK_EN, replyOnlyFallback } from "./reply-only";

/** 与 `APPROVED_FEATURES` 同形的最小型夹具（只用来跑纯函数，不引功能模块）。 */
const OPEN_FEATURES = [
  { id: "personal_item", label: "个人物品使用提醒" },
  { id: "night_laundry", label: "夜间洗衣提醒" },
] as const;
const OPEN_LABELS = OPEN_FEATURES.map((f) => f.label);

/** 英文住户问句（任务点名的那一句）与它的中文对照。 */
const EN_SELF_INTRO_QUESTION = "What does this AI do?";
const ZH_SELF_INTRO_QUESTION = "你是谁？";

/** 一条**只有拉丁词**的住户原话（`decideLanguage` 会判成 direct en）。 */
const EN_TURN = "Could you remind Alex not to run the dryer after 10 tonight?";
/** 一条**中英混写**的住户原话：有汉字、拉丁词又够多 → 原话定不了（歧义）。 */
const MIXED_TURN = "帮我把 dryer 关掉然后 tell Alex 一声";
/** 一条**读不出语言**的原话：没有汉字、拉丁词也不够。 */
const BARE_OK = "ok";

/** 会话里最近的那条能定语言的历史（旧→新）。 */
const EN_HISTORY = [
  { role: "user" as const, content: "阿川，晚上十点后别用烘干机。" },
  { role: "assistant" as const, content: "Sure — I've asked Achuan to avoid the dryer after 10pm." },
];
const ZH_HISTORY = [
  { role: "user" as const, content: EN_TURN },
  { role: "assistant" as const, content: "好，已经提醒阿川了，让他晚上十点后别用烘干机。" },
];

/** 只记调用参数、按 `name` 返回预置文本的离线 mock（解析 / 校验照跑）。 */
function mockFeatureLlm(texts: Record<string, string>): {
  llm: FeatureLlm;
  calls: Array<Pick<FeatureCallBase, "name" | "system" | "user" | "language">>;
} {
  const calls: Array<Pick<FeatureCallBase, "name" | "system" | "user" | "language">> = [];
  return {
    calls,
    llm: {
      async generate(call: FeatureCallBase) {
        calls.push({
          name: call.name,
          system: call.system,
          user: call.user,
          language: call.language,
        });
        if (!(call.name in texts)) {
          throw new Error(`mock FeatureLlm 收到未预置的调用：${call.name}`);
        }
        return { text: texts[call.name], usage: { ...EMPTY_FEATURE_USAGE } };
      },
    },
  };
}

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** 英文自称正文（含身份锚点 AI + 全功能名 + 完整流程那条）。 */
const EN_SELF_INTRO_REPLY =
  "I'm the AI coordinator for this house — not a person, not the landlord. I've got " +
  `dedicated shortcuts for ${OPEN_LABELS.join(" and ")}, which run faster and cheaper; ` +
  "anything else that needs coordinating between the people who live here goes through " +
  "the full coordination flow, so it's not that I can't do it.";

/** 中文自称正文（口径与扩展英文之前一字不差）。 */
const ZH_SELF_INTRO_REPLY =
  `我是这套房子的 AI 协调员，不是真人也不是管理员。我目前对${OPEN_LABELS.join("、")}` +
  `有专门优化，处理起来更快、更省；其它需要协调同住人的请求，会走完整的协调流程来处理，不是做不到。`;

async function main(): Promise<void> {
  console.log("language gate（轮次语言闸）");

  await check("原话能定就按原话定；中英混写 / 读不出来的原话定不了（返回 null，不猜）", () => {
    assert.equal(classifyDirectLanguage(EN_TURN), "en");
    assert.equal(classifyDirectLanguage("提醒 Alex 晚上别洗衣服"), "zh", "有汉字、拉丁词少 = 中文");
    assert.equal(classifyDirectLanguage(BARE_OK), null, "一个 'ok' 不足以证明在说英文");
    assert.equal(classifyDirectLanguage("Ah Chuan 2026-09-20 22:00"), null, "人名 + 数字不算英文");
    assert.equal(classifyDirectLanguage(MIXED_TURN), null, "中英混写 = 歧义，不就地猜");
  });

  await check("歧义原话回退读会话里最近的、判得出来的那一条；都读不出来才落默认中文", () => {
    const en = decideLanguage(BARE_OK, EN_HISTORY);
    assert.equal(en.language, "en");
    assert.equal(en.source, "conversation-fallback");
    assert.equal(en.direct, null, "direct=null 就是「这一轮的依据不是原话」");

    const zh = decideLanguage(BARE_OK, ZH_HISTORY);
    assert.equal(zh.language, "zh");
    assert.equal(zh.source, "conversation-fallback");

    // 最近的那条优先：英文历史在前、中文历史在后 → 取中文。
    const newestWins = decideLanguage(BARE_OK, [
      { role: "assistant", content: EN_HISTORY[1].content },
      { role: "user", content: "好" },
    ]);
    assert.equal(newestWins.language, "zh", "越近越能代表他现在在说哪种语言");

    const none = decideLanguage(BARE_OK, []);
    assert.equal(none.language, "zh");
    assert.equal(none.source, "default");
    assert.equal(none.direct, null);
    // 会话里全是读不出来的条目 → 也是默认，不硬凑一个来源。
    const unreadable = decideLanguage(BARE_OK, [
      { role: "user", content: "ok" },
      { role: "assistant", content: "2026-09-20 22:00" },
    ]);
    assert.equal(unreadable.source, "default");
  });

  await check("中英混写的原话：判定的依据在会话回退，不在这一句的字面", () => {
    assert.equal(decideLanguage(MIXED_TURN, EN_HISTORY).language, "en");
    assert.equal(decideLanguage(MIXED_TURN, ZH_HISTORY).language, "zh");
    assert.equal(
      decideLanguage(MIXED_TURN, []).language,
      "zh",
      "读不出来就落默认中文，与加这个闸之前逐字一致"
    );
  });

  await check("原话判定与回退判定给模型的措辞不同，但正文一字不差（不谎称原话就是那种语言）", () => {
    const direct = languageInstruction(decideLanguage(EN_TURN));
    const fallback = languageInstruction(decideLanguage(BARE_OK, EN_HISTORY));
    assert.match(direct, /The resident wrote in English\./);
    assert.match(fallback, /This conversation is in English\./);
    assert.doesNotMatch(fallback, /The resident wrote in English\./);
    // 除那句归属外，两种说法的正文一字不差。
    assert.equal(
      direct.replace("The resident wrote in English. ", ""),
      fallback.replace("This conversation is in English. ", "")
    );
    assert.match(languageInstruction(decideLanguage("提醒 Alex 晚上别用烘干机")), /自然中文/);
  });

  await check("语言观测只记判定与来源，不带任何正文", () => {
    const observed = observeLanguage(decideLanguage(BARE_OK, EN_HISTORY));
    assert.deepEqual(observed, { language: "en", source: "conversation-fallback" });
    assert.deepEqual(Object.keys(observed).sort(), ["language", "source"]);
  });

  await check("英文自称问句被认出来并走进功能问答（不是落回普通对话）", () => {
    assert.equal(asksAboutSelf(EN_SELF_INTRO_QUESTION), true);
    assert.equal(isFeatureQaQuestion(EN_SELF_INTRO_QUESTION), true);
    // 名词必须出现才认：太泛的「what does this do」不认，宁可漏掉。
    assert.equal(asksAboutSelf("What does this do?"), false);
    // 中文口径不受影响。
    assert.equal(asksAboutSelf(ZH_SELF_INTRO_QUESTION), true);
  });

  await check("英文自称兜底用既有的英文事实措辞；中文问句仍回中文事实", () => {
    const en = featureQaFallback({
      question: EN_SELF_INTRO_QUESTION,
      openFeatures: OPEN_FEATURES,
    });
    assert(en.includes(COORDINATOR_ROLE_NOTE_EN), "必须用既有英文身份事实");
    assert(en.includes("AI"), "不冒充真人：AI 两字不能省");
    assert(
      OPEN_LABELS.every((l) => en.includes(l)),
      "功能名照旧原样引用老板登记的原话（不另翻一份）"
    );
    assert(!en.includes(COORDINATOR_ROLE_NOTE), "不得混进中文身份事实");

    const zh = featureQaFallback({
      question: ZH_SELF_INTRO_QUESTION,
      openFeatures: OPEN_FEATURES,
    });
    assert(zh.includes(COORDINATOR_ROLE_NOTE));
    assert(zh.includes(FULL_FLOW_NOTE));
    assert(!zh.includes(COORDINATOR_ROLE_NOTE_EN), "中文问句不得回英文事实");
  });

  await check("正文上限 / 兜底 / 发给模型的硬指令都读轮次判定（含会话回退），不是各自再推一次", async () => {
    const fallbackDecision = decideLanguage(BARE_OK, EN_HISTORY);
    assert.equal(fallbackDecision.language, "en");

    // 这一句 `"ok"` 单看是定不了的（默认中文上限），回退判定说了算 → 英文上限。
    assert.equal(featureQaMaxChars(BARE_OK), FEATURE_QA_MAX_CHARS, "缺省仍按原话现推（逐字兼容）");
    assert.equal(featureQaMaxChars(BARE_OK, fallbackDecision), FEATURE_QA_MAX_CHARS_EN);

    // 兜底同理：`"ok"` 本身推不出英文，但回退判定能让兜底说英文。
    const enFallback = featureQaFallback({
      question: BARE_OK,
      openFeatures: OPEN_FEATURES,
      language: fallbackDecision,
    });
    assert(enFallback.includes("full coordination flow"));
    assert(!enFallback.includes(FULL_FLOW_NOTE));
    assert(
      featureQaFallback({ question: BARE_OK, openFeatures: OPEN_FEATURES }).includes(FULL_FLOW_NOTE),
      "没有轮次判定时按原话现推：中文兜底一字不动"
    );

    // 模型那侧：英文自称问句拿到的硬指令是英文那条。
    const en = mockFeatureLlm({ [FEATURE_QA_NAME]: JSON.stringify({ reply: EN_SELF_INTRO_REPLY }) });
    const enQa = await runFeatureQa({
      text: EN_SELF_INTRO_QUESTION,
      openFeatures: OPEN_FEATURES,
      language: decideLanguage(EN_SELF_INTRO_QUESTION),
      llm: en.llm,
    });
    assert(enQa, "英文自称问句必须进功能问答");
    assert.equal(enQa!.reply, EN_SELF_INTRO_REPLY, "含身份 + 全功能 + 完整流程的英文正文要原样接受");
    assert(!("error" in enQa!), `英文正文不得被误换兜底：${JSON.stringify(enQa)}`);
    assert.equal(en.calls.length, 1, "自称问答只花一次模型调用");
    // 模型那侧的语言硬指令由 `feature-llm.ts` 用这个判定拼出来（`call.system` 是拼之前
    // 的原文，mock 拿到的是未追加的那份）：断言判定本身确实传到了调用上。
    assert.equal(en.calls[0].language?.language, "en");
    assert.equal(en.calls[0].language?.source, "direct");
    assert.match(languageInstruction(en.calls[0].language!), /natural, idiomatic English/);
    assert.equal(en.calls[0].user, EN_SELF_INTRO_QUESTION);

    // 中文问句照旧：中文硬指令 + 中文正文原样接受。
    const zh = mockFeatureLlm({ [FEATURE_QA_NAME]: JSON.stringify({ reply: ZH_SELF_INTRO_REPLY }) });
    const zhQa = await runFeatureQa({
      text: ZH_SELF_INTRO_QUESTION,
      openFeatures: OPEN_FEATURES,
      language: decideLanguage(ZH_SELF_INTRO_QUESTION),
      llm: zh.llm,
    });
    assert.equal(zhQa!.reply, ZH_SELF_INTRO_REPLY);
    assert(!("error" in zhQa!));
    assert.equal(zh.calls[0].language?.language, "zh");
    assert.match(languageInstruction(zh.calls[0].language!), /自然中文/);
  });

  await check("代码写死的兜底跟随判定：黑名单真话与 reply_only 兜底都按轮次语言说", () => {
    const drainHair = blacklistedCapabilityById(
      "ask-named-roommate-clean-shower-drain-hair"
    );
    assert(drainHair, "夹具：黑名单那一项必须还在");
    const zh = blacklistedReply(drainHair!);
    const en = blacklistedReply(drainHair!, "en");
    assert.notEqual(en, zh);
    assert(en.includes(drainHair!.label) && en.includes(drainHair!.reason));
    assert(zh.includes(drainHair!.label) && zh.includes(drainHair!.reason));

    assert.equal(replyOnlyFallback(), REPLY_ONLY_FALLBACK, "缺省中文一字不动");
    assert.equal(replyOnlyFallback("zh"), REPLY_ONLY_FALLBACK);
    assert.equal(replyOnlyFallback("en"), REPLY_ONLY_FALLBACK_EN);
  });

  console.log(`\nlanguage gate：${passed} 项检查全部通过`);
}

/** 小包装：让「缺省 = 中文」这条显式出现在断言里。 */
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
