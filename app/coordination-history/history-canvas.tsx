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
  Badge,
  Button,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect, useMemo, useRef, useState } from "react";

import "@xyflow/react/dist/style.css";

import type {
  HistoryHousehold,
  HistoryMessage,
  HistoryRole,
} from "@/lib/coordination-history/read";

/* ──────────────────────────────────────────────────────────────────────────
 * 三栏：左边房子列表 / 中间星形关系图 / 右边完整消息记录。
 *
 * 中间那张图回答的是「一个中枢同时在跟几个人打交道，此刻在跟谁说话」——
 * 这是左右气泡那种一对一界面看不出来的。右边一栏反过来，就是老老实实
 * 按时间顺序把整栋房子的往来摊开、能滚能读：图负责结构，记录负责内容，
 * 两者互相不替代。
 *
 * 没有任何数据写入，也没有播放动画——滚动的控制权完全在人手上。
 * ────────────────────────────────────────────────────────────────────────── */

/** 每个人的固定配色。同一个人在节点、边、记录行上永远是同一个颜色。 */
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
const HUB_NAME = "WillingLink";

const ROLE_LABEL: Record<HistoryRole, string> = {
  tenant: "Tenant",
  landlord: "Landlord",
  coordinator: "Coordinator",
  other: "Other",
};

const ROLE_COLOR: Record<HistoryRole, string> = {
  tenant: "blue",
  landlord: "grape",
  coordinator: "teal",
  other: "gray",
};

const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
});

function fmtTime(iso: string): string {
  return TIME_FMT.format(new Date(iso));
}

function fmtDate(iso: string): string {
  return DATE_FMT.format(new Date(iso));
}

function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/* ── 节点尺寸 ────────────────────────────────────────────────────────────
 * 常量，不是量出来的：手柄位置用这几个数算边框落点。既然尺寸定死，
 * 节点就得真的按这个尺寸渲染，否则实际框比常量高，手柄落进框里，
 * 箭头会被节点盖住——一开始就是这么错的。
 * ─────────────────────────────────────────────────────────────────────── */
const HUB_W = 190;
const HUB_H = 104;
const PERSON_W = 178;
const PERSON_H = 86;

/** 手柄相对节点中心的像素偏移 */
type HandleSpec = { id: string; x: number; y: number };

type CenterData = {
  people: number;
  messages: number;
  handles: HandleSpec[];
};

type PersonData = {
  name: string;
  role: HistoryRole | null;
  color: string;
  count: number;
  lastAt: string | null;
  /** 被选中 / 其余人被压暗 */
  selected: boolean;
  dimmed: boolean;
  handle: { x: number; y: number };
};

const CENTER_NODE_ID = "hub";

function personNodeId(personId: string): string {
  return `p:${personId}`;
}

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
        boxSizing: "border-box",
        padding: 16,
        borderRadius: 18,
        background: `linear-gradient(140deg, ${HUB_COLOR}, #7048e8)`,
        color: "#fff",
        boxShadow: "0 6px 20px rgba(95,61,196,0.3)",
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
      <div style={{ fontSize: 11, letterSpacing: 1.5, opacity: 0.7 }}>
        {HUB_NAME.toUpperCase()}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>
        Coordination Hub
      </div>
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.9 }}>
        {d.people} people · {d.messages} messages
      </div>
    </div>
  );
}

function PersonNode({ data }: NodeProps) {
  const d = data as unknown as PersonData;
  return (
    <div
      style={{
        width: PERSON_W,
        height: PERSON_H,
        boxSizing: "border-box",
        padding: 12,
        borderRadius: 14,
        background: "#fff",
        border: `2px solid ${d.selected ? d.color : "#e9ecef"}`,
        boxShadow: d.selected
          ? `0 0 0 6px ${d.color}22, 0 10px 24px ${d.color}55`
          : "0 2px 8px rgba(16,24,40,0.08)",
        opacity: d.dimmed ? 0.3 : 1,
        transition: "box-shadow 200ms ease, border-color 200ms ease, opacity 200ms ease",
        cursor: "pointer",
      }}
    >
      <Handle
        id="t"
        type="target"
        position={Position.Left}
        style={handleStyle(d.handle.x, d.handle.y)}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
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
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: "#868e96" }}>
        {d.role ? `${ROLE_LABEL[d.role]} · ` : ""}
        {d.count} messages
      </div>
      <div style={{ marginTop: 2, fontSize: 11, color: "#adb5bd" }}>
        {d.lastAt ? `Last ${fmtTime(d.lastAt)}` : "No messages"}
      </div>
    </div>
  );
}

const NODE_TYPES = { hub: HubNode, person: PersonNode };

/** 一圈人围着中心，半径随人数放大，免得挤成一团。角度还要拿去做手柄朝向。 */
function radialLayout(index: number, total: number) {
  const radius = Math.max(300, total * 28 + 180);
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, angle };
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
  /** 选中的那个人：图上高亮他，右边记录里把别人的压暗。不筛掉任何数据。 */
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);

  const household =
    households.find((h) => h.id === householdId) ?? households[0] ?? null;
  const messages = household?.messages ?? [];

  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedPersonId(null);
  }, [household?.id]);

  /** 换房子、或点名看某人时，都落到最新的那一条上 */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [household?.id, selectedPersonId]);

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

  /** 每个人最后一条消息是发出去还是收进来——决定边的箭头朝向 */
  const lastDirectionByPerson = useMemo(() => {
    const map = new Map<string, "inbound" | "outbound">();
    for (const msg of messages) {
      map.set(msg.personId, msg.direction);
    }
    return map;
  }, [messages]);

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
        people: total,
        messages: messages.length,
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
        selected: selectedPersonId === person.id,
        dimmed: selectedPersonId !== null && selectedPersonId !== person.id,
        handle: { x: point.x, y: point.y },
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
  }, [household, stats, messages.length, selectedPersonId, personIndex]);

  const edges = useMemo<Edge[]>(() => {
    if (!household) {
      return [];
    }
    return household.people.map((person, index) => {
      const color = colorFor(personIndex.get(person.id) ?? index);
      const s = stats.get(person.id);
      const isSelected = selectedPersonId === person.id;
      const dimmed = selectedPersonId !== null && !isSelected;
      const direction = lastDirectionByPerson.get(person.id);
      const arrow = { type: MarkerType.ArrowClosed, width: 17, height: 17, color };

      return {
        id: `e:${person.id}`,
        source: CENTER_NODE_ID,
        sourceHandle: `s:${person.id}`,
        target: personNodeId(person.id),
        targetHandle: "t",
        // 中枢发出去的 → 箭头落在人身上；人发过来的 → 箭头落回中枢。
        // 两端手柄都在节点边框上，所以两个箭头都露得出来。
        markerEnd: direction !== "inbound" ? arrow : undefined,
        markerStart: direction === "inbound" ? arrow : undefined,
        label: s?.count ? String(s.count) : undefined,
        labelShowBg: true,
        labelBgPadding: [5, 2] as [number, number],
        labelBgBorderRadius: 8,
        labelBgStyle: {
          fill: isSelected ? color : "#ffffff",
          fillOpacity: isSelected ? 1 : 0.9,
        },
        labelStyle: {
          fill: isSelected ? "#fff" : "#868e96",
          fontSize: 11,
          fontWeight: 600,
        },
        style: {
          stroke: color,
          strokeWidth: isSelected ? 3.5 : 1.6,
          strokeOpacity: dimmed ? 0.15 : isSelected ? 1 : 0.5,
          transition: "stroke-width 200ms ease, stroke-opacity 200ms ease",
        },
      } satisfies Edge;
    });
  }, [household, stats, selectedPersonId, lastDirectionByPerson, personIndex]);

  const visibleHouseholds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return households;
    }
    return households.filter((h) => h.label.toLowerCase().includes(q));
  }, [households, query]);

  const selectedPerson =
    household?.people.find((p) => p.id === selectedPersonId) ?? null;

  /** 点了人就只看这个人的往来；没点就是整栋房子的全部记录 */
  const visibleMessages = useMemo(
    () =>
      selectedPersonId
        ? messages.filter((m) => m.personId === selectedPersonId)
        : messages,
    [messages, selectedPersonId]
  );

  function switchHousehold(next: string) {
    setHouseholdId(next);
    // 让 URL 可分享：发给别人时带上 ?h=<房子 id> 直接落在同一套房上
    window.history.replaceState(null, "", `?h=${next}`);
  }

  function togglePerson(personId: string) {
    setSelectedPersonId((current) => (current === personId ? null : personId));
  }

  if (!household) {
    return (
      <Paper withBorder p="xl" radius="md" m="xl">
        <Stack gap={6}>
          <Text fw={600}>No conversation records</Text>
          <Text size="sm" c="dimmed">
            {emptyHouseholdCount > 0
              ? `${emptyHouseholdCount} households exist in the database, but none has any messages yet.`
              : "No coliving.household rows were found, or POSTGRES_URL was not available to this deployment."}
          </Text>
        </Stack>
      </Paper>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <Paper
        shadow="xs"
        radius={0}
        px="lg"
        py="xs"
        style={{ borderBottom: "1px solid #e9ecef", zIndex: 5 }}
      >
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Text fw={700}>Coordination History</Text>
            <Badge variant="light" color="violet">
              Read-only
            </Badge>
            {household.isTest ? (
              <Badge variant="light" color="orange">
                Test household
              </Badge>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed">
            {households.length} households with messages
            {emptyHouseholdCount > 0
              ? ` · ${emptyHouseholdCount} more with none`
              : ""}
          </Text>
        </Group>
      </Paper>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* ── 左：房子列表（常驻，不折进下拉框）───────────────────── */}
        <Paper
          w={296}
          radius={0}
          style={{
            borderRight: "1px solid #e9ecef",
            display: "flex",
            flexDirection: "column",
            flex: "0 0 auto",
          }}
        >
          <div style={{ padding: 12, borderBottom: "1px solid #f1f3f5" }}>
            <TextInput
              size="xs"
              placeholder="Filter households"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            <Text size="xs" c="dimmed" mt={6}>
              Showing {visibleHouseholds.length} of {households.length}
            </Text>
          </div>
          <ScrollArea style={{ flex: 1 }} type="auto">
            {visibleHouseholds.map((h) => {
              const active = h.id === household.id;
              return (
                <div
                  key={h.id}
                  onClick={() => switchHousehold(h.id)}
                  style={{
                    padding: "10px 12px",
                    borderBottom: "1px solid #f8f9fa",
                    cursor: "pointer",
                    background: active ? "#f3f0ff" : "transparent",
                    borderLeft: active
                      ? `3px solid ${HUB_COLOR}`
                      : "3px solid transparent",
                  }}
                >
                  <Group gap={6} wrap="nowrap" align="flex-start">
                    <Text
                      size="xs"
                      fw={active ? 700 : 500}
                      style={{ wordBreak: "break-all", flex: 1 }}
                    >
                      {h.label}
                    </Text>
                    {h.isTest ? (
                      <Badge size="xs" variant="light" color="orange">
                        TEST
                      </Badge>
                    ) : null}
                  </Group>
                  <Text size="xs" c="dimmed" mt={2}>
                    {h.people.length} people · {h.messages.length} messages
                    {h.lastMessageAt ? ` · ${fmtDate(h.lastMessageAt)}` : ""}
                  </Text>
                </div>
              );
            })}
            {visibleHouseholds.length === 0 ? (
              <Text size="xs" c="dimmed" p="md">
                No household matches “{query}”.
              </Text>
            ) : null}
          </ScrollArea>
        </Paper>

        {/* ── 中：星形关系图 ─────────────────────────────────────── */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            position: "relative",
            background: "#fbfbfd",
          }}
        >
          <ReactFlow
            key={household.id}
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            nodeOrigin={[0.5, 0.5]}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            onNodeClick={(_, node) => {
              if (node.id.startsWith("p:")) {
                togglePerson(node.id.slice(2));
              }
            }}
            onPaneClick={() => setSelectedPersonId(null)}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1}
              color="#d6d9e0"
            />
            <Controls showInteractive={false} />
          </ReactFlow>
          <Text
            size="xs"
            c="dimmed"
            style={{ position: "absolute", left: 14, bottom: 12 }}
          >
            {selectedPerson
              ? `Showing only ${selectedPerson.name} — click again, or Show all, to go back`
              : "Click a person to see only their conversation"}
          </Text>
        </div>

        {/* ── 右：整栋房子的消息记录（可滚动）────────────────────── */}
        <Paper
          w={520}
          radius={0}
          style={{
            borderLeft: "1px solid #e9ecef",
            display: "flex",
            flexDirection: "column",
            flex: "0 0 auto",
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid #f1f3f5",
              background: "#fff",
            }}
          >
            <Group justify="space-between" wrap="nowrap">
              <Text fw={600} size="sm">
                {selectedPerson
                  ? `${selectedPerson.name} — ${stats.get(selectedPerson.id)?.count ?? 0} of ${messages.length} messages`
                  : `All messages — ${messages.length}`}
              </Text>
              {selectedPerson ? (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => setSelectedPersonId(null)}
                >
                  Show all
                </Button>
              ) : null}
            </Group>
            <Text size="xs" c="dimmed" mt={2} style={{ wordBreak: "break-all" }}>
              {household.label}
            </Text>
          </div>

          <ScrollArea style={{ flex: 1 }} type="auto" viewportRef={viewportRef}>
            {visibleMessages.map((msg: HistoryMessage, index: number) => {
              const fromHub = msg.direction === "outbound";
              const color = colorFor(personIndex.get(msg.personId) ?? 0);
              const speaker = fromHub ? HUB_NAME : msg.personName;
              const audience = fromHub ? msg.personName : HUB_NAME;

              return (
                // 记录栏是「读」的地方，不挂点击——点一下就换视图会让人读不下去。
                // 选人只从中间那张图上选。
                <div
                  key={msg.id ?? index}
                  style={{
                    display: "flex",
                    gap: 10,
                    padding: "10px 16px",
                    borderBottom: "1px solid #f8f9fa",
                    borderLeft: `4px solid ${
                      selectedPersonId ? color : "transparent"
                    }`,
                  }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 999,
                      marginTop: 5,
                      background: fromHub ? HUB_COLOR : color,
                      flex: "0 0 auto",
                    }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Group gap={6} wrap="nowrap">
                      <Text size="xs" fw={700} style={{ flex: "0 0 auto" }}>
                        {speaker}
                      </Text>
                      <Text size="xs" c="dimmed" style={{ flex: "0 0 auto" }}>
                        → {audience}
                      </Text>
                      <div style={{ flex: 1 }} />
                      <Text size="xs" c="dimmed" style={{ flex: "0 0 auto" }}>
                        {fmtTime(msg.sentAt)}
                      </Text>
                    </Group>
                    <Text
                      size="sm"
                      mt={3}
                      style={{ whiteSpace: "pre-wrap", lineHeight: 1.65 }}
                    >
                      {msg.body}
                    </Text>
                  </div>
                </div>
              );
            })}
            {messages.length === 0 ? (
              <Text size="sm" c="dimmed" p="md">
                No messages in this household yet.
              </Text>
            ) : null}
          </ScrollArea>
        </Paper>
      </div>
    </div>
  );
}
