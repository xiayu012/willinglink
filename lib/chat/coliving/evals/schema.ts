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
  COORDINATION_ACTION_STATUSES,
  COORDINATION_CAPABILITY_ZONES,
  COORDINATION_DECISION_STAGES,
  COORDINATION_DISCLOSURE_PLANS,
  COORDINATION_REQUESTED_ACTIONS,
  COORDINATION_SOURCE_CONSTRAINTS,
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
  "capabilityReasons",
] as const;

/**
 * 校验场景里保存的**离线期望「本轮协调动作卡」**的静态结构。
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
  if (!isEnumValue(COORDINATION_SOURCE_CONSTRAINTS, card.sourceConstraint)) {
    errors.push(
      `privacyCard.sourceConstraint 必须是 ${COORDINATION_SOURCE_CONSTRAINTS.join("/")} 之一`
    );
  }
  if (!isEnumValue(COORDINATION_DECISION_STAGES, card.decisionStage)) {
    errors.push(
      `privacyCard.decisionStage 必须是 ${COORDINATION_DECISION_STAGES.join("/")} 之一`
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
  if (!isEnumValue(COORDINATION_ACTION_STATUSES, card.actionStatus)) {
    errors.push(
      `privacyCard.actionStatus 必须是 ${COORDINATION_ACTION_STATUSES.join("/")} 之一`
    );
  }
  if (!isEnumValue(COORDINATION_CAPABILITY_ZONES, card.capabilityZone)) {
    errors.push(
      `privacyCard.capabilityZone 必须是 ${COORDINATION_CAPABILITY_ZONES.join("/")} 之一`
    );
  }
  // 出站消息：数组，每条必须是含 recipient/purpose/text 三个非空字符串的对象。
  if (!Array.isArray(card.outboundMessages)) {
    errors.push("privacyCard.outboundMessages 必须是数组");
  } else {
    for (const [i, message] of card.outboundMessages.entries()) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        errors.push(`privacyCard.outboundMessages[${i}] 必须是对象`);
        continue;
      }
      const m = message as Record<string, unknown>;
      for (const field of ["recipient", "purpose", "text"] as const) {
        if (typeof m[field] !== "string" || !m[field]) {
          errors.push(
            `privacyCard.outboundMessages[${i}].${field} 必须是非空字符串`
          );
        }
      }
    }
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
 * 送到住户手里那句最终回复，最后一次核对的结论是否站得住。
 *
 * **生产已改为只生成**（见 `ReplyReview`）：`mode` 缺省或 `"generation-only"`
 * 时，`verified:false` 是**设计如此**（没有 LLM 审稿），**不算失败**——只要
 * `pass:true`（没有代码可证的确定性失败）就放行。`pass:false` 仍是真实产品
 * 问题，一律红灯。
 *
 * `mode:"llm-review"`（离线/历史路径）保留旧语义：`verified:false` 表示
 * "审稿器没真的跑起来判过"，算门禁失败，不能给绿灯。
 */
export function evaluateReplyReview(
  review:
    | {
        mode?: "generation-only" | "llm-review";
        verified: boolean;
        pass: boolean;
        broke: string;
        why: string;
      }
    | undefined
): string[] {
  if (!review) {
    return ["缺少 replyReview——这一轮的最终回复没有可核验的核对结论"];
  }
  if (!review.pass) {
    return [`最终回复确定性核对不合格：第${review.broke || "?"}条：${review.why}`];
  }
  if (review.mode === "llm-review" && !review.verified) {
    return ["最终回复的 LLM 审稿未验证（verified=false），不能算通过"];
  }
  return [];
}

export function evaluateTurnReplyReviews(
  reviews: Array<
    | {
        mode?: "generation-only" | "llm-review";
        verified: boolean;
        pass: boolean;
        broke: string;
        why: string;
      }
    | undefined
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
  /**
   * **可选：只对这一轮生效的结构性断言**，默认不填。连续多轮场景（同一住户
   * 反复交办、只查最后一轮会失明）把它填进需要的轮次；单轮场景不填，
   * 行为逐字不变。结构复用场景级 `ScenarioExpectation`，不另立字段。
   */
  expect?: ScenarioExpectation;
};

/**
 * 默认只对**最后一轮**的结果做断言——多轮场景里前面几轮是铺垫，
 * 真正要检验的是"信息齐全之后这一轮做没做该做的事"。需要逐轮都查的场景，
 * 把同一份结构填进 `ScenarioTurn.expect`；两者共用本类型，避免两套漂移。
 */
export type ScenarioExpectation = {
  /** 至少多少条出站通过审稿、可供投递。离线评测仍不真的发短信。 */
  minAcceptedOutbound?: number;
  /** toolsUsed 必须包含全部这些工具，否则判失败 */
  mustUseTools?: string[];
  /**
   * toolsUsed 至少要出现其中一个（OR，不要求全部）。
   * **这是防"拖延无行动"这类 bug 最稳的检查**——纯文字正则去匹配
   * "回头商量""我会去说"这类话术太脆弱（中文语义变体太多，容易漏判
   * 或者误伤合法的"确实需要延后"场景）。工具有没有被调用是确定性的
   * 事实，不受措辞影响。
   */
  mustUseAnyOfTools?: string[];
  /** toolsUsed 不能出现任何一个，出现即判失败 */
  mustNotUseTools?: string[];
  /** reply 文本，命中任意一条即判失败（正则，用于抓"编号泄漏"这类明确、低歧义的模式） */
  replyMustNotMatch?: string[];
  /** reply 文本，必须命中全部这些（正则），用于确认关键信息真的传达了 */
  replyMustMatch?: string[];
  /**
   * 主动发给别人的消息（`contactPerson`产生的 outbound，不是 reply）
   * ——命中任意一条即判失败。经典场景就是"发给被投诉方，却写成冲他
   * 一个人的祈使句"，这种问题从来不出现在 reply 里，只出现在 outbound，
   * 所以要单独查。
   */
  outboundMustNotMatch?: string[];
  /**
   * 主动发给别人的消息，必须命中全部这些（正则）——与 `outboundMustNotMatch`
   * 对称，只查**通过审稿**的实际出站（被拦下的草稿不算真正送达）。
   * 用于确认关键信息真的随出站传达了，比如约谈分开住的议题不能被软化掉。
   */
  outboundMustMatch?: string[];
  /** 本轮必须有一条**通过审稿**的出站发给这个收件人（全部满足）：调了工具不等于是真的发出去了。 */
  mustContactNames?: string[];
  /** 本轮不得产生发给这些收件人的出站，**含被审稿拦下的越权尝试**。 */
  mustNotContactNames?: string[];
  /** 跑完这轮后，阻塞清单（getBlockedComms）至少几条。要查库，仅场景级 `expect` 生效。 */
  minBlockedComms?: number;
};

/** 一轮跑完后的确定性事实，够 `evaluateTurnExpectation` 判完所有非查库断言。 */
export type TurnOutcome = {
  toolsUsed: string[];
  reply: string;
  outbound: Array<{ toName: string; text: string; blocked?: boolean }>;
};

/**
 * 把一份 `ScenarioExpectation` 对一轮结果判一遍，返回失败原因（空数组=通过）。
 * **纯函数**：不碰数据库、不调模型，场景级与逐轮共用同一份判法；要查库的
 * `minBlockedComms` 不在这里判，由 runner 单独处理。
 */
export function evaluateTurnExpectation(
  expect: ScenarioExpectation | undefined,
  outcome: TurnOutcome
): string[] {
  if (!expect) return [];
  const failures: string[] = [];
  // 通过的出站（真的会投递的那些）；被审稿拦下的草稿不算。
  const acceptedOutbound = outcome.outbound.filter((o) => !o.blocked);
  const acceptedCount = countAcceptedOutbound(outcome.outbound);
  if (expect.minAcceptedOutbound !== undefined && acceptedCount < expect.minAcceptedOutbound) {
    failures.push(
      `应有至少 ${expect.minAcceptedOutbound} 条通过审稿的出站，实际 ${acceptedCount} 条；调用联系工具不等于联系成功`
    );
  }
  for (const t of expect.mustUseTools ?? []) {
    if (!outcome.toolsUsed.includes(t)) {
      failures.push(
        `应该调用 ${t}，但 toolsUsed 里没有（实际：${outcome.toolsUsed.join("、") || "无"}）`
      );
    }
  }
  if (expect.mustUseAnyOfTools && expect.mustUseAnyOfTools.length > 0) {
    const hit = expect.mustUseAnyOfTools.some((t) => outcome.toolsUsed.includes(t));
    if (!hit) {
      failures.push(
        `应该调用 [${expect.mustUseAnyOfTools.join("、")}] 里的至少一个，但一个都没调（实际：${outcome.toolsUsed.join("、") || "无"}）`
      );
    }
  }
  for (const t of expect.mustNotUseTools ?? []) {
    if (outcome.toolsUsed.includes(t)) {
      failures.push(`不该调用 ${t}，但调用了`);
    }
  }
  for (const pattern of expect.replyMustNotMatch ?? []) {
    if (new RegExp(pattern).test(outcome.reply)) {
      failures.push(
        `回复命中了不该出现的模式「${pattern}」：${outcome.reply.slice(0, 80)}`
      );
    }
  }
  for (const pattern of expect.replyMustMatch ?? []) {
    if (!new RegExp(pattern).test(outcome.reply)) {
      failures.push(
        `回复没有命中该出现的模式「${pattern}」：${outcome.reply.slice(0, 80)}`
      );
    }
  }
  for (const pattern of expect.outboundMustNotMatch ?? []) {
    const hit = acceptedOutbound.find((msg) => new RegExp(pattern).test(msg.text));
    if (hit) {
      failures.push(
        `出站消息命中了不该出现的模式「${pattern}」：${hit.text.slice(0, 80)}`
      );
    }
  }
  for (const pattern of expect.outboundMustMatch ?? []) {
    // 只看通过审稿的实际出站（与 MustNotMatch 对称）：被拦下的草稿没送达，不算。
    const hit = acceptedOutbound.some((msg) => new RegExp(pattern).test(msg.text));
    if (!hit) {
      failures.push(
        `出站消息没有命中该出现的模式「${pattern}」（通过审稿的出站：${
          acceptedOutbound.map((msg) => msg.text).join(" ／ ") || "无"
        }）`
      );
    }
  }
  // 授权收件人范围：正向只认**通过审稿**的出站（调了工具但被拦下不算联系上），
  // 反向连被拦下的尝试也算（越权尝试本身就是问题，不因为被拦而免罪）。
  const acceptedNames = new Set(acceptedOutbound.map((o) => o.toName));
  for (const name of expect.mustContactNames ?? []) {
    if (!acceptedNames.has(name)) {
      const attempted = [...new Set(outcome.outbound.map((o) => o.toName))];
      failures.push(
        `应该有通过审稿的出站发给「${name}」，但没有（本轮出站收件人：${
          attempted.join("、") || "无"
        }）`
      );
    }
  }
  const attemptedNames = new Set(outcome.outbound.map((o) => o.toName));
  for (const name of expect.mustNotContactNames ?? []) {
    if (attemptedNames.has(name)) {
      failures.push(
        `不该联系「${name}」，但本轮产生了发给他的出站（含被审稿拦下的尝试）`
      );
    }
  }
  return failures;
}

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
   * **离线期望「本轮协调动作卡」**（评测专用，开发者草案）。随场景一起保存，
   * 由开发者按需求逐字段填写（**非老板核准、非模型生成**）；
   * `scripts/coliving-privacy-card.ts` 只读它、跑 `validatePrivacyCard`
   * 并生成 JSON/HTML，**不调用任何模型**。
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
  // 收件人姓名断言写错会静默失效（mustContact 永远失败 / mustNot 永远通过），
  // 所以非快照场景在载入阶段就查名字在不在名册里（快照名册来自 phoneMap，跳过）。
  if (!isSnapshot) {
    const roster = new Set(((obj?.people as ScenarioPerson[]) ?? []).map((p) => p.name));
    const blocks: Array<[unknown, string]> = [
      [obj?.expect, "expect"],
      ...(Array.isArray(obj?.turns) ? (obj.turns as ScenarioTurn[]) : []).map(
        (t, i) => [t?.expect, `turns[${i}].expect`] as [unknown, string]
      ),
    ];
    for (const [block, where] of blocks) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      for (const field of ["mustContactNames", "mustNotContactNames"] as const) {
        const value = (block as Record<string, unknown>)[field];
        if (value === undefined) continue;
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          value.some((n) => typeof n !== "string" || !n)
        ) {
          errors.push(`${where}.${field} 必须是非空字符串数组`);
          continue;
        }
        for (const name of value as string[]) {
          if (!roster.has(name)) {
            errors.push(`${where}.${field} 里的「${name}」不在 people 名册里`);
          }
        }
      }
    }
  }
  if (obj?.privacyCard !== undefined) {
    validatePrivacyCardShape(obj.privacyCard, errors);
  }
  if (errors.length > 0) {
    throw new Error(`场景文件 ${filename} 格式不对：${errors.join("；")}`);
  }
  return obj as EvalScenario;
}
