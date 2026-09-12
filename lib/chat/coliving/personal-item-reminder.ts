import "server-only";

import { assertCanWrite } from "./guard";
import * as repo from "./repo";

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
 * 这条功能支持的**唯一**句式，写在给住户的指引里，让他知道该怎么发。
 * 用占位符而不是某个真实姓名，避免把模板读成"必须提醒这个人"。
 */
export const PERSONAL_ITEM_REMINDER_FORM =
  "提醒 <室友名字>：使用我的个人物品前先问我";

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

/** 给发起人的短的结构化指引（形式不对 / 校验不过时统一用它收口）。 */
function formGuidance(prefix: string): string {
  return `${prefix}个人物品提醒只支持这一种说法：「${PERSONAL_ITEM_REMINDER_FORM}」。`;
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

/**
 * 识别 + 校验 + 发送一条个人物品使用提醒。
 *
 * **不调用任何模型**，也不接受自由正文：命令不合规或校验不过就返回
 * `guidance`，绝不外发。命中的成功路径由本函数落库（decision →
 * communication → appendMessage），调用方只需再补一条给当前人的回执。
 */
export async function deliverPersonalItemReminder(args: {
  householdId: string;
  senderPersonId: string;
  senderIsTest: boolean;
  channel: string;
  text: string;
}): Promise<PersonalItemReminderOutcome> {
  if (!looksLikePersonalItemReminder(args.text)) {
    return { kind: "none" };
  }

  const command = recognizePersonalItemReminder(args.text);
  if (!command) {
    return {
      kind: "guidance",
      reply: formGuidance("这条我还没法照发。"),
    };
  }

  const members = await repo.getMembers(args.householdId, args.channel);
  const matches = members.filter((m) => m.name === command.recipientName);
  if (matches.length === 0) {
    return {
      kind: "guidance",
      reply: formGuidance(
        `房子里没有找到叫「${command.recipientName}」的人。`
      ),
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
  if (!target.nameConfirmed) {
    return {
      kind: "guidance",
      reply: `${target.name} 的姓名还没确认，我暂时没法把提醒发给他。`,
    };
  }
  if (!target.address) {
    return {
      kind: "guidance",
      reply: `${target.name} 在当前渠道还没有登记地址，我暂时联系不上。`,
    };
  }

  // 跟其它写入入口同一条硬闸：本地进程不许写真人住的房子（见 guard.ts）。
  assertCanWrite({
    isTestHousehold: args.senderIsTest,
    what: "发送个人物品使用提醒",
  });

  const decisionId = await repo.recordDecision({
    householdId: args.householdId,
    kind: "contact_one",
    targetPersonIds: [target.personId],
    intent: "个人物品使用提醒",
    rationale:
      "已开放功能：按固定文案发送个人物品使用提醒；正文不含来源、用户原话或物品名。",
    modelId: null,
  });
  const communicationId = await repo.queueCommunication({
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
  const theirConversation = await repo.getOrCreateConversation({
    personId: target.personId,
    householdId: args.householdId,
    channel: args.channel,
  });
  await repo.appendMessage({
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
    to: target.address,
    text: PERSONAL_ITEM_REMINDER_TEXT,
    communicationId,
    decisionId,
    receiptText: personalItemReminderReceipt(target.name),
  };
}
