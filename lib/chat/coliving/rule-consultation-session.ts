/**
 * 「全屋共同规则协商」的可测试运行路径 —— 把 `lib/coordination/rule-consultation.ts`
 * 的纯状态机接到合租房的一条**具体**规则上：**「每个人洗完澡后清理地漏头发」**。
 *
 * ## 与黑名单那条「单方面叫别人清理地漏头发」是**两件事**
 *
 * - **单方面整改**（黑名单，`blacklist.ts`）：**一个人**交办 AI 去**要求另一位点名的
 *   室友**清理由其洗澡后留在地漏里的头发。它拦的是「替一方去命令另一方」。
 * - **共同规则协商**（本文件）：**一条所有人都要一起确认的共同生活规则**。发起人是
 *   **提案人**，不是投诉者；系统向**每个尚未表态的成员**征询，**全员同意才定案**。
 *
 * 两者语义相反，因此本文件的识别入口要求**同时**出现「共同范围」信号（每个人 / 大家 /
 * 咱们 / 所有人 …）和「立规则」框架（规则 / 规矩 / 约定 / 定一个 …）。单方面点名
 * 要求某人清理地漏头发**没有**共同范围、也没有立规则框架 → 不会被这里识别，仍走原
 * 黑名单路径（见 `lib/chat/coliving/rule-consultation-session.test.ts` 的免费反例）。
 *
 * ## 识别入口刻意很窄（不扩大成「卫生一类」）
 *
 * 这是任务允许的「一个很小的、显式的自然语言识别入口」：只认**这一条**规则——
 * 洗澡 + 地漏 + 头发 + 清走动作落在同一分句，且全局有共同范围 + 立规则信号。它**不**
 * 把「卫生 / 地漏 / 头发」当成一个类别（墙面头发、地漏疏通、一般打扫、异味、抱怨、
 * 征询都不进来），也**不**让普通单方面卫生要求误进来。
 *
 * ## 来源隐私：规则事实是**中性固定语义**，不带发起人原句
 *
 * 识别命中后，规则事实一律收敛为 `SHARED_SHOWER_DRAIN_HAIR_RULE_FACT` 这句中性陈述
 * （「每个人洗完澡后清理地漏里的头发」）；**绝不**把发起人原句片段（可能含姓名、指责、
 * 私人理由，例如「阿川总不清理，所以咱们定个规则…」）当作规则文本写进日志或交给措辞层。
 * 因此「是谁提的、为什么提、在说谁」都不会经这条路径泄露给别的住户。最终短信措辞仍由
 * 语言层自然生成，**不写死完整短信**。
 *
 * ## 身份一律用 `PersonId`（不是显示名）
 *
 * 本文件与状态机的参与者 / 发起人都是**稳定身份 id**（生产里是 `personId`），**不是**
 * display name。显示名只用于给住户看的文案；动作收件人由调用方按 id 精确映射
 * （`resolveRuleActionRecipients`）。这样两位**同名**住户不会被合并，也不会互相串收
 * 征询 / 宣布。
 *
 * ## 状态机只记事实与表态，不写固定话术
 *
 * 本文件**不生成任何住户可见文案**、**不调模型**、**不发送**：它只推进事件日志、把
 * `RuleAction`（发给谁）交出去。住户可见文案由**收窄措辞层**（`rule-consultation-notice.ts`，
 * 只拿中性规则事实）生成，该层**不装载 doctrine**；启用前仍须按 doctrine 走一遍人工阅读 /
 * 语义审稿（见 CLAUDE.md「机械检查证明不了语气」）。事件日志按 household 分文件落本地 JSONL；
 * **不写 coliving 生产库、不连 DB、不 import 任何发送逻辑**。
 *
 * ## 事实与回执分开（收据必须等于真的送达）
 *
 * 「提出 / 表态 / 全员同意」是**事实**，推进时立即落库（`rule_proposed` /
 * `position_recorded` / `rule_settled`）。「向某人征询过 / 向某人宣布过」是**动作成功的
 * 回执**（`consulted` / `announced`），**只能在对应短信（或本人回复）确实落账之后**才追加
 * （`deliverRuleActions` / `recordRuleReceipt`）。因此发送失败**不会**留下假回执、不会被当成
 * 「已问过 / 已宣布」而跳过；失败的人留在待办里，下次问进度（`ask_status`）重新产生同一动作、
 * 可重试。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  foldRule,
  projectRule,
  receiptEventFor,
  reduceRule,
  stepRule,
} from "../../coordination/rule-consultation";
import type {
  RuleAction,
  RuleEvent,
  RuleIntent,
  RuleProjection,
  RuleState,
} from "../../coordination/rule-consultation";
import type { PersonId } from "../../coordination/types";
import {
  recognizeSharedRuleDefinition,
  recognizeSharedShowerDrainHairRule as registryRecognizeSharedShowerDrainHairRule,
  SHARED_SHOWER_DRAIN_HAIR_RULE_FACT,
} from "./shared-rule-definitions";

export type { RuleAction } from "../../coordination/rule-consultation";

// 中性规则事实的**唯一事实源**在 `shared-rule-definitions.ts` 的登记册；本文件**直接
// re-export**（不另写一份），保持旧导入路径兼容，且两处**逐字同一**、不会各写一份而漂移。
export { SHARED_SHOWER_DRAIN_HAIR_RULE_FACT };

/* ------------------------------------------------------------------ *
 * 窄识别：只有这一条「洗完澡后清理地漏头发」的共同规则
 * （判据的唯一事实源在 `shared-rule-definitions.ts`，本文件只做薄适配）
 * ------------------------------------------------------------------ */

/** 识别结果：命中时**只**带回固定的中性规则事实，绝不携带发起人原句。 */
export type SharedRuleRecognition =
  | { ok: true; rule: string }
  | { ok: false };

/**
 * **唯一的窄识别入口（薄适配，不自有识别逻辑）**：这句话是不是「大家立一条『洗完澡后清理
 * 地漏头发』的共同规则」。
 *
 * 判据**不在本文件**：共同范围 / 立规则 / 洗澡 /「地漏 + 头发 + 清走动作同处一分句」这些
 * 正则与纯函数，以及「复述后的否定 / 引用 / 举例 / 设想不算提案、只问看法不算提案」的复核，
 * 全部收敛在**唯一事实源** `shared-rule-definitions.ts` 的登记册里
 * （`recognizeSharedShowerDrainHairRule`）。本函数只是**调用登记册的薄适配**：把登记册的
 * 布尔结果包成旧的 `{ ok, rule }` 形状，**保持导入兼容**，**不再重复实现**任何识别判据。
 *
 * 命中后**只**返回固定的中性事实 `SHARED_SHOWER_DRAIN_HAIR_RULE_FACT`——**不是**发起人
 * 原句片段：即使住户原话里点名了某人、带了指责或私人理由，也不会被当作规则文本外传。
 *
 * 因此**单方面点名要求**（「请叫阿川把地漏的头发清干净」）没有共同范围 / 立规则框架 →
 * 不命中，仍走原黑名单；墙面头发 / 地漏疏通 / 一般打扫 / 异味 / 抱怨 / 征询也都不命中。
 */
export function recognizeSharedShowerDrainHairRule(
  text: string
): SharedRuleRecognition {
  return registryRecognizeSharedShowerDrainHairRule(text)
    ? { ok: true, rule: SHARED_SHOWER_DRAIN_HAIR_RULE_FACT }
    : { ok: false };
}

/* ------------------------------------------------------------------ *
 * 会话已开启时的确定性表态解析（只在已有未定案规则时尝试）
 * ------------------------------------------------------------------ */

/** 明确不同意 / 反对（**必须先于**同意判断——「不同意」里含「同意」）。 */
const DISAGREE_SIGNAL =
  /不同意|不赞成|不认同|不赞同|反对|不接受|不愿意|不乐意|不行|不可以|拒绝|没必要|不必|不用|不要|不想|不干|算了吧/;
/** 明确同意 / 赞成。 */
const AGREE_SIGNAL =
  /同意|赞成|赞同|认同|可以|没问题|没意见|支持|答应|好的|好啊|行|OK|Ok|ok|okay|Okay/;
/** 问进度 / 催结果。 */
const STATUS_SIGNAL =
  /怎么样了|到哪了|定下来了吗|定了吗|定了没|有结果|什么结果|有结论|结论|进展|进度|好了吗|同意了吗|大家怎么说|大家怎么看|都同意了吗/;
/** 只有出现规则相关字眼时，才允许较长的句子被当作表态（避免劫持无关长句）。 */
const RULE_TOPIC_HINT = /规则|地漏|头发|洗澡|这条|这件事|这个规则|共同/;
/** 没有规则字眼时，只把很短的句子当作表态（避免把普通对话劫持成同意）。 */
const SHORT_REPLY_MAX_CHARS = 12;

/**
 * 会话已开启（规则已提出、尚未定案）时，把这句话解析成状态机意图；不是表态 / 问进度
 * 就返回 null（交给普通流程，不劫持无关消息）。
 *
 * 保守策略：不同意优先于同意；既没有规则字眼、又超过很短长度的话不当作表态。
 */
export function parseOpenRuleSessionIntent(text: string): RuleIntent | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (STATUS_SIGNAL.test(t)) return { type: "ask_status" };
  if (DISAGREE_SIGNAL.test(t)) return { type: "state_position", position: "disagree" };
  if (AGREE_SIGNAL.test(t)) {
    if (t.length <= SHORT_REPLY_MAX_CHARS || RULE_TOPIC_HINT.test(t)) {
      return { type: "state_position", position: "agree" };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 按 household 分文件的 append-only JSONL 持久化
 * ------------------------------------------------------------------ */

/** householdId → 文件名里只留安全字符（防路径穿越 / Windows 非法字符）。 */
function safeFileStem(householdId: string): string {
  return householdId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 该户的共同规则事件日志路径。 */
export function ruleSessionEventsFile(dir: string, householdId: string): string {
  return path.join(dir, `${safeFileStem(householdId)}.rule.events.jsonl`);
}

/** 缺省落盘目录名：本地临时目录下的固定子目录（跨调用稳定）。 */
const DEFAULT_RULE_SESSION_DIRNAME = "coliving-rule-consultation-sessions";

/**
 * **解析共同规则事件日志的实际存储目录**（本模块**唯一**的默认目录入口）。
 *
 * - 显式传入**非空** `dir` → **原样返回**（不规范化、不拼接）；
 * - 缺省 / `undefined` / 空串 → 本地临时目录下的固定子目录
 *   （`os.tmpdir()/coliving-rule-consultation-sessions`）。
 *
 * `advanceRuleConsultationSession` / `recordRuleReceipt`（及经它们落盘的
 * `deliverRuleActions`）都**只**经这里取默认目录：调用方（含 `turn.ts`）要指目录就传
 * `opts.dir`，**不要**各自复制临时目录字符串，否则会与状态机读到的事件日志分叉。
 */
export function resolveRuleSessionDir(dir?: string): string {
  if (dir && dir.trim()) return dir;
  return path.join(os.tmpdir(), DEFAULT_RULE_SESSION_DIRNAME);
}

/** 读整个 JSONL（坏行跳过、不存在返回空数组）。 */
function loadRuleEvents(filePath: string): RuleEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const events: RuleEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    events.push(parsed as RuleEvent);
  }
  return events;
}

/** 追加事件（每行一个 JSON，绝不覆盖；空数组不写）。 */
function appendRuleEvents(filePath: string, events: readonly RuleEvent[]): void {
  if (events.length === 0) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, events.map((e) => JSON.stringify(e) + "\n").join(""), "utf8");
}

/* ------------------------------------------------------------------ *
 * 会话推进入口
 * ------------------------------------------------------------------ */

/** `advanceRuleConsultationSession` 的调用方配置。 */
export interface RuleSessionOptions {
  /** 参与这条共同规则的全部成员 display_name（由调用方显式传入；本文件不查 DB）。 */
  participants: readonly PersonId[];
  /** 事件日志落盘目录；缺省走 `resolveRuleSessionDir`（本地临时目录下固定子目录）。 */
  dir?: string;
}

/** 本轮推进的结果（原样交给语言生成 / 投递层去措辞与发送）。 */
export interface RuleSessionAdvance {
  /**
   * 本轮**已经追加进日志的事实事件**：`rule_proposed` / `position_recorded` /
   * `rule_settled`。**不含** `consulted` / `announced`——那两个是送达回执，由投递成功后
   * 的 `deliverRuleActions` / `recordRuleReceipt` 追加（见各函数说明）。
   */
  factEvents: RuleEvent[];
  /** 状态机判定的出站动作（只带「发给谁」）。 */
  actions: RuleAction[];
  /** 推进后的派生状态。 */
  state: RuleState;
  /** 推进后的紧凑投影（**不含发起人身份**）。 */
  projection: RuleProjection;
}

/**
 * 推进该 household 的这条共同规则会话一轮。
 *
 * 返回 `null` 表示**这句话不属于本路径**（还没提出这条规则、或已定案、或开着会话但这句
 * 既不是表态也不是问进度）——调用方应当落回普通对话，**不要**把它当成拒绝。
 *
 * 返回非 null 时：`events` 是本轮追加的事件（已落盘），`actions` 是状态机要发的出站动作，
 * 由调用方措辞 / 投递。本文件**不生成文案、不发送**。
 */
export function advanceRuleConsultationSession(
  householdId: string,
  sender: PersonId,
  text: string,
  opts: RuleSessionOptions
): RuleSessionAdvance | null {
  const dir = resolveRuleSessionDir(opts.dir);
  const eventsFile = ruleSessionEventsFile(dir, householdId);
  const events = loadRuleEvents(eventsFile);
  const snap = foldRule(events);

  let intent: RuleIntent | null;
  if (snap.settled) {
    // 已定案：规则本身不再变，也不再重复向别人宣布。只有住户**问进度**时才仍由本路径
    // 回他一句（零第三方出站）；其它消息交给普通流程、不劫持。定案那轮没发成功的收件人
    // （`announced` 回执缺失）会在问进度时被重新列出补发；全部已送达则无动作（`none`）。
    const parsed = parseOpenRuleSessionIntent(text);
    if (!parsed || parsed.type !== "ask_status") return null;
    intent = parsed;
  } else if (!snap.proposed) {
    // 还没提出这条规则：只有窄识别命中才进入本路径。命中时带上登记册给的稳定
    // `ruleDefinitionId`（与中性事实同源），绝不从已有 snap.rule 文本反推 id。
    const def = recognizeSharedRuleDefinition(text);
    intent = def
      ? { type: "propose_rule", rule: def.canonicalFact, ruleDefinitionId: def.id }
      : null;
  } else {
    // 会话已开启：只有明确表态 / 问进度才进入本路径，其余交给普通流程。
    intent = parseOpenRuleSessionIntent(text);
  }
  if (!intent) return null;

  const result = stepRule(events, intent, {
    participants: opts.participants,
    sender,
  });
  // **只追加事实事件**（rule_proposed / position_recorded / rule_settled）。consulted /
  // announced 是**送达回执**，必须等短信（或本人回复）真的落账后由 `deliverRuleActions` /
  // `recordRuleReceipt` 追加——这里绝不提前写：否则没发出去也会被当成「已问过 / 已宣布」，
  // 永不重试，收据就是假的。
  if (result.events.length > 0) appendRuleEvents(eventsFile, result.events);

  const all = [...events, ...result.events];
  return {
    factEvents: result.events,
    actions: result.actions,
    state: reduceRule(all),
    projection: projectRule(all, { participants: opts.participants, sender }),
  };
}

/**
 * 把**一个出站动作的成功回执**追加进该 household 的事件日志：`consult` → `consulted`、
 * `announce` → `announced`。**只能在对应短信 / 本人回复确实落账之后调用**；还没发或发失败
 * 都不要调——这样失败的人会一直留在待办里，下次问进度可重试。返回追加的事件（`none` 无回执，
 * 返回 null）。
 */
export function recordRuleReceipt(
  householdId: string,
  action: RuleAction,
  opts: RuleSessionOptions
): RuleEvent | null {
  const event = receiptEventFor(action);
  if (!event) return null;
  const dir = resolveRuleSessionDir(opts.dir);
  appendRuleEvents(ruleSessionEventsFile(dir, householdId), [event]);
  return event;
}

/**
 * 逐条投递状态机动作：对每个动作调用注入的 `send`；**只有 `send` 兑现（真的发出去了）才
 * 追加对应回执事件**，抛错则记为失败、**不写回执**（可重试）。返回分组供调用方观测。
 *
 * `send` 由调用方注入（生产 = 措辞 + `deliverSms`；测试可注入会失败的假发送方）——因此
 * 「回执 = 送达成功」这条不变量可在免费单测里用**失败注入**证明：send 失败时日志里不会出现
 * `consulted` / `announced`。
 */
export async function deliverRuleActions(
  householdId: string,
  actions: readonly RuleAction[],
  send: (action: Exclude<RuleAction, { type: "none" }>) => Promise<void>,
  opts: RuleSessionOptions
): Promise<{ delivered: RuleAction[]; failed: RuleAction[] }> {
  const delivered: RuleAction[] = [];
  const failed: RuleAction[] = [];
  for (const action of actions) {
    if (action.type === "none") continue;
    try {
      await send(action);
      recordRuleReceipt(householdId, action, opts);
      delivered.push(action);
    } catch {
      failed.push(action); // 失败：不写回执 → 该人保持待办，可重试
    }
  }
  return { delivered, failed };
}

/** 收件人解析所需的最小名册形状：稳定 id + 显示名（显示名只用于文案）。 */
export interface RuleRosterMember {
  personId: PersonId;
  name: string;
}

/**
 * 把状态机的出站动作解析成**具体收件人**：**按 `personId` 精确匹配**名册——
 * **不是**按显示名。这是「身份一律用 id」的落点：两位**同名**住户各有各的 id，因此
 * 会分别解析到各自的成员对象、分别收短信，不会被合并或互相串收。`none` 与名册里
 * 找不到 id 的动作跳过。显示名只随 `member` 一起交给文案层用，不参与匹配。
 */
export function resolveRuleActionRecipients<M extends RuleRosterMember>(
  actions: readonly RuleAction[],
  members: readonly M[]
): Array<{ action: Exclude<RuleAction, { type: "none" }>; member: M }> {
  const byId = new Map<PersonId, M>(members.map((m) => [m.personId, m]));
  const out: Array<{ action: Exclude<RuleAction, { type: "none" }>; member: M }> = [];
  for (const action of actions) {
    if (action.type === "none") continue;
    const member = byId.get(action.person);
    if (member) out.push({ action, member });
  }
  return out;
}
