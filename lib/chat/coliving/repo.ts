import "server-only";

import postgres from "postgres";
import type { FinalNoticeCandidate } from "./final-notice";
import { assertCanWrite } from "./guard";
import { householdIntakeSupplied } from "./intake-once";
import { normalizePhone } from "./phone";

/**
 * 合租房世界模型的数据访问层。
 *
 * **schema 的事实来源是 `lib/db/migrations/manual/coliving-world.sql`**，
 * 这里不再镜像一份 drizzle 定义——本模块的查询是「时间窗 + PostGIS 距离 +
 * 向量相似」这一类，手写 SQL 更清楚；再维护一份 drizzle schema 只会多一个
 * 会漂移的事实来源。public 下租房搜索那些表仍然走 drizzle，两边互不影响。
 *
 * 贯穿全模块的两条规矩（来自设计稿）：
 *   · 关系带时间范围，**改成员不覆盖旧行**，是给旧行填 valid_to 再插新行
 *   · 临时相关性运行时算，不落库成关系
 */

let client: postgres.Sql | null = null;

function db(): postgres.Sql {
  if (!client) {
    const url = process.env.POSTGRES_URL;
    if (!url) {
      throw new Error("[coliving] 没有 POSTGRES_URL");
    }
    // 无服务器环境：连接数压到很低，靠 Neon 的连接池
    client = postgres(url, { max: 2, idle_timeout: 20 });
  }
  return client;
}

/**
 * 数据库的当前时刻（Neon 服务器时钟）。
 *
 * **不要拿 node 的 `new Date()` 冒充「现在」。** `coliving.message.sent_at`
 * 这类时间戳全是数据库 `now()` 生成的，本机时钟与服务器时钟会漂移
 * （实测差约 2.1s）。拿 node 时钟当门槛去比 db 时间戳，秒级竞态判断
 * （hasNewInboundSince 的 since、recentForCritique 的截止线）会把前一轮
 * 刚说过话的人误判成「本轮刚发来新消息」。凡是要跟 sent_at 同一把尺，
 * 就从这里取「当下」。
 */
export async function dbNow(): Promise<Date> {
  const rows = await db()<{ now: Date }[]>`
    select now() as now
  `;
  return rows[0].now;
}

/**
 * 角色与居住事实的**定义在纯模块 `membership-facts.ts`**（零 import，
 * 免费闸与离线测试读同一份，不另立会漂移的第二份）。这里只转出去，
 * 既有 `repo.Role` 的用法保持不变。
 */
import {
  mergeMembershipFacts,
  placeholderName,
  residesFromInput,
  type ResidenceInput,
  type Role,
} from "./membership-facts";

export type { ResidenceInput, Role };

export type Member = {
  personId: string;
  name: string;
  role: Role;
  /**
   * true=确认住在这里，false=确认不住，**null=不知道**。
   * 不知道就是不知道——共用资源怎么分直接取决于这个数，
   * 拿默认值顶替会让 AI 笃定地算错（见 coliving-world-05.sql）。
   */
  resides: boolean | null;
  /** 他真正搬进来的时间。null = 不知道。**不是录入时间** */
  movedInAt: Date | null;
  /**
   * 这个名字是不是真名。false = 系统给的占位名（「2号住客」这种）。
   *
   * **必须逐人标出来给模型看。** 曾经靠在提示词里写一句
   * 「名字带『新住客』字样的是占位符」来防——后来占位名格式改成
   * 「N号住客」，那句话就失效了，AI 把「2号、3号」念进了短信里。
   * 靠字符串匹配的规则会随格式漂移而静默失效，靠字段不会。
   */
  nameConfirmed: boolean;
  /**
   * 他在**当前这个渠道**里的地址：目前只有短信，就是手机号。
   * 不叫 phone 是因为字段按渠道抽象，以后换渠道不用改列名。
   */
  address: string | null;
  /** 长期记忆里关于这个人的作息/偏好，已经拼成一行 */
  notes: string[];
};

export type Sender = {
  personId: string;
  name: string;
  role: Role;
  householdId: string;
  householdLabel: string;
  dwellingId: string;
  /**
   * 这套房是哪个 Unit（`dwelling.unit`）。**听到才填，没听到就是 null**——
   * 陌生号码第一次进来时它一定是 null，这正是「第二条要问房号」的依据。
   */
  unit: string | null;
  /** 测试屋。本地进程只能写这种（见 guard.ts 里那次事故） */
  isTest: boolean;
};

export type OpenCase = {
  id: string;
  kind: string;
  title: string;
  status: string;
  severity: string | null;
  lastActivityAt: Date;
};

export type HouseRule = {
  id: string;
  kind: string;
  statement: string;
  /**
   * `'proposed'` = **还只是一版草案，没生效**；`'active'` = 全员明确同意后成立。
   *
   * 2026-10-06 起插入时是 `'proposed'`（`saveRule`），只有定案（`consulted_at`
   * 写上且没有异议）才升 `'active'`（`closeConsultationIfComplete`）。渲染层据此
   * 明确写出「草案（还没生效）」，不让一版草案在上下文里读起来像已经在跑的规矩。
   */
  status: "proposed" | "active";
  /** 走完一轮征询的时间。null = 还没问全 */
  consultedAt: Date | null;
  agreedCount: number;
  objectedCount: number;
  /** 还没表过态的人名。**由 SQL 算好**，不让模型自己去名单里减 */
  pendingNames: string[];
};

export type PastEvent = {
  id: string;
  kind: string;
  summary: string;
  severity: string | null;
  recordedAt: Date;
  reportedBy: string | null;
  caseId: string | null;
};

// ── 认人 ────────────────────────────────────────────────────────────────────

/**
 * 入站消息认人：**渠道 + 该渠道里的地址** → 这个人 + 他当前所在的 household。
 * 认不出返回 null（调用方应当只回一句问对方是谁，不落任何记录）。
 *
 * 同一个人可以在多个渠道有地址（目前合租房只有短信手机号），
 * person 只有一个——身份不因换渠道而改变，跟不因搬家而改变是同一个道理。
 */
export async function resolveSender(
  channel: string,
  externalId: string
): Promise<Sender | null> {
  const target =
    channel === "sms" ? normalizePhone(externalId) : externalId.trim();
  if (!target) {
    return null;
  }
  const rows = await db()<Sender[]>`
    select
      p.id            as "personId",
      p.display_name  as name,
      m.role          as role,
      h.id            as "householdId",
      h.label         as "householdLabel",
      h.dwelling_id   as "dwellingId",
      h.is_test       as "isTest",
      d.unit          as unit
    from coliving.person_contact pc
    join coliving.person p on p.id = pc.person_id
    join coliving.membership m
      on m.person_id = p.id and m.valid_to is null
    join coliving.household h
      on h.id = m.household_id and h.status = 'active'
    left join coliving.dwelling d on d.id = h.dwelling_id
    where pc.kind = ${channel} and pc.value = ${target}
    limit 1
  `;
  return rows[0] ?? null;
}

/**
 * 当前住在/关联到这栋房子的人。
 *
 * `valid_to is null` 是「此刻生效」的意思。要问「2027年3月10日当时住着谁」，
 * 换成 `valid_from <= $t and (valid_to is null or valid_to > $t)` 即可——
 * 历史没有被覆盖，所以查得到。
 */
export async function getMembers(
  householdId: string,
  channel = "sms"
): Promise<Member[]> {
  return await db()<Member[]>`
    select
      p.id           as "personId",
      p.display_name as name,
      m.role         as role,
      m.resides      as resides,
      p.moved_in_at  as "movedInAt",
      p.name_confirmed as "nameConfirmed",
      (select pc.value from coliving.person_contact pc
        where pc.person_id = p.id and pc.kind = ${channel}
        order by pc.is_primary desc limit 1) as address,
      -- **不按 kind 过滤。** 记忆的类别是自由文本（见 coliving-world-06.sql），
      -- 这里写死白名单的话，模型记了新类别也读不出来——静默失效，
      -- 而且要到有人发现「它明明记过却不知道」时才暴露。
      -- 只排掉 summary：那是给人看的汇总，不是关于这个人的事实。
      -- **推断和单方指控都要标出来。** 混着读会让 AI 把自己的猜测、
      -- 或者别人对他的指控，当成已确认的事实，再基于它推新的——
      -- 几年下来不可逆地跑偏。
      --
      -- third_party 那一支是 2026-09-05 补的：stated_by 字段第七批
      -- 就存下来了，但这里从来没读过它——**数据在库里，模型却看不到**，
      -- 于是"A 说 B 半夜吵"在 B 的档案里读起来跟 B 自己承认的一样。
      -- 这跟宪法第九条（一方的说法不是事实）是同一件事，之前只有提示词
      -- 在管，现在渲染层也把来源摆出来。
      -- 同时按 fact_to 过滤掉已经过期的事实（「这周上夜班」到期就不该再读）。
      coalesce(
        (select array_agg(
                  case
                    when mem.basis = 'inferred'
                      then '（推测）' || mem.content
                    when mem.basis = 'third_party'
                      then '（' ||
                           coalesce(
                             (select sp.display_name from coliving.person sp
                               where sp.id = mem.stated_by),
                             '别人'
                           ) || '说的，本人没确认过）' || mem.content
                    else mem.content
                  end
                order by mem.created_at)
           from coliving.memory mem
          where mem.person_id = p.id
            and mem.valid_to is null
            and mem.kind <> 'summary'
            and (mem.fact_to is null or mem.fact_to > now())),
        '{}'
      ) as notes
    from coliving.membership m
    join coliving.person p on p.id = m.person_id
    where m.household_id = ${householdId} and m.valid_to is null
    order by (m.role = 'landlord'), p.display_name
  `;
}

export async function getActiveRules(
  householdId: string
): Promise<HouseRule[]> {
  return await db()<HouseRule[]>`
    select r.id, r.kind, r.statement, r.status,
           r.consulted_at as "consultedAt",
           coalesce(array_length(r.agreed_by, 1), 0) as "agreedCount",
           coalesce(array_length(r.objected, 1), 0) as "objectedCount",
           -- **谁还没表态，由数据库算**。让模型拿名单去减人，它会算错，
           -- 而且每一轮都要重算一遍——确定性的账不该进提示词。
           coalesce((
             select array_agg(p.display_name order by p.display_name)
             from coliving.membership mb
             join coliving.person p on p.id = mb.person_id
             where mb.household_id = r.household_id
               and mb.valid_to is null
               and mb.resides is not false
               and not (p.id = any(r.agreed_by))
               and not (p.id = any(r.objected))
           ), '{}') as "pendingNames"
    from coliving.rule r
    where r.household_id = ${householdId} and r.status in ('active','proposed')
      and (r.valid_to is null or r.valid_to > now())
    order by r.kind
  `;
}

export async function getOpenCases(householdId: string): Promise<OpenCase[]> {
  return await db()<OpenCase[]>`
    select id, kind, title, status, severity,
           last_activity_at as "lastActivityAt"
    from coliving.case_file
    where household_id = ${householdId}
      and status in ('open','monitoring','waiting','escalated')
    order by last_activity_at desc
    limit 8
  `;
}

// ── 会话与消息 ───────────────────────────────────────────────────────────────

/**
 * 取/建一条会话。**接受调用方的事务**（同 `insertDecision` / `insertCommunication`）：
 * 定案通知那条「领取 (规则, 人) ＋ 写 decision ＋ 写 communication ＋ 写消息」必须在
 * **同一个事务**里一次做完——见 `claimFinalNoticeDelivery` 里为什么。
 */
async function insertConversation(
  sql: postgres.Sql | postgres.TransactionSql,
  args: { personId: string; householdId: string; channel: string }
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into coliving.conversation (person_id, household_id, channel)
    values (${args.personId}, ${args.householdId}, ${args.channel})
    on conflict (person_id, channel) do update
      set last_message_at = now(),
          household_id = excluded.household_id
    returning id
  `;
  return rows[0].id;
}

export async function getOrCreateConversation(args: {
  personId: string;
  householdId: string;
  channel: string;
}): Promise<string> {
  return await insertConversation(db(), args);
}

/** 写一条消息。**接受调用方的事务**，理由同 `insertConversation`。 */
async function insertMessage(
  sql: postgres.Sql | postgres.TransactionSql,
  args: {
    conversationId: string;
    personId: string;
    direction: "inbound" | "outbound";
    channel: string;
    body: string;
    externalMessageId?: string | null;
    communicationId?: string | null;
  }
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    insert into coliving.message
      (conversation_id, person_id, direction, channel, body,
       external_message_id, communication_id)
    values (${args.conversationId}, ${args.personId}, ${args.direction},
            ${args.channel}, ${args.body},
            ${args.externalMessageId ?? null}, ${args.communicationId ?? null})
    on conflict do nothing
    returning id
  `;
  return rows[0]?.id ?? null;
}

export async function appendMessage(args: {
  conversationId: string;
  personId: string;
  direction: "inbound" | "outbound";
  channel: string;
  body: string;
  externalMessageId?: string | null;
  communicationId?: string | null;
  /** 返回消息 id，调用方要用它把「人类回应」关联回对应的沟通 */
}): Promise<string | null> {
  return await insertMessage(db(), args);
}

/**
 * 这个人有没有一条还等着他回话的沟通。**只读，不改状态。**
 *
 * 用在轮次开始时：让模型知道「他这句多半是在回你之前问的那件事」。
 * 这比事后关联更值钱——它直接防住「明明问过、他也答了，下一轮又问一遍」。
 */
export async function pendingCommunication(
  personId: string,
  withinHours = 72
): Promise<{
  purpose: string | null;
  body: string;
  sentAt: Date;
  act: string | null;
} | null> {
  const rows = await db()<
    { purpose: string | null; body: string; sentAt: Date; act: string | null }[]
  >`
    select purpose, body, sent_at as "sentAt", act
    from coliving.communication
    where to_person_id = ${personId}
      and status = 'sent'
      and responded_at is null
      and sent_at > now() - (${withinHours} || ' hours')::interval
    order by (expects_reply = true) desc, sent_at desc limit 1
  `;
  return rows[0] ?? null;
}

/**
 * 竞态门禁：检查某人在指定时刻之后是否发来了新的入站消息。
 *
 * 用途：`contactPerson` 执行时，如果目标住户在本轮上下文构建之后已经
 * 发来新消息，说明上下文已经过期——继续按旧上下文发出的征询会形成
 * 并发重复，甚至在对方已经表态后再发一遍"你愿意吗"。发现有新消息就跳过，
 * 等下一轮拿到最新上下文再处理。
 */
export async function hasNewInboundSince(
  personId: string,
  channel: string,
  since: Date
): Promise<boolean> {
  const rows = await db()<{ exists: boolean }[]>`
    select exists(
      select 1 from coliving.message m
      join coliving.conversation c on c.id = m.conversation_id
      where c.person_id = ${personId}
        and c.channel = ${channel}
        and m.direction = 'inbound'
        and m.sent_at > ${since}
    ) as exists
  `;
  return rows[0]?.exists ?? false;
}

/** 最近几轮对话，按时间正序返回，喂给模型当 history */
export async function getRecentTurns(
  conversationId: string,
  limit = 8
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const rows = await db()<
    { direction: "inbound" | "outbound"; body: string }[]
  >`
    select direction, body from (
      select m.direction, m.body, m.sent_at
      from coliving.message m
      left join coliving.communication c on c.id = m.communication_id
      where m.conversation_id = ${conversationId}
        -- 跳过被竞态门禁标记为过期的出站消息，避免模型把已作废的征询
        -- 当作"已成功联系"的事实带入下一轮上下文。
        and (m.direction = 'inbound' or c.id is null or c.status != 'skipped')
      order by m.sent_at desc
      limit ${limit}
    ) t order by sent_at asc
  `;
  return rows.map((r) => ({
    role:
      r.direction === "inbound" ? ("user" as const) : ("assistant" as const),
    content: r.body,
  }));
}

// ── Governance ──────────────────────────────────────────────────────────────

export async function recordEvent(args: {
  householdId: string;
  kind: string;
  summary: string;
  detail?: string | null;
  severity?: string | null;
  reportedBy?: string | null;
  aboutPersonIds?: string[];
  caseId?: string | null;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.event
      (household_id, kind, summary, detail, severity, reported_by,
       about_person_ids, case_id)
    values (${args.householdId}, ${args.kind}, ${args.summary},
            ${args.detail ?? null}, ${args.severity ?? null},
            ${args.reportedBy ?? null},
            ${db().array(args.aboutPersonIds ?? [])}::uuid[],
            ${args.caseId ?? null})
    returning id
  `;
  return rows[0].id;
}

export async function openCase(args: {
  householdId: string;
  kind: string;
  title: string;
  severity?: string | null;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.case_file (household_id, kind, title, severity)
    values (${args.householdId}, ${args.kind}, ${args.title},
            ${args.severity ?? null})
    returning id
  `;
  return rows[0].id;
}

export async function updateCase(args: {
  caseId: string;
  status?: string;
  resolution?: string | null;
}): Promise<void> {
  await db()`
    update coliving.case_file
    set status = coalesce(${args.status ?? null}, status),
        resolution = coalesce(${args.resolution ?? null}, resolution),
        last_activity_at = now(),
        closed_at = case when ${args.status ?? null} in ('resolved','closed')
                         then now() else closed_at end
    where id = ${args.caseId}
  `;
}

/**
 * 这个 case 真的存在吗（且属于这栋房子）。
 *
 * **模型会编 id。** 编了之后 `touchCase` 更新零行、不报错，
 * 但后面拿它去插 communication 就会撞外键，**整轮崩掉、住户什么都收不到**。
 * 所以凡是模型给的 id，用之前一律先验。
 */
export async function caseExists(
  householdId: string,
  caseId: string
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(caseId)) {
    return false;
  }
  const rows = await db()<{ id: string }[]>`
    select id from coliving.case_file
    where id = ${caseId} and household_id = ${householdId} limit 1
  `;
  return rows.length > 0;
}

export async function touchCase(caseId: string): Promise<void> {
  await db()`
    update coliving.case_file set last_activity_at = now() where id = ${caseId}
  `;
}

export type CasePosition = {
  id: string;
  personId: string;
  personName: string;
  kind: "preference" | "rejection" | "commitment";
  statement: string;
  createdAt: Date;
  honored: boolean | null;
  resolutionNote: string | null;
};

/**
 * 记一条表态：谁想要什么/拒绝了什么，或者 AI 自己许下的承诺。
 * 只在这一步写 statement/kind，honored 留 null——「还没被交代」，
 * 要等 closeCase 时被工具校验逼着填。
 *
 * **caseId 可以不填**：真实事故——房东在案子还没开出来之前随口说
 * "七点用厨房最合适"，那时候没有冲突浮现、没有 openCase，这句偏好就
 * 没地方记，只能靠 recentOutbound 的滚动窗口纯文字流水账，几轮之后
 * 窗口一滚就没了，等真正需要排班时模型对着房东说"你的时间还没确认"——
 * 这句话本身是错的，房东早说过了。caseId 为 null 代表"这是一条独立于
 * 任何具体案子的表态"，案子后来真的开出来，可以按 personId 查出这条
 * 记录参考，不需要事先预判"这句话以后会不会变成一个案子"。
 */
export async function recordCasePosition(args: {
  caseId?: string | null;
  householdId: string;
  personId: string;
  kind: "preference" | "rejection" | "commitment";
  statement: string;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.case_position (case_id, household_id, person_id, kind, statement)
    values (${args.caseId ?? null}, ${args.householdId}, ${args.personId}, ${args.kind}, ${args.statement})
    returning id
  `;
  return rows[0].id;
}

export async function getCasePositions(
  caseId: string
): Promise<CasePosition[]> {
  return await db()<CasePosition[]>`
    select cp.id, cp.person_id as "personId", p.display_name as "personName",
           cp.kind, cp.statement, cp.created_at as "createdAt",
           cp.honored, cp.resolution_note as "resolutionNote"
    from coliving.case_position cp
    join coliving.person p on p.id = cp.person_id
    where cp.case_id = ${caseId}
    order by cp.created_at asc
  `;
}

/**
 * 独立于任何案子、还没被归到某个 case 下的表态——按房子查全部
 * （不按人过滤，因为一次排班冲突常常涉及好几个人，一次性看全比
 * 逐个查更不容易漏）。**这是 context.ts 渲染进运行时上下文用的**，
 * 让模型开新案子/排方案前，先看看有没有人已经随口说过偏好。
 */
export async function getStandalonePositions(
  householdId: string,
  limit = 10
): Promise<CasePosition[]> {
  return await db()<CasePosition[]>`
    select cp.id, cp.person_id as "personId", p.display_name as "personName",
           cp.kind, cp.statement, cp.created_at as "createdAt",
           cp.honored, cp.resolution_note as "resolutionNote"
    from coliving.case_position cp
    join coliving.person p on p.id = cp.person_id
    where cp.household_id = ${householdId} and cp.case_id is null
    order by cp.created_at desc
    limit ${limit}
  `;
}

/**
 * 结案时把每条表态交代清楚：满足没满足、为什么。
 * **不校验"必须全部交代"——那是工具执行层（turn.ts）的活**，这里只管落库。
 */
export async function accountCasePosition(args: {
  positionId: string;
  honored: boolean;
  resolutionNote?: string | null;
}): Promise<void> {
  await db()`
    update coliving.case_position
    set honored = ${args.honored},
        resolution_note = ${args.resolutionNote ?? null},
        accounted_at = now()
    where id = ${args.positionId}
  `;
}

// ── ② 案子影响到谁：结案时核对"都通知到了吗" ─────────────────────────────

export type CaseParty = {
  id: string;
  personId: string;
  personName: string;
  reason: string | null;
  notified: boolean | null;
};

/** upsert：同一个人在同一件事里多次标记，只留最后一次的 reason */
export async function addCaseParty(args: {
  caseId: string;
  householdId: string;
  personId: string;
  reason?: string | null;
}): Promise<void> {
  await db()`
    insert into coliving.case_party (case_id, household_id, person_id, reason)
    values (${args.caseId}, ${args.householdId}, ${args.personId}, ${args.reason ?? null})
    on conflict (case_id, person_id) do update set reason = excluded.reason
  `;
}

export async function getCaseParties(caseId: string): Promise<CaseParty[]> {
  return await db()<CaseParty[]>`
    select cp.id, cp.person_id as "personId", p.display_name as "personName",
           cp.reason, cp.notified
    from coliving.case_party cp
    join coliving.person p on p.id = cp.person_id
    where cp.case_id = ${caseId}
    order by cp.created_at asc
  `;
}

export async function markCasePartyNotified(
  caseId: string,
  personId: string,
  notified: boolean
): Promise<void> {
  await db()`
    update coliving.case_party set notified = ${notified}
    where case_id = ${caseId} and person_id = ${personId}
  `;
}

// ── ④ 算好的份额：存一次，以后的轮次直接读，不用重新心算 ──────────────────

export type CaseShare = {
  id: string;
  resource: string;
  personId: string;
  personName: string;
  amount: number;
  unit: string;
  rationale: string | null;
};

export async function recordCaseShare(args: {
  caseId: string;
  householdId: string;
  resource: string;
  personId: string;
  amount: number;
  unit: string;
  rationale?: string | null;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.case_share
      (case_id, household_id, resource, person_id, amount, unit, rationale)
    values (${args.caseId}, ${args.householdId}, ${args.resource}, ${args.personId},
            ${args.amount}, ${args.unit}, ${args.rationale ?? null})
    returning id
  `;
  return rows[0].id;
}

export async function getCaseShares(caseId: string): Promise<CaseShare[]> {
  return await db()<CaseShare[]>`
    select cs.id, cs.resource, cs.person_id as "personId", p.display_name as "personName",
           cs.amount, cs.unit, cs.rationale
    from coliving.case_share cs
    join coliving.person p on p.id = cs.person_id
    where cs.case_id = ${caseId}
    order by cs.resource, cs.created_at asc
  `;
}

// ── ③ 提醒自己：把 obligation 这张表接上电 ────────────────────────────────

export type DueObligation = {
  id: string;
  householdId: string;
  personId: string | null;
  personName: string | null;
  ruleId: string | null;
  description: string;
  dueAt: Date | null;
};

export async function scheduleReminder(args: {
  householdId: string;
  personId?: string | null;
  ruleId?: string | null;
  description: string;
  dueAt: Date;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.obligation
      (household_id, person_id, rule_id, description, due_at)
    values (${args.householdId}, ${args.personId ?? null}, ${args.ruleId ?? null},
            ${args.description}, ${args.dueAt})
    returning id
  `;
  return rows[0].id;
}

/** 到期且还没处理的提醒。outreach.ts 的 obligation_due job 用这个扫描。 */
export async function dueObligations(
  householdId: string
): Promise<DueObligation[]> {
  return await db()<DueObligation[]>`
    select o.id, o.household_id as "householdId", o.person_id as "personId",
           p.display_name as "personName", o.rule_id as "ruleId",
           o.description, o.due_at as "dueAt"
    from coliving.obligation o
    left join coliving.person p on p.id = o.person_id
    where o.household_id = ${householdId}
      and o.status = 'pending'
      and o.due_at <= now()
    order by o.due_at asc
  `;
}

export async function markObligationDone(id: string): Promise<void> {
  await db()`
    update coliving.obligation
    set status = 'done', completed_at = now()
    where id = ${id}
  `;
}

export async function recordOutcome(args: {
  caseId: string;
  kind: string;
  note?: string | null;
  sentiment?: number | null;
}): Promise<void> {
  await db()`
    insert into coliving.outcome (case_id, kind, note, sentiment)
    values (${args.caseId}, ${args.kind}, ${args.note ?? null},
            ${args.sentiment ?? null})
  `;
}

/** `recordDecision` 的参数（抽出来是为了让 `claimFirstIntroduction` 在同一个事务里落同一条记录）。 */
export type DecisionInput = {
  householdId: string;
  caseId?: string | null;
  eventId?: string | null;
  kind: string;
  targetPersonIds?: string[];
  intent?: string | null;
  rationale?: string | null;
  modelId?: string | null;
  doctrineModules?: string[];
  contextChars?: number | null;
  /** 当时喂给模型的运行时上下文原文。**判断对不对取决于它当时看到了什么** */
  contextSnapshot?: string | null;
  /**
   * 很窄的**结构化标记**（如已批准功能投递时留下的功能 id / 收件人 id）。只放代码
   * 写死的 id，**不放模型自由文本**。
   */
  payload?: Record<string, string> | null;
};

/**
 * 落一条 decision。**接受调用方的事务**（`postgres.TransactionSql` 与 `Sql` 同形），
 * 让需要「判断 + 沟通」原子成立的路径（首次介绍）不必把这段 SQL 抄第二遍。
 *
 * `payload` 必须走 postgres.js 的 `json()`（显式 jsonb 参数）。
 *
 * **不要**写 `${JSON.stringify(...)}::jsonb`：首次执行时驱动的参数类型还是 unknown
 * （按文本发送），但 PostgreSQL 的 ParameterDescription 会把解析出的 jsonb(3802)
 * 写回该参数并缓存预处理语句；**第二次及以后**驱动就按 jsonb 序列化器把已经
 * stringify 过的参数**再序列化一次**，落库变成 JSONB 顶层字符串，读取端
 * `payload->>'<字段>'` 随即读成 null（真实事故的根因）。`shadow.ts` 用的是同一正确先例。
 */
async function insertDecision(
  sql: postgres.Sql | postgres.TransactionSql,
  args: DecisionInput
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into coliving.decision
      (household_id, case_id, event_id, kind, target_person_ids, intent,
       rationale, model_id, doctrine_modules, context_chars,
       context_snapshot, payload)
    values (${args.householdId}, ${args.caseId ?? null}, ${args.eventId ?? null},
            ${args.kind}, ${sql.array(args.targetPersonIds ?? [])}::uuid[],
            ${args.intent ?? null}, ${args.rationale ?? null},
            ${args.modelId ?? null},
            ${sql.array(args.doctrineModules ?? [])}::text[],
            ${args.contextChars ?? null}, ${args.contextSnapshot ?? null},
            ${sql.json(args.payload ?? {})})
    returning id
  `;
  return rows[0].id;
}

/**
 * AI 的治理判断。**先于任何实际沟通落库**，与说出口的话分开存，
 * 这样以后能分别评估「判断对不对」和「表达合不合适」（设计稿第六点）。
 */
export async function recordDecision(args: DecisionInput): Promise<string> {
  return await insertDecision(db(), args);
}

/**
 * **某位住户最近一条「刚被黑名单拒绝」的结构化引用**——只回答功能问答「刚才」
 * 需要的一件事：这位住户自己上一轮被黑名单收口时、由**纯代码**写进 decision payload
 * 的条目 id（`payload.blacklistedCapabilityId`），供 `feature-qa.ts` 关联到统一功能
 * 事实源（`feature-facts.ts`）里的具体条目，说出名称与登记原因。
 *
 * **整个查询就按发起人收窄**（`d.payload->>'personId' = 本人`），所以别的住户中间发了
 * 什么都顶不掉、也拿不到本人刚发生的那条引用（**别的住户的状态不得混入**）。
 *
 * **只认本人「紧接着」的那一条**：`not exists` 要求本人在**同一栋房子**里、这条
 * decision **之后**没有更新的入站消息。当前这轮功能问答的入站消息在查询时还没落库，
 * 因此「本人没有更新的入站」正好等价于「这条黑名单拒绝是本人上一条入站话题」。反例——
 * 住户先被拒了「单方面叫别人在洗完澡后清理地漏头发」，随后自己又发了别的（普通问句 /
 * 已批准的事），再问「刚才」：
 * 那个更新的入站消息会让旧引用出局，旧拒绝不会被翻成「刚才」。时间窗与既有对话关联
 * （`linkResponse` / `pendingCommunication` 的 72h）一致；超过窗口就不算「刚才」。
 *
 * 只读**代码写死的结构化 id**（`payload.blacklistedCapabilityId`），不读任何模型自由
 * 文本，也不按关键词猜「刚才」；查不到返回 null。
 */
export async function latestBlacklistReference(args: {
  householdId: string;
  personId: string;
  withinHours?: number;
}): Promise<{ capabilityId: string } | null> {
  const rows = await db()<{ capabilityId: string | null }[]>`
    select d.payload->>'blacklistedCapabilityId' as "capabilityId"
    from coliving.decision d
    where d.household_id = ${args.householdId}
      and d.payload->>'personId' = ${args.personId}
      and d.payload->>'blacklistedCapabilityId' is not null
      and d.decided_at > now() - (${args.withinHours ?? 72} || ' hours')::interval
      and not exists (
        select 1
        from coliving.message m
        join coliving.conversation c on c.id = m.conversation_id
        where m.person_id = ${args.personId}
          and c.household_id = ${args.householdId}
          and m.direction = 'inbound'
          and m.sent_at > d.decided_at
      )
    order by d.decided_at desc
    limit 1
  `;
  const capabilityId = rows[0]?.capabilityId ?? null;
  return capabilityId ? { capabilityId } : null;
}

/**
 * 模型常常先声明「只回复本人」，转头又去联系了别人。
 * 判断记录必须和实际行为一致，否则「AI 判断得对不对」这个复盘就没法做了。
 * 只往「介入更深」的方向改，不往回改。
 */
export async function upgradeDecisionKind(
  decisionId: string,
  kind: string
): Promise<void> {
  await db()`
    update coliving.decision set kind = ${kind}
    where id = ${decisionId}
      and kind in ('observe','stay_silent','log_only','reply_only')
  `;
}

/** Decision 产生的实际外呼。先落库（queued），发送成功再回写。 */
export type CommunicationAct =
  | "ask"
  | "inform"
  | "propose"
  | "confirm"
  | "remind"
  | "escalate";

/**
 * 按言语行为推出「什么时候之前该有回音」。**不让模型填具体时间**——
 * 它会乱填（第十五批的设计决定）。只有真的在等的那几类才有时限。
 */
function replyDueFor(
  act: CommunicationAct | null,
  expectsReply: boolean
): Date | null {
  if (!expectsReply || !act) {
    return null;
  }
  const hours =
    act === "remind" ? 12 : act === "ask" || act === "confirm" ? 24 : null;
  return hours === null ? null : new Date(Date.now() + hours * 3600 * 1000);
}

export type CommunicationInput = {
  householdId: string;
  decisionId?: string | null;
  caseId?: string | null;
  toPersonId: string;
  channel: string;
  purpose?: string | null;
  body: string;
  /** 这条是什么言语行为。决定要不要盯回音、盯多久 */
  act?: CommunicationAct | null;
  /** 要不要盯着对方回音。**默认 false**，见 coliving-world-15.sql 的说明 */
  expectsReply?: boolean;
};

/**
 * 入队一条 communication。**接受调用方的事务**（同 `insertDecision`）：定案通知那条
 * 「查在途回执 ＋ 落库」必须在同一个事务、同一把咨询锁里，不能分成两次连接写。
 */
async function insertCommunication(
  sql: postgres.Sql | postgres.TransactionSql,
  args: CommunicationInput
): Promise<string> {
  const act = args.act ?? null;
  const expectsReply = args.expectsReply ?? false;
  const rows = await sql<{ id: string }[]>`
    insert into coliving.communication
      (household_id, decision_id, case_id, to_person_id, channel, purpose, body,
       act, expects_reply, reply_due_at)
    values (${args.householdId}, ${args.decisionId ?? null},
            ${args.caseId ?? null}, ${args.toPersonId}, ${args.channel},
            ${args.purpose ?? null}, ${args.body},
            ${act}, ${expectsReply}, ${replyDueFor(act, expectsReply)})
    returning id
  `;
  return rows[0].id;
}

export async function queueCommunication(
  args: CommunicationInput
): Promise<string> {
  return await insertCommunication(db(), args);
}

export async function findRecentOpenCommunication(args: {
  toPersonId: string;
  channel: string;
  body: string;
  withinHours?: number;
}): Promise<{
  id: string;
  status: string;
  sentAt: Date | null;
  createdAt: Date;
} | null> {
  const rows = await db()<
    { id: string; status: string; sentAt: Date | null; createdAt: Date }[]
  >`
    select id, status, sent_at as "sentAt", created_at as "createdAt"
    from coliving.communication
    where to_person_id = ${args.toPersonId}
      and channel = ${args.channel}
      and body = ${args.body}
      and status in ('queued', 'sent')
      and responded_at is null
      and coalesce(sent_at, created_at) > now() - (${args.withinHours ?? 24} || ' hours')::interval
    order by coalesce(sent_at, created_at) desc
    limit 1
  `;
  return rows[0] ?? null;
}

export type BlockedComm = {
  toName: string;
  purpose: string | null;
  body: string;
  act: CommunicationAct | null;
  sentAt: Date;
  replyDueAt: Date | null;
  caseTitle: string | null;
  /** 已经等了多少小时（整数，向下取整） */
  waitedHours: number;
  overdue: boolean;
};

/**
 * **阻塞清单**：这栋房子现在有哪些事，卡在等某个人回话。
 *
 * 这是第十五批的核心产出——敏捷站会那块 blocker board 的等价物。
 * 在这之前，"我在等谁"这件事从来没有被结构化过：`pendingCommunication`
 * 是按人查的（"这个人有没有待回应的"），回答不了"厨房排班这件事现在
 * 卡在谁身上、卡了多久"。AI 只能每轮重读聊天记录临时拼，于是反复
 * 出现"说了回头跟进然后就没下文""同一个问题问了两遍"。
 *
 * 只算真正在等的：发出去了（sent）、明确要回音（expects_reply）、
 * 还没人回（responded_at is null）。不需要回复的通知不进这张清单，
 * 否则会被噪音淹没。
 */
export async function getBlockedComms(
  householdId: string,
  limit = 10
): Promise<BlockedComm[]> {
  return await db()<BlockedComm[]>`
    select p.display_name as "toName", c.purpose, c.body, c.act,
           c.sent_at as "sentAt", c.reply_due_at as "replyDueAt",
           cf.title as "caseTitle",
           floor(extract(epoch from (now() - c.sent_at)) / 3600)::int as "waitedHours",
           (c.reply_due_at is not null and c.reply_due_at < now()) as overdue
    from coliving.communication c
    join coliving.person p on p.id = c.to_person_id
    left join coliving.case_file cf on cf.id = c.case_id
    where c.household_id = ${householdId}
      and c.status = 'sent'
      and c.expects_reply = true
      and c.responded_at is null
    order by c.sent_at asc
    limit ${limit}
  `;
}

export async function markCommunication(args: {
  communicationId: string;
  status: "sent" | "failed" | "skipped";
  externalMessageId?: string | null;
  error?: string | null;
}): Promise<void> {
  await db()`
    update coliving.communication
    set status = ${args.status},
        sent_at = case when ${args.status} = 'sent' then now() else sent_at end,
        external_message_id = ${args.externalMessageId ?? null},
        error = ${args.error ?? null}
    where id = ${args.communicationId}
  `;
}

/**
 * **「这个人还没被介绍过」——原子地判定并占位。** 首次接触那条固定介绍走这里。
 *
 * 为什么不是「读一下再写」：同一个人并发发来两条首消息时（他连发两条，两个
 * webhook 同时在跑），两个进程都会读到「没介绍过」，于是住户收到**两条一模一
 * 样的自我介绍**。这里把判断和写入放进同一个事务、按人加咨询锁，第二个事务
 * 一定看到第一个写下的那一行，直接返回 `null`。
 *
 * 判定条件（**收窄到同一个 `purpose`**，都在 `communication` 上看，**不看正文**）：
 *
 *   · 这个人这条渠道上**已经有一条这条固定介绍**，状态 `sent` 或 `queued`
 *     → 已经送到、或正在发，不重复。
 *
 * **别的沟通一概不算**（老板 2026-10-02 的口径）：普通回复、提醒、别的已发出通信
 * 都**不能替代**这条固定介绍——「收到过那条介绍」只由**这条介绍自己**的投递状态决定。
 * 所以历史上有过一堆 assistant 消息、甚至有过别的 `sent` 通信，只要这条固定介绍
 * 没成功送到过，这个人下一条入站仍然先收到介绍。
 *
 * **`failed` / `skipped` 不算数**：模型/网络失败时这条没送到，下一轮该再试一次
 * ——这正是老板说的「模型失败时第一条仍可到达」的那条重试路径。
 *
 * decision 与 communication 在同一个事务里落：判定与沟通要么一起成立，要么
 * 一起不成立，不会留下「记了一条自我介绍的决定、但一个字都没发」的假账。
 */
export async function claimFirstIntroduction(args: {
  householdId: string;
  personId: string;
  channel: string;
  /** 介绍正文（逐字来自单点文案，调用方已经选好语言） */
  body: string;
  purpose: string;
  intent: string;
  modelId?: string | null;
  /**
   * **仅免费自检用**：把下面的"陈旧"窗口改短，好在不真等 10 分钟的前提下造一条
   * "发送方中断留下的死行"。生产调用方**一律不传**（默认 10 分钟）。
   *
   * **传了就必须是测试屋**（见下）：不给任何生产调用方留一个"超时可调"的口子。
   */
  staleAfterMinutesForTest?: number;
}): Promise<{ decisionId: string; communicationId: string } | null> {
  const staleMinutes = args.staleAfterMinutesForTest ?? 10;
  /**
   * **覆盖陈旧窗口 = 测试专用，目标房子必须自己过一次 `is_test`。**
   *
   * 这个参数能改的是"在途介绍多久算死行"——它是生产行为的一部分。调用方自觉不够
   * （`enrollUnknownSender` 的 `intoTestHouseholdId` 就是这么防的），所以在**开事务
   * 之前**先查一次：真人的房子拿到这个参数直接抛错，不写任何东西、也不动 guard 的
   * 服务器写例外（那是另一道闸，两件事不互相放宽）。
   */
  if (args.staleAfterMinutesForTest !== undefined) {
    if (!(await isTestHousehold(args.householdId))) {
      throw new Error(
        "[coliving] staleAfterMinutesForTest 只许用在测试屋上：不给真人的房子覆盖介绍的超时窗口"
      );
    }
  }
  return await db().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`intro:${args.personId}`}))`;
    /**
     * **陈旧的在途介绍**：投递方如果在"插入 queued、还没记账"之间中断（进程死掉），
     * 那行会永远挂在 `queued`；下面那条 `not exists` 会永远判「见过了」，这个人
     * 往后每一条消息都被挡住、再也收不到回复。所以在一个**不可能属于真实投递**的
     * 窗口（10 分钟，正常投递是秒级）之后还在 `queued` 的介绍，就在这里、同一把锁内
     * 作废掉，由本次重新 claim。
     *
     * 窗口必须宽：等 5 秒就作废会把**正在发送**的那条判死，让第三轮再发一遍（双发）。
     */
    await tx`
      update coliving.communication
      set status = 'failed',
          error = '首次介绍在途状态陈旧（投递方可能中断），作废并由下一轮重试'
      where to_person_id = ${args.personId}
        and channel = ${args.channel}
        and purpose = ${args.purpose}
        and status = 'queued'
        and created_at < now() - make_interval(mins => ${staleMinutes})
    `;
    const [seen] = await tx<{ seen: boolean }[]>`
      select exists (
        select 1 from coliving.communication c
        where c.to_person_id = ${args.personId}
          and c.channel = ${args.channel}
          and c.purpose = ${args.purpose}
          and c.status in ('sent', 'queued')
      ) as seen
    `;
    if (seen?.seen) {
      return null;
    }

    const decisionId = await insertDecision(tx, {
      householdId: args.householdId,
      kind: "reply_only",
      intent: args.intent,
      modelId: args.modelId ?? null,
      doctrineModules: [],
    });
    const [comm] = await tx<{ id: string }[]>`
      insert into coliving.communication
        (household_id, decision_id, case_id, to_person_id, channel, purpose, body,
         act, expects_reply)
      values (${args.householdId}, ${decisionId}, null, ${args.personId},
              ${args.channel}, ${args.purpose}, ${args.body}, null, false)
      returning id
    `;
    return { decisionId, communicationId: comm.id };
  });
}

/** 首次介绍那条消息到住户手里了没有。`timeout` = 等到点了还没落地。 */
export type FirstIntroductionState = "sent" | "failed" | "timeout";

/**
 * **等这个人真的收到那条固定介绍——按那条介绍自己的投递状态，不按历史、也不按谁先创建。**
 *
 * 同一个人的两条首消息前后脚到达时（两个 webhook 同时在跑），只有一条占到介绍
 * （见 `claimFirstIntroduction`）。抢不到的那一轮**不能径直往下发**：住户会先收到回复、
 * 后收到自我介绍，读起来像两个人。它也不能拿"历史里已经有那条 assistant 消息"当回执
 * ——会话历史**本身不是投递证据**：那条介绍送没送到，只看**这条介绍自己的投递状态**。
 *
 * **只认同一个 `purpose`**（这就是为什么它要收 `purpose`）：别的通信即便 `sent` 过，
 * 也**不算**这个人收到过介绍、更不解锁顺序——那正是从前"普通回复发出去就再也不介绍"
 * 的漏洞所在。
 *
 * **这条函数只读。** 等到点仍有一条 `queued` 的介绍就返回 `timeout`（调用方终止本轮），
 * 绝不去改别轮**正在投递**的那条：把它判死会放第三轮重新 claim，正在发的介绍被双发。
 * 投递方自己会记账；真中断了由 `claimFirstIntroduction` 的陈旧窗口兜底。
 */
export async function awaitFirstIntroductionDelivered(args: {
  personId: string;
  channel: string;
  /** 介绍那条 communication 的 purpose（`onboarding.INTRODUCTION_PURPOSE`） */
  purpose: string;
  timeoutMs?: number;
}): Promise<FirstIntroductionState> {
  const deadline = Date.now() + (args.timeoutMs ?? 5000);
  for (;;) {
    const [row] = await db()<
      { sent: boolean; introStatus: string | null }[]
    >`
      select
        exists (
          select 1 from coliving.communication c
          where c.to_person_id = ${args.personId}
            and c.channel = ${args.channel}
            and c.purpose = ${args.purpose}
            and c.status = 'sent'
        ) as sent,
        (
          select c.status from coliving.communication c
          where c.to_person_id = ${args.personId}
            and c.channel = ${args.channel}
            and c.purpose = ${args.purpose}
          order by c.created_at desc limit 1
        ) as "introStatus"
    `;
    // 这条固定介绍真的发到他手机上了：顺序不再是问题。
    if (row?.sent) return "sent";
    // 还有一条在途的（queued）：等到点，到点仍是 queued 就是 timeout（这一轮终止）。
    if (row?.introStatus === "queued") {
      if (Date.now() >= deadline) return "timeout";
      await new Promise((resolve) => setTimeout(resolve, 150));
      continue;
    }
    // 没有这条介绍，或最近一条是 failed / skipped：当没送到处理，不冒险先回。
    return "failed";
  }
}

/**
 * **记下这套房是哪个 Unit**（住户说出来的房号）。
 *
 * 写 `dwelling.unit` **一个地方**（不同时改 `household.label`：label 是别人给
 * 这栋房子起的名字，导入的名单里可能是「Maple Court A 座 101」，拿房号覆盖它
 * 是把真名字弄丢）。上下文里读的就是这一列（见 `context.ts` 的名册抬头）。
 *
 * **只动这一栋**：不按 unit 查房子、不按 unit 合并 household——同一个房号在
 * 两个陌生号码那儿会是两栋各说各话的房子，这是**有意**的（我们没有任何证据
 * 说明他们是同一套）。
 */
export async function setHouseholdUnit(args: {
  householdId: string;
  unit: string;
}): Promise<string> {
  const unit = args.unit.trim();
  if (!unit) {
    throw new Error("房号是空的");
  }
  await db()`
    update coliving.dwelling set unit = ${unit}
    where id = (select dwelling_id from coliving.household where id = ${args.householdId})
  `;
  return unit;
}

/**
 * 记下这栋房子的一条规则。
 *
 * 同 kind 的旧规则**不删除**，而是 retire 掉——保留历史而不是覆盖历史。
 * `agreedBy` 是 Ostrom 那条：规则由住的人参与形成才活得下来，所以要记谁同意过。
 *
 * ## 新记下来的是**草案**（`status = 'proposed'`），不是生效的规则
 *
 * 2026-10-06 改。以前这里一插入就写 `'active'`，等于把「AI 拟的一版」直接当成
 * 全屋生效的规矩——住户还没表态就被当成已经定了，也是「AI 有个人权威」那类问题的
 * 一部分。现在：
 *
 * - 插入 `'proposed'`（草案），**草案本身不生效、不许拿去要求谁**；
 * - **草案只顶掉草案**：同 kind 里旧的 `'proposed'` 行 retire 掉（否则模型每提一版
 *   就在上下文里堆一行）；**在跑的 `'active'` 不动**——旧规则在新规则真正定案之前
 *   一直有效，这才是「草案不是规章」该有的样子；
 * - 升 `'active'` 与 retire 旧规则都挪到**定案那一刻**（`closeConsultationIfComplete`）。
 */
export async function saveRule(args: {
  householdId: string;
  kind: string;
  statement: string;
  agreedBy?: string[];
  sourceCaseId?: string | null;
}): Promise<string> {
  return await db().begin(async (tx) => {
    await tx`
      update coliving.rule
      set status = 'retired', valid_to = now()
      where household_id = ${args.householdId}
        and kind = ${args.kind}
        and status = 'proposed'
    `;
    const rows = await tx<{ id: string }[]>`
      insert into coliving.rule
        (household_id, kind, statement, status, agreed_by, source_case_id)
      values (${args.householdId}, ${args.kind}, ${args.statement}, 'proposed',
              ${tx.array(args.agreedBy ?? [])}::uuid[],
              ${args.sourceCaseId ?? null})
      returning id
    `;
    return rows[0].id;
  });
}

/**
 * 记一条长期记忆。
 *
 * ## 三件事必须分开，否则记忆会被自己污染
 *
 * **basis**：`stated` 当事人自己说的 · `observed` 系统观察到的 ·
 * `inferred` **你推出来的**。「我上夜班」是 stated，
 * 「所以他白天睡觉」是 inferred。混在一起存，几年下来 AI 会把自己的
 * 猜测读回去当事实、再基于它推新的——**不可逆地越跑越偏**。
 *
 * **subjectKey**：同一个人 + 同一个主题只留一条当前有效。
 * 3 月说「11点睡」、8 月说「凌晨3点回」不是两条并列的记忆，
 * 是后者**取代**前者。按主题键取代比按文本相似度可靠得多——
 * 中文改写的三元组相似度会掉到 0.05，根本认不出是同一件事。
 *
 * **factFrom / factTo**：这条事实在**世界里**的有效期，
 * 跟 valid_from/valid_to（记录的有效期）是两回事。
 * 「这周上夜班」和「长期上夜班」的 factTo 完全不同。
 *
 * 取代不删除：旧行填 valid_to + superseded_by，
 * 这样才答得出「他什么时候改的作息」。
 */
export async function noteMemory(args: {
  householdId: string;
  personId?: string | null;
  kind: string;
  content: string;
  /**
   * 默认 stated。**推断一定要显式填 inferred**；
   * **别人说他的（A 投诉 B 那类）填 third_party**——那不是他自己承认的
   */
  basis?: "stated" | "observed" | "inferred" | "third_party";
  /** 谁说的。可能不是这条记忆的主人（室友转述、A 投诉 B） */
  statedBy?: string | null;
  /** 主题键，同人同主题只留一条当前有效 */
  subjectKey?: string | null;
  factFrom?: Date | null;
  factTo?: Date | null;
  confidence?: number | null;
  sourceEventId?: string | null;
  /** 语义召回用。算不出来就不给，不影响写入 */
  embedding?: number[] | null;
}): Promise<string> {
  const basis = args.basis ?? "stated";
  return await db().begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into coliving.memory
        (household_id, person_id, kind, content, basis, stated_by,
         subject_key, fact_from, fact_to, confidence, source_event_id, embedding)
      values (${args.householdId}, ${args.personId ?? null}, ${args.kind},
              ${args.content}, ${basis}, ${args.statedBy ?? null},
              ${args.subjectKey ?? null}, ${args.factFrom ?? null},
              ${args.factTo ?? null},
              ${args.confidence ?? (basis === "inferred" ? 0.5 : 0.85)},
              ${args.sourceEventId ?? null},
              ${args.embedding ? `[${args.embedding.join(",")}]` : null}::vector)
      returning id
    `;

    if (args.personId && args.subjectKey) {
      // 同人同主题的旧记忆被取代。**不删**——留着才答得出「他什么时候改的」
      await tx`
        update coliving.memory
        set valid_to = now(), superseded_by = ${row.id}
        where person_id = ${args.personId}
          and subject_key = ${args.subjectKey}
          and valid_to is null
          and id <> ${row.id}
      `;
    } else if (args.personId) {
      // 没给主题键时退回文本相似度。**弱**：中文改写会掉到 0.05，
      // 所以工具描述里要求模型尽量给 subjectKey
      await tx`
        update coliving.memory
        set valid_to = now(), superseded_by = ${row.id}
        where person_id = ${args.personId} and valid_to is null
          and id <> ${row.id}
          and similarity(content, ${args.content}) > 0.2
      `;
    }

    if (args.personId) {
      // 总量闸：notes 每轮都进上下文，没上限的话用得越久提示词越肿
      await tx`
        update coliving.memory set valid_to = now()
        where id in (
          select id from coliving.memory
          where person_id = ${args.personId} and valid_to is null
          order by created_at desc offset 10
        )
      `;
    }
    return row.id;
  });
}

/**
 * 语义召回长期记忆。**「之前是不是也发生过类似的事」用 SQL 查不了**——
 * 说法千变万化（半夜切菜／凌晨有人／别晚上做饭／宵夜吵醒我），
 * 字面完全不同但说的是一件事。这是向量该干的活。
 */
export async function recallMemories(args: {
  householdId: string;
  queryVector: number[];
  limit?: number;
}): Promise<
  Array<{ who: string | null; kind: string; content: string; basis: string }>
> {
  const vec = `[${args.queryVector.join(",")}]`;
  return (await db()`
    select p.display_name as who, m.kind, m.content, m.basis
    from coliving.memory m
    left join coliving.person p on p.id = m.person_id
    where m.household_id = ${args.householdId}
      and m.embedding is not null
    order by m.embedding <=> ${vec}::vector
    limit ${args.limit ?? 5}
  `) as never;
}

// ── 按需展开的查询（Context Builder 默认不带，模型要了才查）──────────────────

export async function lookupEvents(args: {
  householdId: string;
  aboutPersonId?: string | null;
  kind?: string | null;
  sinceDays?: number;
  limit?: number;
}): Promise<PastEvent[]> {
  const since = args.sinceDays ?? 180;
  const limit = args.limit ?? 10;
  return await db()<PastEvent[]>`
    select e.id, e.kind, e.summary, e.severity,
           e.recorded_at as "recordedAt",
           p.display_name as "reportedBy",
           e.case_id as "caseId"
    from coliving.event e
    left join coliving.person p on p.id = e.reported_by
    where e.household_id = ${args.householdId}
      and e.recorded_at > now() - (${since} || ' days')::interval
      and (${args.kind ?? null}::text is null or e.kind = ${args.kind ?? null})
      and (${args.aboutPersonId ?? null}::uuid is null
           or ${args.aboutPersonId ?? null}::uuid = any(e.about_person_ids)
           or e.reported_by = ${args.aboutPersonId ?? null}::uuid)
    order by e.recorded_at desc
    limit ${limit}
  `;
}

/**
 * 附近的环境观察 —— 设计稿第三、四点的落地。
 *
 * 「Kevin 和这个臭味有关」不落库，而是在这里按**空间 + 时间**动态推算：
 * 房子的坐标 ↔ 观察的坐标在影响半径内，且时间窗重合。
 * 房子没填经纬度时这个查询自然返回空，不报错。
 */
export async function nearbyObservations(args: {
  householdId: string;
  kind?: string | null;
  at: Date;
  windowMinutes?: number;
}): Promise<
  Array<{
    kind: string;
    summary: string | null;
    observedAt: Date;
    severity: number | null;
    confidence: number | null;
    distanceM: number;
  }>
> {
  const win = args.windowMinutes ?? 180;
  return (await db()`
    select o.kind, o.summary, o.observed_at as "observedAt",
           o.severity, o.confidence,
           coalesce(round(st_distance(o.geog, pl.geog)::numeric)::int, 0)
             as "distanceM"
    from coliving.household h
    join coliving.dwelling d on d.id = h.dwelling_id
    join coliving.place pl on pl.id = d.place_id
    -- 两种匹配都算：
    --   ① 有经纬度时按距离（外部数据源、传感器）
    --   ② **没经纬度时按同一个地点**（住户自己报的，我们通常只知道「这栋房子」）
    -- 只留 ① 的话，住户报的观察永远查不出来——表写了也白写。
    join coliving.observation o
      on (
           (o.geog is not null and pl.geog is not null
            and st_dwithin(o.geog, pl.geog, coalesce(o.radius_m, 500)))
        or (o.geog is null and o.place_id = pl.id)
         )
    where h.id = ${args.householdId}
      and (${args.kind ?? null}::text is null or o.kind = ${args.kind ?? null})
      and o.observed_at between
            ${args.at}::timestamptz - (${win} || ' minutes')::interval
        and ${args.at}::timestamptz + (${win} || ' minutes')::interval
    order by o.observed_at desc
    limit 5
  `) as never;
}

/**
 * 找相似的历史 Case。
 *
 * 设计稿第十一点：**向量只是普通查询之外的一种检索方式**，不是数据库结构本身。
 * 所以这里先做结构化前置过滤（同一栋房子、可选类别），再按语义排序——
 * 而不是拿一个向量去全库捞。
 *
 * 没有向量（还没算过 embedding）时自动退回 pg_trgm 关键词相似，不报错。
 */
export async function findSimilarCases(args: {
  householdId: string;
  query: string;
  queryVector?: number[] | null;
  kind?: string | null;
  limit?: number;
}): Promise<
  Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
    resolution: string | null;
    score: number | null;
  }>
> {
  const limit = args.limit ?? 5;
  if (args.queryVector?.length) {
    const vec = `[${args.queryVector.join(",")}]`;
    return (await db()`
      select id, title, kind, status, resolution,
             round((1 - (embedding <=> ${vec}::vector))::numeric, 3)::float as score
      from coliving.case_file
      where household_id = ${args.householdId}
        and embedding is not null
        and (${args.kind ?? null}::text is null or kind = ${args.kind ?? null})
      order by embedding <=> ${vec}::vector
      limit ${limit}
    `) as never;
  }
  return (await db()`
    select id, title, kind, status, resolution,
           round(similarity(title, ${args.query})::numeric, 3)::float as score
    from coliving.case_file
    where household_id = ${args.householdId}
      and (${args.kind ?? null}::text is null or kind = ${args.kind ?? null})
      and (title % ${args.query} or kind = ${args.kind ?? null})
    order by similarity(title, ${args.query}) desc, last_activity_at desc
    limit ${limit}
  `) as never;
}

/** 检索治理资料/判例（Knowledge 域）。同样先结构化后语义。 */
export async function searchKnowledge(args: {
  queryVector: number[];
  kind?: string | null;
  jurisdiction?: string | null;
  limit?: number;
}): Promise<Array<{ title: string; body: string; score: number }>> {
  const vec = `[${args.queryVector.join(",")}]`;
  return (await db()`
    select d.title, c.body,
           round((1 - (c.embedding <=> ${vec}::vector))::numeric, 3)::float as score
    from coliving.knowledge_chunk c
    join coliving.knowledge_doc d on d.id = c.doc_id
    where c.embedding is not null
      and (${args.kind ?? null}::text is null or d.kind = ${args.kind ?? null})
      and (${args.jurisdiction ?? null}::text is null
           or d.jurisdiction = ${args.jurisdiction ?? null})
    order by c.embedding <=> ${vec}::vector
    limit ${args.limit ?? 4}
  `) as never;
}

export async function setCaseEmbedding(
  caseId: string,
  vector: number[]
): Promise<void> {
  await db()`
    update coliving.case_file
    set embedding = ${`[${vector.join(",")}]`}::vector
    where id = ${caseId}
  `;
}

/** 还没算过向量的 Case，供离线补算 */
export async function casesMissingEmbedding(
  limit = 50
): Promise<
  Array<{ id: string; title: string; kind: string; resolution: string | null }>
> {
  return (await db()`
    select id, title, kind, resolution from coliving.case_file
    where embedding is null order by last_activity_at desc limit ${limit}
  `) as never;
}

/**
 * 改名。AI 在对话里听出真名时用——**不是让住户填表**，
 * 是它自己听出来的。`confirmed` 表示这名字是本人说的，不是我们编的。
 */
export async function renamePerson(args: {
  personId: string;
  name: string;
  confirmed?: boolean;
}): Promise<void> {
  await db()`
    update coliving.person
    set display_name = ${args.name},
        name_confirmed = ${args.confirmed ?? true},
        updated_at = now()
    where id = ${args.personId}
  `;
}

// ── 开张与加人 ──────────────────────────────────────────────────────────────

/**
 * 第一个号码入库：没有房子就开一栋，把这个人放进去当**还不知道是谁的联系人**。
 *
 * **这是整个系统的起点。** 用户先拿到一个号码——通常是先认识的那个人，
 * 但**号码本身从来不说明他是谁**：他可能是房东、租客、宿管、物业、中介，
 * 或者我们压根还不知道。所以这里登记成 `role = 'other'` / `resides = null`
 * / 占位名「1号联系人」，身份与居住等往后的对话里听出来再补
 * （`renamePerson` / `addResident`）。
 *
 * **绝不默认 landlord，也绝不当成住在这儿**：共用资源按人头分、共同规则按人
 * 征询，都建在 `resides` 上，一开始就猜错，后面每一步都跟着错。
 *
 * 其余住户的号码由 AI 在对话里问出来（`addResident`）。幂等：同一个号码重复
 * 调用不会重复建人。
 */
export async function enrollFirstContact(args: {
  phone: string;
  label?: string | null;
}): Promise<{ personId: string; householdId: string; created: boolean }> {
  const phone = normalizePhone(args.phone);
  if (!phone) {
    throw new Error("[coliving] 手机号无法解析");
  }
  return await db().begin(async (tx) => {
    /**
     * **同一个号码并发进来两次**（他连发两条，两条 webhook 同时在跑）时，
     * 没有这把锁两个事务都会查不到、都去 insert，撞上
     * `person_contact_kind_value_uniq` 直接报错——用户第一条消息什么都收不到。
     * 按号码串行化，后来那个走 `existing` 分支，幂等。
     */
    await tx`select pg_advisory_xact_lock(hashtext(${`enroll:${phone}`}))`;
    const [existing] = await tx<{ person_id: string; household_id: string }[]>`
      select pc.person_id, m.household_id
      from coliving.person_contact pc
      join coliving.membership m
        on m.person_id = pc.person_id and m.valid_to is null
      where pc.kind = 'sms' and pc.value = ${phone}
      limit 1`;
    if (existing) {
      return {
        personId: existing.person_id,
        householdId: existing.household_id,
        created: false,
      };
    }

    const label = args.label?.trim() || "这栋房子";
    const [place] = await tx<{ id: string }[]>`
      insert into coliving.place (kind, label, country)
      values ('dwelling', ${label}, 'US') returning id`;
    const [dw] = await tx<{ id: string }[]>`
      insert into coliving.dwelling (place_id, label)
      values (${place.id}, ${label}) returning id`;
    const [h] = await tx<{ id: string }[]>`
      insert into coliving.household (dwelling_id, label)
      values (${dw.id}, ${label}) returning id`;
    await tx`
      insert into coliving.household_epoch (household_id, seq, label, started_at)
      values (${h.id}, 1, '开张', now())`;

    const personId = await insertInitialContact(tx, h.id, phone);

    return { personId, householdId: h.id, created: true };
  });
}

/**
 * 建一个「还不知道是谁」的联系人，挂到指定房子上。
 *
 * 角色 other / 居住 null —— **两件都不知道**，不是「不确定所以按住着算」。
 * 见 membership-facts.ts：号码不说明任何一件事，猜错就是算错。
 * 只给 `enrollFirstContact`（新开一栋）和 `enrollUnknownSender`（并进测试屋）共用。
 */
async function insertInitialContact(
  tx: postgres.TransactionSql,
  householdId: string,
  phone: string
): Promise<string> {
  const [p] = await tx<{ id: string }[]>`
    insert into coliving.person (display_name, onboarded_at)
    values (${placeholderName("other", 1)}, now()) returning id`;
  await tx`
    insert into coliving.person_contact (person_id, kind, value, is_primary)
    values (${p.id}, 'sms', ${phone}, true)`;
  await tx`
    insert into coliving.membership (household_id, person_id, role, resides)
    values (${householdId}, ${p.id}, 'other', null)`;
  return p.id;
}

/**
 * **陌生号码第一次发消息进来：给他建/接上他自己的那套联系上下文。**
 *
 * 老板 2026-10-01 的口径：任何号码正常进入对话，不再彻底模板拒绝。这条就是
 * 「正常进入」那一半——**先把上下文建出来**（role other / resides unknown，
 * 同号码幂等），后面的第一句固定介绍、第二条正常回复都跑在普通轮次那条路上，
 * 跟早就录入过的号码**走同一个入口**（`runColivingTurn` 里不再有第二条分叉）。
 *
 * **生产：这个号码自己的房子。** 走 `enrollFirstContact`——每次都是新的
 * place → dwelling → household，**从不按 Unit / label 去找已有的房子**。
 * 所以两个陌生号码都自称「Unit 208」也各是各的 household：谁的记录谁都看不到，
 * 不存在「自动并屋」这件事（这里没有那个判断，也就不会写错那个判断）。
 *
 * **测试：显式并进一栋已有的测试屋**（`intoTestHouseholdId`，只有本地脚本 /
 * 评测传，生产路由**永远不传**）。本地进程不许碰真人的房子，所以这里对目标
 * household 自己再查一次 `is_test`——**不靠调用方自觉**，也不是「本地就放行」：
 * 并进非测试屋直接抛错。号码解析不出来（不是合法号码）返回 `null`，调用方
 * 仍走那句中性的兜底回复。
 */
export async function enrollUnknownSender(args: {
  phone: string;
  channel: string;
  /** **仅本地测试/评测**：并进这栋已有的测试屋。生产调用方一律不传 */
  intoTestHouseholdId?: string | null;
}): Promise<Sender | null> {
  const phone = normalizePhone(args.phone);
  if (!phone) {
    return null;
  }

  if (args.intoTestHouseholdId) {
    const target = args.intoTestHouseholdId;
    if (!(await isTestHousehold(target))) {
      throw new Error(
        "[coliving] 陌生号码只能并进测试屋；目标是真人的房子，拒绝入库"
      );
    }
    /**
     * **过闸必须在第一次写入之前**（2026-10-01 预审第一条）。
     *
     * 以前这条路径只靠 `runColivingTurn` 里**建完档之后**的那次 `assertCanWrite`
     * 兜底——可 `enrollUnknownSender` 一旦跑完，人和 household 已经落库了，
     * 事后拦截**撤销不了已经写进去的真实数据**。所以闸放在这里：目标已经查实
     * 是测试屋，按它的真实身份过闸。
     */
    assertCanWrite({
      isTestHousehold: true,
      what: `把陌生号码并入测试屋（${target}）`,
    });
    await db().begin(async (tx) => {
      // 同一个号码并发两条首消息：跟 enrollFirstContact 同一把锁、同一个理由
      await tx`select pg_advisory_xact_lock(hashtext(${`enroll:${phone}`}))`;
      const [existing] = await tx<{ id: string }[]>`
        select person_id as id from coliving.person_contact
        where kind = 'sms' and value = ${phone} limit 1`;
      if (existing) {
        return;
      }
      await insertInitialContact(tx, target, phone);
    });
  } else {
    /**
     * **生产路径：给这个号码新开一栋他自己的房子。**
     *
     * `isTestHousehold: false` 是**事实**，不是保守估计——`enrollFirstContact`
     * 新建的 household `is_test` 就是默认的 false。所以本地进程走这条路会在这里
     * 被拦下（`COLIVING_LOCAL_WRITE=1` 也救不了它，因为目标不是测试屋），
     * **一栋真房子都不会被建出来**；服务器运行时（Vercel / next dev）照常放行。
     *
     * 本地想跑陌生号码，只有一条路：显式传 `intoTestHouseholdId` 指一栋测试屋
     * （见上面那一支，那里对目标再查一次 `is_test`）。
     */
    assertCanWrite({
      isTestHousehold: false,
      what: `给陌生号码新建联系上下文（${phone}）`,
    });
    await enrollFirstContact({ phone });
  }

  return await resolveSender(args.channel, phone);
}

/**
 * 加一个**跟这栋房子有关的人**。**AI 从对话里拿到号码时调用**——房东把
 * 号码发过来，它就一个个加进来，不需要任何人填表。
 *
 * 这里登记的是「这个号码属于谁、他跟这栋房子是什么关系」，不预设他是谁。
 * 房东报来的号码可能是租客，也可能是宿管、物业、中介，或者我们压根还不知道
 * 是谁——**号码本身就是个号码**：
 *
 *   · `role` 不填就是 `other`（还不知道什么身份），**不默认成 tenant**
 *   · `residence` 不填就是 `null`（不知道住不住这儿），**不默认成住在**
 *
 * `residence` 是三态（`confirmed_lives` / `confirmed_not_living` / `unknown`），
 * 映射进 `resides` 的 `true / false / null`。拿不准时按住着算的那套已经废了：
 * 共用资源按人头分、共同规则按人征询，都建在这个数上，猜错就是算错。
 *
 * 名字先占位（**按角色给中性词**，别把宿管叫成「2号住客」）；真名在往后的
 * 对话里听出来再改（`renamePerson`）。
 *
 * 已经认识的人再被报一次：**只补明确说出口的事实，省略的一律保留原值**
 * （见 `mergeMembershipFacts`）——再报一次号码不该把上次问出来的身份抹掉，
 * 也不会重复建一条关系（`membership_active_uniq` 兜着）。
 */
export async function addResident(args: {
  householdId: string;
  phone: string;
  name?: string | null;
  /** 不填 / `other` = 还不知道什么身份。**不要替对方猜** */
  role?: Role | null;
  /** 三态。不填 = 不知道住不住这儿，**不等于住在这儿** */
  residence?: ResidenceInput | null;
  note?: string | null;
}): Promise<{
  personId: string;
  created: boolean;
  name: string;
  role: Role;
  resides: boolean | null;
}> {
  const phone = normalizePhone(args.phone);
  if (!phone) {
    throw new Error("手机号无法解析");
  }
  const suppliedRole = args.role && args.role !== "other" ? args.role : null;
  const suppliedResides = residesFromInput(args.residence);
  return await db().begin(async (tx) => {
    const [existing] = await tx<
      {
        person_id: string;
        display_name: string;
        /** null = 人在库里，但跟这栋房子还没有生效关系（left join 没命中） */
        role: Role | null;
        resides: boolean | null;
        note: string | null;
      }[]
    >`
      select pc.person_id, p.display_name,
             m.role, m.resides, m.note
      from coliving.person_contact pc
      join coliving.person p on p.id = pc.person_id
      left join coliving.membership m
        on m.person_id = pc.person_id
       and m.household_id = ${args.householdId}
       and m.valid_to is null
      where pc.kind = 'sms' and pc.value = ${phone} limit 1`;
    if (existing) {
      if (existing.role !== null) {
        // 这人已经在这栋房子的名册上。**只补明说的事实，不做减法**
        const merged = mergeMembershipFacts(
          {
            role: existing.role,
            resides: existing.resides,
            note: existing.note,
          },
          {
            role: suppliedRole,
            resides: suppliedResides,
            note: args.note ?? null,
          }
        );
        await tx`
          update coliving.membership
          set role = ${merged.role}, resides = ${merged.resides}, note = ${merged.note}
          where household_id = ${args.householdId}
            and person_id = ${existing.person_id} and valid_to is null`;
        return {
          personId: existing.person_id,
          created: false,
          name: existing.display_name,
          role: merged.role,
          resides: merged.resides,
        };
      }
      // 人在库里（别的房子 / 搬回来过），但跟这栋房子还没有生效关系
      const role = suppliedRole ?? "other";
      await tx`
        insert into coliving.membership (household_id, person_id, role, resides, note)
        values (${args.householdId}, ${existing.person_id}, ${role},
                ${suppliedResides}, ${args.note ?? null})`;
      return {
        personId: existing.person_id,
        created: false,
        name: existing.display_name,
        role,
        resides: suppliedResides,
      };
    }

    const role = suppliedRole ?? "other";
    // 占位名按人数编号，但**模型会并行调多次 addResident**——
    // 两个事务同时读到同样的 count，两个人都叫「2号住客」，
    // findPersonByName 就分不清了。用事务级咨询锁按房子串行化。
    await tx`select pg_advisory_xact_lock(hashtext(${args.householdId}))`;
    const [n] = await tx<{ c: number }[]>`
      select count(*)::int as c from coliving.membership
      where household_id = ${args.householdId} and valid_to is null`;
    const displayName = args.name?.trim() || placeholderName(role, n.c + 1);
    const [p] = await tx<{ id: string }[]>`
      insert into coliving.person (display_name, onboarded_at)
      values (${displayName}, now()) returning id`;
    await tx`
      insert into coliving.person_contact (person_id, kind, value, is_primary)
      values (${p.id}, 'sms', ${phone}, true)`;
    await tx`
      insert into coliving.membership (household_id, person_id, role, resides, note)
      values (${args.householdId}, ${p.id}, ${role}, ${suppliedResides},
              ${args.note ?? null})`;
    return {
      personId: p.id,
      created: true,
      name: displayName,
      role,
      resides: suppliedResides,
    };
  });
}

// ── 成员变更（换人）─────────────────────────────────────────────────────────
// **不覆盖历史**：搬走是给旧行填 valid_to，搬进是插新行；
// 成员结构一变就开一个新 epoch，用来分辨「这栋房子长期如此」
// 还是「某一批人凑在一起才出问题」。

async function rollEpoch(
  tx: postgres.TransactionSql,
  householdId: string,
  label: string
): Promise<void> {
  const [cur] = await tx<{ seq: number }[]>`
    select coalesce(max(seq), 0) as seq from coliving.household_epoch
    where household_id = ${householdId}
  `;
  await tx`
    update coliving.household_epoch set ended_at = now()
    where household_id = ${householdId} and ended_at is null
  `;
  await tx`
    insert into coliving.household_epoch (household_id, seq, label, started_at)
    values (${householdId}, ${cur.seq + 1}, ${label}, now())
  `;
}

export async function moveOut(args: {
  householdId: string;
  personId: string;
  reason?: string | null;
}): Promise<void> {
  await db().begin(async (tx) => {
    await tx`
      update coliving.membership set valid_to = now(),
        note = coalesce(note || ' / ', '') || ${args.reason ?? "搬出"}
      where household_id = ${args.householdId}
        and person_id = ${args.personId} and valid_to is null
    `;
    const [p] = await tx<{ display_name: string }[]>`
      select display_name from coliving.person where id = ${args.personId}
    `;
    await rollEpoch(
      tx,
      args.householdId,
      `${p?.display_name ?? "某人"} 搬出后`
    );
    // 他个人的偏好记忆也随之失效——那是关于「他住在这里时」的事实
    await tx`
      update coliving.memory set valid_to = now()
      where person_id = ${args.personId} and household_id = ${args.householdId}
        and valid_to is null
    `;
  });
}

export async function moveIn(args: {
  householdId: string;
  name: string;
  phone: string;
  role?: Role;
  /**
   * 住不住在这里。**必须显式给，不要从 role 推。**
   * 曾经写成 `role !== 'landlord'`，结果同住的房东被算成不住这儿，
   * 三个人的厨房被按两个人分了。房东完全可以住在自己房子里——
   * 他要是住这儿，共用资源就得算他一份，共同规则他也是一票。
   */
  resides?: boolean;
  note?: string | null;
}): Promise<string> {
  const phone = normalizePhone(args.phone);
  return await db().begin(async (tx) => {
    // 同一个手机号可能是老住户搬回来——复用同一个 person，身份不因搬家而改变
    const [existing] = await tx<{ person_id: string }[]>`
      select person_id from coliving.person_contact
      where kind = 'sms' and value = ${phone} limit 1
    `;
    let personId: string;
    if (existing) {
      personId = existing.person_id;
    } else {
      const [p] = await tx<{ id: string }[]>`
        insert into coliving.person (display_name, onboarded_at)
        values (${args.name}, now()) returning id
      `;
      personId = p.id;
      await tx`
        insert into coliving.person_contact (person_id, kind, value, is_primary)
        values (${personId}, 'sms', ${phone}, true)
      `;
    }
    await tx`
      insert into coliving.membership
        (household_id, person_id, role, resides, note)
      values (${args.householdId}, ${personId}, ${args.role ?? "tenant"},
              ${args.resides ?? true}, ${args.note ?? null})
      on conflict do nothing
    `;
    await tx`
      update coliving.person set onboarded_at = now()
      where id = ${personId} and onboarded_at is null
    `;
    await rollEpoch(tx, args.householdId, `${args.name} 搬入后`);
    return personId;
  });
}

// ── 共识规则：问过谁、谁同意、谁有异议 ───────────────────────────────────────

export type PendingRule = {
  id: string;
  kind: string;
  statement: string;
  consulted: string[];
  agreedBy: string[];
  objected: string[];
};

/**
 * 还没走完一轮征询的规则——主动发起的 cron 靠它找活干。
 *
 * **现场算，不靠 consulted_at 这个标志位。** 判据就是这条规则名下，
 * 名册上还住着的人里，有没有谁既不在 agreed_by 也不在 objected 里；
 * 有就是没走完，没有就是走完了——跟 getActiveRules 里 pendingNames
 * 用的是同一套算法，两处不该有两套真相。
 */
export async function rulesNeedingConsult(
  householdId: string
): Promise<PendingRule[]> {
  return await db()<PendingRule[]>`
    select r.id, r.kind, r.statement,
           r.consulted as "consulted", r.agreed_by as "agreedBy",
           r.objected as "objected"
    from coliving.rule r
    where r.household_id = ${householdId}
      and r.status in ('proposed','active')
      and exists (
        select 1 from coliving.membership mb
        join coliving.person p on p.id = mb.person_id
        where mb.household_id = r.household_id
          and mb.valid_to is null
          and mb.resides is not false
          and not (p.id = any(r.agreed_by))
          and not (p.id = any(r.objected))
      )
    order by r.valid_from
  `;
}

export async function recordConsultation(args: {
  ruleId: string;
  personId: string;
  stance: "asked" | "agreed" | "objected";
}): Promise<void> {
  // 表过态的人一律进 consulted；agreed/objected 再各自加一列。
  // **不能把两条 set 拼成一句**——stance=asked 时两边都是 consulted，
  // PostgreSQL 会报「multiple assignments to same column」，
  // 整个工具调用静默失败（真实 bug，问过 0 人就是这么来的）。
  const p = `{${args.personId}}`;
  await db()`
    update coliving.rule
    set consulted = (select array_agg(distinct x)
                     from unnest(consulted || ${p}::uuid[]) x)
    where id = ${args.ruleId}
  `;
  if (args.stance === "agreed") {
    await db()`
      update coliving.rule
      set agreed_by = (select array_agg(distinct x)
                       from unnest(agreed_by || ${p}::uuid[]) x),
          objected = array_remove(objected, ${args.personId}::uuid)
      where id = ${args.ruleId}
    `;
  } else if (args.stance === "objected") {
    await db()`
      update coliving.rule
      set objected = (select array_agg(distinct x)
                      from unnest(objected || ${p}::uuid[]) x),
          agreed_by = array_remove(agreed_by, ${args.personId}::uuid)
      where id = ${args.ruleId}
    `;
  }
}

/**
 * 表态齐了就自动收口。**由代码判断，不靠模型**。
 *
 * 这类「状态读得到、但没人做那个收尾动作」的 bug 已经犯过三次：
 * `roster_complete` 读了没人写、`name_confirmed` 写了没人读、
 * 现在是征询完成没人合。表现都一样——AI 被提示词一直催着去问，
 * 问到了也没处收，于是下一轮接着问。
 *
 * 判据是确定性的：名册上没有 `resides = false` 的人里，
 * 每一个都出现在 agreed_by 或 objected 里。
 *
 * **但「表态齐了」不等于「都同意了」**——调用方要能区分「全同意，定下来
 * 了」和「有人反对，得改」，不能看到 done=true 就当成尘埃落定（真实发生
 * 过：recordStance 的返回提示原样写死"这条规则已经定下来"，一个人同意
 * 都没有、只有一条异议，也被这么告诉模型），所以额外把 objectedCount
 * 带出去。
 *
 * ## 有异议时**不许**把规则置成 `'active'`（2026-10-06 修）
 *
 * 以前这条 SQL 无论是非都把 `status` 写成 `'active'`：一条只有异议、谁也
 * 没同意的规则，在库里读起来和「全员同意生效」一模一样（`getActiveRules`
 * 把 `status in ('active','proposed')` 一起读，`context.ts` 靠 `objectedCount`
 * 才没念错成「已经定下来了」——但库里的状态本身已经在撒谎）。
 * 现在：
 *
 * - **有异议** → 仍然记 `consulted_at`（这一轮确实问完了，模型不该被催着
 *   再问一遍），但 `status` 保持原样（`'proposed'`）。规则**不成立**，
 *   要按异议改了再走一轮。
 * - **无异议** → 升 `'active'`，并**在这一刻**把同 kind 里旧的 `'active'`
 *   规则 retire 掉（`saveRule` 只顶掉旧草案，不顶在跑的规则——退休动作
 *   属于「新规则真的定案了」，不属于「有人提了一版」）。
 *
 * `objected_count` 取自 `returning` 里的**同一行**，所以「升不升 active」与
 * 「告诉调用方有没有异议」用的是同一个数字，不会两处不一致。
 *
 * ## `consulted_at` 不是收口开关；反对者改口同意要能再收口一次（2026-10-06 补）
 *
 * 上面那版把 `consulted_at is null` 当成**唯一的收口闸**，于是留下一个死角：
 * 全员都表过态、其中一条是异议 → 记 `consulted_at`、状态停在 `'proposed'`；
 * 之后**同一个人对同一条没改过的草案改口同意** → `consulted_at` 已经非空，
 * 收口 SQL 从此不再执行：这条规则既不会升 `'active'`，也**永远不会登记定案通知**。
 *
 * 现在收口与否**现场算**（就是 `not exists` 那条拿名册比 `agreed_by` / `objected`），
 * `consulted_at` 只做审计戳——这正是 `coliving-world-10.sql` 给这一列下的定义
 * （"不再是完成判断的依据"）。闸门改成：
 *
 * - `'proposed'` 的草案**永远可以收口**，包括异议撤回之后的第二次；
 * - 从没收口过的旧行（`'active'` 且 `consulted_at is null`）照旧允许收口；
 * - **已经收口过的 `'active'` 规则不再重收**——幂等，不会重复登记待发台账；
 * - **已退休 / 有效期已过的行一律不收口**：`saveRule` 退休旧草案时写的就是
 *   `status='retired' + valid_to`，模型手里那个陈旧 `ruleId` 不能把一条退休规则
 *   重新置成 `'active'`、再群发一遍定案通知。
 */
export async function closeConsultationIfComplete(
  ruleId: string
): Promise<{ done: boolean; objectedCount: number }> {
  const rows = await db()<{ id: string; objected_count: number }[]>`
    with target as (
      select r.id, r.household_id from coliving.rule r where r.id = ${ruleId}
    ),
    expected as (
      select array_agg(p.id) as ids
      from target t
      join coliving.membership mb on mb.household_id = t.household_id
      join coliving.person p on p.id = mb.person_id
      where mb.valid_to is null and mb.resides is not false
    ),
    closed as (
      update coliving.rule r
      set consulted_at = now(),
          status = case when coalesce(array_length(r.objected, 1), 0) = 0
                        then 'active' else r.status end
      where r.id = ${ruleId}
        -- 只认在册的草案 / 在跑的规则。已退休、或有效期已过的行不能被一个陈旧
        -- id 复活（saveRule 退休旧草案时填的就是 status='retired' + valid_to）。
        and r.status in ('proposed', 'active')
        and (r.valid_to is null or r.valid_to > now())
        -- **收口与否现场算，不拿 consulted_at 当完成开关**（见上「consulted_at
        -- 不是收口开关」与 coliving-world-10.sql 对那一列的定义）。这一条同时
        -- 管幂等：草案永远可以收口（含"先有人反对、后来同一个人改口同意"的第二次
        -- 收口）；从没收口过的旧行照旧允许收口；**已经收口过的 'active' 规则不再
        -- 重收**，所以待发台账不会重复登记。
        and (r.status = 'proposed' or r.consulted_at is null)
        and not exists (
          select 1 from coliving.membership mb
          join coliving.person p on p.id = mb.person_id
          where mb.household_id = r.household_id
            and mb.valid_to is null
            and mb.resides is not false
            and not (p.id = any(r.agreed_by))
            and not (p.id = any(r.objected))
        )
      returning r.id, r.kind, r.household_id,
                coalesce(array_length(r.objected, 1), 0) as objected_count
    ),
    retired as (
      update coliving.rule prev
      set status = 'retired', valid_to = now()
      from closed c
      where prev.household_id = c.household_id
        and prev.kind = c.kind
        and prev.id <> c.id
        and prev.status = 'active'
        and c.objected_count = 0
      returning prev.id
    ),
    notice_work as (
      insert into coliving.decision
        (household_id, kind, target_person_ids, intent, rationale, model_id,
         doctrine_modules, context_chars, context_snapshot, payload)
      select c.household_id, 'contact_group', e.ids,
             '共同规则定案通知（待发台账）',
             '代码在规则定案那一刻登记的定案通知待办：参与人名单冻结在此，' ||
             '回执按 (规则, 人) 记；只有登记过的规则才会被补发，历史规则不回溯。',
             null, '{}'::text[], 0, null,
             jsonb_build_object(
               'finalNoticeRuleId', c.id::text,
               'finalNoticePersonIds', array_to_string(e.ids, ',')
             )
      from closed c, expected e
      where c.objected_count = 0 and e.ids is not null
      returning id
    )
    select id, objected_count from closed
  `;
  return rows.length > 0
    ? { done: true, objectedCount: rows[0].objected_count }
    : { done: false, objectedCount: 0 };
}

/**
 * **定案通知的待发台账**：只列**登记过通知待办**、且还有人没拿到的规则。
 *
 * 待办是 `closeConsultationIfComplete` 在**定案那一刻**写下的 `contact_group` decision
 * （`payload.finalNoticeRuleId` ＋ `finalNoticePersonIds`）。所以驱动表是 `decision`，
 * **不是 `rule`**：上线前就已定案的老规则没有待办、永远不会被翻出来群发；参与人名单
 * **冻结在定案那一刻**（之后搬进来的人不会被通知「大家都同意了」，他根本没参与过）；
 * 共识证明是显式的——登记的每一位都必须真的在 `r.agreed_by` 里，不用
 * 「`consulted_at` 有值 ＋ 没异议」间接推断。
 *
 * 回执按 `decision.payload` 里代码写死的两个 id（`finalNoticeRuleId` ＋
 * `finalNoticePersonId`，先例是 `latestBlacklistReference`）关联
 * `communication.status`，且**收件人要对上**（`c.to_person_id =
 * payload.finalNoticePersonId`）——本轮那条 decision 是整轮共用的，别的工具也挂在
 * 它下面，只按 decision 认会把无关消息当成收据。`sent` 才算已通知；`queued` 在途先不
 * 重发、**不算已通知**，日后变 `failed` / `skipped` 自动落回待发。名册口径与
 * `getActiveRules` 一致（`valid_to is null` ＋ `resides is not false`）。
 *
 * **返回的每一条都真的还有人没拿到**（`limit` 之前就按同一套回执判据筛过），且按
 * 定案时间从老到新排——待办在库里是永久的，不筛就会被发完的老规则占满名额。
 */
export async function finalNoticeCandidates(
  householdId: string
): Promise<FinalNoticeCandidate[]> {
  return await db()<FinalNoticeCandidate[]>`
    select * from (
    select distinct on (d.payload->>'finalNoticeRuleId')
           d.payload->>'finalNoticeRuleId' as "ruleId",
           r.statement,
           r.consulted_at as "consultedAt",
           coalesce(array_length(r.objected, 1), 0) as "objectedCount",
           coalesce((
             select json_agg(json_build_object('personId', p.id,
                                               'name', p.display_name)
                             order by p.display_name)
             from unnest(
                    string_to_array(d.payload->>'finalNoticePersonIds', ',')::uuid[]
                  ) as u(pid)
             join coliving.membership mb on mb.person_id = u.pid
               and mb.household_id = r.household_id
               and mb.valid_to is null
               and mb.resides is not false
             join coliving.person p on p.id = u.pid
           ), '[]'::json) as "residents",
           coalesce((
             select array_agg(distinct c.to_person_id)
             from coliving.decision rd
             join coliving.communication c on c.decision_id = rd.id
             where rd.household_id = r.household_id
               and rd.payload->>'finalNoticeRuleId' = r.id::text
               and rd.payload->>'finalNoticePersonId' is not null
               -- **收件人也必须对上**：本轮那条 decision 是整轮共用的，别的工具
               -- （contactPerson / 回复本身）也挂在它下面；只按 decision 认，会把
               -- 「发给别人的一条无关消息」当成这个人已收到定案通知。
               and c.to_person_id = (rd.payload->>'finalNoticePersonId')::uuid
               and c.status = 'sent'
           ), '{}') as "acceptedPersonIds",
           coalesce((
             select array_agg(distinct c.to_person_id)
             from coliving.decision rd
             join coliving.communication c on c.decision_id = rd.id
             where rd.household_id = r.household_id
               and rd.payload->>'finalNoticeRuleId' = r.id::text
               and rd.payload->>'finalNoticePersonId' is not null
               and c.to_person_id = (rd.payload->>'finalNoticePersonId')::uuid
               and c.status = 'queued'
           ), '{}') as "inFlightPersonIds"
    from coliving.decision d
    join coliving.rule r on r.id = (d.payload->>'finalNoticeRuleId')::uuid
    where d.household_id = ${householdId}
      and d.kind = 'contact_group'
      and d.payload->>'finalNoticeRuleId' is not null
      and d.payload->>'finalNoticePersonIds' is not null
      and r.status = 'active'
      and not exists (
        select 1
        from unnest(
               string_to_array(d.payload->>'finalNoticePersonIds', ',')::uuid[]
             ) as u(pid)
        where not (u.pid = any(r.agreed_by))
      )
      -- **只列还真有人没拿到的待办，而且要在 limit 之前筛**：不筛的话，早就全部发完的
      -- 老待办会一直占着这 10 个位置，新的待办永远排不进来（这条待办在库里是永久的，
      -- 已经全发完的规则不会消失）。判据与下面算回执的那两个子查询同一套：
      -- 这个人有 sent/queued 的通知就不算缺口。
      and exists (
        select 1
        from unnest(
               string_to_array(d.payload->>'finalNoticePersonIds', ',')::uuid[]
             ) as u(pid)
        join coliving.membership mb on mb.person_id = u.pid
          and mb.household_id = r.household_id
          and mb.valid_to is null
          and mb.resides is not false
        where not exists (
          select 1
          from coliving.decision rd
          join coliving.communication c on c.decision_id = rd.id
          where rd.household_id = r.household_id
            and rd.payload->>'finalNoticeRuleId' = r.id::text
            and rd.payload->>'finalNoticePersonId' = u.pid::text
            and c.to_person_id = u.pid
            and c.status in ('sent', 'queued')
        )
      )
    order by d.payload->>'finalNoticeRuleId', d.decided_at desc
    ) t
    -- 等得最久的先发；条数上限之外的那些留到下一轮，下一轮它们就是最老的。
    order by t."consultedAt" nulls last, t."ruleId"
    limit 10
  `;
}

/**
 * **领一条定案通知的落库位置（同一 (规则, 人) 只能领到一次）。**
 *
 * 回执本来就是 `coliving.communication.status`（`sent` 算数、`queued` 在途），但
 * 「查有没有在途回执」和「写下这条 communication」如果分成两次连接，两个并发轮次会
 * 同时查到"还没有"、于是同一个人收到两条一样的定案通知。所以这里在**一个事务**里：
 * 拿 `(规则, 人)` 的咨询锁 → 复查回执 → 写 decision（带 `finalNoticeRuleId` ＋
 * `finalNoticePersonId`，回执靠这两个 id 关联回来）→ 写 communication → 写那条
 * 出站消息，**一次做完**。
 *
 * **消息也放进同一个事务，是 2026-10-07 修的一处静默丢件**：领取成功、可后面
 * 「取会话 / 写消息」那两步在**另一次连接**上做，任一失败就只剩一条 `queued` 的
 * communication——没有 provider 回执（调用方拿不到投递地址）、也没有任何重试（台账
 * 把 `queued` 当在途，那个人从此被划掉），这位住户的定案通知就永远发不出去了。
 * 收进同一个事务之后，失败整体回滚：这条 `(规则, 人)` **没被领走**，人仍在待发名单里，
 * 下一轮相关话题照旧重来。**不另立「已通知」标记、也不加 outbox 机制**——回执仍然只有
 * `communication.status` 这一个来源。
 *
 * 领到返回两个 id，调用方接着投递（消息已经在库里了）；**没领到返回 `claimed:false`**
 * ——那条通知已经在路上（别人已发或在途），调用方什么都不用做，不是缺口。
 *
 * 只吃代码算出来的 id，不碰模型自由文本；`assertCanWrite` 硬闸在这里、**写之前**跑
 * （调用方可能已经把正文交进来了，但一个字都还没落库）。
 */
export async function claimFinalNoticeDelivery(args: {
  householdId: string;
  /** 目标房子是不是测试屋——只给 `assertCanWrite` 硬闸用。 */
  senderIsTest: boolean;
  ruleId: string;
  personId: string;
  channel: string;
  body: string;
  purpose: string;
  caseId?: string | null;
  act?: CommunicationAct | null;
  expectsReply?: boolean;
  /** decision 的形状：单独发通知是 `contact_one`，并进本轮回复是 `reply_only`。 */
  decisionKind: string;
  decisionIntent: string;
  decisionRationale: string | null;
  /** 单独发通知时给（这条 decision 针对谁）；并入回复时为空。 */
  targetPersonIds?: string[] | null;
  /**
   * 消息要写进哪条会话。**并进本轮回复时给**（当前说话人的会话已经在了）；
   * 单独发通知时不给，按 (人, 渠道) 在同一个事务里取/建。
   */
  conversationId?: string | null;
}): Promise<{
  claimed: boolean;
  decisionId: string | null;
  communicationId: string | null;
}> {
  assertCanWrite({
    isTestHousehold: args.senderIsTest,
    what: `发送定案通知（${args.ruleId}）`,
  });
  return await db().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`final-notice:${args.ruleId}:${args.personId}`}))`;
    const existing = await tx<{ id: string }[]>`
      select c.id
      from coliving.decision rd
      join coliving.communication c on c.decision_id = rd.id
      where rd.household_id = ${args.householdId}
        and rd.payload->>'finalNoticeRuleId' = ${args.ruleId}
        and rd.payload->>'finalNoticePersonId' = ${args.personId}
        and c.to_person_id = ${args.personId}::uuid
        and c.status in ('sent', 'queued')
      limit 1
    `;
    if (existing.length > 0) {
      return { claimed: false, decisionId: null, communicationId: null };
    }
    const decisionId = await insertDecision(tx, {
      householdId: args.householdId,
      kind: args.decisionKind,
      targetPersonIds: args.targetPersonIds ?? [],
      intent: args.decisionIntent,
      rationale: args.decisionRationale,
      modelId: null,
      payload: {
        finalNoticeRuleId: args.ruleId,
        finalNoticePersonId: args.personId,
      },
    });
    const communicationId = await insertCommunication(tx, {
      householdId: args.householdId,
      decisionId,
      caseId: args.caseId ?? null,
      toPersonId: args.personId,
      channel: args.channel,
      purpose: args.purpose,
      body: args.body,
      act: args.act ?? null,
      expectsReply: args.expectsReply ?? false,
    });
    // **领取、communication、消息三样一起成败**：只领到前两样而消息没写进去，
    // 就是一条永远不会被投递、也不会被重试的 `queued`（见上面的说明）。
    const conversationId =
      args.conversationId ??
      (await insertConversation(tx, {
        personId: args.personId,
        householdId: args.householdId,
        channel: args.channel,
      }));
    await insertMessage(tx, {
      conversationId,
      personId: args.personId,
      direction: "outbound",
      channel: args.channel,
      body: args.body,
      communicationId,
    });
    return { claimed: true, decisionId, communicationId };
  });
}

// ── 主动发起的候选 ───────────────────────────────────────────────────────────

/** 冷了太久还没了结的事 */
export async function casesNeedingFollowup(args: {
  householdId: string;
  staleDays?: number;
  minGapDays?: number;
}): Promise<OpenCase[]> {
  return await db()<OpenCase[]>`
    select id, kind, title, status, severity, last_activity_at as "lastActivityAt"
    from coliving.case_file
    where household_id = ${args.householdId}
      and status in ('open','monitoring','waiting')
      and last_activity_at < now() - (${args.staleDays ?? 3} || ' days')::interval
      and (last_followup_at is null
           or last_followup_at < now() - (${args.minGapDays ?? 5} || ' days')::interval)
      and followup_count < 3
    order by last_activity_at
    limit 3
  `;
}

export async function markFollowedUp(caseId: string): Promise<void> {
  await db()`
    update coliving.case_file
    set last_followup_at = now(), followup_count = followup_count + 1
    where id = ${caseId}
  `;
}

/**
 * **刚录入系统两周内的人**——注意不是「刚搬进来的人」。
 *
 * 曾经把这两件事混为一谈：`onboarded_at` 记的是我们什么时候把人放进系统，
 * 提示词读成了入住时间，于是 AI 对一个住了三年的租客说
 * 「刚搬进来这几天住得还顺吗」。真正的入住时间在 `person.moved_in_at`，
 * 只有问出来才有，默认是 null。
 *
 * 这个窗口仍然值得主动接触——**因为我们刚认识他**，不是因为他刚搬来。
 */
export async function recentlyAdded(householdId: string): Promise<Member[]> {
  const rows = await getMembers(householdId);
  const all = await db()<
    {
      id: string;
      onboarded_at: Date | null;
      last_outreach_at: Date | null;
      proactive_ok: boolean;
    }[]
  >`
    select id, onboarded_at, last_outreach_at, proactive_ok from coliving.person
    where onboarded_at > now() - interval '14 days'
  `;
  const ok = new Set(
    all
      .filter(
        (p) =>
          p.proactive_ok &&
          (!p.last_outreach_at ||
            Date.now() - p.last_outreach_at.getTime() > 3 * 24 * 3600 * 1000)
      )
      .map((p) => p.id)
  );
  return rows.filter((m) => ok.has(m.personId));
}

/**
 * 给某人在某渠道登记地址。同一渠道同一地址只能属于一个人（唯一索引兜着），
 * 重复登记同一个人是幂等的。
 */
export async function addContact(args: {
  personId: string;
  kind: string;
  value: string;
}): Promise<void> {
  const value =
    args.kind === "sms" ? normalizePhone(args.value) : args.value.trim();
  await db()`
    insert into coliving.person_contact (person_id, kind, value, is_primary)
    values (${args.personId}, ${args.kind}, ${value}, false)
    on conflict (kind, value) do update set person_id = excluded.person_id
  `;
}

/** 改「住不住在这里」。房东可能就住在自己房子里，这是事实不是角色推导。 */
export async function setResides(args: {
  householdId: string;
  personId: string;
  resides: boolean;
}): Promise<void> {
  await db()`
    update coliving.membership set resides = ${args.resides}
    where household_id = ${args.householdId} and person_id = ${args.personId}
      and valid_to is null
  `;
}

export async function canReachProactively(personId: string): Promise<boolean> {
  const [p] = await db()<{ ok: boolean }[]>`
    select (proactive_ok and (last_outreach_at is null
            or last_outreach_at < now() - interval '2 days')) as ok
    from coliving.person where id = ${personId}
  `;
  return p?.ok ?? false;
}

export async function markOutreach(personId: string): Promise<void> {
  await db()`
    update coliving.person set last_outreach_at = now() where id = ${personId}
  `;
}

export async function setProactiveOk(
  personId: string,
  ok: boolean
): Promise<void> {
  await db()`
    update coliving.person set proactive_ok = ${ok} where id = ${personId}
  `;
}

export async function startOutreachRun(args: {
  householdId: string;
  job: string;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.outreach_run (household_id, job)
    values (${args.householdId}, ${args.job}) returning id
  `;
  return rows[0].id;
}

export async function finishOutreachRun(args: {
  runId: string;
  considered: number;
  acted: number;
  skipped?: Record<string, unknown>;
  error?: string | null;
}): Promise<void> {
  await db()`
    update coliving.outreach_run
    set finished_at = now(), considered = ${args.considered},
        acted = ${args.acted},
        skipped_reason = ${JSON.stringify(args.skipped ?? {})}::jsonb,
        error = ${args.error ?? null}
    where id = ${args.runId}
  `;
}

// ── 运维 / 调试用 ────────────────────────────────────────────────────────────

/**
 * 名册收没收全。**现场算，不缓存判断结果**（deduce, don't store）。
 *
 * 曾经是模型自己判断再传一个 `complete: boolean`——它经常算错：
 * 代码手里明明有 declared_size 和当前成员数两个数字，却要模型自己去比。
 * 现在只比这两个数，代码算，模型不参与这一步判断。
 */
export async function rosterStatus(householdId: string): Promise<{
  declaredSize: number | null;
  knownCount: number;
  /**
   * **这一户历史上记过的人**：按人去重，**含已离开的（`valid_to` 非空）与明确不住
   * 这儿的**。只增不减——所以「不用再收名册」不会因为有人搬走、名册只剩一个人在册
   * 又重新开口（见 `intake-once.ts` 的两条反例）。
   */
  historicalCount: number;
  complete: boolean;
  /**
   * **这一户已经有人报过人了**（不止一个人被记过）——判据与边界见 `intake-once.ts`
   * （老板 2026-10-06）。**是推导出来的、不是存下来的**（跟 `complete` 一样）：
   * 不新增列、不新增迁移。**停止收集 ≠ 名册齐全**，这一项为 true 时 `complete`
   * 仍可能是 false（真实那一户就没人报过总人数）。
   */
  intakeSupplied: boolean;
}> {
  const [row] = await db()<
    { declaredSize: number | null; knownCount: number; historicalCount: number }[]
  >`
    select h.declared_size as "declaredSize",
           (select count(*)::int from coliving.membership mb
             where mb.household_id = h.id and mb.valid_to is null
               and mb.resides is not false) as "knownCount",
           -- 历史人数：**不过滤 valid_to、不过滤 resides**（离开的人与宿管都算"报过"）
           (select count(distinct mb.person_id)::int from coliving.membership mb
             where mb.household_id = h.id) as "historicalCount"
    from coliving.household h where h.id = ${householdId}
  `;
  const declaredSize = row?.declaredSize ?? null;
  const knownCount = row?.knownCount ?? 0;
  const historicalCount = row?.historicalCount ?? 0;
  const complete = declaredSize !== null && knownCount >= declaredSize;
  return {
    declaredSize,
    knownCount,
    historicalCount,
    complete,
    // 判据在 `intake-once.ts`（纯模块、可离线测）：这里只喂事实，不写第二套阈值。
    intakeSupplied: householdIntakeSupplied({ historicalCount, complete }),
  };
}

/**
 * 最近发给**这栋房子里每个人**的消息（不只是当前这条会话线）。
 *
 * 没有这个，AI 只看得见跟当前这个人的往来，**根本不知道自己刚给别人
 * 发过什么**。真实后果：房东每说一句就触发一轮，每轮都去问 2号
 * 「你几点做饭」，一连问了四次，其中两次是在人家已经答过之后。
 *
 * **只返回 outbound。** 各会话线自己的入站由 `getRecentTurns` 管，别在这里
 * 再堆一遍；这里是「你最近对别人说过什么」，防止重复发问。
 */
export async function recentOutbound(
  householdId: string,
  limit = 6
): Promise<
  Array<{ to: string; body: string; sentAt: Date; direction: string }>
> {
  return (await db()`
    select p.display_name as "to", m.body, m.sent_at as "sentAt", m.direction
    from coliving.message m
    join coliving.conversation c on c.id = m.conversation_id
    join coliving.person p on p.id = m.person_id
    where c.household_id = ${householdId}
      and m.direction = 'outbound'
    order by m.sent_at desc
    limit ${limit}
  `) as never;
}

/** 记一个人说的"这屋一共住几个"。只存这一个数字，**不存判断结果** */
export async function setDeclaredSize(
  householdId: string,
  total: number
): Promise<void> {
  await db()`
    update coliving.household set declared_size = ${total}
    where id = ${householdId}
  `;
}

/** 记下某人真正搬进来的时间——**问出来才填**，不是录入时间 */
export async function setMovedInAt(
  personId: string,
  movedInAt: Date
): Promise<void> {
  await db()`
    update coliving.person set moved_in_at = ${movedInAt}, updated_at = now()
    where id = ${personId}
  `;
}

export async function isTestHousehold(householdId: string): Promise<boolean> {
  const [h] = await db()<{ is_test: boolean }[]>`
    select is_test from coliving.household where id = ${householdId}
  `;
  return h?.is_test ?? false;
}

/**
 * 开一栋测试屋。**本地脚本只能写这种。**
 * 真人住的房子由 `/api/coliving/enroll` 从房东号码建起，永远 is_test = false。
 */
export async function createTestHousehold(
  label = "测试屋"
): Promise<{ householdId: string }> {
  return await db().begin(async (tx) => {
    const [place] = await tx<{ id: string }[]>`
      insert into coliving.place (kind, label, country)
      values ('dwelling', ${label}, 'US') returning id`;
    const [dw] = await tx<{ id: string }[]>`
      insert into coliving.dwelling (place_id, label)
      values (${place.id}, ${label}) returning id`;
    const [h] = await tx<{ id: string }[]>`
      insert into coliving.household (dwelling_id, label, is_test)
      values (${dw.id}, ${label}, true) returning id`;
    await tx`
      insert into coliving.household_epoch (household_id, seq, label, started_at)
      values (${h.id}, 1, '开张', now())`;
    return { householdId: h.id };
  });
}

/**
 * 按房子名找一栋，找不到就开一栋**真实**的房子（`is_test` 走默认 false）。
 *
 * 这是给**表格导入**用的入口（`/api/coordination-history/import`），不是对话路径：
 * 合作方给一份住户名单，里面写着每间房的名字，我们得先把房子对上号。骨架跟
 * `enrollFirstContact` 建的一模一样（place → dwelling → household → epoch），
 * 少任何一个环节，这栋房子在别处就查不出来。
 *
 * 名字按 trim + 忽略大小写比对：「A101」和「 a101 」是同一间，不能各开一栋。
 * 并发导入同一份名单时用咨询锁按名字串行化，否则两个事务会同时查不到、
 * 各建一栋同名的房子。
 */
export async function ensureHouseholdByLabel(
  rawLabel: string
): Promise<{ householdId: string; created: boolean }> {
  const label = rawLabel.trim() || "这栋房子";
  // 锁的 key 单独加前缀：`addResident` 也按 householdId 上锁，两者是不同的
  // 命名空间，撞上了会白白互相等
  const lockKey = `household-label:${label.toLowerCase()}`;
  return await db().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${lockKey}::text))`;
    const [existing] = await tx<{ id: string }[]>`
      select id from coliving.household
      where lower(label) = lower(${label})
      order by created_at
      limit 1`;
    if (existing) {
      return { householdId: existing.id, created: false };
    }
    const [place] = await tx<{ id: string }[]>`
      insert into coliving.place (kind, label, country)
      values ('dwelling', ${label}, 'US') returning id`;
    const [dw] = await tx<{ id: string }[]>`
      insert into coliving.dwelling (place_id, label)
      values (${place.id}, ${label}) returning id`;
    const [h] = await tx<{ id: string }[]>`
      insert into coliving.household (dwelling_id, label)
      values (${dw.id}, ${label}) returning id`;
    await tx`
      insert into coliving.household_epoch (household_id, seq, label, started_at)
      values (${h.id}, 1, '开张', now())`;
    return { householdId: h.id, created: true };
  });
}

export async function listHouseholds(): Promise<
  Array<{ id: string; label: string }>
> {
  return await db()<{ id: string; label: string }[]>`
    select id, label from coliving.household
    where status = 'active' order by created_at
  `;
}

/**
 * 一条时间线：Event / Decision / Communication / Outcome 混排。
 * 这就是设计稿第十四点想留下的那条链，用来复盘「判断对不对、表达合不合适」。
 */
export async function recentActivity(
  householdId: string,
  limit = 30
): Promise<
  Array<{ at: Date; layer: string; label: string; detail: string | null }>
> {
  return (await db()`
    select * from (
      select e.recorded_at as at, 'EVENT' as layer,
             (e.kind || coalesce(' /' || e.severity, '')) as label,
             e.summary as detail
        from coliving.event e where e.household_id = ${householdId}
      union all
      select d.decided_at, 'DECIDE', d.kind, coalesce(d.intent, d.rationale)
        from coliving.decision d where d.household_id = ${householdId}
      union all
      select c.created_at, 'COMM',
             (c.status || ' → ' || p.display_name), c.body
        from coliving.communication c
        join coliving.person p on p.id = c.to_person_id
       where c.household_id = ${householdId}
      union all
      select o.observed_at, 'OUTCOME', o.kind, o.note
        from coliving.outcome o
        join coliving.case_file cf on cf.id = o.case_id
       where cf.household_id = ${householdId}
    ) t order by at desc limit ${limit}
  `) as never;
}

export async function findPersonByName(
  householdId: string,
  name: string
): Promise<Member | null> {
  const members = await getMembers(householdId);
  const trimmed = name.trim();
  return (
    members.find((m) => m.name === trimmed) ??
    members.find((m) => trimmed.includes(m.name) || m.name.includes(trimmed)) ??
    null
  );
}

/**
 * 把住户刚发来的这条消息，关联到**是哪条沟通引出来的**。
 *
 * 设计稿第十四点那条链里的「Human Response」那一环。
 * **刻意不交给模型判断**：这是确定性的时间与收件人匹配，代码做得又准又免费；
 * 交给模型只会时灵时不灵，而这条链断了就再也补不回来。
 *
 * 判据：这个人最近一条**已发出、还没人回应**的沟通，且在时间窗内。
 * 超过窗口就当他不是在回那条，宁可不关联也不要错关联。
 */
export async function linkResponse(args: {
  personId: string;
  messageId: string;
  withinHours?: number;
}): Promise<{ communicationId: string; purpose: string | null } | null> {
  const rows = await db()<
    { communicationId: string; purpose: string | null }[]
  >`
    update coliving.communication
    set responded_at = now(), response_message_id = ${args.messageId}
    where id = (
      select id from coliving.communication
      where to_person_id = ${args.personId}
        and status = 'sent'
        and responded_at is null
        and sent_at > now() - (${args.withinHours ?? 72} || ' hours')::interval
      -- **在等回复的那条优先**，其次才是最近的一条。
      -- 2026-09-05 实测发现的老 bug：以前只按 sent_at desc 取最近一条，
      -- 如果先问了个问题、又发了条不用回的通知，住户的回话会被算到
      -- 那条通知头上，**真正在等的问句永远清不掉**，于是它会一直留在
      -- 阻塞清单里，AI 以为还没人回、可能再问一遍。
      -- 这个 bug 一直存在，只是在 expects_reply 字段加进来之前
      -- 根本无从表达"哪条才是真的在等"。
      order by (expects_reply = true) desc, sent_at desc
      limit 1
    )
    returning id as "communicationId", purpose
  `;
  return rows[0] ?? null;
}

/**
 * 排班征询的「已确认该时段」持久事实。
 *
 * 住户对一条排班征询（act 为 ask/propose/confirm、正文含「你用 HH:MM-HH:MM」）
 * 回了**简单肯定**，`linkResponse` 已把那条回复关联回原沟通
 * （communication.response_message_id → 那条 inbound message）。这些行就是
 * 「谁确认过哪段」的记录。
 *
 * 复用 communication 的 responded 状态，**不新增写入**：比起另记一条
 * schedule 记忆，不会和「偏好/习惯」类 schedule 记忆混淆，也不占
 * `coliving.memory` 每人的上下文 note 名额。72h 窗口与 linkResponse 一致，
 * 把确认限定在「同一个协调段内」，防止上周的确认误伤这周的新排班。
 */
export async function listScheduleInquiryConfirmations(
  householdId: string,
  withinHours = 72
): Promise<
  Array<{ personId: string; inquiryBody: string; responseBody: string }>
> {
  return await db()<
    { personId: string; inquiryBody: string; responseBody: string }[]
  >`
    select c.to_person_id as "personId", c.body as "inquiryBody", m.body as "responseBody"
    from coliving.communication c
    join coliving.message m on m.id = c.response_message_id
    where c.household_id = ${householdId}
      and c.status = 'sent'
      and c.responded_at is not null
      and c.act in ('ask', 'propose', 'confirm')
      and m.direction = 'inbound'
      and c.sent_at > now() - (${withinHours} || ' hours')::interval
    order by c.sent_at desc
  `;
}

/**
 * 记一条环境观察。**属于地点和时间，不属于某个人**（设计稿第三点）。
 *
 * 住户说「外面今天特别臭」——这既是一个 Event（他报告了这件事），
 * 也是一条关于**这个地点**的观察。后者能长期留在这个地点上：
 * 几年后住户全换了，这栋房子的环境史还在；
 * 附近几栋房子也能共用同一条外部事件。
 */
export async function recordObservation(args: {
  householdId: string;
  kind: string;
  summary: string;
  observedAt?: Date | null;
  endsAt?: Date | null;
  severity?: number | null;
  source?: "resident" | "sensor" | "external" | "inferred";
  sourcePersonId?: string | null;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.observation
      (kind, place_id, observed_at, ends_at, severity, confidence,
       source, source_person_id, summary)
    select ${args.kind}, d.place_id,
           ${args.observedAt ?? new Date()}, ${args.endsAt ?? null},
           ${args.severity ?? null},
           ${args.source === "resident" ? 0.7 : 0.9},
           ${args.source ?? "resident"}, ${args.sourcePersonId ?? null},
           ${args.summary}
    from coliving.household h
    join coliving.dwelling d on d.id = h.dwelling_id
    where h.id = ${args.householdId}
    returning id
  `;
  return rows[0].id;
}
