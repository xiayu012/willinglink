# Claude Code 实现任务：撤销七项“伪能力”离线实现

日期：2026-09-10。老板明确纠正：V5 从工具链一次归纳出的七项不能称为能力；接下来能力要一项一项建立并验收。

## 要做什么

只撤销 commit `250f77c` 中与七项 capability registry、三张映射报告和离线 CLI 有关的实现：

- 删除 `lib/chat/coliving/evals/intent-capability.ts`；
- 删除 `lib/chat/coliving/evals/intent-capability-samples.ts`；
- 删除 `lib/chat/coliving/evals/intent-capability-args.ts`；
- 删除 `scripts/coliving-intent-capability.ts`；
- 从 `package.json` 删除 `coliving:intent-capability`；
- 从 `scripts/coliving-quality-inspect.ts` 删除 V5 的 imports 和全部“意图×能力”检查；
- 删除本地 `tests/coliving-eval/reports/intent-capability/` 报告目录。删除前确认解析后的绝对路径严格位于
  `D:\WillingLink\tests\coliving-eval\reports\intent-capability`，不得扩大范围。

不要机械 `git revert 250f77c`：该提交还包含需要保留并由 Codex 重写的长期协调文档。不要修改任何 `.claude`
文件，不碰生产 `turn.ts`、doctrine、critic、数据库、依赖或环境，不碰 `public/sw.js`。

## 为什么

七项只是根据已有工具和事故归纳出的候选工作，没有逐项端到端建立和验证。工具存在、schema 完整、离线样例
自洽都不能让一项工作取得“能力”资格。保留这套 registry 会让后续开发误以为系统已经拥有七项能力。

老板仍保留“用户意图/目的”这个长期维度，也保留 capability / policy / playbook 的概念区分；本任务不重新
实现它们。第一项真正 capability 的契约会在老板逐项选择后另开任务。

## 验收

- `rg` 不再找到 V5 源码、脚本、package 命令或 quality 检查；
- 原 V4 及更早检查保持通过，预计回到 109 项；
- `pnpm.cmd coliving:quality`；
- `pnpm.cmd exec tsc --noEmit`；
- `git diff --check`；
- 不调用模型、网络、数据库或发送动作；不 commit/push。
