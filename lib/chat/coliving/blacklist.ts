/**
 * **显式黑名单事实源——目前为空；只有老板明确批准的事项才会登记进来。**
 *
 * 老板 2026-09-13 的产品决策：当前改为**默认宽容**。已批准功能清单
 * （`features.ts` 的 `APPROVED_FEATURES`）**不再是权限边界**，而是一条**低成本、
 * 稳定的优化快路径**——命中它就走窄上下文、独立投递；**没命中不再等于拒绝**，
 * 而是落回完整的 doctrine + 运行时主生成，主生成在这次恢复的通用短信联系能力
 * （`turn.ts` 的 `contactPerson`）下，可以按当前意图/流程判断是否该替住户联系同屋人。
 *
 * 因此"某件事办不了"只有一个来源：**老板明确加入这份黑名单**。今天一条都没有；
 * 旧实现里当作"未开放"的卫生整改、一般噪音、费用、规矩、去留等都**不是黑名单**，
 * 不得因为"不在已批准清单里"就自动拒绝。
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
 * 表为空时路由选项为空、绝不拦。`keywords` 仍保留，但**只**供产品功能问答
 * （`feature-facts.ts` 的 `selectBlacklistedCapabilities`）把问题关联到条目做解释，
 * **不再用于生产执行的阻断**。
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

/** 一条**住户可感知的、老板明确批准拒绝**的请求：具名 + 代码站得住的原因。 */
export type BlacklistedCapability = {
  /** 稳定 id（台账 / 结构化状态用） */
  id: string;
  /** 住户可见的名称 */
  label: string;
  /** 为什么办不了——**代码能站得住的原因**，不是说辞 */
  reason: string;
  /**
   * 给**那一次内部功能路由**看的一句话定义：只在模型判定住户**正在交办**这项功能时
   * 才选它，用 `blocked:<id>` token 返回。**不是关键词表**。
   */
  routeDescription: string;
  /**
   * 数据：**只供产品功能问答**（`feature-facts.ts`）把住户的**问题**关联到本条目做
   * 解释；**不用于生产执行的阻断**——执行阻断只认上面那次路由。
   */
  keywords: readonly string[];
  /**
   * 数据：通用 grounding 校验（`feature-qa.ts`）用同一段逻辑核对正文有没有保留
   * 这条事实的理由——主题差异全在这份数据里，引擎里没有任何 `if (id === …)` 分支。
   */
  validation: { reasonAnchors: readonly string[] };
};

/**
 * **老板明确批准的黑名单。今天为空——空表意味着不产生任何拒绝，也不进路由选项。**
 *
 * 不要把"还没开放'的诉求自动登记进来；只有老板点名说要拒绝的才加。
 */
export const BLACKLISTED_CAPABILITIES: readonly BlacklistedCapability[] = [];

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
 * 别的 token（含裸 id、带解释的整句）一律 null。空表恒 null。
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
 * **黑名单命中时的纯代码真话回复**（只在表非空、且那次路由选中了该条目时走到）。
 * 不调模型、不列内部术语、不编处理方案：只如实说这件事目前办不了，给出老板给的
 * 理由。正文短、中性，和两条受约束回复路径同一分寸。
 */
export function blacklistedReply(cap: BlacklistedCapability): string {
  return `「${cap.label}」这件事我目前没法替你办：${cap.reason}。`;
}
