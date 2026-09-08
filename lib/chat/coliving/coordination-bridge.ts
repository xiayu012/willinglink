/**
 * coliving → coordination 的只读桥接（接入生产第一块，不发真人）。
 *
 * 把 `lib/coordination`（协商状态机）从一次性诊断脚本（`lib/coordination/real-data-db-e2e.ts`）
 * 抽成一个可复用的入口：给定一个 household + 共享窗口，从真实 DB 只读拉该户的
 * 成员与消息流水，按 real-data-db-e2e 已验证的做法派生 case，只回放**厨房相关**的
 * 消息（outbound 只进 `recentDialogue`、inbound 走 `llmParseIntent + step`），返回
 * 终态、最后一版方案和（若最后停在 blocked）排不开的诊断。
 *
 * 安全边界（照搬 real-data-db-e2e）：全程只 SELECT，不写库、不发短信、不 import 带
 * `server-only` 的 repo.ts，只直连 `POSTGRES_URL`（`max: 1`）。不产生任何出站发送。
 *
 * 本文件是后续 shadow / 生产接入的**入口**：出站动作怎么措辞、blocked 诊断怎么变成
 * 协调建议，都归调用方（coliving 大脑 / 发送层）管，本文件只把状态机算好的事实交出去。
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";
import { fold, projectState, reduce, step } from "../../coordination/machine";
import { llmParseIntent } from "../../coordination/llm";
import type {
  Assignment,
  Event,
  Infeasibility,
  PersonId,
  State,
  TimeWindow,
} from "../../coordination/types";

/** runCoordinationOnHousehold 的返回：状态机在这栋房子上重放后的终局。 */
export interface CoordinationHouseholdResult {
  /** 该 household 当前生效成员（valid_to is null）的 display_name，房东在前。 */
  participants: PersonId[];
  /** 重放全部厨房相关消息后的派生状态。 */
  state: State;
  /** 最后一版 schedule_proposed 的 assignments；没排过方案就是 null。 */
  assignments: Assignment[] | null;
  /** 若最后停在 blocked：带上为什么排不开；否则是空数组。 */
  blockedReasons: Infeasibility[];
}

/** 默认傍晚厨房共享窗口：17:00–22:00。产品要改窗口时从这里改/由调用方显式传入。 */
export function kitchenEveningWindow(): TimeWindow {
  return { start: 17 * 60, end: 22 * 60 };
}

/** recentDialogue 最多保留最近多少条真实消息（照搬 real-data-db-e2e）。 */
const RECENT_LIMIT = 6;

/** 写进 recentDialogue 时单条消息先截断到多长（防止无界膨胀）。 */
const RECENT_CLIP = 200;

/**
 * 一条消息行 = 查询带出的原始字段 + 内存里派生的 case 标签。`derived` 对出站消息是它
 * 自己 `communication.case_id`；入站消息没有 communication_id，由「同一 conversation
 * 最近一条出站所属 case」派生（照搬 real-data-db-e2e，不改库）。
 */
interface MsgRow {
  direction: "inbound" | "outbound";
  conversationId: string;
  body: string;
  name: string;
  caseId: string | null;
  /** 派生 case：出站 = 自己的 caseId；入站 = 同一 conversation 最近一条出站的 caseId。 */
  derived: string | null;
}

/**
 * 无 case 消息的正文兜底：正文明显是「傍晚厨房时段协调」的说法才放行——厨房/做饭/
 * 灶台词、报时间（几点 / N点 / 用 N 分钟 / 开始做这类）。带「早上/早晨」标记的无 case
 * 消息属于**另一个时间窗口**（早间厨房）的排班线程：状态机一次只协调一个窗口，把早晨
 * 的时段报到回放进傍晚窗口会拿早晨的时段覆盖傍晚的报到，所以明确排除。
 */
const KITCHEN_TEXT_RE =
  /厨房|做饭|做菜|灶台|几点|[一二三四五六七八九十两\d]\s*点|用.*(分钟|小时)|(开始|要用|就用|想用|去用).*(做饭|做|用)|排.*(时间|时段)/;

const MORNING_KITCHEN_RE = /早上|早晨/;

/** 该消息是否属于「厨房相关」回放集合：有派生 case 就在线程内；否则看正文兜底。 */
function isKitchenRelevant(row: MsgRow): boolean {
  if (row.derived) return true;
  const body = (row.body ?? "").trim();
  if (!body) return false;
  // 早间厨房是另一个窗口：正文带早上/早晨标记的无 case 消息不进傍晚窗口的重放。
  if (MORNING_KITCHEN_RE.test(body)) return false;
  return KITCHEN_TEXT_RE.test(body);
}

/** 按码点截断到约 max 个字，超长补 "…"。 */
function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= max) return text.trim();
  return `${chars.slice(0, max).join("")}…`;
}

function pushRecent(dialogue: string[], line: string): void {
  dialogue.push(line);
  while (dialogue.length > RECENT_LIMIT) dialogue.shift();
}

function mkLine(direction: "inbound" | "outbound", name: string, body: string): string {
  return direction === "outbound" ? `AI→${name}：${clip(body, RECENT_CLIP)}` : `${name}：${clip(body, RECENT_CLIP)}`;
}

/** 从事件日志里取最后一版 schedule_proposed 的 assignments；没有返回 null。 */
function lastProposalAssignments(events: readonly Event[]): Assignment[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "schedule_proposed") return e.assignments;
  }
  return null;
}

/**
 * 只读地把一栋 household 的厨房协商流重放进状态机，返回终局。
 *
 * 流程（照搬 real-data-db-e2e 已验证的步骤）：
 * 1. 查 `coliving.membership`（valid_to is null）的 display_name → participants（房东在前）；
 * 2. 查该 household 全部 `coliving.message`（join conversation/person/communication 拿
 *    case_id），按 sent_at 正序，用「同一 conversation 最近一条出站所属 case」给入站
 *    消息派生 case；
 * 3. 只回放厨房相关消息（见 `isKitchenRelevant`）；outbound 只进 recentDialogue 作消歧
 *    上下文，inbound 走 `llmParseIntent + step` 驱动状态机；机器已定案（settled 是终态）
 *    就不再解析后续消息；
 * 4. 返回 reduce(events)、最后一版方案、以及若最后停在 blocked 的诊断。
 *
 * 全程只读 DB；LLM 只做意图翻译，不生成措辞/方案。
 */
export async function runCoordinationOnHousehold(
  householdId: string,
  window: TimeWindow
): Promise<CoordinationHouseholdResult> {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error("没有 POSTGRES_URL（检查 .env.local）");
  const sql = postgres(url, { max: 1, idle_timeout: 20 });

  try {
    // 1) 成员：此刻住在/关联这栋房子的人（valid_to is null），display_name 作 participants。
    const memberRows = await sql<{ name: string }[]>`
      select p.display_name as name
      from coliving.membership m
      join coliving.person p on p.id = m.person_id
      where m.household_id = ${householdId} and m.valid_to is null
      order by (m.role = 'landlord') desc, p.display_name
    `;
    const participants = memberRows.map((r) => r.name);
    if (participants.length === 0) throw new Error("这栋房子没有生效成员");

    // 2) 全部消息：按 sent_at 正序。direction 区分谁说的：outbound = AI 说（name 是接收者），
    //    inbound = 住户说（name 是说话人）。出站消息把 communication 带出来取精确 case。
    const rawMessages = await sql<{
      direction: "inbound" | "outbound";
      conversationId: string;
      body: string;
      name: string;
      caseId: string | null;
    }[]>`
      select m.direction, m.body, m.sent_at as "sentAt", p.display_name as name,
             m.conversation_id as "conversationId", com.case_id as "caseId"
      from coliving.message m
      join coliving.conversation c on c.id = m.conversation_id
      join coliving.person p on p.id = m.person_id
      left join coliving.communication com on com.id = m.communication_id
      where c.household_id = ${householdId}
      order by m.sent_at asc
    `;

    // 内存里给每条消息派生 case（只读，不改库）：按 conversation 分组、按 sent_at 正序
    // 遍历——出站消息把「当前 case」更新为它自己的 caseId（可能是 null，表示这条出站没挂
    // case，之后的入站也跟着回落成无 case）；入站消息继承「当前 case」。
    const currentCaseByConv = new Map<string, string | null>();
    const rows: MsgRow[] = rawMessages.map((m) => {
      const row: MsgRow = { ...m, derived: null };
      if (row.direction === "outbound") {
        row.derived = row.caseId;
        currentCaseByConv.set(row.conversationId, row.caseId);
      } else {
        row.derived = currentCaseByConv.get(row.conversationId) ?? null;
      }
      return row;
    });

    // 3) 只回放厨房相关消息；入站消息在机器定案前逐条驱动状态机。
    let events: Event[] = [];
    const recentDialogue: string[] = [];
    let blockedReasons: Infeasibility[] = [];

    for (const msg of rows) {
      const body = (msg.body ?? "").trim();
      if (!body) continue;
      if (!isKitchenRelevant(msg)) continue;

      if (msg.direction === "outbound") {
        // AI 说的：只进 recentDialogue 作上下文，不驱动状态机。
        pushRecent(recentDialogue, mkLine("outbound", msg.name, body));
        continue;
      }

      // 住户说的：settled 是终态，之后的消息不会再驱动任何转移，提前退出省模型调用。
      if (fold(events).settled) break;

      const snapshot = projectState(events, {
        participants,
        window,
        sender: msg.name,
        recentDialogue: [...recentDialogue],
      });
      const intent = await llmParseIntent(body, snapshot);
      const res = step(events, intent, { participants, window, sender: msg.name });

      // 跟踪「是否停在 blocked」：这步 blocked → 记下原因；这步排出了新方案 → 覆盖掉。
      for (const a of res.actions) {
        if (a.type === "blocked") blockedReasons = a.reasons;
      }
      if (res.events.some((e) => e.type === "schedule_proposed")) blockedReasons = [];

      events = [...events, ...res.events];
      pushRecent(recentDialogue, mkLine("inbound", msg.name, body));
      if (fold(events).settled) break;
    }

    return {
      participants: [...participants],
      state: reduce(events),
      assignments: lastProposalAssignments(events),
      blockedReasons,
    };
  } finally {
    await sql.end();
  }
}
