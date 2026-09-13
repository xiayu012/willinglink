# 当前任务入口

## 当前纠正（2026-09-13）：能力说明不是逐功能编程，而是统一功能事实问答

老板澄清上一节理解过窄。不要把 `capability-followup.ts` 固化为「每一种未开放事项都写代码、
只接上一轮 unsupported」的专用系统。老板原本要的是：**所有与产品功能白名单、为什么不能做、
现在能做什么有关的问题，都让 AI 读取一份长期维护的功能事实源后回答**；以后新增功能不应再
额外编程一套能力说明。

请在当前未提交实现上返工，保持简单：

1. 建立一个统一、运行时可读取的“用户可见功能事实源”（可由现有
   `docs/USER_FACING_CAPABILITY_TRUTH.md` 拆出一个简洁、结构化、可打包的单点文件，或采用更可靠
   的同等方案）。它至少包含：当前开放功能清单；卫生整改的名称与“看不到现场程度、无法可靠
   判断是否达到要求别人整改标准”的原因；其它尚未记录具体理由的请求要诚实使用通用边界，不能编。
2. 建立**一个通用功能问答入口**：用户询问「你有什么功能 / 能不能做 X / 为什么 X 不能做 / 刚才
   为什么拒绝」等产品功能边界时进入。它可以利用最近对话或上一轮结构化 unsupported 状态理解
   “刚才”，但不能把“紧接上一轮”当唯一入口。
3. 这个入口不装载旧 doctrine、不进入主生成、没有工具和第三方出站。模型只看到：用户问题、统一
   功能事实源中的有关事实、当前开放功能清单；只负责说自然。不得补充处理方案、虚构能力或承诺
   联系/协调/跟进。输出失败或越界时使用事实源生成的安全兜底。
4. **不为每个新功能新增能力说明程序。** 以后新增功能时，开放名称应尽量从现有
   `APPROVED_FEATURES` 自动进入回答；需要补充用户可见解释时只改统一事实源的数据，不改问答引擎。
5. 删除/改写当前过窄、按关键词硬编码大量主题的设计；允许保留很小的问句识别与“上一轮主题”
   辅助，但不要让每个功能或未开放主题都对应一套程序分支。
6. 保持此前拍板的按需旁路策略：命中已批准功能、或进入统一功能问答时不装载旧大脑；其它普通
   对话才使用旧提示词大脑。现在不整包删除 doctrine。
7. 更新免费检查与长期文档。保留 corpus-035 两句原文。不要跑付费 eval、commit/push、改数据库
   schema/依赖/环境或触碰 `public/sw.js`。

完成后运行 `pnpm.cmd coliving:quality`、`pnpm.cmd exec tsc --noEmit`、`git diff --check`，并报告统一
事实源在哪里、以后新增功能要改什么、不需要再改什么。

---

## 当前任务（2026-09-13）：受约束的能力说明跟进

你是本任务唯一实现者。先读 `AGENTS.md`、`CLAUDE.md`、`.claude/PROJECT_STATE.md`、
`.claude/DEVELOPMENT_JUDGMENT.md`、`.claude/CONCRETE_FUNCTIONS.md` 与
`docs/USER_FACING_CAPABILITY_TRUTH.md`。本任务修复 corpus-035 暴露的真实产品缝隙。

### 事故与根因

第一轮「请叫阿川把地漏的头发清干净」正确走 `unsupported`，零第三方出站；第二轮紧接着问
「请问为什么连这么简单的功能都没有?那你有什么功能？」时，因为当前轮没有再次点名阿川，
绕过功能前门并落回旧主生成。主生成在旧 doctrine 的“协调员要推进”倾向下自由发挥成：
「地漏这个我自己去跟阿川讲……有结果我回你」，但实际没有出站能力，也没有安排后续。

### 产品目标

把「用户追问刚才为什么拒绝、现在能做什么」做成一条受约束的跟进说明路径。它不能进入旧的
大提示词主生成，也不能由模型自行判断或补充能力事实。代码必须提供且只提供这些事实：

- 刚才被拒绝的事项：`卫生整改`；
- 拒绝原因：AI 无法看到现场程度，目前不能可靠判断是否达到需要要求别人整改的标准；
- 当前开放功能：`个人物品使用提醒`、`夜间洗衣提醒`。

LLM 只负责把这些事实说成自然、简短的中文，不得补充处理方案，不得承诺自己去联系、协调、
跟进、转告或以后回复结果，不得虚构其它功能，也不得讲白名单、路由、提示词等内部工程术语。

### 实现边界

1. 沿用当前功能前门体系，做最小、清楚的实现；不要引入动作卡、LLM 工具或通用工作流框架。
2. 跟进识别必须利用最近一轮已经发生的 `unsupported` 事实，而不是要求用户在每轮重新点名室友。
   优先使用现有数据库中的上一轮 decision/communication/消息状态；若现有状态不足，可保存一个
   很窄的、结构化的 unsupported 主题标识，但不要把模型自由文本当权限或事实来源。
3. 能力说明的生成器只能收到上面三项代码事实和用户当前追问；不要把旧 doctrine、原始投诉全文、
   主生成工具表或任意能力知识交给它。输出须结构校验；失败时使用同样只含三项事实的代码兜底。
4. 普通未开放请求仍维持现在的一两句短回复，不主动罗列能力；只有用户明确追问“为什么不能 / 有
   什么功能”且紧接上一轮 unsupported 时，才进入本路径。
5. 不广泛删除现有 doctrine。本轮只把这一种能力说明从旧主生成中切出；其它普通对话保持现状。
6. 更新 `docs/USER_FACING_CAPABILITY_TRUTH.md`、`.claude/PROJECT_STATE.md` 与必要的免费确定性检查。
   把 corpus-035 纳入相应结构检查，但不要改老板给定的两句 `turns[].text`。
7. 不发送真实短信，不跑付费 `coliving-eval`，不改数据库 schema、依赖或环境配置，不碰
   `public/sw.js`。不要 commit/push。

### 免费验证

- `pnpm.cmd coliving:quality`
- `pnpm.cmd exec tsc --noEmit`（如仍只有既有 `speech-input.tsx` 两条 TS2717，须如实报告）
- `git diff --check`

完成后报告：实现如何可靠识别“紧接上一轮 unsupported 的能力追问”、模型实际看到的字段、兜底
文本、修改文件和免费验证结果。

---

## 当前返工（2026-09-13）：两项提醒按白名单直接执行

老板纠正：白名单决定功能是否可做；已命中且合规的自然交办直接执行，不增加「预览 → 确认 / 取消」第二层。
Claude Code 已移除预览/确认专用状态和 SQL，保留两项受约束提醒的固定正文、名册校验、旧窄命令兼容及自然请求判定。
验收重点：合规自然请求各恰一条固定第三方出站与短回执；卫生/费用等混合、讨论、否定、未点名零出站；确认/取消不再有专门发送语义。
免费质量检查 147 项通过；034 隔离重演结构通过、零模型生成，报告 `2026-09-13T01-11-45-891Z.html`。tsc 仅剩原有 speech-input.tsx 两处声明冲突；不发送真人短信，不运行语义 judge。
本节以下均为历史任务，不应照其旧能力名单恢复或删除当前功能。

## 本轮规格（2026-09-12）：按老板严格口径收回通用第三方出站，只留「个人物品使用提醒」

**状态：Claude Code 已实现，待 Codex 独立验收。**

老板 2026-09-12「具体功能逐项开放」拍板，选**严格口径**：立刻收回所有自由文本的
第三方出站能力，只保留一个**程序化受约束**的具体功能。迁移策略 1（立刻关闭，不留
旧通用出口）。目标：未开放的请求不能再借「模型调 `contactPerson`」「自由文案」
「强制重发」「cron 主动发起」四条路溜出去。

### 本轮唯一开放的出站功能

`lib/chat/coliving/personal-item-reminder.ts` —— 个人物品使用提醒。

- 触发形态：`提醒 阿川：使用我的个人物品前先问我`（允许标点/礼貌前缀的窄变体）。
- **纯正则识别，不过模型**；命令体带任何多余内容（理由、物品名、别的诉求）即不认。
- 发给对方**只有一条写死的正文常量**，不含来源、用户原话、物品名、理由。
- 校验全过才发：同屋、名册里唯一且姓名已确认、非本人、当前渠道有地址。
- 收据回给发起人（短、只讲做成了什么）。
- 已经接在 `runColivingTurn` 主生成**之前**；命中即收工，不调 LLM。

### 本轮同时收回的旧路径（都保留签名/注释，便于日后按功能逐项走回）

- 生产 `activeTools` 里删掉 `contactPerson`；`enqueueScheduleContact`、排班确定性
  收口循环、forced-contact 兜底生成整体删除。模型即使想发也没有工具、也没有兜底。
- `outreach.ts` 三个入口（`kickoffLandlord` / `runOutreachForHousehold` / `runOutreach`）
  全部返回空结果，**不调模型、不入队**；cron / enroll 路由照旧调用，投递循环空转。
  SMS / 企业微信最终投递路由不改——它们仍要送达本功能产生的授权收据。
- 普通回复里若声称「已经联系/提醒了某个第三方」而本轮没有受约束出站，替换成一句
  简短的、说真话的未发送说明（`claimsUnsentThirdPartyContact` + `TRUTHFUL_UNSENT_REPLY`）；
  只抓第一人称完成/进行态，跟当前说话人的正常讨论不受影响。

### 验证

只跑免费闸：`pnpm.cmd coliving:quality`、`pnpm.cmd exec tsc --noEmit`、`git diff --check`。
新增隔离场景 `corpus-033-personal-item-reminder-2026-09-12` 与免费确定性检查，只证明
**结构与文本范围**，不宣称语言质量。不 commit/push，不碰 `public/sw.js`。

### 明确不做

- 不开放夜间洗衣、卫生整改或任何其它具体功能；它们仍走普通对话、没有第三方出站。
- 不改 SMS / 企业微信投递路由、不改 DB schema、不改依赖、不动真人数据、不发真实消息。
- 不迁移历史场景里的 `mustUseTools: ["contactPerson"]`（这类场景是旧通用能力的期望，
  已随严格口径失效，见本轮报告，留待 Codex 决定是否逐条改写）。

---


## 已完成任务（2026-09-12）：corpus-032 的窄范围一对一传话留出测试

**状态：已完成并通过 Codex 定向验收；无自动续跑任务。** 场景已落地为
`corpus-032-reddit-narrow-reminders-2026-09-12`；Codex 定向 `--judge-off` 跑通结构闸，最终有效
一次实际成本 $0.037510。更早一次 `--max-generations 2` 复跑因 embedding 占用上限而无效，不作证据。
本节其余内容保留为原始任务要求与证据，不再作为待执行任务。

你是本任务唯一实现者。先读 `AGENTS.md`、`CLAUDE.md`、`.claude/PROJECT_STATE.md`、
`.claude/DEVELOPMENT_JUDGMENT.md` 与 `lib/ai/brains/coliving/doctrine/domain/relay.md`。

### 任务目标

老板刚在其 Notion `reddit语料` 页加入 032：一名住户抱怨室友凌晨洗衣、以及洗澡后不清理
浴室头发等长期摩擦。原帖是发泄，不是给 AI 的原始交办；不能把整段故事直接当用户指令，
也不能为了覆盖它新造调解、规则制定、住宿去留或驱逐能力。

请只把其中两件**可以被当前已批准“一对一传话”完整完成**的具体提醒，做成一个新的、
独立的留出评测场景：

1. 当前住户明确请 AI 私下联系指定室友：凌晨四点洗衣/烘干会吵到其房间，请这一次先不要
   在深夜运行；
2. 当前住户明确请 AI 私下联系同一室友：洗澡后把浴室墙面和地漏里留下的大把头发清理掉。

可以为让测试成为真实产品输入而将 Reddit 第一人称叙事转换成自然、明确的中文交办，
但 `source` 必须如实写清这是由原帖转化而来、原帖本身并未向 AI 下令。不得把原帖中的
嘲讽、人身评价或“他根本不尊重我”带入出站。

### 明确不在范围内

- 不把访客凌晨到来转成规则制定或全屋协调；原帖仅称对方目前会提前告知并保持安静，未交办动作。
- 不处理“他是否尊重我”“以后会不会大吵”“是否换住/分开住”。这些不是已批准任务能力，也不是本轮明确交办。
- 不改生产 `turn.ts`、工具、schema、数据库、模型、doctrine 或提示词。先由留出测试观察现有 relay 能否完成。
- 不硬编码该场景的最终文案，不改评测 runner 或质量检查来迁就模型输出。

### 场景要求

- 新增一个版本化 scenario JSON，id 建议：`corpus-032-reddit-narrow-reminders-2026-09-12`；
  仅两轮，预置两人姓名和既有协调员介绍，避免姓名/首次接触变量。
- 两轮均要求 `contactPerson`、收信人为被提醒的具体室友，且不得联系其他人；全场不得使用
  `proposeRule`。
- 用窄的确定性断言防止明显越界：出站不得出现原帖的人身羞辱/嘲讽（例如秃、怨气、恶心），
  不得把一次夜间提醒说成全屋长期规则或替住户约定硬钟点制度；不要用正则替代人工自然度判断。
- 如果 schema 允许，保持场景断言只检查能机械确认的对象/动作范围；不宣称它证明自然语言质量。

### 验证与边界

只运行免费闸：

- `pnpm.cmd coliving:quality`
- `pnpm.cmd exec tsc --noEmit`
- `git diff --check`

不要运行 `coliving-eval`（Codex 会在独立验收时只跑这个新场景，且默认 `--judge-off`）。
不要 commit/push，不碰 `public/sw.js`。完成后报告改动、两轮输入与断言边界、免费验证结果；
不要把免费字符串检查说成模型语言质量已验收。

---

2026-09-11 成本审查任务 A 已由 Claude Code 实现并经 Codex 独立验收；本轮一次性 V8 任务卡与复审卡已删除。当前没有自动续跑的实现任务，后续由老板选择继续 B/C/D/E/S 或切换工作线。

V7 是已结束的 corpus-031 开发记录，不再作为待执行任务。本文下面均为历史任务，仅保留作证据，不得继续执行。

# Claude Code 实现任务：评测专用 Golden Trace A/B（历史）

## 角色与边界

你是本任务唯一实现者。先读 `AGENTS.md`、`CLAUDE.md`、`.claude/PROJECT_STATE.md`、`.claude/FIRST_EXPERIMENT_DECISION.md`、`.claude/DOCTRINE_DEVELOPMENT_MAP.md`、`.claude/GOLDEN_TRACE_CANDIDATES.md`。

只实现一个默认关闭、仅由评测显式启用的成功轨迹 guidance 实验。不要顺手重构，不要改生产 doctrine 正文，不要改 DB schema、依赖、环境配置、路由或真实发送。

`public/sw.js` 是老板的未跟踪文件，绝对不要修改、删除或加入提交。

## 产品目标

验证少量成功轨迹能否让当前大脑：

- 不把内部记录/核实/判断过程念给住户；
- 必要理由简短但不消失；
- 两人隐私可能被反推时，只问信息所有者是否仍发送，不自动升级；
- 保持现有动作与工具能力。

## 实现要求

1. 新增一个版本化、已登记的 guidance，例如 `concise-coordination-v1`。内容只放 3 条短轨迹：目标询问、劝退过度规则、隐私风险询问。参考 `.claude/GOLDEN_TRACE_CANDIDATES.md`，但不要把整份长文塞进 prompt。
2. guidance 必须明确区分“内部状态/决定”和“最终回复”，并说明示范句不要求逐字照搬、不得形成固定口头禅。
3. `runColivingTurn` 增加仅供内部调用方使用的可选实验 guidance 参数；不传时，生成器看到的 system 内容、模块和生产行为保持不变。
4. 所有属于生成器的重写/补发路径都应使用同一 guidance，避免主生成学到示例、重写又丢失；critic 的 rubric 审核不要注入这些示例。
5. `scripts/coliving-eval.ts` 增加显式参数，例如 `--guidance concise-coordination-v1`。只允许选择代码中登记的 id；未知 id 立即报错。默认不启用。
6. 评测输出与 JSON 报告应记录 guidance id，确保基线和实验结果不会混淆。
7. 不要在本任务里运行付费模型评测；Codex 验收后会定向运行。你只跑免费闸。
8. 增加足够的确定性检查，至少证明：默认路径无 guidance、已知 id 能装载、未知 id 拒绝、报告能区分实验版本。

## 建议文件边界

可以按仓库现状调整，但优先小改：

- `lib/chat/coliving/evals/guidance.ts` 或相近单一模块：登记 id 与短 guidance 内容。
- `lib/chat/coliving/turn.ts`：可选参数及生成系统消息复用。
- `scripts/coliving-eval.ts`：CLI 选择与报告记录。
- `scripts/coliving-quality-inspect.ts`：免费确定性检查。

不要把实验 guidance 放进常驻 `doctrine/always`。

## 免费验证

完成后运行：

- `pnpm.cmd coliving:quality`
- `pnpm.cmd exec tsc --noEmit`
- `git diff --check`

不要 commit，不要 push。最后汇报：改了哪些文件、默认生产路径为何不变、验证结果、仍有哪些风险。

## Codex 第一轮审查反馈

第一版已实现但未验收通过。继续前必须完整读取 `.claude/CODEX_REVIEW.md`，按其中三项退回意见收窄：system 顺序、纯正向示例、降低检查复杂度。
# 当前任务（2026-09-10）：离线推断性隐私现场卡

> 本节替代本文件下面已经完成的 Golden Trace A/B 任务。旧任务保留作实现证据。

## 目标

实现一个**只读、离线、评测专用**的“本轮隐私现场卡”检查器。它读取已有合租评测场景，用当前合租默认模型把当前消息整理成结构化隐私决定，并生成 JSON + HTML 供老板和 Codex 人工查看。

这不是生产功能：不得接入 `runColivingTurn`，不得修改 doctrine/critic/contactPerson，不得写数据库，不得发 Twilio/企微/小红书消息。

业务规格以 `.claude/PRIVACY_DECISION_V0.md` 和 `.claude/CURRENT_TURN_CARD_V0.md` 为准。首要验证场景是 `corpus-025-cleaning-privacy-2026-09-09`。

## 必须实现

1. 新增一个评测侧纯结构模块，例如 `lib/chat/coliving/evals/privacy-turn-card.ts`：
   - 明确定义卡片 schema/type；
   - 至少包含 `sourceOwner`、`proposedRecipients`、`sensitiveClaims`、`inferenceRisk`、`riskReasons`、`ownerConsent`、`recommendedAction`、`residentReply`、`decisionSummary`；
   - 枚举建议：`inferenceRisk = none | possible | likely`，`ownerConsent = not_needed | unknown | approved | declined`，`recommendedAction = ask_owner | safe_to_contact_minimized | stop | no_contact_needed`；
   - 提供纯函数业务校验，不能只信模型：信息所有者必须是当前 speaker；拟联系对象必须来自名册且不能是 speaker；`possible/likely + unknown` 必须是 `ask_owner`；`declined` 必须是 `stop`；风险未获同意时不得宣称已经联系。

2. 新增 CLI，例如 `scripts/coliving-privacy-card.ts`：
   - 用法至少支持 `--scenario <id>`；可选 `--turn <1-based-index>`，默认最后一轮；
   - 只从 `lib/chat/coliving/evals/scenarios/` 按 id 读取并先走现有 `validateScenario`；首版遇到 snapshot 可明确报“不支持”，不要偷偷猜名册；
   - 当前 speaker、名册、原文由场景确定性提供，不让模型编；
   - 模型使用 `COLIVING_DEFAULT_MODEL`，允许仅为评测显式 `--model` 覆盖；
   - 让模型输出结构化对象，不解析自由文本 JSON；提示只要求可复核的“判断摘要/证据”，不要索取或展示隐藏思维链；
   - 绝不调用生产 turn 或任何工具动作。

3. 报告：
   - 写入 `tests/coliving-eval/reports/privacy-cards/`，文件名含场景 id 和时间；
   - 同时生成 JSON 与 HTML；
   - HTML 用中文清楚展示场景、说话人、名册、原文、结构化卡、风险依据、建议动作、住户回复、确定性校验通过/失败；
   - 做 HTML 转义；不要嵌远程脚本；不要显示隐藏 chain-of-thought。

4. 在 `package.json` 增加方便命令，例如 `coliving:privacy-card`。

5. 在 `scripts/coliving-quality-inspect.ts` 增加免费确定性检查，至少覆盖业务校验器的 green/red cases，以及 CLI/报告模块不引用 `runColivingTurn`、`contactPerson` 等生产动作。不要调用模型。

## 首轮人工预期（不是硬编码答案）

对 `corpus-025-cleaning-privacy-2026-09-09`：

- `sourceOwner = 阿哲`
- `proposedRecipients` 应包含大凯
- `inferenceRisk = likely`
- `ownerConsent = unknown`
- `recommendedAction = ask_owner`
- `residentReply` 应是短问句，告诉阿哲大凯可能从两人和私人房间细节猜到来源，并问是否仍联系；不要念记录、核实、升级流程。

## 边界与验收

- 不改现有 Golden Trace A/B 行为；它已作为失败实验保留但不启用。
- 不新增生产提示词或生产动作阻塞。
- 不运行任何真实住户或真实发送。
- 先由 Claude Code 编辑；完成后报告文件列表、关键设计和实际运行的免费验证。不要 commit/push，由 Codex 独立审查。

---
# 当前任务（2026-09-10）：把失败的模型卡收窄为人工标准卡

> 本节替代下面“模型生成离线卡”的任务。两次默认模型实跑都返回 `No object generated: response did not match schema`；不再继续换 SDK 包装或调用模型。

## 目标

保留已经写好的隐私卡 type、纯函数业务校验和 HTML 展示价值，但删除默认必失败的模型生成路径。改成**人工核准的标准卡（gold card）**：标准卡随评测场景保存，CLI 只读、校验并生成 JSON + HTML，不调用任何模型。

## 必须修改

1. 扩展 `EvalScenario`/`validateScenario`，增加可选 `privacyCard`，结构复用 `PrivacyTurnCard`；运行时校验至少确保字段存在、枚举合法、数组/字符串类型正确。不要复制另一份漂移的类型。
2. 在 `corpus-025-cleaning-privacy-2026-09-09.json` 写入老板/Codex 核准的标准卡：
   - `sourceOwner: 阿哲`
   - `proposedRecipients: [大凯]`
   - 私人房间、私人物品、趁本人不在进入等敏感主张
   - `inferenceRisk: likely`
   - 风险依据至少包含“两人范围”和“私人房间独有细节”
   - `ownerConsent: unknown`
   - `recommendedAction: ask_owner`
   - 回复应简短表达“大凯可能会猜到是你，是否仍联系”；不要念内部过程，不自动升级
   - `decisionSummary` 是供 HTML 人工核对的简短依据，不是隐藏思维链。
3. 重写 `scripts/coliving-privacy-card.ts`：
   - 仍支持 `--scenario <id>`；首版只处理场景里已有的一张标准卡，不需要 `--turn`/`--model`；
   - 不 import AI SDK、provider、model，不加载 `.env`，绝不联网；
   - 读取并 `validateScenario` 后，找不到 `privacyCard` 就明确报错；
   - 从场景第一轮（或明确记录的卡片轮次；首版可固定单轮场景）确定 speaker/roster/rawMessage，调用 `validatePrivacyCard`；
   - 无论业务校验通过或失败，都可以生成 JSON + HTML 供人工查看，但失败必须退出非零且醒目标红；
   - HTML 保留全量转义、场景、原文、名册、标准卡、判断摘要和校验结果；标题明确“人工标准隐私卡”，不得暗示模型生成。
4. `package.json` 命令名可保留 `coliving:privacy-card`。
5. 更新免费检查：
   - 验证 scenario schema 的合法/非法 `privacyCard`；
   - 验证 CLI 不含 `generateText`、`generateObject`、`Output.object`、`getLanguageModel`、gateway、dotenv、生产 turn/repo/联系动作；
   - 保留所有隐私状态 red/green cases。

## 边界

- 不改 doctrine/critic/contactPerson/生产 turn。
- 不调用任何模型，不写数据库，不发送消息。
- 不删失败证据；`.claude/PRIVACY_DECISION_V0.md` 已记录两次失败。
- 完成后运行免费三闸，不 commit/push，由 Codex验收。

---
# 当前返工（2026-09-13）：corpus-035 实跑暴露 grounding 缺口

Codex 已在当前实现上用 DeepSeek V4.1 Flash 实跑 corpus-035。结构闸通过，但人工验收不通过：

1. 第一轮 unsupported 回复为「这件事我没法替你转给阿川，现在也没发出去。你可能得直接跟他说一下，让他把地漏的头发清干净。」其中「你可能得直接跟他说一下」是代码事实没有提供的替代处理方案，违反“LLM 只把事实说自然，不自行补充处理方案”。
2. 第二轮 feature:qa 回复为「这件事目前不在我能替你转达给别人的范围里；我现在能替你发给别人的只有夜间洗衣提醒和个人物品使用提醒。」它列出了开放功能，但漏掉了本次卫生整改的真实拒绝理由：看不到现场程度，当前技术不能可靠判断是否达到要求别人整改的标准。

请修复通用机制，不写 corpus-035 专用字面补丁：

- unsupported 与 feature QA 的模型输出都必须被确定性 grounding 约束，只能表达所选事实；不得建议用户自己联系、找别人、换渠道、等待以后处理，亦不得承诺替代方案。
- 对「为什么不能 + 有什么功能」的组合问句，必须同时包含：相关未开放事项、该事项已登记的具体拒绝理由、当前全部开放功能。缺任一项即使用确定性事实型 fallback。
- 保持统一事实源和统一问答引擎；不要恢复逐功能能力说明程序，不加载旧 doctrine，不新增工具或第三方出站。
- 增加免费离线检查覆盖上述两个真实失败输出及正常自然改写。

完成后运行 `pnpm.cmd coliving:quality`、`pnpm.cmd exec tsc --noEmit`、`git diff --check`，把完整结果报告给 Codex。不要提交，不要推送，不要运行付费模型。
# 当前返工（2026-09-13）：真实 DB 证据显示 decision.payload 被双重 JSON 编码

修复后第二次实跑 corpus-035：第一轮已正确收口；第二轮仍落入通用边界，漏掉卫生整改具体原因。Codex 做了只读 DB 诊断，已找到确定根因：

- 第一轮 decision 实际 `payload` 读出来是 JSONB 顶层**字符串**：`"{\"capabilityId\":\"hygiene\",\"personId\":\"...\"}"`，而不是 JSONB 对象。
- 因此 `payload->>'capabilityId'` 和 `payload->>'personId'` 都得到 null，第二轮无法关联上一轮事实。
- 根因在 `repo.recordDecision`：`${JSON.stringify(args.payload ?? {})}::jsonb` 让 postgres.js 再序列化了一次。项目已有正确先例是 `sql.json(...)`（见 `lib/chat/coliving/shadow.ts`）。

请只修这个根因并加免费回归闸：

- `recordDecision` 使用 postgres.js 的 JSON 参数能力写入真正 JSONB 对象，不要先 `JSON.stringify`；不要为 corpus-035 写特例。
- 保持 `latestDecision` 读取 `payload->>` 的通用设计。
- 新增离线源码/纯函数回归，确保 decision payload 不再用 `JSON.stringify(... )::jsonb` 写入，并沿用 postgres.js 正确 JSON API；不要连接真实数据库、不要跑付费模型。
- 不要顺手改变无关的 `skipped_reason` 老代码，除非你能证明它属于本次同一根因且有既有行为测试。
- 运行 `pnpm.cmd coliving:quality`、`pnpm.cmd exec tsc --noEmit`、`git diff --check`。不要提交、不要推送、不要碰 `public/sw.js`。
