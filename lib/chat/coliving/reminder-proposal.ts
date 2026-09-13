import "server-only";

import { assertCanWrite } from "./guard";
import * as repo from "./repo";

/**
 * **两项受约束提醒（个人物品 / 夜间洗衣）的「预览 → 确认」持久化核心。**
 *
 * 背景（2026-09-12 老板驳回旧行为）：住户用自然语言说「你能不能私下跟他讲，
 * 这一次先别在深夜洗」，旧实现只回一句「只能按固定说法发：『提醒 <室友名字>：…』」
 * 的模板指引——要求住户自己改写。老板要求换成**可执行的预览 + 一句短确认**：
 * AI 先把「要发给谁、发哪一句固定正文」如实摆出来，住户回「确认」才真的发。
 *
 * 五条不可放宽的性质：
 *
 * 1. **近似识别只产生提案，永远不是直接发送的授权。** 预览是一条发给
 *    **发起人本人**的消息（零第三方出站）；「识别到近似请求」本身绝不构成
 *    发给别人任何消息的许可。
 * 2. **确认的凭据是持久化的提案，不是进程内存、也不是助手文本。** 提案落成
 *    一条 `coliving.communication`（`to_person_id` = 发起人、`channel`、
 *    `household_id`、`purpose` = 本模块的标记、`act='confirm'`、
 *    `expects_reply=true`）＋ 一条 `decision`（`target_person_ids` 里恰好一个
 *    收件人稳定 ID、`model_id` 为空）。确认时只认**该会话最近一条出站**，
 *    核对它确属本功能、已送达、还没被回应，再 `claimReminderProposal`
 *    **按 id 原子认领**（认领那一刻重新校验新鲜度）：并发 / 重复的「确认」
 *    只有一个能认领到行。跨人 / 跨渠道 / 跨会话 / 过期 / 已取消 / 已被抢走
 *    的确认一律拿不到行、不发送。
 * 3. **只有一条提案在飞，新话题即作废。** 新提案落库前先作废旧的；住户回
 *    「取消」、或抛出新话题 / 讨论 / 混合指令时也作废——避免一句「确认」把
 *    一条已经过期的旧提案翻出来发掉。
 * 4. **认领即消耗，没有回头路。** 认领后写第三方失败**不退回认领**（退回会
 *    造成「队列里已有一条、重试再入一条」的重复外呼）。失败可能落在第三方
 *    已入队**之后**，所以只能如实报「发送状态无法确认、不会自动重发」，不能
 *    断言没发出。
 * 5. **不做通用框架。** 这里只放两项提醒共用的少量确定性工具；各自识别、
 *    固定正文、收件人校验与发送执行仍留在各自模块里。
 *
 * 本模块不调用任何模型、不接受自由正文。
 */

/** 两项提醒各自提案的 purpose 标记。前缀用于「取消」时一次作废全部待确认提案。 */
export const REMINDER_PROPOSAL_PURPOSE_PREFIX = "待确认提醒：";

export const REMINDER_PROPOSAL_PURPOSE = {
  personalItem: "待确认提醒：个人物品使用提醒",
  nightLaundry: "待确认提醒：夜间洗衣提醒",
} as const;

/** 与 `replyDueFor(act='confirm')` 一致的 24h 窗口：过期提案不能再被翻出来补发。 */
export const REMINDER_PROPOSAL_TTL_HOURS = 24;

/** 住户回「取消」时的固定真话回复。**没有发过任何第三方消息。** */
export const REMINDER_PROPOSAL_CANCELLED_REPLY = "好，这条提醒不发了。";

/**
 * 认领到的提案在**发送前**核对不过（正文与当前固定文案不一致 / 收件人已不在
 * 当前名册）时的真话回复。**没有发过任何第三方消息**，提案已作废。
 */
export const REMINDER_PROPOSAL_STALE_REPLY =
  "这条提醒已经失效了，我没有发。要发的话请重新说一次。";

/**
 * 认领之后写第三方消息失败时的回复：**认领不退回**（退回会造成重复外呼），
 * 且失败可能发生在 `queueCommunication` **之后**（写会话/消息那一步抛错）——
 * 那时第三方消息其实已经入队、即将发出，说「没发出去」是事实错误，还会让住户
 * 重说一遍造成重复。所以只如实说**发送状态无法确认**，并明确**不会自动重发**。
 */
export const REMINDER_PROPOSAL_FAILED_REPLY =
  "这条提醒的发送状态暂时无法确认，我不会自动重发。";

/** 提案绑定的收件人已不在当前名册 / 当前渠道不可达时的真话回复。 */
export const REMINDER_PROPOSAL_RECIPIENT_GONE_REPLY =
  "这条提醒现在发不出去了：当时的收件人已经不在当前名册里。";

/**
 * 本模块与两个受约束提醒模块用到的 repo 子集。**显式注入**是为了让免费测试
 * 能用假 repo 断言「到底入队了几条、正文是什么、收件人是谁」，而不是拿
 * 「源码里出现过某常量」冒充行为证据。
 */
export type ReminderProposalDeps = {
  getMembers: typeof repo.getMembers;
  recordDecision: typeof repo.recordDecision;
  queueCommunication: typeof repo.queueCommunication;
  getOrCreateConversation: typeof repo.getOrCreateConversation;
  appendMessage: typeof repo.appendMessage;
  linkResponse: typeof repo.linkResponse;
  findLatestOutboundCommunication: typeof repo.findLatestOutboundCommunication;
  claimReminderProposal: typeof repo.claimReminderProposal;
  consumeReminderProposalsByPrefix: typeof repo.consumeReminderProposalsByPrefix;
  getReminderProposalDecision: typeof repo.getReminderProposalDecision;
};

export const reminderProposalDeps: ReminderProposalDeps = {
  getMembers: repo.getMembers,
  recordDecision: repo.recordDecision,
  queueCommunication: repo.queueCommunication,
  getOrCreateConversation: repo.getOrCreateConversation,
  appendMessage: repo.appendMessage,
  linkResponse: repo.linkResponse,
  findLatestOutboundCommunication: repo.findLatestOutboundCommunication,
  claimReminderProposal: repo.claimReminderProposal,
  consumeReminderProposalsByPrefix: repo.consumeReminderProposalsByPrefix,
  getReminderProposalDecision: repo.getReminderProposalDecision,
};

/** 住户对预览的回应类型。**只有整条消息就是这几个词**才算，混合内容一律不认。 */
export type ReminderConfirmationToken = "confirm" | "cancel" | "none";

/**
 * **只认预览里明说的那几个词**（「回复『确认』我就发」）。刻意收窄：
 * 「可以」「同意」「好的」「嗯」「是的」这类在别的话题里也天天出现的词**不算**
 * 确认——一句本来在聊别的事的「可以」不该触发第三方发送。
 */
const CONFIRM_ONLY = /^(?:确认|发送|发吧|就发|可以发)(?:了|吧)?$/;
const CANCEL_ONLY =
  /^(?:取消|不用了|不需要了?|算了|别发了?|不发了?|不要发了?|先别发|作罢|撤销)(?:了|吧)?$/;

/**
 * 解析「确认 / 取消」。**只认整条消息就是那个词**：
 *   · 末尾**不剥问号**——「确认？」「可以吗？」是疑问、不是授权，一律不认；
 *   · 「确认，但别提到我」这类混合指令既不确认也不取消，返回 none。
 * 绝不因歧义触发发送（要求见 DEVELOPMENT_JUDGMENT：混合请求不能只做一半）。
 */
export function parseReminderConfirmation(
  text: string
): ReminderConfirmationToken {
  const t = text.trim().replace(/[。.!！~～、,，;；:：\s]+$/, "");
  if (CONFIRM_ONLY.test(t)) return "confirm";
  if (CANCEL_ONLY.test(t)) return "cancel";
  return "none";
}

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

/**
 * 落一条待确认提案：入站（住户请求）→ decision（绑定收件人稳定 ID）→
 * 发给发起人本人的预览 communication → 预览 outbound message。
 *
 * **只写发给发起人的消息**，不产生任何第三方出站。入站先写，保证历史
 * 顺序是「住户请求 → AI 预览」而不是反过来。
 *
 * 落新提案前先作废该发起人 / 渠道 / 房子里所有还没回应的旧提案：**同一时刻
 * 只允许一条待确认提案**，否则后来说的「确认」可能把一条更旧的翻出来发掉。
 */
export async function createReminderProposal(
  deps: ReminderProposalDeps,
  args: {
    householdId: string;
    /** 目标房子是不是测试屋（由调用方从 household 行取，透传自 deliver 入参）。 */
    senderIsTest: boolean;
    requesterPersonId: string;
    conversationId: string;
    channel: string;
    recipientPersonId: string;
    purpose: string;
    /** 内部留痕用的功能名，例如「个人物品使用提醒」。 */
    label: string;
    previewText: string;
    /** 住户这一轮的原始请求正文，落在入站消息里。 */
    inboundText: string;
  }
): Promise<{ decisionId: string; communicationId: string }> {
  // 落预览同样是一次写入（入站消息 + decision + communication + outbound），
  // 必须与真正的发送共用同一条硬闸：本地进程不许在真人住的房子里落任何提案。
  // 没有这道闸，近似入口就能绕开 execute* 的 assertCanWrite 写进真实数据。
  assertCanWrite({
    isTestHousehold: args.senderIsTest,
    what: "落待确认提醒提案",
  });
  await deps.consumeReminderProposalsByPrefix({
    householdId: args.householdId,
    requesterPersonId: args.requesterPersonId,
    channel: args.channel,
    purposePrefix: REMINDER_PROPOSAL_PURPOSE_PREFIX,
    withinHours: REMINDER_PROPOSAL_TTL_HOURS,
  });
  const inboundId = await deps.appendMessage({
    conversationId: args.conversationId,
    personId: args.requesterPersonId,
    direction: "inbound",
    channel: args.channel,
    body: args.inboundText,
  });
  if (inboundId) {
    await deps.linkResponse({
      personId: args.requesterPersonId,
      messageId: inboundId,
    });
  }
  const decisionId = await deps.recordDecision({
    householdId: args.householdId,
    kind: "contact_one",
    targetPersonIds: [args.recipientPersonId],
    intent: args.purpose,
    rationale: `待确认提案：${args.label}；还没有发给收件人，等发起人确认后才发。`,
    modelId: null,
  });
  const communicationId = await deps.queueCommunication({
    householdId: args.householdId,
    decisionId,
    caseId: null,
    toPersonId: args.requesterPersonId,
    channel: args.channel,
    purpose: args.purpose,
    body: args.previewText,
    act: "confirm",
    expectsReply: true,
  });
  await deps.appendMessage({
    conversationId: args.conversationId,
    personId: args.requesterPersonId,
    direction: "outbound",
    channel: args.channel,
    body: args.previewText,
    communicationId,
  });
  return { decisionId, communicationId };
}

/**
 * 认领**本会话最近一条出站**所对应的那条提案，取回绑定信息。**拿不到就返回
 * `none`，调用方绝不发送。**
 *
 * 判定顺序（全部是确定性的、不调模型）：
 *   1. 取该住户这条会话线里**最近一条出站消息**（不分 purpose、不分状态）；
 *   2. 它必须绑定**当前**会话（`conversationId` 一致）、属于**本项**功能、
 *      `status='sent'`（预览真的送达）、`act='confirm'`、还没被回应、仍在
 *      时间窗内——任何一条不符就是 `none`（旧提案不会藏在新消息后面复活）；
 *   3. 核对它关联的 decision：本屋、`contact_one`、`intent` 与 `purpose` 一致、
 *      `model_id` 为空、`target_person_ids` 恰好一个且不是发起人本人；
 *   4. 用 `claimReminderProposal` **按 id 原子认领**（认领那一刻重新校验
 *      「仍是最近一条出站」）；并发第二次拿不到行 → `none`。
 *
 * **正文与收件人可达性仍由各自功能模块在认领后核对**（每项固定正文不同），
 * 核对不过就把这条已认领的提案当失效处理、不发送。
 */
export type ReminderProposalTake =
  | { kind: "none" }
  | {
      kind: "claimed";
      communicationId: string;
      decisionId: string;
      recipientPersonId: string;
      /** 预览当时的正文；功能模块据此核对是否与当前固定文案逐字一致。 */
      body: string;
    };

export async function takeReminderProposal(
  deps: ReminderProposalDeps,
  args: {
    householdId: string;
    requesterPersonId: string;
    channel: string;
    /** 发起人当前会话线；候选必须绑定在它上面（防串台/防旧线复活）。 */
    conversationId: string;
    purpose: string;
  }
): Promise<ReminderProposalTake> {
  const latest = await deps.findLatestOutboundCommunication({
    householdId: args.householdId,
    personId: args.requesterPersonId,
    channel: args.channel,
  });
  if (!latest || !latest.communicationId) {
    return { kind: "none" };
  }
  if (latest.conversationId !== args.conversationId) {
    return { kind: "none" };
  }
  if (latest.purpose !== args.purpose) {
    return { kind: "none" };
  }
  if (
    latest.status !== "sent" ||
    latest.act !== "confirm" ||
    latest.respondedAt !== null
  ) {
    return { kind: "none" };
  }
  const at = latest.sentAt ?? latest.createdAt;
  if (
    !at ||
    Date.now() - new Date(at).getTime() >
      REMINDER_PROPOSAL_TTL_HOURS * 3600 * 1000
  ) {
    return { kind: "none" };
  }
  if (!latest.decisionId) {
    return { kind: "none" };
  }
  const decision = await deps.getReminderProposalDecision(latest.decisionId);
  if (
    !decision ||
    decision.householdId !== args.householdId ||
    decision.kind !== "contact_one" ||
    decision.intent !== args.purpose ||
    decision.modelId !== null ||
    decision.targetPersonIds.length !== 1
  ) {
    return { kind: "none" };
  }
  const recipientPersonId = decision.targetPersonIds[0];
  if (recipientPersonId === args.requesterPersonId) {
    return { kind: "none" };
  }
  const claimed = await deps.claimReminderProposal({
    communicationId: latest.communicationId,
    householdId: args.householdId,
    personId: args.requesterPersonId,
    channel: args.channel,
    withinHours: REMINDER_PROPOSAL_TTL_HOURS,
  });
  if (!claimed) {
    return { kind: "none" };
  }
  return {
    kind: "claimed",
    communicationId: claimed.communicationId,
    decisionId: latest.decisionId,
    recipientPersonId,
    body: latest.body,
  };
}

/** 住户回「取消」：一次作废全部还没回应的待确认提案，返回作废条数。 */
export async function cancelPendingReminderProposals(
  deps: ReminderProposalDeps,
  args: { householdId: string; requesterPersonId: string; channel: string }
): Promise<number> {
  return await deps.consumeReminderProposalsByPrefix({
    householdId: args.householdId,
    requesterPersonId: args.requesterPersonId,
    channel: args.channel,
    purposePrefix: REMINDER_PROPOSAL_PURPOSE_PREFIX,
    withinHours: REMINDER_PROPOSAL_TTL_HOURS,
  });
}
