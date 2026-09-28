import "server-only";

import * as XLSX from "xlsx";
import { z } from "zod";

import {
  FEATURE_EXTRACT_MAX_OUTPUT_TOKENS,
  productionFeatureLlm,
  structuredCall,
} from "@/lib/chat/coliving/feature-llm";
import { colivingModelId } from "@/lib/chat/coliving/model";
import { normalizePhone } from "@/lib/chat/coliving/phone";
import { addResident, ensureHouseholdByLabel } from "@/lib/chat/coliving/repo";

/* ──────────────────────────────────────────────────────────────────────────
 * 合作方名单导入：一份 CSV / Excel → 库里真实的 person + person_contact +
 * membership。
 *
 * ## 这套系统面向的是**公寓里的一套房**，不是一栋独栋
 *
 * 名单上的每一行是「某套房里的某个人」。**一套房的标识常常散在好几列里**
 * ——`Property` + `Bldg` + `Unit` 三个列名拼起来才是「Maple Court A 座 101」。
 * 早先这里只让模型挑**一列**当房号，结果它挑了 `Property`（整份文件都一样），
 * 十一个人全被塞进了同一套房。现在按**列的有序列表**收，拼起来当房间标识。
 *
 * ## 为什么列名要靠模型判断
 *
 * 表格是**合作方自己的系统**导出来的，列名叫什么完全不知道（`租客姓名` /
 * `Tenant` / `Mobile #` / 甚至没有表头）。写正则匹配表头是在猜对方的命名习惯。
 * 所以**只调一次模型**，让它看前若干行的样子，回答「哪几列拼出房号、哪一列是
 * 名字、哪一列是电话、真正的记录从第几行开始」——**它只回答结构，不搬运数据**。
 *
 * 拿到结构之后，**逐行怎么取值是纯代码的事**（`planResidents` 里那个循环）：
 * 1000 行数据就是 1000 次 `cells[i]`，不是 1000 次模型调用。
 *
 * ## 电话号码：先代码，代码办不了的才花钱
 *
 * 号码写法千奇百怪（`+1 (555) 123-0001`、`555.123.0001`、带分机号、
 * 一格塞两个号码、全角数字）。`extractPhone` 先把这些吃掉——**绝大多数行
 * 用不上模型**。只有代码确实切不出来、而格子里又**确实有东西**的那些行，
 * 才把**那几格原文**攒成**一次**调用交给模型看一眼。既省，又只把模型用在
 * 真正需要判断的地方；而且模型回来的答案**还要再过一遍 `extractPhone`**，
 * 号码合不合法始终由代码说了算。
 *
 * ## 写入走的是生产那句 `addResident`
 *
 * 不另写一套 insert。导入进来的人跟房东短信报号码进来的人是**同一种东西**，
 * 必须能被大脑按同一套规则认出来（号码去重、同名合并、占位名编号、并发上锁）。
 * 这里只是**多了一条把号码送进 `addResident` 的入口**，短信那条路径一个字没动。
 *
 * ## 只读页面上唯一的写入口
 *
 * `/coordination-history` 是给合作方看的只读窗口，这个导入是**唯一**让它写库
 * 的东西。页面本身（`read.ts`）仍然没有任何 insert / update / delete。
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 列号：`null` = 没有这一列。
 *
 * 模型偶尔会把 `3` 写成字符串 `"3"`，或者把「没有」写成 `""` / `-1`。这里
 * **只在这一个位置上做归一**，把「不是个正常的列号」统一收成 `null`，
 * 后面所有读列的地方就不用各自防一遍。
 */
const columnIndex = z.preprocess((value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}, z.number().int().nullable());

/** 行号：`null` / 负数 / 非数字一律收成 0（从第一行开始认） */
const rowIndex = z.preprocess((value) => {
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}, z.number().int());

/** 一份名单一次最多收这么多人。超出的部分**明确报出来**，不静默截断 */
const MAX_ROWS = 1000;
/** 给模型看多少行、多少列、每个格子截多长——够它认出结构就行，不把整份表喂进去 */
const MAX_PREVIEW_ROWS = 15;
const MAX_PREVIEW_COLS = 12;
const MAX_PREVIEW_CELL_CHARS = 40;
/** 一次最多送几格原文去做「号码修补」，防止一份烂表把这一次调用撑爆 */
const MAX_PHONE_REPAIRS = 40;

export type ImportedResident = {
  name: string;
  phone: string;
  householdLabel: string;
  householdId: string;
  /** false = 这个号码本来就在库里，这次只是补齐了信息，没有新建人 */
  created: boolean;
};

/** 模型认出来的表格结构。**原样摆进结果里**给用户核对 */
export type ImportLayout = {
  /** 第一条真正的住户记录在第几行（0 起） */
  dataStartRow: number;
  nameColumn: number | null;
  phoneColumn: number | null;
  /**
   * **拼出房号的列，按从左到右的顺序。** 一套房的标识可能散在好几列里
   * （`Property` + `Bldg` + `Unit`），全都要收进来；空数组表示整份文件属于
   * 同一套房，房名看 `householdName`。
   */
  householdColumns: number[];
  /** 整份文件属于同一套房时，那个房名 */
  householdName: string | null;
};

export type ImportReport = {
  ok: true;
  sheetName: string;
  layout: ImportLayout;
  households: Array<{
    id: string;
    /** 归一之后的套房名，也是库里 `household.label` 真正写下的那个 */
    label: string;
    /**
     * 被折进这套房的**原始房号**（`501-A` / `401-1` …），不含与 label 相同的那些。
     * 归一是一次不可撤销的判断，回执里得让它一眼可查：这几行当初是并进这里的。
     */
    aliases: string[];
    /** 这套房是这次新建的，还是库里本来就有的 */
    created: boolean;
    added: number;
  }>;
  residents: ImportedResident[];
  /** 认不出号码 / 整行空掉的行。带行号和原文，方便回去对着原表找 */
  skipped: Array<{ row: number; raw: string; reason: string }>;
  /** 超过 `MAX_ROWS` 被留下的行数。0 表示整份文件都收进来了 */
  truncated: number;
};

export type ImportFailure = { ok: false; error: string };

/** 边做边报，让页面能说清「现在卡在哪一步」，而不是干等 */
export type ImportStage =
  | { stage: "read" }
  | { stage: "identify" }
  | { stage: "repair"; count: number }
  | { stage: "units"; count: number }
  | { stage: "write"; done: number; total: number };

type OnStage = (stage: ImportStage) => void;

// ── 电话号码 ────────────────────────────────────────────────────────────────

/**
 * 末尾的分机号：`ext 22` / `extension 22` / `x22` / `转 22` / `内线 22` / `分机 22`。
 * 整段砍掉再找主号码——留着的话 `555-123-0005 ext 22` 会被拼成 12 位。
 */
const EXTENSION_SUFFIX =
  /(?:\b(?:ext|extension|ex|tel|x)\b\.?|转|内线|分机)\s*[:#]?\s*\d+\s*$/i;

/**
 * 全角数字、各种 Unicode 连字符与空格 → 半角。
 *
 * 合作方的表是从各处粘出来的，`１２３` 和 `－` 混进来过。不先归一，后面所有
 * 数字判断都会静默落空。
 */
function toHalfWidth(input: string): string {
  return input
    .replace(
      /[０-９]/g,
      (c) => String.fromCharCode(c.charCodeAt(0) - 0xfe_e0)
    )
    .replace(/[‐-―−－]/g, "-")
    .replace(/[   　]/g, " ")
}

/**
 * 从一格随便写的文字里**抠出一个电话号码**，抠不出返回 `null`。
 *
 * 覆盖过的写法：
 *   `+1 (555) 123-0001` · `555.123.0001` · `5551230001` · `1-555-123-0001`
 *   `555 123 0001 ext 22`（分机号砍掉）· `(555) 123-0001 (cell)`（备注砍掉）
 *   `555-123-0001 / 555-987-6543`（一格两个，取第一个）
 *   `１２３４５６７８９０`（全角）
 *
 * **先切候选、再按长度判定**，不是「把非数字全删了看剩几位」——后者遇到一格
 * 两个号码会造出一个二十多位的假号码写进库，而且**看不出错**。宁可返回 null
 * 让它去走人工/模型那一步，也不要写一个看起来像号码的垃圾。
 */
export function extractPhone(raw: string): string | null {
  if (!raw) {
    return null;
  }
  const text = toHalfWidth(raw).replace(EXTENSION_SUFFIX, "").trim();
  // 候选片段：以数字（或 +数字）开头、以数字结尾、中间只夹着号码里会出现的符号
  const candidates = text.match(/\+?\d[\d\s().-]{4,}\d/g) ?? [];
  for (const candidate of candidates) {
    const digits = candidate.replace(/\D/g, "");
    // 北美十位、或带国家码的十一位
    if (digits.length === 10 || (digits.length === 11 && digits.startsWith("1"))) {
      return normalizePhone(digits);
    }
    // 写成 `+` 开头的国际号码，长度合理就认
    if (candidate.startsWith("+") && digits.length >= 10 && digits.length <= 15) {
      return normalizePhone(candidate);
    }
  }
  return null;
}

/** 修补回执：每一格给回一个号码或者 null */
const phoneRepairSchema = z.object({
  phones: z.array(
    z.object({
      row: rowIndex,
      phone: z
        .preprocess(
          (value) =>
            value === null || value === undefined ? null : String(value).trim(),
          z.string().nullable()
        )
        .nullable(),
    })
  ),
});

const PHONE_REPAIR_SYSTEM = [
  "用户会给你几行原文，每行是 `row N: <原文>`，原文来自一个「联系电话」格，",
  "但写法不规范（夹杂称谓、分机、备注、多个号码、全角字符等）。",
  "",
  "请为每一行给出**一个**电话号码，只输出一个 JSON 对象，不要任何解释：",
  '  {"phones": [{"row": 0, "phone": "15551230001"}, {"row": 4, "phone": null}]}',
  "",
  "规则：",
  "  · `phone` 只写数字，可以带一个开头的 `+`；不要括号、空格、连字符。",
  "  · 一格里有多个号码时，给**第一个**。",
  "  · 有分机号就**丢掉**分机号，只给主号码。",
  "  · 原文里**根本没有电话号码**（比如写着「无」「N/A」、只有日期或房号）",
  "    就填 null。**不要猜、不要凑、不要编**——填 null 比编一个强得多。",
  "  · 每一行都要出现在结果里，`row` 用原文给你的那个号。",
].join("\n");

/**
 * 代码抠不出号码的那些格，**攒成一次调用**交给模型看一眼。
 *
 * 一次都不多调：没有任何一格需要修补时（绝大多数情况）直接返回，不花这笔钱。
 */
async function repairPhones(
  pending: Array<{ row: number; raw: string }>,
  onStage?: OnStage
): Promise<Map<number, string>> {
  const fixed = new Map<number, string>();
  if (pending.length === 0) {
    return fixed;
  }
  const batch = pending.slice(0, MAX_PHONE_REPAIRS);
  onStage?.({ stage: "repair", count: batch.length });

  const llm = productionFeatureLlm(colivingModelId());
  const { value } = await structuredCall(llm, {
    stage: "import:repair-phones",
    name: "resident-phone-repair",
    system: PHONE_REPAIR_SYSTEM,
    user: batch.map((p) => `row ${p.row}: ${p.raw.slice(0, 120)}`).join("\n"),
    maxOutputTokens: FEATURE_EXTRACT_MAX_OUTPUT_TOKENS,
    schema: phoneRepairSchema,
  });
  const parsed = value as { phones: Array<{ row: number; phone: string | null }> };

  for (const item of parsed.phones) {
    if (!item.phone) {
      continue;
    }
    // **模型给的号码也要过一遍代码这道关。** 它可能回一个「555-123-0001 x22」
    // 或者干脆编一个；`extractPhone` 认不下就当它没修好，绝不让没验证过的
    // 字符串进库——号码是这套系统认人的唯一凭据
    const cleaned = extractPhone(item.phone);
    if (cleaned) {
      fixed.set(item.row, cleaned);
    }
  }
  return fixed;
}

// ── 读表 ────────────────────────────────────────────────────────────────────

/**
 * 单元格 → 字符串。
 *
 * `raw: true` 拿到的电话列**很可能是个数字**（Excel 里没设成文本格式的号码），
 * 直接 `String()` 会得到 `1.5551230001e9` 这种没法解析的东西。整数一律按整数
 * 展开，绝不用科学计数法。
 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  if (value instanceof Date) {
    // 日期列（`cellDates: true`）给模型看的是 `2025-03-01`，不是 `45716.666`
    return value.toISOString().slice(0, 10);
  }
  return String(value).trim();
}

/**
 * 二进制表格（xlsx 是 zip，老 xls 是 OLE2 复合文档）还是纯文本表（CSV / TSV）？
 * 用文件头分流，不信扩展名。
 */
function looksBinary(bytes: Uint8Array): boolean {
  return (
    (bytes[0] === 0x50 && bytes[1] === 0x4b) || // "PK" → zip，也就是 .xlsx
    (bytes[0] === 0xd0 && bytes[1] === 0xcf) // OLE2 头，也就是 .xls
  );
}

/**
 * 读第一张工作表，摊成二维数组。CSV 和 xlsx / xls **走同一个函数**。
 *
 * **CSV 必须自己按 UTF-8 解码，不能把字节直接丢给 SheetJS。** 实测：直接喂
 * 字节时它按 Latin-1 兜底，`序号 / 租客姓名 / 张伟` 会整片变成 `åºå·` 这种
 * 乱码——而且是**静默**废掉（照样读出一个数组，只是人名校验不过、房号对不上）。
 *
 * `blankrows: false` 让行号跟人眼看到的「第几条记录」对得上。
 */
function readSheet(buffer: ArrayBuffer): {
  sheetName: string;
  rows: string[][];
} {
  const bytes = new Uint8Array(buffer);
  const binary = looksBinary(bytes);
  const workbook = XLSX.read(
    binary ? bytes : new TextDecoder("utf-8").decode(bytes),
    { type: binary ? "array" : "string", cellDates: true }
  );
  const sheetName = workbook.SheetNames[0] ?? "";
  if (!sheetName) {
    throw new Error("This file has no worksheets in it.");
  }
  const raw = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
    header: 1,
    raw: true,
    blankrows: false,
    defval: null,
  });
  return { sheetName, rows: raw.map((cells) => cells.map(cellText)) };
}

/** 把前若干行渲染成模型能读的样子：`row 3: [0] 姓名 | [1] 电话 | …` */
function renderPreview(rows: string[][]): string {
  return rows
    .slice(0, MAX_PREVIEW_ROWS)
    .map((cells, row) => {
      const shown = cells
        .slice(0, MAX_PREVIEW_COLS)
        .map((cell, col) => `[${col}] ${cell.slice(0, MAX_PREVIEW_CELL_CHARS)}`)
        .join(" | ");
      return `row ${row}: ${shown || "(blank row)"}`;
    })
    .join("\n");
}

// ── 认列 ────────────────────────────────────────────────────────────────────

/** 拼出房号的列：`null` / `[]` / 单个数字都收成一个有序数组 */
const householdColumns = z.preprocess(
  (value) => {
    if (value === null || value === undefined) {
      return [];
    }
    const list = Array.isArray(value) ? value : [value];
    const out: number[] = [];
    for (const item of list) {
      const n =
        typeof item === "number" ? item : Number(String(item).trim());
      if (Number.isFinite(n) && n >= 0) {
        out.push(Math.floor(n));
      }
    }
    return out;
  },
  z.array(z.number().int())
);

const layoutSchema = z.object({
  dataStartRow: rowIndex,
  nameColumn: columnIndex,
  phoneColumn: columnIndex,
  householdColumns,
  householdName: z
    .preprocess(
      (value) =>
        value === null || value === undefined || value === ""
          ? null
          : String(value).trim(),
      z.string().nullable()
    )
    .nullable(),
});

const IDENTIFY_SYSTEM = [
  "You are a spreadsheet structure identifier. The user shows you the first few rows",
  "of a resident roster. Each line is `row N`, and each cell is written `[column] value`.",
  "",
  "Decide the structure of the sheet, then output **only one JSON object** — no prose,",
  "no explanation outside the JSON.",
  "",
  "Fields (all required; use null when it does not exist):",
  '  "dataStartRow"      Row index (0-based) of the FIRST real resident record. Skip any',
  "                      title, note, blank or header rows above it.",
  '  "nameColumn"        Column holding the resident name, or null.',
  '  "phoneColumn"       Column holding the phone number, or null. **This is the most',
  "                      important one.** Do not mistake a date, unit number, ID or zip",
  "                      code for the phone column.",
  '  "householdColumns"  The column(s) that identify WHICH UNIT the person lives in,',
  "                      as an array in left-to-right order.",
  "                      **A unit is often spread over several columns** — e.g. a",
  '                      "Property" column plus a "Bldg" column plus a "Unit" column',
  "                      together name one unit. List ALL of them, e.g. [2, 3, 4].",
  "                      Do NOT include person-level columns (bed space, lease status,",
  "                      move-in date, email). Use [] when no column carries the unit.",
  '  "householdName"     When the WHOLE file is about a single unit and its name only',
  "                      appears in a title row, put that name here (copy it verbatim,",
  "                      do not translate or rewrite). Otherwise null.",
  "",
  "Column numbers are 0-based integers matching the `[column]` labels. Report the",
  "structure only — never copy any row data into the JSON.",
].join("\n");

/**
 * 一次模型调用，问出这份表的结构。
 *
 * **输出上限必须给足**：DeepSeek V4.1 Flash 把 reasoning token 也算进
 * `maxOutputTokens`，压小会在文本产出前就被截断（项目里真实复现过
 * `NoOutputGeneratedError`），所以这里跟别的短调用用同一档。
 */
async function identifyLayout(
  rows: string[][],
  onStage?: OnStage
): Promise<ImportLayout> {
  onStage?.({ stage: "identify" });
  const llm = productionFeatureLlm(colivingModelId());
  const { value } = await structuredCall(llm, {
    stage: "import:resident-columns",
    name: "resident-file-layout",
    system: IDENTIFY_SYSTEM,
    user: `This sheet has ${rows.length} rows (0-based row numbers). Its first rows:\n\n${renderPreview(rows)}`,
    maxOutputTokens: FEATURE_EXTRACT_MAX_OUTPUT_TOKENS,
    schema: layoutSchema,
  });
  return value as ImportLayout;
}

/** 一套房的名字：把模型指认的那几列按顺序拼起来 */
function composeLabel(
  cells: string[],
  columns: number[],
  wholeFile: string | null
): string {
  const parts = columns
    .map((column) => (cells[column] ?? "").trim())
    .filter(Boolean);
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  return wholeFile?.trim() || "Unnamed unit";
}

// ── 套房归一 ────────────────────────────────────────────────────────────────

/**
 * 一次最多送多少个不同的房号原文去做归一分组。
 *
 * 一栋公寓楼的单元数撑死几百个，超过这个数说明这多半不是一份「一栋楼」的名单，
 * 超出部分原样保留并在回执里报出来，不静默丢。
 */
const MAX_UNIT_LABELS = 500;

/**
 * 一次调用里放多少条原文。
 *
 * **分成几批不是性能取舍，是防截断。** 输出是「每条原文一个 `{raw, unit}`」，
 * 条数一多 JSON 本身就长；而生产模型是推理模型，**reasoning tokens 计入
 * `maxOutputTokens`**（见 `feature-llm.ts` 那张表）。几百条一次问，推理加上
 * 几千字的 JSON 很容易把额度用光、`finishReason: "length"`，整条导入就跟着
 * 失败了——为了一个「能合并得更细」的附带好处，把正事赔进去不划算。
 *
 * 分批之后每批的输出都是短而确定的，**批与批之间并行跑**，等待时间不叠加。
 * 代价是跨批的相似房号模型看不到（`501-A` 和 `501-B` 落在两批里就合不起来），
 * 所以宁可每批塞大一点、批数少一点。
 */
const UNIT_CHUNK_SIZE = 80;

/**
 * 归一这一步自己的输出上限。
 *
 * **比通用短调用那档（4096）高**：那一档是给「一个 token、两个字段、一条短信」
 * 定的，这里的输出是**几十条**映射，不是一句话。低了下场就是推理把额度吃光、
 * 一条映射都没吐出来。
 */
const UNIT_RESOLVE_MAX_OUTPUT_TOKENS = 8192;

/** 原文 → 套房。`raw === unit` 表示这一条没被折叠 */
export type UnitResolution = { raw: string; unit: string };

const unitResolutionSchema = z.object({
  units: z.array(
    z.object({
      raw: z
        .preprocess(
          (v) => (v === null || v === undefined ? "" : String(v)),
          z.string()
        )
        .nullable(),
      unit: z
        .preprocess(
          (v) => (v === null || v === undefined ? "" : String(v)),
          z.string()
        )
        .nullable(),
    })
  ),
});

const UNIT_RESOLUTION_SYSTEM = [
  "用户给你一份住户名单里**出现过的全部房号原文**，一行一个，写成 `raw N: <原文>`。",
  "",
  "这份名单常常记到比「一套房」更细的粒度：房号上还挂着一间房 / 一个床位 / 一个",
  "子单元的编号。你的任务是把每一行原文映射到它所属的**那套房**。",
  "",
  "原文有时是**几列拼起来的**，中间用 ` · ` 隔开（楼栋名 · 楼座 · 房号）。",
  "这种情况下**每一段都要留着**，只砍掉最后那段里属于房间 / 床位的尾缀。",
  "",
  "例子：",
  '  "501-A"、"501-B"、"501"      → 都是 501 这套房',
  '  "401-1"、"401-2"             → 都是 401 这套房',
  '  "Bldg A Unit 101 Bed 3"      → 是 "Bldg A Unit 101" 这套房',
  '  "Maple Court · A · 501-A"    → 是 "Maple Court · A · 501" 这套房',
  '  "Maple Court · A · 501-B"    → 也是 "Maple Court · A · 501"',
  "",
  "规则：",
  "  · **只有确实是同一套房时才合并。** 不同楼、不同层、不同单元号就是不同的房，",
  "    哪怕看着很像——**认不出来的编号一个都不许并**。",
  "  · 只砍掉明确是「房间 / 床位 / 子单元」的限定部分，房号本身（楼号字母、单元号）",
  "    要留着，` · ` 两边的段也要留着。",
  "  · **套房名必须是原文的一部分，一字不差。** 你只能**删字**，不能改字、不能缩写、",
  "    不能重排、不能另起一个名字、不能翻译，标点和空格也照抄。原文里没有的东西",
  "    不许出现在结果里。",
  "  · **拿不准就原样返回。** 猜错合并比不合并糟得多：并错了是把人塞进别人家，",
  "    用户很难发现也很难撤；没并顶多是列表里多几行，他一眼就能看出来。",
  "  · 每一条给你的原文都必须在结果里**恰好出现一次**，`raw` 照抄你收到的原文。",
  "",
  "只输出一个 JSON 对象，不要任何解释：",
  '  {"units": [{"raw": "501-A", "unit": "501"}, {"raw": "501", "unit": "501"}]}',
].join("\n");

/** 比较时把空白和大小写抹平，免得为了一个空格判成「不包含」 */
function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 把「房间 / 床位级」的房号原文收拢到「套房级」。
 *
 * 为什么值得多花一次模型调用：这件事**判断不了靠正则**。合作方把房间号挂上去的
 * 写法五花八门（`501-A` / `401-1` / `101 bed 3` / `#2` …），而且同样的 `-A`
 * 在一份表里是房间、在另一份表里可能就是楼座。写死一套剥离规则，等于拿这一份
 * 文件的样式去赌下一份。
 *
 * 而且**把原始房号一次性全摆给模型看**，它才能看出「501-A 和 501-B 是一家人」
 * 这种要横着比才知道的事——只看前十几行是看不出来的。这也正是 `renderPreview`
 * 那种「看个开头」做不到的部分。
 *
 * **代码这关必须过**：模型给的套房名要能在原文里找得到（只许删、不许编），
 * 找不到就丢掉、那条原文保持原样。否则模型可以凭空造一个房号，把两拨不相干的
 * 人合并到同一个不存在的名字底下，而库里看起来完全正常。
 */
async function resolveUnits(
  labels: string[],
  onStage?: OnStage
): Promise<UnitResolution[]> {
  const distinct = [...new Set(labels.filter(Boolean))];
  // 只有一种房号时没什么可归一的，不花这笔钱
  if (distinct.length < 2) {
    return distinct.map((raw) => ({ raw, unit: raw }));
  }

  const batch = distinct.slice(0, MAX_UNIT_LABELS);
  onStage?.({ stage: "units", count: batch.length });

  const chunks: string[][] = [];
  for (let i = 0; i < batch.length; i += UNIT_CHUNK_SIZE) {
    chunks.push(batch.slice(i, i + UNIT_CHUNK_SIZE));
  }

  // 并行跑：分几批是为了防截断，不该让用户多等几倍时间
  const answers = await Promise.all(chunks.map((chunk) => resolveUnitChunk(chunk)));

  const resolved = new Map<string, string>();
  for (const { raw, unit } of answers.flat()) {
    if (!resolved.has(raw)) {
      resolved.set(raw, unit);
    }
  }

  // 模型漏答的原文一律保持原样——宁可多几套房，也不能因为模型没提就把人丢掉
  for (const raw of batch) {
    if (!resolved.has(raw)) {
      resolved.set(raw, raw);
    }
  }
  // 超过上限没送去的，原样保留
  for (const raw of distinct.slice(MAX_UNIT_LABELS)) {
    resolved.set(raw, raw);
  }

  return [...resolved].map(([raw, unit]) => ({ raw, unit }));
}

/**
 * 一批原文 → 一批映射。**这一批问不出来就整批原样返回，不往上抛。**
 *
 * 归一只是让列表好看一点的**附带好处**，不该有权把整次导入判死：模型超时、
 * 输出被截断、回来的 JSON 不合 schema，这时候最想要的结果是「房号没合并，
 * 但人是照样导进去了」，而不是用户等了两分钟等到一句失败、还要重来一遍。
 * 所以这里吞掉异常，让调用方拿到等同「这批什么都没合」的结果。
 */
async function resolveUnitChunk(chunk: string[]): Promise<UnitResolution[]> {
  const identity: UnitResolution[] = chunk.map((raw) => ({ raw, unit: raw }));
  let items: Array<{ raw: string | null; unit: string | null }>;
  try {
    const llm = productionFeatureLlm(colivingModelId());
    const { value } = await structuredCall(llm, {
      stage: "import:resolve-units",
      name: "resident-unit-resolution",
      system: UNIT_RESOLUTION_SYSTEM,
      user: chunk.map((label, index) => `raw ${index}: ${label}`).join("\n"),
      maxOutputTokens: UNIT_RESOLVE_MAX_OUTPUT_TOKENS,
      schema: unitResolutionSchema,
    });
    items = (value as { units: Array<{ raw: string | null; unit: string | null }> })
      .units;
  } catch (error) {
    console.error("[coordination-history] 房号归一这批没成，按原样保留", error);
    return identity;
  }

  const known = new Set(chunk);
  const resolved = new Map<string, string>();
  for (const item of items) {
    const raw = (item.raw ?? "").trim();
    const unit = (item.unit ?? "").trim();
    // 原文不是我们给过的（模型编的）→ 丢掉
    if (!known.has(raw) || resolved.has(raw)) {
      continue;
    }
    // 空、过长、或者**不是原文的一部分**（模型改名 / 缩写 / 翻译了）→ 不采纳，
    // 保持原样。这条是整套归一里唯一的硬约束：模型只能做减法
    if (
      !unit ||
      unit.length > 120 ||
      !normalizeForCompare(raw).includes(normalizeForCompare(unit))
    ) {
      resolved.set(raw, raw);
      continue;
    }
    resolved.set(raw, unit);
  }

  // 模型漏答的，原样保留
  for (const raw of chunk) {
    if (!resolved.has(raw)) {
      resolved.set(raw, raw);
    }
  }
  return [...resolved].map(([raw, unit]) => ({ raw, unit }));
}

// ── 计划（不写库） ──────────────────────────────────────────────────────────

export type PlannedResident = {
  /** 原表里的行号，0 起 */
  row: number;
  name: string;
  phone: string;
  householdLabel: string;
};

export type ImportPlan = {
  sheetName: string;
  layout: ImportLayout;
  /** `householdLabel` 已经是**归一之后的套房名**，不是原表里的原文 */
  residents: PlannedResident[];
  /** 原文房号 → 套房名的完整对应，回执里据此展示「这几行并进了哪套房」 */
  unitResolutions: UnitResolution[];
  skipped: Array<{ row: number; raw: string; reason: string }>;
  truncated: number;
};

/**
 * 读表 → 认列 → 抠号码 → 算好每一行要写什么。**一行都不写库。**
 *
 * 跟写入分开是有意的：这一半全是「算」，可以在本地对着任何一份表跑，
 * 不碰数据库、不留垃圾；`importResidents` 只是把它算出来的东西交给
 * `addResident`。
 */
export async function planResidents(
  buffer: ArrayBuffer,
  onStage?: OnStage
): Promise<ImportPlan> {
  onStage?.({ stage: "read" });
  const { sheetName, rows } = readSheet(buffer);
  if (rows.length === 0) {
    throw new Error("This spreadsheet has no rows in it.");
  }

  const layout = await identifyLayout(rows, onStage);
  if (layout.phoneColumn === null) {
    // **认不出电话列就整份不收。** 猜一列硬着头皮写进去，写错的是人名和号码
    // 的对应关系——那是没法从库里认出来、只能一条条手工收拾的脏数据
    throw new Error(
      "Couldn't tell which column holds the phone numbers, so nothing was written. Try another file."
    );
  }

  const start = Math.min(layout.dataStartRow, rows.length);
  const residents: PlannedResident[] = [];
  const skipped: ImportPlan["skipped"] = [];
  /** 代码抠不出号码、但格子里确实有东西的，等着交给模型看一眼 */
  const pending: Array<{ row: number; raw: string }> = [];
  let truncated = 0;

  for (let row = start; row < rows.length; row += 1) {
    if (residents.length + pending.length >= MAX_ROWS) {
      truncated = rows.length - row;
      break;
    }
    const cells = rows[row] ?? [];
    const raw = (cells[layout.phoneColumn] ?? "").trim();
    if (!raw) {
      // 表尾的合计行、备注行、隔断空行都会落到这里。不是错误，只是没有号码
      skipped.push({ row, raw: "", reason: "no phone number in this row" });
      continue;
    }
    const phone = extractPhone(raw);
    if (phone) {
      residents.push({
        row,
        name: layout.nameColumn === null ? "" : (cells[layout.nameColumn] ?? "").trim(),
        phone,
        householdLabel: composeLabel(cells, layout.householdColumns, layout.householdName),
      });
    } else {
      pending.push({ row, raw });
    }
  }

  // 只有确实存在「抠不出来但有内容」的格子时才花这笔钱
  const repaired = await repairPhones(pending, onStage);
  for (const item of pending) {
    const phone = repaired.get(item.row);
    const cells = rows[item.row] ?? [];
    if (!phone) {
      skipped.push({
        row: item.row,
        raw: item.raw.slice(0, 80),
        reason: "couldn't read a phone number from this cell",
      });
      continue;
    }
    residents.push({
      row: item.row,
      name: layout.nameColumn === null ? "" : (cells[layout.nameColumn] ?? "").trim(),
      phone,
      householdLabel: composeLabel(cells, layout.householdColumns, layout.householdName),
    });
  }

  // 归一在**最终住户列表**上做，不是在原始行上：只有真正会被写进库的那些房号
  // 才值得摆给模型看，被跳过的行不该影响它的判断
  const unitResolutions = await resolveUnits(
    residents.map((r) => r.householdLabel),
    onStage
  );
  const unitByRaw = new Map(unitResolutions.map((r) => [r.raw, r.unit]));
  for (const resident of residents) {
    resident.householdLabel =
      unitByRaw.get(resident.householdLabel) ?? resident.householdLabel;
  }

  residents.sort((a, b) => a.row - b.row);
  skipped.sort((a, b) => a.row - b.row);
  return { sheetName, layout, residents, unitResolutions, skipped, truncated };
}

// ── 写入 ────────────────────────────────────────────────────────────────────

/**
 * 一份名单 → 库里的住户。
 *
 * 逐个 `addResident` 而不是攒一批一次性插：那个函数自带的「号码已存在就补齐、
 * 不重复建人」的语义正是这里要的，重跑同一份文件不会插出一堆重复的人。
 * 同一套房的 id 在这一次请求里缓存住，几十行同一套房不会反复查库。
 */
export async function importResidents(
  buffer: ArrayBuffer,
  onStage?: OnStage
): Promise<ImportReport> {
  const plan = await planResidents(buffer, onStage);

  // 哪几行原文并进了哪套房。回执要能回答「501 里明明有六个人，原表哪六行」，
  // 所以归一这一步的结果**必须随回执一起交出来**，不能只体现在最终的 label 上
  const aliasesByUnit = new Map<string, string[]>();
  for (const { raw, unit } of plan.unitResolutions) {
    if (raw === unit) {
      continue;
    }
    const list = aliasesByUnit.get(unit) ?? [];
    list.push(raw);
    aliasesByUnit.set(unit, list);
  }

  const households = new Map<
    string,
    {
      id: string;
      label: string;
      aliases: string[];
      created: boolean;
      added: number;
    }
  >();
  const residents: ImportedResident[] = [];

  for (const [index, planned] of plan.residents.entries()) {
    onStage?.({
      stage: "write",
      done: index,
      total: plan.residents.length,
    });

    let house = households.get(planned.householdLabel);
    if (!house) {
      const found = await ensureHouseholdByLabel(planned.householdLabel);
      house = {
        id: found.householdId,
        label: planned.householdLabel,
        aliases: aliasesByUnit.get(planned.householdLabel) ?? [],
        created: found.created,
        added: 0,
      };
      households.set(planned.householdLabel, house);
    }

    // 名字留空就让 `addResident` 按角色编号给占位名（「3号住客」），
    // 绝不拿电话号当名字。
    //
    // `role: "tenant"` + `residence: "confirmed_lives"` —— **这份名单就是
    // 「这些人住这儿」的确认**（老板 2026-09-27 定）。合作方交上来的不是一本
    // 通讯录，是某套房的住户名单；房号加人名加号码，本身就是居住事实的声明。
    //
    // 这跟「房东短信报来一个号码」是两回事，后者仍然是 unknown：那边报的可能
    // 只是宿管、物业、中介的号码，号码本身不构成「他住在这儿」。判据是**这份
    // 数据的来处说明了什么**，不是「拿到号码就按住着算」。
    const added = await addResident({
      householdId: house.id,
      phone: planned.phone,
      name: planned.name || null,
      role: "tenant",
      residence: "confirmed_lives",
    });
    house.added += 1;
    residents.push({
      name: added.name,
      phone: planned.phone,
      householdLabel: house.label,
      householdId: house.id,
      created: added.created,
    });
  }

  return {
    ok: true,
    sheetName: plan.sheetName,
    layout: plan.layout,
    households: [...households.values()],
    residents,
    skipped: plan.skipped,
    truncated: plan.truncated,
  };
}
