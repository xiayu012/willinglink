# Claude Code 实现任务：用户意图 × 能力模块架构 V0（离线）

日期：2026-09-10。只做现有系统盘点、离线结构和人工样例，不接生产。

## 老板提出的方向

老板希望把系统整理成“能力模块”，让能力边界更清楚；同时把用户找上来的意图和目的作为长期
开发的一等维度。Codex 判断这与现有 H3–H6、工具链盘点和 V4 逐动作计划吻合，但能力模块不能
退化成一堆提示词文件，意图也不能退化成一个单标签分类器。

## 开工前阅读与独立审查

先读：`AGENTS.md`、`CLAUDE.md`、`.claude/PROJECT_STATE.md`、
`.claude/DEVELOPMENT_JUDGMENT.md`、`.claude/BRAIN_IMPROVEMENT_ROADMAP.md`、
`.claude/DOCTRINE_DEVELOPMENT_MAP.md`、`.claude/TOOL_CHAIN_INVENTORY.md`、
`.claude/DOCTRINE_CONFLICT_MAP.md`、V4 `action-plan*.ts`，以及生产 `turn.ts` 中当前实际工具定义。

实现前独立验证工具盘点没有漂移，并提出至少两个会推翻错误设计的反例：

- 普通住户也可能说“弄好后通知我”，不能把措辞当意图或授权枚举；
- 一个消息可同时要求“先联系取数、再做草案、但先别发布”，不能只给一个 intent 标签；
- “有工具”不等于“能力已可靠”：工具存在但多步链仍常漏，最多标 partial；
- “访客/噪音/清洁”是领域 playbook，不应各自复制成同构能力模块；
- 隐私、公平、事实来源、决定权、动作收据是跨模块门禁，不应复制进每个模块成为漂移副本。

若你的设计需要超过 7 个首批能力模块、超过 6 个意图核心字段，或简单提醒也要填写大量无关字段，
先收窄并说明；不要为了显得完整把整个产品一次建模。

## Doctrine 使用卡 6

- **直接依据**：`always/identity.md` 的语言/信息/记录/调度能力与无身体/权限边界；
  `always/constitution.md` 的决定权、受影响者参与、承诺兑现；`always/arbitration.md` 的个人/共同/
  流程决定区分；`always/craft.md` 的内部复杂、对外只给必要结果；`domain/conflict.md` 的异步协调；
  `tool/records.md` 的事实来源、送达与闭环；`special-cases/money.md` 的金钱权限边界。
- **工程推导**：`IntentEnvelope → capability selection → V4 action plan → tools/receipts → reply` 是
  开发者提出的架构，不是 doctrine 原文，也不声称已有实验证明。
- **业务不变量**：用户目标、当前请求动作、限制条件和完成标准不能混成一个标签；能力是否可用由
  必要事实、权限、工具、历史可靠性和可验证收据决定，不靠模型自报信心。
- **承载层**：第一步只建立可追溯的离线 registry、意图契约、三张人工样例和报告；不改 prompt、
  不让模型自动填、不接工具执行。
- **停止条件**：模块只是话题文件、工具存在就冒充能力可靠、跨模块规则大量复制、意图字段比原话
  更难理解、或样例必须靠特例才能通过时，停止扩张并报告。

## V0 能力模块边界

首批最多 7 个，优先从当前真实工具链归纳“动词 + 可验收结果”，例如（名称可独立改进）：

1. 发送一条定向消息；
2. 联系参与者收集一个约束；
3. 生成排班草案；
4. 向受影响者分发排班草案；
5. 分发共同规则提议并收集立场；
6. 开启冲突跟进并进入等待状态；
7. 无既有依据时决定新费用分摊——应明确为当前 blocked/unsupported，而不是假装可执行。

每个模块至少说明：稳定 id、可验收结果、当前成熟度（建议 `available | partial | blocked`，可调整）、
必要输入、允许使用的**实际工具名**、成功收据、主要停止条件、Doctrine/source 引用、相关领域
playbook。不要因为 `turn.ts` 有某个工具就把整条多步能力标成 available；历史有漏动作证据的链应
如实标 partial。

隐私、事实来源、决定权、公平、完成收据等放进单独的 cross-cutting policies 索引；专项 guest、
noise、cleanliness、money、scheduling 放 playbook 索引。二者都不能冒充可执行能力模块。

## V0 用户意图契约

设计一个很小的多意图结构，核心业务字段不超过 6 个。它至少能逐个意图表达：

- 用户想达到的结果（自然语言短句，不强迫穷举）；
- 当前请求的动作；
- 作用对象；
- 授权依据的原话片段；
- 明确限制（如先给我看、暂不发送、隐藏来源）；
- 用户认为怎样算完成。

原话证据必须能在 `rawMessage` 中逐字找到；这是来源校验，不是用关键词猜意图。一个消息可有多个
意图项，每项选择一个 registry capability。blocked capability 不得被标为可执行；partial 不能被
报告包装成稳定可用。意图结构只表达用户侧目标/授权/限制，不复制 V4 的执行状态和依赖。

## 三张人工期望映射与报告

建立三张**开发者草案**，报告明确“非模型生成、非老板核准”：

1. 简单提醒：一个意图、一个 available 能力；证明简单情况很轻。
2. “先问小王哪天方便，把表排出来先给我看，我定了再发”：至少拆出取数、草案、发布三个意图；
   `preview_before_publish` 只约束发布，不阻止已获准的取数。
3. 024：访客规则协调映射到 partial 共同规则能力；无既有依据的新费用分摊映射到 blocked；报告
   显示需要用户确认是否接受缩窄范围，不能把整条消息判成一个 red，也不能开始被阻塞的费用动作。

报告应并排显示：原话、意图证据、选择的能力、成熟度、允许工具、完成收据、边界原因、相关
Doctrine/playbook。不要显示隐藏思维链，不加载远程资源，完全离线。

## 免费确定性检查

至少覆盖：

- registry id 唯一；模块数不超过 7；工具名确实存在于当前生产工具定义；
- available/partial/blocked 的字段一致性；blocked 无允许执行工具和成功执行收据；
- cross-cutting policy 与 playbook 不混入 capability registry；
- 意图证据是原文子串；每项选中的 capability 存在；
- 同消息多意图合法；限制只作用于关联意图，不跨意图连坐；
- blocked capability 不能被标记为可执行；partial 在报告中不能显示为“稳定可用”；
- 三张样例与一个负例；简单提醒保持少量字段；
- CLI/报告完全离线，不 import 生产 turn/repo、不调用模型/网关/工具。

不要用正则或关键词声称已经验证“意图理解正确”；这里只验证开发者手写映射和结构一致性。

## 文件与边界

可新增独立 eval 模块、sample、CLI/package script、HTML/JSON；优先复用现有 V4 类型，但不要让
V4 执行状态泄漏进 intent。更新：

- `.claude/INTENT_CAPABILITY_ARCHITECTURE_V0.md`（完整地图与设计结论）；
- `.claude/DOCTRINE_DEVELOPMENT_MAP.md` 使用卡 6；
- `.claude/BRAIN_IMPROVEMENT_ROADMAP.md`；
- `.claude/PROJECT_STATE.md`、`.claude/AGENT_LOG.md`。

不修改生产 doctrine、critic、`runColivingTurn`、工具、DB、依赖或环境配置；不调用任何模型；不发
消息；不碰 `public/sw.js`；不 commit/push。

完成后运行：

- 新 CLI 生成三张报告；
- `pnpm.cmd coliving:quality`；
- `pnpm.cmd exec tsc --noEmit`；
- `git diff --check`。

最终报告独立审查、实际文件、能力模块清单、三张报告、测试结果和仍未验证部分。

## Codex 第一轮独立审查反馈（必须修复）

只修改本轮 V5 源码、测试和报告生成器，不修改 `.claude` 文档、生产文件或
`public/sw.js`：

1. `draft-schedule` 不能标 `available`。生产 `turn.ts` 多处真实事故注释明确记录模型漏
   `pickSchedule` / `chooseSchedule`、心算或链路耗尽；这是两工具链。改为 `partial`，并把
   依据、标签和注释说准确，不得再写“历史无漏步骤证据”。
2. `available` 的定义与报告当前写成 `stable` / “稳定可用”，超出了本轮离线证据。可以保留
   三态 id，但 `available` 只表示该能力具备当前已实现的确定性执行构件与可核验回执，不表示
   模型路由、编排或线上效果稳定。修改定义、`MATURITY_STABILITY`、标签、报告页尾及相关措辞。
3. `send-targeted-message.allowedTools` 只保留 `contactPerson`。`sendReply` 是回复当前发信人，
   不是向指定第三方定向联系，也没有对应当前 success receipt。
4. `validateIntentSample` 还必须机械拦住：
   - `authorizationEvidence === null` 却 `executable: true`；
   - 存在 `preview_before_publish` 或 `hold_before_send` 却 `executable: true`。
   增加明确违规码和真正的负例断言。`conceal_source` 不是自动禁止，不得一刀切。
5. 质量检查中原先断言 `draft-schedule` 为 available 的地方同步改成 partial。简单提醒仍可保持
   available，但说明只是单动作执行构件具备，不代表端到端模型稳定。
6. 报告不得再总括“当前能可靠做到什么”；明确成熟度是开发者基于已有实现与事故记录形成的草案，
   离线检查只证明结构一致性。
7. 运行 `pnpm.cmd coliving:quality`、`pnpm.cmd coliving:intent-capability`、
   `pnpm.cmd exec tsc --noEmit`、`git diff --check`；不调用模型或网络，不 commit。
