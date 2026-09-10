# WillingLink 协调卡来源地图

> 日期：2026-09-10
> 状态：离线评测设计依据；尚未接入生产。
> 目的：卡片中的状态、门禁和流程必须可追溯到项目 doctrine 或外部权威资料；
> LLM 只做开放语言理解与短回复润色，不自行发明业务流程。

## 先纠正上一版的根本错误

上一版隐私卡一看到消息里出现“大凯”，就把大凯填成 `proposedRecipients`，等于把
“谈到某人”误写成“准备联系某人”。`corpus-025` 的用户只要求判断是否越界，系统却
擅自增加了联系任务，因此后面的反推风险问题虽然单独看合理，放在这一轮却答非所问。

新顺序必须是：

```text
识别用户目的
  -> 明确本轮请求的动作
  -> 判断是否存在对外数据动作/联系计划
  -> 只有存在计划时才判断收件人、最小披露、反推风险与许可
  -> 形成当前回复或动作阻塞
```

“隐私安全”不能反过来制造一个用户没有要求的披露动作。

## 来源分级

| 等级 | 含义 | 可以决定什么 |
|---|---|---|
| P1 项目 doctrine | WillingLink 已长期打磨的业务原则和领域 SOP | 卡片字段、决定权、事实来源、对外回复边界 |
| P2 外部权威标准 | NIST、W3C、ICO 等公开的一手资料 | 目的限制、数据动作、来源追踪、验证方法 |
| P3 项目胶水 | 为把 P1/P2 接进当前评测而做的最小工程选择 | 枚举名字、HTML 排版、文件名、命令参数 |

P3 不得新增权限、联系对象、升级路径、处置步骤或“默认替用户做什么”。无法指出 P1/P2
依据的业务规则，不进入卡片和确定性门禁。

## 卡片运转及逐项依据

| 顺序 | 卡片环节 | 主要依据 | 提炼出的规则 | 允许的 LLM 工作 |
|---|---|---|---|---|
| 1 | 事实信封 | `always/constitution.md`「事实是地基」；`tool/records.md`「事实与判断必须分离」 | 说话人、名册、原文来自代码/场景；当事人陈述标为主张，不写成已查实 | 从自然语言提取主张、对象和主题 |
| 2 | 用户目的 | `always/constitution.md`「先判断问题是什么」；ICO Purpose limitation | 先保存 `userGoal` 与 `requestedAction`；不得把“请判断”扩成“请联系” | 把自由文本映射到预先定义的目的类别 |
| 3 | 决定权 | `always/arbitration.md`「决定权归属」；`always/constitution.md`「谁决定」 | 判断/流程由协调员负责；是否暴露自己的身份由信息所有者负责；不把专业判断推回住户 | 识别当前缺少哪一个会改变动作的事实 |
| 4 | 对外动作计划 | NIST Privacy Framework 的 data actions；ICO Purpose limitation | 只有本轮确有联系/披露计划，才填写收件人并进入隐私门；提及某人不等于联系某人 | 从明确请求与既有状态识别候选动作，不得自行新增动作 |
| 5 | 最小披露 | `always/constitution.md`「隐私」；`tool/records.md`「隐私」；ICO Data minimisation | 只向完成既定目的所需的人披露必要内容；没有目的时不披露 | 将原始叙述压缩为最小必要内容草稿 |
| 6 | 反推风险与许可 | `domain/conflict.md`「只有一个可能的投诉人」；`domain/complaint-risk.md`「披露身份的标准动作」；老板一级红线 | 仅在拟披露时评估 `possible/likely`；能反推且未获许可时先问所有者；拒绝后停止，不自动升级 | 识别时间、地点、人数、独有细节造成的语义风险 |
| 7 | 回复契约 | `always/craft.md`「一次只做一件事」「住户要的是结果」 | 判断请求直接给判断；必要时最多问一个问题；不念记录、核实、critic 或内部流程 | 写一句自然、简短、对得上用户问题的回复 |
| 8 | 来源与验收 | W3C PROV-O；NIST AI RMF Govern 3.2、Map 2.3 | 每个字段/规则显示依据；结构状态用确定性校验；语义仍由人工金标准复核 | 不允许模型自己生成、自己判定通过 |

外部一手资料：

- NIST Privacy Framework, Getting Started：隐私风险由系统对数据采取的动作产生。
  https://www.nist.gov/privacy-framework/getting-started-0
- NIST AI RMF Core：明确人和 AI 的角色责任，并记录测试、验证、数据适用性。
  https://airc.nist.gov/airmf-resources/airmf/5-sec-core/
- NIST AI RMF Effectiveness：持续判断治理做法是否达到预期结果。
  https://airc.nist.gov/airmf-resources/airmf/4-effectiveness/
- W3C PROV-O：用 Entity / Activity / Agent 及来源关系表达信息从哪里来、由谁产生、
  经什么活动派生。
  https://www.w3.org/TR/prov-o/
- ICO Purpose limitation：先明确处理目的，防止用途漂移。
  https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/purpose-limitation/
- ICO Data minimisation：数据应与既定目的相关，并限制在必要范围内。
  https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/data-minimisation/

## V1 最小状态

```text
intent
  user_goal: answer_question | record_only | coordinate | propose_rule | other
  requested_action: answer_only | record_only | consider_contact | contact_person | other
  action_basis: explicit_user_request | doctrine_coordinator_duty | none

data_action
  disclosure_plan: none | considering | approved_to_send
  proposed_recipients[]

privacy
  source_owner
  sensitive_claims[]
  inference_risk: not_applicable | none | possible | likely
  risk_reasons[]
  owner_consent: not_needed | unknown | approved | declined

result
  recommended_action: answer_only | record_only | ask_owner | safe_to_contact_minimized | stop
  resident_reply
  decision_summary
  field_sources[]
```

## V1 状态不变量

1. `requested_action=answer_only` 时，`disclosure_plan=none`、收件人为空、
   `inference_risk=not_applicable`、`owner_consent=not_needed`，回复必须直接回答问题。
2. `disclosure_plan=none` 时不得出现拟联系对象；消息里出现的人名不能自动成为收件人。
3. `disclosure_plan` 非 `none` 时必须有 `action_basis` 和至少一个名册内收件人。
4. `possible/likely + unknown` 只能 `ask_owner`；`declined` 只能 `stop`；不得自动升级。
5. `approved` 只表示接受可识别风险，不表示可以披露全部原话和私人细节。
6. `resident_reply` 必须回应 `user_goal`；内部判断摘要不得复制进回复。
7. 每个业务字段必须列出 P1/P2 来源；P3 只能解释表示方法，不能成为业务依据。

## 三个离线样例的选择

1. `corpus-025-cleaning-privacy-2026-09-09`：只问“是否越界”，验证系统不擅自联系。
2. `corpus-026-privacy-knock-2026-09-09`：明确请协调，且两人场景会暴露来源，验证先问所有者。
3. `corpus-024-guest-overstay-2026-09-09`：询问处理方案，验证先给合适的协调方案，
   不把“问怎么处理”自动当成立即联系或直接下禁令。

这三张都是人工核准金标准、完全离线生成报告，不调用模型、不发送消息、不接生产。
