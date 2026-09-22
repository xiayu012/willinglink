import { z } from "zod";
import {
  FEATURE_QA_MAX_OUTPUT_TOKENS,
  FeatureCallError,
  structuredCall,
  usageOfFeatureError,
  type FeatureLlm,
  type FeatureUsage,
} from "./feature-llm";
import {
  blacklistFact,
  buildFeatureQaFacts,
  selectBlacklistedCapabilities,
  selectFeatureQaBlocks,
  type FeatureDisplayName,
  type FeatureQaBlock,
  type FeatureQaBlacklistFact,
  type FeatureQaFactBundle,
} from "./feature-facts";
import { findGroundingViolations } from "./feature-grounding";
import { residentLanguage, type LanguageDecision, type ResidentLanguage } from "./language";

/**
 * **统一的产品功能问答入口——不是功能、不是工具、不出站。**
 *
 * 老板 2026-09-13 决策（默认宽容）：住户问「你有什么功能 / 能不能做 X / 为什么 X
 * 不能做 / 刚才为什么拒绝 / **你是谁、你是干什么的**」这类**产品边界与自称元问题**时
 * 进这里，读 `feature-facts.ts` 那份统一事实源回答。**口径不再是"只有两项功能"**：
 * 两项已批准功能只是专门优化的快路径；其它协调请求走完整的协调流程，不是不能做；
 * 真正办不了的只有老板明确登记的**黑名单**（`blacklist.ts`，当前一项是**「单方面叫
 * 别人在洗完澡后清理地漏头发」**）。与问题对不上的条目不得被选中，也不得为它编造原因。
 *
 * **老板 2026-09-22 补齐的语义分家**（问什么就只答什么，不再一锅端）：
 *
 * - 问「你是谁 / 介绍一下你自己」→ **只**读内容 Markdown 的 `identity.*`：**不**列优化功能
 *   清单、**不**顺带讲办不到的事、**不**解释内部怎么运作，也不把无关的限制一起倒出来；
 * - 问「你能做什么」→ **只**读 `capabilities.*`；只有住户**明确问到**某件已登记为办不到的
 *   事时，才另外说出那件事的名称与登记原因；
 * - 「这件事为什么办不了」→ **只**说那件事的名称与登记原因，不夹带别的。
 *
 * 原文只有 Markdown 一个出处（`coordinator-copy.ts`）：本文件里**没有任何一句住户可见的
 * 通用话**，兜底也从同一个选段结果里取，代码不另写一份措辞。
 *
 * ## 「刚才为什么」的窄引用（不按关键词猜）
 *
 * 住户被黑名单收口后**紧接着**追问「为什么连这么简单都没有?那你有什么功能？」时，
 * 问题本身不含主题词，光靠 `keywords` 对不上条目。为此黑名单回复那一轮会由**纯代码**
 * 把 `{ blacklistedCapabilityId, personId }` 写进 decision payload；本入口由调用方传入
 * `referencedBlacklistedId`（`repo.latestBlacklistReference` 已按**本人 + 紧接本人上一条
 * 入站 + 72h** 收窄），只在问题对不上任何条目、且这条引用可用时补上那一个条目。
 * **不读自由文本、不靠关键词猜「刚才」**：本人后来发过别的（引用出局）或别的住户发问
 * （查询按 personId 收窄）都不会错误继承。
 *
 * ## 与旧主生成、工具表完全无关
 *
 * 本入口**不装载旧 doctrine、不进主生成、没有任何工具、零第三方出站**（由 `turn.ts`
 * 调 `finalizeFeatureTurn` 早返回）。生成阶段**只看到三样**：住户的问题、事实源里
 * **与这个问题有关**的整段原文（`buildFeatureQaFacts`）、以及本轮该说哪种语言
 * （`language.ts` 的轮次判定）。模型只负责把那些原话说成自然、简短、**住户这一轮语言**
 * 的回应；**不得补充处理方案、虚构能力、或承诺立刻去联系 / 跟进**。写出内部术语 /
 * 假承诺 / 把球踢回住户、漏掉该说的原话、或**列出具体功能名**时，用**同样取自
 * Markdown / 黑名单数据**的代码兜底（`featureQaFallback`）。共享的 grounding 判定见
 * `feature-grounding.ts`。
 *
 * 它只在 `turn.ts` **已批准功能前门之后**接线：命中已批准功能 / 保留轮的请求先由前门
 * 处理，前门不接的（普通问句不需要点名收件人）才轮到本入口——**已批准功能的执行行为
 * 一字不变**。
 */

export const FEATURE_QA_STAGE = "feature:qa";
export const FEATURE_QA_NAME = "feature_qa";

/** 正文长度上限（一两句，模型偶尔啰嗦时换兜底，不截断）。 */
export const FEATURE_QA_MAX_CHARS = 240;

/**
 * 英文正文的长度上限。**同一条「一两句」在英文里占的字符数本来就多得多**：住户用英文
 * 问起自己时，正文必须说清身份；按 240 字符卡容易被换掉兜底——那等于英文这条路白修。
 * 上限按语言取，只放宽英文，中文口径一字不动。
 */
export const FEATURE_QA_MAX_CHARS_EN = 400;

/** 这一轮正文的长度上限：按住户说话的语言取（判定复用 `language.ts`，不另写关键词）。 */
export function featureQaMaxChars(
  question: string,
  /**
   * 本轮住户语言判定（`turn.ts` 在轮次边界判一次）。**给了就用它**——判定还含会话
   * 回退那一半（住户只回一个 "ok" / 中英混写时全靠它），在这里从 `question` 现推
   * 只剩原话那一半。缺省按原话现推，既有离线调用一行不改。
   */
  language?: LanguageDecision
): number {
  return (language?.language ?? residentLanguage(question)) === "en"
    ? FEATURE_QA_MAX_CHARS_EN
    : FEATURE_QA_MAX_CHARS;
}

/** 只接受一个字符串字段：回给当前说话人的那一两句。 */
const featureQaSchema = z.object({
  reply: z.string().describe("回给当前说话人的一两句自然回应"),
});

/**
 * **内部工程术语黑名单**：一旦出现在正文里就判失败，换回代码兜底。这是**本路径独有的
 * 格式/用词约束**（内部术语），不是 grounding；共享的「假承诺 / 把球踢回住户 / 换渠道 /
 * 等以后」判定在 `feature-grounding.ts`（`findGroundingViolations`）。
 */
const INTERNAL_TERMS =
  /白名单|路由|提示词|能力清单|未开放|functionId|schema|内部规则|系统设定|模型|大模型|数据库|工具|接口|算法|服务器|后台|代码|训练|架构|\b(?:llm|api|gpt|model|models|database|tool|tools|prompt|prompts|architecture|backend|server|agent|token|tokens)\b/i;

/**
 * **「只有两项功能」式失真**的窄哨兵：老板 2026-09-13 的口径是那两项只是**专门优化的
 * 快路径**、不是全部能力。一旦说成就换回只含事实源事实的兜底——这和内部术语一样是
 * **这条路径自己的格式约束**，不是 grounding。
 */
const CLAIMS_ONLY_TWO_FUNCTIONS =
  /只有(?:这|那)?两(?:项|个|件)|就(?:是)?这(?:两|2)(?:项|个|件)|只能做这(?:两|2)件|only (?:these |the )?two\b/i;

/**
 * **英文的「你能做什么」——整句相等，不靠包含匹配。**
 *
 * 为什么必须锚定整句：`what can you do about the noise next door?` 是**一件具体的交办**
 * （住户要你去处理隔壁噪音），不是问能力。一句宽松的 `/what can you do/` 会把这种句子
 * 吞进功能问答，让真正要办的事没人办——与 `asksAboutSelf` 里那条注释是同一个坑。
 * 只有"整句话就是在问你能做什么"（允许一句招呼、允许 `for me/us`）才算。
 */
const ASKS_WHAT_IS_AVAILABLE_EN =
  /^(?:(?:hi|hello|hey|so|and)[\s,]+)*what (?:can|could|do) (?:you|u) do(?: for (?:me|us))?[\s.!?~]*$/i;

/**
 * 住户是不是在问「你现在能做什么 / 你有哪些功能」。**只做元问题识别，不做主题分类。**
 * 抽出来单独暴露，因为选段（`selectFeatureQaBlocks`）要据此决定这一轮读 `capabilities.*`。
 */
export function asksWhatIsAvailable(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return (
    (/有什么|有哪些|都有什么|都有哪些|会什么|能做什么|能干什么/.test(t) &&
      /功能|能力|本事|作用|能|可以/.test(t)) ||
    (/功能|能力/.test(t) && /(有哪些|有什么|都是什么|是哪些)/.test(t)) ||
    /(能|可以|会)(帮|替|给|为)?(我|你)?(做|干|办)(什么|啥|哪些)/.test(t) ||
    /(帮|替)?(我)?(能|可以)(做|干|办)(什么|啥|哪些)/.test(t) ||
    ASKS_WHAT_IS_AVAILABLE_EN.test(t.replace(/[’‘]/g, "'"))
  );
}

/**
 * **问身份**的句式（中英各若干条）：只写"住户在问你是谁 / 你是干什么的 / 你怎么工作"
 * 这几种意思，不写主题词——主题分类不在这里做。
 *
 * 与下面 `CAPABILITY_QUOTE_PHRASES` 分开列，是因为**问身份与问能力是两种问法**
 * （老板 2026-09-22：问身份只读身份段、问能力只读能力段）。合成一份，纯「你能做什么」
 * 就会既算问身份又算问能力，于是一句能力问题同时背上身份段。
 */
const IDENTITY_QUOTE_PHRASES: readonly string[] = [
  // —— 中文 ——
  "你是谁",
  "你到底是谁",
  "你究竟是谁",
  "你是什么(?:人)?",
  "你是(?:干什么|做什么|干嘛|干啥)的",
  // 「你是不是 AI」「你是这套房子的管理员吗」：中间允许几个修饰字（这套房子的 / 一个）。
  // 整句两端都被锚住，中间的 `{0,6}?` 拉不长，不会退化成主题匹配。
  "你(?:是不是|是)\\s*[^。！？?!，,\\n]{0,6}?(?:AI|ai|机器人|人工智能|真人|人|管理员|管家|房东|物业|中介)\\s*(?:吗|嘛)?",
  "你(?:的)?(?:身份|角色|作用|职责)是(?:什么|啥)",
  "自我介绍",
  "介绍(?:一下)?你自己",
  "你介绍(?:一下)?自己",
  "你(?:平时|一般|大概|到底|究竟)?(?:是)?怎么(?:工作|运作|运行)的",
  // —— 英文（`asksAboutSelf` 里以 `i` 标记匹配，大小写不敏感）——
  "who are you",
  "who r u",
  "what are you",
  "what(?:'s|s| is)\\s+this(?: number| service| thing)?",
  // 「What does this AI do?」——问的是**这个 AI / 这项服务**是干什么的。名词必须出现
  // 才认（光有 "what does this do" 太泛），与相邻条目同一粒度。
  "what does (?:this|the) (?:ai|bot|robot|service|number|thing|system|assistant) do",
  "are you (?:a |an )?(?:bot|robot|ai|human|person|machine|real)",
  "introduce yourself",
  "tell me about yourself",
  "what(?:'|’)s your (?:role|job|purpose)",
  "how do you work",
  "how does this work",
];

/**
 * **问能力**的句式（住户在问你能做什么 / 你有哪些功能）。与身份句式分开列——纯能力问题
 * 只读能力段，不背身份段。这几句**也**都在 `asksWhatIsAvailable` 里，所以拆出去不会漏掉
 * 「进不进功能问答」这件事，只是不再被算成"问你自己"。
 */
const CAPABILITY_QUOTE_PHRASES: readonly string[] = [
  "你能(?:帮|替|给|为)?(?:我|我们)?(?:做|干|办)(?:什么|啥|哪些)",
  "你会(?:做|干)(?:什么|啥|哪些)",
  "你(?:都)?有(?:什么|哪些)功能",
  "what can you do(?: for (?:me|us))?",
  "what do you do(?: for (?:me|us))?",
];

/**
 * 整句判定的句式表 = 两份合起来：住户**连着问**（「你是谁啊？你能做什么呢？」）时整句仍
 * 由这些句式组成，所以这一句仍要认出来——至于算不算"问身份"，看下面那道身份复核。
 */
const SELF_QUOTE_PHRASES: readonly string[] = [
  ...IDENTITY_QUOTE_PHRASES,
  ...CAPABILITY_QUOTE_PHRASES,
];

/**
 * **整句里有没有一句是在问身份。** 不锚定即可：上面 `SELF_QUOTE_RE` 已经锚住整句，这一串
 * 字只可能由招呼、句式与语气词组成，所以在这里命中身份句式，就等于那一句确实是身份问句。
 */
const SELF_IDENTITY_RE = new RegExp(IDENTITY_QUOTE_PHRASES.join("|"), "i");

/**
 * 句间/句尾允许的停顿与语气词（「你是谁啊？」「你好，请问你是做什么的？」）。
 * 标点与语气词**合在一个字符类里重复**：中文里两者先后不固定（「你是谁啊？」是语气词
 * 在前），合成一处就不必猜顺序，也不必为每种组合各写一条。
 */
const SELF_QUOTE_TAIL = "[\\s，,、；;：:。.！!？?~～…（）()啊呀呢吧哦噢哈嘛诶嘞么]*";

/** 自称类问句前面允许的招呼 / 「请问」；**可以连着来两句**（「你好，请问……」）。 */
const SELF_QUOTE_LEAD = `(?:${[
  "你好",
  "您好",
  "哈喽",
  "哈啰",
  "嗨",
  "请问",
  "打扰(?:一下)?",
  "hi",
  "hello",
  "hey",
].join("|")})`;

const SELF_QUOTE_RE = new RegExp(
  `^(?:${SELF_QUOTE_LEAD}${SELF_QUOTE_TAIL})*` +
    `(?:${SELF_QUOTE_PHRASES.join("|")})` +
    `(?:${SELF_QUOTE_TAIL}(?:${SELF_QUOTE_PHRASES.join("|")}))*` +
    `${SELF_QUOTE_TAIL}$`,
  "i"
);

/**
 * **住户在问「你是谁 / 你是干什么的 / 你怎么工作」的窄识别——保守优先。**
 *
 * 与 `asksWhatIsAvailable` 的分工：那个认的是"问能力"（你有哪些功能），本函数认的是
 * **"问身份/角色"**。问身份时只读 Markdown 的 `identity.*` 那一段，**不**顺带列功能、
 * 讲办不到的事或解释内部结构。
 *
 * 判据是**结构不是主题**：整句话必须**就是**一句（或连着几句）自称类问句，前面只允许
 * 一句招呼 / 「请问」。**只要后面还跟着别的要求就整条不认**——「你是谁？顺便帮我跟阿川
 * 说一声」里有一件真正要办的事，被这里吞掉就等于住户的交办没人办。同理
 * 「what can you do about the noise next door?」不认：`about …` 后面挂着一个具体
 * 诉求，那是交办不是问身份。
 *
 * **整句合规还不够，还要真的问到了身份**（老板 2026-09-22）：纯「你能做什么 /
 * what can you do」是一句**能力**问题，整句也确实由自称类句式组成，但它不读身份段——
 * 认成问身份就会让住户问一句能力却收到"我是谁"那一段。只有整句里出现身份句式
 * （「你是谁啊？你能做什么呢？」这种连着问的）才算问身份，那时两段都读。
 *
 * 宁可漏掉口语变体（漏了就退回普通对话，不会造成新的越界），也不把普通交办误判进来。
 */
export function asksAboutSelf(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  // 英文撇号有直撇和弯撇两种写法，先归一，免得「what’s this?」漏掉。
  const normalized = t.replace(/[’‘]/g, "'");
  return SELF_QUOTE_RE.test(normalized) && SELF_IDENTITY_RE.test(normalized);
}

/**
 * **窄的、通用的功能边界问句识别——保守优先。** 只认那几类元问题：
 * 「你有什么功能 / 你是谁 / 能不能做 X / 为什么 X 不能做 / 刚才为什么拒绝」。普通交办、
 * 抱怨、闲聊、新的提醒请求都返回 false（仍走原来的对话路径，成功交办的已批准功能不受
 * 影响）。
 *
 * 这不是主题分类，只是识别"住户在问产品功能边界或问起我自己"这一种**元问题**。
 * 宁可漏掉不常见的口语变体（漏了就退回普通对话，不会造成新的越界），也不把普通聊天
 * 误判进来。
 */
export function isFeatureQaQuestion(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;

  // 「为什么 X 不能做」
  const asksWhyNotPossible =
    /为什么|为啥|怎么/.test(t) &&
    /不能|不行|没有|没开放|办不到|办不了|做不了|做不到|发不了|不支持|没法/.test(t);

  // 「刚才 / 上一次为什么拒绝我」
  const asksAboutJustNow =
    /(刚才|刚刚|你刚(?:才)?(?:说|讲|回复)|上次|上一次)/.test(t) &&
    /(拒绝|不给我|没给我|没帮|办不了|不能|不行|为什么|怎么|没有|没做)/.test(t);

  // 「能不能做 X」——明确的是非能力询问（带问句语气 + 一个动作）
  const asksWhetherYouCan =
    /(能不能|可不可以|能否|可以不可以|能帮我|可以帮我|能替我|可以替我)/.test(t) &&
    /(办|做|发|提醒|联系|通知|告诉|传话|转达|转告|协调|催|安排|处理|沟通|要求|让)/.test(t);

  return (
    asksWhatIsAvailable(t) ||
    asksAboutSelf(t) ||
    asksWhyNotPossible ||
    asksAboutJustNow ||
    asksWhetherYouCan
  );
}

/**
 * 把这一轮该说的几段原文**按顺序接起来**。**只做拼接，不加字、不改标点、不换措辞**：
 * 住户看到的必须是 Markdown 里那一串字。中文段自带句末标点，直接相连；英文段之间留
 * 一个空格，免得两句黏成一个词。
 */
function joinBlocks(blocks: readonly FeatureQaBlock[], language: ResidentLanguage): string {
  return blocks.map((b) => b.text).join(language === "en" ? " " : "");
}

/**
 * **只含 Markdown 原文与登记事实的兜底**。模型完全写不出可用回应、或写出违规内容时用它
 * ——它同样不承诺、不虚构、不列内部术语，也**不再自己编一句通用话**：说的就是内容文件里
 * 那几段（可能还加上被问到的那件办不到的事）。**没有选中黑名单条目时不说任何"办不了"**。
 */
export function featureQaFallback(args: {
  question: string;
  openFeatures: readonly FeatureDisplayName[];
  /** 本人上一轮刚被黑名单拒绝的条目 id（结构化引用；没有则 null） */
  referencedBlacklistedId?: string | null;
  /**
   * 本轮住户语言判定（`turn.ts` 在轮次边界判一次）。**给了就用它**，不再从
   * `question` 现推——住户只回一个 "ok"、或中英混写时，依据在会话回退里。缺省按原话
   * 现推，既有离线调用一行不改。
   */
  language?: LanguageDecision;
}): string {
  // 语言判定复用 `language.ts`，不在这里另写一套关键词。
  const language = args.language?.language ?? residentLanguage(args.question);
  // 黑名单条目**按这同一份判定展开**：名称、理由、grounding 锚点三者一起取到同一份
  // 语言，不会出现"名称换成英文、理由还是中文"的半截英文。中文轮次逐字不变。
  const blacklisted = selectBlacklistedCapabilities(
    args.question,
    args.referencedBlacklistedId
  ).map((c) => blacklistFact(c, language));
  // 该读哪几段由**选段函数**决定（与交给模型的事实包是同一个函数、同一个结果）：
  // 问身份只给身份段、问能力只给能力段、问到已登记的办不到事项就不给通用段。
  const blocks = selectFeatureQaBlocks({
    selfIntro: asksAboutSelf(args.question),
    wantsCapabilities: asksWhatIsAvailable(args.question),
    hasBlacklisted: blacklisted.length > 0,
    language,
  });
  const blocksText = joinBlocks(blocks, language);

  if (blacklisted.length) {
    const f = blacklisted[0];
    // 名称与登记原因来自 `blacklist.ts`（老板给的事实），不是本文件写的措辞。
    const fact =
      language === "en"
        ? `There's one thing I can't do for you — ${f.displayName}: ${f.reason}.`
        : `「${f.displayName}」这件事我目前没法替你办：${f.reason}。`;
    return blocksText ? `${fact}${language === "en" ? " " : ""}${blocksText}` : fact;
  }
  // 走到这里 blocks 必非空：选段函数只在"问到了已登记的办不到事项"时才可能一段都不给，
  // 而那种情况已经在上面返回了。
  return blocksText;
}

/**
 * **通用 grounding 校验——只读事实源与内容文件，引擎里没有任何主题分支。**
 *
 * 接受的正文必须：
 * 1. 含**本轮该说的每一段原文**（`blocks`，整段一字不差）——原文只有 Markdown 一个出处，
 *    所以住户读到的就是文件里那句话；模型自己另讲一遍、漏掉或改写了都不算过关；
 * 2. 含**每一条**被选中的黑名单条目的 `displayName`，并保留它的**理由**——含该条目
 *    `reasonAnchors` 里的**每一个**锚点词（允许自然改写措辞：锚点是数据里「换句话也
 *    绕不开」的核心词）。名称、理由与锚点是**同一次按语言取用的结果**（`blacklistFact`），
 *    所以英文轮次核的是英文说法与英文锚点，中文轮次逐字不变；
 * 3. **不得出现任何具体功能名**（`forbiddenOpenFeatureNames`）：问身份 / 问能力只回那两段
 *    原文，不列功能清单——老板 2026-09-22 的口径，这里做成能验的规则而不是一句嘱咐。
 *
 * 返回空数组 = 通过；否则返回**哪里不对**的可诊断短语，调用方据此换成只含 Markdown 原文
 * 与登记事实的 `featureQaFallback`。新增功能 / 条目只改登记数据与那份 Markdown，本函数
 * 一行不动。
 */
export function findUngroundedFeatureQaFacts(
  reply: string,
  bundle: FeatureQaFactBundle
): string[] {
  const text = reply ?? "";
  const problems: string[] = [];
  for (const block of bundle.blocks) {
    if (!text.includes(block.text)) {
      problems.push(
        `没有原样说出${block.kind === "identity" ? "身份" : "能力"}那一段原话`
      );
    }
  }
  for (const fact of bundle.blacklisted) {
    if (!text.includes(fact.displayName)) {
      problems.push(`未提到事项「${fact.displayName}」`);
      continue;
    }
    const absent = fact.reasonAnchors.filter((a) => !text.includes(a));
    if (absent.length) {
      problems.push(`未保留「${fact.displayName}」的原因（缺：${absent.join("、")}）`);
    }
  }
  for (const name of bundle.forbiddenOpenFeatureNames) {
    if (text.includes(name)) {
      problems.push(
        `列出了具体功能名「${name}」——问身份 / 问能力只回那两段原话，不列功能清单`
      );
    }
  }
  return problems;
}

function featureQaSystem(bundle: FeatureQaFactBundle): string {
  const blocks = bundle.blocks.length
    ? bundle.blocks.map((b) => `- ${b.text}`)
    : ["（这一轮没有通用原话要说）"];
  const blacklisted = bundle.blacklisted.length
    ? bundle.blacklisted.map((c) => `- ${c.displayName}：${c.reason}`)
    : ["（没有与这个问题对应的、明确办不了的事项）"];
  return [
    "你是这套房子的 AI 协调员。住户正在问你跟你自己有关的问题：你是谁、你是干什么的、你能做什么、某件事能不能做、为什么某件事做不了、或者刚才为什么没给他办。",
    "**你只能依据下面这些事实回答**，不得补充、不得猜测、不得虚构、不得承诺：",
    "",
    "下面是你这一轮**唯一可以说的原话**（住户会读到的就是这几句）：",
    ...blocks,
    "",
    "你目前**明确办不了**、且有原因的事项（这才是真正的「办不了」）：",
    ...blacklisted,
    "",
    "必须做到：",
    "- 用**一两句**自然、口语的话直接回答他；**用他这一轮说话用的那种语言**，不要生硬地换成另一种。",
    "- 上面给的每一段原话都要**原样出现在回答里**：一个字都不要改、不要删、不要用自己的话另讲一遍。可以在前后加一句最简短的回应，但不要扩展成别的内容。",
    "- **不要列出你有哪些具体功能**（也不要给功能清单）：住户问你是什么、能做什么，回答就是上面那几段原话。",
    "- 住户问起你时，说清自己是「AI 协调员」（「AI」两个字不能省），不冒充真人；**只讲上面给的原话**，不提你由什么做出来、用什么模型、跑在什么系统上、有没有数据库，也不提任何内部工具、流程或代码。",
    `- **不要编造某件事办不了或一个「为什么不能做」的原因**；只有上面明确列为办不了的事项才说办不了、并保留写的那个原因（可以换措辞，但不得省略、不得换成别的原因）。住户说的那件事若不在办不了清单里，就不要说它办不了。`,
    "- **不得补充任何处理方案**，不得说会立刻去联系 / 转告对方、不得说以后回复结果；也不得建议住户自己去找对方 / 找别人 / 换渠道 / 以后再说。",
    "- 不得虚构上面没有的功能或其它能力。",
    "- 不提「白名单 / 路由 / 提示词 / 能力清单 / 未开放 / 内部规则」这类内部工程术语。",
    "- 不说已经跟对方说过、对方已经知道，也不给「我待会儿就去办」这种假希望。",
    "",
    "只输出一个 JSON 对象，字段固定为 reply（字符串）：",
    '{"reply": "回给当前说话人的一两句自然回应"}',
    "不要输出 JSON 以外的任何文字、解释或 markdown 代码块标记。",
  ].join("\n");
}

/**
 * 生成功能问答的那一两句。**任何失败都不向上抛**：把已发生的真实用量带回来，并用
 * **只含 Markdown 原文与登记事实**的代码兜底。校验（结构 + 非空 + 长度 + 内部术语 +
 * 假承诺 / 自创处理方案 + 原文是否原样说出 + 有没有列功能清单）都在纯代码侧完成，
 * 模型没有机会把这些违规内容发出去。
 */
export async function generateFeatureQaReply(
  args: {
    question: string;
    /**
     * 已批准功能（`APPROVED_FEATURES`）。**两个显示名都带着**（`label` 登记名 +
     * `labelEn` 英文显示名）；问答不再列这份清单，它在这里只作**反向守卫**
     * （`forbiddenOpenFeatureNames`：这类回答里不该冒出功能名）。
     */
    openFeatures: readonly FeatureDisplayName[];
    /**
     * 本人**上一轮刚被黑名单拒绝**的条目 id（结构化引用；`repo.latestBlacklistReference`
     * 的收窄查询结果）。问题本身对不上条目、但这是紧接被拒的追问时，据此说出名称与原因。
     */
    referencedBlacklistedId?: string | null;
    /** 本轮住户语言判定（`turn.ts` 判一次）——正文上限、模型指令、读哪一份原文都由它定。 */
    language?: LanguageDecision;
  },
  llm: FeatureLlm
): Promise<{ reply: string; fallback: string; usage: FeatureUsage; error?: unknown }> {
  // 问身份与问能力是两种问法：分类在引擎这一处做完，事实源只做数据查找与选段
  // （见 `buildFeatureQaFacts` / `selectFeatureQaBlocks`）。
  const selfIntro = asksAboutSelf(args.question);
  const wantsCapabilities = asksWhatIsAvailable(args.question);
  const bundle = buildFeatureQaFacts({
    openFeatures: args.openFeatures,
    question: args.question,
    referencedBlacklistedId: args.referencedBlacklistedId ?? null,
    selfIntro,
    wantsCapabilities,
    // 读哪一份原文按本轮语言取：英文轮次的事实包与 grounding 读英文段。
    language: args.language,
  });
  const maxChars = featureQaMaxChars(args.question, args.language);
  const fallback = featureQaFallback({
    question: args.question,
    openFeatures: args.openFeatures,
    referencedBlacklistedId: args.referencedBlacklistedId ?? null,
    language: args.language,
  });
  try {
    const { value, usage } = await structuredCall(llm, {
      stage: FEATURE_QA_STAGE,
      name: FEATURE_QA_NAME,
      schema: featureQaSchema,
      system: featureQaSystem(bundle),
      // 只对当前说话人说明，可以看他的问法；这里不会把内容发给任何第三方。
      user: args.question,
      // 说哪种语言由轮次判定（含会话回退）定，不由这一句问法的字面反推。
      language: args.language,
      maxOutputTokens: FEATURE_QA_MAX_OUTPUT_TOKENS,
    });
    const reply = ((value as z.infer<typeof featureQaSchema>).reply ?? "").trim();
    // **通用 grounding 校验**：没原样说出该说的那几段原文、漏提 / 说错被选中的事实名或
    // 理由、或列出了功能清单，一律换回只含 Markdown 原文与登记事实的兜底——绝不放一句
    // 丢了事实的正文出去。
    const ungrounded = findUngroundedFeatureQaFacts(reply, bundle);
    // **共享 grounding 闸**（`feature-grounding.ts`）：本路径无工具、无出站，任何"我去
    // 联系""你自己去找他""换个渠道""以后再说"都是代码事实没有提供的方案——与
    // `reply-only.ts` 同源，换主题 / 换问法都不改这里。
    const violations = findGroundingViolations(reply);
    if (
      !reply ||
      reply.length > maxChars ||
      INTERNAL_TERMS.test(reply) ||
      CLAIMS_ONLY_TWO_FUNCTIONS.test(reply) ||
      violations.length > 0 ||
      ungrounded.length > 0
    ) {
      throw new FeatureCallError(
        FEATURE_QA_STAGE,
        new Error("feature qa reply rejected"),
        usage,
        ungrounded.length
          ? `模型输出的功能回答没有覆盖本轮该说的原文与事实：${ungrounded.join("；")}`
          : violations.length
            ? `模型输出的功能回答越界：${violations.join("；")}`
            : CLAIMS_ONLY_TWO_FUNCTIONS.test(reply)
              ? "模型输出的功能回答把两项专门优化说成了全部能力"
              : "模型输出的功能回答不可用（空 / 超长 / 内部术语）"
      );
    }
    return { reply, fallback, usage };
  } catch (error) {
    return { reply: fallback, fallback, usage: usageOfFeatureError(error), error };
  }
}

/**
 * **这一轮要不要走功能问答。** 返回 null = 不走（落回原来的普通对话，行为不变）。
 *
 * 触发只要求**当前这句话是功能边界问句**（`isFeatureQaQuestion`）。
 */
export async function runFeatureQa(args: {
  text: string;
  openFeatures: readonly FeatureDisplayName[];
  /** 本人上一轮刚被黑名单拒绝的条目 id（结构化引用；没有则 null） */
  referencedBlacklistedId?: string | null;
  /**
   * 本轮住户语言判定（`turn.ts` 在轮次边界判一次，与主生成、功能前门共用同一个值）。
   * 缺省时退回"按这句问法现推"，既有离线调用一行不改。
   */
  language?: LanguageDecision;
  llm: FeatureLlm;
}): Promise<{ reply: string; fallback: string; usage: FeatureUsage; error?: unknown } | null> {
  if (!isFeatureQaQuestion(args.text)) return null;
  return generateFeatureQaReply(
    {
      question: args.text,
      openFeatures: args.openFeatures,
      referencedBlacklistedId: args.referencedBlacklistedId ?? null,
      language: args.language,
    },
    args.llm
  );
}
