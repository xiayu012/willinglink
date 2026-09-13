import "server-only";

import { assertCanWrite } from "./guard";
import * as repo from "./repo";
import {
  hasRelayedReminderAskSignal,
  looksLikeRelayedReminderAsk,
} from "./reminder-ask";
import {
  createReminderProposal,
  parseReminderConfirmation,
  REMINDER_PROPOSAL_FAILED_REPLY,
  REMINDER_PROPOSAL_PURPOSE,
  REMINDER_PROPOSAL_RECIPIENT_GONE_REPLY,
  REMINDER_PROPOSAL_STALE_REPLY,
  reminderProposalDeps,
  reminderTargetIneligibleReply,
  takeReminderProposal,
  type ReminderProposalDeps,
} from "./reminder-proposal";

/**
 * **已开放的具体功能：个人物品使用提醒（唯一允许发给别的住户的受约束出站）。**
 *
 * 老板 2026-09-12 拍板「具体功能逐项开放」，并选了严格口径：立刻收回所有
 * 自由文本的第三方出站能力，只保留这一个**程序化受约束**的功能。这个文件
 * 就是那唯一的实现，也是唯一一条「不是模型写话、要把消息发给另一个住户」
 * 的路径。通用 `contactPerson` 工具与 outreach / kickoff / cron / enroll
 * 的自由文本出站都已撤掉（见 `outreach.ts` 与 `turn.ts`）。
 *
 * 三条不可放宽的性质：
 *
 * 1. **确定性识别，不过模型。** 只认一条很窄的固定命令
 *    （`提醒 阿川：使用我的个人物品前先问我` 的等价说法，允许标点和礼貌前缀
 *    的细微变体）。识别纯靠正则，**不接受任意自由文本**——命令体里有任何
 *    多余内容（夹带、理由、物品名、别的诉求）就一律不认，**零第三方出站**，
 *    由 `runColivingTurn` 回一句短的结构化指引。
 *    住户用自然语言表达同一件事时，**不直接发送**，只落一条发给**发起人
 *    本人**的待确认预览（`proposal`，零第三方出站），回「确认」才发。
 * 2. **收件人文案是写死的常量**，不是从用户文本里抽的。里面没有来源、没有
 *    用户原话、没有物品名、没有理由、没有额外要求，避免用户借物品名或备注
 *    夹带未开放的要求（见 CONCRETE_FUNCTIONS「自由文本不能直接拼入受限消息」）。
 * 3. **校验必须全过才发。** 同一栋房子、名册里唯一、非本人、姓名已确认、
 *    当前渠道有地址；任一不满足就不发，回一句短的说明，第三方出站为空。
 *
 * 写入沿用现有链路：decision → communication → appendMessage。不做任何 LLM
 * 生成（本模块不 import AI SDK）。所有写入都过 `assertCanWrite` 硬闸。
 */

/** 发给被提醒住户的**唯一**正文。写死，不拼接任何用户输入。 */
export const PERSONAL_ITEM_REMINDER_TEXT =
  "使用室友的个人物品前，请先征得对方同意。";

/**
 * 旧版固定命令句式。**只为兼容既有断言保留，不再出现在任何发给住户的
 * 消息里**（老板已驳回「只支持这一种说法」的模板指引）。
 */
export const PERSONAL_ITEM_REMINDER_FORM =
  "提醒 <室友名字>：使用我的个人物品前先问我";

/**
 * 预览轮报告的工具名。**与真正的发送（`personalItemReminder`）区分开**，
 * 这样「这一轮只出了预览、零第三方出站」可以被行为测试直接断言，而不必把
 * 零出站断言放宽到允许真正的发送工具。
 */
export const PERSONAL_ITEM_PREVIEW_TOOL = "personalItemReminderPreview";

/** 提案在库里的 purpose 标记（也用于取消时按前缀作废）。 */
export const PERSONAL_ITEM_PROPOSAL_PURPOSE =
  REMINDER_PROPOSAL_PURPOSE.personalItem;

/**
 * 近似请求的**可执行预览**（发给发起人本人，零第三方出站）：
 * 如实说明还没发、点名收件人、把**将要发出的那句固定正文原样摆出来**、
 * 给出「确认 / 取消」。**只摆那一句、不承诺带上住户说的原因或条件**
 * （带上就该写成另一条消息了——混合/附加诉求一律不落提案，见下）。
 * 住户回「确认」才真的发，回「取消」就不发。
 */
export function personalItemProposalPreview(recipientName: string): string {
  return `还没发送。给${recipientName}的短信是：「${PERSONAL_ITEM_REMINDER_TEXT}」回复「确认」发送，或「取消」。`;
}

/** 回给发起人的真话收据：只说做成了什么，不复述内部过程。 */
export function personalItemReminderReceipt(recipientName: string): string {
  return `好，已经提醒${recipientName}了：用你的个人物品前先问你。`;
}

export type PersonalItemReminderCommand = {
  /** 命令里点名的收件人。后续仍要拿它去名册里核对，不能直接采信。 */
  recipientName: string;
};

/** 命令前缀：允许常见礼貌说法与「私下」「一下」这类无意义填充。 */
const COMMAND_PREFIX =
  /^(?:麻烦你?|请你?|帮我|帮忙|劳驾|拜托你?|能帮我|可以帮我|能否帮我)?\s*(?:帮我\s*)?(?:私下\s*)?提醒\s*(?:一下\s*)?/;

/** 只看「像不像在说个人物品」的宽松线索；不负责判断形式是否合规。 */
const LOOSE_POLITE =
  /^(?:麻烦你?|请你?|帮我|帮忙|劳驾|拜托你?|能帮我|可以帮我|能否帮我)?\s*/;
const LOOSE_LEAD = /^(?:帮我\s*)?(?:私下\s*)?提醒/;
const LOOSE_PERSONAL_ITEM =
  /(?:我的|我)(?:的)?(?:个人)?(?:物品|东西|私人物品|私人物件)|个人物品|私人物品/;

/**
 * 命令体归一化后必须**整体**命中的固定语义：用我的个人物品前先征得我同意。
 * 末尾 `$` 是关键——任何夹带都会让整条意图匹配失败。
 */
const COMMAND_BODY =
  /^(?:要|得|记得)?(?:使用|用|借用?|借|拿|动)(?:我的|我)(?:的)?(?:个人物品|私人物品|物品|东西)(?:之前|以前|前)?(?:(?:先|要|得|请))*?(?:问(?:一下|一声)?我|问我(?:一下|一声)?|跟我(?:说|讲)?(?:一声|一下)?|通知我(?:一声|一下)?|征求我(?:的)?同意|征得我(?:的)?同意|取得我(?:的)?同意)$/;

/** 归一化：去掉空白与句读，再剥掉体首的礼貌/时间前缀。 */
function normalizeBody(raw: string): string {
  return raw
    .replace(/\s+/g, "")
    .replace(/[。.!！~～、,，;；:：]/g, "")
    .replace(/^(?:麻烦|请|以后|下次|之后|将来|记得|千万|一定|拜托)+/, "");
}

/**
 * 这条消息是不是在请求「个人物品使用提醒」这一族功能（含形式不合规的
 * 尝试）。命中但它不合规时，调用方给一句短的下一步说明、**不发送**；
 * 不命中（例如深夜洗衣、清理地漏头发）就直接走普通对话，第三方出站为零。
 */
export function looksLikePersonalItemReminder(text: string): boolean {
  const t = text.trim().replace(LOOSE_POLITE, "");
  return LOOSE_LEAD.test(t) && LOOSE_PERSONAL_ITEM.test(t);
}

/**
 * 明确属于**其它未开放能力 / 混合议题**的信号。命中即不吞：深夜洗衣（另有
 * 模块）、卫生/头发、费用分摊、规则制定、去留协调、一般噪音等。
 */
const PERSONAL_ITEM_APPROX_FOREIGN =
  /(?:头发|地漏|卫生|水费|电费|分摊|摊钱|公用|公摊|规矩|规则|全屋|大家都|换住|搬走|退租|押金|深夜|半夜|大半夜|夜里|夜间|晚上|入夜|凌晨|洗衣机|烘干机|洗烘|洗衣服|烘衣服|洗衣|烘干|噪音|音乐|电视|外放|音量|清洁|打扫|垃圾|厨房|做饭|访客|过夜)/;

/** 「用/借/拿我的个人物品」的动作词。 */
const PERSONAL_ITEM_USE =
  /(?:使用|用|借用?|借|拿|动|碰|翻|穿)/;
/** 「先问我/打招呼/征得同意」的征询线索。 */
const PERSONAL_ITEM_ASK =
  /(?:问|打招呼|同意|先说|说一声|讲一声|告知|经过我|通过我|征得)/;

/** 这一项功能的独有主题：用我的个人物品前先问我。 */
function isPersonalItemTopic(t: string): boolean {
  return (
    LOOSE_PERSONAL_ITEM.test(t) &&
    PERSONAL_ITEM_USE.test(t) &&
    PERSONAL_ITEM_ASK.test(t)
  );
}

/**
 * 近似请求的**便宜预筛**（不查名册）：主题 + 请求语气 + 非讨论/非混合。
 * 先跑它，只有疑似才去读成员表。
 */
export function hasPersonalItemAskSignal(text: string): boolean {
  return hasRelayedReminderAskSignal(text, {
    topicCue: isPersonalItemTopic,
    foreignCue: PERSONAL_ITEM_APPROX_FOREIGN,
  });
}

/**
 * 完整判定：见 `looksLikeRelayedReminderAsk`。`memberNames` 传的是**除当前
 * 说话人以外**的名册姓名（判定「指定室友」用）。
 */
export function looksLikeApproximatePersonalItemAsk(
  text: string,
  memberNames: readonly string[]
): boolean {
  return looksLikeRelayedReminderAsk(text, memberNames, {
    topicCue: isPersonalItemTopic,
    foreignCue: PERSONAL_ITEM_APPROX_FOREIGN,
  });
}

/**
 * 确定性识别这条命令。**认不出就返回 null**，调用方应当回一句结构化指引
 * （若 `looksLikePersonalItemReminder` 为真）或落回普通对话，不要猜。
 */
export function recognizePersonalItemReminder(
  text: string
): PersonalItemReminderCommand | null {
  const match = text
    .trim()
    .match(
      new RegExp(
        `${COMMAND_PREFIX.source}([^\\s：:，,，]{1,16})\\s*[：:，,]\\s*(.+)$`,
        "s"
      )
    );
  if (!match) {
    return null;
  }
  const recipientName = match[1].trim();
  const body = normalizeBody(match[2]);
  if (!recipientName || !COMMAND_BODY.test(body)) {
    return null;
  }
  return { recipientName };
}

/**
 * 没法安全受理时给发起人的短说明：**说人话、说真话**——没发出去 + 我能帮上
 * 的是哪一类事。**到此为止。**
 *
 * **不写「用平常的话再说一遍」这类反复重述的指令，也不承诺「只说个名字
 * 就行」。** 走到这一句时多半已经点了名（只是夹带了头发/水费、或被否定式
 * 交办），再问「谁」是睁眼说瞎话；而「只说个名字」也走不通——近似入口要求
 * 整句里既有请求语气又有这一项的主题。不再摆占位模板
 * （`PERSONAL_ITEM_REMINDER_FORM` 保留只为兼容既有断言，不再出现在任何
 * 发给住户的消息里）。
 */
function unsupportedFormReply(): string {
  return "这条我没有发出去。我能帮住户做的是「个人物品使用提醒」这一类：用你的个人物品前先问你。";
}

export type PersonalItemReminderOutcome =
  | {
      /** 这条消息根本不是个人物品提醒，普通对话照常处理。 */
      kind: "none";
    }
  | {
      /** 像个人物品提醒但形式/校验不通过：回一句短指引，**零第三方出站**。 */
      kind: "guidance";
      reply: string;
    }
  | {
      /**
       * 近似请求：已落一条**发给发起人本人**的待确认预览，**零第三方出站**。
       * 住户回「确认」后由 `confirmPersonalItemReminder` 才真的发。
       */
      kind: "proposal";
      reply: string;
      recipientName: string;
      recipientPersonId: string;
      /** 预览 communication（发给发起人，不是第三方） */
      communicationId: string;
      decisionId: string;
    }
  | {
      /** 校验全过，已写入固定第三方出站。 */
      kind: "sent";
      recipientName: string;
      recipientPersonId: string;
      /** 当前渠道里的地址，调用方据此投递 */
      to: string;
      /** 固定正文常量，调用方据此投递 */
      text: string;
      /** 第三方 communication（不是回执） */
      communicationId: string;
      decisionId: string;
      /** 给当前说话人的真话回执正文 */
      receiptText: string;
    };

/** 只有 narrow 命令路径与确认路径共用的「发送给某位已核对成员」。 */
async function executePersonalItemReminder(
  deps: ReminderProposalDeps,
  args: { householdId: string; senderIsTest: boolean; channel: string },
  target: repo.Member
): Promise<Extract<PersonalItemReminderOutcome, { kind: "sent" }>> {
  // 跟其它写入入口同一条硬闸：本地进程不许写真人住的房子（见 guard.ts）。
  assertCanWrite({
    isTestHousehold: args.senderIsTest,
    what: "发送个人物品使用提醒",
  });

  const decisionId = await deps.recordDecision({
    householdId: args.householdId,
    kind: "contact_one",
    targetPersonIds: [target.personId],
    intent: "个人物品使用提醒",
    rationale:
      "已开放功能：按固定文案发送个人物品使用提醒；正文不含来源、用户原话或物品名。",
    modelId: null,
  });
  const communicationId = await deps.queueCommunication({
    householdId: args.householdId,
    decisionId,
    caseId: null,
    toPersonId: target.personId,
    channel: args.channel,
    purpose: "个人物品使用提醒",
    body: PERSONAL_ITEM_REMINDER_TEXT,
    act: "remind",
    expectsReply: true,
  });
  const theirConversation = await deps.getOrCreateConversation({
    personId: target.personId,
    householdId: args.householdId,
    channel: args.channel,
  });
  await deps.appendMessage({
    conversationId: theirConversation,
    personId: target.personId,
    direction: "outbound",
    channel: args.channel,
    body: PERSONAL_ITEM_REMINDER_TEXT,
    communicationId,
  });

  return {
    kind: "sent",
    recipientName: target.name,
    recipientPersonId: target.personId,
    to: target.address ?? "",
    text: PERSONAL_ITEM_REMINDER_TEXT,
    communicationId,
    decisionId,
    receiptText: personalItemReminderReceipt(target.name),
  };
}

/**
 * 近似自然语言请求入口（不过模型、**零第三方出站**）：判定自带主题 / 请求
 * 语气 / 非讨论 / 非否定 / 非混合的闸，命中就落一条发给**发起人本人**的
 * 待确认预览。返回 `null` 表示「不是可受理的近似请求」，由调用方决定回一句
 * 真话指引还是走普通对话。
 *
 * **刻意不拿「像不像这一族」当前置条件。** 出过事（2026-09-12 Codex 实测）：
 * 住户说「帮我提醒阿川用我的个人物品前先问我」——点了名、意思也对，只是没按
 * 固定格式写——旧写法先要求 `looksLikePersonalItemReminder` 再进近似分支，
 * 结果它被挡在门外，回一句「你说清楚要提醒谁」，明明已经点名了。现在只要
 * 近似判定通过就收口成预览，**不**再看窄命令的宽松线索。
 */
async function tryPersonalItemProposal(
  args: {
    householdId: string;
    senderPersonId: string;
    /** 透传自 deliver 入参的**真实**测试屋标记，落提案前过 assertCanWrite。 */
    senderIsTest: boolean;
    channel: string;
    conversationId: string;
    text: string;
  },
  deps: ReminderProposalDeps
): Promise<PersonalItemReminderOutcome | null> {
  // 先做不查名册的预筛，只有疑似才读成员表，避免每条无关消息都查一次。
  if (!hasPersonalItemAskSignal(args.text)) {
    return null;
  }
  const others = (await deps.getMembers(args.householdId, args.channel)).filter(
    (m) => m.personId !== args.senderPersonId
  );
  if (
    !looksLikeApproximatePersonalItemAsk(
      args.text,
      others.map((m) => m.name)
    )
  ) {
    return null;
  }
  // 收件人必须由**稳定 ID 唯一确定**：消息里点了不止一个人名就是歧义，
  // 给真话澄清、不落任何待确认状态（否则会变成对某个人的误发）。
  const matched = others.filter(
    (m) => m.name.trim().length >= 2 && args.text.includes(m.name)
  );
  if (matched.length > 1) {
    return {
      kind: "guidance",
      reply: "这条消息里提到了不止一位室友，请写清楚要提醒谁。",
    };
  }
  const target = matched[0];
  if (!target) {
    return null;
  }
  const ineligible = reminderTargetIneligibleReply(target);
  if (ineligible) {
    return { kind: "guidance", reply: ineligible };
  }
  const preview = personalItemProposalPreview(target.name);
  const proposal = await createReminderProposal(deps, {
    householdId: args.householdId,
    senderIsTest: args.senderIsTest,
    requesterPersonId: args.senderPersonId,
    conversationId: args.conversationId,
    channel: args.channel,
    recipientPersonId: target.personId,
    purpose: PERSONAL_ITEM_PROPOSAL_PURPOSE,
    label: "个人物品使用提醒",
    previewText: preview,
    inboundText: args.text,
  });
  return {
    kind: "proposal",
    reply: preview,
    recipientName: target.name,
    recipientPersonId: target.personId,
    communicationId: proposal.communicationId,
    decisionId: proposal.decisionId,
  };
}

/**
 * 识别 + 校验 + 发送一条个人物品使用提醒。
 *
 * **不调用任何模型**，也不接受自由正文。判定顺序：
 *   ① 先试**原有窄命令**（`recognizePersonalItemReminder`）：命中就走老路径
 *      （名册校验 → 固定正文发送），行为与开放时一致；
 *   ② 不是窄命令，再试**近似自然语言请求**：只落一条发给发起人本人的待确认
 *      预览（`proposal`，零第三方出站），等住户回「确认」才由
 *      `confirmPersonalItemReminder` 发；
 *   ③ 仍像这一族但没法安全受理（夹带 / 没点名 / 被否定）：回一句真话短说明，
 *      零第三方出站；不像就走普通对话。
 */
export async function deliverPersonalItemReminder(
  args: {
    householdId: string;
    senderPersonId: string;
    senderIsTest: boolean;
    channel: string;
    /** 发起人自己的会话线，用于落「住户请求 → AI 预览」两条消息。 */
    conversationId: string;
    text: string;
  },
  deps: ReminderProposalDeps = reminderProposalDeps
): Promise<PersonalItemReminderOutcome> {
  // ① 原有窄命令：命中即走老路径。
  const command = recognizePersonalItemReminder(args.text);
  if (command) {
    const members = await deps.getMembers(args.householdId, args.channel);
    const matches = members.filter((m) => m.name === command.recipientName);
    if (matches.length === 0) {
      return {
        kind: "guidance",
        reply: `房子里没有找到叫「${command.recipientName}」的人。我没发任何消息。`,
      };
    }
    if (matches.length > 1) {
      return {
        kind: "guidance",
        reply: `「${command.recipientName}」对应不止一个人，请写清楚要提醒谁。`,
      };
    }
    const target = matches[0];
    if (target.personId === args.senderPersonId) {
      return { kind: "guidance", reply: "这是你自己，不用提醒。" };
    }
    const ineligible = reminderTargetIneligibleReply(target);
    if (ineligible) {
      return { kind: "guidance", reply: ineligible };
    }
    return await executePersonalItemReminder(deps, args, target);
  }

  // ② 近似自然语言请求：只落本地待确认预览，不直接发送。
  const proposal = await tryPersonalItemProposal(args, deps);
  if (proposal) {
    return proposal;
  }

  // ③ 像这一族但受理不了：真话说明，零第三方出站。
  if (looksLikePersonalItemReminder(args.text)) {
    return { kind: "guidance", reply: unsupportedFormReply() };
  }
  return { kind: "none" };
}

/**
 * 住户回「确认」后，认领上一轮的待确认提案并**只发那条固定正文**。
 *
 * 拿不到提案（没有 / 过期 / 已取消 / 属另一项功能 / 已被别的确认抢走）就返回
 * `none`，**绝不发送**——「确认」两个字本身不是发送授权，持久化的提案才是。
 * 收件人按提案里绑定的**稳定 ID** 回到**当前**同屋名册里重新核对，正文也必须
 * 与当前固定文案逐字一致；任一不符就不发（提案作废）。
 */
export async function confirmPersonalItemReminder(
  args: {
    householdId: string;
    senderPersonId: string;
    senderIsTest: boolean;
    channel: string;
    /** 发起人当前会话线；候选提案必须绑定在它上面。 */
    conversationId: string;
    text: string;
  },
  deps: ReminderProposalDeps = reminderProposalDeps
): Promise<Exclude<PersonalItemReminderOutcome, { kind: "proposal" }>> {
  if (parseReminderConfirmation(args.text) !== "confirm") {
    return { kind: "none" };
  }
  const taken = await takeReminderProposal(deps, {
    householdId: args.householdId,
    requesterPersonId: args.senderPersonId,
    channel: args.channel,
    conversationId: args.conversationId,
    purpose: PERSONAL_ITEM_PROPOSAL_PURPOSE,
  });
  if (taken.kind === "none") {
    return { kind: "none" };
  }

  // 收件人必须重新回到**当前**同屋名册里核对（不新建会话、不发送）。
  const members = await deps.getMembers(args.householdId, args.channel);
  const target = members.find((m) => m.personId === taken.recipientPersonId);
  if (!target || target.personId === args.senderPersonId) {
    return { kind: "guidance", reply: REMINDER_PROPOSAL_RECIPIENT_GONE_REPLY };
  }
  const ineligible = reminderTargetIneligibleReply(target);
  if (ineligible) {
    return { kind: "guidance", reply: ineligible };
  }
  // 预览正文必须与**当前**固定文案逐字一致（防代码/姓名变动后照旧文案发）。
  if (taken.body !== personalItemProposalPreview(target.name)) {
    return { kind: "guidance", reply: REMINDER_PROPOSAL_STALE_REPLY };
  }

  try {
    return await executePersonalItemReminder(deps, args, target);
  } catch {
    // 认领后写入失败：**不退回认领**（退回会造成重复入队/重复外呼）。失败可能
    // 落在 `queueCommunication` **之后**（写会话/消息那一步抛错）——那时外呼其实
    // 已经入队、即将发出，所以不能断言「没发出去」，只报发送状态无法确认、且不会
    // 自动重发，避免住户重说一遍造成重复。
    return { kind: "guidance", reply: REMINDER_PROPOSAL_FAILED_REPLY };
  }
}
