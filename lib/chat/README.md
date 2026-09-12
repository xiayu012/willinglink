# 多渠道聊天（半成品骨架）

一句话原则：**WillingLink 的 conversation 才是聊天本体**，网页与短信只是同一个
conversation 的不同窗口。老板 2026-09-12 决定：外部**实时消息只做 `web` 与
`sms` 两条**（`CHANNELS = ["web", "sms"]`），合租房的实时通信渠道只有短信。

```
网页    /api/chat              → buildTurnSetup + streamText（SSE，保留流式）
短信    /api/twilio/messages   → Twilio adapter → 合租大脑 / Chat Engine → 出站 sendSms
```

## 现在有什么

| 文件 | 作用 | 成熟度 |
| --- | --- | --- |
| `types.ts` | `ChannelId`（web / sms）、`ConversationSource`、`InboundTurn`、`TurnResult` | 可用 |
| `engine.ts` | `buildTurnSetup()`（模型/提示词/工具唯一来源）、`runChatTurn()`（非流式整轮）、`runPostScopedTurn()` / `transformText()` | 可用 |
| `identity.ts` | 外部身份 → 内部 user，没见过就建 guest 并绑定 | 可用，需先建表 |
| `conversation.ts` | 内部 user → chatId（取最近一条，没有就新建） | 可用，策略以后可换 |
| `adapter.ts` | adapter 公共骨架 + 总开关 + 错误翻译 | 可用 |
| `twilio.ts` | 短信验签、TwiML、分段与出站发送 | 可用，详见 `TWILIO.md` |
| `app/api/twilio/messages` | 短信 adapter（合租房唯一实时渠道） | 可用，验签 + 空 TwiML + 出站 |
| `app/(chat)/api/chat` | 网页 SSE 入口，模型/提示词/工具从 `buildTurnSetup()` 拿 | 可用 |

小红书**私信**出站已整体下线：`xhs` 不在 `CHANNELS` 里，没有 adapter、没有
webhook、没有出站路径。**小红书的房源采集与帖子评论草稿是独立的非聊天功能**，
不属于实时消息渠道；评论草稿只借 conversation 存帖主身份（`ConversationSource`
里保留 `"xhs"` 标签），它不是私信、不走出站。

## 跨渠道上下文是怎么成立的

`handleInboundMessage` 里没有"某渠道的会话"这一步：

1. `resolveInternalUserId({ channel, externalUserId })` → 内部 userId
2. `resolveChatIdForUser({ userId })` → 该用户**唯一**的那条 conversation
3. `runChatTurn()` 按 chatId 读**全部**历史，不管当初从哪个渠道进来

所以：网页说"想找 Sunnyvale"→ 短信说"预算 1300"，模型看到的是同一串对话；
网页打开这条 conversation 也能看到短信里说的那句。

## 三种语义，别混用

`engine.ts` 的三个导出对应三件**根本不同**的事，混用的代价见 AGENT_LOG
2026-08-25 那一节（comment-reply 的 6 个 case 里 5 个是同一个混用造成的）：

| 函数 | 读历史 | 有工具 | 写库 | 用在哪 |
|---|---|---|---|---|
| `runChatTurn` | ✅ 最近20条 | ✅ | ✅ | **对话**：短信 |
| `runPostScopedTurn` | ❌ | ✅ | ✅ | **单帖**：评论草稿（非聊天） |
| `transformText` | ❌ | ❌ | ❌ | **纯变换**：压缩、改写 |

判断标准是**这次动作的输入应该是什么**：对话的输入是"这个人说过的话"，历史
就是它的本体；单帖的输入只该是这一篇帖子；纯变换的输入只有那段待处理的文字。

## 上线顺序（按这个来，每步都可单独回滚）

1. **建表**：Neon 控制台执行 `lib/db/migrations/manual/channel-identity.sql` 第 1 段。
   不跑这步，adapter 会返回 501 并明确告诉你差什么。
2. **打开开关**：`CHANNEL_ADAPTERS_ENABLED=1`（默认关闭，因为这些是无鉴权入口，
   每次调用都会跑一轮带搜索的 agent）。
3. **消息打渠道标签**：跑 SQL 第 2 段，然后把 `channel` / `externalMessageId`
   两列补进 `lib/db/schema.ts` 的 `message` 定义，`runChatTurn` 里存消息时带上。
   顺序不能反：drizzle 会按 schema 定义查列，库里没列会直接报错。
4. **接 Twilio**：验签、TwiML、分段、出站已在 `lib/chat/twilio.ts`，详见 `TWILIO.md`。

## 有意没做的事

- **网页那条没有搬进 Chat Engine 跑**。SSE、resumable stream、标题生成、工具
  审批续跑都在 `/api/chat` 里，搬过来收益小风险大。它只是改成从
  `buildTurnSetup()` 拿模型/提示词/工具——**这一处收敛才是重点**，以后换模型
  两边同时生效，不会再出现各写一份然后慢慢漂移。
- **评论草稿（`/api/xhs/comment-reply`）保持独立**。它是一次性的"帖子评论生成"，
  无状态、不进聊天记录，跟已下线的私信不是一回事。
- **去重与限流**：`externalMessageId` 已经在链路里传，判重没写；webhook 渠道也
  还没有 entitlements 那样的额度控制。接真实渠道前必须补。
- **身份合并**只写了做法（SQL 注释里），没写流程。等真有两个渠道的同一个人
  再定谁并谁、冲突怎么办。
