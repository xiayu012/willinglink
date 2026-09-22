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
 * - **短英文原话表驱动矩阵**：`introduce yourself` 这类**只有一两个词**的英文短句必须由
 *   原话直接判成英文（`direct`），并且真的走通「认出 → 功能问答 → **既有英文事实**
 *   （`COORDINATOR_ROLE_NOTE_EN`）」；人名 / 号码 / 日期 / 短标签 / 单个 `ok` 继续是
 *   歧义，落会话回退 / 默认中文——这是本文件新增的核心回归；
 * - **英文里夹中文人名**（本轮新增）：`小五 always messes up the kitchen…` 这条 2026-09-21
 *   生产事故原话必须**按原话直接判成英文**（`direct`），**压过中文会话历史**；边界由
 *   「拉丁词 ≥ 8 且 ≥ 汉字 3 倍」的合成比例判，不够就退回**歧义**、绝不就地猜；
 * - **英文自称问句**：`What does this AI do?` 必须被认成自称问句、走进问答，且兜底用的是
 *   **既有的英文事实措辞**（`COORDINATOR_ROLE_NOTE_EN`），不是中文那段；
 * - **中文一字不动**：同一入口的中文问句仍回中文事实（`COORDINATOR_ROLE_NOTE`）；
 * - **歧义 / 中英混写的回退**：原话定不了时按**会话里最近判得出来的那一条**定，
 *   都读不出来才落默认中文；`direct` 为 null 表示"这一轮的依据不是原话"；
 * - **贯通**：正文上限、模型硬指令、代码兜底都读**轮次判定**（含回退），
 *   不是各自拿这一句文本再推一遍——`"ok"` 单看是定不了的，但回退能定；
 * - **判定差遣**：`direct` 与回退给模型的措辞不同（不谎称原话就是那种语言），正文一字不差；
 * - **观测不带正文**：`observeLanguage` 只记判定与来源；
 * - **功能名的本地化显示名**（本文件第二轮新增）：`introduce yourself` 的**完整兜底正文里
 *   一个汉字都没有**，且两个功能的**英文显示名**都在；英文轮次交给模型的事实包与
 *   grounding 校验认的是**同一份**英文显示名（写中文登记名的英文正文判不通过），
 *   中文轮次的登记名与既有断言一字不动。
 */

import assert from "node:assert/strict";
import { blacklistedCapabilityById, blacklistedReply } from "./blacklist";
import {
  asksAboutSelf,
  asksWhatIsAvailable,
  featureQaFallback,
  featureQaMaxChars,
  findUngroundedFeatureQaFacts,
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
  blacklistFact,
  buildFeatureQaFacts,
  featureDisplayName,
} from "./feature-facts";
import {
  EMPTY_FEATURE_USAGE,
  type FeatureCallBase,
  type FeatureLlm,
} from "./feature-llm";
import {
  classifyDirectLanguage,
  containsHan,
  decideLanguage,
  isExplicitEnglishShortUtterance,
  languageInstruction,
  observeLanguage,
  type LanguageSource,
  type ResidentLanguage,
} from "./language";
import { REPLY_ONLY_FALLBACK, REPLY_ONLY_FALLBACK_EN, replyOnlyFallback } from "./reply-only";

/**
 * 与 `APPROVED_FEATURES` 同形的最小型夹具（只用来跑纯函数，不引功能模块）。
 * **两个显示名都带**：`label` 是老板登记的中文名（台账 / 中文正文），`labelEn` 是
 * 只在住户说英文时用的自然英文显示名——这正是本文件第二轮要钉住的机制。
 */
const OPEN_FEATURES = [
  { id: "personal_item", label: "个人物品使用提醒", labelEn: "personal item reminder" },
  { id: "night_laundry", label: "夜间洗衣提醒", labelEn: "night-time laundry reminder" },
] as const;
const OPEN_LABELS = OPEN_FEATURES.map((f) => f.label);
const OPEN_LABELS_EN = OPEN_FEATURES.map((f) => f.labelEn);

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

/**
 * ── 任务点名的**六句短英文自称问句**（只有 `introduce yourself` 真的掉了词数下限）──
 *
 * 每一句都必须走通同一条链路：`asksAboutSelf` 认出 → `isFeatureQaQuestion` 进问答 →
 * `decideLanguage` 判成英文 → 兜底给的是**既有的那段英文事实**。
 */
const SELF_INTRO_SHORT_UTTERANCES = [
  "introduce yourself",
  "who are you",
  "what are you",
  "tell me about yourself",
  "how do you work",
  "what can you do",
] as const;

/**
 * ── 表驱动矩阵：**一句话 → 轮次判定**（一律空历史，逼原话自己给出判定）──────
 *
 * 正例行是「整句就是一句英文短话」的那一档：`introduce yourself` 两词，正是任务里
 * 复现出来的真实故障（两词 < 三个词的下限 → 原话定不了 → 无历史 → 默认中文 →
 * 英文住户收到中文自我介绍）。
 *
 * **负例行是同一个 bug 的另一半**：修词数下限最容易的错法是把「短拉丁串」一律当英文，
 * 于是人名、号码、日期、`Wi-Fi` 这种短标签和住户随手回的一个 `ok` 都会把回复语言
 * 翻成英文。每一行都钉住「它**没有**被翻过去」。
 */
const LANGUAGE_MATRIX: readonly {
  text: string;
  language: ResidentLanguage;
  source: LanguageSource;
  note: string;
}[] = [
  // —— 短英文自称 / 元问题：原话自己就定得了 ——
  { text: "introduce yourself", language: "en", source: "direct", note: "两词，任务里的真实故障" },
  { text: "Introduce yourself!", language: "en", source: "direct", note: "首字母大写 + 句尾叹号，同一条" },
  { text: "who are you", language: "en", source: "direct", note: "自称短问句" },
  { text: "what are you", language: "en", source: "direct", note: "自称短问句" },
  { text: "tell me about yourself", language: "en", source: "direct", note: "自称短问句" },
  { text: "how do you work", language: "en", source: "direct", note: "自称短问句" },
  { text: "what can you do", language: "en", source: "direct", note: "自称短问句" },
  { text: "what’s this?", language: "en", source: "direct", note: "弯撇号 + 问号仍要认出来" },
  // —— 两个词以上、整句是一句英文的招呼 / 确认 ——
  { text: "good morning", language: "en", source: "direct", note: "两词英文招呼" },
  { text: "thank you", language: "en", source: "direct", note: "两词英文道谢" },
  { text: "sounds good", language: "en", source: "direct", note: "两词英文确认" },

  // —— 英文句子里夹中文人名 / 一个汉字：汉字是**标识符**，这句话仍然是英文 ——
  // 第一行就是 2026-09-21 的生产事故原话（23 个拉丁词 + 2 个汉字）。
  {
    text: "小五 always messes up the kitchen and doesn't tidy up. You tell him to clean up the kitchen every time he finishes using it.",
    language: "en",
    source: "direct",
    note: "事故原话：英文句子 + 中文人名",
  },
  {
    text: "欧阳娜 always leaves the dishes in the sink after she cooks.",
    language: "en",
    source: "direct",
    note: "三个汉字的人名同样是零头，一样按英文判",
  },
  {
    text: "Alex said 好 and left the kitchen dirty after he finished cooking.",
    language: "en",
    source: "direct",
    note: "夹一个被引用的汉字仍算英文（拉丁词远多于汉字）",
  },

  // —— 负例：这些**不许**被当成英文（空历史 → 默认中文，不是 direct）——
  { text: "Mary", language: "zh", source: "default", note: "一个词的人名" },
  { text: "Ah Chuan", language: "zh", source: "default", note: "两个词的人名" },
  { text: "13800138000", language: "zh", source: "default", note: "电话号码" },
  { text: "+86 138 0013 8000", language: "zh", source: "default", note: "带国家码的电话号码" },
  { text: "2026-09-20", language: "zh", source: "default", note: "日期" },
  { text: "ok", language: "zh", source: "default", note: "孤零零一个 ok：中文住户也这么回，交给会话回退" },
  { text: "OK!", language: "zh", source: "default", note: "大写 + 叹号的 ok 同样不算英文" },
  { text: "yes", language: "zh", source: "default", note: "单词确认不收（单词原话一律留给会话回退）" },
  { text: "hi", language: "zh", source: "default", note: "单词招呼不收（中文住户也会打 hi）" },
  { text: "Wi-Fi", language: "zh", source: "default", note: "短拉丁标签，不是一句话" },
  { text: "Room 3B", language: "zh", source: "default", note: "短拉丁标签，不是一句话" },
  {
    text: "小五 always cleans the kitchen",
    language: "zh",
    source: "default",
    note: "汉字是零头但拉丁词只有 4 个：不够长，仍算歧义（不就地猜英文）",
  },
  {
    text: "小五总是把厨房搞得一团糟 and you tell him to clean the kitchen every time he finishes using it",
    language: "zh",
    source: "default",
    note: "汉字不是零头（拉丁词不到汉字的 3 倍）= 真中英混写，仍算歧义",
  },
  {
    text: MIXED_TURN,
    language: "zh",
    source: "default",
    note: "中英各半，同样落歧义——合成比例判据不得把它翻成英文",
  },

  // —— 中文：同一入口中文口径一字不动 ——
  { text: "你是谁？", language: "zh", source: "direct", note: "中文自称问句" },
  { text: "介绍你自己", language: "zh", source: "direct", note: "中文自称问句" },
  { text: "提醒 Alex 晚上别用烘干机", language: "zh", source: "direct", note: "中文 + 一个英文人名仍算中文" },
  { text: "ok 那就这样", language: "zh", source: "direct", note: "中文句首一个 ok 不改判定" },
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

/** 英文自称正文（含身份锚点 AI + 两个**英文显示名** + 完整流程那条，通篇无汉字）。 */
const EN_SELF_INTRO_REPLY =
  "I'm the AI coordinator for this house — not a person, not the landlord. I handle " +
  `${OPEN_LABELS_EN.join(" and ")}, which run faster and cheaper; ` +
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

  await check("表驱动矩阵：短英文整句按原话定；人名 / 号码 / 日期 / 短标签 / 单词仍不行", () => {
    for (const row of LANGUAGE_MATRIX) {
      const d = decideLanguage(row.text);
      assert.equal(d.language, row.language, `「${row.text}」语言判错（${row.note}）`);
      assert.equal(d.source, row.source, `「${row.text}」判定来源错（${row.note}）`);
      assert.equal(
        d.direct,
        row.source === "direct" ? row.language : null,
        `「${row.text}」direct 字段与来源不一致（${row.note}）`
      );
    }
    // 矩阵必须真的两种语言、两种来源都覆盖到，否则这条检查是空转。
    assert.deepEqual(
      [...new Set(LANGUAGE_MATRIX.map((r) => r.language))].sort(),
      ["en", "zh"],
      "矩阵必须覆盖两种语言"
    );
    assert.ok(
      LANGUAGE_MATRIX.some((r) => r.source === "direct") &&
        LANGUAGE_MATRIX.some((r) => r.source === "default"),
      "矩阵必须同时覆盖 direct 与 default"
    );
  });

  /**
   * ── 英文句子里夹中文人名：**原话的判定必须压过中文会话历史** ──────────────────
   *
   * 2026-09-21 生产事故：住户通篇写英文、只把人名写成汉字，会话线是中文的。老口径
   * 「有汉字 + 拉丁词够多 = 歧义」→ 回退读会话里最近那条 → **中文**，于是英文住户
   * 收到一段中文回复。这条检查把三件事一起钉住：
   *
   * 1. **依据是原话**（`source: "direct"`），不是会话回退——这正是「当前这条原话的
   *    主要语言优先于中文姓名、房子标签与更早的中文历史」；
   * 2. **门槛是构成比例，不是关键词**：拉丁词数与汉字数的两个条件各自都能单独否决，
   *    下面用只违反其中一条的两个句子分别验证；
   * 3. **反例仍然是歧义**：真中英混写、或英文证据不够长的句子，`direct` 必须是
   *    `null`（回退会话），不得就地猜成英文。
   */
  await check("英文里夹中文人名：原话直接判英文并压过中文历史；比例不够就退回歧义", () => {
    /** 事故原话：23 个拉丁词 + 2 个汉字（人名「小五」）。 */
    const ACCIDENT =
      "小五 always messes up the kitchen and doesn't tidy up. " +
      "You tell him to clean up the kitchen every time he finishes using it.";

    // ① 会话历史**全中文**，原话仍然自己就能定 —— 判定依据是原话，不是历史。
    const withChineseHistory = decideLanguage(ACCIDENT, ZH_HISTORY);
    assert.equal(withChineseHistory.language, "en");
    assert.equal(withChineseHistory.source, "direct", "依据必须是原话，不能是会话回退");
    assert.equal(withChineseHistory.direct, "en");
    // 对照：老口径会走会话回退、判成中文——把这条历史留着，正是为了证明原话赢在它前面。
    assert.equal(
      decideLanguage(BARE_OK, ZH_HISTORY).language,
      "zh",
      "夹具：这份历史确实是中文的（所以①的 en 只能来自原话）"
    );

    // ② 门槛的两条各自都能单独否决（用只违反其中一条的句子验证，不是同一句话两遍）。
    //    只差「够长」：汉字 2 个、比例够，但拉丁词只有 7 个。
    const tooShort = "小五 always cleans the kitchen and the stove";
    assert.equal(classifyDirectLanguage(tooShort), null, "拉丁词不够 8 个 → 不判英文");
    //    只差「比例」：拉丁词 10 个（够长），但汉字 4 个，不到 3 倍。
    const tooMuchHan = "小五总是 always leaves the dishes there in the sink after cooking";
    assert.equal(classifyDirectLanguage(tooMuchHan), null, "汉字不是零头 → 不判英文");
    //    两条都过：汉字 2 个、拉丁词 9 个。
    const justEnough = "小五 always cleans the kitchen and stove after he cooks";
    assert.equal(classifyDirectLanguage(justEnough), "en", "两条都过 → 判英文");

    // ③ 反例：真中英混写与「英文证据不够长」仍然是歧义，不回退成英文。
    for (const mixed of [MIXED_TURN, tooShort, tooMuchHan]) {
      assert.equal(classifyDirectLanguage(mixed), null, `仍是歧义：${mixed}`);
    }

    // ④ 交给模型的硬指令跟着这条判定走：住户拿到的是「英文」那条，不是回退 / 默认。
    assert.match(
      languageInstruction(withChineseHistory),
      /The resident wrote in English\./
    );
  });

  await check("短英文清单是**整句相等**，不是关键词表（不靠包含匹配）", () => {
    // 整句相等 → 一个字不同就不匹配：人名 / 标签 / 「挂着一件别的事」的问句都不会被吞。
    assert.equal(isExplicitEnglishShortUtterance("introduce yourself to my roommate"), false);
    assert.equal(isExplicitEnglishShortUtterance("who are you exactly"), false);
    // 单独一个词不匹配——这正是「不是关键词表」的证据。
    assert.equal(isExplicitEnglishShortUtterance("introduce"), false);
    assert.equal(isExplicitEnglishShortUtterance("yourself"), false);
    // 人名 / 号码 / 日期 / 一个 ok / 带汉字 / 空串。
    assert.equal(isExplicitEnglishShortUtterance("Ah Chuan"), false);
    assert.equal(isExplicitEnglishShortUtterance("13800138000"), false);
    assert.equal(isExplicitEnglishShortUtterance("2026-09-20"), false);
    assert.equal(isExplicitEnglishShortUtterance(BARE_OK), false);
    assert.equal(isExplicitEnglishShortUtterance("你是谁"), false);
    assert.equal(isExplicitEnglishShortUtterance(""), false);
    // 归一化只动两端标点与大小写，不动任何一个实词。
    assert.equal(isExplicitEnglishShortUtterance("  INTRODUCE YOURSELF?  "), true);
    assert.equal(isExplicitEnglishShortUtterance("introduce yourself"), true);
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

  await check("英文自称兜底用既有的英文事实措辞与英文功能显示名；中文问句口径一字不动", () => {
    const en = featureQaFallback({
      question: EN_SELF_INTRO_QUESTION,
      openFeatures: OPEN_FEATURES,
    });
    assert(en.includes(COORDINATOR_ROLE_NOTE_EN), "必须用既有英文身份事实");
    assert(en.includes("AI"), "不冒充真人：AI 两字不能省");
    assert(
      OPEN_LABELS_EN.every((l) => en.includes(l)),
      "英文兜底要用英文显示名列全功能（不再是老板登记的中文原话）"
    );
    assert(
      !OPEN_LABELS.some((l) => en.includes(l)),
      "英文兜底不得夹带中文功能名——中英混排不是可接受的英文体验"
    );
    assert(!en.includes(COORDINATOR_ROLE_NOTE), "不得混进中文身份事实");

    const zh = featureQaFallback({
      question: ZH_SELF_INTRO_QUESTION,
      openFeatures: OPEN_FEATURES,
    });
    assert(zh.includes(COORDINATOR_ROLE_NOTE));
    assert(zh.includes(FULL_FLOW_NOTE));
    assert(OPEN_LABELS.every((l) => zh.includes(l)), "中文兜底仍用登记名");
    assert(!zh.includes(COORDINATOR_ROLE_NOTE_EN), "中文问句不得回英文事实");
  });

  await check("六句短英文自称问句真的走进功能问答，兜底一律是**既有英文事实**", async () => {
    for (const question of SELF_INTRO_SHORT_UTTERANCES) {
      const decision = decideLanguage(question);
      assert.equal(decision.language, "en", `「${question}」必须是英文轮次`);
      assert.equal(decision.source, "direct", `「${question}」的依据必须是原话`);
      assert.equal(asksAboutSelf(question), true, `「${question}」必须被认成自称问句`);
      assert.equal(isFeatureQaQuestion(question), true, `「${question}」必须进功能问答`);

      // ① 兜底本身（生产里 `turn.ts` 传的就是这个判定）。
      const fallback = featureQaFallback({
        question,
        openFeatures: OPEN_FEATURES,
        language: decision,
      });
      assert(fallback.includes(COORDINATOR_ROLE_NOTE_EN), `「${question}」兜底必须是既有英文身份事实`);
      assert(!fallback.includes(COORDINATOR_ROLE_NOTE), `「${question}」兜底不得回中文身份事实`);
      assert(fallback.includes("full coordination flow"), `「${question}」兜底要保留完整流程那条`);
      assert(
        OPEN_LABELS_EN.every((l) => fallback.includes(l)),
        `「${question}」兜底要列全专门优化功能的英文显示名`
      );

      // ② **真的跑一遍问答链路**：模型一个字都写不出来 → 真落到那个兜底上
      //    （不是假设"应该会落到"，是让 `runFeatureQa` 走完整条路）。
      const { llm, calls } = mockFeatureLlm({
        [FEATURE_QA_NAME]: JSON.stringify({ reply: "" }),
      });
      const qa = await runFeatureQa({
        text: question,
        openFeatures: OPEN_FEATURES,
        language: decision,
        llm,
      });
      assert(qa, `「${question}」必须进功能问答`);
      assert("error" in qa!, `「${question}」空正文必须被换掉，不得放出去`);
      assert.equal(qa!.reply, fallback, `「${question}」实际落到的兜底就是那句英文事实`);
      assert.equal(calls.length, 1, `「${question}」只花一次模型调用`);
      assert.equal(calls[0].language?.language, "en", `「${question}」模型那侧的硬指令也是英文`);
    }
  });

  await check("对照组：同样的兜底入口，中文问句仍回中文事实（没被英文口径带跑）", async () => {
    for (const question of ["你是谁？", "介绍你自己"]) {
      const decision = decideLanguage(question);
      assert.equal(decision.language, "zh", `「${question}」必须是中文轮次`);
      const fallback = featureQaFallback({
        question,
        openFeatures: OPEN_FEATURES,
        language: decision,
      });
      assert(fallback.includes(COORDINATOR_ROLE_NOTE), `「${question}」要回中文身份事实`);
      assert(!fallback.includes(COORDINATOR_ROLE_NOTE_EN), `「${question}」不得回英文身份事实`);
    }
  });

  await check("功能显示名按本轮语言取：中文登记名 / 英文显示名，同一个函数一处取", () => {
    const [personalItem, nightLaundry] = OPEN_FEATURES;
    assert.equal(featureDisplayName(personalItem, "zh"), OPEN_LABELS[0]);
    assert.equal(featureDisplayName(nightLaundry, "zh"), OPEN_LABELS[1]);
    assert.equal(featureDisplayName(personalItem, "en"), OPEN_LABELS_EN[0]);
    assert.equal(featureDisplayName(nightLaundry, "en"), OPEN_LABELS_EN[1]);
    // 两个名字都是登记好的数据，不是现翻的：英文显示名里不许有汉字。
    for (const name of OPEN_LABELS_EN) {
      assert.equal(containsHan(name), false, `英文显示名不得含汉字：${name}`);
    }
  });

  await check("『introduce yourself』的完整兜底正文里一个汉字都没有，且两个英文显示名都在", () => {
    const question = "introduce yourself";
    const decision = decideLanguage(question);
    assert.equal(decision.language, "en");
    assert.equal(decision.source, "direct");

    const fb = featureQaFallback({
      question,
      openFeatures: OPEN_FEATURES,
      language: decision,
    });
    // 这一条是**整段正文**的断言：英文住户拿到的兜底里不许出现任何汉字（身份、功能名、
    // 完整流程那条都算在内）。
    assert.equal(containsHan(fb), false, `英文兜底里不许有汉字：${fb}`);
    for (const name of OPEN_LABELS_EN) {
      assert(fb.includes(name), `英文兜底必须含英文显示名：${name}`);
    }
    for (const label of OPEN_LABELS) {
      assert(!fb.includes(label), `英文兜底不得夹带中文登记名：${label}`);
    }
    assert(fb.includes(COORDINATOR_ROLE_NOTE_EN), "英文兜底仍用既有英文身份事实");
    assert(fb.includes("full coordination flow"), "英文兜底仍保留完整流程那条");
    assert(fb.includes("AI"), "不冒充真人：AI 两字不能省");

    // 同一个入口的中文问句：仍是登记名，口径一字不动。
    const zhDecision = decideLanguage("介绍你自己");
    const zhFb = featureQaFallback({
      question: "介绍你自己",
      openFeatures: OPEN_FEATURES,
      language: zhDecision,
    });
    assert.equal(containsHan(zhFb), true, "中文兜底本来就是中文");
    for (const label of OPEN_LABELS) {
      assert(zhFb.includes(label), `中文兜底仍用登记名：${label}`);
    }
    for (const name of OPEN_LABELS_EN) {
      assert(!zhFb.includes(name), `中文兜底不得冒出英文显示名：${name}`);
    }
  });

  await check("英文轮次的事实包与 grounding 认英文显示名；写中文登记名的英文正文判不通过", async () => {
    const question = "introduce yourself";
    const decision = decideLanguage(question);

    // ① 交给模型的那份事实包按本轮语言取显示名。
    const enBundle = buildFeatureQaFacts({
      openFeatures: OPEN_FEATURES,
      question,
      selfIntro: true,
      language: decision,
    });
    assert.deepEqual(
      enBundle.openFeatures.map((f) => f.displayName),
      [...OPEN_LABELS_EN],
      "英文事实包只给英文显示名（不把中文名丢给模型自己译）"
    );
    const zhBundle = buildFeatureQaFacts({
      openFeatures: OPEN_FEATURES,
      question: "介绍你自己",
      selfIntro: true,
      language: decideLanguage("介绍你自己"),
    });
    assert.deepEqual(
      zhBundle.openFeatures.map((f) => f.displayName),
      [...OPEN_LABELS],
      "中文事实包仍只给登记名，一字不动"
    );

    // ② grounding 与兜底读的是同一个名字：英文事实包认英文名，中文名判缺。
    const enFb = featureQaFallback({
      question,
      openFeatures: OPEN_FEATURES,
      language: decision,
    });
    assert.deepEqual(
      findUngroundedFeatureQaFacts(enFb, enBundle, { requireOpenLabels: true }),
      [],
      "英文兜底自己必须过英文事实包的 grounding"
    );
    const mixedReply = enFb
      .replace(OPEN_LABELS_EN[0], OPEN_LABELS[0])
      .replace(OPEN_LABELS_EN[1], OPEN_LABELS[1]);
    assert.equal(
      findUngroundedFeatureQaFacts(mixedReply, enBundle, { requireOpenLabels: true }).length,
      2,
      "英文正文里写中文登记名 = 两项都算没列出来，必须判缺"
    );
    // 反过来：中文事实包不认英文显示名（两边各认各的名字，不互相放过）。
    assert.equal(
      findUngroundedFeatureQaFacts(enFb, zhBundle, { requireOpenLabels: true }).length,
      2,
      "中文事实包不认英文显示名"
    );

    // ③ 真的跑一遍问答：英文名正文接受；夹中文名的英文正文回落兜底。
    const ok = mockFeatureLlm({
      [FEATURE_QA_NAME]: JSON.stringify({ reply: EN_SELF_INTRO_REPLY }),
    });
    const okQa = await runFeatureQa({
      text: question,
      openFeatures: OPEN_FEATURES,
      language: decision,
      llm: ok.llm,
    });
    assert.equal(okQa!.reply, EN_SELF_INTRO_REPLY, "全英文正文必须原样接受");
    assert(!("error" in okQa!));
    assert(
      OPEN_LABELS_EN.every((n) => ok.calls[0].system.includes(n)) &&
        !OPEN_LABELS.some((l) => ok.calls[0].system.includes(l)),
      "英文轮次给模型的事实清单里只有英文显示名"
    );

    const mixed = mockFeatureLlm({
      [FEATURE_QA_NAME]: JSON.stringify({ reply: mixedReply }),
    });
    const mixedQa = await runFeatureQa({
      text: question,
      openFeatures: OPEN_FEATURES,
      language: decision,
      llm: mixed.llm,
    });
    assert.equal(mixedQa!.reply, enFb, "夹中文功能名的英文正文必须换成纯英文兜底");
    assert(mixedQa!.error, "回落时要把原因带出来");
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
    // 中文一字不动：仍是老板登记的原话与安全事实。
    assert(zh.includes(drainHair!.label) && zh.includes(drainHair!.reason));
    // 英文取的是**同一份登记的英文说法**：整句一个汉字都没有，名称与理由都在。
    // （原先这里钉的是 `en.includes(cap.label)`——那正是要修的中文泄漏，别再钉回去。）
    assert.equal(containsHan(en), false, `黑名单英文真话不得夹汉字：${en}`);
    assert(en.includes(drainHair!.labelEn) && en.includes(drainHair!.reasonEn));
    assert(!en.includes(drainHair!.label) && !en.includes(drainHair!.reason));

    assert.equal(replyOnlyFallback(), REPLY_ONLY_FALLBACK, "缺省中文一字不动");
    assert.equal(replyOnlyFallback("zh"), REPLY_ONLY_FALLBACK);
    assert.equal(replyOnlyFallback("en"), REPLY_ONLY_FALLBACK_EN);
  });

  /**
   * ── 表驱动：**「办不了」这条事实在两种语言下的贯通** ────────────────────────
   *
   * 每一行 = 一个住户问句 + 那一轮的轮次判定 + 引用（`referencedBlacklistedId`）。
   * 三件事一起钉住：
   *
   * 1. **名称、理由、grounding 锚点是同一次按语言取用的结果**（`blacklistFact`）——
   *    中文行取老板登记的中文原话，英文行取登记的英文说法；绝不出现"名称换成英文、
   *    理由还是中文"的半截英文；
   * 2. **代码兜底整段一个汉字都没有**（英文行）：英文住户被这条黑名单拒过、接着用英文
   *    追问「那你到底能做什么」时，兜底正文里夹中文名称 / 理由正是要修的；
   * 3. **grounding 用同一份锚点核对**：两种语言的兜底自己都必须判通过（否则每一句都会
   *    被换掉），而**英文句式 + 中文登记名**的正文必须判**不**通过——这条正是英文住户
   *    那个"永远过不了 grounding"的结构性 bug 的回归哨兵。
   *
   * 四行的语言来源刻意各不相同：direct（原话自己判得出）+ conversation-fallback
   * （住户只回一个 `ok`，依据在会话回退里，中英各一行）。
   */
  const BLACKLISTED_ID = "ask-named-roommate-clean-shower-drain-hair";
  const BLACKLIST_MATRIX: readonly {
    label: string;
    question: string;
    history: readonly { role: "user" | "assistant"; content: string }[];
    /** 问题本身带中文关键词 + 资格信号时走 `fromQuestion`，否则靠结构化引用回填 */
    referencedId: string | null;
    language: ResidentLanguage;
    source: LanguageSource;
  }[] = [
    {
      label: "中文 + 直接判定（问题本身就命中条目）",
      question: "为什么不能让他清理地漏的头发？",
      history: [],
      referencedId: null,
      language: "zh",
      source: "direct",
    },
    {
      label: "中文 + 会话回退（只回一个 ok）",
      question: BARE_OK,
      history: ZH_HISTORY,
      referencedId: BLACKLISTED_ID,
      language: "zh",
      source: "conversation-fallback",
    },
    {
      label: "英文 + 直接判定",
      question: "what can you do",
      history: [],
      referencedId: BLACKLISTED_ID,
      language: "en",
      source: "direct",
    },
    {
      label: "英文 + 会话回退（只回一个 ok）",
      question: BARE_OK,
      history: EN_HISTORY,
      referencedId: BLACKLISTED_ID,
      language: "en",
      source: "conversation-fallback",
    },
  ];

  await check("表驱动：黑名单事实的名称 / 理由 / 锚点 / 兜底正文都按轮次语言取同一份", () => {
    const drainHair = blacklistedCapabilityById(BLACKLISTED_ID);
    assert(drainHair, "夹具：黑名单那一项必须还在");
    for (const row of BLACKLIST_MATRIX) {
      const decision = decideLanguage(row.question, row.history);
      assert.equal(decision.language, row.language, `[${row.label}] 轮次语言`);
      assert.equal(decision.source, row.source, `[${row.label}] 判定来源`);

      // 1) 事实包：名称、理由、锚点三者同语言。
      const bundle = buildFeatureQaFacts({
        openFeatures: OPEN_FEATURES,
        question: row.question,
        referencedBlacklistedId: row.referencedId,
        selfIntro: asksAboutSelf(row.question),
        language: decision,
      });
      assert.equal(bundle.blacklisted.length, 1, `[${row.label}] 必须关联到那一条`);
      const fact = bundle.blacklisted[0];
      assert.equal(fact.id, BLACKLISTED_ID, `[${row.label}] 关联的是哪一条`);
      if (row.language === "en") {
        assert.equal(fact.displayName, drainHair!.labelEn, `[${row.label}] 英文显示名`);
        assert.equal(fact.reason, drainHair!.reasonEn, `[${row.label}] 英文理由`);
        assert.deepEqual(
          fact.reasonAnchors,
          drainHair!.validation.reasonAnchorsEn,
          `[${row.label}] 英文锚点`
        );
        assert.equal(containsHan(fact.displayName + fact.reason), false);
        for (const a of fact.reasonAnchors) assert.equal(containsHan(a), false);
      } else {
        assert.equal(fact.displayName, drainHair!.label, `[${row.label}] 中文登记名`);
        assert.equal(fact.reason, drainHair!.reason, `[${row.label}] 中文登记理由`);
        assert.deepEqual(
          fact.reasonAnchors,
          drainHair!.validation.reasonAnchors,
          `[${row.label}] 中文锚点`
        );
      }
      // `blacklistFact` 是唯一取用处：事实包里的三个字段必须与它逐字相同。
      assert.deepEqual(fact, blacklistFact(drainHair!, row.language), `[${row.label}] 取用一致`);

      // 2) 代码兜底：说住户这一轮的语言，英文行一个汉字都没有。
      const fallback = featureQaFallback({
        question: row.question,
        openFeatures: OPEN_FEATURES,
        referencedBlacklistedId: row.referencedId,
        language: decision,
      });
      assert(
        fallback.includes(fact.displayName),
        `[${row.label}] 兜底必须说出条目名称：${fallback}`
      );
      assert.equal(
        containsHan(fallback),
        row.language === "zh",
        `[${row.label}] 兜底正文的语言：${fallback}`
      );

      // 3) grounding：本语言的兜底必须判通过（否则每次都会被换掉）。
      assert.deepEqual(
        findUngroundedFeatureQaFacts(fallback, bundle, {
          requireOpenLabels: asksWhatIsAvailable(row.question) || asksAboutSelf(row.question),
        }),
        [],
        `[${row.label}] 自家兜底必须过 grounding：${fallback}`
      );
    }

    // 4) 回归哨兵：**英文轮次的事实包**喂一段中文兜底 → 必须判不通过（缺英文名 + 英文锚点）。
    const enDecision = decideLanguage("what can you do");
    const enBundle = buildFeatureQaFacts({
      openFeatures: OPEN_FEATURES,
      question: "what can you do",
      referencedBlacklistedId: BLACKLISTED_ID,
      selfIntro: true,
      language: enDecision,
    });
    const zhFallback = featureQaFallback({
      question: "你有什么功能？",
      openFeatures: OPEN_FEATURES,
      referencedBlacklistedId: BLACKLISTED_ID,
      language: decideLanguage("你有什么功能？"),
    });
    assert(
      findUngroundedFeatureQaFacts(zhFallback, enBundle, { requireOpenLabels: false }).length > 0,
      "英文轮次里出现中文登记名 / 中文锚点的正文必须判不通过"
    );
  });

  console.log(`\nlanguage gate：${passed} 项检查全部通过`);
}

/** 小包装：让「缺省 = 中文」这条显式出现在断言里。 */
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
