"use client";

import { Badge, ScrollArea, TextInput } from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  HistoryHousehold,
  HistoryMessage,
} from "@/lib/coordination-history/read";

/* ──────────────────────────────────────────────────────────────────────────
 * 两栏：左边房子列表 / 右边整栋房子的消息记录。
 *
 * **每一行要回答的是「谁发给谁」，不是「说了什么」。** 所以一行里发件人和
 * 收件人各占一个色块、各带一个名字，名字比正文大、颜色比正文重，中间一个
 * 箭头指明方向——扫一列箭头就知道这栋房子的往来是怎么流的。正文退到第二行、
 * 小一号、颜色压淡。
 *
 * 色块只有颜色、不带字：29 条记录就是 58 个色块，每个里面都塞两个字的话，
 * 读起来是负担而不是帮助。颜色配着旁边的名字看，一次就记住了。
 *
 * 没有任何数据写入，也没有筛选——从头到尾就是整栋房子的完整记录。
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

/** 纯色块，不带字。中枢是圆角方块，人是圆 */
function Dot({
  color,
  size = 38,
  square = false,
}: {
  color: string;
  size?: number;
  square?: boolean;
}) {
  return (
    <span
      aria-hidden
      className="shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: square ? Math.round(size * 0.3) : 999,
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
      {/* 正文：这页要看的是往来流向，内容退到次要位置——小一号、颜色压淡，
          但仍然逐字照登，不截断、不改写 */}
      <div className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-[1.65] text-[#6c757d]">
        {msg.body}
      </div>
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

  if (!household) {
    return (
      <div className="p-8">
        <div className="text-[15px] font-semibold text-[#212529]">
          No conversation records
        </div>
        <p className="mt-1 text-[13px] text-[#868e96]">
          {emptyHouseholdCount > 0
            ? `${emptyHouseholdCount} households exist in the database, but none has any messages yet.`
            : "No coliving.household rows were found, or POSTGRES_URL was not available to this deployment."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-white">
      {/* ── 顶栏 ───────────────────────────────────────────────────── */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e9ecef] px-4 py-2.5 sm:px-5 sm:py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Dot color={HUB_COLOR} size={30} square />
          <div className="min-w-0">
            <div className="truncate text-[16px] font-bold leading-tight text-[#212529]">
              Coordination History
            </div>
            <div className="text-[11px] text-[#868e96]">
              WillingLink · read-only
            </div>
          </div>
        </div>
        <div className="hidden shrink-0 text-right text-[11px] text-[#868e96] sm:block">
          {households.length} household{households.length === 1 ? "" : "s"}
          {emptyHouseholdCount > 0
            ? ` · ${emptyHouseholdCount} more with no messages`
            : ""}
        </div>
      </header>

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
              placeholder="Filter households"
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
                    {h.people.length} people · {h.messages.length} messages
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
                No household matches “{query}”.
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
                aria-label="Back to households"
              >
                ‹
              </button>
              <div className="min-w-0 flex-1">
                <div className="break-words text-[16px] font-bold text-[#212529]">
                  {household.label}
                </div>
                <div className="mt-0.5 text-[12px] text-[#868e96]">
                  {people.length} people · {messages.length} messages · complete
                  record
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
              {messages.length === 0 ? (
                <div className="p-4 text-[13px] text-[#868e96]">
                  No messages in this household yet.
                </div>
              ) : null}
            </div>
          </ScrollArea>
        </section>
      </div>
    </div>
  );
}
