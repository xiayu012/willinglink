import "server-only";

import postgres from "postgres";

/**
 * 「协调历史」公开只读页的数据访问层。
 *
 * **这个模块故意不引用 `lib/chat/coliving/` 任何东西。** 那个目录是生产大脑，
 * 每轮对话都在动；这个页面只是把已经落库的 message 原样摊开给人看。两边
 * 共用代码的收益（少写几十行 SQL）远小于代价（大脑改一次就要回归这个页面，
 * 或者反过来这个页面的需求把大脑的 repo 撑大）。所以这里自带一份只读查询。
 *
 * 三条硬性质：
 *   · **只读**——本文件里没有 insert / update / delete，也不引入 guard.ts。
 *   · **不改 schema**——建表的事实来源仍是 `lib/db/migrations/manual/coliving-world.sql`。
 *   · **出错不拖垮主站**——查询失败或没有 POSTGRES_URL 时返回空集，页面照常渲染。
 */

let client: postgres.Sql | null = null;

function db(): postgres.Sql | null {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    return null;
  }
  if (!client) {
    client = postgres(url, { max: 2, idle_timeout: 20 });
  }
  return client;
}

/** 单套房最多带多少条消息 —— 演示页不需要全量，防止一栋老房子把页面拖死 */
const MESSAGES_PER_HOUSEHOLD = 400;

export type HistoryRole = "tenant" | "landlord" | "coordinator" | "other";

export type HistoryPerson = {
  id: string;
  name: string;
  /** 当前生效关系里的身份；只从消息里认出来的人没有这个字段 */
  role: HistoryRole | null;
  resides: boolean | null;
};

export type HistoryMessage = {
  id: string;
  personId: string;
  personName: string;
  /** inbound = 这个人发给中枢，outbound = 中枢发给这个人 */
  direction: "inbound" | "outbound";
  body: string;
  /** ISO 字符串，格式化在展示层做 */
  sentAt: string;
  channel: string;
};

export type HistoryHousehold = {
  id: string;
  label: string;
  status: string;
  /** 隔离测试屋。页面上标出来，免得演示时把测试数据当成真实住户 */
  isTest: boolean;
  people: HistoryPerson[];
  messages: HistoryMessage[];
};

export type CoordinationHistoryData = {
  /** 只包含**有聊天记录**的房子 */
  households: HistoryHousehold[];
  /** 库里其余没有任何消息的房子数量。页面上标一句，不假装它们不存在 */
  emptyHouseholdCount: number;
};

type HouseholdRow = {
  id: string;
  label: string;
  status: string;
  is_test: boolean;
  created_at: Date;
};

type MembershipRow = {
  household_id: string;
  person_id: string;
  display_name: string;
  role: HistoryRole;
  resides: boolean;
};

type MessageRow = {
  household_id: string;
  id: string;
  person_id: string;
  display_name: string | null;
  direction: "inbound" | "outbound";
  body: string;
  sent_at: Date;
  channel: string;
};

/**
 * 读全部房子的协调历史。
 *
 * 三条独立查询然后在内存里拼装，比一条多表 join 更好读：membership 和 message
 * 的粒度不一样（前者是「现在是谁」，后者是「历史上说过什么」），join 到一起
 * 会互相放大行数。
 */
export async function readCoordinationHistory(): Promise<CoordinationHistoryData> {
  const sql = db();
  if (!sql) {
    return { households: [], emptyHouseholdCount: 0 };
  }

  try {
    const [households, memberships, messages] = await Promise.all([
      sql<HouseholdRow[]>`
        select id, label, status, is_test, created_at
        from coliving.household
        order by created_at desc
      `,
      sql<MembershipRow[]>`
        select m.household_id, m.person_id, p.display_name, m.role, m.resides
        from coliving.membership m
        join coliving.person p on p.id = m.person_id
        where m.valid_to is null
      `,
      // 每套房只取最近 N 条，再翻回升序。
      // 直接全量 order by sent_at asc 会在老房子上把整段历史拉进内存。
      sql<MessageRow[]>`
        select * from (
          select c.household_id, msg.id, msg.person_id,
                 p.display_name, msg.direction, msg.body, msg.sent_at, msg.channel,
                 row_number() over (
                   partition by c.household_id order by msg.sent_at desc
                 ) as rn
          from coliving.message msg
          join coliving.conversation c on c.id = msg.conversation_id
          left join coliving.person p on p.id = msg.person_id
          where c.household_id is not null
        ) t
        where rn <= ${MESSAGES_PER_HOUSEHOLD}
        order by sent_at asc
      `,
    ]);

    const peopleByHousehold = new Map<string, HistoryPerson[]>();
    for (const row of memberships) {
      const list = peopleByHousehold.get(row.household_id) ?? [];
      list.push({
        id: row.person_id,
        name: row.display_name,
        role: row.role,
        resides: row.resides,
      });
      peopleByHousehold.set(row.household_id, list);
    }

    const messagesByHousehold = new Map<string, HistoryMessage[]>();
    for (const row of messages) {
      const list = messagesByHousehold.get(row.household_id) ?? [];
      list.push({
        id: row.id,
        personId: row.person_id,
        // 消息里的人可能已经退租、不在当前 membership 里；兜底一个占位名，
        // 宁可显示「已退租住户」也不要让节点凭空消失
        personName: row.display_name ?? "已退租住户",
        direction: row.direction,
        body: row.body,
        sentAt: row.sent_at.toISOString(),
        channel: row.channel,
      });
      messagesByHousehold.set(row.household_id, list);
    }

    const withMessages = households
      .map((h) => {
        const people = peopleByHousehold.get(h.id) ?? [];
        const known = new Set(people.map((p) => p.id));
        const houseMessages = messagesByHousehold.get(h.id) ?? [];

        // 消息里出现过、但当前 membership 里没有的人，也补成节点，
        // 否则那段历史在图上没有落点
        const seen = new Map<string, HistoryPerson>();
        for (const msg of houseMessages) {
          if (!known.has(msg.personId) && !seen.has(msg.personId)) {
            seen.set(msg.personId, {
              id: msg.personId,
              name: msg.personName,
              role: null,
              resides: null,
            });
          }
        }

        return {
          id: h.id,
          label: h.label,
          status: h.status,
          isTest: h.is_test,
          people: [...people, ...seen.values()],
          messages: houseMessages,
        };
      })
      .filter((h) => h.messages.length > 0)
      // 演示页从信息量最大的房子开始，别一进来就是空的
      .sort((a, b) => b.messages.length - a.messages.length);

    return {
      households: withMessages,
      emptyHouseholdCount: households.length - withMessages.length,
    };
  } catch (error) {
    console.error("[coordination-history] 读取失败，按空集渲染", error);
    return { households: [], emptyHouseholdCount: 0 };
  }
}
