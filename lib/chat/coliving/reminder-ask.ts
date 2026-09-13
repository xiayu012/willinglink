/**
 * **受约束提醒的「近似请求」判定核心（个人物品 / 夜间洗衣共用，纯函数、不过模型）。**
 *
 * 背景：两项已开放功能各自只有一条合规命令。住户常用自然语言表达同一件事
 * （corpus-034 第 4 轮：「阿川昨天凌晨四点开洗衣机和烘干机……你能不能私下
 * 跟他讲一下，这一次先别在深夜洗和烘干。」），但没按固定命令写。旧行为是落回
 * 普通对话：模型既没有第三方出站工具，又可能误报能力边界（那一轮花了 $0.0809、
 * 2.7 万推理 tokens，还错说「只支持个人物品提醒」）。这里给出一个**确定性**入口，
 * 命中后只回当前说话人一句「没有发送 + 唯一命令模板」的短指引，零第三方出站、
 * 零模型调用。
 *
 * 命中必须**同时**满足（见 `looksLikeRelayedReminderAsk`）：
 *   a) 有显式让 AI 对某位指定室友采取联系/提醒动作的自然语言请求；
 *   b) 是该功能的独有主题（由各模块传入 `topicCue`）；
 *   c) 文本里出现名册里的室友姓名（=「指定室友」，排除「有人」「他」这类未点名）；
 *   d) 不是该功能的合规命令本身（调用方在用近似入口前会先跑合规识别）。
 *
 * 设计取向（老板要求）：**宁可漏掉自然表达，也不吞掉普通谈话。** 下列情形一律
 * 不命中，落回现有普通对话：纯抱怨、评理、讨论/征询、未点名对象、一般噪音、
 * 卫生/头发、费用、规则、混合议题、以及**否定式交办**（「别提醒他」这类拦着
 * AI 的指令，见 `isNegatedRequest`）。判定只用字符串/正则，不做语义分类，也不
 * 试图穷举自然语言。
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 只在跟当前说话人对话时用的显式请求标记（请 AI 去做事）。 */
const AI_REQUEST_MARKER =
  /(?:帮我|帮忙|麻烦(?:你|您)?|请你?|拜托(?:你|您)?|能不能|能否|可不可以|可以帮我|劳驾)/;

/** 句首就是祈使的转达动作（整条短信都是发给 AI 的）。 */
const IMPERATIVE_RELAY_START =
  /^(?:请|麻烦(?:你|您)?|帮我|帮忙|劳驾|拜托(?:你|您)?)?\s*(?:私下\s*)?(?:提醒|跟|和|向|告诉|转达|转告|通知|叫|让)/;

/** 句读之后的祈使分句（「……，你跟他说一下」）。 */
const IMPERATIVE_RELAY_CLAUSE =
  /[，。；！？!?\n]\s*(?:你|你们)?\s*(?:私下\s*)?(?:提醒|跟|和|向|告诉|转达|转告|通知|叫|让)/;

/**
 * 商量 / 征询意见 / 追问既成事实——不是交办，不触发。
 * 覆盖「要不要提醒他」「你觉得呢」「你跟他说过吗」这类表述。
 */
const DELIBERATIVE =
  /(?:要不要|该不该|是不是该|是否该|有没有必要|有没有需要|你觉得|你认为|我在考虑|考虑要不要|我该不该|过吗|了吗|了没|了没有|有没有(?:跟|和|向|提醒|告诉|通知|联系))/;

/**
 * **否定式交办「不要去做」**——住户明确拦着 AI，不是让 AI 去做
 * （「别提醒他」「不要跟他说」「不用通知他」「没让你转告」）。
 * 命中即不命中近似请求，落回普通对话；否则会把一句阻止指令读成发送提案。
 *
 * 只看否定词**紧贴转达动词之前**：像「提醒他别在深夜洗」里的「别」修饰的是
 * 收件人的行为、出现在动词之后，不受影响——所以不会误伤正常请求。
 */
const NEGATED_REQUEST =
  /(?:别|不要|不用|不需要|不许|不准|无需|没必要|不是要你|不是让你|没让你)(?:再|去|帮我|帮忙|私下|主动)?\s*(?:提醒|跟|和|向|告诉|转达|转告|通知|叫|让)/;

export function isNegatedRequest(text: string): boolean {
  return NEGATED_REQUEST.test(text);
}

/** 名册里可作为收件人的名字（≥2 字，避免单字误匹配）。 */
function usableNames(names: readonly string[]): string[] {
  return names.filter((n) => typeof n === "string" && n.trim().length >= 2);
}

/** 转达动作要指向的「对方」：代词或名册里的姓名。 */
function targetAlt(names: readonly string[]): string {
  const named = usableNames(names).map(escapeRegExp);
  return `(?:他|她|他们|她们|对方${named.length ? `|${named.join("|")}` : ""})`;
}

/** 是否存在「让 AI 对某个对方说/讲/提醒」的转达动作。 */
function relayDirectiveRegexes(names: readonly string[]): RegExp[] {
  const t = targetAlt(names);
  return [
    new RegExp(
      `(?:跟|和|向|给|对)${t}(?:说|讲|提|聊|沟通|联系|转达|转告|反映|提醒|交代)(?:一下|一声|下|吧)?`
    ),
    new RegExp(`(?:提醒|告诉|通知|转达|转告)(?:一下|一声)?${t}`),
    new RegExp(
      `(?:让|叫|请)${t}(?:说|讲|提|别|不要|不|下次|以后|先|记得|尽量|用之前|提前|一声)`
    ),
  ];
}

const SELF_FILLER =
  "(?:已经|已|就|会|要|去|来|先|再|也|还|还是|自己|想|打算|准备|回头|下次|以后|稍后)*";

/**
 * 反着来的表达：对方提醒/通知「我」，或说话人自己去联系（不是请 AI 去做）。
 * 命中就不算「请 AI 对指定室友采取动作」。第一条用句读/行首锚定，避免把
 * 「帮我提醒他」里的「我提醒」错当成自己去做。
 */
function isReverseOrSelfDirected(text: string, names: readonly string[]): boolean {
  const t = targetAlt(names);
  const reverse = new RegExp(
    `(?:${t})(?:已经|已|就|也|还|又)?(?:提醒|告诉|通知|劝)(?:过)?(?:我|我们)` +
      `|(?:${t})(?:跟|和|向)(?:我|我们)(?:说|讲|提|反映|抱怨|吐槽)`
  );
  const self = new RegExp(
    `(?:^|[，。！？!?\\n\\s])(?:我|我们)${SELF_FILLER}(?:去)?(?:跟|和|向|提醒|告诉|通知|劝)` +
      `|(?:我|我们)(?:自己|本人)(?:去)?(?:跟|和|向|提醒|告诉|通知|劝)`
  );
  return reverse.test(text) || self.test(text);
}

export function hasAiRequestMarker(text: string): boolean {
  return AI_REQUEST_MARKER.test(text);
}

export function isImperativeRelayStart(text: string): boolean {
  return (
    IMPERATIVE_RELAY_START.test(text.trim()) ||
    IMPERATIVE_RELAY_CLAUSE.test(text)
  );
}

export function isDeliberative(text: string): boolean {
  return DELIBERATIVE.test(text);
}

export function mentionsMember(
  text: string,
  names: readonly string[]
): boolean {
  return usableNames(names).some((n) => text.includes(n));
}

export type ReminderAskCues = {
  /** 该功能的独有主题（各模块自备，纯判断，不做语义分类）。 */
  topicCue: (text: string) => boolean;
  /** 明确属于其它未开放能力/混合议题的信号：命中即不吞，落回普通对话。 */
  foreignCue: RegExp;
};

/**
 * 便宜的预筛（不需要名册）：主题 + 请求语气 + 非讨论/非混合。
 * 先跑它再决定要不要查名册，避免每条无关消息都读一次成员表。
 */
export function hasRelayedReminderAskSignal(
  text: string,
  cues: ReminderAskCues
): boolean {
  const t = text.trim();
  if (!cues.topicCue(t)) return false;
  if (cues.foreignCue.test(t)) return false;
  if (isDeliberative(t)) return false;
  if (isNegatedRequest(t)) return false;
  return hasAiRequestMarker(t) || isImperativeRelayStart(t);
}

/**
 * 完整判定：预筛信号 + 名册里确有被点名的室友 + 有指向对方的转达动作 +
 * 不是「对方提醒我」/「我自己去说」。命中即应回当前说话人一句未发送指引。
 */
export function looksLikeRelayedReminderAsk(
  text: string,
  names: readonly string[],
  cues: ReminderAskCues
): boolean {
  if (!hasRelayedReminderAskSignal(text, cues)) return false;
  if (!mentionsMember(text, names)) return false;
  if (isReverseOrSelfDirected(text, names)) return false;
  return relayDirectiveRegexes(names).some((re) => re.test(text));
}
