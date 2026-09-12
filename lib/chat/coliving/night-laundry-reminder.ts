import "server-only";

import { assertCanWrite } from "./guard";
import * as repo from "./repo";

/**
 * **已开放的具体功能：夜间洗衣提醒（第二项受约束第三方出站）。**
 *
 * 老板 2026-09-12「具体功能逐项开放」拍板后，这是继个人物品使用提醒
 * （`personal-item-reminder.ts`）之后按同一套严格口径开放的第二项，也是
 * 同一受限功能体系里的**同级模块**，不是新的通用出口。它可处理的共同影响
 * 只有一件：深夜运行洗衣机 / 烘干机影响别人休息。**不从这里外推到**
 * 一般噪音、一般清洁、规则制定、费用分摊或去留协调。
 *
 * 跟个人物品提醒完全同构的三条不可放宽的性质：
 *
 * 1. **确定性识别，不过模型。** 只认一条很窄的固定命令
 *    （`提醒 阿川：深夜别开洗衣机或烘干机` 的等价说法，允许标点和礼貌前缀
 *    的细微变体）。识别纯靠正则，**不接受任意自由文本**——命令体里有任何
 *    多余内容（清理头发、分摊费用、全屋规矩、人身攻击等）就一律不认，
 *    **零第三方出站**，由 `runColivingTurn` 回一句短的结构化指引。
 * 2. **收件人文案是写死的常量**，不是从用户文本里抽的。里面没有来源、没有
 *    用户原话、没有具体钟点、没有自由理由、没有附带命令。
 * 3. **校验必须全过才发。** 同一栋房子、名册里唯一、非本人、姓名已确认、
 *    当前渠道有地址；任一不满足就不发，回一句短的说明，第三方出站为空。
 *
 * 写入沿用现有链路：decision → communication → appendMessage。不做任何 LLM
 * 生成（本模块不 import AI SDK）。所有写入都过 `assertCanWrite` 硬闸。
 */

/** 发给被提醒住户的**唯一**正文。写死，不拼接任何用户输入，也不含具体钟点。 */
export const NIGHT_LAUNDRY_REMINDER_TEXT =
  "深夜使用洗衣机或烘干机容易影响他人休息，请尽量避开深夜时段。";

/**
 * 这条功能支持的**唯一**句式，写在给住户的指引里，让他知道该怎么发。
 * 用占位符而不是某个真实姓名，避免把模板读成"必须提醒这个人"。
 */
export const NIGHT_LAUNDRY_REMINDER_FORM =
  "提醒 <室友名字>：深夜别开洗衣机或烘干机";

/** 回给发起人的真话收据：只说做成了什么，不复述内部过程。 */
export function nightLaundryReminderReceipt(recipientName: string): string {
  return `好，已经提醒${recipientName}了：深夜尽量别用洗衣机或烘干机。`;
}

export type NightLaundryReminderCommand = {
  /** 命令里点名的收件人。后续仍要拿它去名册里核对，不能直接采信。 */
  recipientName: string;
};

/** 命令前缀：允许常见礼貌说法与「私下」「一下」这类无意义填充。 */
const COMMAND_PREFIX =
  /^(?:麻烦你?|请你?|帮我|帮忙|劳驾|拜托你?|能帮我|可以帮我|能否帮我)?\s*(?:帮我\s*)?(?:私下\s*)?提醒\s*(?:一下\s*)?/;

/** 只看「像不像在说深夜洗衣」的宽松线索；不负责判断形式是否合规。 */
const LOOSE_POLITE =
  /^(?:麻烦你?|请你?|帮我|帮忙|劳驾|拜托你?|能帮我|可以帮我|能否帮我)?\s*/;
const LOOSE_LEAD = /^(?:帮我\s*)?(?:私下\s*)?提醒/;
const LOOSE_NIGHT = /(?:深夜|半夜|大半夜|夜里|夜间|晚上|入夜|凌晨)/;
const LOOSE_LAUNDRY =
  /(?:洗衣机|烘干机|洗烘机|洗衣烘干机|洗烘|洗衣服|烘衣服|洗衣|烘干)/;

/**
 * 命令体归一化后必须**整体**命中的固定语义：深夜别运行洗衣机 / 烘干机。
 * 允许两种语序（时间在前 / 否定在前）。末尾 `$` 是关键——任何夹带都会让
 * 整条意图匹配失败，因此命令体里不能有理由、钟点、别的诉求或人身评价。
 */

/** 深夜时段词。刻意不收「十一点后」这类具体钟点，保持命令形态窄。 */
const NL_TIME = "(?:深夜|半夜|大半夜|夜里|夜间|晚上|入夜|凌晨)";
/** 否定词，前可挂「尽量 / 千万 / 记得」这类软化词。 */
const NL_PRE = "(?:记得|以后|下次|要|得|尽量|尽可能|最好|千万|一定|请)*";
const NL_NEG = "(?:别|不要|不用|不能|不许|不准|请勿|避免|少)";
/** 动作词；`再` 允许「别再洗」。 */
const NL_VERB = "(?:再)?(?:开|用|使用|启动|运行|洗|烘|弄|动|转)";
/** 设备 / 对象词，允许并列（洗衣机或烘干机 / 洗衣机、烘干机 / 洗衣服）。 */
const NL_DEVICE =
  "(?:洗衣机|烘干机|洗烘机|洗衣机烘干机|洗烘|衣服|衣物)";
const NL_DEVICE_SEQ = `${NL_DEVICE}(?:(?:或|和|跟|与|还是|及)?${NL_DEVICE})*`;
/** 句尾礼貌词，不算夹带。 */
const NL_TAIL = "(?:了|吧|啊|啦|呀|哦|嘛|好吗|行吗|可以吗|谢谢|多谢)*";

const NL_TIME_FIRST = new RegExp(
  `^${NL_TIME}${NL_PRE}${NL_NEG}${NL_VERB}${NL_DEVICE_SEQ}${NL_TAIL}$`
);
const NL_NEG_FIRST = new RegExp(
  `^${NL_PRE}${NL_NEG}(?:在|于)?${NL_TIME}${NL_PRE}${NL_VERB}${NL_DEVICE_SEQ}${NL_TAIL}$`
);

/** 归一化：去掉空白与句读，再剥掉体首的礼貌/时间前缀。 */
function normalizeBody(raw: string): string {
  return raw
    .replace(/\s+/g, "")
    .replace(/[。.!！~～、,，;；:：]/g, "")
    .replace(/^(?:麻烦|请|以后|下次|之后|将来|记得|千万|一定|拜托)+/, "");
}

/**
 * 这条消息是不是在请求「夜间洗衣提醒」这一族功能（含形式不合规的尝试）。
 * 命中但它不合规时，调用方给一句短的下一步说明、**不发送**；不命中
 * （例如浴室头发、水费、一般噪音）就直接走普通对话，第三方出站为零。
 */
export function looksLikeNightLaundryReminder(text: string): boolean {
  const t = text.trim().replace(LOOSE_POLITE, "");
  return (
    LOOSE_LEAD.test(t) && LOOSE_NIGHT.test(t) && LOOSE_LAUNDRY.test(t)
  );
}

/**
 * 确定性识别这条命令。**认不出就返回 null**，调用方应当回一句结构化指引
 * （若 `looksLikeNightLaundryReminder` 为真）或落回普通对话，不要猜。
 */
export function recognizeNightLaundryReminder(
  text: string
): NightLaundryReminderCommand | null {
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
  if (!recipientName || !(NL_TIME_FIRST.test(body) || NL_NEG_FIRST.test(body))) {
    return null;
  }
  return { recipientName };
}

/** 给发起人的短的结构化指引（形式不对 / 校验不过时统一用它收口）。 */
function formGuidance(prefix: string): string {
  return `${prefix}夜间洗衣提醒只支持这一种说法：「${NIGHT_LAUNDRY_REMINDER_FORM}」。`;
}

export type NightLaundryReminderOutcome =
  | {
      /** 这条消息根本不是夜间洗衣提醒，普通对话照常处理。 */
      kind: "none";
    }
  | {
      /** 像夜间洗衣提醒但形式/校验不通过：回一句短指引，**零第三方出站**。 */
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
 * 识别 + 校验 + 发送一条夜间洗衣提醒。
 *
 * **不调用任何模型**，也不接受自由正文：命令不合规或校验不过就返回
 * `guidance`，绝不外发。命中的成功路径由本函数落库（decision →
 * communication → appendMessage），调用方只需再补一条给当前人的回执。
 */
export async function deliverNightLaundryReminder(args: {
  householdId: string;
  senderPersonId: string;
  senderIsTest: boolean;
  channel: string;
  text: string;
}): Promise<NightLaundryReminderOutcome> {
  if (!looksLikeNightLaundryReminder(args.text)) {
    return { kind: "none" };
  }

  const command = recognizeNightLaundryReminder(args.text);
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
    what: "发送夜间洗衣提醒",
  });

  const decisionId = await repo.recordDecision({
    householdId: args.householdId,
    kind: "contact_one",
    targetPersonIds: [target.personId],
    intent: "夜间洗衣提醒",
    rationale:
      "已开放功能：按固定文案发送夜间洗衣提醒；正文不含来源、用户原话或具体钟点。",
    modelId: null,
  });
  const communicationId = await repo.queueCommunication({
    householdId: args.householdId,
    decisionId,
    caseId: null,
    toPersonId: target.personId,
    channel: args.channel,
    purpose: "夜间洗衣提醒",
    body: NIGHT_LAUNDRY_REMINDER_TEXT,
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
    body: NIGHT_LAUNDRY_REMINDER_TEXT,
    communicationId,
  });

  return {
    kind: "sent",
    recipientName: target.name,
    recipientPersonId: target.personId,
    to: target.address,
    text: NIGHT_LAUNDRY_REMINDER_TEXT,
    communicationId,
    decisionId,
    receiptText: nightLaundryReminderReceipt(target.name),
  };
}
