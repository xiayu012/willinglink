"use client";

import { Badge, ScrollArea, TextInput } from "@mantine/core";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";

import type {
  ImportFailure,
  ImportReport,
  ImportStage,
} from "@/lib/coordination-history/import";
import type {
  HistoryHousehold,
  HistoryMessage,
} from "@/lib/coordination-history/read";

/* ──────────────────────────────────────────────────────────────────────────
 * ⚠️ **这一页的界面文字一律英文，写死，别改。**
 *
 * 改这条要老板明确发话。原因：这一页是**直接分享给合作方**看的窗口，对面
 * 未必读中文，而它又长期靠 vibe coding 往下加东西——不写死的话，下一次顺手的
 * 改动就会掺回中文，而且是**悄悄**掺回来，谁也不会在本地注意到。
 *
 * **只约束界面（UI）**：按钮、标题、提示、报错、空状态、aria-label 这些。
 * **聊天记录本身不翻译、不改写**，数据库里是什么语言就照原样显示什么——那是
 * 证据，不是文案，翻过一遍就不再是原始记录了。
 *
 * 这条是整个 `app/coordination-history/` 的规矩，不只这一个文件。
 *
 * ## 「household」在这页上写作 apartment / unit
 *
 * 项目已经转向**公寓**：以前是本地打工人合租的独栋，现在一套房就是一个单位。
 * 代码里 `household` 这个标识符沿用（库表、repo 函数都叫这个，改名要动整个
 * 数据层，不值得），但**用户看得见的字必须是 apartment / unit**——合作方看的
 * 就是一套套单元房，「household（住户/一家人）」会让他们以为这是按家庭分的。
 *
 * ## 两栏布局
 *
 * 左边房子列表 / 右边整栋房子的消息记录。
 *
 * **每一行要回答的是「谁发给谁」，不是「说了什么」。** 所以一行里发件人和
 * 收件人各占一个色块、各带一个名字，中间一个箭头指明方向——扫一列箭头就
 * 知道这栋房子的往来是怎么流的。正文退到第二行，只比名字小一点点（17 → 15），
 * **颜色跟发件人的名字完全一致**：名字和正文一个色，整段读下来就是这个人的
 * 声音，不用靠字号去分「谁是说话人」。
 *
 * 色块只有颜色、不带字：29 条记录就是 58 个色块，每个里面都塞两个字的话，
 * 读起来是负担而不是帮助。颜色配着旁边的名字看，一次就记住了。
 *
 * 没有按人筛选——从头到尾就是整栋房子的完整记录。
 *
 * 页面上**唯一会写库的东西是顶栏那个绿色长条方框**（合作方名单导入，见
 * `lib/coordination-history/import.ts`）：文件拖进去 / Ctrl+V 粘进去 / 点它
 * 选一个，三条路都通。除此之外这里不发送任何写请求。
 * ────────────────────────────────────────────────────────────────────────── */

/** 中枢自己的颜色。永远是圆角方块，跟人的圆点区分开 */
const HUB_COLOR = "#5f3dc4";
const HUB_NAME = "WillingLink";

// 时区写死：服务端和浏览器可能不在一个时区，不写死会出现水合前后时间不一样
const TZ = "America/Los_Angeles";

const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DAY_KEY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const DAY_LABEL_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
});

const RAIL_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  month: "short",
  day: "numeric",
});

/**
 * 同一个人的颜色，按他在**这栋房子里**的出场序号取（顺序由数据层定死，
 * 见 `readCoordinationHistory`）。
 *
 * 色相按 150° 步进，是为了让排在最前面的几个人之间差得尽可能远：0/1/2 号
 * 拿到的是 0°(红) / 150°(绿) / 300°(品红)，一眼就分得开。老老实实按调色板
 * 顺序发色会出现「老四偏蓝、小五也偏蓝」，那这套颜色就白上了。
 *
 * 12 个人之后色相绕回一圈，改用明度再分一层。真实房子 2–3 个人，够用。
 */
function personColor(index: number): string {
  const hue = (index * 150) % 360;
  const ring = Math.floor(index / 12) % 3;
  return `hsl(${hue} 68% ${[45, 62, 32][ring]}%)`;
}

/** 纯色块，不带字。中枢是正正方方的正方形，人是圆 */
function Dot({
  color,
  size = 38,
  square = false,
}: {
  color: string;
  size?: number;
  /** 中枢的色块：正正方形，一点圆角都不给 */
  square?: boolean;
}) {
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: square ? 0 : 999,
        background: color,
      }}
    />
  );
}

/** 记录里的一行：发件人 → 收件人，正文退到第二行 */
function MessageRow({
  msg,
  color,
}: {
  msg: HistoryMessage;
  /** 这行归属的那个人的颜色 */
  color: string;
}) {
  const fromHub = msg.direction === "outbound";
  const senderName = fromHub ? HUB_NAME : msg.personName;
  const senderColor = fromHub ? HUB_COLOR : color;
  const recipientName = fromHub ? msg.personName : HUB_NAME;
  const recipientColor = fromHub ? color : HUB_COLOR;

  return (
    <div
      className="border-b border-[#f4f5f7] py-3.5 pr-4"
      style={{ paddingLeft: 13, borderLeft: `3px solid ${color}` }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Dot color={senderColor} square={fromHub} />
        <span
          className="text-[17px] font-bold leading-none"
          style={{ color: senderColor }}
        >
          {senderName}
        </span>
        <span className="px-0.5 text-[18px] leading-none text-[#ced4da]">
          →
        </span>
        <Dot color={recipientColor} square={!fromHub} />
        <span
          className="text-[17px] font-bold leading-none"
          style={{ color: recipientColor }}
        >
          {recipientName}
        </span>
        <span className="ml-auto pl-3 text-[12px] tabular-nums text-[#adb5bd]">
          {TIME_FMT.format(new Date(msg.sentAt))}
        </span>
      </div>
      {/* 正文：只比名字小一点点（17 → 15），肉眼看得出但差得不多；颜色跟
          发件人的名字完全一致，一行读下来就是这个人的语气。仍然逐字照登，
          不截断、不改写 */}
      <div
        className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-[1.7]"
        style={{ color: senderColor }}
      >
        {msg.body}
      </div>
    </div>
  );
}

/** 往上送进托盘：一眼看得懂是「导入文件」，不是下载 */
function UploadIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-[19px] w-[19px] shrink-0 ${className ?? ""}`}
      aria-hidden
    >
      <path d="M12 15V3" />
      <path d="m7 8 5-5 5 5" />
      <path d="M3 15v3a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-3" />
    </svg>
  );
}

/**
 * 导入结果。
 *
 * **把模型认出来的列结构原样摆出来**：导入是一次性动作、没法撤销，事后想不通
 * 「怎么多出来这几个人」时，唯一的线索就是它当初把哪一列当成了电话列。
 * 认错列在这儿是一眼可见的，藏起来就只能对着错数据猜。
 */
function ImportResult({
  report,
  onClose,
}: {
  report: ImportReport | { ok: false; error: string };
  onClose: () => void;
}) {
  if (!report.ok) {
    return (
      <div className="border-b border-[#ffc9c9] bg-[#fff5f5] px-4 py-3 sm:px-5">
        <div className="mx-auto flex w-full max-w-[1100px] items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold text-[#c92a2a]">
              Import failed
            </div>
            <div className="mt-0.5 break-words text-[12px] text-[#a61e1e]">
              {report.error}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-[18px] leading-none text-[#c92a2a]"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  const newPeople = report.residents.filter((r) => r.created).length;
  const newUnits = report.households.filter((h) => h.created).length;
  const column = (index: number | null) =>
    index === null ? "none" : `#${index}`;
  // 房号可能散在好几列里，摆出来的是**有序的那一组**
  const unitColumns =
    report.layout.householdColumns.length > 0
      ? report.layout.householdColumns.map((c) => `#${c}`).join(" + ")
      : "none";

  return (
    <div className="max-h-[45dvh] overflow-y-auto border-b border-[#b2f2bb] bg-[#ebfbee] px-4 py-3 sm:px-5">
      <div className="mx-auto flex w-full max-w-[1100px] items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold text-[#2b8a3e]">
            Imported {report.residents.length} resident
            {report.residents.length === 1 ? "" : "s"}
            {newUnits > 0
              ? ` · ${newUnits} new unit${newUnits === 1 ? "" : "s"}`
              : ""}
            {newPeople > 0 ? ` · ${newPeople} new` : ""}
          </div>

          {/* 认出来的列结构**原样摆出来**：导入不可撤销，事后想不通「怎么多出来
              这几个人」时，唯一的线索就是它当初把哪几列当成了房号 */}
          <div className="mt-1 text-[11px] text-[#2f6f3e]">
            Sheet “{report.sheetName}” · rows start at{" "}
            {report.layout.dataStartRow}
            {" · "}name {column(report.layout.nameColumn)}
            {" · "}phone {column(report.layout.phoneColumn)}
            {" · "}unit from {unitColumns}
            {report.layout.householdName
              ? ` (“${report.layout.householdName}” for the whole file)`
              : ""}
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            {report.households.map((h) => (
              <span
                key={h.id}
                className="rounded-full bg-white px-2.5 py-1 text-[11px] text-[#2b8a3e]"
              >
                {h.label}
                <span className="opacity-70">
                  {" "}
                  +{h.added}
                  {h.created ? " · new" : ""}
                </span>
              </span>
            ))}
          </div>

          <div className="mt-2 break-words text-[11px] text-[#2f6f3e]">
            {report.residents.map((r) => `${r.name} ${r.phone}`).join(" · ")}
          </div>

          {report.skipped.length > 0 ? (
            <div className="mt-2 text-[11px] text-[#a26a00]">
              Skipped {report.skipped.length} row
              {report.skipped.length === 1 ? "" : "s"} with no readable phone
              number (rows{" "}
              {report.skipped
                .slice(0, 12)
                .map((s) => s.row)
                .join(", ")}
              {report.skipped.length > 12 ? ", …" : ""}).
            </div>
          ) : null}
          {report.truncated > 0 ? (
            <div className="mt-2 text-[11px] text-[#a26a00]">
              {report.truncated} more rows were left out — this importer takes
              1000 at a time.
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-[18px] leading-none text-[#2b8a3e]"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}

/**
 * 只收这三种。**按扩展名判，不看浏览器报的 MIME**——同一个 `.csv` 在不同系统
 * 上 `file.type` 从 `text/csv` 到 `application/vnd.ms-excel` 到空字符串都有，
 * 照 MIME 卡会把正常文件挡在外面。真正读不读得动由服务端说了算。
 */
const SPREADSHEET_EXTENSIONS = [".csv", ".xlsx", ".xls"];

/**
 * 读服务端推回来的 NDJSON：每收到一条 stage 就回调一次，最后那条 report 当
 * 返回值。
 *
 * **单独抽成一个模块级函数，不只是为了短。** 写在 `upload` 里面的话，回调里
 * 给外层变量赋值这件事 TypeScript 的控制流分析看不到——它仍然认为那个变量是
 * 初始值 `null`，后面所有分支都会被收窄成 `never`，报一堆莫名其妙的类型错。
 */
async function readImportStream(
  body: ReadableStream<Uint8Array>,
  onStage: (stage: ImportStage) => void
): Promise<ImportReport | ImportFailure> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let report: ImportReport | ImportFailure | null = null;

  const handleLine = (line: string) => {
    const text = line.trim();
    if (!text) {
      return;
    }
    let event: { type?: string; report?: unknown };
    try {
      event = JSON.parse(text) as { type?: string; report?: unknown };
    } catch {
      // 半行 / 脏行直接跳过。进度是锦上添花，不值得为它把整次导入判失败
      return;
    }
    if (event.type === "stage") {
      onStage(event as unknown as ImportStage);
    } else if (event.type === "report") {
      report = event.report as ImportReport | ImportFailure;
    }
  };

  let reading = true;
  while (reading) {
    const chunk = await reader.read();
    reading = !chunk.done;
    if (chunk.value) {
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split("\n");
      // 最后一段可能是半行，留到下一块再拼
      pending = lines.pop() ?? "";
      for (const line of lines) {
        handleLine(line);
      }
    }
  }
  // 服务端最后一行**不带换行**收尾的话，它还在 pending 里
  handleLine(pending);

  return (
    report ?? {
      ok: false,
      error: "The server closed the connection without answering.",
    }
  );
}

/**
 * 服务端那一步 → 用户看得懂的一句话。
 *
 * **写成大白话，不是日志。** 「identify」对用这个框的人来说没有任何意义，
 * 「Which column holds the phone numbers?」才让他知道机器在忙什么、还要不要
 * 继续等。用词也照着「可能要等一会儿」来排：越靠后的步骤越慢。
 */
function describeStage(stage: ImportStage | null): {
  headline: string;
  detail: string;
} {
  switch (stage?.stage) {
    case "identify":
      return {
        headline: "Reading the columns…",
        detail:
          "Asking the AI which column holds the phone numbers. This is the slow part.",
      };
    case "repair":
      return {
        headline: `Fixing up ${stage.count} phone number${stage.count === 1 ? "" : "s"}…`,
        detail: "Some entries weren't in a standard format, so the AI is having a look.",
      };
    case "write":
      return {
        headline: `Saving resident ${Math.min(stage.done + 1, stage.total)} of ${stage.total}…`,
        detail: "Writing them into the database one by one.",
      };
    case "read":
      return { headline: "Opening the file…", detail: "Reading the first sheet." };
    default:
      return { headline: "Importing…", detail: "Working on it." };
  }
}

/**
 * 导入名单的**长条方框**：拖进来 / Ctrl+V 粘进来 / 点一下选文件，三条路都通。
 *
 * 做成方框而不是按钮，是因为要它同时当**拖放目标**——按钮没有「拖到这儿」的
 * 含义，员工看到按钮不会想到能把文件拖上去。框里用大白话把三种用法写全，
 * 因为用的人不一定熟悉电脑：说「按 Ctrl + V 粘贴」比说「从剪贴板导入」有用。
 *
 * 拖拽和点击交给 `react-dropzone`（成熟、轻、就干这一件事）；**粘贴它不管**
 * （20.1.2 的 dist 里连一个 `paste` 字样都没有），所以下面自己接一个 window
 * 监听——员工不会先点一下框再粘贴，他就是复制完随手一按。
 */
function ImportDropZone({
  importing,
  progress,
  onFile,
}: {
  importing: boolean;
  /**
   * 正在做的那一步 + 已经过去多少秒。**等待本身是可以被讲清楚的**：同样是三十
   * 秒，「Importing…」让人怀疑卡死，而「Asking the AI which column holds the
   * phone numbers… 12s」让人知道它在干活、知道钱花在哪了。
   */
  progress: { headline: string; detail: string; seconds: number } | null;
  onFile: (file: File) => void;
}) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    multiple: false,
    disabled: importing,
    onDrop: (accepted) => {
      const file = accepted[0];
      if (file) {
        onFile(file);
      }
    },
  });

  // `onFile` 每次渲染都是新的箭头函数，用 ref 兜住，免得粘贴的监听每次渲染
  // 都拆了重挂
  const onFileRef = useRef(onFile);
  useEffect(() => {
    onFileRef.current = onFile;
  });

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (importing) {
        return;
      }
      const file = event.clipboardData?.files?.[0];
      // **只有剪贴板里真有文件才接管。** 复制一段文字再按 Ctrl+V 是往左边那个
      // 筛选框里打字，被这里抢走就成了「粘贴没反应」
      if (!file) {
        return;
      }
      event.preventDefault();
      onFileRef.current(file);
    }
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [importing]);

  return (
    <div
      {...getRootProps({
        className: [
          "flex min-w-[260px] flex-1 cursor-pointer items-center gap-3 rounded-lg border-2 border-dashed px-3 py-2 transition-colors",
          isDragActive
            ? "border-[#2f9e44] bg-[#d3f9d8]"
            : "border-[#8ce99a] bg-[#f8fdf9]",
          importing ? "cursor-wait opacity-70" : "hover:bg-[#ebfbee]",
        ].join(" "),
      })}
    >
      <input {...getInputProps({ accept: SPREADSHEET_EXTENSIONS.join(",") })} />
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#2f9e44] text-white">
        {/* 导入中让它转起来。**同一时刻只有这一个动的东西**，静止的界面配上
            一个转圈，一眼就知道「还在跑，不是在等我」 */}
        <UploadIcon className={importing ? "animate-pulse" : undefined} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-bold leading-tight text-[#2b8a3e]">
          {importing
            ? (progress?.headline ?? "Importing…")
            : "Import resident phone numbers"}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-[#5c7a63]">
          {importing
            ? `${progress?.detail ?? "Working on it."}${
                progress && progress.seconds >= 2
                  ? ` · ${progress.seconds}s`
                  : ""
              }`
            : isDragActive
              ? "Let go to import this file."
              : "Drag a file into this box, paste it with Ctrl + V, or click here to pick one. CSV or Excel (.xlsx)."}
        </span>
      </span>
    </div>
  );
}

export function HistoryCanvas({
  households,
  emptyHouseholdCount,
  initialHouseholdId,
}: {
  households: HistoryHousehold[];
  /** 库里还没有任何消息的房子数 */
  emptyHouseholdCount: number;
  initialHouseholdId: string | null;
}) {
  const [householdId, setHouseholdId] = useState(
    initialHouseholdId ?? households[0]?.id ?? ""
  );
  const [query, setQuery] = useState("");
  /**
   * 窄屏下一次只显示一栏，所以得记住在看哪一栏。宽屏两栏并排，用不上这个
   * 状态。带着 ?h= 打开说明是别人分享的链接，直接落到记录栏，别让人再多点
   * 一下。
   */
  const [mobilePane, setMobilePane] = useState<"list" | "chat">(
    initialHouseholdId ? "chat" : "list"
  );

  const household =
    households.find((h) => h.id === householdId) ?? households[0] ?? null;
  const messages = household?.messages ?? [];
  /** 顺序由数据层定死，颜色直接按这个序号的来 */
  const people = household?.people ?? [];

  const viewportRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  /** 导入中 / 上次导入的结果。`null` = 还没导过 */
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<
    ImportReport | { ok: false; error: string } | null
  >(null);
  /** 服务端推过来的当前步骤。导入中才非空 */
  const [stage, setStage] = useState<ImportStage | null>(null);
  const [elapsed, setElapsed] = useState(0);

  /**
   * 秒表。**这是「等很久」最直接的解药**：秒数在跳，就说明还在动。
   *
   * 只在导入期间跑，停下来的时候清掉——不然一个一直在涨的秒数留在界面上，
   * 下次看到会以为又卡住了。
   */
  useEffect(() => {
    if (!importing) {
      return;
    }
    const startedAt = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [importing]);

  /** 人 id → 颜色。整页只有这一处发色，别处一律查这张表 */
  const colorByPerson = useMemo(() => {
    const map = new Map<string, string>();
    people.forEach((p, index) => {
      map.set(p.id, personColor(index));
    });
    return map;
  }, [people]);

  /**
   * 按天插分隔条：一栋房子几十条记录跨好几天，没有日期条就会读串。
   * 在 memo 里算而不是渲染时算，免得渲染过程中改外部变量。
   */
  const rows = useMemo(() => {
    let lastDay = "";
    return messages.map((msg) => {
      const day = DAY_KEY_FMT.format(new Date(msg.sentAt));
      const showDay = day !== lastDay;
      lastDay = day;
      return { msg, showDay };
    });
  }, [messages]);

  const visibleHouseholds = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? households.filter((h) => h.label.toLowerCase().includes(q))
      : households;
  }, [households, query]);

  /**
   * 换房子时落回**开头**，从头读起。
   *
   * 不落到最新那条：这是一份按时间排的记录，进来看到的第一句是中枢的开场白、
   * 或者某人提的第一件事，顺着往下读才看得懂后面在说什么。一进来就吊在尾巴
   * 上，等于把前情提要藏在了上面。
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop = 0;
    }
  }, [household?.id]);

  function switchHousehold(next: string) {
    setHouseholdId(next);
    // 窄屏：选完直接进记录栏，不用再点一次
    setMobilePane("chat");
    // 让 URL 可分享：发给别人时带上 ?h=<房子 id> 直接落在同一套房上
    window.history.replaceState(null, "", `?h=${next}`);
  }

  /**
   * 上传一份名单。**这是整页唯一会写库的动作**，只在拖进来 / 粘进来 / 选中
   * 一个文件时才发生。
   *
   * 服务端做三件事：解析表格 → 一次模型调用认出列 → 逐行走生产的
   * `addResident` 落库。这里只负责把文件递过去、把回执原样摆出来。
   */
  async function upload(file: File) {
    // 拖进来的东西五花八门（照片、压缩包、整个文件夹）。在这里挡一下，比让
    // 服务端去猜、回来报一句「解析不了」要清楚
    const lower = file.name.toLowerCase();
    if (!SPREADSHEET_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      setReport({
        ok: false,
        error: `“${file.name}” isn't a spreadsheet. This box takes .csv, .xlsx or .xls files.`,
      });
      return;
    }
    setImporting(true);
    setStage(null);
    setReport(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/coordination-history/import", {
        method: "POST",
        body,
      });
      if (!response.body) {
        throw new Error("The server closed the connection without answering.");
      }

      // 服务端按 NDJSON 一行一条推。**边收边更新界面**，不是收完再一次性渲染
      // ——那样中途的进度就白推了
      const result = await readImportStream(response.body, setStage);
      setReport(result);
      if (result.ok && result.households.length > 0) {
        // 直接跳到刚写进去的那套房：导完还停在原来那套上，等于要用户自己
        // 去列表里找证据。先选上，再 refresh 让新数据回来填进去。
        switchHousehold(result.households[0].id);
        router.refresh();
      }
    } catch (error) {
      setReport({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStage(null);
      setImporting(false);
    }
  }

  if (!household) {
    return (
      <div className="p-8">
        <div className="text-[15px] font-semibold text-[#212529]">
          No conversation records
        </div>
        {/* 走到这里说明**一栋房子都没有**——空房子现在也进列表，所以
            「有房子但都没说过话」不再落到这一支 */}
        <p className="mt-1 text-[13px] text-[#868e96]">
          No coliving.household rows were found, or POSTGRES_URL was not
          available to this deployment.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-white">
      {/* ── 顶栏 ───────────────────────────────────────────────────── */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[#e9ecef] px-4 py-2.5 sm:px-5 sm:py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Dot color={HUB_COLOR} size={30} square />
          <div className="min-w-0">
            <div className="truncate text-[16px] font-bold leading-tight text-[#212529]">
              Coordination History
            </div>
            <div className="hidden text-[11px] text-[#868e96] sm:block">
              {households.length} unit{households.length === 1 ? "" : "s"}
              {emptyHouseholdCount > 0
                ? ` · ${emptyHouseholdCount} with no messages yet`
                : ""}
            </div>
          </div>
        </div>

        {/* 整页**唯一**会写库的入口。绿色长条方框，跟旁边那排纯展示的文字分明
            是两种东西；窄屏上它自己占一整行 */}
        <ImportDropZone
          importing={importing}
          progress={{ ...describeStage(stage), seconds: elapsed }}
          onFile={upload}
        />
      </header>

      {report ? (
        <ImportResult report={report} onClose={() => setReport(null)} />
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* ── 左：房子列表（宽屏常驻；窄屏是一整屏）──────────────── */}
        <aside
          className={`${
            mobilePane === "chat" ? "hidden" : "flex"
          } w-full shrink-0 flex-col border-[#e9ecef] md:flex md:w-[300px] md:border-r`}
        >
          <div className="border-b border-[#f1f3f5] p-3">
            <TextInput
              size="xs"
              placeholder="Filter units"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            <div className="mt-1.5 text-[11px] text-[#868e96]">
              Showing {visibleHouseholds.length} of {households.length}
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1" type="auto">
            {visibleHouseholds.map((h) => {
              const active = h.id === household.id;
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => switchHousehold(h.id)}
                  className="block w-full border-b border-[#f8f9fa] px-3.5 py-3 text-left"
                  style={{
                    background: active ? "#f3f0ff" : "transparent",
                    borderLeft: `3px solid ${active ? HUB_COLOR : "transparent"}`,
                  }}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className="min-w-0 flex-1 break-words text-[13px] text-[#212529]"
                      style={{ fontWeight: active ? 700 : 500 }}
                    >
                      {h.label}
                    </span>
                    {/* SQL 已经把 is_test 排掉了，这个徽章正常永远不出现。
                        留着是防呆：万一哪天过滤被改坏，测试屋不会假装成
                        真实住户混过去 */}
                    {h.isTest ? (
                      <Badge size="xs" variant="light" color="orange">
                        TEST
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 text-[11px] text-[#868e96]">
                    {h.people.length} resident
                    {h.people.length === 1 ? "" : "s"} · {h.messages.length}{" "}
                    message{h.messages.length === 1 ? "" : "s"}
                  </div>
                  {/* 这栋房子里有谁，用他们各自的颜色点出来——色点跟右边
                      记录栏里的色块是同一个来源 */}
                  <div className="mt-2 flex items-center gap-1">
                    {h.people.slice(0, 8).map((p, index) => (
                      <span
                        key={p.id}
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: personColor(index) }}
                      />
                    ))}
                    <span className="ml-auto text-[11px] text-[#adb5bd]">
                      {h.lastMessageAt
                        ? RAIL_DATE_FMT.format(new Date(h.lastMessageAt))
                        : ""}
                    </span>
                  </div>
                </button>
              );
            })}
            {visibleHouseholds.length === 0 ? (
              <div className="p-4 text-[12px] text-[#868e96]">
                No unit matches “{query}”.
              </div>
            ) : null}
          </ScrollArea>
        </aside>

        {/* ── 右：整栋房子的消息记录（宽屏常驻；窄屏是一整屏）───── */}
        <section
          className={`${
            mobilePane === "list" ? "hidden" : "flex"
          } min-w-0 flex-1 flex-col md:flex`}
        >
          {/* 内容限宽 820px 居中：正文虽然退到次要，行太长一样难读 */}
          <div className="shrink-0 border-b border-[#eef0f3] px-4 py-3">
            <div className="mx-auto flex w-full max-w-[820px] items-start gap-2">
              <button
                type="button"
                onClick={() => setMobilePane("list")}
                className="-ml-1 shrink-0 rounded-md px-1.5 text-[20px] leading-tight text-[#868e96] md:hidden"
                aria-label="Back to units"
              >
                ‹
              </button>
              <div className="min-w-0 flex-1">
                <div className="break-words text-[16px] font-bold text-[#212529]">
                  {household.label}
                </div>
                <div className="mt-0.5 text-[12px] text-[#868e96]">
                  {people.length} resident{people.length === 1 ? "" : "s"} ·{" "}
                  {messages.length === 0
                    ? "no messages yet"
                    : `${messages.length} messages · complete record`}
                </div>
              </div>
            </div>
          </div>

          <ScrollArea
            className="min-h-0 flex-1"
            type="auto"
            viewportRef={viewportRef}
          >
            <div className="mx-auto w-full max-w-[820px]">
              {rows.map(({ msg, showDay }) => (
                <div key={msg.id}>
                  {showDay ? (
                    <div className="sticky top-0 z-10 border-b border-[#f1f3f5] bg-[#fbfbfd] px-4 py-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-[#868e96]">
                        {DAY_LABEL_FMT.format(new Date(msg.sentAt))}
                      </span>
                    </div>
                  ) : null}
                  <MessageRow
                    msg={msg}
                    color={colorByPerson.get(msg.personId) ?? HUB_COLOR}
                  />
                </div>
              ))}
              {/* 还没说过话的房子不是一片空白：**它已经有人了**，只是没人发过
                  消息。尤其刚导完名单，这一屏是用户唯一能确认「人真的进去了」
                  的地方——只写一句「还没有消息」等于让人对着空气怀疑导入成功没有。
                  成员名字用跟上面记录栏**同一个发色规则**，点回有消息的房子时
                  颜色能对上号 */}
              {messages.length === 0 ? (
                <div className="p-4">
                  <div className="text-[13px] text-[#868e96]">
                    No messages in this unit yet.
                  </div>
                  {people.length > 0 ? (
                    <>
                      <div className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-[#adb5bd]">
                        {people.length} resident
                        {people.length === 1 ? "" : "s"} in this unit
                      </div>
                      <ul className="mt-2">
                        {people.map((p, index) => (
                          <li
                            key={p.id}
                            className="flex items-center gap-2.5 border-b border-[#f8f9fa] py-1.5 last:border-b-0"
                          >
                            <Dot color={personColor(index)} size={12} />
                            <span className="min-w-0 flex-1 break-words text-[13px] text-[#212529]">
                              {p.name}
                            </span>
                            {p.role ? (
                              <span className="shrink-0 text-[11px] text-[#adb5bd]">
                                {p.role}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </ScrollArea>
        </section>
      </div>
    </div>
  );
}
