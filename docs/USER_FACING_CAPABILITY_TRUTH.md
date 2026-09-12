# 用户可见能力真相（对外能力边界单点事实源）

> 用途：回答一个具体问题——**AI 现在到底能替住户对「别人」做什么。**
> 涉及第三方出站、代转达、主动联系人、cron 主动发起的改动，先读本文件。
> 建立于 2026-09-12 老板「具体功能逐项开放」严格口径。
> 同目录相关：`.claude/CONCRETE_FUNCTIONS.md`（具体功能总册）、`.claude/PROJECT_STATE.md`。

> **2026-09-12 更新：第二项受约束功能「夜间洗衣提醒」已开放**（老板把它列为首批
> 方向之一）。它跟个人物品提醒同一套严格口径：窄命令、纯正则、写死正文、不过模型、
> 校验全过才发。只处理「深夜运行洗衣机 / 烘干机影响别人休息」这一件共同影响，
> **不外推到一般噪音、卫生整改、规则制定、费用分摊或去留协调**。下面两节如实列出
> 现在开放的两项功能与仍然做不到的事。

## 通信渠道：外部实时消息只有短信

- 老板 2026-09-12 决定：**外部实时消息只做短信（SMS，Twilio 路由）**，并彻底放弃
  企业微信与小红书私信/出站通道。`web` 是网页对话窗口，不是替住户对外发消息的渠道。
- 企业微信的运行时已整体移除：`app/api/wecom/messages/route.ts`、`lib/chat/wecom.ts`、
  `scripts/wecom-selftest.ts` 删除，`wecom:selftest` 命令、`proxy.ts` 的 `/api/wecom`
  放行、`CHANNELS` 里的 `wecom` 全部去掉。数据库迁移历史里的 `wecom` 取值保留作历史兼容，
  但**新的运行时不得再宣称或加载企业微信渠道**。
- 小红书**私信/出站通道**也已整体移除：`app/api/xhs/messages/route.ts`、
  `lib/chat/xhs-dm.ts`、`lib/chat/jijyun.ts`，以及只服务私信的 `lib/chat/redact-contact.ts`
  与对应评测脚本（`redact-eval` / `answer-coverage-eval`）删除；集简云 webhook 配置
  `JIJYUN_WEBHOOK_URL`、私信模型 `XHS_DM_MODEL`、`CHANNELS` 里的 `xhs` 全部去掉。
- **小红书不是实时消息通道的部分保留不动**：房源来源（`/api/xhs/rental-ingest`、
  `xhsRental*` 表、标题/地理分类、房源清理脚本）与**帖子评论草稿**
  （`/api/xhs/comment-reply`）。评论草稿是替用户写一段评论文字，不接 webhook、
  不做出站消息投递；它只是仍用 `xhs` 作帖主身份的 conversation 命名空间
  （见 `lib/chat/types.ts` 的 `ConversationSource`，**不在** `CHANNELS` 里）。
- 免费结构闸 `scripts/coliving-quality-inspect.ts` 守住这两条：`CHANNELS` 只有
  `web` / `sms`（不含 wecom、xhs）；企业微信的运行文件、`package.json` 自检命令、
  `proxy.ts` 路由与运行时代码里的 `wecom` 字面量均已清除；小红书私信的四条运行
  文件（`/api/xhs/messages` 路由、`xhs-dm.ts`、`jijyun.ts`、`redact-contact.ts`）
  不存在；同时确认小红书**房源采集**与**帖子评论草稿**路由仍在，以及 Twilio 短信
  投递与两项受约束提醒（个人物品、夜间洗衣）仍可投递。

## 允许发给另一个住户的功能（两项受约束功能）

### 1. 个人物品使用提醒 —— `lib/chat/coliving/personal-item-reminder.ts`

- 触发：住户发来 `提醒 阿川：使用我的个人物品前先问我`（允许标点与礼貌前缀的窄变体）。
- 识别：**纯正则，不过模型**；命令体夹带任何多余内容（理由、物品名、别的诉求）一律不认，
  落回普通对话或回一句短指引，**不发送**。
- 发给对方的正文是**写死的常量**：`使用室友的个人物品前，请先征得对方同意。`
  不含来源、住户原话、物品名、理由或额外要求——避免借物品名或备注夹带未开放的要求。
- 校验全过才发：同一栋房子、名册里唯一、姓名已确认、非本人、当前渠道有地址。
- 回给发起人一句短收据。**整条链路不调用 LLM。**

### 2. 夜间洗衣提醒 —— `lib/chat/coliving/night-laundry-reminder.ts`

- 触发：住户发来 `提醒 阿川：深夜别开洗衣机或烘干机`（允许标点与礼貌前缀的窄变体，
  例如「晚上不要用洗衣机」「别在深夜开洗衣机或烘干机」）。
- 识别：**纯正则，不过模型**；命令体夹带任何多余内容（清理头发、分摊水费、全屋规矩、
  人身攻击、具体钟点等）一律整体不认，**零第三方出站**，只回一句短的结构化指引；
  完全不是这条命令形态的深夜洗衣自由文本仍走普通对话。
- 发给对方的正文是**写死的常量**：
  `深夜使用洗衣机或烘干机容易影响他人休息，请尽量避开深夜时段。`
  不含来源、住户原话、具体钟点、自由理由或附带命令。
- 校验全过才发：同一栋房子、名册里唯一、姓名已确认、非本人、当前渠道有地址。
- 回给发起人一句短收据。**整条链路不调用 LLM。**
- 只处理「深夜运行洗衣机 / 烘干机影响别人休息」这一件共同影响，**不要求 AI 先裁定
  谁的卫生阈值或物品所有权**；不能从它外推到一般噪音、一般清洁、规则制定、费用或去留协调。

## 现在明确做不到的（住户能感知）

- **一般噪音 / 深夜噪音提醒（非洗衣）**：只能提醒「深夜别开洗衣机或烘干机」这一件；
  说话声、搬家具、电视音量等其它噪音仍不能替住户私下提醒。
- **卫生整改 / 清理头发**：不能替住户要求室友「洗完澡清掉浴室墙面与地漏里的头发」。
  现场程度的卫生整改**仍未开放**。
- **任何代转达、代问、催办、协调**：不能把住户的话替转给另一个住户。
- **群体联系 / 群发**：不能分别联系多个住户，也不能替一群人约谈某个人。
- **主动发起**：cron 的四类主动作业（回访、问全规则、接触新住户、到期提醒）全部停用；
  房东入库也不再收到第一条消息。住户不开口，AI 不主动发。
- 遇到上面这些请求，AI 只能在**跟当前说话人**的对话里回复，并如实说明这件事它没法
  替对方发出去；**不能用自由文本假装已经联系过对方**——命中
  `claimsUnsentThirdPartyContact` 时，那句话会被替换成一句说真话的未发送说明。

## 为什么是这些、不是别的

老板 2026-09-12 选严格口径：立刻收回所有自由文本的第三方出站，只保留**程序化受约束**的
功能，并按「具体功能」逐项开放。夜间洗衣提醒即按这条路径成为第二项：它**不是**恢复了当初
被收回的自由文本出站，而是又一个写成受约束模块的窄功能（见 `.claude/CONCRETE_FUNCTIONS.md`）。
卫生整改、一般噪音、代转达、群体联系、cron 主动发起等**仍然明确不开放**——不是被遗忘，
是要开放必须逐项走同一条评审，不能靠恢复通用工具或自由文案蒙混回来。

## 代码落点

- 受约束出站模块：`lib/chat/coliving/personal-item-reminder.ts`、
  `lib/chat/coliving/night-laundry-reminder.ts`
- 接入点（主生成**之前**）：`lib/chat/coliving/turn.ts` 里的 `finishConstrainedReminder(...)`
  公共收口，分别接 `deliverPersonalItemReminder(...)` 与 `deliverNightLaundryReminder(...)`
- 真话保护：`claimsUnsentThirdPartyContact` / `TRUTHFUL_UNSENT_REPLY`（同文件）
- 已停用的自由文本出站：`lib/chat/coliving/outreach.ts`（三个入口返回空，不调模型、不入队）
- 运行时上下文对模型的表述：`lib/chat/coliving/context.ts`
- 免费结构闸：`scripts/coliving-quality-inspect.ts`
- 隔离场景：`lib/chat/coliving/evals/scenarios/corpus-033-personal-item-reminder-2026-09-12.json`、
  `lib/chat/coliving/evals/scenarios/corpus-034-night-laundry-reminder-2026-09-12.json`

## 以后要重新开放一项功能的做法

1. 在 `personal-item-reminder.ts` 同级新增一个受约束模块：确定性识别 + 写死正文 +
   校验全过才发，不调 LLM、不接受自由正文（夜间洗衣提醒就是这么加的第二个实例）。
2. 在 `turn.ts` 主生成之前接入，走 `finishConstrainedReminder` 公共收口，命中即收工。
3. 更新本文件与 `context.ts` 里的运行时表述（让模型知道能力变了）。
4. 加免费确定性检查 + 一条隔离场景，再交 Codex 验收。

**不要**恢复 `contactPerson` 工具或 outreach 的自由文本生成——那是被明确收回的通用出口，
留着的签名与注释是回退路径的脚手架，不是可以随手打开的开关。
