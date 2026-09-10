# WillingLink 本轮现场卡 V0

> 建立日期：2026-09-09
> 状态：设计与桌面样例，尚未接入运行时。
> 目标：把当前长篇 context 中与本轮决定直接相关的状态聚焦出来，不替代数据库，也不要求代码复刻完整人类思维。

## Doctrine 使用卡

- **现实问题**：角色对象错位、已答信息重复询问、隐私信息发给错误对象、临时建议被说成共识、内部判断过程被念给住户。
- **适用 doctrine**：`always/constitution.md` 的事实来源、隐私、决定权和承诺；`always/arbitration.md` 的提问预算与方案状态；`always/craft.md` 的结果而非脑内过程；`domain/conflict.md` 的事实/影响/诉求和异步处理；`tool/records.md` 的事实/主张/推测/未知分离。
- **业务不变量**：模型行动前必须能明确回答“谁在对谁说、谈的是谁、哪些信息来自谁、当前收件人能否知道、只缺什么、谁有权决定、现在是什么状态”。
- **承载层**：结构化现场卡；数据库事实由代码填写，语义判断由模型提出，隐私与动作边界由规则校验。
- **为什么不只改提示词**：这些事实已经分散在数据库和 context 中；再写一遍原则不会稳定聚焦，也不能防止收件人映射错误。
- **验收**：同一事实不换主人；敏感信息不流向无权收件人；信息齐全时不追问；回复不念内部字段。
- **停止条件**：如果现场卡只复制旧 context、没有减少错误或反而丢失关键历史，就不替换原 context，改为按任务检索或规划步骤。

## 当前 context 已经做对的事

核对 `lib/chat/coliving/context.ts` 后确认，现有系统并不是“没有环境”：

- 明确当前说话人及其房屋角色；
- 区分确认居住、居住未知和不居住；
- 标注占位名不可念出口；
- 提供现行规则及各方是否表态；
- 提供正在等谁回复、未结案件、各方立场、已算份额；
- 提供最近发给全屋各人的出站消息；
- 明确未知房屋事实不可猜；
- 明确当前渠道与短信长度约束。

这些资产应复用，不重新造一套平行事实源。

## 当前缺口

1. **本轮关系不成型**：sender 有标记，但没有显式 `speaker / addressee / subject_people`。
2. **信息所有权不成型**：有隐私原则，没有逐条 `source_owner / allowed_recipients / inferability`。
3. **事实类型只存在于散文**：没有把本轮关键内容明确分成 `verified_fact / party_claim / preference / inference / unknown`。
4. **缺项不聚焦**：模型要自己从长 context 判断还缺什么，容易重复问或一次问一串。
5. **决定状态不聚焦**：临时安排、候选方案、已通知、已同意、正式规则散落在不同段落。
6. **外部输出契约不独立**：内部资料很多，但没有一张本轮卡明确“对这个收件人只需说什么”。

## V0 字段

```text
turn
  speaker                 当前发信人
  addressee               固定为 AI 协调员；转述内容另标 quoted_addressee
  raw_message             当前原文，不改写
  replying_to             正在回答哪条已发问题，没有则为空

people
  subject_people          本轮谈到的人
  affected_people         决定会影响的人
  known_scope             已确认的共用/参与范围
  unknown_scope           尚不能确认的范围

claims[]
  content                 尽量保留原意
  source_person           谁说的
  about_person            在说谁/什么
  type                    verified_fact | party_claim | preference | inference | unknown
  disclosure              哪些人可以知道
  inference_risk          发给谁会不会从细节反推出来源

task
  kind                    查询 | 记录 | 提醒 | 冲突 | 排程 | 规则 | 风险 | 其他
  stage                   了解 | 可行动 | 等回复 | 临时执行 | 征询 | 已成立 | 受阻
  decision_owner          resident | coordinator | landlord_or_qualified_human
  missing_decision_facts  只列会改变当前动作的缺项
  current_status          proposed | provisional | delivered | replied | agreed | failed

action_boundary
  safe_now                当前可以做的动作
  blocked_now             当前不能做及客观原因
  required_receipts       动作后必须返回的投递/记录状态

reply_contract
  must_tell               收件人此刻必须知道
  ask_one                 仅在必要时的一个问题
  do_not_tell             内部过程和不属于他的资料
  max_length              渠道上限
```

## 字段由谁产生

| 字段 | 最可靠来源 | 说明 |
|---|---|---|
| speaker、raw_message、replying_to | 代码/数据库 | 已经存在，不让模型猜 |
| 名册、角色、规则状态、案件、投递状态 | 代码/数据库 | 继续使用现有 repo 单一事实源 |
| subject_people 初选 | 名册匹配 + 模型语义 | 名字匹配可确定，代词和转述需语义判断 |
| claims 内容、类型、about_person | 模型结构化提取 | 代码不理解所有自然语言，不强行词表化 |
| disclosure、inference_risk | doctrine 规则 + 收件人视角检查 | 不能只靠“是否出现姓名”的正则 |
| task.kind、stage | 路由信号 + 状态机 + 模型 | 结构信号优先，模型补足开放语义 |
| missing_decision_facts | SOP 所需字段与已有状态求差 | 尽量由任务模板计算，模型只补充 |
| reply_contract | doctrine + 当前收件人 | 内部可以复杂，外部默认简洁 |

## 桌面样例 1 · 多人对白对象不串线

```yaml
turn:
  speaker: 阿凯
  addressee: AI协调员
  raw_message: 红那条我从来没碰过。白的那条，我天天洗完澡都拿它擦身子。
people:
  subject_people: [阿凯, 阿哲]
claims:
  - content: 阿凯没有用过红毛巾
    source_person: 阿凯
    about_person: 阿凯
    type: party_claim
  - content: 阿凯每天用白毛巾擦身
    source_person: 阿凯
    about_person: 阿凯
    type: party_claim
task:
  kind: 冲突
  stage: 了解
  decision_owner: coordinator
  missing_decision_facts:
    - 白毛巾此前是否被明确说成共用
reply_contract:
  must_tell: []
  ask_one: 白毛巾之前是谁说可以共用的？
  do_not_tell:
    - 不把阿哲的话改成阿凯对AI说的话
    - 不把任何一方陈述写成已查实
  max_length: 140
```

**示范回复**：“白毛巾之前是谁说可以共用的？”

### 样例结论

对象关系一旦显式化，“你自己的毛巾是红的”这种属于阿哲对阿凯的原对白，就不会被误写成阿凯对 AI 的陈述。

## 桌面样例 2 · 两人隐私可被反推

```yaml
turn:
  speaker: 林姐
  addressee: AI协调员
  raw_message: 你提醒一下阿凯别再用我的调料，但别让他知道是我说的。
people:
  subject_people: [林姐, 阿凯]
  affected_people: [林姐, 阿凯]
  known_scope: 只有林姐和阿凯共用这个柜子
claims:
  - content: 阿凯多次使用林姐的调料
    source_person: 林姐
    about_person: 阿凯
    type: party_claim
    disclosure: 未允许向阿凯披露来源
    inference_risk: 即使不点名，阿凯也很可能从两人范围推断出林姐
task:
  kind: 冲突
  stage: 受阻
  decision_owner: resident
  missing_decision_facts:
    - 林姐是否接受可能被阿凯推断来源
action_boundary:
  safe_now: [向林姐说明推断风险]
  blocked_now: [未获同意前不向阿凯发送]
reply_contract:
  must_tell: [两人范围导致可能被猜到]
  ask_one: 是否仍要发送
  do_not_tell: [记录分类, 升级流程, 长篇匿名原理]
  max_length: 140
```

**示范回复**：“这个柜子只有你们两个人用，他可能会猜到是你。还要发吗？”

### 样例结论

这不是系统替 A 决定公开，也不是自动升级；现场卡只把风险和决定权摆清楚。

## 桌面样例 3 · 房东提出过度规则

```yaml
turn:
  speaker: 房东
  addressee: AI协调员
  raw_message: 以后十点后不准洗澡，直接发给他们。
people:
  affected_people: [全体住客]
claims:
  - content: 房东希望十点后完全禁止使用浴室
    source_person: 房东
    about_person: 全体住客
    type: preference
task:
  kind: 规则
  stage: 了解
  decision_owner: coordinator
  missing_decision_facts:
    - 是否有人只能在十点后正常使用浴室
action_boundary:
  safe_now: [用基本使用权这一必要理由劝退完全禁止]
  blocked_now: [不能把房东要求直接写成已生效规则]
reply_contract:
  must_tell: [完全禁止会影响夜班住客正常使用]
  ask_one: null
  do_not_tell: [准备如何分别核实, 规则形成流程, 内部权限分析]
  max_length: 140
```

**示范回复**：“十点后完全不让洗不合适，夜班回来的人也得正常用浴室。可以改成十点后尽量缩短、保持安静。”

### 样例结论

必要理由可以说，但核实计划和完整规则形成过程留在内部。协调员先挡住明显不合适的要求，不把一串流程念给房东。

## 与现有 context 的关系

V0 不建议立即替换 `context.ts`。更安全的实验顺序：

1. 用现有 context 离线生成现场卡并展示，不参与生产回复。
2. 人工核对卡片是否丢事实、串角色或错误扩大隐私范围。
3. 只在 3–5 个定向场景里把卡作为额外运行时状态，保留原 context 作对照。
4. 卡片稳定后，再决定哪些旧散文可以删；不允许长期双份重复。

## 当前结论

- “手脚装得不到位”之外，确实存在“眼睛看到很多，但没有聚焦本轮关系”的问题。
- 现场卡不负责代替 LLM 做所有判断；它负责让判断对象、事实来源、权限和输出边界可见。
- 第一项实现应是**离线卡片生成与人工检查**，而不是直接替换生产 context。

## A/B 后的优先级更新（2026-09-09）

少量 Golden Trace 在首个隐私场景失败，说明 `claims[].inference_risk` 不能只是给模型看的说明文字。下一版桌面卡优先验证四个能直接控制行动的字段：

```text
privacy_decision
  source_owner            敏感信息属于谁
  proposed_recipient      准备联系谁
  inference_risk          none | possible | likely
  owner_consent           not_needed | unknown | approved | declined
```

行动不变量：`inference_risk` 为 `possible/likely` 且 `owner_consent` 为 `unknown/declined` 时，不允许联系 `proposed_recipient`；当前回复只需向 `source_owner` 说明可能被猜到并问是否继续。`declined` 后停止，不自动升级。

这组字段先做离线生成与人工核对，重点不是让模型换一种说法，而是验证同一个敏感事实能否在进入工具动作前被正确拦住。
