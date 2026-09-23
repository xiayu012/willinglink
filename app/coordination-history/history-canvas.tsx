"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  ActionIcon,
  Badge,
  Divider,
  Group,
  Paper,
  ScrollArea,
  Select,
  Slider,
  Stack,
  Text,
  Timeline,
  Tooltip,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";

import "@xyflow/react/dist/style.css";

import type {
  HistoryHousehold,
  HistoryMessage,
  HistoryRole,
} from "@/lib/coordination-history/read";

/* ──────────────────────────────────────────────────────────────────────────
 * 展示层
 *
 * 刻意不是「左右气泡」那种一对一聊天界面。默认视图是一张**星形图**：
 * 中间一个枢纽节点（AI 协调方），四周一圈人。任何时刻只有一条边是亮的，
 * 那条边就是「中枢此刻在跟谁说话」。时间轴一推，亮点在人与人之间跳。
 *
 * 人和消息都来自数据库，这里只做布局与着色，不改任何数据。
 * ────────────────────────────────────────────────────────────────────────── */

/** 每个人的固定配色。同一个人在他的节点、边、时间轴色块上永远是同一个颜色，
 *  这样「中枢在对谁说话」不需要读名字就能看出来。 */
const PALETTE = [
  "#4c6ef5",
  "#12b886",
  "#f76707",
  "#e8590c",
  "#ae3ec9",
  "#0ca678",
  "#d6336c",
  "#3b5bdb",
  "#f59f00",
  "#1c7ed6",
];

const HUB_COLOR = "#5f3dc4";

const ROLE_LABEL: Record<HistoryRole, string> = {
  tenant: "住户",
  landlord: "房东",
  coordinator: "协调方",
  other: "其他",
};

const ROLE_COLOR: Record<HistoryRole, string> = {
  tenant: "blue",
  landlord: "grape",
  coordinator: "teal",
  other: "gray",
};

const TIME_FMT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "America/Los_Angeles",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function fmtTime(iso: string): string {
  return TIME_FMT.format(new Date(iso));
}

function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/**
 * 节点尺寸**是常量，不是量出来的**——手柄位置在上面的 `borderPoint` 里用这
 * 几个数算边框落点。既然尺寸定死，节点也得真的按这个尺寸渲染（下面 style 里
 * 写死 width/height，条件渲染的那行用 `visibility` 占位而不是不渲染），
 * 否则实际框比常量高，手柄就落进框里，箭头被节点盖住。
 */
const HUB_W = 188;
const HUB_H = 122;
const PERSON_W = 172;
const PERSON_H = 92;

/** 一个手柄摆在哪儿：相对节点中心的像素偏移 */
type HandleSpec = { id: string; x: number; y: number };

type CenterData = {
  speaker: string | null;
  /** true = 中枢说的是「发出」，false = 「收到」 */
  speakerOutbound: boolean;
  speaking: boolean;
  /** 每个邻居一个手柄，摆在枢纽方框朝向那个人的那一边 */
  handles: HandleSpec[];
};

type PersonData = {
  name: string;
  role: HistoryRole | null;
  color: string;
  count: number;
  lastAt: string | null;
  active: boolean;
  /** 朝向枢纽那一边的手柄 */
  handle: { x: number; y: number };
  isTest: boolean;
};

const CENTER_NODE_ID = "hub";

function personNodeId(personId: string): string {
  return `p:${personId}`;
}

/**
 * 射线打到方框边上的落点。
 *
 * **手柄不能摆在节点正中心。** 边画到手柄位置结束，而节点是盖在边上面的，
 * 摆在中心等于把箭头藏进节点里——图上看不出方向，而「中枢在对谁说话、
 * 说还是听」正是这一页要讲的事。摆在边框上箭头才露得出来。
 *
 * 用固定宽高算而不是量 DOM：节点尺寸本来就是这里定死的常量，量 DOM 反而
 * 要等布局完成，首帧会闪。
 */
function borderPoint(angle: number, width: number, height: number) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const t = Math.min(
    width / 2 / Math.max(Math.abs(cos), 1e-6),
    height / 2 / Math.max(Math.abs(sin), 1e-6)
  );
  return { x: cos * t, y: sin * t };
}

function handleStyle(x: number, y: number): React.CSSProperties {
  return {
    opacity: 0,
    left: `calc(50% + ${x}px)`,
    top: `calc(50% + ${y}px)`,
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
  };
}

function HubNode({ data }: NodeProps) {
  const d = data as unknown as CenterData;
  return (
    <div
      style={{
        width: HUB_W,
        height: HUB_H,
        padding: "16px",
        boxSizing: "border-box",
        borderRadius: 18,
        background: `linear-gradient(140deg, ${HUB_COLOR}, #7048e8)`,
        color: "#fff",
        boxShadow: d.speaking
          ? `0 0 0 6px rgba(112,72,232,0.22), 0 10px 30px rgba(95,61,196,0.45)`
          : "0 6px 20px rgba(95,61,196,0.28)",
        transition: "box-shadow 220ms ease",
        textAlign: "center",
      }}
    >
      {d.handles.map((h) => (
        <Handle
          key={h.id}
          id={h.id}
          type="source"
          position={Position.Right}
          style={handleStyle(h.x, h.y)}
        />
      ))}
      <div style={{ fontSize: 11, letterSpacing: 1, opacity: 0.75 }}>
        WILLINGLINK
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
        合租协调中枢
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 12,
          opacity: 0.95,
          minHeight: 18,
          fontWeight: 500,
        }}
      >
        {d.speaker
          ? `${d.speakerOutbound ? "→ 正在对" : "← 刚收到"} ${d.speaker}${
              d.speakerOutbound ? " 说" : ""
            }`
          : "—"}
      </div>
    </div>
  );
}

function PersonNode({ data }: NodeProps) {
  const d = data as unknown as PersonData;
  const scale = d.active ? 1.1 : 1;
  return (
    <div
      style={{
        width: PERSON_W,
        height: PERSON_H,
        padding: "12px",
        boxSizing: "border-box",
        borderRadius: 14,
        background: "#fff",
        border: `2px solid ${d.active ? d.color : "#e9ecef"}`,
        boxShadow: d.active
          ? `0 0 0 6px ${d.color}22, 0 10px 24px ${d.color}55`
          : "0 2px 8px rgba(16,24,40,0.08)",
        transform: `scale(${scale})`,
        transition: "transform 200ms ease, box-shadow 200ms ease, border-color 200ms ease",
        opacity: d.active ? 1 : 0.82,
      }}
    >
      <Handle
        id="t"
        type="target"
        position={Position.Left}
        style={handleStyle(d.handle.x, d.handle.y)}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: d.color,
            flex: "0 0 auto",
          }}
        />
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {d.name}
        </span>
        {d.role ? (
          <span
            style={{
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 999,
              background: "#f1f3f5",
              color: "#495057",
              flex: "0 0 auto",
            }}
          >
            {ROLE_LABEL[d.role]}
          </span>
        ) : null}
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: "#868e96" }}>
        {d.count} 条 · {d.lastAt ? fmtTime(d.lastAt) : "无记录"}
      </div>
      {/* 这一行永远占位，只是没轮到时看不见——高度写死才跟 PERSON_H 对得上 */}
      <div
        style={{
          marginTop: 6,
          fontSize: 11,
          fontWeight: 600,
          color: d.color,
          visibility: d.active ? "visible" : "hidden",
        }}
      >
        ● 此刻正在对话
      </div>
    </div>
  );
}

const NODE_TYPES = { hub: HubNode, person: PersonNode };

/** 一圈人围着中心，半径随人数放大，免得挤成一团。角度还要拿去做手柄朝向。 */
function radialLayout(index: number, total: number) {
  const radius = Math.max(320, total * 30 + 180);
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, angle };
}

export function HistoryCanvas({
  households,
  emptyHouseholdCount,
  initialHouseholdId,
}: {
  households: HistoryHousehold[];
  /** 库里还没有任何消息的房子数。下面会标一句，不假装它们不存在 */
  emptyHouseholdCount: number;
  initialHouseholdId: string | null;
}) {
  const [householdId, setHouseholdId] = useState(
    initialHouseholdId ?? households[0]?.id ?? ""
  );
  const household =
    households.find((h) => h.id === householdId) ?? households[0] ?? null;

  const messages = household?.messages ?? [];

  /** 时间轴位置。默认停在最新一条——打开就是「现在的状态」 */
  const [cursor, setCursor] = useState(Math.max(messages.length - 1, 0));
  const [playing, setPlaying] = useState(false);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);

  useEffect(() => {
    setCursor(Math.max(messages.length - 1, 0));
    setPlaying(false);
    setSelectedPersonId(null);
  }, [messages.length, household?.id]);

  useEffect(() => {
    if (!playing || messages.length === 0) {
      return;
    }
    const timer = setInterval(() => {
      setCursor((current) => {
        if (current >= messages.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 1100);
    return () => clearInterval(timer);
  }, [playing, messages.length]);

  const personIndex = useMemo(() => {
    const map = new Map<string, number>();
    household?.people.forEach((p, i) => {
      map.set(p.id, i);
    });
    return map;
  }, [household]);

  const stats = useMemo(() => {
    const map = new Map<string, { count: number; lastAt: string | null }>();
    for (const msg of messages) {
      const entry = map.get(msg.personId) ?? { count: 0, lastAt: null };
      entry.count += 1;
      entry.lastAt = msg.sentAt;
      map.set(msg.personId, entry);
    }
    return map;
  }, [messages]);

  const activeMessage: HistoryMessage | null = messages[cursor] ?? null;

  // 时间轴上「此刻」之前已经说过话的人，用来决定边的箭头朝向：
  // 最后一次是中枢发出去的，箭头就指向那个人；反之指向中枢。
  const lastDirectionByPerson = useMemo(() => {
    const map = new Map<string, "inbound" | "outbound">();
    for (let i = 0; i <= cursor && i < messages.length; i += 1) {
      map.set(messages[i].personId, messages[i].direction);
    }
    return map;
  }, [messages, cursor]);

  const nodes = useMemo<Node[]>(() => {
    if (!household) {
      return [];
    }
    const total = household.people.length;
    const layouts = household.people.map((_, index) => radialLayout(index, total));

    const hub: Node = {
      id: CENTER_NODE_ID,
      type: "hub",
      position: { x: 0, y: 0 },
      draggable: true,
      data: {
        speaker: activeMessage ? activeMessage.personName : null,
        speakerOutbound: activeMessage?.direction === "outbound",
        speaking: Boolean(activeMessage),
        handles: household.people.map((person, index) => {
          const point = borderPoint(layouts[index].angle, HUB_W, HUB_H);
          return { id: `s:${person.id}`, x: point.x, y: point.y };
        }),
      } satisfies CenterData as unknown as Record<string, unknown>,
    };

    const people: Node[] = household.people.map((person, index) => {
      const s = stats.get(person.id);
      // 人这一边的手柄朝回枢纽，也就是他所在角度的反方向
      const point = borderPoint(layouts[index].angle + Math.PI, PERSON_W, PERSON_H);
      const data: PersonData = {
        name: person.name,
        role: person.role,
        color: colorFor(personIndex.get(person.id) ?? index),
        count: s?.count ?? 0,
        lastAt: s?.lastAt ?? null,
        active: activeMessage?.personId === person.id,
        handle: { x: point.x, y: point.y },
        isTest: household.isTest,
      };
      return {
        id: personNodeId(person.id),
        type: "person",
        position: { x: layouts[index].x, y: layouts[index].y },
        draggable: true,
        data: data as unknown as Record<string, unknown>,
      };
    });

    return [hub, ...people];
  }, [household, stats, activeMessage, personIndex]);

  const edges = useMemo<Edge[]>(() => {
    if (!household) {
      return [];
    }
    return household.people.map((person, index) => {
      const color = colorFor(personIndex.get(person.id) ?? index);
      const s = stats.get(person.id);
      const isActive = activeMessage?.personId === person.id;
      const direction = lastDirectionByPerson.get(person.id);
      const arrow = { type: MarkerType.ArrowClosed, width: 18, height: 18, color };

      return {
        id: `e:${person.id}`,
        source: CENTER_NODE_ID,
        sourceHandle: `s:${person.id}`,
        target: personNodeId(person.id),
        targetHandle: "t",
        // 中枢发出去的 → 箭头落在人身上；人发过来的 → 箭头落回中枢。
        // 两端的手柄都在节点边框上，所以两个箭头都露得出来。
        markerEnd: direction === "outbound" || direction === undefined ? arrow : undefined,
        markerStart: direction === "inbound" ? arrow : undefined,
        animated: isActive,
        label: s?.count ? String(s.count) : undefined,
        labelShowBg: true,
        labelBgPadding: [5, 2] as [number, number],
        labelBgBorderRadius: 8,
        labelBgStyle: { fill: isActive ? color : "#ffffff", fillOpacity: isActive ? 1 : 0.9 },
        labelStyle: { fill: isActive ? "#fff" : "#868e96", fontSize: 11, fontWeight: 600 },
        style: {
          stroke: color,
          strokeWidth: isActive ? 3.5 : 1.4,
          strokeOpacity: isActive ? 1 : 0.35,
          transition: "stroke-width 200ms ease, stroke-opacity 200ms ease",
        },
      } satisfies Edge;
    });
  }, [household, stats, activeMessage, lastDirectionByPerson, personIndex]);

  const selectedPerson =
    household?.people.find((p) => p.id === selectedPersonId) ?? null;

  const selectedThread = useMemo(
    () => (selectedPerson ? messages.filter((m) => m.personId === selectedPerson.id) : []),
    [messages, selectedPerson]
  );

  const recentStrip = useMemo(() => messages.slice(Math.max(cursor - 11, 0), cursor + 1), [
    messages,
    cursor,
  ]);

  function switchHousehold(next: string | null) {
    setHouseholdId(next ?? "");
    // 让 URL 可分享：发给别人时带上 ?h=<房子 id> 直接落在同一套房上
    if (next) {
      window.history.replaceState(null, "", `?h=${next}`);
    }
  }

  if (!household) {
    return (
      <Paper withBorder p="xl" radius="md" m="xl">
        <Stack gap={6}>
          <Text fw={600}>没有读到任何聊天记录</Text>
          <Text size="sm" c="dimmed">
            {emptyHouseholdCount > 0
              ? `库里有 ${emptyHouseholdCount} 栋房子，但都还没有消息。`
              : "数据库里还没有 coliving.household 记录，或者这次连接没有拿到 POSTGRES_URL。"}
            页面本身是好的——有数据就会显示。
          </Text>
        </Stack>
      </Paper>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      {/* ── 顶部控制条 ─────────────────────────────────────────────── */}
      <Paper
        shadow="xs"
        radius={0}
        px="lg"
        py="sm"
        style={{ borderBottom: "1px solid #e9ecef", zIndex: 5 }}
      >
        <Group justify="space-between" wrap="nowrap" gap="md">
          <Group gap="sm" wrap="nowrap">
            <Text fw={700} size="md">
              Coordination history
            </Text>
            <Badge variant="light" color="violet">
              只读
            </Badge>
            {household.isTest ? (
              <Badge variant="light" color="orange">
                隔离测试屋
              </Badge>
            ) : null}
          </Group>

          <Group gap="sm" wrap="nowrap">
            <Select
              size="xs"
              w={280}
              value={household.id}
              onChange={switchHousehold}
              allowDeselect={false}
              data={households.map((h) => ({
                value: h.id,
                label: `${h.label}　·　${h.people.length} 人 / ${h.messages.length} 条${
                  h.isTest ? "（测试）" : ""
                }`,
              }))}
            />
            <Text size="xs" c="dimmed">
              {activeMessage
                ? `${fmtTime(activeMessage.sentAt)} · 第 ${cursor + 1}/${messages.length} 条`
                : "无消息"}
            </Text>
            {emptyHouseholdCount > 0 ? (
              <Text size="xs" c="dimmed">
                另有 {emptyHouseholdCount} 栋房暂无消息
              </Text>
            ) : null}
          </Group>
        </Group>
      </Paper>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* ── 星形图 ──────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, position: "relative", background: "#fbfbfd" }}>
          <ReactFlow
            key={household.id}
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            nodeOrigin={[0.5, 0.5]}
            fitView
            fitViewOptions={{ padding: 0.22 }}
            minZoom={0.2}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, node) => {
              if (node.id.startsWith("p:")) {
                setSelectedPersonId(node.id.slice(2));
              }
            }}
            onPaneClick={() => setSelectedPersonId(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d6d9e0" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {/* ── 右侧详情 ────────────────────────────────────────────── */}
        <Paper
          w={380}
          style={{ borderLeft: "1px solid #e9ecef", display: "flex", flexDirection: "column" }}
          radius={0}
        >
          <ScrollArea style={{ flex: 1 }} p="md" type="auto">
            {selectedPerson ? (
              <Stack gap="sm">
                <Group justify="space-between">
                  <Group gap={8}>
                    <Text fw={600}>{selectedPerson.name}</Text>
                    {selectedPerson.role ? (
                      <Badge size="sm" variant="light" color={ROLE_COLOR[selectedPerson.role]}>
                        {ROLE_LABEL[selectedPerson.role]}
                      </Badge>
                    ) : null}
                  </Group>
                  <ActionIcon variant="subtle" onClick={() => setSelectedPersonId(null)}>
                    ✕
                  </ActionIcon>
                </Group>
                <Text size="xs" c="dimmed">
                  与中枢的完整往来 · 共 {selectedThread.length} 条
                </Text>
                <Divider />
                <Timeline active={selectedThread.length - 1} bulletSize={16} lineWidth={2}>
                  {selectedThread.map((msg) => {
                    const fromHub = msg.direction === "outbound";
                    const color = colorFor(
                      personIndex.get(msg.personId) ?? 0
                    );
                    return (
                      <Timeline.Item
                        key={msg.id}
                        bullet={
                          <span
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 999,
                              background: fromHub ? HUB_COLOR : color,
                            }}
                          />
                        }
                        title={
                          <Group gap={6}>
                            <Text size="xs" fw={600}>
                              {fromHub ? "中枢 → " : "← "}
                              {fromHub ? selectedPerson.name : "中枢"}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {fmtTime(msg.sentAt)}
                            </Text>
                          </Group>
                        }
                      >
                        <Text size="sm" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                          {msg.body}
                        </Text>
                      </Timeline.Item>
                    );
                  })}
                </Timeline>
              </Stack>
            ) : (
              <Stack gap="sm">
                <Text fw={600} size="sm">
                  此刻
                </Text>
                {activeMessage ? (
                  <>
                    <Group gap={8}>
                      <Badge
                        variant="light"
                        color={activeMessage.direction === "outbound" ? "violet" : "teal"}
                      >
                        {activeMessage.direction === "outbound" ? "中枢发出" : "对方发来"}
                      </Badge>
                      <Text fw={600}>{activeMessage.personName}</Text>
                    </Group>
                    <Text size="xs" c="dimmed">
                      {fmtTime(activeMessage.sentAt)} · {activeMessage.channel}
                    </Text>
                    <Paper withBorder p="sm" radius="md" bg="#f8f9fa">
                      <Text size="sm" style={{ whiteSpace: "pre-wrap", lineHeight: 1.65 }}>
                        {activeMessage.body}
                      </Text>
                    </Paper>
                  </>
                ) : (
                  <Text size="sm" c="dimmed">
                    这套房还没有消息。
                  </Text>
                )}

                <Divider label="这栋房子的人" labelPosition="left" mt="sm" />
                <Stack gap={6}>
                  {household.people.map((person, index) => {
                    const s = stats.get(person.id);
                    return (
                      <Group
                        key={person.id}
                        justify="space-between"
                        wrap="nowrap"
                        style={{ cursor: "pointer" }}
                        onClick={() => setSelectedPersonId(person.id)}
                      >
                        <Group gap={8} wrap="nowrap">
                          <span
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 999,
                              background: colorFor(personIndex.get(person.id) ?? index),
                              flex: "0 0 auto",
                            }}
                          />
                          <Text size="sm">{person.name}</Text>
                          {person.role ? (
                            <Badge size="xs" variant="light" color={ROLE_COLOR[person.role]}>
                              {ROLE_LABEL[person.role]}
                            </Badge>
                          ) : null}
                        </Group>
                        <Text size="xs" c="dimmed">
                          {s?.count ?? 0} 条
                        </Text>
                      </Group>
                    );
                  })}
                </Stack>
              </Stack>
            )}
          </ScrollArea>
        </Paper>
      </div>

      {/* ── 底部时间轴 ──────────────────────────────────────────── */}
      <Paper
        radius={0}
        px="lg"
        py="sm"
        style={{ borderTop: "1px solid #e9ecef", background: "#fff", zIndex: 5 }}
      >
        <Stack gap={8}>
          {/* 最近发言序列：一眼看出中枢是在几个人之间来回，而不是一对一线程 */}
          <Group gap={4} wrap="nowrap" align="center">
            <Text size="xs" c="dimmed" style={{ flex: "0 0 auto" }}>
              最近往返
            </Text>
            <div style={{ display: "flex", gap: 3, flexWrap: "nowrap", overflow: "hidden" }}>
              {recentStrip.map((msg, i) => {
                const absolute = cursor - recentStrip.length + 1 + i;
                const color = colorFor(personIndex.get(msg.personId) ?? 0);
                const isNow = absolute === cursor;
                return (
                  <Tooltip
                    key={msg.id}
                    label={`${msg.personName} · ${fmtTime(msg.sentAt)}`}
                    withArrow
                    openDelay={120}
                  >
                    <span
                      onClick={() => setCursor(absolute)}
                      style={{
                        width: isNow ? 30 : 20,
                        height: 8,
                        borderRadius: 999,
                        background: color,
                        opacity: isNow ? 1 : 0.4,
                        cursor: "pointer",
                        transition: "width 160ms ease, opacity 160ms ease",
                        flex: "0 0 auto",
                      }}
                    />
                  </Tooltip>
                );
              })}
            </div>
            <Text size="xs" c="dimmed">
              {household.people.length} 人
            </Text>
          </Group>

          <Group gap="md" wrap="nowrap">
            <ActionIcon
              variant={playing ? "filled" : "light"}
              color="violet"
              onClick={() => {
                if (cursor >= messages.length - 1) {
                  setCursor(0);
                }
                setPlaying((p) => !p);
              }}
              disabled={messages.length < 2}
            >
              {playing ? "❚❚" : "▶"}
            </ActionIcon>
            <Slider
              style={{ flex: 1 }}
              min={0}
              max={Math.max(messages.length - 1, 0)}
              value={cursor}
              onChange={(value) => {
                setPlaying(false);
                setCursor(value);
              }}
              label={(value) =>
                messages[value] ? `${messages[value].personName}` : ""
              }
              disabled={messages.length < 2}
            />
            <Text size="xs" c="dimmed" style={{ flex: "0 0 auto", minWidth: 130 }}>
              {activeMessage ? fmtTime(activeMessage.sentAt) : "—"}
            </Text>
          </Group>
        </Stack>
      </Paper>
    </div>
  );
}
