/**
 * **住户语言闸——一轮只判一次，判完由代码一路带着走。**
 *
 * 住户写英文就该收到英文，写中文就该收到中文，包括「你是谁 / 你能做什么」这类
 * **自我介绍与功能问答**。难点不在模型那侧（给它一句语言指令它就会照做），而在
 * **代码那一侧的每一条确定性回复**：认不出的号码、简单肯定短路、功能回执兜底、
 * 「这件事我还没发出去」的真话说明、coordination 模板……每一处都是写死的中文短句。
 * 只把语言指令塞给模型、却让这些兜底继续说中文，等于住户问「what is this AI?」
 * 时收到一段中文——**语言这条路最常被代码兜底破坏**。
 *
 * 所以这里给出的是一个**类型化的轮次级判定**（`LanguageDecision`），而不是一个
 * 到处重算的纯函数：
 *
 * 1. **只在轮次边界判一次**（`decideLanguage`），判完作为一个值往下传；
 * 2. **原话能定就按原话定**（`source: "direct"`）——这是唯一有语义依据的一档；
 * 3. **原话定不了（中英混写、只有数字/名字/一个 "ok"）才回退**，回退读**同一条
 *    会话线上最近的、判得出来的**那一条（`source: "conversation-fallback"`）：
 *    保守、只看最近、读不出来就不猜；
 * 4. **连会话里也读不出来才用默认中文**（`source: "default"`）——与加这个闸之前
 *    的行为逐字一致，不会因为引入回退而改变任何既有语料的判定。
 *
 * **判据本身不做主题分类，也不看关键词表**：只数汉字与拉丁词，外加一小份
 * **整句相等**的短英文清单（`EXPLICIT_ENGLISH_SHORT_UTTERANCES`）。那份清单不是主题词表
 * ——它认的是「这一整句**就是**一句英文」这个事实，所以只做整句相等、不做包含匹配，
 * 人名 / 号码 / 日期 / 短标签结构上命中不了（见该常量的说明）。下游任何一处
 * 需要「用住户的语言」时都读这个判定，**不许再各写一套正则**（`reply-only.ts`
 * 曾经自己写过一个汉字正则，就是这条纪律的反例）。
 */

export type ResidentLanguage = "en" | "zh";

/**
 * 语言是从哪儿定出来的。**这是可观测性的一部分**：同一句英文，`direct` 和
 * `conversation-fallback` 是两件不同的事，排查「为什么这轮回了中文」时必须能分开。
 */
export type LanguageSource =
  /** 原话自己就能定（汉字 / 拉丁词的比例够明确） */
  | "direct"
  /** 原话定不了（中英混写、或只有数字 / 名字 / 一个 "ok"），读了会话里最近判得出来的那条 */
  | "conversation-fallback"
  /** 原话和会话都定不了，用默认（中文） */
  | "default";

/** 轮次语言判定。**一轮一个，从轮次边界往下传，中途不重算。** */
export type LanguageDecision = {
  language: ResidentLanguage;
  source: LanguageSource;
  /**
   * **原话自己的判定**；原话歧义（走了回退或默认）时为 `null`。
   * 留着它是为了可观测与排查：`direct: null` 就是「这一轮的依据不是原话」。
   */
  direct: ResidentLanguage | null;
};

const HAN = /[㐀-鿿]/g;
/** 同一个汉字字符类，非全局：只用来 `test`（全局正则会带 `lastIndex`，不适合 `test`）。 */
const HAS_HAN = /[㐀-鿿]/;
/** 拉丁词：允许 `don't` / `you’re` 这类撇号与连字符，一个词只算一个。 */
const LATIN_WORD = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;

/**
 * 一个词都不改的保守边界：**至少三个拉丁词**才算英文。
 * 少于三个（电话号码、一个人名、一句 "ok"）不足以证明这轮在说英文——这种原话
 * 归入「歧义」，交给会话回退去定，而不是就地猜。
 *
 * **唯一的例外**是下面那份短英文清单：`introduce yourself` 只有两个词，却是住户
 * 在问「你是谁」的一整句英文——那种原话自己就能定，不该掉进回退里。例外只对
 * **整句相等**的短句开放，词数下限本身没有放松。
 */
const ENGLISH_MIN_LATIN_WORDS = 3;

/**
 * **短英文原话的显式清单——整句相等才算，绝不做包含匹配。**
 *
 * 为什么需要它：住户写的英文短句常常只有一两个词，撞在三个词的下限之外。这不是
 * 假想的边界情况——**它已经真实发生过**：住户发 `introduce yourself`（两词）问
 * 「你是谁」，`asksAboutSelf` / `isFeatureQaQuestion` 都认出来了、走进了功能问答，
 * 可 `decideLanguage` 判成默认中文，于是英文住户收到一段中文自我介绍——修的正是
 * 语言闸本身，**不是给功能问答开一个局部特例**：所有短英文原话在这里一视同仁。
 *
 * 为什么是清单、不是关键词：**整句相等**是这里唯一安全的判据。任何一个字不同
 * （`introduce yourself to my roommate`）就不匹配，于是人名（`Ah Chuan`）、电话号码
 * （`13800138000`）、日期（`2026-09-20`）、短标签（`Wi-Fi` / `Room 3B`）**结构上
 * 不可能**命中——它们是**标识符**，不是一句完整的英文。反过来，任何**包含**式匹配
 * （`/yourself|introduce/`）都会把「Introduce Yourself」这种活动名或住户随手打的标签
 * 吞进来，所以不做。
 *
 * **单词原话（`ok` / `yes` / `hi` / `thanks`）一律留在清单外**：孤零零一个词定不了
 * 这轮在说哪种语言（中文住户也常回一个 `ok`），而那种原话**会话回退本来就答对了**
 * （中文会话里回 `ok` → 中文）。只有**两个词以上、整句就是一句英文**的招呼 / 确认
 * 才收进来——这是「能安全收窄才收」的边界，不是白名单式的能力限制。
 */
const EXPLICIT_ENGLISH_SHORT_UTTERANCES: ReadonlySet<string> = new Set([
  // —— 自称 / 元问题：住户在问「你是谁 / 你是干什么的 / 你怎么工作」——
  "introduce yourself",
  "who are you",
  "what are you",
  "tell me about yourself",
  "how do you work",
  "what can you do",
  "what's this",
  // —— 两个词以上、整句就是一句英文的招呼（单词的 `hi` / `hello` 不收，见上）——
  "good morning",
  "good afternoon",
  "good evening",
  "hi there",
  "hello there",
  "hey there",
  // —— 两个词以上、整句就是一声确认 / 道谢的英文短句 ——
  "thank you",
  "thanks a lot",
  "sounds good",
  "go ahead",
  "yes please",
  "no thanks",
  "sure thing",
]);

/** 整句两端的标点与空白：`"Introduce yourself!"` 与 `introduce yourself` 是同一条。 */
const SHORT_UTTERANCE_LEAD = /^[\s"'()[\],.!?;:…~*\-]+/;
const SHORT_UTTERANCE_TAIL = /[\s"'()[\],.!?;:…~*\-]+$/;

/** 归一化：弯撇号拉直、去两端标点、小写、空白收成一个。**不改动任何一个实词。** */
function normalizeShortUtterance(text: string): string {
  return text
    .replace(/[’‘]/g, "'")
    .replace(SHORT_UTTERANCE_LEAD, "")
    .replace(SHORT_UTTERANCE_TAIL, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * **这一整句是不是一句明确的英文短话**——保守优先，只做整句相等。
 *
 * 调用点在 `classifyDirectLanguage`：它只在**没有汉字、且拉丁词不到三个**时才问到这里，
 * 所以这个函数**不负责**判断「是不是英文多于中文」那件事；它只回答「这一整句是否
 * 恰好是一句公认的英文短句」。有汉字直接 false——那是中文或中英混写，与这里无关。
 */
export function isExplicitEnglishShortUtterance(text: string): boolean {
  const t = text ?? "";
  if (HAS_HAN.test(t)) return false;
  return EXPLICIT_ENGLISH_SHORT_UTTERANCES.has(normalizeShortUtterance(t));
}

/**
 * **这段文本里有没有汉字**——只回答这一个问题，**不做语言判定**。
 *
 * 用途是让「英文那一侧的正文里一个汉字都没有」成为一条**确定性**断言（离线检查直接调
 * 它，不各写一套汉字正则，免得两边对「什么算汉字」的理解漂移）。要判语言请用
 * `decideLanguage` / `classifyDirectLanguage`，别拿这个函数凑。
 */
export function containsHan(text: string): boolean {
  return HAS_HAN.test(text ?? "");
}

/**
 * **只看这一条原话**的判定。定不了返回 `null`（歧义），**不猜**。
 *
 * - 没有汉字、且拉丁词够多 → `en`
 * - 没有汉字、拉丁词不够，但**整句就是一句明确的英文短话** → `en`
 * - 有汉字、拉丁词又少 → `zh`
 * - 有汉字、拉丁词也多（中英混写）→ `null`
 * - 没汉字、拉丁词又少（数字 / 人名 / 一个 "ok"）→ `null`
 */
export function classifyDirectLanguage(text: string): ResidentLanguage | null {
  const t = text ?? "";
  const han = (t.match(HAN) ?? []).length;
  const latinWords = (t.match(LATIN_WORD) ?? []).length;
  if (han === 0) {
    if (latinWords >= ENGLISH_MIN_LATIN_WORDS) return "en";
    // 词数不够，但整句恰好是一句明确的英文短话（`introduce yourself`）→ 原话仍能定。
    // 人名 / 号码 / 日期 / 短标签在这份清单里匹配不上，照旧是 `null`（歧义）。
    return isExplicitEnglishShortUtterance(t) ? "en" : null;
  }
  return latinWords >= ENGLISH_MIN_LATIN_WORDS ? null : "zh";
}

/**
 * **一次原话的判定（不做会话回退）**，歧义时按默认中文收口。
 *
 * 保留这个名字与语义，是因为它被大量既有调用与离线检查当作「这条文本是什么语言」
 * 的纯函数用；轮次里真正该传下去的是 `decideLanguage` 的返回值。
 */
export function residentLanguage(text: string): ResidentLanguage {
  return classifyDirectLanguage(text) ?? "zh";
}

/**
 * **轮次边界的唯一判定入口。** 原则上只调一次，返回值一路往下传。
 *
 * `history` 是**同一条会话线**上最近的往来（`repo.getRecentTurns`，旧→新）。
 * 回退时**从新往旧**找第一条判得出来的：越近越能代表他现在在说哪种语言。
 * 一条都读不出来就用默认中文。
 */
export function decideLanguage(
  text: string,
  history: readonly { role: "user" | "assistant"; content: string }[] = []
): LanguageDecision {
  const direct = classifyDirectLanguage(text);
  if (direct) return { language: direct, source: "direct", direct };
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const fromHistory = classifyDirectLanguage(history[i]?.content ?? "");
    if (fromHistory) {
      return { language: fromHistory, source: "conversation-fallback", direct: null };
    }
  }
  return { language: "zh", source: "default", direct: null };
}

/**
 * 语言判定的**可观测投影**——只记判定与来源，不记任何正文。
 * 与 `PromptComposition` / `ContextReceipt` 同一条纪律：观测不带住户原话。
 */
export type LanguageObservation = {
  language: ResidentLanguage;
  source: LanguageSource;
};

export function observeLanguage(decision: LanguageDecision): LanguageObservation {
  return { language: decision.language, source: decision.source };
}

/**
 * 交给模型的**语言硬指令**（不是话术，是约束：说哪种语言由代码定，不由模型挑）。
 *
 * `source: "direct"` 时说的是「住户这一轮写的就是这种语言」；回退 / 默认时说的是
 * 「这段对话是这种语言」——**不谎称原话就是那种语言**，否则模型会拿一句
 * "ok" 当英文原文去猜语气。两种说法的正文一字不差，只有那句归属不同。
 */
export function languageInstruction(decision: LanguageDecision): string {
  const fromText = decision.source === "direct";
  return decision.language === "en"
    ? "## Response language (hard rule)\n" +
        (fromText
          ? "The resident wrote in English. "
          : "This conversation is in English. ") +
        "Write every resident-facing reply and any outbound SMS in natural, idiomatic English. " +
        "Do not translate Chinese wording literally, and do not switch to Chinese. " +
        "Keep names, quoted facts, and times unchanged."
    : "## 回复语言（硬规则）\n" +
        (fromText ? "住户这一轮主要使用中文。" : "这段对话使用中文。") +
        "给住户的回复和对外短信都用自然中文；不要无故切换成英文。姓名、原始事实与时间保持不变。";
}

/**
 * 按**这一条文本**给语言指令的便捷入口（不做会话回退）。
 *
 * 轮次里请用 `decideLanguage` + `languageInstruction`；这个只剩「手上只有一句文本、
 * 且这句文本就是唯一依据」的地方用。
 */
export function residentLanguageInstruction(text: string): string {
  return languageInstruction(decideLanguage(text));
}
