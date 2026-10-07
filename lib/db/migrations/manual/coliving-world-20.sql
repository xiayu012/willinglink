-- ============================================================================
-- 合租房世界模型 · 第二十批：「协调历史」页的实时变更信号
--
-- 起因（老板 2026-10-06）：`/coordination-history` 之前靠**每 30 秒轮询**自己
-- 重读。「三十秒太长了。一有消息短信任何动静就要更新。」——周期没有变小的余地
-- （三秒一次 = 每隔三秒把整页重读一遍，绝大部分时候什么都没变），所以信号改由
-- **写库那一方**发出来。
--
-- 这一批只加信号：不加数据、不改列、不动任何既有行的含义。往 coliving 里写
-- 消息 / 改会话 / 改外呼状态 / 动房子、成员、人、楼栋时顺手 `pg_notify` 一个
-- 常量；听 `coordination_history_change` 通道的人（每个 Vercel 实例一条，见
-- `lib/coordination-history/change-feed.ts`）收到就让浏览器重读那一页。
--
-- 走数据库而不是进程内存：页面同时活在好几个实例上，写库的（收短信的 Twilio
-- 回调）还可能是另一个实例，内存里的 EventEmitter 只通知得到自己那一个。
--
-- 三条写死的约束：
--   ① 通道上**只有常量 `'1'`**——没有房号、人名、电话、正文。谁改了什么不走
--      这条路，前端收到信号去请求那一页，过滤照旧由服务端做。
--   ② **`is_test` 的房子整栋不发声**（判据就是这一列，本批不读也不改它的语义）。
--      评测语料四百多栋测试屋，本地跑一轮就是成百上千条消息，无脑发会把正在
--      看页面的合作方刷屏。影子房（`label like '影子验证%'`）**故意不在这里滤**：
--      那是展示层的命名约定，抄进触发器等于焊进数据库；真要治就给影子房补一个
--      显式标记列，不是抄一个 `like`。
--   ③ **绝不能弄坏生产写路径**：`message` 那条挂在住户短信落库的 INSERT 上，
--      触发器里任何异常都会让**那条消息永久丢掉**。所以每个函数整个身体包在
--      `exception when others` 里——出任何事只是这一轮不实时，绝不向外抛。
--
-- 顺带一个便宜的好处：同一个事务里往同一通道发**内容相同**的通知 Postgres 只
-- 投递一条，所以一次导入写十一条 membership 只推一个信号出去。**常量载荷不只是
-- 隐私考虑，它本身就是合并机制。**
--
-- 落点（7 个触发器，名字都叫 coordination_history_notify）：
--   message       消息增/改/删。这一页的全部内容，唯一高频的一条。
--   conversation  会话增/改/删（`last_message_at` 的更新通常已被上一条覆盖）。
--   communication 外呼状态变化（queued → sent / failed / skipped）。**这一页现在
--                 不显示 communication 的任何字段**，所以这条当下和 message
--                 那条重复；留着是因为它是这批需求点名要的信号，代价只是一次会
--                 被合并掉的 notify。
--   household     房子增/改/删（左栏列表项、房号、状态）。
--   membership    成员增/改/删（中栏的人、身份、是否居住）。
--   person        改 `display_name`（消息署名、成员名）。人是跨房子的，所以要
--                 反查 membership 里有没有非测试房。
--   dwelling      改 `unit`（页面上那套房叫什么）。同理，反查 household。
--
-- **消失也要发信号**：一栋房子被改成 `is_test`、一条会话的 `household_id` 被
-- 置空，都是「它从这一页上消失了」。只看新值的话这种改动悄无声息，旧数据会一直
-- 挂在页面上。所以每个触发器都是 **OLD 或 NEW 只要有一次是可见的**就发。
--
-- 安装（本仓库的 manual/*.sql 一律手工应用，不进 drizzle journal）：
--   psql "$POSTGRES_URL" -f lib/db/migrations/manual/coliving-world-20.sql
-- 或者整份贴进 Neon 的 SQL Editor。**可以重复执行**：函数是 create or replace，
-- 触发器先 drop 再 create。回滚 SQL 在文件末尾，**故意注释掉**——这份文件要能
-- 整份直接跑，回滚那几行要是活的，一执行就把自己拆了。
-- ============================================================================

-- 通道名 `coordination_history_change` 同时写在 `change-feed.ts` 的
-- `CHANGE_CHANNEL` 里，**改一处要改两处**。

-- ── 判据：某项东西在这页上看得见吗 ──────────────────────────────────────────
-- 三张表各一个「可见」判定。household 的键列就叫 id，所以第一个函数直接收
-- household id。
create or replace function coliving.coordination_history_is_visible_household(
  p_household_id uuid
)
returns boolean
language sql
stable
as $$
  select p_household_id is not null
     and exists (
       select 1
       from coliving.household h
       where h.id = p_household_id
         and h.is_test = false
     )
$$;

-- 人跨房子，所以要反查 membership 里有没有非测试房
create or replace function coliving.coordination_history_person_is_visible(
  p_person_id uuid
)
returns boolean
language sql
stable
as $$
  select p_person_id is not null
     and exists (
       select 1
       from coliving.membership m
       join coliving.household h on h.id = m.household_id
       where m.person_id = p_person_id
         and h.is_test = false
     )
$$;

-- 楼栋同理，反查 household
create or replace function coliving.coordination_history_dwelling_is_visible(
  p_dwelling_id uuid
)
returns boolean
language sql
stable
as $$
  select p_dwelling_id is not null
     and exists (
       select 1
       from coliving.household h
       where h.dwelling_id = p_dwelling_id
         and h.is_test = false
     )
$$;

-- ── 触发器函数 ──────────────────────────────────────────────────────────────

-- message：household 要从 conversation 反查（message 上没有这一列）。INSERT 是
-- 热路径（每条短信都走），那里只查一次；UPDATE / DELETE 才查第二次。
-- 会话被删时 cascade 过来的消息删除查不到会话，不发信号——但那条路会话自己的
-- DELETE 已经发过了。
create or replace function coliving.coordination_history_notify_message()
returns trigger
language plpgsql
as $$
declare
  v_old_household uuid;
  v_new_household uuid;
begin
  if tg_op <> 'INSERT' then
    select c.household_id into v_old_household
    from coliving.conversation c
    where c.id = old.conversation_id;
  end if;

  if tg_op <> 'DELETE' then
    select c.household_id into v_new_household
    from coliving.conversation c
    where c.id = new.conversation_id;
  end if;

  if coliving.coordination_history_is_visible_household(v_old_household)
     or coliving.coordination_history_is_visible_household(v_new_household) then
    perform pg_notify('coordination_history_change', '1');
  end if;

  return null;
exception when others then
  -- 住户的短信就是这样落库的。出任何事都只当没发生——宁可这一轮不实时，
  -- 也不能让一条收到的短信写不进去
  return null;
end;
$$;

-- conversation / communication / membership 三张都直接带 household_id，共用
-- 这一个函数
create or replace function coliving.coordination_history_notify_household_column()
returns trigger
language plpgsql
as $$
declare
  v_old_household uuid;
  v_new_household uuid;
begin
  if tg_op <> 'INSERT' then
    v_old_household := old.household_id;
  end if;

  if tg_op <> 'DELETE' then
    v_new_household := new.household_id;
  end if;

  if coliving.coordination_history_is_visible_household(v_old_household)
     or coliving.coordination_history_is_visible_household(v_new_household) then
    perform pg_notify('coordination_history_change', '1');
  end if;

  return null;
exception when others then
  return null;
end;
$$;

-- household：**看这一行自己的 is_test，不能拿 id 去查 household 表**。DELETE
-- 走到这里时那一行已经没了，exists 查出来是空——一栋真房子被删掉反而悄无声息，
-- 页面上会一直挂着一套已经不存在的房。
create or replace function coliving.coordination_history_notify_household()
returns trigger
language plpgsql
as $$
declare
  v_visible boolean := false;
begin
  if tg_op <> 'INSERT' then
    v_visible := (old.is_test = false);
  end if;

  if not v_visible and tg_op <> 'DELETE' then
    v_visible := (new.is_test = false);
  end if;

  if v_visible then
    perform pg_notify('coordination_history_change', '1');
  end if;

  return null;
exception when others then
  return null;
end;
$$;

-- person：改名会改到消息署名和成员名，所以要发
create or replace function coliving.coordination_history_notify_person()
returns trigger
language plpgsql
as $$
declare
  v_old_person uuid;
  v_new_person uuid;
begin
  if tg_op <> 'INSERT' then
    v_old_person := old.id;
  end if;

  if tg_op <> 'DELETE' then
    v_new_person := new.id;
  end if;

  if coliving.coordination_history_person_is_visible(v_old_person)
     or coliving.coordination_history_person_is_visible(v_new_person) then
    perform pg_notify('coordination_history_change', '1');
  end if;

  return null;
exception when others then
  return null;
end;
$$;

-- dwelling：改 unit 会改掉页面上「这套房叫什么」
create or replace function coliving.coordination_history_notify_dwelling()
returns trigger
language plpgsql
as $$
declare
  v_old_dwelling uuid;
  v_new_dwelling uuid;
begin
  if tg_op <> 'INSERT' then
    v_old_dwelling := old.id;
  end if;

  if tg_op <> 'DELETE' then
    v_new_dwelling := new.id;
  end if;

  if coliving.coordination_history_dwelling_is_visible(v_old_dwelling)
     or coliving.coordination_history_dwelling_is_visible(v_new_dwelling) then
    perform pg_notify('coordination_history_change', '1');
  end if;

  return null;
exception when others then
  return null;
end;
$$;

-- ── 触发器（先 drop 再 create，重复执行不会撞名）──────────────────────────
drop trigger if exists coordination_history_notify on coliving.message;
create trigger coordination_history_notify
  after insert or update or delete on coliving.message
  for each row
  execute function coliving.coordination_history_notify_message();

drop trigger if exists coordination_history_notify on coliving.conversation;
create trigger coordination_history_notify
  after insert or update or delete on coliving.conversation
  for each row
  execute function coliving.coordination_history_notify_household_column();

drop trigger if exists coordination_history_notify on coliving.communication;
create trigger coordination_history_notify
  after insert or update or delete on coliving.communication
  for each row
  execute function coliving.coordination_history_notify_household_column();

drop trigger if exists coordination_history_notify on coliving.membership;
create trigger coordination_history_notify
  after insert or update or delete on coliving.membership
  for each row
  execute function coliving.coordination_history_notify_household_column();

drop trigger if exists coordination_history_notify on coliving.household;
create trigger coordination_history_notify
  after insert or update or delete on coliving.household
  for each row
  execute function coliving.coordination_history_notify_household();

drop trigger if exists coordination_history_notify on coliving.person;
create trigger coordination_history_notify
  after insert or update or delete on coliving.person
  for each row
  execute function coliving.coordination_history_notify_person();

drop trigger if exists coordination_history_notify on coliving.dwelling;
create trigger coordination_history_notify
  after insert or update or delete on coliving.dwelling
  for each row
  execute function coliving.coordination_history_notify_dwelling();

-- ============================================================================
-- 回滚（**故意注释掉**，要回滚就取消注释再执行）
--
-- 卸掉之后页面退回「打开时读一次」的静态行为，`/coordination-history` 本身照常
-- 工作。没有任何数据被改过，所以回滚没有数据损失。
-- ============================================================================
--
-- drop trigger if exists coordination_history_notify on coliving.message;
-- drop trigger if exists coordination_history_notify on coliving.conversation;
-- drop trigger if exists coordination_history_notify on coliving.communication;
-- drop trigger if exists coordination_history_notify on coliving.membership;
-- drop trigger if exists coordination_history_notify on coliving.household;
-- drop trigger if exists coordination_history_notify on coliving.person;
-- drop trigger if exists coordination_history_notify on coliving.dwelling;
--
-- drop function if exists coliving.coordination_history_notify_message();
-- drop function if exists coliving.coordination_history_notify_household_column();
-- drop function if exists coliving.coordination_history_notify_household();
-- drop function if exists coliving.coordination_history_notify_person();
-- drop function if exists coliving.coordination_history_notify_dwelling();
-- drop function if exists coliving.coordination_history_is_visible_household(uuid);
-- drop function if exists coliving.coordination_history_person_is_visible(uuid);
-- drop function if exists coliving.coordination_history_dwelling_is_visible(uuid);
