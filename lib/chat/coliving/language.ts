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
 * **判据本身不做主题分类，也不看关键词表**：只数汉字与拉丁词。下游任何一处
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
/** 拉丁词：允许 `don't` / `you’re` 这类撇号与连字符，一个词只算一个。 */
const LATIN_WORD = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;

/**
 * 一个词都不改的保守边界：**至少三个拉丁词**才算英文。
 * 少于三个（电话号码、一个人名、一句 "ok"）不足以证明这轮在说英文——这种原话
 * 归入「歧义」，交给会话回退去定，而不是就地猜。
 */
const ENGLISH_MIN_LATIN_WORDS = 3;

/**
 * **只看这一条原话**的判定。定不了返回 `null`（歧义），**不猜**。
 *
 * - 没有汉字、且拉丁词够多 → `en`
 * - 有汉字、拉丁词又少 → `zh`
 * - 有汉字、拉丁词也多（中英混写）→ `null`
 * - 没汉字、拉丁词又少（数字 / 人名 / 一个 "ok"）→ `null`
 */
export function classifyDirectLanguage(text: string): ResidentLanguage | null {
  const t = text ?? "";
  const han = (t.match(HAN) ?? []).length;
  const latinWords = (t.match(LATIN_WORD) ?? []).length;
  if (han === 0) {
    return latinWords >= ENGLISH_MIN_LATIN_WORDS ? "en" : null;
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
