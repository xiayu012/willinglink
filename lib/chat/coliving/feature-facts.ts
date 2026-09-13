import {
  BLACKLISTED_CAPABILITIES,
  blacklistedCapabilityById,
  type BlacklistedCapability,
} from "./blacklist";

/**
 * **用户可见功能事实源——一个运行时可直接读取、可打包的单点数据文件。**
 *
 * 老板 2026-09-13 决策（默认宽容）：能力说明不是"只列两项功能、其余一律不能做"。
 * 当前口径是：
 *
 * 1. **两项已批准功能是专门优化的快路径**（`features.ts` 的 `APPROVED_FEATURES`
 *    单一登记点，调用方注入，**不在这里复制**）：命中时更快、更省，由窄上下文
 *    直接替住户发给对方。它们**不是全部能力**，只是被专门优化过的两件。
 * 2. **其它需要协调同住人的请求**，主生成会用恢复的通用短信联系能力走完整的协调
 *    流程（是否该替住户联系某位同屋人，由 doctrine + 本轮 intent 判断）——**不是
 *    不能做**。问答里也要如实这么说。
 * 3. **真正办不了的事只有一个来源**：老板明确登记的**黑名单**
 *    （`blacklist.ts` 的 `BLACKLISTED_CAPABILITIES`，当前是**「卫生整改要求」**一项：
 *    看不到现场严重程度、当前技术不能可靠判断"脏到什么程度才该要求别人整改"）。
 *    与问题**对不上**的条目不得被选中，也不得为它编造原因。
 *
 * 本文件只做数据查找，不做主题分叉：黑名单条目自带 `keywords`（关联用）与
 * `validation.reasonAnchors`（通用 grounding 用）。以后新增 / 改写：只改
 * `blacklist.ts` 的数据与 `APPROVED_FEATURES` 登记，问答引擎一行不动。
 *
 * 本文件只 import 同目录的 `blacklist.ts`（后者不 import 任何东西），不会成环。
 */

/** 两项专门优化功能的统一说明（正文只用 label，不暴露内部机制）。 */
export const OPTIMIZED_FAST_PATH_NOTE =
  "个人物品使用提醒、夜间洗衣提醒这两项有专门优化，处理起来更快、更省";

/** 清单外协调请求的去向：走完整协调流程，不是不能做。 */
export const FULL_FLOW_NOTE =
  "其它需要协调同住人的请求，会走完整的协调流程来处理，不是做不到";

/**
 * **交给模型的那一份用户可见事实**（结构化、可打包）：专门优化的开放功能 +
 * 与本次问题有关的黑名单条目 + 通用说明。开放功能由调用方从 `APPROVED_FEATURES`
 * 注入，**不在这里复制**。
 */
export type FeatureQaFactBundle = {
  /** 当前开放（专门优化）的功能（含 id 供台账；正文只用 label） */
  openFeatures: readonly { id: string; label: string }[];
  /** 与本次问题有关的黑名单条目；**可能为空**（空 = 这个问题没有对得上的"办不了"） */
  blacklisted: readonly BlacklistedCapability[];
  /** 没有选中黑名单条目时的通用说明（不是"做不到"的托词） */
  generic: { fastPath: string; fullFlow: string };
};

/**
 * 与**这次问的问题**有关的黑名单条目（数据查找；没有对得上的条目时为空数组）。
 *
 * **本次问题命中关键词优先**；只有问题本身对不上任何条目、但住户**上一轮刚被**这条
 * 黑名单拒绝（`referencedId`，代码写入的结构化 id，不是自由文本）时，才用那一条——
 * 于是「为什么连这么简单都没有?那你有什么功能？」这种**紧接被拒的追问**也能说出名称
 * 与登记原因。**不按关键词猜「刚才」**：引用是否可用由 `repo.latestBlacklistReference`
 * 的收窄查询（本人 + 紧接本人上一条入站 + 72h）决定，这里只做数据查找。
 */
export function selectBlacklistedCapabilities(
  question: string,
  referencedId?: string | null
): BlacklistedCapability[] {
  const t = (question ?? "").trim();
  const fromQuestion = t
    ? BLACKLISTED_CAPABILITIES.filter((c) => c.keywords.some((k) => t.includes(k)))
    : [];
  if (fromQuestion.length) return fromQuestion;
  const ref = referencedId ? blacklistedCapabilityById(referencedId) : null;
  return ref ? [ref] : [];
}

export function buildFeatureQaFacts(args: {
  openFeatures: readonly { id: string; label: string }[];
  question: string;
  /** 本人上一轮刚被黑名单拒绝的条目 id（代码写入的结构化引用；没有则 null） */
  referencedBlacklistedId?: string | null;
}): FeatureQaFactBundle {
  return {
    openFeatures: args.openFeatures,
    blacklisted: selectBlacklistedCapabilities(
      args.question,
      args.referencedBlacklistedId
    ),
    generic: { fastPath: OPTIMIZED_FAST_PATH_NOTE, fullFlow: FULL_FLOW_NOTE },
  };
}
