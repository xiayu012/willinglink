/**
 * 共同规则定案后的**终局通知**：这条规则定案了没有、按台账还有谁没收到。
 *
 * **纯函数、无 DB、无模型、不写话术**——正文由措辞层写，投递由既有发送链路做。
 * 起因是真实缺口：三位住户定下一条厨房规则，最后一位回「我同意」之后，模型只回了
 * 他那句「那就定了」，另外两位一条消息都没收到。所以判定从模型手里拿走。
 *
 * **谁已经收到，只看这条规则自己的通知回执**（`repo.finalNoticeCandidates` 从
 * `decision.payload` 的两个 id 关联 `communication.status` 算出来）：`sent` 才算已
 * 通知；`queued` 已入队、本轮不重发但**不算已通知**（日后变 `failed` /
 * `skipped` 会自动落回待发）。**不许拿「这一轮发过消息的人」来减**——那可能是跟这条
 * 规则无关的提醒，拿它当收据会把定案通知整个吞掉。
 *
 * 两条不变量：**有人反对绝不定案**（所有人都表过态只说明问完了）、**没人回不算同意**
 * （`consultedAt` 为空一律不发，沉默永远推不出定案）。
 *
 * **最后说话的人也在这份名单里**：他这一轮的回复不是「已经拿到通知」的凭证。真要合进
 * 回复，由 `turn.ts` 把措辞层那句并进回复、并给那条回复本身登记 (规则, 人) 回执；
 * 本模块不认识「当前说话人」这个概念。
 */

/** 定案通知的收件人。只带稳定 id 与显示名——显示名只用于文案。 */
export type FinalNoticeRecipient = { personId: string; name: string };

/** 一条规则的通知台账（`decision.payload` ＋ `communication.status` 算出来的）。 */
export type FinalNoticeLedger = {
  /** 有 `status='sent'` 的定案通知。**唯一**算「已通知」。 */
  acceptedPersonIds: readonly string[];
  /** 有 `status='queued'` 的定案通知。不发，但也不算已通知。 */
  inFlightPersonIds: readonly string[];
};

/**
 * 一条登记的待发通知：`repo.finalNoticeCandidates` 的返回形状，原样喂给
 * `planFinalNotices`。判定逻辑只有这一份，SQL 不另做一套。
 *
 * `residents` 是**定案那一刻冻结的参与人**里、现在仍住在这里的人（名单在
 * `closeConsultationIfComplete` 登记时定死，之后搬进来的人不在里面）。
 */
export type FinalNoticeCandidate = FinalNoticeLedger & {
  ruleId: string;
  /** 规则原文（库里那条，不是模型这轮的转述）——措辞层拿它写通知。 */
  statement: string;
  /** 走完一轮征询的时间。null = 还有人没表态（或压根没问过）。 */
  consultedAt: Date | string | null;
  /** 明确反对的人数。 */
  objectedCount: number;
  residents: readonly FinalNoticeRecipient[];
};

/** 不派发的原因（可离线断言，也方便排查为什么没发）。 */
export type FinalNoticeSkipReason =
  | "not-settled"
  | "objected"
  | "everyone-reached";

export type FinalNoticePlan =
  | { dispatch: false; reason: FinalNoticeSkipReason }
  | { dispatch: true; recipients: FinalNoticeRecipient[] };

/** 这条规则算不算定案（= 全员明确同意）。 */
export function isSettledRule(rule: {
  consultedAt: Date | string | null;
  objectedCount: number;
}): boolean {
  return rule.consultedAt !== null && rule.objectedCount === 0;
}

/** 还有谁需要收到定案通知。顺序按传进来的名册顺序，不重排、不去猜。 */
export function pendingFinalNoticeRecipients(
  rule: FinalNoticeLedger & { residents: readonly FinalNoticeRecipient[] }
): FinalNoticeRecipient[] {
  const done = new Set([...rule.acceptedPersonIds, ...rule.inFlightPersonIds]);
  return rule.residents.filter((m) => !done.has(m.personId));
}

/** 这条规则这一轮要不要补发定案通知。**返回 `dispatch:true` 才允许真的发。** */
export function planFinalNotices(
  rule: FinalNoticeCandidate | null
): FinalNoticePlan {
  if (!rule) return { dispatch: false, reason: "not-settled" };
  if (!isSettledRule(rule)) {
    return {
      dispatch: false,
      reason: rule.objectedCount > 0 ? "objected" : "not-settled",
    };
  }
  const recipients = pendingFinalNoticeRecipients(rule);
  if (recipients.length === 0) {
    return { dispatch: false, reason: "everyone-reached" };
  }
  return { dispatch: true, recipients };
}
