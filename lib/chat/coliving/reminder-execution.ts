import "server-only";

import * as repo from "./repo";

/**
 * **两项受约束提醒（个人物品 / 夜间洗衣）共用的一点点执行脚手架。**
 *
 * 白名单是**功能/动作边界**：只有两项已开放的固定提醒可以由代码替住户发给
 * 另一个住户。命中了白名单的自然请求，就直接调用本功能既有的受约束执行器
 * （写死正文 + 名册校验 + 固定回执），**不需要二次确认**——「要不要发」在这里
 * 不是待定状态，而是「这句话是不是这两件事之一的明确交办」。
 *
 * 这里只放两样东西，两项功能完全相同、又不属于任一功能专有：
 *   1. **可注入的 repo 子集**，让免费测试用假 repo 断言「到底入队了几条、
 *      正文是什么、收件人是谁」，而不是拿「源码里出现过某常量」冒充行为证据；
 *   2. **收件人可达性说明**（姓名未确认 / 当前渠道没有地址）。
 *
 * **不做通用框架。** 各功能的识别、固定正文与发送执行仍在各自模块里
 * （`personal-item-reminder.ts` / `night-laundry-reminder.ts`）。
 */

export type ReminderExecutionDeps = {
  getMembers: typeof repo.getMembers;
  recordDecision: typeof repo.recordDecision;
  queueCommunication: typeof repo.queueCommunication;
  getOrCreateConversation: typeof repo.getOrCreateConversation;
  appendMessage: typeof repo.appendMessage;
};

export const reminderExecutionDeps: ReminderExecutionDeps = {
  getMembers: repo.getMembers,
  recordDecision: repo.recordDecision,
  queueCommunication: repo.queueCommunication,
  getOrCreateConversation: repo.getOrCreateConversation,
  appendMessage: repo.appendMessage,
};

/** 消息里点了不止一个名册姓名 → 收件人不唯一，不发送、只回一句澄清。 */
export const AMBIGUOUS_REMINDER_RECIPIENT_REPLY =
  "这条消息里提到了不止一位室友，请写清楚要提醒谁。";

/** 收件人在**当前**渠道是否可达的真话说明；可发返回 null。 */
export function reminderTargetIneligibleReply(
  target: Pick<repo.Member, "name" | "nameConfirmed" | "address">
): string | null {
  if (!target.nameConfirmed) {
    return `${target.name} 的姓名还没确认，我暂时没法把提醒发给他。`;
  }
  if (!target.address) {
    return `${target.name} 在当前渠道还没有登记地址，我暂时联系不上。`;
  }
  return null;
}
