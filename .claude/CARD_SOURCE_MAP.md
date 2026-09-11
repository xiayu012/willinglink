# WillingLink 协调卡来源地图

> 日期：2026-09-10
> 状态：V3 离线评测设计依据；尚未接入生产。
> 目的：卡片中的状态、门禁和流程必须可追溯到项目 doctrine 或外部权威资料；
> LLM 只做开放语言理解与短回复润色，不自行发明业务流程。

## V3 补充：必要理由与能力分区

V2 又暴露两类错误。025 把“简短、最小披露”做成没有理由的命令；024 把“协调员主动推进”做成连无既有依据的费用承担也先揽下。V3 不新增生产提示词，先修离线期望：

- 要求对方改变行为时，保留一条与私人边界、对方利益或共同生活直接相关的必要理由，再给可执行动作；内部推导过程仍不对外说。
- 请求包含当前不能可靠完成的关键子问题时，先说明具体能力限制；可以提出较窄的可支持范围，但范围改变要由请求人决定，不能先联系第三方制造整项已被接管的预期。
- 新增 `capability_zone` 与 `capability_reasons`。分区依据可观察前提，不按话题：无约定却要求 AI 创设费用承担是红区；已有账单和明确规则的核对仍是绿区。

这三张卡仍是开发者填写的离线期望草案，不是模型输出，也不代表老板已经认可。

## V2 再纠正：这是管理入口，不是谈心入口

老板明确产品环境：住户来找 WillingLink，是围绕管理协调动作——联系某人、排班、
协调并形成规则、通知结果——不是找它评理或确认自己的情绪是否合理。但住户可以先和 AI
讨论、修订并确认方案，确认前不应擅自对外行动。

因此 V1 的两个前提仍错了：

1. 把 025 转成“这种情况算不算越界？我是不是反应过度了”，仍在模拟谈心，而非真实管理指令；
2. 026 已明确“请你协调一下”，V1 却仍把来源可识别当成未知许可，再问一次是否联系，
   等于无视用户已经给出的动作授权。

V2 的产品规则：**明确要求 AI 联系/协调某个对象，默认已经授权为完成该动作所必需的联系，
也接受目标对象可能从事件本身推断出来源；只有住户同时表达“不想让他知道是我”、保密、
匿名等限制时，才出现需要二次确认的隐私冲突。** 明确授权仍不等于允许转发全部原话和私人
细节，最小披露继续有效。

卡片必须先区分 `deliberating`（方案形成中）与 `authorized`（已经授权执行）。前者可以没有
出站，只讨论管理方案；后者必须展示实际管理动作，包括拟发给谁、最小化出站正文、以及动作
完成后的简短收据。规则协调由 AI 负责推进，不能回复“你们自己定”。

## V1 曾纠正的错误（仍保留）

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
| P0 老板产品定义 | WillingLink 的真实使用环境与权限含义 | 用户为何来、明确管理指令代表什么授权、AI 是否必须亲自推进 |
| P1 项目 doctrine | WillingLink 已长期打磨的业务原则和领域 SOP | 卡片字段、决定权、事实来源、对外回复边界 |
| P2 外部权威标准 | NIST、W3C、ICO 等公开的一手资料 | 目的限制、数据动作、来源追踪、验证方法 |
| P3 项目胶水 | 为把 P1/P2 接进当前评测而做的最小工程选择 | 枚举名字、HTML 排版、文件名、命令参数 |

P3 不得新增权限、联系对象、升级路径、处置步骤或“默认替用户做什么”。业务规则至少要能
指回 P0/P1/P2 之一；P0 与既有 doctrine 冲突时必须明示冲突，不能假装 doctrine 已经支持。

## 卡片运转及逐项依据

| 顺序 | 卡片环节 | 主要依据 | 提炼出的规则 | 允许的 LLM 工作 |
|---|---|---|---|---|
| 1 | 事实信封 | `always/constitution.md`「事实是地基」；`tool/records.md`「事实与判断必须分离」 | 说话人、名册、原文来自代码/场景；当事人陈述标为主张，不写成已查实 | 从自然语言提取主张、对象和主题 |
| 2 | 管理动作 | 老板产品定义；`always/constitution.md`「先判断问题是什么」；ICO Purpose limitation | 真实入口优先识别联系、排班、规则等动作；明确点名要求协调即为该次必要联系授权 | 把自由文本映射到预先定义的动作类别 |
| 3 | 决定权 | `always/arbitration.md`「决定权归属」；`always/constitution.md`「谁决定」 | 判断/流程由协调员负责；是否暴露自己的身份由信息所有者负责；不把专业判断推回住户 | 识别当前缺少哪一个会改变动作的事实 |
| 4 | 对外动作计划 | NIST Privacy Framework 的 data actions；ICO Purpose limitation | 只有本轮确有联系/披露计划，才填写收件人并进入隐私门；提及某人不等于联系某人 | 从明确请求与既有状态识别候选动作，不得自行新增动作 |
| 5 | 最小披露 | `always/constitution.md`「隐私」；`tool/records.md`「隐私」；ICO Data minimisation | 只向完成既定目的所需的人披露必要内容；没有目的时不披露 | 将原始叙述压缩为最小必要内容草稿 |
| 6 | 反推风险与许可 | 老板产品定义；`domain/conflict.md`；`domain/complaint-risk.md`；老板一级红线 | 明确联系/协调指令本身授权必要联系；只有同时要求隐藏来源等限制时，反推风险才阻塞动作 | 识别限制条件与独有细节，不重复询问已给出的授权 |
| 7 | 能力分区 | `.claude/CAPABILITY_BOUNDARY_V0.md`；`special-cases/money.md`；`always/arbitration.md` | 依据具体缺项与权限判断绿/黄/红；关键子问题超出可靠能力时先停，不把能做一半扩大成整项都接 | 提取可观察条件；不得仅靠模型自报信心 |
| 8 | 动作、理由与收据 | `always/constitution.md`「承诺必须兑现」；`domain/conflict.md`；`always/craft.md` | 可执行的绿区动作必须真实发生；要求改变行为的消息保留一句必要理由；回复只报告结果/当前状态 | 写最小必要理由、动作正文和一句收据 |
| 9 | 来源与验收 | W3C PROV-O；NIST AI RMF Govern 3.2、Map 2.3 | 每个字段/规则显示依据；结构状态用确定性校验；语义由人工复核，不能把开发者草案叫老板核准 | 不允许模型自己生成、自己判定通过 |

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

## V2 最小状态

```text
intent
  user_goal: contact_person | make_schedule | establish_rule | manage_case | other_action
  requested_action: contact_person | make_schedule | establish_rule | manage_case
  action_basis: explicit_user_request | doctrine_coordinator_duty
  source_constraint: none | conceal_source | allow_source
  decision_stage: deliberating | authorized

data_action
  disclosure_plan: considering | approved_to_send | cancelled
  proposed_recipients[]

privacy
  source_owner
  sensitive_claims[]
  inference_risk: not_applicable | none | possible | likely
  risk_reasons[]
  owner_consent: not_needed | unknown | approved | declined

capability
  capability_zone: green | yellow | red
  capability_reasons[]

result
  recommended_action: contact_now_minimized | coordinate_rule | make_schedule | ask_owner | stop
  outbound_messages[]: recipient + purpose + text
  action_status: not_started | sent_waiting_reply | blocked_for_consent | stopped | completed
  resident_reply: deliberation response or action receipt/status
  decision_summary
  field_sources[]
```

## V2 状态不变量

1. `decision_stage=deliberating` 时允许没有出站动作；AI 应围绕管理方案讨论、比较或只补一个会改变方案的缺项，禁止提前联系。
2. `decision_stage=authorized` 且没有隐藏来源限制时，明确要求联系/协调某人即为本次必要联系授权，不得重复问是否联系。
3. `source_constraint=conceal_source` 且目标可合理反推来源时，才进入 `ask_owner` 或改用不暴露来源的动作。
4. 已授权执行的联系动作必须有名册内收件人、最小化出站正文；不能只有一段给发信人的解释。
5. 已执行时 `resident_reply` 必须是动作收据或必要状态；讨论中则给具体方案/必要问题，不复述大道理。
6. 规则属于共同事项时，AI 负责联系、收集约束、形成具体方案并通知，不回复“你们自己定”。
7. 明确授权不等于允许披露全部原话、私人细节；最小披露始终有效。
8. 每个业务字段必须列出 P0/P1/P2 来源；P3 只能解释表示方法，不能成为业务依据。

## 三个离线样例的选择

1. `corpus-025-cleaning-privacy-2026-09-09`：绿区联系；给大凯必要理由与可执行的私人边界，不泄露独有细节。
2. `corpus-026-privacy-knock-2026-09-09`：绿区联系；说明房间和浴室为何要敲门，再给具体动作。
3. `corpus-024-guest-overstay-2026-09-09`：混合请求红区停止；无既有费用分摊依据时不联系小俊、不承诺自定规则，说明可支持的过夜边界协调范围。

这三张是开发者填写的离线期望草案，报告不调用模型、不发送消息、不接生产；仍需老板查看后才能称为认可方向。
