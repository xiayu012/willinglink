import "server-only";

import { assertCanWrite } from "./guard";
import type { ResidentLanguage } from "./language";
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
 * - `deliverFinalNoticeSms` / `deliverFinalNoticeReply`：**共同规则定案通知**的两个
 *   出口（单独发给某位住户 / 并进本轮回复）。同一套表、同一道硬闸，只是落库换成
 *   `repo.claimFinalNoticeDelivery` 的**原子领取**：decision ＋ communication ＋ 那条
 *   出站消息在同一个事务里写完，一来保证同一条 (规则, 人) 只有一条通知，二来不留
 *   「领到了、消息没写进去」那种永远不投递、也不重试的 `queued`。所以这两个出口
 *   **自己不取会话、不写消息**——这件事在领取里做完了。
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
 * 上面那句的英文说法。**这一层是"收件人绑不上"的澄清句，会被当成本轮回复发给住户**
 * （见各功能模块的 `reply`），所以它和正文一样要按本轮语言说——`language` 由轮次判定
 * 一路传下来（缺省中文，既有调用逐字不变）。中文那句是既有口径，一字不动。
 */
export const AMBIGUOUS_SMS_RECIPIENT_REPLY_EN =
  "That message mentions more than one roommate — tell me clearly who you mean.";

/** 原话没有点名任何同住人时的澄清句（同样是住户可见的回复）。 */
export const NO_NAMED_RECIPIENT_REPLY =
  "住户这句话里没有点名任何一位同住人，我不知道要发给谁。";

/** 上面那句的英文说法。 */
export const NO_NAMED_RECIPIENT_REPLY_EN =
  "Nobody in this message is named as the person to reach, so I don't know who " +
  "to send it to.";

/**
 * **收件人绑定：只能绑住户原话里点名且唯一的那位同住人。**
 *
 * 没点名、点了不止一位（或点到自己）都不成立——返回可读原因、零写入。**这个判定
 * 完全不依赖模型**：功能模块把原话交给这里，模型没有机会改收件人。
 *
 * `language` 是本轮住户语言判定（`turn.ts` 在轮次边界判一次，各功能模块照传，
 * **不在这里重算**）：这两句 `reason` 是设计成住户可见的澄清句，功能模块会把它们
 * 当本轮回复发出去，所以按同一份判定取中文原句或登记英文句。缺省中文。
 */
export function resolveNamedRecipient(
  text: string,
  members: readonly repo.Member[],
  senderPersonId: string,
  language: ResidentLanguage = "zh"
): SmsRecipientResult {
  const named = namedRoommates(text, members, senderPersonId);
  if (named.length === 0) {
    return {
      ok: false,
      reason:
        language === "en" ? NO_NAMED_RECIPIENT_REPLY_EN : NO_NAMED_RECIPIENT_REPLY,
    };
  }
  if (named.length > 1) {
    return {
      ok: false,
      reason:
        language === "en"
          ? AMBIGUOUS_SMS_RECIPIENT_REPLY_EN
          : AMBIGUOUS_SMS_RECIPIENT_REPLY,
    };
  }
  return { ok: true, recipient: named[0] };
}

/**
 * **姓名还没本人确认**这条闸——已批准功能（「提醒某位室友」）的默认口径。
 *
 * 姓名是**住户名册里的名字**（不是文案），中英两句都原样嵌在句中——英文句里出现一个
 * 中文人名是正常的，要防的是整句没被翻译。`language` 口径同 `resolveNamedRecipient`：
 * 由轮次判定传下来，不在这里重算。
 *
 * **这条闸不能当成通用的可达性判据**：名册导入的在住成员
 * `nameConfirmed = false`（见 `membership-facts.ts`），拿它去拦「共同规则定案通知」
 * 会把真实的在住成员整个挡在通知之外。所以拆成两个函数，由调用方选口径。
 */
export function smsRecipientUnconfirmedNameReply(
  target: Pick<repo.Member, "name" | "nameConfirmed">,
  language: ResidentLanguage = "zh"
): string | null {
  if (!target.nameConfirmed) {
    return language === "en"
      ? `${target.name}'s name hasn't been confirmed yet, so I can't send them a reminder for now.`
      : `${target.name} 的姓名还没确认，我暂时没法把提醒发给他。`;
  }
  return null;
}

/** **当前渠道没有登记地址**——这才是真正的「联系不上」，对任何口径都成立。 */
export function smsRecipientNoAddressReply(
  target: Pick<repo.Member, "name" | "address">,
  language: ResidentLanguage = "zh"
): string | null {
  if (!target.address) {
    return language === "en"
      ? `${target.name} has no address registered on this channel yet, so I can't reach them right now.`
      : `${target.name} 在当前渠道还没有登记地址，我暂时联系不上。`;
  }
  return null;
}

/**
 * 收件人在**当前**渠道是否可达的真话说明；可发返回 null。
 *
 * 两句合起来就是「已批准功能的默认口径」（先看姓名确认、再看地址），逐字不变。
 */
export function smsRecipientIneligibleReply(
  target: Pick<repo.Member, "name" | "nameConfirmed" | "address">,
  language: ResidentLanguage = "zh"
): string | null {
  return (
    smsRecipientUnconfirmedNameReply(target, language) ??
    smsRecipientNoAddressReply(target, language)
  );
}

export type SmsDeliveryDeps = {
  recordDecision: typeof repo.recordDecision;
  queueCommunication: typeof repo.queueCommunication;
  getOrCreateConversation: typeof repo.getOrCreateConversation;
  appendMessage: typeof repo.appendMessage;
  /**
   * 定案通知的原子领取（`repo.claimFinalNoticeDelivery`）。**只有定案通知用它**，
   * 所以是可选的：已批准功能的假投递器（`coliving-quality-inspect.ts`）不必实现。
   */
  claimFinalNoticeDelivery?: typeof repo.claimFinalNoticeDelivery;
};

export const smsDeliveryDeps: SmsDeliveryDeps = {
  recordDecision: repo.recordDecision,
  queueCommunication: repo.queueCommunication,
  getOrCreateConversation: repo.getOrCreateConversation,
  appendMessage: repo.appendMessage,
  claimFinalNoticeDelivery: repo.claimFinalNoticeDelivery,
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
 *
 * **共同规则定案通知不走这里**，走下面那两个 `deliverFinalNotice*`：那条通知的
 * 「查在途回执 ＋ 落库」必须是**一个原子领取**，`deliverSms` 这三步分开写做不到
 * （两个并发轮次会各自查到"还没通知过"）。落库仍是同一套表、同一道硬闸、同一份
 * 可达性判据。
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
  // 可达性在功能模块里**已经查过一次**（查出来就把那句真话当本轮回复发出去、不投递）；
  // 走到这里说明情况在本轮内变了，是**内部异常**、不是住户可见的回复——所以按内部
  // 错误口径固定用中文，不跟住户语言走（内部错误不进正文，见 CLAUDE.md 的分工）。
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

/** 定案通知落 decision / communication 用的功能名（台账、日志、评测都看这一条）。 */
export const FINAL_NOTICE_PURPOSE_LABEL = "共同规则定案通知";

/** 落库时这条通知是什么形状：单独发一条给某位住户，还是并进本轮回复。 */
type FinalNoticeWrite = {
  householdId: string;
  senderIsTest: boolean;
  channel: string;
  ruleId: string;
  personId: string;
  text: string;
  /**
   * 台账标签（进 `communication.purpose`）。**字段名就叫 `purposeLabel`**：这个名字
   * 在静态审计闸里是登记过的**内部记录字段**，不会被当成"没翻的住户可见回复"
   * ——它确实不是发给住户的字。
   */
  purposeLabel: string;
  caseId: string | null;
  act: repo.CommunicationAct | null;
  decisionKind: string;
  decisionIntent: string;
  decisionRationale: string;
  targetPersonIds: string[] | null;
  /** 并进回复时已知的那条会话；单独发通知时为 null（按人取）。 */
  conversationId: string | null;
};

/**
 * 领取 `(规则, 人)` 的落库位置。**领到就等于这条通知已经完整落库**——decision、
 * communication、以及那条出站消息都在 `claimFinalNoticeDelivery` 的**同一个事务**
 * 里写完了（见那里的说明：分开写会留下一条永远不投递、也不重试的 `queued`）。
 * 这里**不再自己取会话 / 写消息**。
 *
 * **没领到返回 null**——那条通知已经在路上，调用方什么都不用做。
 */
async function claimAndAppend(
  args: FinalNoticeWrite,
  deps: SmsDeliveryDeps
): Promise<SmsDelivery | null> {
  const claim = await (
    deps.claimFinalNoticeDelivery ?? repo.claimFinalNoticeDelivery
  )({
    householdId: args.householdId,
    senderIsTest: args.senderIsTest,
    ruleId: args.ruleId,
    personId: args.personId,
    channel: args.channel,
    body: args.text,
    purpose: args.purposeLabel,
    caseId: args.caseId,
    act: args.act,
    expectsReply: false,
    decisionKind: args.decisionKind,
    decisionIntent: args.decisionIntent,
    decisionRationale: args.decisionRationale,
    targetPersonIds: args.targetPersonIds,
    conversationId: args.conversationId,
  });
  if (!claim.claimed || !claim.decisionId || !claim.communicationId) {
    return null;
  }
  return {
    to: "",
    text: args.text,
    communicationId: claim.communicationId,
    decisionId: claim.decisionId,
  };
}

/**
 * **单独发一条定案通知给某位住户**（第三方出站）。
 *
 * 同一套链路与硬闸，只是落库走原子领取：**同一条 (规则, 人) 只会有一条通知**，
 * 并发轮次里领不到的那一轮返回 null，不会重复发。
 *
 * 可达性**只查地址、不查姓名是否本人确认**：名册导入的真名 `nameConfirmed` 是 false
 * （见 `membership-facts.ts`），用那条闸会把真实在住的成员整个挡在通知之外。
 */
export async function deliverFinalNoticeSms(
  args: {
    householdId: string;
    channel: string;
    senderIsTest: boolean;
    ruleId: string;
    recipient: SmsRecipient;
    text: string;
  },
  deps: SmsDeliveryDeps = smsDeliveryDeps
): Promise<SmsDelivery | null> {
  const ineligible = smsRecipientNoAddressReply(args.recipient);
  if (ineligible) {
    throw new Error(ineligible);
  }
  const sent = await claimAndAppend(
    {
      householdId: args.householdId,
      senderIsTest: args.senderIsTest,
      channel: args.channel,
      ruleId: args.ruleId,
      personId: args.recipient.personId,
      text: args.text,
      purposeLabel: FINAL_NOTICE_PURPOSE_LABEL,
      caseId: null,
      // 定案通知是通知，不是问句：不盯回音，别塞进「你在等谁回话」那张清单。
      act: "inform",
      decisionKind: "contact_one",
      decisionIntent: FINAL_NOTICE_PURPOSE_LABEL,
      decisionRationale:
        "共同规则全员同意后由代码派发的定案通知：收件人按这条规则自己的通知台账算出，" +
        "正文由措辞层按规则原文写；这里只做可达性与发送硬闸后的落库。",
      targetPersonIds: [args.recipient.personId],
      conversationId: null,
    },
    deps
  );
  return sent ? { ...sent, to: args.recipient.address ?? "" } : null;
}

/**
 * **把定案通知并进本轮回复**（收件人＝当前说话人本人）。
 *
 * 不另发一条自我短信：回执就登记在**这条回复自己的 decision 上**（专用一条，不挂在
 * 整轮共用的那条 decision 上——那条底下还挂着这一轮发给别人的消息，容易被当成
 * 「这个人已经收到通知了」）。领不到（这条 (规则, 人) 已经有通知在途）返回 null，
 * 调用方按**原样的回复**发出去，一个字都不改。
 *
 * 这里**不查可达性**：这是回给刚发消息过来的人，他显然收得到；再去查一次地址反而会
 * 把一条本该发出去的回复弄丢。
 */
export async function deliverFinalNoticeReply(
  args: {
    householdId: string;
    channel: string;
    senderIsTest: boolean;
    ruleId: string;
    personId: string;
    text: string;
    caseId: string | null;
    conversationId: string;
  },
  deps: SmsDeliveryDeps = smsDeliveryDeps
): Promise<SmsDelivery | null> {
  return await claimAndAppend(
    {
      householdId: args.householdId,
      senderIsTest: args.senderIsTest,
      channel: args.channel,
      ruleId: args.ruleId,
      personId: args.personId,
      text: args.text,
      purposeLabel: "回复本人",
      caseId: args.caseId,
      act: null,
      decisionKind: "reply_only",
      decisionIntent: "共同规则定案通知（并入本轮回复）",
      decisionRationale:
        "共同规则定案通知并入本轮回复：收件人就是当前说话人，回执是这条回复自己的 communication。",
      targetPersonIds: null,
      conversationId: args.conversationId,
    },
    deps
  );
}
