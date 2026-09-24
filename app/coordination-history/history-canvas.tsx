"use client";

import { Badge, ScrollArea, TextInput } from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  HistoryHousehold,
  HistoryMessage,
  HistoryRole,
} from "@/lib/coordination-history/read";

/* ──────────────────────────────────────────────────────────────────────────
 * 两栏：左边房子列表 / 右边整栋房子的消息记录。
 *
 * 要一眼看出来的那件事是「一个中枢同时在跟好几个人打交道，这句话是在跟谁
 * 说」——所以每一行都同时带**说话人**和**收件人**，收件人名字用他自己的
 * 颜色写，行左侧那条色脊也是他的颜色。扫一眼色脊就知道这栋房子的往来是
 * 在几个人之间怎么交错的，不用点开任何东西。
 *
 * 没有任何数据写入。
 * ────────────────────────────────────────────────────────────────────────── */

/** 中枢自己的颜色。跟任何人都不一样——它永远是个圆角方块，不是圆。 */
const HUB_COLOR = "#5f3dc4";
const HUB_NAME = "WillingLink";

const ROLE_LABEL: Record<HistoryRole, string> = {
  tenant: "Tenant",
  landlord: "Landlord",
  coordinator: "Coordinator",
  other: "Other",
};

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

/**
 * 头像里写什么字。
 *
 * 中文名必须取两个字：「老孙 / 老四」只取首字会双双变成「老」，头像就成了
 * 两个一模一样的圈。拉丁名首字母够用，也更像常规头像。
 */
function avatarText(name: string): string {
  const chars = Array.from(name.trim());
  if (chars.length === 0) {
    return "?";
  }
  const wide = /[^\x20-\x7E]/.test(chars[0]);
  return wide ? chars.slice(0, 2).join("") : chars[0].toUpperCase();
}

function Avatar({
  color,
  name,
  size = 44,
  square = false,
}: {
  color: string;
  name: string;
  size?: number;
  /** 中枢用圆角方块，跟人的圆区分开——颜色之外多一层形状线索 */
  square?: boolean;
}) {
  const text = avatarText(name);
  return (
    <span
      aria-hidden
      className="flex shrink-0 select-none items-center justify-center font-semibold text-white"
      style={{
        width: size,
        height: size,
        borderRadius: square ? Math.round(size * 0.3) : 999,
        background: color,
        fontSize: Math.round(size * (text.length > 1 ? 0.34 : 0.44)),
      }}
    >
      {text}
    </span>
  );
}

/** 记录里的一行。说话人在左、收件人在右，箭头替方向说话。 */
function MessageRow({
  msg,
  color,
  selected,
}: {
  msg: HistoryMessage;
  /** 这行归属的那个人的颜色 */
  color: string;
  selected: boolean;
}) {
  const fromHub = msg.direction === "outbound";

  return (
    <div
      className="flex gap-3 border-b border-[#f4f5f7] py-3 pr-4"
      style={{
        paddingLeft: 13,
        borderLeft: `3px solid ${color}`,
        background: selected ? `${color}0d` : "#fff",
      }}
    >
      <Avatar
        color={fromHub ? HUB_COLOR : color}
        name={fromHub ? HUB_NAME : msg.personName}
        square={fromHub}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span
            className="text-[13px] font-bold"
            style={{ color: fromHub ? HUB_COLOR : color }}
          >
            {fromHub ? HUB_NAME : msg.personName}
          </span>
          <span className="text-[12px] text-[#adb5bd]">→</span>
          <span
            className="text-[12px] font-semibold"
            style={{ color: fromHub ? color : HUB_COLOR }}
          >
            {fromHub ? msg.personName : HUB_NAME}
          </span>
          <span className="ml-auto pl-3 text-[11px] tabular-nums text-[#adb5bd]">
            {TIME_FMT.format(new Date(msg.sentAt))}
          </span>
        </div>
        <div className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-[1.7] text-[#212529]">
          {msg.body}
        </div>
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
  /** 只看某一个人的往来。null = 整栋房子的全部记录 */
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
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

  const countByPerson = useMemo(() => {
    const map = new Map<string, number>();
    for (const msg of messages) {
      map.set(msg.personId, (map.get(msg.personId) ?? 0) + 1);
    }
    return map;
  }, [messages]);

  const selectedPerson = people.find((p) => p.id === selectedPersonId) ?? null;

  /** 点了人就只看这个人的往来；没点就是整栋房子的全部记录 */
  const visibleMessages = useMemo(
    () =>
      selectedPersonId
        ? messages.filter((m) => m.personId === selectedPersonId)
        : messages,
    [messages, selectedPersonId]
  );

  /**
   * 按天插分隔条：一栋房子几十条记录跨好几天，没有日期条就会读串。
   * 在 memo 里算而不是渲染时算，免得渲染过程中改外部变量。
   */
  const rows = useMemo(() => {
    let lastDay = "";
    return visibleMessages.map((msg) => {
      const day = DAY_KEY_FMT.format(new Date(msg.sentAt));
      const showDay = day !== lastDay;
      lastDay = day;
      return { msg, showDay };
    });
  }, [visibleMessages]);

  const visibleHouseholds = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? households.filter((h) => h.label.toLowerCase().includes(q))
      : households;
  }, [households, query]);

  useEffect(() => {
    setSelectedPersonId(null);
  }, [household?.id]);

  /**
   * 换房子、或点名看某人时，落回**开头**，从头读起。
   *
   * 不落到最新那条：这是一份按时间排的记录，进来看到的第一句是中枢的开场白、
   * 或者某人提的第一件事，顺着往下读才看得懂后面在说什么。一进来就吊在尾巴
   * 上，等于把前情提要藏在了上面。两栏宽度下也都是这个行为。
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop = 0;
    }
  }, [household?.id, selectedPersonId]);

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
          <Avatar color={HUB_COLOR} name={HUB_NAME} size={30} square />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-bold leading-tight text-[#212529]">
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
                      记录栏、跟头像里的颜色是同一个来源 */}
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
          {/* 内容限宽 760px 居中：14px 的中文一行大约 50 个字，再宽眼睛
              就要来回扫了。桌面宽屏上不会被拉成一行两百字。 */}
          <div className="shrink-0 border-b border-[#eef0f3] px-4 py-3">
            <div className="mx-auto w-full max-w-[760px]">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => setMobilePane("list")}
                  className="-ml-1 shrink-0 rounded-md px-1.5 text-[20px] leading-tight text-[#868e96] md:hidden"
                  aria-label="Back to households"
                >
                  ‹
                </button>
                <div className="min-w-0 flex-1">
                  <div className="break-words text-[15px] font-bold text-[#212529]">
                    {household.label}
                  </div>
                  <div className="mt-0.5 text-[12px] text-[#868e96]">
                    {people.length} people · {messages.length} messages
                  </div>
                </div>
              </div>

              {/* 选人换成了这一排：每个人一个色点，颜色跟记录栏完全一致 */}
              <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-0.5">
                <button
                  type="button"
                  onClick={() => setSelectedPersonId(null)}
                  className="shrink-0 rounded-full border px-2.5 py-1 text-[12px] font-medium"
                  style={{
                    borderColor: selectedPersonId ? "#e9ecef" : "#212529",
                    background: selectedPersonId ? "#fff" : "#212529",
                    color: selectedPersonId ? "#495057" : "#fff",
                  }}
                >
                  All {messages.length}
                </button>
                {people.map((p) => {
                  const color = colorByPerson.get(p.id) ?? HUB_COLOR;
                  const active = selectedPersonId === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelectedPersonId(active ? null : p.id)}
                      className="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium"
                      style={{
                        borderColor: active ? color : "#e9ecef",
                        background: active ? color : "#fff",
                        color: active ? "#fff" : "#495057",
                      }}
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: active ? "#fff" : color }}
                      />
                      {p.name}
                      <span style={{ opacity: 0.6 }}>
                        {countByPerson.get(p.id) ?? 0}
                      </span>
                    </button>
                  );
                })}
              </div>

              {selectedPerson ? (
                <div className="mt-2 text-[11px] text-[#868e96]">
                  {selectedPerson.role
                    ? ROLE_LABEL[selectedPerson.role]
                    : "Participant"}{" "}
                  · showing only this person’s conversation
                </div>
              ) : null}
            </div>
          </div>

          <ScrollArea
            className="min-h-0 flex-1"
            type="auto"
            viewportRef={viewportRef}
          >
            <div className="mx-auto w-full max-w-[760px]">
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
                    selected={selectedPersonId === msg.personId}
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
