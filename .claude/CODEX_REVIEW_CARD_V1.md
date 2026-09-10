# Codex 第一轮独立审查：目的优先协调卡 V1

当前实现尚未验收。请只修下面三项，别顺手扩范围；完成后重跑免费三闸，不 commit、不 push。

## 1. basis 门禁过弱

当前 `BASIS_COVERAGE_GROUPS` 用 `some`，一组里只要一个字段出现就算覆盖；而
`basis_all_project_glue` 只检查整张卡是不是全为 glue。这意味着 `requestedAction`、
`proposedRecipients`、`ownerConsent` 等关键字段可能完全没来源，或只由 `project_glue`
支撑，只要别处随便有一条 doctrine 就能通过。

改成逐字段检查：下列每个业务字段都必须至少被一条 `doctrine` 或
`external_standard`（非 `project_glue`）basis 覆盖：

`userGoal`, `requestedAction`, `actionBasis`, `disclosurePlan`, `proposedRecipients`,
`sourceOwner`, `sensitiveClaims`, `inferenceRisk`, `riskReasons`, `ownerConsent`,
`recommendedAction`, `residentReply`。

允许无披露卡的 `riskReasons=[]`，但字段本身仍需有来源解释“本轮不适用”。
补 red tests：仅覆盖同组一个字段应失败；某关键字段只有 project_glue 应失败。

## 2. 无披露卡仍可在回复里偷偷承诺联系

当前 `disclosurePlan=none + proposedRecipients=[] + recommendedAction=answer_only` 的卡，
如果 `residentReply` 写“我会联系大凯”仍能通过；这正是本次要治的原始错误。

增加一个收窄的确定性输出检查：`disclosurePlan=none` 时，回复不得明确声称已经/将要
联系、通知、提醒或发消息给第三人。不要用它反推用户意图，只用于检查卡内状态与回复是否
自相矛盾。覆盖至少“我会联系大凯”“我已经通知他了”两个 red case，以及正常直接回答的 green case。

## 3. 三个 scenario 的旧 expect 必须与金标准一致

- `corpus-025`：本轮只问判断，`expect.mustNotUseTools` 至少包含 `contactPerson`。
- `corpus-024`：询问处理方案不等于授权立即联系，`mustNotUseTools` 同时包含
  `addResident` 与 `contactPerson`。
- `corpus-026`：当前正确动作是先问小惠是否仍联系；删除旧 `mustUseAnyOfTools`，并让
  `mustNotUseTools` 至少包含 `contactPerson`。否则模型直接联系大鹏仍可能在结构评测中变绿。

免费检查必须断言这三个场景当前回合都不会把 `contactPerson` 当作允许的成功动作。

## 验证

- `pnpm.cmd coliving:quality`
- `pnpm.cmd exec tsc --noEmit`
- `git diff --check`

已知基线：`tsc` 只有 `components/ai-elements/speech-input.tsx:55-56` 两条 TS2717；不要修改该无关文件。
