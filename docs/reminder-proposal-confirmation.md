# 受约束提醒的「预览 → 确认」规范（开发用）

> 面向实现/验收的开发文档，不加载进生产大脑。
> 对外能力边界单点事实源是 `docs/USER_FACING_CAPABILITY_TRUTH.md`；本文只讲工程怎么做。
> 适用对象：个人物品使用提醒、夜间洗衣提醒这两项已开放的第三方出站功能。
> 建立于 2026-09-12 老板驳回「只回模板指引、要住户自己改写」之后。

## 目标

住户用自然语言表达同一件已开放的事、且**点名了名册里的室友**时，不要只丢一句
「请按固定说法发」，也不要直接替住户发。改成一个**可执行的预览 + 一句短确认**：

1. AI 如实摆出**要发给谁**、**将发出的那一句固定正文**；
2. 这条预览**只发给发起人本人**；
3. 住户回「确认」才真的写入那条第三方固定消息，回「取消」就不发。

**识别到近似请求本身绝不构成发给别人的授权**——授权的凭据是**落库的待确认提案
＋ 住户明确回「确认」**，不是助手文本、也不是进程内存。

## 非目标（明确不做）

- 不恢复通用 `contactPerson` / outreach 自由文本出站；本机制只承载两项功能的**写死正文**。
- 不做语义分类、不调模型：识别与确认解析都是纯字符串/正则。**有限正则只覆盖几组
  固定说法，不等于全面的语义识别**——覆盖不到的自然表达仍走普通对话。
- 不把混合、否定、未点名、其它未开放主题（一般噪音、卫生/头发、费用、规则等）拆成半边提案。
- 不新建 schema/枚举/迁移/框架：复用既有 `decision` / `communication` 表。

## 识别顺序（两个模块一致）

`deliverXReminder(text)` 依次：

1. **先按原有窄命令识别**（`recognizeXReminder`）。命中即走老路径，行为与
   未引入本机制前**完全不变**（含校验全过才发、回执）。
2. **不命中窄命令，再尝试合规的近似提案**（`tryXProposal`）。这里**不再看
   `looksLikeX` 前缀**——否则「点名室友但写成自由文本」的请求会先被判成
   「像命令」而绕过近似入口，退回旧的「要提醒谁」指引（2026-09-12 真实回退）。
   近似命中就落一条发给发起人的预览，返回 `kind:"proposal"`。
3. **两者都不中，才判** `looksLikeX(text)`：像这一族但受理不了 → 回一句短指引
   （`kind:"guidance"`，零第三方出站）；否则 `kind:"none"`，落回普通对话。

近似入口的判定核心是 `lib/chat/coliving/reminder-ask.ts` 的纯函数
（`hasXAskSignal` 预筛 + `looksLikeApproximateXAsk`）：要求「显式请求 AI 去提醒 +
名册里确有被点名的唯一室友 + 该功能独有主题 + 非讨论 + 非否定 + 非混合」同时成立。

## 数据模型与授权

一次近似请求落**四类记录**（只写发给发起人的消息，零第三方出站）：

- 入站消息（住户本轮原话）——先写，保证历史顺序是「住户请求 → AI 预览」。
- `decision`：`kind='contact_one'`、`target_person_ids=[收件人稳定 ID]`、
  `intent=<该功能 purpose>`、**`model_id=null`**、`rationale` 注明「待确认提案」。
- `communication`：`to_person_id=发起人`、`purpose=<该功能 purpose>`、
  `act='confirm'`、`expects_reply=true`、`body=预览文本`（含收件人姓名 + 固定正文 + 确认/取消）。
- 对应的 outbound `message`，绑定该 `communication`。

purpose 常量见 `REMINDER_PROPOSAL_PURPOSE`，前缀 `待确认提醒：` 用于「取消」时批量作废。
**同一时刻只允许一条待确认提案**：落新预览前先 `consumeReminderProposalsByPrefix`
作废该发起人 / 渠道 / 房子里所有还没回应的旧提案（否则后来的「确认」可能把更旧的翻出来发掉）。

## 原子认领（唯一的发送权）

`takeReminderProposal` 全部确定性校验，任一不符即 `none`、调用方**绝不发送**：

1. 取该住户该渠道**最近一条出站消息**（不分 purpose、不分状态）。
2. 它必须：绑定**当前** `conversationId`、属于**本项** `purpose`、`status='sent'`
   （**项目侧**投递状态为已投递，queued 不算；它**不代表对方已读**）、
   `act='confirm'`、`responded_at` 为空、在 `REMINDER_PROPOSAL_TTL_HOURS`(24h) 内。
3. 核对其 `decision`：本屋、`contact_one`、`intent` 与 `purpose` 一致、`model_id` 为空、
   `target_person_ids` 恰好一个且**不是发起人本人**。
4. `claimReminderProposal` **按 id 原子认领**（单条 `UPDATE ... WHERE status='sent'
   AND responded_at IS NULL AND id=(最新出站) AND TTL RETURNING`）。并发/重复「确认」
   第二次拿不到行 → `none`。

认领后由功能模块**再次**核对（见下），核对不过就把已认领的提案当失效处理、不发送；
**认领不退回**（退回会造成重复入队/重复外呼）。

这里的「只发一次」只指**同一条提案在项目侧只被认领一次**；它**不构成整个短信
网络（Twilio 投递与重试）的 exactly-once 保证**——项目侧入队一次，仍可能被下游
重试或重复投递。

## 确认 / 取消

`parseReminderConfirmation` **只认整条消息就是那几个词**：

- 确认：`确认 / 发送 / 发吧 / 就发 / 可以发`（可带「了/吧」）。
- 取消：`取消 / 不用了 / 不需要了 / 算了 / 别发了 / 不发了 / 不要发了 / 先别发 / 作罢 / 撤销`。
- 末尾**不剥问号**：「确认？」「可以吗？」是疑问、不是授权，返回 `none`。
- 「确认，但别提到我」这类混合内容既不确认也不取消，返回 `none`（不因歧义触发发送）。
- 「可以」「同意」「好的」「嗯」「是的」**不算**确认——这些词在别的话题里也天天出现。

取消走 `cancelPendingReminderProposals`：一次作废全部待确认提案，回固定真话
`REMINDER_PROPOSAL_CANCELLED_REPLY`（「好，这条提醒不发了。」）。

## 认领后的二次核对（各功能模块）

- 收件人按提案里绑定的**稳定 ID** 回**当前**同屋名册重新查找；不在 / 是本人 →
  `REMINDER_PROPOSAL_RECIPIENT_GONE_REPLY`。
- 姓名未确认 / 当前渠道无地址 → `reminderTargetIneligibleReply`。
- 预览正文必须与**当前**固定文案逐字一致（如 `personalItemProposalPreview(name)`）——
  防代码或姓名变动后照旧文案发 → `REMINDER_PROPOSAL_STALE_REPLY`。
- 写入第三方失败 → `REMINDER_PROPOSAL_FAILED_REPLY`（失败可能落在第三方**已入队
  之后**——写会话/消息那一步抛错——所以只说发送状态无法确认、不会自动重发；既不
  断言没发出，也不叫住户重说一遍（那会诱发重复）。**绝不谎报成功**）。

## 测试（免费、零真实写入）

`ReminderProposalDeps` / `reminderProposalDeps` 显式注入 repo 子集，让
`scripts/coliving-quality-inspect.ts` 用**假 repo** 断言行为（入队几条、正文、收件人），
而不是拿「源码里出现过某常量」冒充证据。已覆盖：合规命令成功、预览→确认→发送、
裸「确认」无提案、认领失败、预览未投递、最新出站是普通消息、正文不一致 STALE、
跨功能旧提案、入队抛错 FAILED 且重试 `none`、取消后陈旧确认、歧义姓名 / 不合规收件人回指引、
非本功能回普通对话、旧窄命令仍成功。预览轮场景断言见 corpus-033 第 3 轮、corpus-034
第 4 轮；预览 → 确认 → 发送、预览 → 取消的端到端多轮见 corpus-035。

本地质量脚本不是服务器运行时：落提案与发送都要过 `guard.ts` 的硬闸，脚本按它的
**正规姿势**放行——显式开 `COLIVING_LOCAL_WRITE=1`，且所有调用都传
`senderIsTest:true`（目标是测试屋）；**不把 `NEXT_RUNTIME` 设成 nodejs 冒充生产
运行时**（那是绕过硬闸，不是启用它）。针对的是假 repo，零数据库写入。

## 代码落点

- 判定核心：`lib/chat/coliving/reminder-ask.ts`（纯函数）
- 预览 / 认领 / 确认 / 取消：`lib/chat/coliving/reminder-proposal.ts`
- 两项模块：`lib/chat/coliving/personal-item-reminder.ts`、
  `lib/chat/coliving/night-laundry-reminder.ts`
  （导出 `deliverXReminder` / `confirmXReminder` / `xProposalPreview`，
  预览工具名 `PERSONAL_ITEM_PREVIEW_TOOL` / `NIGHT_LAUNDRY_PREVIEW_TOOL`，
  与真正的发送工具 `personalItemReminder` / `nightLaundryReminder` 区分）
- 接入点（主生成之前）：`lib/chat/coliving/turn.ts` 的 `finishConstrainedReminder(...)`
- 免费结构闸：`scripts/coliving-quality-inspect.ts`
