import "server-only";

/**
 * 主动发起 —— **已按老板 2026-09-12「严格口径」整体停用。**
 *
 * 这一整条链路原本是「管理员」和「客服」的分界线：cron 自己回头看有没有
 * 该回访的事、该问全的规则、该接触的新人，然后**由模型自由写一条短信**
 * 发给某个住户。
 *
 * 严格口径要求：**立刻收回所有自由文本的第三方出站能力**，只保留
 * `personal-item-reminder.ts` 那一个程序化受约束的功能。主动发起写的
 * 正是自由文本（`compose()` 里一次 `generateText`，措辞全交给大脑），
 * 属于被收回的那一类，因此这里不再生成任何文本、不再入队任何消息。
 *
 * 三条不可放宽的性质：
 *
 * 1. **不调模型。** 本模块不 import AI SDK —— 不是「生成了但不发」，
 *    而是根本不生成。留着生成调用本身就是一条可被重新打开的自由文本
 *    出站路径。
 * 2. **不留待发消息。** 所有入口返回空结果，调用方（cron / enroll 路由）
 *    的投递循环自然空转，不会碰 Twilio 短信 —— 那是已授权排队消息
 *    的投递路由，本次不改。
 * 3. **保留签名。** `kickoffLandlord` / `runOutreachForHousehold` /
 *    `runOutreach` 与返回类型原样保留，路由不改；要走回来必须显式改这个
 *    文件并重新过一遍「谁允许往别的住户发自由文本」这个决定。
 *
 * 注意：`repo` 里的 `canReachProactively` / `markOutreach` /
 * `startOutreachRun` / `finishOutreachRun` 暂时没有调用方。**保留勿删**——
 * 它们是回退路径的一部分，重新开放主动发起时要接着用（见 AGENT_LOG）。
 */

export type OutreachMessage = {
  to: string;
  personId: string;
  text: string;
  communicationId: string;
};

export type OutreachResult = {
  household: string;
  jobs: Array<{ job: string; considered: number; acted: number }>;
  messages: OutreachMessage[];
};

/**
 * 开张第一条：原本是房东刚进库时主动联系他、拿到住户号码。
 *
 * 现在**不发**：那是自由文本第三方出站。房东入库仍然建房子、建人，
 * 只是不再主动开口——他知道房子的事时自己来问，走普通对话链路。
 */
export async function kickoffLandlord(_args: {
  householdId: string;
  personId: string;
}): Promise<OutreachMessage[]> {
  void _args;
  return [];
}

/**
 * 原本跑四类主动作业：回访冷掉的事 / 问全共同规则 / 接触新住户 / 到期提醒。
 *
 * 现在**全部停用**，一栋房子都不产生消息。保留函数与返回结构，路由照旧。
 */
export async function runOutreachForHousehold(
  householdId: string,
  label: string
): Promise<OutreachResult> {
  void householdId;
  return { household: label, jobs: [], messages: [] };
}

/**
 * 原本遍历所有房子跑主动发起。现在**一栋都不跑**，直接返回空数组——
 * 连房子都不查，确保没有任何一条自由文本出站路径残留。
 */
export async function runOutreach(): Promise<OutreachResult[]> {
  return [];
}
