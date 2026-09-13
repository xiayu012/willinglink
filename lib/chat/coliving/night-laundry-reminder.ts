import "server-only";

import { assertCanWrite } from "./guard";
import * as repo from "./repo";
import {
  hasRelayedReminderAskSignal,
  looksLikeRelayedReminderAsk,
} from "./reminder-ask";
import {
  AMBIGUOUS_REMINDER_RECIPIENT_REPLY,
  reminderExecutionDeps,
  reminderTargetIneligibleReply,
  type ReminderExecutionDeps,
} from "./reminder-execution";

/**
 * **已开放的具体功能：夜间洗衣提醒（第二项受约束第三方出站）。**
 *
 * 老板 2026-09-12「具体功能逐项开放」拍板后，这是继个人物品使用提醒
 * （`personal-item-reminder.ts`）之后按同一套严格口径开放的第二项，也是
 * 同一受限功能体系里的**同级模块**，不是新的通用出口。它可处理的共同影响
 * 只有一件：深夜运行洗衣机 / 烘干机影响别人休息。**不从这里外推到**
 * 一般噪音、一般清洁、规则制定、费用分摊或去留协调。
 *
 * 老板 2026-09-13 再次明确：**白名单是功能/动作边界，不是每一次命中都要
 * 二次确认。** 合规的自然请求既然已经落在白名单功能内，就直接复用本功能
 * 既有的受约束执行器发出固定正文 + 固定回执；不设「预览 → 回复确认发送或
 * 取消」的状态机。**不许部分执行**：收件人不唯一、混入其它议题、讨论、否定
 * 或未点名时，一律不发送，落回普通对话或回一句既有真话说明。
 *
 * 跟个人物品提醒完全同构的三条不可放宽的性质：
 *
 * 1. **确定性识别，不过模型。** 认两种形态：①旧的窄命令
 *    （`提醒 阿川：深夜别开洗衣机或烘干机` 的等价说法，允许标点和礼貌前缀
 *    的细微变体）；②**合规的近似自然请求**（点名了名册里唯一的室友、主题
 *    正好是深夜洗衣、明确要 AI 去执行、不是讨论/否定/混合）。识别纯靠正则，
 *    **不接受任意自由文本**——命令体里有任何多余内容（清理头发、分摊费用、
 *    全屋规矩、人身攻击等）就一律不认，**零第三方出站**，由
 *    `runColivingTurn` 回一句短的结构化指引。
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
 * 旧版固定命令句式。**只为兼容既有断言保留，不再出现在任何发给住户的
 * 消息里**（老板已驳回「只支持这一种说法」的模板指引；合规自然请求现在
 * 直接执行，也不回模板）。
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
 * 明确属于**其它未开放能力 / 混合议题**的信号。命中即不吞，落回普通对话：
 * 一般噪音、卫生/头发、费用分摊、规则制定、去留协调，以及混进来的个人物品
 * 诉求（那一件另有它自己的模块）。这是「宁可漏掉，不吞普通谈话」的关键闸。
 */
const NIGHT_APPROX_FOREIGN =
  /(?:头发|地漏|卫生|水费|电费|分摊|摊钱|公用|公摊|规矩|规则|全屋|大家都|大家也|换住|搬走|退租|押金|访客|过夜|厨房|做饭|垃圾|音乐|电视|外放|音量|搬家具|清洁|打扫|轮值|值日|宠物|抽烟|个人物品|私人物品|我(?:的)?东西)/;

/** 深夜时段 + 洗衣设备：这一项功能的独有主题。 */
function isNightLaundryTopic(t: string): boolean {
  return LOOSE_NIGHT.test(t) && LOOSE_LAUNDRY.test(t);
}

/**
 * 近似请求的**便宜预筛**（不查名册）：主题 + 请求语气 + 非讨论/非混合。
 * 先跑它，只有疑似才去读成员表。
 */
export function hasNightLaundryAskSignal(text: string): boolean {
  return hasRelayedReminderAskSignal(text, {
    topicCue: isNightLaundryTopic,
    foreignCue: NIGHT_APPROX_FOREIGN,
  });
}

/**
 * 完整判定：见 `looksLikeRelayedReminderAsk`。`memberNames` 传的是**除当前
 * 说话人以外**的名册姓名（判定「指定室友」用）。
 */
export function looksLikeApproximateNightLaundryAsk(
  text: string,
  memberNames: readonly string[]
): boolean {
  return looksLikeRelayedReminderAsk(text, memberNames, {
    topicCue: isNightLaundryTopic,
    foreignCue: NIGHT_APPROX_FOREIGN,
  });
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

/**
 * 没法安全受理时给发起人的短说明：**说人话、说真话**——没发出去 + 我能帮上
 * 的是哪一类事。**到此为止。**
 *
 * **不写「用平常的话再说一遍」这类反复重述的指令，也不承诺「只说个名字
 * 就行」。** 走到这一句时多半已经点了名（只是夹带了水费/头发、或被否定式
 * 交办），再问「谁」是睁眼说瞎话；而「只说个名字」也走不通——近似入口要求
 * 整句里既有请求语气又有这一项的主题。不再摆占位模板
 * （`NIGHT_LAUNDRY_REMINDER_FORM` 保留只为兼容既有断言，不再出现在任何
 * 发给住户的消息里）。
 */
function unsupportedFormReply(): string {
  return "这条我没有发出去。我能帮住户做的是「夜间洗衣提醒」这一类：深夜用洗衣机或烘干机影响别人休息。";
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

/** 窄命令路径与合规近似请求路径共用的「发送给某位已核对成员」。 */
async function executeNightLaundryReminder(
  deps: ReminderExecutionDeps,
  args: { householdId: string; senderIsTest: boolean; channel: string },
  target: repo.Member
): Promise<Extract<NightLaundryReminderOutcome, { kind: "sent" }>> {
  // 跟其它写入入口同一条硬闸：本地进程不许写真人住的房子（见 guard.ts）。
  assertCanWrite({
    isTestHousehold: args.senderIsTest,
    what: "发送夜间洗衣提醒",
  });

  const decisionId = await deps.recordDecision({
    householdId: args.householdId,
    kind: "contact_one",
    targetPersonIds: [target.personId],
    intent: "夜间洗衣提醒",
    rationale:
      "已开放功能：按固定文案发送夜间洗衣提醒；正文不含来源、用户原话或具体钟点。",
    modelId: null,
  });
  const communicationId = await deps.queueCommunication({
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
    body: NIGHT_LAUNDRY_REMINDER_TEXT,
    communicationId,
  });

  return {
    kind: "sent",
    recipientName: target.name,
    recipientPersonId: target.personId,
    to: target.address ?? "",
    text: NIGHT_LAUNDRY_REMINDER_TEXT,
    communicationId,
    decisionId,
    receiptText: nightLaundryReminderReceipt(target.name),
  };
}

/**
 * 合规的近似自然语言请求入口（不过模型）：判定自带主题 / 请求语气 / 非讨论 /
 * 非否定 / 非混合的闸，且点名了**名册里唯一**的室友——命中就复用本功能的
 * 受约束执行器，直接发那条写死的固定正文、回一句真话收据（`sent`）。返回
 * `null` 表示「不是可受理的近似请求」，由调用方决定回一句真话指引还是走普通
 * 对话。
 *
 * **不许部分执行**：点了不止一位人名（歧义）或收件人不可达时，只回一句真话
 * 说明、零写入；混合议题在信号层就被挡掉，绝不拆成半边发送。
 *
 * **刻意不拿「像不像这一族」当前置条件。** 出过事（2026-09-12 Codex 实测）：
 * 住户说「帮我提醒阿川深夜别开洗衣机」——点了名、意思也对，只是没按固定格式
 * 写——旧写法先要求 `looksLikeNightLaundryReminder` 再进近似分支，结果它被
 * 挡在门外，回一句「你说清楚要提醒谁」，明明已经点名了。现在只要近似判定
 * 通过就收口到受约束执行器，**不**再看窄命令的宽松线索。
 */
async function tryNightLaundryApproxRequest(
  args: {
    householdId: string;
    senderPersonId: string;
    /** 透传自 deliver 入参的**真实**测试屋标记，发送前过 assertCanWrite。 */
    senderIsTest: boolean;
    channel: string;
    text: string;
  },
  deps: ReminderExecutionDeps
): Promise<NightLaundryReminderOutcome | null> {
  // 先做不查名册的预筛，只有疑似才读成员表，避免每条无关消息都查一次。
  if (!hasNightLaundryAskSignal(args.text)) {
    return null;
  }
  const others = (await deps.getMembers(args.householdId, args.channel)).filter(
    (m) => m.personId !== args.senderPersonId
  );
  if (
    !looksLikeApproximateNightLaundryAsk(
      args.text,
      others.map((m) => m.name)
    )
  ) {
    return null;
  }
  // 收件人必须由**稳定 ID 唯一确定**：消息里点了不止一个人名就是歧义，
  // 给真话澄清、不发送（否则会变成对某个人的误发）。
  const matched = others.filter(
    (m) => m.name.trim().length >= 2 && args.text.includes(m.name)
  );
  if (matched.length > 1) {
    return { kind: "guidance", reply: AMBIGUOUS_REMINDER_RECIPIENT_REPLY };
  }
  const target = matched[0];
  if (!target) {
    return null;
  }
  const ineligible = reminderTargetIneligibleReply(target);
  if (ineligible) {
    return { kind: "guidance", reply: ineligible };
  }
  return await executeNightLaundryReminder(deps, args, target);
}

/**
 * 识别 + 校验 + 发送一条夜间洗衣提醒。
 *
 * **不调用任何模型**，也不接受自由正文。判定顺序：
 *   ① 先试**原有窄命令**（`recognizeNightLaundryReminder`）：命中就走老路径
 *      （名册校验 → 固定正文发送），行为与开放时一致；
 *   ② 不是窄命令，再试**合规的近似自然语言请求**：点名声册里唯一的室友、主题
 *      正好是深夜洗衣、明确要 AI 去执行时，**直接复用同一个受约束执行器**发送
 *      （固定正文 + 真话收据），不需要二次确认；
 *   ③ 仍像这一族但没法安全受理（夹带 / 没点名 / 被否定）：回一句真话短说明，
 *      零第三方出站；不像就走普通对话。
 */
export async function deliverNightLaundryReminder(
  args: {
    householdId: string;
    senderPersonId: string;
    senderIsTest: boolean;
    channel: string;
    text: string;
  },
  deps: ReminderExecutionDeps = reminderExecutionDeps
): Promise<NightLaundryReminderOutcome> {
  // ① 原有窄命令：命中即走老路径。
  const command = recognizeNightLaundryReminder(args.text);
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
    return await executeNightLaundryReminder(deps, args, target);
  }

  // ② 合规的近似自然请求：直接走同一个受约束执行器，不需要二次确认。
  const approx = await tryNightLaundryApproxRequest(args, deps);
  if (approx) {
    return approx;
  }

  // ③ 像这一族但受理不了：真话说明，零第三方出站。
  if (looksLikeNightLaundryReminder(args.text)) {
    return { kind: "guidance", reply: unsupportedFormReply() };
  }
  return { kind: "none" };
}
