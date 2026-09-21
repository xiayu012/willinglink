/**
 * **显式黑名单事实源——目前登记了唯一一项「单方面叫别人在洗完澡后清理地漏头发」。**
 * 只有老板明确批准的事项才会登记进来。
 *
 * 老板 2026-09-13 的产品决策：当前改为**默认宽容**。已批准功能清单
 * （`features.ts` 的 `APPROVED_FEATURES`）**不再是权限边界**，而是一条**低成本、
 * 稳定的优化快路径**——命中它就走窄上下文、独立投递；**没命中不再等于拒绝**，
 * 而是落回完整的 doctrine + 运行时主生成，主生成在这次恢复的通用短信联系能力
 * （`turn.ts` 的 `contactPerson`）下，可以按当前意图/流程判断是否该替住户联系同屋人。
 *
 * 因此"某件事办不了"只有一个来源：**老板明确加入这份黑名单**。老板同日纠正：
 * **「单方面叫别人在洗完澡后清理地漏头发」就是已明确登记的一项**——住户单方面交办
 * AI 去要求**点名的一位室友**，清理由其洗澡 / 使用浴室后留在**地漏里的头发**，
 * 属于**不让系统执行的功能**，不是"尚未开发但仍可交给完整大脑"的普通事项。
 * 真实理由（老板给的，必须如实保留）：**系统看不到地漏头发 / 卫生现场的严重程度；
 * 即使用户描述了现场，当前技术也还没开发到能可靠判断"脏到什么程度才适合替一方
 * 要求另一方整改"的水平**。所以不能替住户发出这类要求。它不是因为这件事不重要，
 * 也不是让住户自己去处理。
 *
 * 反过来说，**其它清单外事项（一般噪音、费用、规矩、去留、说某处有异味、想开窗、
 * 讨论清洁怎么安排）都不是黑名单**，不得因为"不在已批准清单里"就自动拒绝。
 *
 * ## 老板 2026-09-13 进一步纠正：功能是**精确行为**，不是"一类主题"
 *
 * 上一版把这条命名为宽泛的「卫生整改要求」（`hygiene-rectification`），把"要求某位
 * 室友整改卫生"整类包进来，范围过宽。老板要求：**不要"一类"功能；每一项都是死代码级
 * 明确、准确、很窄的最小产品行为**，名字允许很长。因此本项的稳定 id 与住户可见名称
 * 都直接表达这一个具体动作，不再用 `hygiene` 之类的大类命名；以后白名单 / 黑名单里
 * 每一项都遵循这个粒度，**不为省代码把相邻行为包成一个主题类别**。
 *
 * 与此配套，每个条目**各自拥有一个很小的确定性资格复核**（`qualifier`）：
 * 路由选中 `blocked:<id>` 之后，代码还要确认原话**确实同时具备本功能的必要信号**
 * 才阻断；不通过就当作 `none` 落回完整流程（见 `features.ts`）。**精确优先于省代码**，
 * **宁可漏判，不得误杀相邻行为**。
 *
 * ## 为什么不能按关键词拦，而是复用那**一次**功能路由
 *
 * 早期实现是 `matchBlacklistedCapabilityId`：拿 `keywords` 在**每一条原话**上直接
 * 命中。那是错的——住户**讨论**某个功能、**否定**它、**引用**它、**问为什么**时，
 * 原话里同样会出现那些词，会被误当成"正在交办这个黑名单功能"。老板说的是**黑名单
 * 功能**，不是黑名单**词 / 话题**。
 *
 * 正确做法是复用 `features.ts` 里已经存在的**那一次**内部白名单路由：把每个黑名单
 * 条目也作为同一轮路由**可选项**摆给模型（用明确的 `blocked:` token 前缀区分），
 * **只有模型判定住户正在交办这个黑名单功能**时才拦。**不新增第二次 LLM 调用**；
 * 表里没有的事项、或经讨论 / 否定 / 引用 / 提问，都不拦。`keywords` 仍保留，但**只**供
 * 产品功能问答（`feature-facts.ts` 的 `selectBlacklistedCapabilities`）把问题关联到
 * 条目做解释（并与 `qualifier` 一起收窄，**不再用于生产执行的阻断**）。
 *
 * ## 当前黑名单的适用面（不要假装更宽）
 *
 * 这条执行阻断接在功能前门里，而功能前门只在**原话点名了唯一一位同住人**时才启动
 * （`resolveNamedRecipient`，见 `turn.ts`）。所以**现在的黑名单定义面是"对点名的
 * 同住人执行某个功能"这一类请求**——和两条已批准快路径同一类。以后若要覆盖别的
 * 形态的功能，要先扩展前门，不要在本文档不声不响地宣称已经覆盖。
 *
 * 很久以后若要切回"白名单外一律拒绝"，那是一次产品决策，不是这份数据能自动表达的
 * 模式切换——见 `docs/FEATURE_RUNTIME_ARCHITECTURE.md`。
 */

// 纯类型导入（编译后不产生 require）：语言判定的类型只有 `language.ts` 一处，
// 这里不重写一份 `"en" | "zh"`。（`language.ts` 自身零 import，不成环。）
import type { ResidentLanguage } from "./language";

/** 一条**住户可感知的、老板明确批准拒绝**的请求：具名 + 代码站得住的原因。 */
export type BlacklistedCapability = {
  /** 稳定 id（台账 / 结构化状态用）：**直接表达这一个具体动作**，不用大类命名 */
  id: string;
  /** 住户可见的名称：**精确、允许很长**的最小行为，不是主题类别 */
  label: string;
  /**
   * 同一个名称的**自然英文说法**：只在住户这一轮说英文时进入给住户看的正文与
   * grounding 校验，**与已批准功能的 `labelEn` 是同一条口径**（取用只经
   * `blacklistDisplayName`，不在任何地方现翻）。
   *
   * 为什么黑名单也要有：中文 `label` 是老板登记的原话，但"原话照引"只有在对中文住户
   * 说时才成立——对英文住户说时，正文里夹一句中文名称，等于**这一段干脆没被翻译**，
   * 比不给理由更糟。所以英文说法与中文原话一样是**登记好的数据**，不是运行时翻译。
   *
   * 它**只**是住户可见的名称：`id`、内部路由 token、台账与结构化引用一律仍用 `id`。
   */
  labelEn: string;
  /** 为什么办不了——**代码能站得住的原因**，不是说辞 */
  reason: string;
  /** 同一条原因的**自然英文说法**（口径同 `labelEn`）。 */
  reasonEn: string;
  /**
   * 给**那一次内部功能路由**看的一句话定义：只在模型判定住户**正在交办**这项功能时
   * 才选它，用 `blocked:<id>` token 返回。**不是关键词表**。
   */
  routeDescription: string;
  /**
   * 数据：**只供产品功能问答**（`feature-facts.ts`）把住户的**问题**关联到本条目做
   * 解释；**不用于生产执行的阻断**——执行阻断只认那次路由选中的 `blocked:<id>`。
   */
  keywords: readonly string[];
  /**
   * **本条目自己的确定性资格复核**（纯函数、很小）：路由选中 `blocked:<id>` 之后，
   * 代码再确认原话**确实同时具备本功能的必要信号**才阻断（这里 = 有叫 / 让 / 请对方的
   * 交办语义，且在**同一局部语义片段**里出现「地漏 + 头发 + 明确清走动作短语」；点名收件人
   * 已由前门保证）。不通过就当作 `none` 落回完整流程。**精确优先于省代码，宁可漏判，
   * 不得误杀相邻行为。**
   */
  qualifier: (text: string) => boolean;
  /**
   * 数据：通用 grounding 校验（`feature-qa.ts`）用同一段逻辑核对正文有没有保留
   * 这条事实的理由——主题差异全在这份数据里，引擎里没有任何 `if (id === …)` 分支。
   *
   * `reasonAnchors` / `reasonAnchorsEn` 分别是**中文理由与英文理由里「换句话也绕不开」
   * 的核心词**，与各自的 `reason` 成对：英文轮次的正文核对英文锚点，中文轮次核对中文
   * 锚点。两份都要有，否则英文正文永远凑不出中文锚点，grounding 会把每一句英文都判不通过。
   */
  validation: {
    reasonAnchors: readonly string[];
    reasonAnchorsEn: readonly string[];
  };
};

// ── 「单方面叫别人在洗完澡后清理地漏头发」的确定性资格信号（纯函数用，很小） ──
// 这些只是**必要的结构信号**，不是语义分类：真正"是不是在交办"由那次路由的模型判断，
// 这里只负责在模型选了 blocked 之后，用代码确认原话没有跑偏到相邻行为。
const DRAIN_SIGNAL = /地漏/;
const HAIR_SIGNAL = /头发|毛发|发丝/;
/** 交办语义：住户要 AI 去「叫 / 让 / 请 / 要求 / 催 / 转告」对方。 */
const ASK_SIGNAL = /叫|让|请|要求|催|转告|交代|喊/;
/**
 * 清走动作：**必须是明确的两字以上动作短语**，不能用 `洗` / 弄 / 裸 `清` / 裸 `除`
 * 这类可由别的意思满足的单字——「洗完澡」「谁弄的」「怎么清理」都会提供假信号
 * （Codex 2026-09-13 退回）。`弄掉 / 弄走 / 弄干净` 这类**带补语的短语**才收。
 */
const CLEAN_AWAY_SIGNAL =
  /清理|清掉|清走|清干净|清一下|清一清|清光|清出去|清完|弄掉|弄走|弄干净|弄出去|捡掉|捡走|捡起来|捡干净|拿走|拿掉|拿出去|收走|收拾掉|收拾干净|扫掉|扫走|掏掉|掏出来|掏干净|处理掉|处理干净|除掉|去除|去掉|冲掉/;
/**
 * 征询 / 商量 / 问看法 / 疑问：不是交办。**含「请问 / 怎么… / 如何…」这些自然问法**，
 * 免得「请问地漏里的头发怎么清理？」被当成在叫一位室友去办（Codex 2026-09-13 退回）。
 */
const CONSULT_SIGNAL =
  /请问|怎么|如何|要不要|该不该|是不是|好不好|你觉得|你认为|是否|怎么看|怎么想|商量|讨论/;
/** 局部语义片段分隔（句 / 分句 / 顿号 / 换行）：清走动作要与「地漏 + 头发」落在同一片段。 */
const CLAUSE_SPLIT = /[。．.！!？?；;，,、\n\r]+|\s{2,}/;

/**
 * 「单方面叫别人在洗完澡后清理地漏头发」的**资格复核**。
 *
 * 只有原话**同时**满足：① 有交办语义（叫 / 让 / 请对方去办）；② 在**同一个局部语义
 * 片段**里同时出现「地漏 + 头发 + 明确清走动作短语」；③ 不是在征询 / 商量 / 问看法 /
 * 疑问——才认可这是本功能。
 *
 * 这样界定后，纯叙述 / 告知 / 提问**不再**被误当成交办（宁可漏判，不得误杀）：
 * - 「通知阿川，洗完澡后地漏里有头发。」——只告知存在，没有清走动作；
 * - 「让阿川知道，地漏里有头发，谁弄的还不知道。」——「让」是告知对象、「弄」是来源叙述；
 * - 「请问地漏里的头发怎么清理？」——问法，命中征询排除。
 *
 * 相邻行为（都**不**阻断，走完整流程）：
 * - 浴室**墙面**头发（有头发、没有地漏）；
 * - 地漏**疏通 / 维修**（有地漏、没有头发）；
 * - 一般打扫卫生 / 污渍（没有地漏 + 头发这一对）；
 * - 异味 / 开窗（同上）；
 * - 商量清洁安排、只抱怨或问看法（征询排除）。
 */
export function qualifiesShowerDrainCleanupRequest(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (CONSULT_SIGNAL.test(t)) return false;
  if (!ASK_SIGNAL.test(t)) return false;
  return t
    .split(CLAUSE_SPLIT)
    .some(
      (clause) =>
        DRAIN_SIGNAL.test(clause) &&
        HAIR_SIGNAL.test(clause) &&
        CLEAN_AWAY_SIGNAL.test(clause)
    );
}

/**
 * **老板明确批准的黑名单。今天只有一项：「单方面叫别人在洗完澡后清理地漏头发」。**
 *
 * 不要因为"某件事还没开发 / 不在已批准清单里"就把它登记进来；只有老板**点名说要拒绝**
 * 的才加。加之前必须拿到老板给的**具体、代码站得住的原因**（见每条的 `reason`），
 * 并写好这一条自己的 `qualifier`。
 *
 * ### 这一项**只**表示这一个具体动作，不扩大
 *
 * 老板 2026-09-13 的原始纠正针对的是"请叫阿川把地漏的头发清干净"这**一个**具体交办。
 * 因此名称与 `routeDescription` 都收窄到**单方面叫别人在洗完澡后清理地漏头发**：
 *
 * - **正常应拦**：住户点名唯一同住人，**要 AI 去要求对方**清理由其洗澡 / 使用浴室后
 *   留在**地漏里的头发**——例如「阿川……请叫他把地漏的头发清干净」。
 * - **只差一个条件就不应拦**：浴室**墙面**头发；地漏**维修 / 疏通**（没要求清理头发）；
 *   一般打扫卫生、污渍；异味 / 开窗；共同商量清洁安排；只抱怨或询问看法。这些都返回
 *   `none`、落回完整协调流程，**不得**被这一项拦下。
 *
 * 关键差别只有一条：**住户是不是在把"叫对方清地漏头发"这件事交给你去办**。是"交办"
 * 才拦；讨论、抱怨、其它主题都不拦。这一层由**那一次路由**的模型来判，之后再由本条目
 * 的 `qualifier` 用代码复核必要信号（`keywords` 绝不是执行依据）。
 */
export const BLACKLISTED_CAPABILITIES: readonly BlacklistedCapability[] = [
  {
    id: "ask-named-roommate-clean-shower-drain-hair",
    label: "单方面叫别人在洗完澡后清理地漏头发",
    // 同一件事的自然英文说法：住户这一轮说英文时用它，中文住户那边一个字都不变。
    labelEn:
      "one person asking me, on their own, to make a named roommate clear the " +
      "hair out of the shower drain",
    // 老板给的原因，原样保留：看不到现场程度 + 当前技术不能可靠判断整改门槛。
    reason:
      "我看不到现场的严重程度，就算你描述了情况，我现在也还没办法可靠判断到什么程度才该替你去要求对方整改",
    // 同一条原因的英文说法：事实一字不增、一字不减，只是换成英文讲。
    reasonEn:
      "I can't see on site how bad it actually is, and even if you describe it, " +
      "I still can't reliably tell how bad it has to be before I should go and " +
      "ask someone to fix it for you",
    routeDescription:
      "住户点名某位同住人、要你去**要求对方清掉**他洗完澡 / 用完浴室后留在**地漏里的头发**。" +
      "只在住户把这件事**交给你去办**时才选；浴室**墙面**的头发、地漏维修或疏通、" +
      "一般打扫卫生、污渍、说某处有异味、想开窗通风、商量清洁怎么安排、或一句普通抱怨 / " +
      "问看法，都不算。",
    // 只供产品功能问答把**问题**关联到本条目做解释（并与 qualifier 一起收窄）。
    keywords: ["地漏", "头发", "毛发"],
    qualifier: qualifiesShowerDrainCleanupRequest,
    // 通用 grounding 校验用的「换句话也绕不开」的核心词，必须取自上面的 reason。
    validation: {
      reasonAnchors: ["看不到", "程度", "整改"],
      // 英文锚点取自上面的 reasonEn，与它成对（英文轮次核对这一份）。
      reasonAnchorsEn: ["can't see", "how bad", "fix"],
    },
  },
];

/**
 * 黑名单选项在**那一次功能路由**里的 token 前缀。用明确前缀是为了让代码能把
 * "选中的黑名单条目"和"选中的已批准功能 id"精确区分开——不是给模型看的枚举值，
 * 也不是 tool schema。
 */
export const BLACKLIST_ROUTE_PREFIX = "blocked:";

/** 一个黑名单条目在那次路由里的完整 token（`blocked:<id>`）。 */
export function blacklistRouteToken(id: string): string {
  return `${BLACKLIST_ROUTE_PREFIX}${id}`;
}

/**
 * 把路由返回的裸 token 解析回黑名单条目：**只有精确的 `blocked:<id>` 才命中**，
 * 别的 token（含裸 id、带解释的整句）一律 null。表里没有的 id 恒 null。
 */
export function blacklistedCapabilityByRouteToken(
  token: string
): BlacklistedCapability | null {
  const t = (token ?? "").trim();
  if (!t.startsWith(BLACKLIST_ROUTE_PREFIX)) return null;
  const id = t.slice(BLACKLIST_ROUTE_PREFIX.length);
  return BLACKLISTED_CAPABILITIES.find((c) => c.id === id) ?? null;
}

/** 按 id 取回条目。 */
export function blacklistedCapabilityById(
  id: string
): BlacklistedCapability | null {
  return BLACKLISTED_CAPABILITIES.find((c) => c.id === id) ?? null;
}

/**
 * **按本轮语言取条目名称**——住户那一侧唯一的取名函数（执行阻断的回复、问答兜底、
 * 事实包、grounding 四处读的都是它，与 `feature-facts.ts` 的 `featureDisplayName`
 * 同一条口径）。**不在这里翻译任何东西**：两个名字都是登记好的数据，中文轮次取中文
 * 原话、英文轮次取英文说法。
 */
export function blacklistDisplayName(
  cap: BlacklistedCapability,
  language: ResidentLanguage
): string {
  return language === "en" ? cap.labelEn : cap.label;
}

/** 同一条原因的按语言取用（与 `blacklistDisplayName` 成对）。 */
export function blacklistReason(
  cap: BlacklistedCapability,
  language: ResidentLanguage
): string {
  return language === "en" ? cap.reasonEn : cap.reason;
}

/** grounding 用的理由锚点：与上面两个函数取的是**同一份语言**，不能各取各的。 */
export function blacklistReasonAnchors(
  cap: BlacklistedCapability,
  language: ResidentLanguage
): readonly string[] {
  return language === "en"
    ? cap.validation.reasonAnchorsEn
    : cap.validation.reasonAnchors;
}

/**
 * **黑名单命中时的纯代码真话回复**（只在表非空、且那次路由选中了该条目、且资格复核
 * 通过时走到）。不调模型、不列内部术语、不编处理方案：只如实说这件事目前办不了，
 * 给出老板给的理由。正文短、中性，和两条受约束回复路径同一分寸。
 *
 * `language` 是本轮住户语言判定（缺省按中文，与加语言闸之前逐字一致）。名称与理由
 * **按这份判定一起取**（`blacklistDisplayName` / `blacklistReason`）：中文轮次是老板
 * 登记的原话，逐字不变；英文轮次是同一条事实的**登记英文说法**，不是运行时翻译，也
 * 不会把中文原话夹进英文正文。
 */
export function blacklistedReply(
  cap: BlacklistedCapability,
  language: ResidentLanguage = "zh"
): string {
  const label = blacklistDisplayName(cap, language);
  const reason = blacklistReason(cap, language);
  if (language === "en") {
    return `There's one thing I can't do for you — ${label}: ${reason}.`;
  }
  return `「${label}」这件事我目前没法替你办：${reason}。`;
}
