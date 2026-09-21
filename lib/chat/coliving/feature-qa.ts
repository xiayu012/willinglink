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
  COORDINATOR_ROLE_NOTE,
  COORDINATOR_ROLE_NOTE_EN,
  featureDisplayName,
  FULL_FLOW_NOTE,
  OPTIMIZED_FAST_PATH_NOTE,
  selectBlacklistedCapabilities,
  type FeatureDisplayName,
  type FeatureQaBlacklistFact,
  type FeatureQaFactBundle,
} from "./feature-facts";
import { findGroundingViolations } from "./feature-grounding";
import { residentLanguage, type LanguageDecision } from "./language";

/**
 * **统一的产品功能问答入口——不是功能、不是工具、不出站。**
 *
 * 老板 2026-09-13 决策（默认宽容）：住户问「你有什么功能 / 能不能做 X / 为什么 X
 * 不能做 / 刚才为什么拒绝 / **你是谁、你是干什么的、你怎么工作**」这类**产品边界与
 * 自称元问题**时进这里，读 `feature-facts.ts` 那份统一事实源回答。**口径不再是
 * "只有两项功能"**：
 *
 * - 两项已批准功能是**专门优化的快路径**（更快、更省），不是全部能力；
 * - 其它需要协调同住人的请求会走**完整的协调流程**处理，**不是不能做**；
 * - 真正办不了的只有老板明确登记的**黑名单**（`blacklist.ts`，当前一项是**「单方面叫
 *   别人在洗完澡后清理地漏头发」**）。与问题对不上的条目不得被选中，也不得为它编造原因。
 *
 * **住户问起「你是谁 / 你怎么工作」**（`asksAboutSelf`）走的是同一次回答、同一个兜底，
 * 只是多拿一条身份事实（`COORDINATOR_ROLE_NOTE`，镜像 doctrine 的「AI 协调员」那段）。
 * 它**不给**能力清单、**不碰**内部架构 / 工具 / 模型 / 数据库，也**不改**任何第三方动作
 * 权限（本路径零工具、零出站这条不变）；问身份与问能力都要求列全专门优化功能，所以
 * "只有这两项"这种失真在两条路上都会被兜底换掉。
 *
 * 以后新增功能**只改事实源数据 / `APPROVED_FEATURES`，不改本文件**。
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
 * **与这个问题有关**的事实（`buildFeatureQaFacts`）、当前专门优化的功能清单——**功能名
 * 按本轮语言取显示名**（`feature-facts.ts` 的 `featureDisplayName`：中文登记名 / 英文
 * 显示名），所以英文问句里不会夹着中文功能名，模型也不必自己译。模型只
 * 负责把事实说成自然、简短的、**住户这一轮语言**的回应（语言由轮次判定给出，见
 * `language.ts`）；**不得补充处理方案、虚构能力、或承诺立刻去联系 / 跟进**。写出内部
 * 术语 / 假承诺，或**把球踢回住户（「你自己去找他」「换个渠道」「以后再说」）**，或
 * 结构不合法时，用**同样只含事实源事实**的代码兜底（`featureQaFallback`）。共享的
 * grounding 判定见 `feature-grounding.ts`。
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
 * 问起自己时，正文必须同时说清身份、两个功能名和完整流程那条，按 240 字符卡几乎必然
 * 被换掉兜底——那等于英文这条路白修。上限按语言取，只放宽英文，中文口径一字不动。
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
 * 快路径**、不是全部能力。住户问起自己时最容易滑向"我只能做这两件事"，一旦说成就换回
 * 只含事实源事实的兜底——这和内部术语一样是**这条路径自己的格式约束**，不是 grounding。
 */
const CLAIMS_ONLY_TWO_FUNCTIONS =
  /只有(?:这|那)?两(?:项|个|件)|就(?:是)?这(?:两|2)(?:项|个|件)|只能做这(?:两|2)件|only (?:these |the )?two\b/i;

/**
 * 住户是不是在问「你现在能做什么 / 你有哪些功能」。**只做元问题识别，不做主题分类。**
 * 抽出来单独暴露，因为 grounding 校验要据此决定**必须逐项列出全部专门优化的功能名**
 * （住户明确问能力清单时不能漏项；只问「为什么办不了某件事」则不强制全列）。
 */
export function asksWhatIsAvailable(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return (
    (/有什么|有哪些|都有什么|都有哪些|会什么|能做什么|能干什么/.test(t) &&
      /功能|能力|本事|作用|能|可以/.test(t)) ||
    (/功能|能力/.test(t) && /(有哪些|有什么|都是什么|是哪些)/.test(t)) ||
    /(能|可以|会)(帮|替|给|为)?(我|你)?(做|干|办)(什么|啥|哪些)/.test(t) ||
    /(帮|替)?(我)?(能|可以)(做|干|办)(什么|啥|哪些)/.test(t)
  );
}

/**
 * 自称类问句里允许出现的**最小句式**（中英各若干条）。只写"住户在问你是谁 / 你是
 * 干什么的 / 你怎么工作"这几种意思，不写主题词——主题分类不在这里做。
 */
const SELF_QUOTE_PHRASES: readonly string[] = [
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
  "你能(?:帮|替|给|为)?(?:我|我们)?(?:做|干|办)(?:什么|啥|哪些)",
  "你会(?:做|干)(?:什么|啥|哪些)",
  "你(?:都)?有(?:什么|哪些)功能",
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
  "what can you do(?: for (?:me|us))?",
  "what do you do(?: for (?:me|us))?",
];

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
 * **"问身份/角色"**。两者都会让回答必须列全专门优化功能——住户在要一份整体说明时，
 * 漏项本身就是失真。身份事实取 `feature-facts.ts` 的 `COORDINATOR_ROLE_NOTE`
 * （镜像自 doctrine 的「AI 协调员」那段），**不是**一份能力清单。
 *
 * 判据是**结构不是主题**：整句话必须**就是**一句（或连着几句）自称类问句，前面只允许
 * 一句招呼 / 「请问」。**只要后面还跟着别的要求就整条不认**——「你是谁？顺便帮我跟阿川
 * 说一声」里有一件真正要办的事，被这里吞掉就等于住户的交办没人办。同理
 * 「what can you do about the noise next door?」不认：`about …` 后面挂着一个具体
 * 诉求，那是交办不是问身份。
 *
 * 宁可漏掉口语变体（漏了就退回普通对话，不会造成新的越界），也不把普通交办误判进来。
 */
export function asksAboutSelf(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  // 英文撇号有直撇和弯撇两种写法，先归一，免得「what’s this?」漏掉。
  return SELF_QUOTE_RE.test(t.replace(/[’‘]/g, "'"));
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
 * **只含事实源事实的兜底**。模型完全写不出可用回应、或写出违规内容时用它——它同样
 * 不承诺、不虚构、不列内部术语，只把事实摆出来。**没有选中黑名单条目时不说任何
 * "办不了"**。
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
  // 功能名**按同一份判定取显示名**：英文轮次取自然英文显示名（与交给模型的事实包、
  // grounding 校验读的是同一个函数），中文轮次取登记名、逐字不变。
  const openNames = args.openFeatures.map((f) => featureDisplayName(f, language));
  // **兜底也要说住户那一轮的语言**：住户用英文问、模型那侧又没写出可用正文时，回一段
  // 中文（或一段夹着中文功能名的英文）正是「用对方的语言回答」最容易被代码兜底破坏的地方。
  if (language === "en") {
    return englishFeatureQaFallback({
      blacklisted,
      openLabels: openNames,
      selfIntro: asksAboutSelf(args.question),
    });
  }
  const open = openNames.join("、");
  if (blacklisted.length) {
    const f = blacklisted[0];
    const fast = open ? `${OPTIMIZED_FAST_PATH_NOTE}。` : "";
    return `「${f.displayName}」这件事我目前没法替你办：${f.reason}。${fast}${FULL_FLOW_NOTE}。`;
  }
  // 问起我自己：先说清身份（镜像 doctrine 的「AI 协调员」那段），再说能帮上什么忙。
  const facts = args.openFeatures.length
    ? `我目前对${open}有专门优化，处理起来更快、更省；${FULL_FLOW_NOTE}。`
    : `${FULL_FLOW_NOTE}。`;
  if (asksAboutSelf(args.question)) {
    return `${COORDINATOR_ROLE_NOTE}。${facts}`;
  }
  if (args.openFeatures.length) {
    return facts;
  }
  return `${FULL_FLOW_NOTE}。`;
}

/**
 * 英文列举（`a` / `a and b` / `a, b and c`）——**只服务于下面这一段代码兜底**，不是通用
 * 工具：显示名是单数名词短语，简单 `join(", ")` 接在句子成分里读不顺。
 */
function englishList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * 兜底的英文写法，**事实与中文兜底同一份**（角色说明取 `COORDINATOR_ROLE_NOTE_EN`）。
 *
 * `openLabels` 与 `blacklisted` 拿到的都是**已经按语言取好的字段**（调用方走
 * `featureDisplayName` / `blacklistFact`，英文轮次即登记好的英文说法）——这里不翻译、
 * 不拼词，只把它们摆进句子；于是整段英文兜底里一个汉字都不会有。**理由与名称必须是
 * 同一次取用的结果**：名称取英文、理由还是中文原话，读起来就是一段没翻完的英文。
 */
function englishFeatureQaFallback(args: {
  blacklisted: readonly FeatureQaBlacklistFact[];
  openLabels: readonly string[];
  selfIntro: boolean;
}): string {
  const role = args.selfIntro ? `${COORDINATOR_ROLE_NOTE_EN}. ` : "";
  const shortcuts = args.openLabels.length
    ? `I handle ${englishList(args.openLabels)} on a faster, cheaper dedicated path; `
    : "";
  const fullFlow =
    "anything else that needs coordinating between the people who live here goes " +
    "through the full coordination flow, so it's not that I can't do it";
  if (args.blacklisted.length) {
    const f = args.blacklisted[0];
    return `${role}There's one thing I can't do for you — ${f.displayName}: ${f.reason}. ${shortcuts}${fullFlow}.`;
  }
  return `${role}${shortcuts}${fullFlow}.`;
}

/**
 * **通用 grounding 校验——只读事实源的验证元数据，引擎里没有任何主题分支。**
 *
 * 接受的正文必须：
 * 1. 含**每一条**被选中的黑名单条目的 `displayName`；
 * 2. 保留它的**理由**——含该条目 `reasonAnchors` 里的**每一个**锚点词
 *    （允许自然改写措辞：锚点是数据里「换句话也绕不开」的核心词）。名称、理由与锚点
 *    是**同一次按语言取用的结果**（`blacklistFact`），所以英文轮次核的是英文说法与
 *    英文锚点，中文轮次逐字不变；
 * 3. 当住户明确在问「你能做什么」或问起「你是谁」（`asksWhatIsAvailable` /
 *    `asksAboutSelf`）时，含**当前全部**专门优化功能的**显示名**，一项不漏；名字由
 *    `bundle` 按本轮语言取好（英文轮次是英文显示名），所以英文正文里凑不出中文登记名
 *    就判不通过——**这正是要防的**：英文住户不该收到夹着中文功能名的英文回应；
 * 4. 问起我自己时，含 `selfIntro.anchors` 里的每一个锚点——doctrine 的硬规则是
 *    「AI」两字不能省（不冒充真人），住户用中文还是英文问都得说出来。
 *
 * 返回空数组 = 通过；否则返回**缺了什么**的可诊断短语，调用方据此换成只含事实源事实的
 * `featureQaFallback`。新增功能 / 条目只改事实源数据，本函数一行不动。
 */
export function findUngroundedFeatureQaFacts(
  reply: string,
  bundle: FeatureQaFactBundle,
  opts: { requireOpenLabels: boolean }
): string[] {
  const text = reply ?? "";
  const missing: string[] = [];
  for (const fact of bundle.blacklisted) {
    if (!text.includes(fact.displayName)) {
      missing.push(`未提到事项「${fact.displayName}」`);
      continue;
    }
    const absent = fact.reasonAnchors.filter((a) => !text.includes(a));
    if (absent.length) {
      missing.push(`未保留「${fact.displayName}」的原因（缺：${absent.join("、")}）`);
    }
  }
  if (bundle.selfIntro) {
    const absent = bundle.selfIntro.anchors.filter((a) => !text.includes(a));
    if (absent.length) {
      missing.push(`没有说清自己的身份（缺：${absent.join("、")}）`);
    }
  }
  if (opts.requireOpenLabels) {
    for (const f of bundle.openFeatures) {
      if (!text.includes(f.displayName)) {
        missing.push(`未列出优化功能「${f.displayName}」`);
      }
    }
  }
  return missing;
}

function featureQaSystem(
  bundle: FeatureQaFactBundle,
  requireOpenLabels: boolean
): string {
  // 功能名用**已经按本轮语言取好的显示名**：英文轮次这里是英文名，模型照抄即可，
  // 不需要自己把中文登记名译成自然英文（那正是要避免的即兴发挥）。
  const open = bundle.openFeatures.length
    ? bundle.openFeatures.map((f) => `- ${f.displayName}`)
    : ["（目前没有）"];
  const blacklisted = bundle.blacklisted.length
    ? bundle.blacklisted.map((c) => `- ${c.displayName}：${c.reason}`)
    : ["（没有与这个问题对应的、明确办不了的事项）"];
  return [
    "你是这套房子的 AI 协调员。住户正在问你跟你自己有关的问题：你是谁、你是干什么的、你怎么工作、你有哪些功能、某件事能不能做、为什么某件事做不了、或者刚才为什么没给他办。",
    "**你只能依据下面这些事实回答**，不得补充、不得猜测、不得虚构、不得承诺：",
    "",
    // 问起我自己时才给这段身份事实：普通的功能边界问答不背它，既不跑题也省 token。
    ...(bundle.selfIntro
      ? ["关于你自己（住户正在问你是谁 / 你怎么工作）：", bundle.selfIntro.note, ""]
      : []),
    `你目前**专门优化**、处理起来更快更省的功能（这两项不是你的全部能力，只是被优化过的两件）：`,
    ...open,
    "",
    "你目前**明确办不了**、且有原因的事项（这才是真正的「办不了」）：",
    ...blacklisted,
    `其它需要协调同住人的请求（例如替他把某件事跟另一位同住人沟通），${FULL_FLOW_NOTE}。`,
    "",
    "必须做到：",
    "- 用**一两句**自然、口语的话直接回答他，别绕；**用他这一轮说话用的那种语言**，不要生硬地换成另一种。",
    `- **不要说「只有这两项功能」或「只能做这两件事」**：它们只是被专门优化、更快更省的；其它协调请求走完整协调流程，不是做不到。`,
    `- **不要编造某件事办不了或一个「为什么不能做」的原因**；只有上面明确列为办不了的事项才说办不了、并保留写的那个原因。住户说的那件事若不在办不了清单里，就不要说它办不了。`,
    ...(bundle.selfIntro
      ? [
          "- 住户问起你时，**说清自己是「AI 协调员」**（「AI」两个字不能省），并如实说不是真人、不是房东、也不是替住户定规矩的管理员；共同生活的规则由住在一起的人一起定。",
          "- 只讲上面给的身份事实：**不提**你由什么做出来、用什么模型、跑在什么系统上、有没有数据库，也不提任何内部工具、流程或代码；不讲实现细节，也不描述内部机制。",
        ]
      : []),
    ...(bundle.blacklisted.length
      ? [
          "- 上面列出的、与这个问题有关的办不了的事项：要把它的**名称**说出来，并保留写的那个**原因**（可以换措辞，但不得省略、不得换掉成别的原因）。",
        ]
      : []),
    ...(requireOpenLabels
      ? [
          "- 住户在问你能做什么：把上面列出的**每一项**专门优化功能都用它的名称说出来，一项都不要漏，并说明其它协调请求走完整流程。",
        ]
      : []),
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
 * **只含事实源事实**的代码兜底。校验（结构 + 非空 + 长度 + 内部术语 + 假承诺 / 自创
 * 处理方案）都在纯代码侧完成，模型没有机会把这些违规内容发出去。
 */
export async function generateFeatureQaReply(
  args: {
    question: string;
    /**
     * 已批准功能（`APPROVED_FEATURES`）。**两个显示名都带着**（`label` 登记名 +
     * `labelEn` 英文显示名），由事实源按本轮语言取用——引擎里不翻译、不拼名字。
     */
    openFeatures: readonly FeatureDisplayName[];
    /**
     * 本人**上一轮刚被黑名单拒绝**的条目 id（结构化引用；`repo.latestBlacklistReference`
     * 的收窄查询结果）。问题本身对不上条目、但这是紧接被拒的追问时，据此说出名称与原因。
     */
    referencedBlacklistedId?: string | null;
    /** 本轮住户语言判定（`turn.ts` 判一次）——正文上限、模型指令、显示名、兜底都由它定。 */
    language?: LanguageDecision;
  },
  llm: FeatureLlm
): Promise<{ reply: string; fallback: string; usage: FeatureUsage; error?: unknown }> {
  // 问起我自己（你是谁 / 你怎么工作）与问能力是同一类"要一份整体说明"的问题：
  // 分类在引擎这一处做完，事实源只做数据查找（见 `buildFeatureQaFacts`）。
  const selfIntro = asksAboutSelf(args.question);
  const bundle = buildFeatureQaFacts({
    openFeatures: args.openFeatures,
    question: args.question,
    referencedBlacklistedId: args.referencedBlacklistedId ?? null,
    selfIntro,
    // 显示名按本轮语言取：英文轮次的事实包与 grounding 用英文显示名。
    language: args.language,
  });
  // 住户明确问「你能做什么」或问起「你是谁」时必须逐项列出全部专门优化功能名；
  // 只问「为什么某件事办不了」则不强制全列。
  const requireOpenLabels = asksWhatIsAvailable(args.question) || selfIntro;
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
      system: featureQaSystem(bundle, requireOpenLabels),
      // 只对当前说话人说明，可以看他的问法；这里不会把内容发给任何第三方。
      user: args.question,
      // 说哪种语言由轮次判定（含会话回退）定，不由这一句问法的字面反推。
      language: args.language,
      maxOutputTokens: FEATURE_QA_MAX_OUTPUT_TOKENS,
    });
    const reply = ((value as z.infer<typeof featureQaSchema>).reply ?? "").trim();
    // **通用 grounding 校验**：漏提 / 说错被选中的事实名或理由、或该列全功能时漏项，
    // 一律换回只含事实源事实的兜底——绝不放一句丢了事实的正文出去。
    const ungrounded = findUngroundedFeatureQaFacts(reply, bundle, {
      requireOpenLabels,
    });
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
          ? `模型输出的功能回答没有覆盖全部事实：${ungrounded.join("；")}`
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
