# WillingLink 项目当前状态（单点事实源）

> 新会话先读本文件（约 1-2 分钟），再决定从哪继续。目的：让项目不依赖任何一条
> 会越来越长、会坏的对话。
> 更细决策历史看 `.claude/AGENT_LOG.md`；老板长期意图看
> `.claude/OWNER_TO_CLAUDE.md`；工作制度看 `AGENTS.md`、`CLAUDE.md`。

## 产品一句话

WillingLink 是合租/多人 AI 协调系统：LLM 理解查询，合租「大脑」通过短信协调
多人排班、规则、冲突与入住。核心资产是分层提示词（doctrine）、critic 与确定性
闸，不是通信管道。

## 铁律（老板死命令，不可省）

- Claude Code 是唯一实现者（源码/提示词/测试/迁移/依赖/运行配置）；默认
  `--model sonnet --effort medium`，用短会话和最小必要上下文。
- Codex 是领导/监工/验收：调查、拆解、把边界清楚的任务写进 `.claude/CODEX_TASK.md`
  下派、读完整 diff、跑验证、判断达成、commit+push。
- 发现问题退回 Claude 改；Codex 不自改实现。Claude 不可用就停并报告阻塞。

## 当前工作线（倒序）

### A. 室友矛盾对白语料库（最近活跃，线程因 payload 过大中断）

- 进度：已提交 fragment 001–031，另有 `corpus-index.json` 与 `README.md`；工作树干净。
- 目标：老板原话「奔着无限多去，直到网上爬取不到更多」。
- 产物：`data/roommate-dialogue-corpus/`；素材缓存 `.claude/transcripts-cache/`（gitignore）。
- 下一步：继续采集更多冲突片段，补未覆盖类别（噪音、访客/对象过夜、食物、作息、温度等仍偏薄）。

### B. 合租大脑「回复唯一作者」重构（已验收推送）

- 提交 `6e5f5d6`、`fe1eb5d`：删工具硬编码回复覆盖，注入公平性事实信号，doctrine 补原则。

### C. 合租大脑历史修复（均已提交）

- 排班公平、竞态时钟同源、选定排班自动补发联系人、critic 分层（非敏感不调 LLM）等。

## 关键纪律（详见 AGENTS.md / CLAUDE.md）

- 测试成本分层：默认只跑免费闸 `pnpm.cmd coliving:quality` + `pnpm.cmd exec tsc --noEmit`
  + `git diff --check`；模型级 eval 只按需、定向、`--judge-off`、生产默认模型。
- 安全硬闸 `guard.ts`：本地进程默认不能写真实住户库；测试只在隔离测试屋。
- 不碰 `public/sw.js`；只提交本任务相关文件，保留用户无关改动。
- 改大脑提示词先问三句：能不能不改 / 放哪一层 / 加还是删；宪法只写正面原则，
  检查写 `rubric.md`；代码只给事实与约束，不替大脑写话术；组合计算写代码，不靠模型心算。

## 长期连续性约定（本次建立）

- 本文件是唯一入口；每次会话开始先读它，再按工作线读对应最近 1-2 条 `AGENT_LOG.md`。
- 每条工作线完成或推进一个里程碑，就回来更新上面的「当前工作线」和进度。
- 重要决策/事故追加 `AGENT_LOG.md`；老板意图更新 `OWNER_TO_CLAUDE.md`（仅本地）。
- 本文件是协调文档，不属「产品实现」，Codex 可直接维护；产品行为改动仍走双模型。

## 最快恢复路径

1. `git status --short` 与 `git log --oneline -10` 看指针。
2. 读本文件 + 对应工作线的 `AGENT_LOG.md` 最近条目。
3. 产品行为改动 → 派 `.claude/CODEX_TASK.md` 给 Claude Code。
4. Codex 验收后 commit + push origin main。
