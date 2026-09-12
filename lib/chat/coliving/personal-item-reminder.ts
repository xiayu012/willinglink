import "server-only";

import { assertCanWrite } from "./guard";
import * as repo from "./repo";
import {
  hasRelayedReminderAskSignal,
  looksLikeRelayedReminderAsk,
} from "./reminder-ask";

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

/**
 * 近似请求（不是窄命令形态，但明确让 AI 提醒某位指定室友、主题是
 * 「用我的个人物品前先问我」）统一回这句短指引：如实说**没有发送**，
 * 并给出这唯一一种固定说法。零第三方出站、不过模型。
 */
export const PERSONAL_ITEM_APPROXIMATE_GUIDANCE = `我没有把这条发给对方。个人物品提醒只能按固定说法发：「${PERSONAL_ITEM_REMINDER_FORM}」。`;

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
    // 不是窄命令形态，但可能是「明确让 AI 提醒某位指定室友」的近似自然语言
    // 请求：只回一句未发送指引，零第三方出站、不过模型。先做不查名册的预筛，
    // 只有疑似才读成员表，避免每条无关消息都查一次。
    if (hasPersonalItemAskSignal(args.text)) {
      const others = (
        await repo.getMembers(args.householdId, args.channel)
      )
        .filter((m) => m.personId !== args.senderPersonId)
        .map((m) => m.name);
      if (looksLikeApproximatePersonalItemAsk(args.text, others)) {
        return {
          kind: "guidance",
          reply: PERSONAL_ITEM_APPROXIMATE_GUIDANCE,
        };
      }
    }
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
