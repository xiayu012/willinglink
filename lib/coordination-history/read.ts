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
  /** 最后一条消息的时间。列表按这个倒序——最近的排最前 */
  lastMessageAt: string | null;
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
      // 合成数据整栋排除。这一页是给合作方长期看的，两类房子装的都不是真实
      // 住户的协调记录，混进来等于拿构造数据冒充：
      //
      //   · is_test = true —— 隔离测试屋（评测语料，含刻意构造的冲突、辱骂、
      //     歧视内容），这 400 多栋本来就不该见人。
      //   · label like '影子验证%' —— 影子跑生成的房子。它们**没有**被标成
      //     is_test（影子跑那批是手工建的，比 shadow_run 落表还早），但成员
      //     是「房东 / 住客甲」这种占位名，同样是合成的。命名约定是唯一稳定
      //     的判据：shadow_run 里那三栋、加上最早手工建的这栋，都叫这个前缀。
      //
      // 判断在 SQL 这一层做，不靠前端隐藏。
      sql<HouseholdRow[]>`
        select id, label, status, is_test, created_at
        from coliving.household
        where is_test = false
          and label not like '影子验证%'
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

        // 消息里出现过、但当前 membership 里没有的人，也补进来，
        // 否则那段历史就没有归属
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

        // **顺序必须确定**：展示层的颜色是按这个顺序发的，顺序一飘，同一个
        // 人刷新两次就换了个颜色。membership 那条查询没有 order by，所以这里
        // 按「第一次说话的时间」排——既确定，又正好是这栋房子里出场的先后。
        // 从没说过话的人排在最后，按名字定序。
        const firstSeen = new Map<string, string>();
        for (const msg of houseMessages) {
          if (!firstSeen.has(msg.personId)) {
            firstSeen.set(msg.personId, msg.sentAt);
          }
        }
        const everyone = [...people, ...seen.values()].sort((a, b) => {
          const fa = firstSeen.get(a.id) ?? "9999";
          const fb = firstSeen.get(b.id) ?? "9999";
          return fa === fb ? a.name.localeCompare(b.name) : fa < fb ? -1 : 1;
        });

        return {
          id: h.id,
          label: h.label,
          status: h.status,
          isTest: h.is_test,
          people: everyone,
          messages: houseMessages,
          // 查询已按 sent_at 升序，所以最后一条就是最新的
          lastMessageAt:
            houseMessages[houseMessages.length - 1]?.sentAt ?? null,
        };
      })
      .filter((h) => h.messages.length > 0)
      // 最近有动静的排最前——历史列表的常规排法，也保证一进来不是空房子
      .sort((a, b) =>
        (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "")
      );

    return {
      households: withMessages,
      emptyHouseholdCount: households.length - withMessages.length,
    };
  } catch (error) {
    console.error("[coordination-history] 读取失败，按空集渲染", error);
    return { households: [], emptyHouseholdCount: 0 };
  }
}
