/**
 * 共同规则协商状态机（Shared-Rule Consultation State Machine）——确定性核心。
 *
 * 与 `machine.ts`（厨房排班的**时间**协商）**并列、互不影响**：这里不 import 排班
 * 任何东西（连 `./machine` 都不 import），只借 `./types` 的 `PersonId` 类型。它处理
 * 的是**另一类**协商——一条**全屋共同规则**是不是被全员接受：
 *
 *     提出同一条规则 → 向尚未表态的人征询 → 记录同意 / 不同意 →
 *     全员同意才定案 → 向全员宣布
 *
 * ## 它**不**做什么（边界就是它的价值）
 *
 * - **不判断规则内容是否合理**：住户提什么规则就记什么规则，代码不评价「该不该」；
 * - **不替住户编造规则**：规则文本只能来自发起人这条消息里的事实，本模块不生成文案；
 * - **不做任何现场判断**（严重程度 / 谁对谁错 / 该不该整改），也因此跟黑名单里那条
 *   「单方面叫别人清理地漏头发」是**两件事**：那条是**一个人交办 AI 去要求另一个人**，
 *   本模块是**一条所有人都要一起确认的共同规则**——发起人不是「投诉者」，是提案人。
 *
 * ## 事件溯源与不变量（代码强制，不靠 LLM 自觉）
 *
 * 不「改状态」，只**追加事件**；当前状态由 `foldRule` 重放事件日志推导。硬不变量：
 *
 * 1. **没有所有成员同意，绝不 `rule_settled`**：`stepRule` 只在 `allAgree` 时才追加
 *    `rule_settled`；`checkRuleInvariants` 独立复核「定案时每个已知参与人都已同意」。
 * 2. **同意过的人不重复征询**：发起人提出即视为同意（`rule_proposed` 记他 agree，靠表态
 *    即可排除，不必假记征询）；`consulted` 只是**送达回执**，对同一人至多出现一次。
 * 3. **有人不同意就绝不定案**：只要有一人 `disagree`，`allAgree` 恒假，`rule_settled`
 *    不会被追加（`ruleStateFromSnap` 投影成 `objected`）。
 * 4. **不泄露发起人**：`initiator` 只留在内部 `RuleSnap` 供审计；`projectRule` 的投影
 *    里**没有** `initiator` 字段，`RuleAction` 只带「发给谁」，不带任何来源情境。
 * 5. **定案是终态**：`rule_settled` 之后的消息不再驱动任何转移，也不会重复宣布。
 *
 * 纯函数、无副作用、不落库、不读环境变量；持久化与 NL 识别在 coliving 那侧另接
 * （`lib/chat/coliving/rule-consultation-session.ts`）。
 */

import type { PersonId } from "./types";

/** 某位成员对「这条共同规则」的表态。 */
export type RulePosition = "agree" | "disagree";

/**
 * 派生状态（不落库，由事件日志重放算出来）：
 * - `none` —— 还没有人提出过这条规则。
 * - `proposed` —— 已提出，正在等尚未表态的人（全场没有反对）。
 * - `objected` —— 已有人明确不同意：这条原规则不会被定案。
 * - `settled` —— 全员同意，已定案（终态）。
 */
export type RuleState = "none" | "proposed" | "objected" | "settled";

/**
 * 事件（只追加、不可变）。
 *
 * - `rule_proposed` —— 某人提出这条共同规则。`rule` 是**发起人消息里导出的事实文本**，
 *   本模块不改写它。`initiator` **只供内部审计，绝不投影 / 出站**（来源隐私）。
 * - `consulted` —— **送达回执**：向某人的征询短信真的发出去过（「同意过的人不重复征询」的
 *   去重依据）。**只在送达成功后追加**，失败不记、可重试。
 * - `position_recorded` —— 某人明确表态同意 / 不同意。
 * - `rule_settled` —— 全员同意，定案。
 * - `announced` —— **送达回执**：定案通知真的发给过某人（「不重复宣布」的去重依据）。
 *   同样只在送达成功后追加。
 */
export type RuleEvent =
  | { type: "rule_proposed"; rule: string; initiator: PersonId }
  | { type: "consulted"; person: PersonId }
  | { type: "position_recorded"; person: PersonId; position: RulePosition }
  | { type: "rule_settled" }
  | { type: "announced"; person: PersonId };

/**
 * 意图（薄意图层 → 状态机）：真正解析由调用方（coliving 侧的显式小解析入口）完成，
 * 本模块只按结构化意图走转移。
 */
export type RuleIntent =
  | { type: "propose_rule"; rule: string }
  | { type: "state_position"; position: RulePosition }
  | { type: "ask_status" }
  | { type: "other" };

/**
 * 出站动作：状态机判定「下一步该对谁说什么」的结果，由调用方（语言生成 / 短信层）
 * 真正措辞并发出。**只带「发给谁」，不带规则文本、不带任何来源情境**——措辞归语言层，
 * 状态机不写固定话术（见 CLAUDE.md「不要替大脑写话术」）。
 *
 * - `consult` —— 请这个人对这条共同规则表态。
 * - `announce` —— 告诉这个人：这条规则已全员同意、定案生效。
 * - `none` —— 这轮没有要发的消息。
 */
export type RuleAction =
  | { type: "consult"; person: PersonId }
  | { type: "announce"; person: PersonId }
  | { type: "none" };

/**
 * 重放事件日志得到的派生快照。**`initiator` 只在这里**——它不进 `RuleProjection`、
 * 不进任何 `RuleAction`，所以调用方拿不到「是谁发起的」。
 */
export interface RuleSnap {
  /** 日志里出现过 `rule_proposed`。 */
  proposed: boolean;
  /** 发起人提出的规则事实文本；没提出就是 null。 */
  rule: string | null;
  /** 发起人身份：**内部审计用，绝不外传**（来源隐私）。 */
  initiator: PersonId | null;
  /** 每人的表态（首次表态后不再改）。 */
  positions: Map<PersonId, RulePosition>;
  /** 已成功送达征询的人（**送达回执**，去重依据；失败不记）。 */
  consulted: Set<PersonId>;
  /** 已成功送达定案通知的人（**送达回执**，去重依据；失败不记）。 */
  announced: Set<PersonId>;
  /** 是否已追加过 `rule_settled`（终态）。 */
  settled: boolean;
  /** 事件里出现过的人、按首次出现顺序排列（`projectRule` 缺省参与者名单的兜底）。 */
  order: PersonId[];
}

/** 还没有任何事件的初始快照。 */
export function emptyRuleSnap(): RuleSnap {
  return {
    proposed: false,
    rule: null,
    initiator: null,
    positions: new Map(),
    consulted: new Set(),
    announced: new Set(),
    settled: false,
    order: [],
  };
}

/* ------------------------------------------------------------------ *
 * foldRule：事件日志 → 派生快照
 * ------------------------------------------------------------------ */

/**
 * 从头重放一整段事件日志，推导派生快照。纯函数，不原地改入参。
 *
 * `rule_proposed` 只在**第一次**出现时生效（同一条规则只有一个生命周期）；此后重复的
 * `rule_proposed` 被忽略（不会重复清零表态）。发起人在提出时即视为同意、并记入已征询
 * ——他不是「被征询对象」，也证明「同意过的人不重复征询」。
 */
export function foldRule(events: readonly RuleEvent[]): RuleSnap {
  const snap = emptyRuleSnap();
  const seen = new Set<PersonId>();
  const visit = (p: PersonId): void => {
    if (p && !seen.has(p)) {
      seen.add(p);
      snap.order.push(p);
    }
  };

  for (const e of events) {
    switch (e.type) {
      case "rule_proposed": {
        if (snap.proposed) break; // 同一条规则只认第一次提出
        snap.proposed = true;
        snap.rule = e.rule;
        snap.initiator = e.initiator;
        visit(e.initiator);
        snap.positions.set(e.initiator, "agree");
        // **不**把发起人记进 `consulted`：`consulted` 现在只表示「真的发出过征询」的
        // 回执（见 `receiptEventFor`）。发起人提出即视为同意（已有表态），本来就不该被
        // 征询，靠 `positions` 就能排除，不需要假记一条征询回执。
        break;
      }
      case "consulted": {
        visit(e.person);
        snap.consulted.add(e.person);
        break;
      }
      case "position_recorded": {
        visit(e.person);
        snap.positions.set(e.person, e.position);
        break;
      }
      case "rule_settled": {
        snap.settled = true;
        break;
      }
      case "announced": {
        visit(e.person);
        snap.announced.add(e.person);
        break;
      }
    }
  }

  return snap;
}

/**
 * 从派生快照出状态（`reduce` 的映射核心）：
 * - 没提出过 → `none`；
 * - 已定案 → `settled`（终态）；
 * - 有人明确不同意 → `objected`（原规则不会被强行定案）；
 * - 否则 → `proposed`。
 */
export function ruleStateFromSnap(s: RuleSnap): RuleState {
  if (!s.proposed) return "none";
  if (s.settled) return "settled";
  for (const pos of s.positions.values()) {
    if (pos === "disagree") return "objected";
  }
  return "proposed";
}

/** 事件日志 → 状态（薄封装）。 */
export function reduceRule(events: readonly RuleEvent[]): RuleState {
  return ruleStateFromSnap(foldRule(events));
}

/**
 * `projectRule` 的输出：把事件日志重放成**当前事实的紧凑投影**，给上层（语言生成 /
 * 路由 / 测试）当单一事实来源。
 *
 * **这里没有 `initiator`**：投影只回答「规则是什么、谁同意、谁还没表态、定没定案」，
 * 不回答「是谁发起的」——来源隐私由类型本身保证，调用方拿不到这个字段。
 */
export interface RuleProjection {
  state: RuleState;
  settled: boolean;
  /** 发起人提出的规则事实文本；没提出就是 null。 */
  rule: string | null;
  /** 参与全员（`ctx.participants`；缺省为事件里出现过的人）。 */
  participants: PersonId[];
  /** 当前说话人；不知道为 null。 */
  sender: PersonId | null;
  /** 已明确同意的成员。 */
  agreed: PersonId[];
  /** 已明确不同意的成员。 */
  disagreed: PersonId[];
  /** 还没表态的成员（含已被征询、还在等的）。 */
  waiting: PersonId[];
  /** 已被征询、还没表态的成员。 */
  awaitingReply: PersonId[];
  /** 还没表态、也还没被征询的成员。 */
  notYetAsked: PersonId[];
  /** 已收到定案通知的成员。 */
  announced: PersonId[];
  /** 已被征询过的成员。 */
  consulted: PersonId[];
}

/** `projectRule` 的可选运行时上下文。 */
export interface RuleProjectionContext {
  /** 参与全员（事件日志只记开过口的人，沉默成员要靠这里补）。 */
  participants?: readonly PersonId[];
  /** 正在发当前这条消息的人。 */
  sender?: PersonId;
}

/**
 * 把派生快照（或事件日志）投影成紧凑的 `RuleProjection`。纯函数、无副作用。
 * 参与者顺序按 `ctx.participants`；缺省退化为事件里首次出现的顺序。
 */
export function projectRuleFromSnap(
  s: RuleSnap,
  ctx: RuleProjectionContext = {}
): RuleProjection {
  const participants = ctx.participants ? [...ctx.participants] : [...s.order];

  const agreed: PersonId[] = [];
  const disagreed: PersonId[] = [];
  const waiting: PersonId[] = [];
  const awaitingReply: PersonId[] = [];
  const notYetAsked: PersonId[] = [];
  for (const p of participants) {
    const pos = s.positions.get(p);
    if (pos === "agree") agreed.push(p);
    else if (pos === "disagree") disagreed.push(p);
    else {
      waiting.push(p);
      if (s.consulted.has(p)) awaitingReply.push(p);
      else notYetAsked.push(p);
    }
  }

  return {
    state: ruleStateFromSnap(s),
    settled: s.settled,
    rule: s.rule,
    participants,
    sender: ctx.sender ?? null,
    agreed,
    disagreed,
    waiting,
    awaitingReply,
    notYetAsked,
    announced: participants.filter((p) => s.announced.has(p)),
    consulted: participants.filter((p) => s.consulted.has(p)),
  };
}

/** 事件日志 → `RuleProjection`（薄封装）。 */
export function projectRule(
  events: readonly RuleEvent[],
  ctx: RuleProjectionContext = {}
): RuleProjection {
  return projectRuleFromSnap(foldRule(events), ctx);
}

/* ------------------------------------------------------------------ *
 * stepRule：给定 历史事件 + Intent + 运行时上下文 → 追加事件 + 出站动作
 * ------------------------------------------------------------------ */

/** step 需要的运行时上下文：参与全员 + 当前这条消息是谁发的。 */
export interface RuleStepContext {
  /** 参与这条共同规则的全部成员。全员同意才定案，指的就是这个集合。 */
  participants: readonly PersonId[];
  /** 正在处理这条消息的人。 */
  sender: PersonId;
}

/** step 的产物：追加进日志的事件 + 要发出的出站动作。 */
export interface RuleStepResult {
  events: RuleEvent[];
  actions: RuleAction[];
}

function noopRule(): RuleStepResult {
  return { events: [], actions: [{ type: "none" }] };
}

/** 全员都明确同意（空集合不算）。 */
function allAgree(s: RuleSnap, participants: readonly PersonId[]): boolean {
  if (participants.length === 0) return false;
  return participants.every((p) => s.positions.get(p) === "agree");
}

/**
 * 出站动作 → 对应的**成功回执事件**：`consult` 成功后记 `consulted`，`announce` 成功后记
 * `announced`。调用方**必须**在对应的短信（或本人回复）**确实落账之后**才追加这个事件——
 * 还没发、或发失败，都**不许**先记，否则「已征询 / 已宣布」的日志就是假的，而且下次不会
 * 重试（收据必须等于「真的送达过的那些」）。`none` 没有回执，返回 null。
 */
export function receiptEventFor(action: RuleAction): RuleEvent | null {
  if (action.type === "consult") return { type: "consulted", person: action.person };
  if (action.type === "announce") return { type: "announced", person: action.person };
  return null;
}

/**
 * 「还没收到宣布」的参与者 → `announce` 动作。**只在已定案之后用**：定案（`rule_settled`）
 * 是一次性事实，但「谁已经收到宣布」要等短信真的发出去（`announced` 回执）才算数。因此定案
 * 那一轮没送达的收件人，之后问进度时会在这里被重新列出、补发；已经收到的不再重复。
 */
function pendingAnnounce(
  events: readonly RuleEvent[],
  participants: readonly PersonId[]
): RuleAction[] {
  const s = foldRule(events);
  return participants
    .filter((p) => !s.announced.has(p))
    .map((p): RuleAction => ({ type: "announce", person: p }));
}

/**
 * 纯函数：给定历史事件日志 + 这条消息的 `RuleIntent`（+ 谁发的、有哪些人），产出
 * 「要追加进日志的**事实**事件」与「要发出的出站动作」。不落库、不读环境变量、不改入参。
 *
 * **只有「事实」随 `events` 返回**：
 * - `propose_rule` → `rule_proposed`（事实：某人提出了这条规则；发起人即视为同意）；
 * - 表态 → `position_recorded`（事实：某人明确表态）；
 * - 最后一位同意 → 另加 `rule_settled`（事实：全员已同意，规则定案）。
 *
 * **`consulted` / `announced` 不是事实，是「动作成功」的回执**，因此**绝不由本函数产出**：
 * 它们只能由调用方在对应短信（或本人回复）**真的发出去之后**用 `receiptEventFor` 追加
 * （见 `lib/chat/coliving/rule-consultation-session.ts` 的 `deliverRuleActions`）。没发成功
 * 就不记——下一次问进度会重新产生同一个 `consult` / `announce` 动作，因此**可以重试**。
 *
 * 转移表：
 * - `propose_rule`：首次提出 → `rule_proposed`（事实），并向尚未表态的其他人发 `consult`；
 *   已经提出过同一条 → 当作**该住户明确同意**（另一位成员用自己的话说同一条，或发起人
 *   重复提出）。
 * - `state_position`：记 `position_recorded`（事实）；全员同意 → 另加 `rule_settled`（事实）
 *   + 向尚未收到宣布的人发 `announce`；有人不同意 → 只记表态，**绝不定案**。
 * - `ask_status`：定案前，对「还没表态、也还没被征询」的人补 `consult`；**定案后**，只对
 *   「还没收到宣布」的人补 `announce`（定案那轮没送达的会在这里补发；都已送达则无动作）。
 * - `other`：无状态转移。
 *
 * 非参与人的消息一律 `none`。
 */
export function stepRule(
  events: readonly RuleEvent[],
  intent: RuleIntent,
  ctx: RuleStepContext
): RuleStepResult {
  const base = foldRule(events);
  if (!ctx.participants.includes(ctx.sender)) return noopRule();

  switch (intent.type) {
    case "other":
      return noopRule();
    case "ask_status":
      // 定案后也能走这里：给还没收到宣布的人补发 announce。
      return stepRuleAskStatus(events, base, ctx);
    case "state_position":
      if (base.settled) return noopRule(); // 定案后不再接受新表态
      return stepRulePosition(events, base, ctx, intent.position);
    case "propose_rule": {
      if (base.settled) return noopRule();
      if (base.proposed) {
        // 同一条规则已经提出过：这次发声当作**该住户明确同意**（发起人重复提出、
        // 或另一位成员自己又提了一遍同一条，都在表达「我赞成这条规则」）。
        return stepRulePosition(events, base, ctx, "agree");
      }
      const rule = intent.rule.trim();
      if (!rule) return noopRule();
      const facts: RuleEvent[] = [{ type: "rule_proposed", rule, initiator: ctx.sender }];
      const afterPropose = foldRule([...events, ...facts]);
      if (allAgree(afterPropose, ctx.participants)) {
        // 只有发起人一人（单成员房子）：提出即全员同意。
        facts.push({ type: "rule_settled" });
        const all = [...events, ...facts];
        return { events: facts, actions: pendingAnnounce(all, ctx.participants) };
      }
      const actions = ctx.participants
        .filter((p) => !afterPropose.positions.has(p) && !afterPropose.consulted.has(p))
        .map((p): RuleAction => ({ type: "consult", person: p }));
      return { events: facts, actions: actions.length ? actions : [{ type: "none" }] };
    }
  }
}

/** 记录一次表态（事实）；全员同意 → 另加 `rule_settled` 事实 + 向未收到宣布者发 announce。 */
function stepRulePosition(
  events: readonly RuleEvent[],
  base: RuleSnap,
  ctx: RuleStepContext,
  position: RulePosition
): RuleStepResult {
  if (!base.proposed) return noopRule();
  if (base.settled) return noopRule();
  if (base.positions.has(ctx.sender)) return noopRule(); // 已表过态：首次表态为准，不重复记
  const facts: RuleEvent[] = [{ type: "position_recorded", person: ctx.sender, position }];
  const after = foldRule([...events, ...facts]);
  if (position === "agree" && allAgree(after, ctx.participants)) {
    facts.push({ type: "rule_settled" });
    const all = [...events, ...facts];
    return { events: facts, actions: pendingAnnounce(all, ctx.participants) };
  }
  return { events: facts, actions: [{ type: "none" }] };
}

/**
 * 定案前补 `consult`、定案后补 `announce`——都只针对**还没成功送达**的人。
 * 因为 `consulted` / `announced` 只在送达成功后才记，失败的人会一直留在待办里，可重试。
 */
function stepRuleAskStatus(
  events: readonly RuleEvent[],
  base: RuleSnap,
  ctx: RuleStepContext
): RuleStepResult {
  if (base.settled) {
    const actions = pendingAnnounce(events, ctx.participants);
    return actions.length ? { events: [], actions } : noopRule();
  }
  if (!base.proposed) return noopRule();
  const pending = ctx.participants.filter(
    (p) => !base.positions.has(p) && !base.consulted.has(p)
  );
  if (pending.length === 0) return noopRule();
  return {
    events: [],
    actions: pending.map((p): RuleAction => ({ type: "consult", person: p })),
  };
}

/* ------------------------------------------------------------------ *
 * checkRuleInvariants：校验一份事件日志有没有违反硬约束
 * ------------------------------------------------------------------ */

/**
 * 校验事件日志的不变量，返回违规描述列表（空数组 = 通过）。机器自己产出的日志应该总是
 * 通过；这份检查用来挡手工构造 / 未来接入时不慎写坏的日志。
 *
 * 检查项（对应任务要求的确定性保证）：
 * 1. `rule_settled` 出现时，日志里已知的每个参与人都必须已经明确 `agree`——
 *    **没有所有成员同意，绝不能说规则已经生效**。
 * 2. 有人 `disagree` 之后仍出现 `rule_settled`，同样算违反（含在第 1 条里）。
 * 3. **同意过的人不被重复征询**：对已表过态的人再发 `consulted` 即违规；同一人
 *    重复 `consulted` 也违规。
 * 4. **定案是终态**：`rule_settled` 之后不得再有表态 / 征询 / 提出。
 * 5. **宣布有据**：`announced` 只能出现在 `rule_settled` 之后，且对同一人不重复。
 * 6. `rule_proposed` 最多出现一次。
 */
export function checkRuleInvariants(events: readonly RuleEvent[]): string[] {
  const violations: string[] = [];

  let proposedCount = 0;
  for (const e of events) {
    if (e.type !== "rule_proposed") continue;
    proposedCount += 1;
    if (proposedCount > 1) {
      violations.push("同一条规则被重复提出：rule_proposed 只能出现一次");
    }
  }

  // 1/2) 定案必须全员同意（对每个 rule_settled 看它出现时的已知参与人）。
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== "rule_settled") continue;
    const s = foldRule(events.slice(0, i + 1));
    if (s.order.length === 0) {
      violations.push("rule_settled 出现在没有任何参与人的日志里");
      continue;
    }
    for (const p of s.order) {
      const pos = s.positions.get(p);
      if (pos !== "agree") {
        violations.push(
          `rule_settled 时 ${p} 还没有明确同意（当前=${pos ?? "未表态"}）`
        );
      }
    }
  }

  // 3) 已表态者不被重复征询；4) 定案后不得再有转移；5) 宣布有据且不重复。
  let settledSeen = false;
  const consultedSeen = new Set<PersonId>();
  const announcedSeen = new Set<PersonId>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === "rule_settled") settledSeen = true;

    if (e.type === "consulted") {
      if (settledSeen) violations.push(`定案之后仍在征询：${e.person}`);
      const before = foldRule(events.slice(0, i));
      if (before.positions.has(e.person)) {
        violations.push(`向已经表过态的 ${e.person} 重复征询`);
      }
      if (consultedSeen.has(e.person)) {
        violations.push(`向 ${e.person} 重复征询`);
      }
      consultedSeen.add(e.person);
    }

    if (e.type === "position_recorded" && settledSeen) {
      violations.push(`定案之后仍有表态事件：${e.person}`);
    }

    if (e.type === "announced") {
      if (!settledSeen) violations.push(`尚未定案就宣布：${e.person}`);
      if (announcedSeen.has(e.person)) violations.push(`向 ${e.person} 重复宣布`);
      announcedSeen.add(e.person);
    }
  }

  return violations;
}
