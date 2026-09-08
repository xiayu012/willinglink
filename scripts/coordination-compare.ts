/**
 * 离线对照命令：证明「协商状态机方案」与「真实定案 rule」一致（shadow/生产接入前
 * 的最后一步离线实证）。
 *
 * 做法（只跑一次、少调模型）：
 * - 只读直连 `POSTGRES_URL`；
 * - 对老孙那户的傍晚厨房 case（47941422）调 `runCoordinationOnCase`（只回放派生
 *   case == 该 case 的消息，出站入站都算；case 内入站走 LLM 意图解析驱动状态机）；
 * - 查该户真实 `coliving.rule`（kind='kitchen_schedule'）拿「真实定案」文本；
 * - 打印状态机终态、最后一版方案（按 person 列 start-end）、真实定案文本，
 *   并给出老孙/小五/老四三个关键档是否一致的结论。
 *
 * 安全边界：全程只 SELECT；不写库、不发短信、不 import 带 `server-only` 的 repo.ts。
 * 运行：pnpm.cmd exec tsx scripts/coordination-compare.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";
import { kitchenEveningWindow, runCoordinationOnCase } from "../lib/chat/coliving/coordination-bridge";
import type { TimeSlot } from "../lib/coordination/types";

const HOUSEHOLD_ID = "bb3556fa-5599-43fe-9c84-563d0e0470cd";
const CASE_ID = "47941422-331b-447f-be77-449a32cacbc5";

/** 期望复现的真实定案三档（照 real-case-regression.test.ts 的 golden / CODEX_TASK）。 */
const EXPECTED: Readonly<Record<string, TimeSlot>> = {
  老孙: { start: 17 * 60 + 30, end: 18 * 60 }, // 17:30-18:00
  小五: { start: 18 * 60, end: 18 * 60 + 30 }, // 18:00-18:30
  老四: { start: 18 * 60 + 30, end: 20 * 60 + 30 }, // 18:30-20:30
};

function fmtMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function fmtSlot(slot: TimeSlot): string {
  return `${fmtMinute(slot.start)}-${fmtMinute(slot.end)}`;
}

function toMinute(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => Number.parseInt(x, 10));
  return h * 60 + m;
}

/** 从 rule statement 里抽 (人 / 档位) 列表：够用即可，只认「名字 + HH:MM-HH:MM」。 */
interface RuleToken {
  label: string;
  slot: TimeSlot;
}

function parseStatementTokens(text: string): RuleToken[] {
  const tokens: RuleToken[] = [];
  const rangeRe = /(\d{1,2}:\d{2})\s*[-–—~至]\s*(\d{1,2}:\d{2})/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = rangeRe.exec(text)) !== null) {
    // 每段时间档前面的字符，最后一个「非分隔片段」就是人名标签。
    const between = text.slice(lastIndex, m.index);
    const segs = between
      .split(/[，。、；;：:\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const label = segs.length > 0 ? segs[segs.length - 1] : `档${tokens.length + 1}`;
    tokens.push({ label, slot: { start: toMinute(m[1]), end: toMinute(m[2]) } });
    lastIndex = rangeRe.lastIndex;
  }
  return tokens;
}

function slotKey(slot: TimeSlot): string {
  return `${slot.start}:${slot.end}`;
}

async function main() {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error("没有 POSTGRES_URL（检查 .env.local）");
  const sql = postgres(url, { max: 1, idle_timeout: 20 });

  try {
    // 1) 真实定案 rule：列出该户全部 kitchen_schedule，供人核对取了哪条。
    const rules = await sql<{
      status: string;
      statement: string;
      validFrom: Date;
    }[]>`
      select r.status, r.statement, r.valid_from as "validFrom"
      from coliving.rule r
      where r.household_id = ${HOUSEHOLD_ID} and r.kind = 'kitchen_schedule'
      order by r.valid_from desc
    `;

    console.log(`household ${HOUSEHOLD_ID} 的 kitchen_schedule rule（按 valid_from 倒序）：`);
    rules.forEach((r, i) => {
      const mark = i === 0 ? " ← 最新一条" : "";
      console.log(`  [${i}] ${r.status}  valid_from=${r.validFrom.toISOString()}${mark}\n      ${r.statement}`);
    });

    // 对照目标取「最新一条『傍晚』厨房 rule」：本 case（47941422）是傍晚厨房高峰，
    // 而该户当前最新一条 kitchen_schedule 可能被另一时间窗（早间厨房）的 rule 占用；
    // 拿早晨的 rule 对照傍晚的 case 没有意义，所以这里在清单里挑最新傍晚那条，并提示。
    const evening = rules.find((r) => /傍晚/.test(r.statement));
    const ground = evening ?? rules[0];
    if (!ground) throw new Error("这栋房子没有任何 kitchen_schedule rule");
    if (evening && rules[0] !== evening) {
      console.log(`\n注意：字面上最新的 kitchen_schedule 是「${rules[0].statement.slice(0, 12)}…」` +
        `（另一个窗口的 rule）；对照目标取最新的「傍晚」rule。`);
    }
    console.log(`\n真实定案文本（对照目标）：\n  ${ground.statement}`);

    // 2) 跑状态机：只回放 case 47941422 的消息。
    const result = await runCoordinationOnCase(HOUSEHOLD_ID, CASE_ID, kitchenEveningWindow());

    console.log(`\n状态机重放 case ${CASE_ID} 后的终态：${result.state}` +
      `（participants=[${result.participants.join(",")}]）`);
    if (result.blockedReasons.length > 0) {
      console.log(`  停在 blocked，原因：`);
      for (const r of result.blockedReasons) console.log(`    - [${r.kind}]${r.person ? ` ${r.person}：` : " "}${r.message}`);
    }

    console.log("状态机最后一版方案（按 person）：");
    const machine = new Map<string, TimeSlot>();
    if (result.assignments && result.assignments.length > 0) {
      for (const a of result.assignments) {
        machine.set(a.person, a.slot);
        console.log(`  ${a.person}  ${fmtSlot(a.slot)}  (${a.slot.end - a.slot.start} 分钟)`);
      }
    } else {
      console.log("  （没有排过任何方案）");
    }

    // 3) 三档比对：老孙/小五/老四，逐个对照真实定案里的同一档。
    const realTokens = parseStatementTokens(ground.statement);
    console.log("\n真实定案里解析出的档位：");
    for (const t of realTokens) console.log(`  ${t.label}  ${fmtSlot(t.slot)}  (${t.slot.end - t.slot.start} 分钟)`);

    // 真实文本里的房东标签「老孙」直接对应人；两位租客在 statement 里可能写作
    // 「2号住客/3号住客」这类旧名——所以租客按「档位时间」对齐：期望某人的档位 =
    // statement 里与状态机同一时间段的那一档。输出里会打印出这个对应。
    const realByTime = new Map<string, RuleToken>();
    for (const t of realTokens) realByTime.set(slotKey(t.slot), t);

    const checks: { person: string; ok: boolean; detail: string }[] = [];
    const slotSetOf = (xs: Iterable<TimeSlot>) => new Set([...xs].map(slotKey));

    const machineSlots = [...machine.values()];
    const realSlots = realTokens.map((t) => t.slot);
    const mset = slotSetOf(machineSlots);
    const rset = slotSetOf(realSlots);
    const slotsAgree = mset.size === rset.size && [...mset].every((k) => rset.has(k));

    for (const person of ["老孙", "小五", "老四"] as const) {
      const expected = EXPECTED[person];
      const got = machine.get(person);
      const timeOk = got !== undefined && got.start === expected.start && got.end === expected.end;
      const match = slotsAgree ? realByTime.get(slotKey(got ?? { start: -1, end: -1 })) : undefined;
      const realOk = match !== undefined && match.slot.start === expected.start && match.slot.end === expected.end;
      const ok = timeOk && realOk;
      const realText = match ? `${match.label} ${fmtSlot(match.slot)}` : "(真实档位里没有同一时间段)";
      checks.push({
        person,
        ok,
        detail: `状态机=${got ? fmtSlot(got) : "无"}，期望=${fmtSlot(expected)}，真实定案对应=${realText}`,
      });
    }

    // 老四 120 分钟全程不被覆盖：状态机里老四的档必须正好跨 120 分钟。
    const laosi = machine.get("老四");
    const laosi120Ok = laosi !== undefined && laosi.end - laosi.start === 120;

    console.log("");
    let allOk = true;
    for (const c of checks) {
      console.log(`${c.ok ? "PASS" : "FAIL"}  老孙/小五/老四 → ${c.person}：${c.detail}`);
      if (!c.ok) allOk = false;
    }
    console.log(`${laosi120Ok ? "PASS" : "FAIL"}  老四档位 = ${laosi ? fmtSlot(laosi) + `（${laosi.end - laosi.start} 分钟）` : "无"}，120 分钟全程不被覆盖`);
    if (!laosi120Ok) allOk = false;

    console.log(`\n结论：状态机方案与真实定案${allOk ? "一致" : "有差异"}。`);
    if (allOk) {
      console.log("老孙 17:30-18:00、小五 18:00-18:30、老四 18:30-20:30 三档全部对上，且老四 120 不被覆盖。");
    } else {
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
