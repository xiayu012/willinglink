/**
 * Conversation-language selection for resident-facing text.
 *
 * This intentionally answers only one narrow question: which language should
 * the model use for this turn?  It does not translate facts, names, rules, or
 * tool data; those remain source-of-truth structured values.
 */
export type ResidentLanguage = "en" | "zh";

export function residentLanguage(text: string): ResidentLanguage {
  const han = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  // Require several Latin words so phone numbers, names, and an isolated "ok"
  // do not unexpectedly flip an otherwise Chinese conversation to English.
  const latinWords = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)?/g) ?? [];
  return han === 0 && latinWords.length >= 3 ? "en" : "zh";
}

/** A model instruction, deliberately native rather than a translated UI label. */
export function residentLanguageInstruction(text: string): string {
  return residentLanguage(text) === "en"
    ? "## Response language (hard rule)\nThe resident wrote in English. Write every resident-facing reply and any outbound SMS in natural, idiomatic English. Do not translate Chinese wording literally, and do not switch to Chinese. Keep names, quoted facts, and times unchanged."
    : "## 回复语言（硬规则）\n住户这一轮主要使用中文。给住户的回复和对外短信都用自然中文；不要无故切换成英文。姓名、原始事实与时间保持不变。";
}
