# Claude Code 实现任务：目的优先的离线协调卡 V1

## 角色与边界

你是本任务唯一实现者。先完整阅读 `AGENTS.md`、`CLAUDE.md`、`.claude/PROJECT_STATE.md`、
`.claude/CARD_SOURCE_MAP.md`、`.claude/PRIVACY_DECISION_V0.md`，以及这些 doctrine：
`always/constitution.md`、`always/arbitration.md`、`always/craft.md`、
`domain/conflict.md`、`domain/complaint-risk.md`、`tool/records.md`。

只修改离线评测卡、三个场景中的人工金标准卡、HTML 报告和免费确定性检查。不得接入生产
`runColivingTurn`、doctrine、critic、contactPerson，不调用模型，不写数据库，不发送消息。
不得触碰或提交 `public/sw.js`。不要改 Codex 已完成的 `turns[].text` 中文转化。

## 根本问题

当前卡一看到消息里提到另一个人，就直接进入“准备联系谁”的隐私流程。这让 `corpus-025`
（用户只问“算不算越界”）凭空多出联系大凯的任务，回复因此答非所问。

V1 必须先表达用户目的和本轮请求动作；只有确实存在对外数据动作时，才评估拟收件人、
反推风险与许可。业务规则与来源以 `.claude/CARD_SOURCE_MAP.md` 为准，不自行发明新 SOP。

## 1. 扩展卡片状态

修改 `privacy-turn-card.ts` 及场景 schema，至少加入：

- `userGoal`: `answer_question | record_only | coordinate | propose_rule | other`
- `requestedAction`: `answer_only | record_only | consider_contact | contact_person | other`
- `actionBasis`: `explicit_user_request | doctrine_coordinator_duty | none`
- `disclosurePlan`: `none | considering | approved_to_send`
- `inferenceRisk` 增加 `not_applicable`
- `recommendedAction`: `answer_only | record_only | ask_owner | safe_to_contact_minimized | stop`
- 逐字段依据，例如 `basis: Array<{ fields: string[]; sourceType: "doctrine" | "external_standard" | "project_glue"; sourceRef: string; rule: string }>`。字段名可小幅调整；HTML 必须能看出每组字段依据哪份 doctrine/外部标准。`project_glue` 不得成为权限或流程的唯一依据。

保留 `sourceOwner`、`proposedRecipients`、`sensitiveClaims`、`riskReasons`、`ownerConsent`、
`residentReply`、`decisionSummary`。标题/注释从狭义“隐私卡”改为“本轮协调动作卡”或同义名称。

## 2. 确定性状态不变量

至少验证：

1. `requestedAction=answer_only` -> `disclosurePlan=none`、`proposedRecipients=[]`、
   `inferenceRisk=not_applicable`、`ownerConsent=not_needed`、`recommendedAction=answer_only`。
2. `disclosurePlan=none` 时拟收件人必须为空，风险必须 `not_applicable`；提到的人名不是收件人。
3. `disclosurePlan!=none` 时必须有非 `none` 的 `actionBasis` 和至少一个名册内、非 speaker 的收件人。
4. 只有 `disclosurePlan!=none` 才允许 `none/possible/likely`；`possible/likely + unknown`
   只能 `ask_owner`；`declined` 只能 `stop`；未许可不得宣称已联系。
5. `safe_to_contact_minimized` 只能用于 `approved_to_send`，并保留敏感事实/风险依据供人工核对。
6. `basis` 必须覆盖目的/请求动作、披露计划、隐私状态、建议动作；不得全部只有 `project_glue`。

不要用话术正则猜用户是否想联系；金标准由人工填写，校验只检查状态组合。

## 3. 三张人工金标准卡

在三个已有单轮场景中填写/改正 `privacyCard`：

1. `corpus-025-cleaning-privacy-2026-09-09`
   - 询问边界判断，只回答；没有披露计划和收件人。
   - `not_applicable / not_needed / answer_only`。
   - 回复：`按你描述的情况，算越界。未经你同意进入你的房间、动你的东西，不会因为他说是关心就变得合适。你不是反应过度。`
   - 不得询问是否联系大凯。修正 `source` 中暗示必须联系的旧目标，明确不擅自增加联系任务。

2. `corpus-026-privacy-knock-2026-09-09`
   - 用户明确“请你协调一下”，因此是 `explicit_user_request`，可考虑联系大鹏。
   - 两人范围 + 换衣服/浴室独有细节为 `likely`；许可 `unknown`；动作 `ask_owner`。
   - 回复只说明大鹏很可能知道来源并问是否仍联系；不升级、不声称已联系。

3. `corpus-024-guest-overstay-2026-09-09`
   - “怎么处理合适”是询问方案，不等于授权立即联系小俊。
   - 可用 `propose_rule / answer_only / none / not_applicable / not_needed / answer_only`。
   - 回复直接给简短原则：允许带朋友不等于默认长期同住；应把访客频率、过夜和新增开销形成双方可执行的规则；不声称已联系或直接下禁令。
   - 删除旧 `expect.mustUseAnyOfTools` 的强制动作；保留 `mustNotUseTools: ["addResident"]` 与必要的泄漏/武断措辞检查。

每张 `basis` 至少覆盖：目的（constitution + ICO Purpose limitation）、事实来源
（constitution 或 records）、披露时隐私（conflict / complaint-risk / constitution）、
最小披露（constitution / records + ICO Data minimisation）、回复（craft）。

## 4. HTML/JSON

继续完全离线输出 JSON + HTML。HTML 必须：

- 标题明确“人工标准本轮协调动作卡（非模型生成）”；
- 先显示目的、请求动作、动作依据、披露计划，再显示隐私字段；
- 显示逐字段来源，区分 doctrine / external standard / project glue；
- 将 `not_applicable` 解释为“本轮没有披露动作，因此不适用”，而不是绝对无风险；
- 保留转义、校验结果、内部摘要与对外回复分离。

CLI 保持一次一个场景，Codex 会连续跑三次。不得增加模型调用。

## 5. 免费检查与交付

扩充 `coliving-quality-inspect.ts`，覆盖上述 green/red cases，尤其 answer-only 不得带收件人、
no-disclosure 必须 not_applicable、披露计划必须有收件人与 action basis、likely+unknown 只能
ask_owner、basis 不能全靠 project_glue、三个场景均通过、CLI 不引用模型/生产/数据库/联系动作。

完成后运行：

- `pnpm.cmd coliving:quality`
- `pnpm.cmd exec tsc --noEmit`
- `git diff --check`

不要 commit、不要 push。最后列出完整修改文件、验证结果和未覆盖风险。
