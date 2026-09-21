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
 *    （`blacklist.ts` 的 `BLACKLISTED_CAPABILITIES`，当前是**「单方面叫别人在洗完澡后
 *    清理地漏头发」**一项：看不到现场严重程度、当前技术不能可靠判断"脏到什么程度才该
 *    要求别人整改"）。与问题**对不上**的条目不得被选中，也不得为它编造原因。
 * 4. **住户问起「你是谁 / 你怎么工作」时**，给的是 `COORDINATOR_ROLE_NOTE` 这条
 *    **镜像自 doctrine 的身份事实**（AI 协调员 / 不是管理员 / 没有身体不在现场），
 *    **不是**一份能力清单，更不涉及内部架构、工具、模型或数据库——住户能理解的身份
 *    说明就在 `docs/USER_FACING_CAPABILITY_TRUTH.md`。
 *
 * 本文件只做数据查找，不做主题分叉：黑名单条目自带 `keywords`（关联预筛）、
 * `qualifier`（与执行阻断同一份精确资格判据）与 `validation.reasonAnchors`（通用
 * grounding 用）。以后新增 / 改写：只改 `blacklist.ts` 的数据与 `APPROVED_FEATURES`
 * 登记，问答引擎一行不动。
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
 * **身份事实**：住户问起「你是谁 / 你是干什么的 / 你怎么工作」时，这条路径唯一能给的身份说明。
 *
 * 措辞**镜像既有权威来源** `lib/ai/brains/coliving/doctrine/always/identity.md`
 * （「你是这套房子的 AI 协调员」「是协调员，不是管理员」「没有身体，不在现场」），
 * 这里只镜像这一小段、**不复制整份准则**：功能问答这条路径按设计**不读旧 doctrine**
 * （见 `feature-qa.ts` 顶部说明），所以身份事实必须像黑名单理由一样落在事实源里。
 * 离线哨兵会核对这里的角色名与 doctrine 的写法没有漂移。
 */
export const COORDINATOR_ROLE_NOTE =
  "你是这套房子的 AI 协调员——不是真人，也不是房东或替住户定规矩的管理员：" +
  "共同生活的规则由住在一起的人一起定，你在中间负责沟通、记录和跟进；" +
  "你没有身体、不在现场，看不到也碰不到房子里的人和东西";

/**
 * 身份事实的**英文镜像**，只给代码兜底用（模型那一侧照旧只拿中文事实、按
 * `language.ts` 的语言指令写成住户那一轮的语言）。住户用英文问起时，兜底不能回一段
 * 中文——那正是「用对方的语言回答」这条要求最容易被代码兜底破坏的地方。
 */
export const COORDINATOR_ROLE_NOTE_EN =
  "I'm the AI coordinator for this house — not a person, and not the landlord or " +
  "an administrator who sets the rules: the rules for living together are decided " +
  "by the people who live here, and I handle the talking, the record-keeping and " +
  "the follow-up in between; I have no body and I'm not on site";

/**
 * 报身份时**不能省**的锚点（取自该 doctrine 的硬规则：「AI」两字不能省，不冒充真人）。
 * 与黑名单条目的 `validation.reasonAnchors` 一样由数据给出，grounding 引擎里没有
 * 任何主题分支——住户用中文还是英文问，都要求这句身份披露真的写出来。
 */
export const COORDINATOR_ROLE_ANCHORS: readonly string[] = ["AI"];

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
  /**
   * 住户问起**你自己**（你是谁 / 你是干什么的 / 你怎么工作）时的身份事实；
   * **不是这类问题就是 `null`**——普通的功能边界问答不背这段，既不跑题也省 token。
   */
  selfIntro: { note: string; anchors: readonly string[] } | null;
};

/**
 * 与**这次问的问题**有关的黑名单条目（数据查找；没有对得上的条目时为空数组）。
 *
 * **本次问题命中关键词优先**，且要与**执行阻断同一份精确资格**（`qualifier`）一起满足：
 * 这样"为什么要我清墙面头发 / 疏通地漏 / 打扫卫生"这类**相邻主题的问题**不会被错误地
 * 关联到本条目、也就不会被说成"办不了"。只有问题本身对不上任何条目、但住户**上一轮刚被**
 * 这条黑名单拒绝（`referencedId`，代码写入的结构化 id，不是自由文本）时，才用那一条——
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
    ? BLACKLISTED_CAPABILITIES.filter(
        (c) => c.keywords.some((k) => t.includes(k)) && c.qualifier(t)
      )
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
  /**
   * 住户这一句是不是在问**你自己**。由调用方（`feature-qa.ts` 的窄识别器）判，
   * **不在这里按关键词猜**：本文件只做数据查找，问题分类留在问答引擎一处。
   */
  selfIntro?: boolean;
}): FeatureQaFactBundle {
  return {
    openFeatures: args.openFeatures,
    blacklisted: selectBlacklistedCapabilities(
      args.question,
      args.referencedBlacklistedId
    ),
    generic: { fastPath: OPTIMIZED_FAST_PATH_NOTE, fullFlow: FULL_FLOW_NOTE },
    selfIntro: args.selfIntro
      ? { note: COORDINATOR_ROLE_NOTE, anchors: COORDINATOR_ROLE_ANCHORS }
      : null,
  };
}
