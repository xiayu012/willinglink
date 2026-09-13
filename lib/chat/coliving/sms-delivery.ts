import "server-only";

import { assertCanWrite } from "./guard";
import * as repo from "./repo";

/**
 * **已批准功能共用的短信投递基础设施——纯代码，不调模型、不是给模型看的工具。**
 *
 * 老板 2026-09-13 定稿：**功能**是唯一正式的最小批准单位（各写各的朴素代码，
 * 不强行抽象）；**工具只是底层机械动作**，不决定权限。这里放的就是
 * 那个"底层机械动作"里**所有功能完全一样**的一点点纯代码：
 *
 * - `resolveNamedRecipient`：收件人只能绑住户**原始原话**里点名且唯一的非本人
 *   同住人。它只从原话里取人，**不看模型说什么**——模型改不了收件人。
 * - `smsRecipientIneligibleReply`：收件人在**当前渠道**不可达时的真话说明。
 * - `deliverSms`：把一条已经定稿的正文写进既有链路（decision → communication →
 *   appendMessage），并过 `assertCanWrite` 硬闸。
 *
 * **它不知道也不判断"哪件事"**——功能识别与正文生成在各自的朴素功能模块里。这里
 * 只保证：谁收、能不能收、以及写完落库时仍过发送硬闸。**这里不 import 任何模型**。
 */

export type SmsRecipient = Pick<
  repo.Member,
  "personId" | "name" | "nameConfirmed" | "address"
>;

export type SmsRecipientResult =
  | { ok: true; recipient: SmsRecipient }
  | { ok: false; reason: string };

/** 原话里点名且去重的非本人名册成员（姓名长度 >= 2 才算点名）。 */
function namedRoommates(
  text: string,
  members: readonly repo.Member[],
  senderPersonId: string
): repo.Member[] {
  return members.filter(
    (m) =>
      m.personId !== senderPersonId &&
      m.name.trim().length >= 2 &&
      text.includes(m.name.trim())
  );
}

/** 原话点名的收件人不唯一时回给住户的澄清句（零出站）。 */
export const AMBIGUOUS_SMS_RECIPIENT_REPLY =
  "这条消息里提到了不止一位室友，请写清楚要提醒谁。";

/**
 * **收件人绑定：只能绑住户原话里点名且唯一的那位同住人。**
 *
 * 没点名、点了不止一位（或点到自己）都不成立——返回可读原因、零写入。**这个判定
 * 完全不依赖模型**：功能模块把原话交给这里，模型没有机会改收件人。
 */
export function resolveNamedRecipient(
  text: string,
  members: readonly repo.Member[],
  senderPersonId: string
): SmsRecipientResult {
  const named = namedRoommates(text, members, senderPersonId);
  if (named.length === 0) {
    return {
      ok: false,
      reason: "住户这句话里没有点名任何一位同住人，我不知道要发给谁。",
    };
  }
  if (named.length > 1) {
    return { ok: false, reason: AMBIGUOUS_SMS_RECIPIENT_REPLY };
  }
  return { ok: true, recipient: named[0] };
}

/** 收件人在**当前**渠道是否可达的真话说明；可发返回 null。 */
export function smsRecipientIneligibleReply(
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

export type SmsDeliveryDeps = {
  recordDecision: typeof repo.recordDecision;
  queueCommunication: typeof repo.queueCommunication;
  getOrCreateConversation: typeof repo.getOrCreateConversation;
  appendMessage: typeof repo.appendMessage;
};

export const smsDeliveryDeps: SmsDeliveryDeps = {
  recordDecision: repo.recordDecision,
  queueCommunication: repo.queueCommunication,
  getOrCreateConversation: repo.getOrCreateConversation,
  appendMessage: repo.appendMessage,
};

export type SmsDelivery = {
  /** 收件人在当前渠道的地址，调用方据此投递 */
  to: string;
  /** 真的写进库、要发出去的正文（由功能模块的模型生成阶段产出） */
  text: string;
  communicationId: string;
  decisionId: string;
};

/**
 * **把一条已定稿的短信写进既有链路：decision → communication → appendMessage。**
 *
 * 正文由功能模块的模型生成阶段写好（生成阶段只看到收窄后的获准字段），这里只再跑
 * 一次可达性（姓名已确认、当前渠道有地址）与 `assertCanWrite` 硬闸，然后落库。本地
 * 进程不许写真人住的房子（见 guard.ts）。
 */
export async function deliverSms(
  args: {
    householdId: string;
    channel: string;
    senderIsTest: boolean;
    /** 落 decision / communication 时用的功能名，例如「夜间洗衣提醒」 */
    purposeLabel: string;
    recipient: SmsRecipient;
    text: string;
  },
  deps: SmsDeliveryDeps = smsDeliveryDeps
): Promise<SmsDelivery> {
  const ineligible = smsRecipientIneligibleReply(args.recipient);
  if (ineligible) {
    throw new Error(ineligible);
  }

  assertCanWrite({
    isTestHousehold: args.senderIsTest,
    what: `发送${args.purposeLabel}`,
  });

  const decisionId = await deps.recordDecision({
    householdId: args.householdId,
    kind: "contact_one",
    targetPersonIds: [args.recipient.personId],
    intent: args.purposeLabel,
    rationale:
      "已批准功能：功能入口内部判定命中后，用收窄的获准字段生成正文，" +
      "收件人由代码绑定原话点名的那一位；这里只做可达性与发送硬闸后的落库。",
    modelId: null,
  });
  const communicationId = await deps.queueCommunication({
    householdId: args.householdId,
    decisionId,
    caseId: null,
    toPersonId: args.recipient.personId,
    channel: args.channel,
    purpose: args.purposeLabel,
    body: args.text,
    act: "remind",
    expectsReply: true,
  });
  const theirConversation = await deps.getOrCreateConversation({
    personId: args.recipient.personId,
    householdId: args.householdId,
    channel: args.channel,
  });
  await deps.appendMessage({
    conversationId: theirConversation,
    personId: args.recipient.personId,
    direction: "outbound",
    channel: args.channel,
    body: args.text,
    communicationId,
  });

  return {
    to: args.recipient.address ?? "",
    text: args.text,
    communicationId,
    decisionId,
  };
}
