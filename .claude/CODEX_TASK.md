# Claude Code 实现任务：评测专用 Golden Trace A/B

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
