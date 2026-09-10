/**
 * 语料场景的类型定义。**先校验格式，再跑**——见 `scripts/coliving-eval.ts`。
 *
 * 设计取舍（对照 docs/coliving-parallel-testing-plan.md 阶段一）：
 * - 一个场景 = 一个独立的测试屋 + 一串按顺序发生的对话轮次。
 *   household 之间靠 `household_id` 天然隔离，场景可以并发跑，
 *   不需要 `pnpm coliving:db --purge` 这个串行点。
 * - `expect` 是**结构性**断言（工具有没有调、回复里有没有出现某个词），
 *   不做语义判断——语义判断（"这条回复合不合适"）留给阶段三的人工/
 *   子代理审查，这里只做代码能确定性判的那部分（阶段二）。
 */

import {
  COORDINATION_ACTION_BASES,
  COORDINATION_DISCLOSURE_PLANS,
  COORDINATION_REQUESTED_ACTIONS,
  COORDINATION_SOURCE_TYPES,
  COORDINATION_USER_GOALS,
  PRIVACY_INFERENCE_RISKS,
  PRIVACY_OWNER_CONSENTS,
  PRIVACY_RECOMMENDED_ACTIONS,
  type PrivacyTurnCard,
} from "./privacy-turn-card";

export type ScenarioPerson = {
  phone: string;
  name: string;
  role: "tenant" | "landlord";
};

function isEnumValue<T extends string>(
  allowed: readonly T[],
  value: unknown
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

const PRIVACY_CARD_STRING_FIELDS = [
  "sourceOwner",
  "residentReply",
  "decisionSummary",
] as const;

const PRIVACY_CARD_STRING_ARRAY_FIELDS = [
  "proposedRecipients",
  "sensitiveClaims",
  "riskReasons",
] as const;

/**
 * 校验场景里保存的**人工金标准「本轮协调动作卡」**（gold card）的静态结构。
 *
 * 只查字段存在、类型与枚举合法——语义/状态一致性由 `privacy-turn-card.ts`
 * 的 `validatePrivacyCard` 负责（那是动作边界的单一事实源，不在这里复制一份
 * 会漂移的判断）。
 */
export function validatePrivacyCardShape(raw: unknown, errors: string[]): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("privacyCard 必须是对象");
    return;
  }
  const card = raw as Record<string, unknown>;
  for (const field of PRIVACY_CARD_STRING_FIELDS) {
    if (typeof card[field] !== "string") {
      errors.push(`privacyCard.${field} 必须是字符串`);
    }
  }
  for (const field of PRIVACY_CARD_STRING_ARRAY_FIELDS) {
    const value = card[field];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      errors.push(`privacyCard.${field} 必须是字符串数组`);
    }
  }
  if (!isEnumValue(COORDINATION_USER_GOALS, card.userGoal)) {
    errors.push(
      `privacyCard.userGoal 必须是 ${COORDINATION_USER_GOALS.join("/")} 之一`
    );
  }
  if (!isEnumValue(COORDINATION_REQUESTED_ACTIONS, card.requestedAction)) {
    errors.push(
      `privacyCard.requestedAction 必须是 ${COORDINATION_REQUESTED_ACTIONS.join("/")} 之一`
    );
  }
  if (!isEnumValue(COORDINATION_ACTION_BASES, card.actionBasis)) {
    errors.push(
      `privacyCard.actionBasis 必须是 ${COORDINATION_ACTION_BASES.join("/")} 之一`
    );
  }
  if (!isEnumValue(COORDINATION_DISCLOSURE_PLANS, card.disclosurePlan)) {
    errors.push(
      `privacyCard.disclosurePlan 必须是 ${COORDINATION_DISCLOSURE_PLANS.join("/")} 之一`
    );
  }
  if (!isEnumValue(PRIVACY_INFERENCE_RISKS, card.inferenceRisk)) {
    errors.push(
      `privacyCard.inferenceRisk 必须是 ${PRIVACY_INFERENCE_RISKS.join("/")} 之一`
    );
  }
  if (!isEnumValue(PRIVACY_OWNER_CONSENTS, card.ownerConsent)) {
    errors.push(
      `privacyCard.ownerConsent 必须是 ${PRIVACY_OWNER_CONSENTS.join("/")} 之一`
    );
  }
  if (!isEnumValue(PRIVACY_RECOMMENDED_ACTIONS, card.recommendedAction)) {
    errors.push(
      `privacyCard.recommendedAction 必须是 ${PRIVACY_RECOMMENDED_ACTIONS.join("/")} 之一`
    );
  }
  // 逐字段依据：至少一条，且每条结构完整、来源等级合法。
  if (!Array.isArray(card.basis) || card.basis.length === 0) {
    errors.push("privacyCard.basis 必须是非空数组");
  } else {
    for (const [i, entry] of card.basis.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`privacyCard.basis[${i}] 必须是对象`);
        continue;
      }
      const basis = entry as Record<string, unknown>;
      if (
        !Array.isArray(basis.fields) ||
        basis.fields.length === 0 ||
        basis.fields.some((f) => typeof f !== "string")
      ) {
        errors.push(`privacyCard.basis[${i}].fields 必须是非空字符串数组`);
      }
      if (!isEnumValue(COORDINATION_SOURCE_TYPES, basis.sourceType)) {
        errors.push(
          `privacyCard.basis[${i}].sourceType 必须是 ${COORDINATION_SOURCE_TYPES.join("/")} 之一`
        );
      }
      if (typeof basis.sourceRef !== "string" || !basis.sourceRef) {
        errors.push(`privacyCard.basis[${i}].sourceRef 必须是非空字符串`);
      }
      if (typeof basis.rule !== "string" || !basis.rule) {
        errors.push(`privacyCard.basis[${i}].rule 必须是非空字符串`);
      }
    }
  }
}

/** 统计通过审稿的草稿；不把工具调用次数或被拦消息当作可投递结果。 */
export function countAcceptedOutbound(messages: Array<{ blocked?: boolean }>): number {
  return messages.filter((m) => !m.blocked).length;
}

/**
 * 送到住户手里那句最终回复，最后一次审稿的结论是否站得住——
 * `verified:false`（没真的跑起来判过）或 `pass:false`（判过、不合格）
 * 都算门禁失败，不能让"批判器明知不合格但代码照样发了"在跑批里显示绿灯。
 */
export function evaluateReplyReview(
  review: { verified: boolean; pass: boolean; broke: string; why: string } | undefined
): string[] {
  if (!review) {
    return ["缺少 replyReview——这一轮的最终回复没有可核验的审稿结论"];
  }
  if (!review.verified) {
    return ["最终回复的审稿未验证（verified=false），不能算通过"];
  }
  if (!review.pass) {
    return [`最终回复审稿不合格：第${review.broke || "?"}条：${review.why}`];
  }
  return [];
}

export function evaluateTurnReplyReviews(
  reviews: Array<
    { verified: boolean; pass: boolean; broke: string; why: string } | undefined
  >
): string[] {
  return reviews.flatMap((review, index) =>
    evaluateReplyReview(review).map((failure) => `第${index + 1}轮：${failure}`)
  );
}

export type ScenarioTurn = {
  /** 发信人手机号，必须在 people 里 */
  from: string;
  text: string;
};

/**
 * 只对**最后一轮**的结果做断言——多轮场景里，前面几轮是在铺垫信息，
 * 真正要检验的是"信息齐全之后这一轮做没做该做的事"。
 * 只需要断言中间某一轮时，把该轮设成一个独立场景更清楚，不在这里加复杂度。
 */
export type ScenarioExpectation = {
  /** 至少多少条出站通过审稿、可供投递。离线评测仍不真的发短信。 */
  minAcceptedOutbound?: number;
  /** 最后一轮 toolsUsed 必须包含全部这些工具，否则判失败 */
  mustUseTools?: string[];
  /**
   * 最后一轮 toolsUsed 至少要出现其中一个（OR，不要求全部）。
   * **这是防"拖延无行动"这类 bug 最稳的检查**——纯文字正则去匹配
   * "回头商量""我会去说"这类话术太脆弱（中文语义变体太多，容易漏判
   * 或者误伤合法的"确实需要延后"场景）。工具有没有被调用是确定性的
   * 事实，不受措辞影响。
   */
  mustUseAnyOfTools?: string[];
  /** 最后一轮 toolsUsed 不能出现任何一个，出现即判失败 */
  mustNotUseTools?: string[];
  /** 最后一轮的 reply 文本，命中任意一条即判失败（正则，用于抓"编号泄漏"这类明确、低歧义的模式） */
  replyMustNotMatch?: string[];
  /** 最后一轮的 reply 文本，必须命中全部这些（正则），用于确认关键信息真的传达了 */
  replyMustMatch?: string[];
  /**
   * 最后一轮主动发给别人的消息（`contactPerson`产生的 outbound，不是
   * reply）——命中任意一条即判失败。经典场景就是"发给被投诉方，
   * 却写成冲他一个人的祈使句"，这种问题从来不出现在 reply 里，
   * 只出现在 outbound，所以要单独查。
   */
  outboundMustNotMatch?: string[];
  /** 跑完这轮后，阻塞清单（getBlockedComms）至少要有几条——验证"问出去的话有没有被正确标记成在等回音" */
  minBlockedComms?: number;
};

export type EvalScenario = {
  id: string;
  /** 这个场景是哪来的——生产事故就写事故描述，编的场景就写设计意图 */
  source: string;
  /**
   * **快照重放**：填 `snapshots/` 下的文件名（不带 .json），这一轮就不再
   * 从零建屋，而是把那个时刻的完整世界状态恢复出来，只跑 `turns` 里的消息。
   *
   * 跟"从零演一遍"的区别（这是这个字段存在的全部理由）：多轮场景里
   * 从零重演，中间某一轮新代码反应不一样，后面几轮就跟着分叉，最后测的
   * 是"新代码对一条被重新演绎的对话的处理"。快照重放没有中间轮次，
   * 状态是冻住的，测的就是"新代码对那个历史时刻的处理"。
   *
   * 填了这个字段时，`household`/`people` 不用填（状态来自快照），
   * `turns[].from` 要用快照 `phoneMap` 里的**测试号**（跑
   * `pnpm coliving-snapshot` 时会打印出来）。
   */
  snapshot?: string;
  household?: { label: string };
  people?: ScenarioPerson[];
  /**
   * 不经模型铺垫，直接预置待测的结构化状态。适合“未结事项后的下一轮”这类
   * 回归：少一次模型调用，也避免第一轮输出波动改变第二轮前提。
   */
  setup?: {
    confirmedNames?: string[];
    priorMessages?: Array<{
      person: string;
      direction: "inbound" | "outbound";
      body: string;
    }>;
    openCases?: Array<{
      kind: string;
      title: string;
      severity?: string;
      positions?: Array<{
        person: string;
        kind: "preference" | "rejection" | "commitment";
        statement: string;
      }>;
    }>;
  };
  turns: ScenarioTurn[];
  expect?: ScenarioExpectation;
  /**
   * **人工核准的「本轮协调动作卡」**（gold card，评测专用）。随场景一起保存，
   * 由老板/Codex 对真实对白逐字段核对后写入；`scripts/coliving-privacy-card.ts`
   * 只读它、跑 `validatePrivacyCard` 并生成 JSON/HTML，**不调用任何模型**。
   * 结构复用 `PrivacyTurnCard`，避免另立一份会漂移的类型。
   */
  privacyCard?: PrivacyTurnCard;
};

export function validateScenario(s: unknown, filename: string): EvalScenario {
  const errors: string[] = [];
  const obj = s as Record<string, unknown>;
  if (typeof obj?.id !== "string" || !obj.id) errors.push("缺 id");
  if (typeof obj?.source !== "string" || !obj.source) errors.push("缺 source");

  // 快照场景的人和屋子都来自快照文件，不在这里重复声明；
  // 从零演的场景两样都必须齐（否则建不出屋子）
  const isSnapshot = typeof obj?.snapshot === "string" && obj.snapshot;
  if (!isSnapshot) {
    if (!obj?.household || typeof (obj.household as { label?: unknown })?.label !== "string") {
      errors.push("缺 household.label（不是快照场景就必须填）");
    }
    if (!Array.isArray(obj?.people) || obj.people.length === 0) {
      errors.push("people 必须是非空数组（不是快照场景就必须填）");
    }
  }

  if (!Array.isArray(obj?.turns) || obj.turns.length === 0) {
    errors.push("turns 必须是非空数组");
  } else if (!isSnapshot) {
    // 快照场景的号码要对着快照的 phoneMap 校验，那要读文件，
    // 放在 runner 里恢复完再查（见 coliving-eval.ts），这里只查从零演的
    const phones = new Set(
      (obj.people as ScenarioPerson[] | undefined)?.map((p) => p.phone) ?? []
    );
    for (const [i, t] of (obj.turns as ScenarioTurn[]).entries()) {
      if (!phones.has(t.from)) {
        errors.push(`turns[${i}].from（${t.from}）不在 people 列表里`);
      }
    }
  }
  const setup = obj?.setup as EvalScenario["setup"] | undefined;
  if (setup?.openCases && !Array.isArray(setup.openCases)) {
    errors.push("setup.openCases 必须是数组");
  }
  if (obj?.privacyCard !== undefined) {
    validatePrivacyCardShape(obj.privacyCard, errors);
  }
  if (errors.length > 0) {
    throw new Error(`场景文件 ${filename} 格式不对：${errors.join("；")}`);
  }
  return obj as EvalScenario;
}
