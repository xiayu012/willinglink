# 当前任务入口

2026-09-10 当前唯一有效任务见 `.claude/CODEX_TASK_CARD_V1.md`。本文件以下内容均为已经完成的历史任务，只保留作实现证据，不得继续执行。

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
