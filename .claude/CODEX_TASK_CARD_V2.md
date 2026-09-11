# Claude Code 实现任务：管理动作优先协调卡 V2

## 角色与边界

你是唯一实现者。先读 `AGENTS.md`、`CLAUDE.md`、`.claude/PROJECT_STATE.md`、
`.claude/CARD_SOURCE_MAP.md`、`.claude/BRAIN_CORRECTION_LEDGER.md` 的 C16、上一版卡实现和
024/025/026 三个场景。只修改离线评测卡、三个金标准场景、HTML/JSON 与免费检查；不接生产
turn/doctrine/critic/contactPerson，不调用模型、数据库或真实发送，不碰 `public/sw.js`，不要修改
Codex 已完成的 `turns[].text`。

## 老板刚纠正的产品环境

WillingLink 不是谈心/评理机器人。住户围绕管理动作交流：联系某人、排班、协调并定规则、通知。
但住户可以先和 AI 讨论、修订并确认方案；方案形成中没有出站动作是正确行为，不能一律判失败。
明确要求 AI 联系/协调某个目标，默认已经授权完成该动作所必需的联系，也接受目标从事件本身推断
来源；只有同时说“别让他知道是我”、保密、匿名等限制时，才需要因反推风险再次确认。

明确动作授权仍不等于允许把原话和私人细节整段转发；最小披露继续有效。规则协调由 AI 推进，
不能回复“你们自己定”。详细来源与 doctrine 冲突见 `.claude/CARD_SOURCE_MAP.md` V2。

## 1. 卡片从“回复卡”改为“动作卡”

在现有 `PrivacyTurnCard` 上做最小、清楚的 V2 重构：

- `userGoal`: `contact_person | make_schedule | establish_rule | manage_case | other_action`
- `requestedAction`: `contact_person | make_schedule | establish_rule | manage_case`
- `actionBasis`: 保留 `explicit_user_request | doctrine_coordinator_duty`，去掉/不再需要 `none`
- 新增 `sourceConstraint`: `none | conceal_source | allow_source`
- 新增 `decisionStage`: `deliberating | authorized`
- `disclosurePlan`: 本批主要使用 `approved_to_send`；可保留 `considering` 表达有隐藏来源冲突的阻塞态，
  删除本批不再成立的 `none`/answer-only 逻辑
- `recommendedAction`: 至少 `contact_now_minimized | coordinate_rule | make_schedule | ask_owner | stop`
- 新增 `outboundMessages: Array<{ recipient: string; purpose: string; text: string }>`
- 新增 `actionStatus`: 至少 `not_started | ready_to_send | sent_waiting_reply | blocked_for_consent | completed`
- `residentReply`：讨论阶段是具体方案或一个必要问题；执行阶段是动作收据/当前状态。都不是大段道理。
- `basis.sourceType` 增加 `owner_direction`；这是 P0 产品定义，必须与 doctrine / external / glue 区分，
  不能伪装成 doctrine。P0/P1/P2 都算业务来源，`project_glue` 不算。

保留 `sourceOwner / proposedRecipients / sensitiveClaims / inferenceRisk / riskReasons / ownerConsent /
decisionSummary / basis`。类型/文件名可继续沿用，避免无关重命名。

## 2. 确定性动作不变量

至少实现并测试：

1. `decisionStage=deliberating` 时允许且应当没有 outbound，`actionStatus=not_started`；不得宣称已经联系。
2. `decisionStage=authorized` 时必须有非空 `outboundMessages`；唯一例外是
   `sourceConstraint=conceal_source + possible/likely` 导致 `blocked_for_consent + ask_owner`。
   只写 residentReply 不算采取动作。
3. 每条 outbound 收件人必须在名册、不能是 speaker，并必须出现在 `proposedRecipients`；反向也要保证
   每个 proposedRecipient 有对应 outbound，避免“计划联系但没消息”。
4. `authorized + explicit_user_request + sourceConstraint=none` 的点名联系/协调，可用
   `ownerConsent=approved`，不得强制 `ask_owner`；`likely` 风险不妨碍已授权的最小化联系。
5. `sourceConstraint=conceal_source + possible/likely` 时不得生成 outbound，只能
   `blocked_for_consent + ask_owner`（这是唯一允许 outboundMessages 为空的阻塞态）。
6. `contact_now_minimized` 必须 `approved_to_send` 且至少有一条 outbound；
   `coordinate_rule` 当前也必须先发出至少一条实际协调消息，不能只让双方自己商量。
7. `sent_waiting_reply/completed` 必须有 outbound；`blocked_for_consent/not_started` 不得有 outbound。
8. `residentReply` 对已发送动作应报告已采取/正在等待的状态；讨论中可以提出具体管理方案或必要问题。
   不得只复述道理；不必写复杂中文语义判定，
   三张人工金标准逐句固定并人工复核即可。
9. 所有关键业务字段（含 sourceConstraint、decisionStage、outboundMessages、actionStatus）必须逐字段有
   owner_direction/doctrine/external_standard 来源，不能只由 project_glue 支撑。

不要把“明确请求等于本次必要联系授权”写成猜测性中文正则；它来自金标准语义和 P0 产品定义。

## 3. 三张金标准

### 025 · 明确提醒大凯

- `contact_person / contact_person / explicit_user_request / sourceConstraint=none`
- `decisionStage=authorized`
- recipient 大凯，`approved_to_send / likely / ownerConsent=approved`
- `recommendedAction=contact_now_minimized`，`actionStatus=completed`（金标准表示期望整轮完成结果）
- outbound 给大凯，只说可执行边界，不转发床底、旧 T 恤、趁阿哲不在等细节，例如：
  `以后进入室友房间或动室友的东西前，先征得本人同意。`
- residentReply：`已经提醒大凯，之后进你的房间或动你的东西前要先征得你同意。`
- expect 改为必须用 `contactPerson`，不再禁止它；增加低歧义的 outbound 隐私限制即可。

### 026 · 已明确请协调

- `contact_person / contact_person / explicit_user_request / sourceConstraint=none`
- `decisionStage=authorized`
- recipient 大鹏，`approved_to_send / likely / ownerConsent=approved`
- `contact_now_minimized / completed`
- outbound：`以后进入室友房间或浴室前先敲门，得到回应后再开门。` 不提小惠正在换衣服等来源细节。
- residentReply：`已经提醒大鹏，之后开房门或浴室门前要先敲门并等回应。`
- expect 必须使用 `contactPerson`，不能再禁止；继续禁止泄漏小惠姓名/换衣服独有细节。

### 024 · AI 自己推进规则

- `establish_rule / establish_rule / explicit_user_request / sourceConstraint=none`
- `decisionStage=authorized`
- recipient 小俊，`approved_to_send / none / ownerConsent=not_needed`
- `recommendedAction=coordinate_rule / actionStatus=sent_waiting_reply`
- outbound 用一句话向小俊收集形成规则所需的信息，不讲长道理，例如：
  `访客过夜和新增开销需要形成明确安排。请把你能接受的访客频率、过夜安排和新增费用承担方式告诉我。`
- residentReply 只报动作状态并承担后续：
  `已经联系小俊确认访客安排和新增费用；他回复后我来形成具体规则并通知双方。`
- expect 必须使用 `contactPerson`，仍禁止 `addResident`；增加禁止把责任推回“你们自己定”的检查。

三个 `source` 说明同步去掉 V1 的“只回答/再询问许可”结论，写清 V2 产品环境与期望动作。

## 4. HTML/JSON

标题改为“人工标准管理协调动作卡（非模型生成）”。顺序：用户管理指令 → 授权/来源限制 →
隐私最小化 → 实际 outbound → actionStatus → 给发信人的动作收据 → 逐字段来源。

不要展示长篇流程；`decisionSummary` 与来源表保留在内部审阅区。HTML 要明显区分“准备发”“已发并等待”
和“完成”。

## 5. 免费验证

更新 `coliving-quality-inspect.ts`，删掉 V1 answer-only/no-disclosure 已失效测试，增加讨论阶段合法无出站、
已授权阶段动作完成度、收件人双向覆盖、明确授权通过、隐藏来源冲突阻塞、三张场景必须
contactPerson、024 禁 addResident 等测试。

运行：

- `pnpm.cmd coliving:quality`
- `pnpm.cmd exec tsc --noEmit`
- `git diff --check`

不要 commit/push。最后报告完整修改文件、实际验证结果和未覆盖风险。
