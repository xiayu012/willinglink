# Codex 独立审查：管理动作卡 V2 第一轮

当前 92 项免费检查通过，但发现三项状态/产品问题。只修这些，不扩范围；不 commit/push。

## 1. `coordinate_rule` 仍错误地强迫讨论阶段出站

通用逻辑允许 `decisionStage=deliberating` 无 outbound，但后面无条件执行：

```ts
if (card.recommendedAction === "coordinate_rule" && !hasOutbound) fail
```

这会把“用户和 AI 正在讨论规则方案，尚未确认”的合法回合判失败，正好违反老板刚补充的边界。

修正：`coordinate_rule` 只有在 `decisionStage=authorized` 时才要求已发送动作；
`deliberating + coordinate_rule + actionStatus=not_started + no outbound` 必须能通过。增加专门 green test，
不要只拿 `make_schedule` 代表所有讨论态。

## 2. `ready_to_send` 与“实际动作”语义矛盾；declined 没有合法终态

当前 `outboundMessages` 被定义/展示成“实际 outbound”，但 `ready_to_send` 又被当成有 outbound 的合法状态，
会让“准备发、尚未发送”错误满足已授权阶段的动作完成要求。

本离线金标准评的是整轮期望结果，收窄状态：

- 删除 `ready_to_send`；有实际 outbound 的状态只有 `sent_waiting_reply | completed`。
- 增加 `stopped` actionStatus，与 `recommendedAction=stop` 配套，无 outbound。
- `disclosurePlan` 增加 `cancelled`，用于信息所有者明确拒绝后停止。
- `ownerConsent=declined` 必须组合为 `recommendedAction=stop + actionStatus=stopped +
  disclosurePlan=cancelled + outboundMessages=[]`，并且能通过。
- 只有 `conceal_source + possible/likely + ownerConsent=unknown` 才是等待确认的冲突态：
  `ask_owner + blocked_for_consent + considering`。
- 现有 concealConflict 不应在 `declined` 时仍强制 ask_owner。用 pending-concealment（unknown）区分。

补 green/red tests，确保拒绝后“停止且不自动升级”有可表达的合法状态。

## 3. 024 继续压缩，不复述事项清单

把 gold outbound 压成：

`请告诉我你能接受的访客过夜频率，以及新增水电怎么承担。`

把 residentReply 压成：

`我已联系小俊；等他回复，我来定具体规则并通知双方。`

内部 `decisionSummary` 和 basis 可以保留详细依据，但对外两条不要重复解释“允许朋友不等于长期住”、
访客/过夜/水电的整串大道理。

## 验证

- `pnpm.cmd coliving:quality`
- `pnpm.cmd exec tsc --noEmit`（只允许既有 speech-input.tsx:55-56 两条 TS2717）
- `git diff --check`
