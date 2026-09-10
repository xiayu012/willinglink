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

### 0. 协调大脑能力架构改造（规划启动）

- 长期动态路线：`.claude/BRAIN_IMPROVEMENT_ROADMAP.md`。
- 当前判断：不以“LLM 独自成为顶级人类协调员”为前提；按大脑、眼睛、手脚、
  能力边界重新分工，用成功轨迹、结构化现场卡、组合工具和升级机制逐步验证。
- 现有 doctrine 中的投诉受理、风险分级、异步调解、处置阶梯、记录与转交等 SOP
  将作为我们设计流程和案例的业务参考，不再默认全部继续堆进在线提示词。
- 下一步先做只读证据整理：老板纠正账本、doctrine 冲突图、Golden Trace 候选；
  没有完成设计与对照基线前，不改生产行为。
- 首批证据文档已建立：`.claude/BRAIN_CORRECTION_LEDGER.md`（12 类反复纠正）和
  `.claude/DOCTRINE_CONFLICT_MAP.md`（5 组高优先级拉扯 + 4 组重复负载）。
- 当前最小实验候选：围绕“问什么、谁决定、何时算成立”制作 6 条短对照轨迹；
  先核对真实模块装配和当前模型基线，再决定是否改 doctrine。
- 六条轨迹设计稿已写入 `.claude/GOLDEN_TRACE_CANDIDATES.md`；路由核对确认上述冲突会在
  常见住客投诉中真实同时装配。下一步是老板人工审阅方向，再做当前模型基线。
- 老板新增三条一级红线：推断性隐私不得泄露；已知处理不稳时坦白边界并交接；
  保持中立、稳定、像“坚实的大地”。能力边界已提前，草案见
  `.claude/CAPABILITY_BOUNDARY_V0.md`，当前尚未接生产。
- 能力边界首轮桌面演练已完成；没有把普通小事一概升级。接入前最大产品选择是：
  红区由谁接手、通过什么通道接手，以及无人接手时系统还能承诺到哪一步。
- 老板复审后纠正：住户消息不得复述内部记录/核实/判断过程；隐私可能被推断时先问
  信息所有者是否仍发送，不自动升级。GT03/GT05/GT06 已按此缩短修正。
- Doctrine 不再只是参考索引：`.claude/DOCTRINE_DEVELOPMENT_MAP.md` 已规定每项行为改动
  必须先提炼适用业务规格，再决定放入提示词、案例、现场卡、代码、工具、边界或验收。
- `.claude/CURRENT_TURN_CARD_V0.md` 已完成：核对现有 context 后设计三张桌面卡，聚焦
  speaker/addressee/subject、信息来源与披露、关键缺项、决定状态和简洁回复契约。
- 当前第一项实现候选：离线生成现场卡并人工核对，不直接替换生产 context；确认不丢事实后
  才做少量定向对照。
- `.claude/TOOL_CHAIN_INVENTORY.md` 已盘点 22 个工具与五条业务链；第一组合候选是
  `publishSchedulePlan`，但尚未决定先做它。下一步将 Golden Trace、现场卡、组合工具
  按收益/风险/成本统一选择第一项实现。
- 三方案已对照，第一项实现选择“仅评测显式启用的 Golden Trace A/B”，详见
  `.claude/FIRST_EXPERIMENT_DECISION.md`；默认关闭、不改生产 doctrine。Claude Code 已完成
  隔离 A/B 能力，Codex 已通过 70 项离线闸、类型检查基线和 CLI 参数边界验收。
- 第一组隐私 A/B 已停止：实验组没有先征求信息所有者同意，反而在 outbound 直接写出
  阿哲姓名和私人房间细节；两组结构检查仍判通过，说明验收也有缺口。没有继续另两个场景，
  没有调用语义 judge，不再追加 Golden Trace，也不接生产。
- 根因转为 D05/C13：旧 critic/硬闸会驳回正确的来源推断风险询问，现场状态又缺少明确的
  `source_owner / proposed_recipient / inference_risk / owner_consent`。治本设计见
  `.claude/PRIVACY_DECISION_V0.md`；下一步先做离线隐私现场卡并人工核对，再决定最小动作阻塞。
- 离线模型卡首轮也已证伪：`deepseek/deepseek-v4-flash` 经两种 SDK 结构化输出方式都不能
  生成符合 schema 的对象，均明确报未验证，没有落假报告。停止继续调用；下一步改为在场景中
  保存人工核准的标准卡并生成 HTML，先建立可比较真值，再谈模型提取。
- 第一张人工标准隐私卡已落在 `corpus-025-cleaning-privacy-2026-09-09`：完全离线命令成功
  生成 JSON/HTML，确定性确认 `阿哲 → 大凯 / likely / unknown / ask_owner`。免费闸已增至
  80 项全过；HTML 明示“人工核准、非模型生成”，包含风险依据和判断摘要，不展示隐藏思维链。
- 下一步不是接生产：先补覆盖 `possible / declined / approved / none` 的少量标准卡，确认状态模型
  足以表达现实差异；再设计生产动作阻塞的最小接口。

### A. 室友矛盾对白语料库 + 转化

- 进度：已提交 fragment 001–030（去重后），另有 `corpus-index.json` 与 `README.md`。
- 转化：5 条已转成 `lib/chat/coliving/evals/scenarios/corpus-013/024/026/028/030-*.json`（Claude Code 实现、Codex 验收）。
- 多人场景 002/003/004/013/018 已补齐；2026-09-09 修正了把室友间“你/你的/你俩”
  错当成对协调 AI 说的角色错位。往后纯对白转化与文字修订由 Codex 直接完成。
- 继续新增 5 条 A/P0 场景：006 卫生间维修、008 公共餐桌、010 搬走与冰箱习惯、
  015 个人食物边界、016 失业后的房租焦虑；均为 3–7 轮、AI-facing 独立入站。
- 目标：把采集到的真实矛盾对白持续转成可跑评测场景，替代/扩充旧合成用例。
- 产物：`data/roommate-dialogue-corpus/`；场景在 `lib/chat/coliving/evals/scenarios/`。
- 下一步：继续转化其余 A 档片段；需要行为验证时再按成本纪律做定向
  `--judge-off` 冒烟，纯对白转化本身不烧模型评测。

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
