# 协商状态机（Coordination State Machine）

这是把“多人用自然语言协调一件事（比如厨房排班）”从 LLM 手里拿回确定性代码的
**实验性架构**。低耦合、自包含，**可整体删除**（删掉 `lib/coordination/` 即可）。

## 一句话定位

LLM 只做一件事：把住户说的一句话翻译成一个结构化 `Intent`。真正的“协调”由这里
的确定性状态机完成——它记状态、走转移、守不变量、决定下一步该对谁说什么。

## 借自底层系统的四个思想

1. **事件溯源（数据库）**：不“改状态”，只**追加事件**；当前状态由事件日志重放推导。
   谁报了什么时间、谁确认、谁拒绝，都是不可变事件，永远可回放、可审计。
2. **极小状态机（CPU）**：少数状态 + 少数转移，循环执行，从不“思考”。
   聪明不来自大模型，来自状态集和转移集定得恰到好处。
3. **不变量（物理守恒律）**：硬约束由代码强制，不靠 LLM 自觉。
4. **薄意图层（无为）**：LLM 做最少的事，系统靠结构自己流转。

## 状态（State，派生，不落库）

- `gathering` —— 信息还没齐（还有人的可用时间/时长没报）。
- `proposed` —— 已排出一版方案，正在等人确认。
- `settled` —— 全员确认，已定案。
- `renegotiating` —— 有人拒绝/反提/加了新约束，正在重排。

“卡住/部分确认”这类是**派生状态**，不单独存：由事件日志算出来
（谁 pending、谁确认了、谁超时了）。

## 事件（Event，只追加，不可变）

- `availability_reported { person, start, duration, latestStart? }`
  —— `latestStart` 是「最晚必须开始」的分钟数，缺省表示没有上限（「八点太晚 / 不能晚于
  八点开始」的落点）；它与 `start`（最早能开始）合起来把可用起点圈成 `[start, latestStart]`。
- `schedule_proposed { window, assignments[] }`
- `confirmed { person }`
- `rejected { person, reason }`
- `reminded { person }`
- `settled { window, assignments[] }`

## 转移（给定 Intent，状态机产出新事件 + 出站动作）

| Intent | 产出 |
|---|---|
| `report_availability` | 追加事件；若信息齐 → `schedule_proposed` + 给每人发提议 |
| `confirm` | 追加事件；若全员确认 → `settled` + 给每人发定案 |
| `reject` / `counter_propose` / `add_constraint` | 追加事件 → 重算 → `schedule_proposed` |
| `ask_status` | 对 pending 的人补 `reminded`（催一次，不重复问） |
| `other` | 无状态转移 |

排不出可行方案时（`allocateSlots` 返回 null），不再静默停在原地：出站动作发一条
`{ type: "blocked", reasons }`，`reasons` 是 `diagnoseInfeasibility` 产出的结构化诊断
（总时长超窗口 / 某人最早开始已超窗口尾 / 最晚开始早于最早开始 / 锚点空当放不下）。
这条 **不向住户发任何内容**，只把「为什么排不开」交给上层去生成协调建议——这是
「看见排不开却假装没看见」的消除。

## 不变量（Invariants，代码强制）

1. 一人同一窗口只占一段，不重叠。
2. 已确认的段不被静默改变——只有 reject/renegotiate 才会动。
3. 同一件事对同一人不重复发问：有 pending 时只 `remind`，不重发提议。
4. `settled` 必须全员确认，或明确豁免。

## LLM 的唯一职责

```ts
llmParseIntent(message, snapshot): Intent
```

`Intent ∈ { report_availability, confirm, reject, counter_propose, add_constraint, ask_status, other }`

三个 availability 意图（report / counter / add_constraint）都带 `start` + `duration`，
可选 `latestStart`（「八点太晚 / 不能晚于八点」落成最晚开始上限）。解析只吃
`projectState` 的紧凑投影 + 当前这一条消息，**不吃历史原文**；投影里可带一段由调用方
维护的 `recentDialogue`（最近几条真实对话，含 AI 出站），专门用来消歧「这句话在回什么」。

两个关键消歧（都在 `llm.ts` 的 SYSTEM_PROMPT + 快速路径里）：

- **接受时间建议 ≠ confirm**：AI 刚征询/建议过「17:30 先做，方便吗」，住户回「可以」
  是接受那个新时间（更新可用时间到 17:30），不是确认旧方案。
- **纯寒暄/纯确认走确定性快速路径**：`fastIntent` 只拦截「无论上下文都只有一种解」的
  整句（你好/在吗/可以/行/没问题），带时间、数字、否定、疑问、犹豫的一律交回 LLM——
  省模型调用、不降聪明。

## 持久化（append-only JSONL）

状态是**派生**的、不落库；落盘的只有**追加的事件日志**，用 **JSONL**（每行一个
JSON 事件、行尾换行）存成文件。存储层是自包含的 `store.ts`：只 import node 内置
`fs`/`path` 和 `types.ts` 的 `Event` 类型，不 import 任何项目业务代码、不 import
通用聊天框架或第三方持久化依赖。

- `appendEvents(filePath, events)` —— 把事件**追加**到文件末尾，绝不覆盖已有行；
  目录不存在自动建。空数组不写。
- `loadEvents(filePath)` —— 读整个 JSONL，按行解析成 `Event[]`；文件不存在返回
  `[]`，单行解析失败**跳过该行**，不让一条坏行毁掉整次重放。取回的日志直接喂给
  `projectState`（`reduce`/`fold`）重放，得到当前状态——**状态 = 日志重放出的
  物化投影**，磁盘上不另存一份"当前状态"。
- `readLatest(filePath, limit)` —— 读最后 `limit` 条事件（正序）并返回事件总数。
  这是「最近窗口」的底层：把尾部事件喂 `projectState`，就在有限窗口里恢复最近
  事实，不必每次整段重放。
- `saveCheckpoint(filePath, snap, offset)` / `loadCheckpoint(filePath)` —— 把派生
  快照 `Snap` 摊平成 JSON（`machine.ts` 的 `snapToJson`）连同「已重放到的 offset」
  **覆盖写**到 checkpoint 文件；读回时 `snapFromJson` 还原成 `Snap`。文件不存在或
  解析失败时 `loadCheckpoint` 返回 `null`。
- `resume(eventsFile, checkpointFile)` —— 读 checkpoint（没有就 `emptySnap()` +
  offset 0），`loadEvents` 后取 `slice(offset)` 的增量事件，用 `foldFrom` 从快照
  续放，返回最新 snap 和新的 offset（= 当前事件总数）。**等价性保证**：
  `resume(...).snap` 与 `fold(loadEvents(...))` 完全等价（有测试锁死）。

**checkpoint 与事件日志性质不同，不混为一谈**：事件日志仍是 append-only JSONL，
只追加、从不覆盖；checkpoint 是**覆盖写**的派生物化快照，保存「已重放到的
offset + 当时完整 Snapshot」，丢了或坏了随时可从事件日志全量重放重建，不是事实
的原始记录。

设计不是自创，是**偷思想、不搬依赖**：

1. **事件溯源（数据库）**——只追加不可变事件、从不改状态；当前状态永远可回放。
2. **sqlite 物化投影 / 流式系统 checkpoint**——把"状态 = 对日志的物化投影"搬下来，
   落盘格式是纯文本 JSONL，不是 SQLite；等日志变大时用「物化快照 + 从快照续放」
   让重放只从最近的位置续起，不必每次整读整解析。`fold` / `foldFrom` 用同一套
   循环（`fold` 只是 `foldFrom(emptySnap(), events, 0)` 的薄封装），续放把事件
   下标看成 `baseIndex + 局部下标`，保证 `lastProposalIndex` / `lastDisruptIndex`
   仍记绝对位置、`renegotiating` 判定不被增量续放破坏。

## 第二条机器：共同规则协商（`rule-consultation.ts`）

上面那台机器解决的是「**同一件事里有多个可选安排、算出一个方案让大家确认**」
（厨房排班：几点、谁先谁后）。它**不处理**另一种协调：**一条全屋共同规则本身
要不要生效**——这不需要算方案，只需要**收集全员表态**。

`rule-consultation.ts` 是一台**独立的小状态机**，跟排班机器**同目录、共享同一套
事件溯源思想，但不共用代码、不互相 import**（各自的类型、fold、step 分开写；不强行
抽象，见 CLAUDE.md「允许大量暂时不共用的码」）。它只处理一条具体规则（当前是
「每个人洗完澡后把地漏里的头发清掉」），**不判断规则内容是否合理、不自己发明规则、
不做任何现场卫生判断**。

### 与排班机器的区别

| | 排班机器（`machine.ts`） | 共同规则机器（`rule-consultation.ts`） |
|---|---|---|
| 协调的对象 | 一件事的**具体安排**（时间/顺序） | 一条**规则本身**要不要生效 |
| 有没有「候选项」 | 有，`allocateSlots` 先算出方案再确认 | 没有，动作只有「表态 / 征询 / 宣布」 |
| 定案条件 | 全员确认（或明确豁免） | **全员同意**，缺一不可 |
| 有人反对 | 重排（`renegotiating`） | **永不定案原规则**（`objected`，其余人同意也不翻转） |
| 出站内容 | 提议 / 催办 / 定案 | 征询 / 定案宣布 |

### 状态（派生，不落库）

- `none` —— 还没有人提出这条规则。
- `proposed` —— 规则已提出，正在收集全员表态（**未全员同意前绝不定案**）。
- `settled` —— **全员同意**，规则正式生效，已向全员宣布（终态）。
- `objected` —— 有人明确反对，**原规则永不定案**（终态）。

### 事件（只追加，不可变）

- `rule_proposed { rule, initiator }` —— 有人提出这条共同规则；发起人视为已同意、
  且**不会被重复征询**。
- `consulted { person }` —— **送达回执**：向某位室友的征询短信**真的发出去过**才记。
- `position_recorded { person, position }` —— 某人明确表态（agree / disagree）。
- `rule_settled { rule }` —— 全员同意，定案。
- `announced { person }` —— **送达回执**：向某人宣布规则已生效的短信**真的发出去过**才记。

**事实与回执分开**：「提出 / 表态 / 全员同意」是**事实**，推进时立即落库（`rule_proposed` /
`position_recorded` / `rule_settled`）。`consulted` / `announced` 是**动作成功的回执**，只能在
对应短信（或本人回复）确实落账之后才由调用方追加（`rule-consultation-session.ts` 的
`deliverRuleActions` / `recordRuleReceipt`）。因此**发送失败不会留下假回执**，不会被当成
「已问过 / 已宣布」而跳过；失败的人留在待办里，下次问进度（`ask_status`）重新产生同一动作、
可重试。

### 不变量（`checkRuleInvariants`，代码强制）

1. `rule_proposed` 最多一条（同一栋房子同时只有一条规则在协商）。
2. `rule_settled` 时，日志里所有**已知的**参与者都必须是 agree——**少一人同意不得定案**。
3. 已表态的人**不被重复征询**；同一人不重复 `consulted` / `announced`。
4. 只能先定案、再宣布；定案后不再接受新的 `position_recorded`。
5. **回执 = 真的送达**：`consulted` / `announced` 只由投递成功后的调用方追加；失败不记，
   且失败者会在之后问进度时被重新征询 / 补发。

### 来源隐私（类型层保证）

`RuleProjection` / `RuleAction` **没有 `initiator` 字段**——「是谁先提的、谁投诉了」
只存在于内部 `RuleSnap`，不会投影出去，因此下游措辞层拿不到、也无法泄露是谁发起的。
`ruleAction` 只表达「对谁做什么」（consult / announce），措辞由 doctrine 决定（见 CLAUDE.md
「不要替大脑写话术」）。

**注意**：这台机器不写任何固定短信文案，也**不自己发送**；它只产出结构化的
`RuleAction`，由 coliving 侧（默认关闭的实验接线）交给措辞层生成正文。

### 身份用 `PersonId`、规则事实用固定中性文本（来源隐私）

- **参与者 / 发起人 / 收件人一律是稳定 `PersonId`**（生产里是 `personId`），**不是显示名**；
  收件人由调用方按 id 精确解析（`rule-consultation-session.ts` 的
  `resolveRuleActionRecipients`）。两位**同名**住户各有各的 id，会被分别征询 / 宣布，不会
  被合并，也不会互相串收。
- **规则事实收敛为中性固定语义**：识别命中后，写进状态机与措辞层的规则文本恒为
  `SHARED_SHOWER_DRAIN_HAIR_RULE_FACT`（「每个人洗完澡后清理地漏里的头发」），**不是**发起人
  原句片段——原句里的姓名、指责、私人理由都不会外传给别的住户。最终短信措辞仍由措辞层自然
  生成，不写死完整短信。

## 目录结构（自包含）

```
lib/coordination/
  README.md       本文件
  types.ts        State / Event / Intent / OutboundAction / Infeasibility 类型
  machine.ts      fold/foldFrom（事件日志→派生快照）、reduce、step、allocateSlots、
                  不变量、diagnoseInfeasibility；snapToJson/snapFromJson（快照 ⇄ JSON）
  rule-consultation.ts  第二条独立小状态机：全屋共同规则协商（提出→征询→全员
                  同意才定案→向全员宣布；有人反对则原规则永不定案）。只处理一条具体
                  规则、不算方案、不写话术、不发送；投影里不含发起人身份。
  intent.ts       parseIntent 接口 + 一个确定性 stub
  llm.ts          上下文感知的 LLM 意图解析（薄意图层胶水）+ fastIntent 快速路径
  store.ts        append-only JSONL 持久化 + checkpoint 物化快照（appendEvents /
                  loadEvents / readLatest / saveCheckpoint / loadCheckpoint / resume）
  runtime.ts      runCoordinationTurn：把「恢复→投影→解析→step→落盘/推进 checkpoint」
                  收成一个完整一轮的运行时入口
  machine.test.ts 纯函数单测（不调 LLM）
  rule-consultation.test.ts  共同规则机器纯函数单测（不调 LLM、不连库）
  store.test.ts   持久化层纯 IO 单测（node 临时目录，不连库）
  llm.test.ts     意图快速路径 + 接受时间建议上下文闸 的纯函数单测（不调 LLM）
  runtime.test.ts 运行时入口纯 Node 单测（注入 stub 解析器，不调 LLM）
  real-case-regression.test.ts  真实 kitchen_contention 的 golden 回归（手工 Intent，
                   断言状态机复现真实定案）
  e2e.test.ts     合成场景端到端（golden + 真实 LLM 两层）
  real-data-e2e.ts          硬编码真实入站消息回放
  real-data-db-e2e.ts       数据库双向消息回放 + 按 case 切分
```

## 设计目标

- **纯函数**：输入（事件日志 + 当前消息的 Intent）→ 输出（新事件 + 要发出的动作），
  无副作用、可单测、可回放。
- **零耦合**：不 import 项目里任何 coliving 代码，便于整体删除或替换。
- **可渐进落地**：先在旁边跑通，验证思路后，再决定是否把现有
  `pickSchedule`/`contactPerson`/确认逻辑逐步迁移进来。

## 接入生产的适配路径（路标，不是当前实现）

实验内核已能在真实 kitchen_contention 上复现真实定案（`real-case-regression.test.ts`
锁死），但要真正接管生产，还需要一个**只读适配层**把 coliving 世界投影成这里的输入：

1. `participants` ← 该 household 当前 membership（`valid_to is null`）的 `display_name`；
2. `window` ← 该「共享资源」的可用时间窗（这是**产品配置**：厨房排班是傍晚窗，垃圾/清洁
   是另一套；适配层需要一张 `资源 → 窗口` 的显式映射，而不是散落的硬编码）；
3. 消息流 ← 按 case 切分的真实入站/出站（`real-data-db-e2e.ts` 已做派生 case 标签）；
4. 出站动作 → 交给 coliving 的措辞/发送层，`blocked` 诊断交给 coliving 大脑生成协调
   建议（措辞归 doctrine，代码只给事实，见 CLAUDE.md）。

**安全边界**：本目录不 import 任何发送/真实住户写入逻辑；接入前必须先走 shadow
（只读、不向真人发送）对照，确认状态机方案与真实方案/住户约束一致，再谈替换。
