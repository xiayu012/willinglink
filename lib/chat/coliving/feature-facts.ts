import {
  BLACKLISTED_CAPABILITIES,
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
 *    （`blacklist.ts` 的 `BLACKLISTED_CAPABILITIES`，**目前为空**）。空黑名单
 *    不得产生任何"这件事办不了"的说法，也不得为它编造原因。
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
  /** 与本次问题有关的黑名单条目；**可能为空**（空 = 没有能说出口的"办不了"） */
  blacklisted: readonly BlacklistedCapability[];
  /** 黑名单为空时的通用说明（不是"做不到"的托词） */
  generic: { fastPath: string; fullFlow: string };
};

/** 与**这次问的问题**有关的黑名单条目（数据查找；空表恒为空数组）。 */
export function selectBlacklistedCapabilities(
  question: string
): BlacklistedCapability[] {
  const t = (question ?? "").trim();
  if (!t) return [];
  return BLACKLISTED_CAPABILITIES.filter((c) =>
    c.keywords.some((k) => t.includes(k))
  );
}

export function buildFeatureQaFacts(args: {
  openFeatures: readonly { id: string; label: string }[];
  question: string;
}): FeatureQaFactBundle {
  return {
    openFeatures: args.openFeatures,
    blacklisted: selectBlacklistedCapabilities(args.question),
    generic: { fastPath: OPTIMIZED_FAST_PATH_NOTE, fullFlow: FULL_FLOW_NOTE },
  };
}
