/**
 * **定案通知的派发编排：代码定路由，措辞层写语言，失败留在待办里。**
 *
 * 判定在 `final-notice.ts` 的纯函数；这里把判定变成真实的投递动作。依赖全部注入
 * （读台账 / 写文案 / 投递），所以整条执行路径可以离线跑真测试。
 *
 * 一条规则 **只写一次文案**（同一条规则不该因人而异），然后逐个投给待发的人；
 * 收件人由代码算，模型没有再选一次的机会，因此不会重复发或发错人。
 *
 * 这里**不写任何「已通知」标记**：回执就是 `coliving.communication.status`
 * （`queued` → 下一轮不重发；`sent` → 真算数；`failed` / `skipped` → 重新落回待发）。
 * `outstanding` 里的人这一轮确实没通知到，调用方不许把这轮说成「都通知完了」。
 *
 * 不加 `import "server-only"`：本模块不碰 DB、不碰模型、不碰环境变量。
 */

import {
  planFinalNotices,
  type FinalNoticeCandidate,
  type FinalNoticeRecipient,
  type FinalNoticeSkipReason,
} from "./final-notice";

/** 一次投递成功后的回执（地址 + 那条 communication 的 id）。 */
export type FinalNoticeDelivery = { to: string; communicationId: string };

export type FinalNoticeDispatchDeps = {
  /** 这栋房子的待发台账（`repo.finalNoticeCandidates`）。 */
  loadPending: () => Promise<FinalNoticeCandidate[]>;
  /**
   * 用**这条规则的原文**写一句定案通知。
   *
   * **普通失败（写不出 JSON、被截断）由这个依赖自己吞掉并返回 null**——上层要顺手
   * 把已经花掉的用量记进本轮台账。**致命取消（评测预算超限 / 主动中止）必须抛出来。**
   */
  composeAnnouncement: (ruleStatement: string) => Promise<string | null>;
  /** 投给一位住户。失败 / 普通异常返回 null，**不记任何回执**。 */
  deliver: (args: {
    ruleId: string;
    recipient: FinalNoticeRecipient;
    text: string;
  }) => Promise<FinalNoticeDelivery | null>;
  /** 致命错误判定（预算超限 / 中止）——命中就继续往上抛，**绝不当普通失败吞掉**。 */
  isFatal?: (error: unknown) => boolean;
  /** 一轮最多为几条规则写文案，缺省 2：待办再多也不在这个回合里无限花钱。 */
  maxRules?: number;
};

export type FinalNoticeSent = FinalNoticeDelivery & {
  ruleId: string;
  personId: string;
  name: string;
  text: string;
};

/** 这一轮**没有**通知到的人（规则 + 收件人）。它们仍是待办。 */
export type FinalNoticeOutstanding = { ruleId: string; personId: string };

export type FinalNoticeDispatchResult = {
  sent: FinalNoticeSent[];
  outstanding: FinalNoticeOutstanding[];
  /** 每条规则这一轮写出来的通知正文（失败为 null）。给日志 / 评测看，不驱动逻辑。 */
  composed: Array<{ ruleId: string; text: string | null }>;
  /** 判定为不发的规则与原因。噪声，但排查「为什么没发」时必需。 */
  skipped: Array<{ ruleId: string; reason: FinalNoticeSkipReason }>;
  /** 这一轮因为条数上限没轮到的规则——保持待办，下一轮再来。 */
  deferred: string[];
};

export async function dispatchPendingFinalNotices(
  deps: FinalNoticeDispatchDeps
): Promise<FinalNoticeDispatchResult> {
  const maxRules = deps.maxRules ?? 2;
  const candidates = await deps.loadPending();
  const sent: FinalNoticeSent[] = [];
  const outstanding: FinalNoticeOutstanding[] = [];
  const composed: Array<{ ruleId: string; text: string | null }> = [];
  const skipped: Array<{ ruleId: string; reason: FinalNoticeSkipReason }> = [];
  const deferred: string[] = [];
  let composedRules = 0;

  for (const rule of candidates) {
    const plan = planFinalNotices(rule);
    if (!plan.dispatch) {
      skipped.push({ ruleId: rule.ruleId, reason: plan.reason });
      continue;
    }
    // 花钱的上限：写文案是这一步唯一的模型调用。
    if (composedRules >= maxRules) {
      deferred.push(rule.ruleId);
      continue;
    }
    let text: string | null = null;
    try {
      const wrote = await deps.composeAnnouncement(rule.statement);
      composedRules += 1;
      text = wrote && wrote.trim() ? wrote.trim() : null;
    } catch (error) {
      if (deps.isFatal?.(error)) throw error;
      composedRules += 1;
      text = null;
    }
    composed.push({ ruleId: rule.ruleId, text });
    if (!text) {
      // 话没写出来 → 这条规则一个人都不发，**不影响别的规则**。
      for (const recipient of plan.recipients) {
        outstanding.push({ ruleId: rule.ruleId, personId: recipient.personId });
      }
      continue;
    }
    for (const recipient of plan.recipients) {
      let delivered: FinalNoticeDelivery | null = null;
      try {
        delivered = await deps.deliver({
          ruleId: rule.ruleId,
          recipient,
          text,
        });
      } catch (error) {
        if (deps.isFatal?.(error)) throw error;
        delivered = null;
      }
      if (!delivered) {
        outstanding.push({ ruleId: rule.ruleId, personId: recipient.personId });
        continue;
      }
      sent.push({
        ...delivered,
        ruleId: rule.ruleId,
        personId: recipient.personId,
        name: recipient.name,
        text,
      });
    }
  }

  return { sent, outstanding, composed, skipped, deferred };
}
