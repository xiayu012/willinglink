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
 * ## 为什么列名要靠模型判断
 *
 * 表格是**合作方自己的系统**导出来的，列名叫什么完全不知道（`租客姓名` /
 * `Tenant` / `姓名` / `Name` / 甚至没有表头只有一列人名）。写正则匹配表头
 * 是在猜对方的命名习惯，猜不中就整份文件读不出来。所以**只调一次模型**，
 * 让它看前若干行的样子，回答「哪一列是名字、哪一列是电话、哪一列是房子名、
 * 真正的记录从第几行开始」——**它只回答结构，不搬运数据**。
 *
 * 拿到这个结构之后，**逐行怎么取值是纯代码的事**（`importResidents` 里那个循环）：
 * 1000 行数据就是 1000 次 `cells[phoneColumn]`，不是 1000 次模型调用。
 * 这也符合项目里那条「组合 / 穷举类的机械活交给代码，不靠模型心算」。
 *
 * ## 写入走的是生产那句 `addResident`
 *
 * 不另写一套 insert。导入进来的人跟房东短信报号码进来的人是**同一种东西**，
 * 必须能被大脑按同一套规则认出来（同名合并、号码去重、占位名编号、并发上锁）。
 * 这里只是**多了一条把号码送进 `addResident` 的入口**，短信那条路径一个字没动。
 *
 * ## 只读页面上唯一的写入口
 *
 * `/coordination-history` 是给合作方看的只读窗口，这个导入是**唯一**让它写库
 * 的东西，且只在按下那个绿色长条按钮时发生。页面本身（`read.ts`）仍然没有
 * 任何 insert / update / delete。
 * ────────────────────────────────────────────────────────────────────────── */

/** 一份名单一次最多收这么多人。超出的部分**明确报出来**，不静默截断 */
const MAX_ROWS = 1000;
/** 给模型看多少行、多少列、每个格子截多长——够它认出结构就行，不把整份表喂进去 */
const MAX_PREVIEW_ROWS = 25;
const MAX_PREVIEW_COLS = 14;
const MAX_PREVIEW_CELL_CHARS = 60;

export type ImportedResident = {
  name: string;
  phone: string;
  householdLabel: string;
  householdId: string;
  /** false = 这个号码本来就在库里，这次只是补齐了信息，没有新建人 */
  created: boolean;
};

export type ImportReport = {
  ok: true;
  sheetName: string;
  /**
   * 模型认出来的表格结构。**原样摆进结果里**：认错了列（比如把「入住日期」
   * 当成电话列）是一眼能看出来的，不给看就只能对着错数据猜为什么不对。
   */
  layout: {
    dataStartRow: number;
    nameColumn: number | null;
    phoneColumn: number | null;
    householdColumn: number | null;
    householdName: string | null;
  };
  households: Array<{
    id: string;
    label: string;
    /** 这栋房子是这次新建的，还是库里本来就有的 */
    created: boolean;
    added: number;
  }>;
  residents: ImportedResident[];
  /** 认不出号码 / 整行空掉的行。带行号，方便回去对着原表找 */
  skipped: Array<{ row: number; reason: string }>;
  /** 超过 `MAX_ROWS` 被留下的行数。0 表示整份文件都收进来了 */
  truncated: number;
};

export type ImportFailure = { ok: false; error: string };

/**
 * 单元格 → 字符串。
 *
 * `raw: true` 拿到的电话列**很可能是个数字**（Excel 里没设成文本格式的号码，
 * 或者 CSV 被识别成数值），直接 `String()` 会得到 `1.5551230001e9` 这种没法
 * 解析的东西。整数一律按整数展开，绝不用科学计数法。
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
    // 日期列（`cellDates: true`）给模型看的是 `2025-03-01`，不是 `45716.666`。
    // 我们不读日期，但只要它出现在预览里，读成人看的写法模型才不容易认错列
    return value.toISOString().slice(0, 10);
  }
  return String(value).trim();
}

/**
 * 二进制表格（xlsx 是 zip，老 xls 是 OLE2 复合文档）还是纯文本表（CSV / TSV）？
 *
 * 用文件头分流，不信扩展名：`XLSX.read` 自己也会嗅探格式，但我们**必须知道该
 * 不该先自己解码**——理由是下面那条。
 */
function looksBinary(bytes: Uint8Array): boolean {
  return (
    (bytes[0] === 0x50 && bytes[1] === 0x4b) || // "PK" → zip，也就是 .xlsx
    (bytes[0] === 0xd0 && bytes[1] === 0xcf) // OLE2 头，也就是 .xls
  );
}

/**
 * 读第一张工作表，摊成二维数组。CSV 和 xlsx / xls **走同一个函数**，调用方
 * 不需要知道上传的是哪一种。
 *
 * **CSV 必须自己按 UTF-8 解码，不能把字节直接丢给 SheetJS。** 实测：直接喂
 * 字节时它按 Latin-1 兜底，`序号 / 租客姓名 / 张伟` 会整片变成 `åºå·` 这种
 * 乱码——名单里全是中文，这等于整份文件废掉，而且是**静默**废掉（照样读出
 * 一个数组，只是人名校验不过、房子名对不上）。xlsx / xls 是二进制，不能这么
 * 解，所以按文件头分流。
 *
 * `blankrows: false` 让下面的行号跟人眼看到的「第几条记录」对得上，中间的空行
 * 不会把行号顶偏。`cellDates` 让日期格子读成人看得懂的写法（见 `cellText`）。
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
    // 抛给用户看的文案一律英文：这一页整个是英文界面，混一句中文没人读得懂
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
        .map((cell, col) => {
          const text = cell.slice(0, MAX_PREVIEW_CELL_CHARS);
          return `[${col}] ${text}`;
        })
        .join(" | ");
      return `row ${row}: ${shown || "(空行)"}`;
    })
    .join("\n");
}

/**
 * 列号：`null` = 没有这一列。
 *
 * 模型偶尔会把 `"3"` 写成字符串、或者把「没有」写成 `""` / `-1`。这里**只在
 * 这一个位置上做归一**，把「不是个正常的列号」统一收成 `null`，别的地方仍然
 * 严格。
 */
const columnIndex = z.preprocess((value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return n;
}, z.number().int().nullable());

const rowIndex = z.preprocess((value) => {
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}, z.number().int());

/** 模型要回答的全部内容——只有结构，没有一行真实数据 */
const layoutSchema = z.object({
  dataStartRow: rowIndex,
  nameColumn: columnIndex,
  phoneColumn: columnIndex,
  householdColumn: columnIndex,
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

type Layout = z.infer<typeof layoutSchema>;

const IDENTIFY_SYSTEM = [
  "你是一个表格结构识别器。用户会给你一份住户名单的前若干行，一行一个 `row N`，",
  "单元格写成 `[列号] 值`。",
  "",
  "你的任务是判断这份表的结构，然后**只输出一个 JSON 对象**，不要任何解释文字、",
  "不要 markdown 代码围栏以外的内容。",
  "",
  "JSON 的字段（一个都不能少，认不出来的填 null）：",
  '  "dataStartRow"    第一条真正的住户记录在第几行（0 起）。前面是标题、说明、',
  "                    表头、空行的话，全部跳过，给第一条有姓名或电话的记录的 row。",
  '  "nameColumn"      住户姓名在第几列。没有姓名列就 null。',
  '  "phoneColumn"     电话号码在第几列。**这个最关键**，认错整份名单就废了。',
  "                    注意别把日期、房号、身份证、邮编当成电话列。",
  '  "householdColumn" 如果**每一行**各自带一个公寓/房子名称，写它所在的列；',
  "                    整个文件属于同一套房、房子名只出现在标题里，这一项填 null。",
  '  "householdName"   整个文件属于同一套房时，把那个房子名写在这里（照抄原文，',
  "                    不要翻译、不要改写）；有 householdColumn 或者看不出来就 null。",
  "",
  "列号是 0 起的整数，跟 `[列号]` 对得上。只回答结构，不要把任何一行的数据抄进",
  "JSON 里。",
].join("\n");

/**
 * 一次模型调用，问出这份表的结构。
 *
 * **只调这一次**：之后每一行怎么取值是纯代码。所以哪怕名单有一千行，成本也
 * 就是这一次调用——不给每行都问一遍模型。
 */
async function identifyLayout(rows: string[][]): Promise<Layout> {
  const llm = productionFeatureLlm(colivingModelId());
  const { value } = await structuredCall(llm, {
    stage: "import:resident-columns",
    name: "resident-file-layout",
    system: IDENTIFY_SYSTEM,
    user: `这份表一共 ${rows.length} 行（行号 0 起）。前面若干行是这样：\n\n${renderPreview(rows)}`,
    maxOutputTokens: FEATURE_EXTRACT_MAX_OUTPUT_TOKENS,
    schema: layoutSchema,
  });
  return value as Layout;
}

/**
 * 一份名单 → 库里的住户。
 *
 * 逐个 `addResident` 而不是攒一批一次性插：那个函数自带的「号码已存在就补齐、
 * 不重复建人」的语义正是这里要的，重跑同一份文件不会插出一堆重复的人。
 * 同一间房的房子 id 在这一次请求里缓存住，几十行同一间房不会反复查库。
 */
export async function importResidents(
  buffer: ArrayBuffer
): Promise<ImportReport> {
  const { sheetName, rows } = readSheet(buffer);
  if (rows.length === 0) {
    throw new Error("This spreadsheet has no rows in it.");
  }

  const layout = await identifyLayout(rows);
  if (layout.phoneColumn === null) {
    // **认不出电话列就整份不收。** 猜一列硬着头皮写进去，写错的是人名和号码
    // 的对应关系——那是没法从库里认出来、只能一条条手工收拾的脏数据
    throw new Error(
      "Couldn't tell which column holds the phone numbers, so nothing was written. Try another file."
    );
  }

  const start = Math.min(layout.dataStartRow, rows.length);
  const households = new Map<
    string,
    { id: string; label: string; created: boolean; added: number }
  >();
  const residents: ImportedResident[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];
  let truncated = 0;

  for (let row = start; row < rows.length; row += 1) {
    if (residents.length >= MAX_ROWS) {
      truncated = rows.length - row;
      break;
    }
    const cells = rows[row] ?? [];
    const phone = normalizePhone(cells[layout.phoneColumn] ?? "");
    if (!phone) {
      // 表尾的合计行、备注行、隔断空行都会落到这里。不是错误，只是没有号码，
      // 记下行号让用户能回去核对
      skipped.push({ row, reason: "这一行没有能识别的电话号码" });
      continue;
    }

    const name =
      layout.nameColumn === null ? "" : (cells[layout.nameColumn] ?? "").trim();
    const perRowHouse =
      layout.householdColumn === null
        ? ""
        : (cells[layout.householdColumn] ?? "").trim();
    const label = perRowHouse || layout.householdName || "未命名房源";

    let house = households.get(label);
    if (!house) {
      const found = await ensureHouseholdByLabel(label);
      house = {
        id: found.householdId,
        label,
        created: found.created,
        added: 0,
      };
      households.set(label, house);
    }

    // 名字留空就让 `addResident` 按角色编号给占位名（「3号住客」），
    // 绝不拿电话号当名字。
    //
    // `role: "tenant"` + `residence: "confirmed_lives"` —— **这份名单就是
    // 「这些人住这儿」的确认**（老板 2026-09-27 定）。合作方交上来的不是一本
    // 通讯录，是某间房的住户名单；房号加人名加号码，本身就是居住事实的声明。
    //
    // 这里跟「房东短信报来一个号码」是两回事，后者仍然是 `unknown`：那边
    // 报的可能只是宿管、物业、中介的号码，号码本身不构成「他住在这儿」。
    // 判据是**这份数据的来处**说明了什么，不是「拿到号码就按住着算」——
    // `membership-facts.ts` 开头那条警告针对的是后者，别把它套到名单上。
    const added = await addResident({
      householdId: house.id,
      phone,
      name: name || null,
      role: "tenant",
      residence: "confirmed_lives",
    });
    house.added += 1;
    residents.push({
      name: added.name,
      phone,
      householdLabel: house.label,
      householdId: house.id,
      created: added.created,
    });
  }

  return {
    ok: true,
    sheetName,
    layout,
    households: [...households.values()],
    residents,
    skipped,
    truncated,
  };
}
