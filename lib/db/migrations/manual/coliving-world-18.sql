-- ============================================================================
-- 合租房世界模型 · 第十八批：名册上的人不止「房东」和「租客」
--
-- 起因：`addResident` 把世界写死成三个推论——
--
--     landlord → tenant → 住在这里
--
-- 具体表现：
--   · `role` 只认 tenant / landlord。宿管、物业管理员、代为传话的协调人
--     一律被记成 tenant——**假的事实比空着更坏**，模型之后会照着它说话
--   · 号码一进来 `resides` 就写 true。可**号码本身从来不说明他住在这儿**：
--     宿管有这栋楼的号码，不代表他住这栋楼
--
-- 事实是两件互相独立的事，谁也不能推谁：
--   · **role**    —— 他是什么身份（租客 / 业主 / 宿管物业 / 协调人 / 还不知道）
--   · **resides** —— 他此刻住不住在这里（允许 null = 不知道）
--
-- 房东住在自己房子里（landlord + resides=true）和宿管不住这儿
-- （manager + resides=false）都是正常世界的一部分，都要能记下来。
--
-- 本批**只扩角色取值，不动任何已有行的 role / resides**：现存记录一律照旧，
-- 不因为这次放宽被降级成「不知道」。
-- ============================================================================

-- 内联 check 由 PostgreSQL 自动命名为 membership_role_check。
-- 先 drop 再 add：老库上它已经存在，新库上刚由 coliving-world.sql 建出来，
-- 两种情况都要幂等。
alter table coliving.membership
  drop constraint if exists membership_role_check;

alter table coliving.membership
  add constraint membership_role_check
  check (role in ('tenant','landlord','manager','coordinator','other'));

comment on column coliving.membership.role is
  '这个人跟这栋房子的关系：tenant 租客 / landlord 业主 / manager 宿管·物业 /
   coordinator 人类协调人 / other 其它或还不知道。**与 resides 相互独立**——
   房东可能就住在自己房子里，宿管通常不住；角色不决定居住，号码也不决定';
