/**
 * **离线「逐动作协调计划」（V4 评测专用，纯结构 + 纯函数校验）。**
 *
 * 背景（为什么要有 V4）：V3 的 `PrivacyTurnCard` 只有一个**整轮级**的
 * `decisionStage=deliberating|authorized`，并把整轮出站绑在它上面——讨论态禁止任何
 * 出站，授权态原则上必须有出站。现实里的一个请求常常同时包含多个动作，每个动作的
 * 授权、信息就绪度和完成条件各不相同，整轮标签会误判：
 *
 * 1. 「先问小王哪天方便，排好表先给我看」：可以联系小王收集时间，但还不能发布排班。
 * 2. 「帮我安排时间」但发信人自己关键可用时间未知：目标已委托 ≠ 信息充分，此刻只该
 *    向发信人问一个会改变安排的问题，不该为了证明「已行动」去联系别人。
 * 3. 024 把「访客过夜」（可协调）和「无既有依据的新增水电分摊」（当前不能自定）绑在
 *    一起：只做前者会实质收窄原委托，要先让周姐决定；但也不能让一个整轮 red 抹掉
 *    可支持范围，更不能偷偷开始。
 *
 * V4 因此把一轮请求拆成 `plan + actionItems[]`，每个动作**独立**拥有自己的授权依据、
 * 信息就绪度、能力分区、执行状态、依赖项和实际出站收据。整轮标签不再控制单个动作。
 *
 * 设计自审（对照任务卡的三条停止条件）：
 * - **不是整轮二分**：`status` 逐动作取值，允许同一计划里「一个已发出、一个等确认、
 *   一个停止」并存（见 `action-plan-samples.ts` 的三张样例）。
 * - **不靠十几个近义枚举**：只保留 5 个正交轴——`kind`(5) / `authorization`(4) /
 *   `readiness`(2) / `status`(4) / `capability`(3，复用 V3 的绿黄红)。每个取值都能
 *   指到一条会改变校验结果的规则；没有为了对称硬凑的枚举。
 * - **简单动作字段少**：单动作绿区提醒只填 id/kind/purpose/authorization/capability/
 *   status/outbound 即可通过（`readiness`/`dependsOn`/`blockedReason`/`requesterQuestion`
 *   都是可缺省的）。
 *
 * 边界（重要）：
 * - **不接入生产**：`runColivingTurn`、critic、`contactPerson` 都不引用本文件；
 *   这里没有 repo、没有 DB、没有任何发送动作，只有类型和纯函数。
 * - 复用 V3 的 `OutboundMessage` 类型、能力分区枚举和 `claimsContactAlreadyMade`，
 *   避免另立一份会漂移的定义；但**不使用 V3 的整轮不变量**。
 * - 校验是「偏严格」的：只拦**可证明违反**的组合，不替作者猜它没写的东西。
 * - 语义判断由开发者填写的离线期望样例给出；这里只做状态一致性校验。
 */

import {
  COORDINATION_CAPABILITY_ZONES,
  claimsContactAlreadyMade,
  type CoordinationCapabilityZone,
  type OutboundMessage,
} from "./privacy-turn-card";

// ── 动作种类 ───────────────────────────────────────────────────────────────

/**
 * 这个动作是什么。
 * - `ask_requester`：只向当前发信人问一个会改变处置的必问题（**收据是那句问话，不是
 *   第三方出站**）；
 * - `contact_person`：联系第三方（收集约束或发出边界消息）；
 * - `make_schedule`：内部计算/拟方案（可以没有对外消息）；
 * - `publish_plan`：把已定方案发给受影响的人（对外发布）；
 * - `establish_rule`：形成一条共同生活规则（可能包含对外联系）。
 */
export const ACTION_KINDS = [
  "ask_requester",
  "contact_person",
  "make_schedule",
  "publish_plan",
  "establish_rule",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * 需要**第三方实际出站**才算「做了」的动作种类。用来判断「声称完成却没有收据」。
 * `make_schedule` 是内部计算，`ask_requester` 的收据是问话本身，都不在此列。
 */
export const THIRD_PARTY_ACTION_KINDS: readonly ActionKind[] = [
  "contact_person",
  "publish_plan",
];

// ── 授权依据 ───────────────────────────────────────────────────────────────

/**
 * 这个动作的授权从哪来。
 * - `requester_requested`：发信人本轮明确请求（默认已授权这个动作所需的联系）；
 * - `coordinator_duty`：协调员职责范围内、无需另行请示（例如向发信人补问一个缺项）；
 * - `needs_confirmation`：仍需发信人确认（授权或**范围**），确认前不得对第三方执行；
 * - `denied`：发信人明确拒绝，终止。
 */
export const ACTION_AUTHORIZATIONS = [
  "requester_requested",
  "coordinator_duty",
  "needs_confirmation",
  "denied",
] as const;
export type ActionAuthorization = (typeof ACTION_AUTHORIZATIONS)[number];

// ── 信息就绪度 ─────────────────────────────────────────────────────────────

/**
 * 信息是否够做这个动作（缺省视为 `ready`，简单动作不必填）。
 * - `ready`：信息充分；
 * - `missing_requester_fact`：缺**发信人自己**的关键事实（只有发信人能提供）——此时
 *   该动作自身不得出站/执行，要等这个缺项补齐（通常由一个 `ask_requester` 动作补）。
 *   缺项**只封这个动作和依赖它的动作**，不整轮连坐：同一请求里与它无关的其它动作
 *   （例如另一件独立的事）仍可正常出站。整轮最多向发信人问一个必要问题。
 * 缺**第三方**信息的情形由 `dependsOn`（等收集动作完成）表达，不另设枚举。
 */
export const ACTION_READINESS = [
  "ready",
  "missing_requester_fact",
] as const;
export type ActionReadiness = (typeof ACTION_READINESS)[number];

// ── 执行状态 ───────────────────────────────────────────────────────────────

/**
 * 这个动作现在执行到哪一步。
 * - `planned`：已计划、尚未动作（有没有被阻塞看 `readiness`/`dependsOn`/`authorization`）；
 * - `waiting_reply`：**已向第三方发出**，等回复（必须有本动作自己的出站收据）；
 * - `done`：该动作本轮已完成（对外动作必须有收据；`ask_requester` 的问话即收据）；
 * - `stopped`：因授权被拒或能力边界停止，本轮不动作（不得有出站）。
 */
export const ACTION_STATUSES = [
  "planned",
  "waiting_reply",
  "done",
  "stopped",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** 能力分区复用 V3 的绿/黄/红，避免两份会漂移的定义。 */
export type ActionCapability = CoordinationCapabilityZone;
export const ACTION_CAPABILITIES = COORDINATION_CAPABILITY_ZONES;

// ── 计划与动作项 ───────────────────────────────────────────────────────────

/** 计划里的一个动作。除标注可选外都为必填。 */
export type ActionItem = {
  /** 稳定 id，计划内唯一；`dependsOn` 用它指向别的动作。 */
  id: string;
  kind: ActionKind;
  /** 这个动作要做什么（一句话，给人工复核看）。 */
  purpose: string;
  authorization: ActionAuthorization;
  capability: ActionCapability;
  status: ActionStatus;
  /** 信息就绪度；缺省视为 `ready`。 */
  readiness?: ActionReadiness;
  /**
   * 为什么现在不做/等谁（人话，简短）。**只解释，不授权绕过结构闸**：真正决定
   * 「能不能做」的是 `authorization`/`readiness`/`capability`/`dependsOn`，
   * 写了理由也不会改变校验结果（见 `actionable_but_not_acted`）。
   */
  blockedReason?: string;
  /** 依赖的其它动作 id；依赖未完成前不得执行/发布。 */
  dependsOn?: string[];
  /** **只属于这个动作**的实际出站收据。 */
  outbound?: OutboundMessage[];
  /** 等发信人确认/回答时，那个（唯一的）会改变处置的问题。 */
  requesterQuestion?: string;
  /** 能力分区理由（尤其红区必须说清具体缺什么前提，不能笼统）。 */
  capabilityReasons?: string[];
};

/**
 * 一轮请求的逐动作计划。
 * `requesterReply` 是本轮真正回给发信人的那一句（唯一一条）。
 */
export type ActionPlan = {
  actions: ActionItem[];
  requesterReply: string;
};

/** 校验器需要的确定性语境——全部来自场景/样例，不让模型编。 */
export type ActionPlanContext = {
  /** 当前说话人姓名。 */
  speaker: string;
  /** 名册全部成员姓名（含说话人）。 */
  roster: string[];
  /** 本轮原文。 */
  rawMessage: string;
};

export type ActionPlanViolationCode =
  // 结构
  | "empty_actions"
  | "empty_action_id"
  | "duplicate_action_id"
  | "empty_purpose"
  | "empty_requester_reply"
  | "self_dependency"
  | "unknown_dependency"
  // 收据
  | "waiting_reply_without_receipt"
  | "done_send_action_without_receipt"
  | "unexpected_receipt"
  | "reply_claims_contact_without_receipt"
  // 收件人
  | "recipient_not_in_roster"
  | "recipient_is_speaker"
  | "outbound_text_empty"
  // 授权
  | "confirmation_required_but_acted"
  | "denied_but_acted"
  | "actionable_but_not_acted"
  // 信息就绪
  | "missing_requester_fact_executed"
  | "missing_requester_fact_blocks_dependent"
  | "multiple_requester_questions"
  // 能力分区
  | "red_requires_stop"
  | "red_forbids_outbound"
  // 依赖
  | "dependency_not_satisfied"
  // 问发信人
  | "ask_requester_forbids_outbound"
  | "ask_requester_requires_question";

export type ActionPlanViolation = {
  actionId?: string;
  code: ActionPlanViolationCode;
  message: string;
};

export type ActionPlanValidation = {
  ok: boolean;
  violations: ActionPlanViolation[];
};

/**
 * **纯函数状态校验**：把人工填的逐动作计划对着确定性语境逐条查。
 *
 * 不变量（逐条对应任务卡的免费校验清单）：
 * 1. 计划至少有一个动作（空 `actions` 即使配一句 `requesterReply` 也不通过）；
 *    action id 唯一、非空；依赖指向存在且不能自依赖；
 * 2. `waiting_reply`（声称已发出）必须有本动作自己的出站收据；`contact_person`/
 *    `publish_plan` 标 `done` 同样必须有收据；没有收据不得靠 `requesterReply`
 *    宣称已联系；`planned`/`stopped` 不得带出站；
 * 3. 出站收件人必须在名册内、不是发信人本人、正文非空；
 * 4. `authorization=needs_confirmation` 的动作确认前不得对第三方执行；
 *    `denied` 只能停止；
 * 5. `readiness=missing_requester_fact` **只封该动作自身和依赖它的动作**：它们不得
 *    出站/执行；同计划里与之无关的动作不受牵连（不整轮连坐）。全计划最多一个
 *    `requesterQuestion`；
 * 6. `capability=red` 的动作必须 `stopped` 且无出站；**不因此**改写同计划里其它
 *    动作的能力分区（校验器不跨动作传播 red）；
 * 7. 依赖未完成（依赖动作不是 `done`）时，引用它的动作不得执行/发布；
 * 8. `requester_requested + green + 信息就绪 + 无依赖` 的动作必须真的执行（不能只写
 *    `planned` 混过去，也不能靠 `blockedReason` 写段理由绕过——理由只解释、不改变
 *    校验）——这是 V3「已授权必须出站」的逐动作版；
 * 9. `ask_requester` 的收据是问话：不得有第三方出站，`done` 时必须给出问题。
 *
 * 刻意没做：完整拓扑环检测。当前只有「依赖存在/不自依赖」两查；发现需要时再加，
 * 保持代码简短。
 */
export function validateActionPlan(
  plan: ActionPlan,
  context: ActionPlanContext
): ActionPlanValidation {
  const violations: ActionPlanViolation[] = [];
  const roster = new Set(context.roster);

  if (!plan.requesterReply.trim()) {
    violations.push({
      code: "empty_requester_reply",
      message: "requesterReply 不能为空：本轮必须有一句回给发信人的话",
    });
  }
  // 空计划不是「没有可拦的」，本身就是违规：光有一句 requesterReply、没有任何动作，
  // 等于用一句回复冒充整轮行动，必须单独拦下。
  if (plan.actions.length === 0) {
    violations.push({
      code: "empty_actions",
      message:
        "actions 不能为空：一个计划至少要有一个动作，不能只有一句 requesterReply",
    });
  }

  // —— 结构：id 唯一、非空；先建 id 集合供依赖检查 ——
  const ids = new Set<string>();
  const statusById = new Map<string, ActionStatus>();
  for (const action of plan.actions) {
    if (!action.id.trim()) {
      violations.push({
        code: "empty_action_id",
        message: "action id 不能为空",
      });
    } else if (ids.has(action.id)) {
      violations.push({
        actionId: action.id,
        code: "duplicate_action_id",
        message: `action id「${action.id}」重复：计划内 id 必须唯一`,
      });
    } else {
      ids.add(action.id);
      statusById.set(action.id, action.status);
    }
    if (!action.purpose.trim()) {
      violations.push({
        actionId: action.id,
        code: "empty_purpose",
        message: `动作「${action.id}」的 purpose 不能为空`,
      });
    }
  }

  const anyThirdPartyOutbound = plan.actions.some(
    (action) => (action.outbound ?? []).length > 0
  );
  // 缺发信人关键事实时**只封该动作和依赖它的动作**，不整轮连坐：先算出这个集合，
  // 再在逐动作循环里分别检查「自身」与「依赖者」。传递依赖用不动点闭包，避免
  // 中间隔一层就漏掉（保持简短，不做完整拓扑/环检测）。
  const blockedByMissingFact = new Set(
    plan.actions
      .filter((action) => action.readiness === "missing_requester_fact")
      .map((action) => action.id)
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const action of plan.actions) {
      if (blockedByMissingFact.has(action.id)) continue;
      if ((action.dependsOn ?? []).some((dep) => blockedByMissingFact.has(dep))) {
        blockedByMissingFact.add(action.id);
        grew = true;
      }
    }
  }
  const questionCount = plan.actions.filter(
    (action) => (action.requesterQuestion ?? "").trim() !== ""
  ).length;

  for (const action of plan.actions) {
    const outbound = action.outbound ?? [];
    const hasOutbound = outbound.length > 0;
    const deps = action.dependsOn ?? [];

    // —— 依赖：存在且不能指向自己 ——
    for (const dep of deps) {
      if (dep === action.id) {
        violations.push({
          actionId: action.id,
          code: "self_dependency",
          message: `动作「${action.id}」不能依赖自己`,
        });
      } else if (!ids.has(dep)) {
        violations.push({
          actionId: action.id,
          code: "unknown_dependency",
          message: `动作「${action.id}」依赖了不存在的动作「${dep}」`,
        });
      }
    }
    const dependencyUnsatisfied = deps.some(
      (dep) => statusById.get(dep) !== "done"
    );

    // —— 收件人：名册内、非发信人、正文非空 ——
    for (const message of outbound) {
      if (!roster.has(message.recipient)) {
        violations.push({
          actionId: action.id,
          code: "recipient_not_in_roster",
          message: `动作「${action.id}」的出站收件人「${message.recipient}」不在名册里（名册：${context.roster.join("、")}）`,
        });
      } else if (message.recipient === context.speaker) {
        violations.push({
          actionId: action.id,
          code: "recipient_is_speaker",
          message: `动作「${action.id}」的出站收件人不能是发信人自己「${message.recipient}」`,
        });
      }
      if (!message.text.trim()) {
        violations.push({
          actionId: action.id,
          code: "outbound_text_empty",
          message: `动作「${action.id}」发给「${message.recipient}」的正文不能为空`,
        });
      }
    }

    // —— 状态与收据一致 ——
    if (action.status === "waiting_reply" && !hasOutbound) {
      violations.push({
        actionId: action.id,
        code: "waiting_reply_without_receipt",
        message: `动作「${action.id}」标为 waiting_reply（已发出等回复）却没有本动作自己的出站收据`,
      });
    }
    if (
      THIRD_PARTY_ACTION_KINDS.includes(action.kind) &&
      action.status === "done" &&
      !hasOutbound
    ) {
      violations.push({
        actionId: action.id,
        code: "done_send_action_without_receipt",
        message: `动作「${action.id}」是 ${action.kind} 且标为 done，必须有本动作自己的出站收据（不能只写 requesterReply 冒充）`,
      });
    }
    if ((action.status === "planned" || action.status === "stopped") && hasOutbound) {
      violations.push({
        actionId: action.id,
        code: "unexpected_receipt",
        message: `动作「${action.id}」状态为 ${action.status}（未执行），不得带出站收据`,
      });
    }

    // —— ask_requester：收据是问话，不是第三方出站 ——
    if (action.kind === "ask_requester") {
      if (hasOutbound) {
        violations.push({
          actionId: action.id,
          code: "ask_requester_forbids_outbound",
          message: `动作「${action.id}」是向发信人问话，不得产生第三方出站`,
        });
      }
      if (
        action.status === "done" &&
        !(action.requesterQuestion ?? "").trim()
      ) {
        violations.push({
          actionId: action.id,
          code: "ask_requester_requires_question",
          message: `动作「${action.id}」标为 done（本轮已问出发信人），必须给出 requesterQuestion`,
        });
      }
    }

    // —— 授权：需确认 / 被拒绝 ——
    if (action.authorization === "needs_confirmation") {
      const acted =
        hasOutbound ||
        action.status === "waiting_reply" ||
        action.status === "done";
      if (acted) {
        violations.push({
          actionId: action.id,
          code: "confirmation_required_but_acted",
          message: `动作「${action.id}」仍需发信人确认（needs_confirmation），确认前不得对第三方执行`,
        });
      }
    }
    if (action.authorization === "denied") {
      if (action.status !== "stopped" || hasOutbound) {
        violations.push({
          actionId: action.id,
          code: "denied_but_acted",
          message: `动作「${action.id}」已被发信人拒绝（denied），只能停止且不得有出站`,
        });
      }
    }

    // —— 能力分区：red 停止；不牵连同计划其它动作 ——
    if (action.capability === "red") {
      if (action.status !== "stopped") {
        violations.push({
          actionId: action.id,
          code: "red_requires_stop",
          message: `动作「${action.id}」能力分区为 red，必须 stopped（当前版本不独立协调这个子问题）`,
        });
      }
      if (hasOutbound) {
        violations.push({
          actionId: action.id,
          code: "red_forbids_outbound",
          message: `动作「${action.id}」能力分区为 red，不得有第三方出站`,
        });
      }
    }

    // —— 依赖未满足不得执行/发布 ——
    if (
      dependencyUnsatisfied &&
      (hasOutbound || action.status === "waiting_reply" || action.status === "done")
    ) {
      violations.push({
        actionId: action.id,
        code: "dependency_not_satisfied",
        message: `动作「${action.id}」依赖的动作尚未完成（依赖：${deps.join("、")}），不得执行/发布`,
      });
    }

    // —— 已授权 + 绿区 + 信息就绪 + 无依赖 → 不能只 planned 混过去 ——
    const ready = (action.readiness ?? "ready") === "ready";
    if (
      action.authorization === "requester_requested" &&
      action.capability === "green" &&
      ready &&
      deps.length === 0 &&
      action.status === "planned" &&
      !hasOutbound
    ) {
      violations.push({
        actionId: action.id,
        code: "actionable_but_not_acted",
        message: `动作「${action.id}」已获发信人请求、绿区、信息就绪且无依赖，不能只标 planned：要么本轮执行，要么用 authorization/readiness/capability/dependsOn 中真实的结构化条件表示为什么不能执行；blockedReason 只解释、不授权绕过`,
      });
    }

    // —— 缺发信人关键事实：只封该动作自身与依赖它的动作（不整轮连坐）——
    // 「执行」= 产生第三方出站，或声称已发出/已完成。问发信人的动作本身是去补这个
    // 缺项，不算「执行」，故豁免；它不得有第三方出站已由 ask_requester 规则单独拦。
    const executed =
      hasOutbound ||
      action.status === "waiting_reply" ||
      action.status === "done";
    if (action.readiness === "missing_requester_fact") {
      if (action.kind !== "ask_requester" && executed) {
        violations.push({
          actionId: action.id,
          code: "missing_requester_fact_executed",
          message: `动作「${action.id}」缺发信人自己的关键事实，不得出站/执行：等这个缺项补齐（通常先问发信人）再动`,
        });
      }
    } else if (blockedByMissingFact.has(action.id) && executed) {
      violations.push({
        actionId: action.id,
        code: "missing_requester_fact_blocks_dependent",
        message: `动作「${action.id}」依赖了缺发信人关键事实的动作，在那个缺项补齐前不得出站/执行`,
      });
    }
  }

  // —— 计划级：一轮只问一个会改变处置的问题 ——
  if (questionCount > 1) {
    violations.push({
      code: "multiple_requester_questions",
      message: `本轮向发信人问了 ${questionCount} 个问题：一轮最多一个必要问题`,
    });
  }
  // —— 计划级：没有任何第三方出站时，回复不得宣称已联系 ——
  if (!anyThirdPartyOutbound && claimsContactAlreadyMade(plan.requesterReply)) {
    violations.push({
      code: "reply_claims_contact_without_receipt",
      message:
        "计划里没有任何第三方出站收据，requesterReply 却宣称已经联系过对方（不能用回复冒充动作收据）",
    });
  }

  return { ok: violations.length === 0, violations };
}
