# AI 工程成本审查与长期执行队列

审查日期：2026-09-11（本地）；代码基线：`9a65fe5`。状态：**调查与派单已完成，下面的工程修复尚未实现**。
用途：后续 5.6/Codex 恢复工作时直接使用，不依赖本轮聊天。本文不进入生产提示词，不另造任务能力或业务 SOP。

## 给老板的结论

贵不能简单归因于 Vercel 或某个模型。当前有两类问题：每次推理内部的重复输入，以及开发过程中生成、审核、修正、重测的放大。缓存主要改善前者；减少无效修正与复用已有测试证据主要改善后者。

项目不是没有缓存、没有记账、没有重审工具。真正的问题是已有能力没有贯穿完整调用链，部分规格还互相矛盾。先补可观测性和低成本验证路径，再决定优化哪里；不重建一套框架，不默认换模型。

## 审查边界

- 已核对合租入口涉及的模型选择、doctrine 装配、turn 主生成与补救、critic、judge、评测 runner、费用台账、embedding、coordination 意图解析，以及本机安装的 SDK 实现相关片段。
- 已读取上一轮八份本地费用报告，复阅最后七轮可见对白；没有查询 Vercel 账户账单、生产环境变量或真实住户数据。文中的默认模型指仓库默认，不等于已核实线上环境覆盖值。
- 本轮没有付费推理、Claude API 调用、数据库写入或真实短信。只做文档交接。
- 不是全仓安全审计，也不是完整产品能力认证。文件行号以基线为准，改动后按函数名定位。

## 当前实际架构：沿调用链看费用

```text
合租短信入口 / 隔离 coliving-eval
  → runColivingTurn
      → 数据库上下文、历史 + 路由选 doctrine / activeTools
      → generateText 主生成（最多 6 个 SDK step）
          → 工具执行（部分工具还调用 embedding）
      → 按需补交回复 / 补联系
      → 出站 critic → 回复 critic
      → 按失败原因 redo / fact-retry / finalFix + 再审
  → 生产通道处理发送；eval 仅模拟发送状态
  → eval 可额外运行整场 semantic judge

getLanguageModel → Vercel Gateway
trackedGatewayCall → 目前只在 eval 上下文计账，包住一次 generateText
```

一次工具调用不一定等于一次模型请求：一个 SDK step 可产生多个工具调用；一个 generateText 又可包含多个 step，step 内还有传输重试。不能拿任何一层的计数冒充另一层。

## 已核实发现

### F1：已有费用台账，但“调用硬上限”不是 HTTP 请求硬上限

证据：`lib/chat/coliving/gateway-ledger.ts` 的 `trackedGatewayCall / BatchBudget.beforeCall / gatewayCostFromResult`；`turn.ts:3429`。

台账在整个 generateText 前计一次，结束后累加所有 steps 的 Gateway cost。**成功调用的多步费用已有累加，不要误报为只记最后一步。** 但 `maxModelCalls` 限的是包装器次数，不拦内部下一步与重试。金额在包装器返回后才更新；并发和长调用的超支不保证只是“小幅”。

本机 SDK：`ai@6.0.0-beta.159`、`@ai-sdk/gateway@2.0.0-beta.85`（package.json）。`node_modules/ai/dist/index.js` 的 `prepareRetries` 默认 2 次重试，generateText 在每步调用 retry；有 prepareStep/onStepFinish。错误分支只记 unknown，可能丢失同一包装器内此前已完成步骤的已知费用。

预算只跨同一个 CLI 批次共享。两个独立 CLI 进程不会共享“这轮用户对话约 $4”的预算。默认不传上限仍是不设限。旧报告 unknown=0 仅说明**已纳管包装器返回的 cost 完整**，不能证明整个账户所有费用都纳管。

### F2：缓存读数已有代码，但报告与全链路覆盖断开

证据：`turn.ts:900 sumUsage` 读取 input/cache read/cache write/output/cost；`turn.ts:4934` 只传主生成的 `result.steps`；`scripts/coliving-eval.ts:425` 构造 transcript 时未保存 usage；台账 bucket 只有调用数/金额/unknown。

因此不能说“从来没有 usage”，也不能用 TurnOutcome.usage 当整个任务费用。critic、补救、judge 的 token/cache/耗时明细没有统一落账，现有最后报告无法回答缓存实际省了多少。

`embedding.ts` 的 embed/embedMany 不进该台账，`turn.ts` 的 remember/检索工具可调用 embedOne。coordination/llm.ts 也有独立 generateText，但要先验证其对目标入口的可达性，不能把全仓调用都算进这七轮。outreach 是另一入口，不能为了凑统一而扩大首批改动。

### F3：缓存并非没开；稳定“文件”不等于稳定“请求前缀”

证据：`assemble.ts` 分离 doctrine/runtime；`turn.ts:1234` 的系统消息、`critic.ts:334/593`、`evals/judge.ts:641` 已有 Anthropic ephemeral 标记。

assemble 将常驻和按路由变化的情境模块拼成一个 doctrine 字符串；其“每轮逐字相同”的注释不普遍成立。主生成、forced-sendReply、redo 等还会使用不同工具集。缓存受序列化前缀、模型/上游、寿命、最小长度影响，不能只查是否出现 cacheControl。

不要为命中缓存把全部工具常驻，也不要为了凑最小长度塞无用文字。先采集 moduleIds、工具集指纹、稳定前缀长度与实际 cache read/write，再判断现有手动断点是否需调整。短审稿视图是否达到所用平台门槛，本轮未实测。

### F4：已有历史文本重审入口，不应重造

证据：`scripts/coliving-quality-inspect.ts:4631` 的 `--report` 已能读取旧报告并调用 judge，明确标为历史重审；`coliving-snapshot` 也已有世界状态恢复，但它重新调用生产大脑，不是免费重评。

缺口：历史重审路径没有建立共享费用台账/预算，去身份后 roster 为空，可能损失判断依据；不能直接当成与原场景等价的完整验收。未发现 coliving-eval 的通用“只对冻结输出重跑结构断言”入口。

建议复用现有断言函数和重审入口，补齐来源与预算，不造第二套 runner。改断言/展示不等于必须把七轮大脑重新生成；改生产 prompt 则不能拿旧输出当新版效果。

### F5：贵模型路径在成熟房屋里可能不再是窄例外

证据：`model.ts relayReviewNeedsStrong`，`turn.ts:3737–3757`。只要近期全屋任一收件人已有两条出站，relay 审稿就升级，不要求本次对象或议题相关。

这是实际条件，不是“只有难题才升级”。成熟房屋普通提醒也可能长期触发强审稿；实际流量占比未知。先记升级原因与占比，再做限定实验；不要直接删除，它原本针对漏联系却声称完成等真实事故。

### F6：提示词内冲突是质量问题，也可能增加重写成本

证据：`domain/relay.md` 第二节的合格例写“别再动我的了”；第三节的合格例写“我们几个想跟你聊聊”；第五节又禁止未标明来源的第一人称冒充。第六节禁止任何内容摘要，`critic.ts RELAY_SENDER_REVIEW_VIEW` 却允许简短点题。

最后报告仍有：T3 把“以后想调高先问”扩大为“以后想调温度先问”，还增加“没跟人说过”“大家都不舒服”；T7 未标归属的“我们几个”。这是可见语义偏差，不应因 judge 绿灯而忽略。旧报告保留，后续添加复审结论，不静默改写历史输出。

工程判断：先删除矛盾、校准示例和审稿共同前提，比继续加重复 must/never 更值得做。这里不声称已证明哪一句导致了哪一次失败；因果仍须定向验证。不要把第一人称全局禁用，AI 的“我已联系”、标明来源的引语都是正常反例。

### F7：没有显式输出 cap，但不能盲目设成几十 token

核对的 turn 六处生成、critic 两处、judge、coordination/llm 调用均未见 maxOutputTokens。超时限制不等于输出长度限制。

短 JSON 也可能需要推理 token、多条 findings 或足够的工具参数。先看真实分布及模型语义，再定各 stage 上限，覆盖截断、length finish、解析失败，防止“省了输出费，却多出重试费或误放行”。先不改生产全局默认。

### F8：审稿故障默认放行，不能当成成本优化细节顺手改

证据：`critic.ts UNVERIFIED_PASS` 是 verified=false/pass=true；异常返回它。`turn.ts critiqueAndMarkOutbound` 按 pass 判拦截，并未因高风险 unverified 单独阻断。`turn.ts:4811` 也明确保留最终仍不合格的可交付回信并标红。

这需要单独的产品可靠性修复：未审核不等于通过；但是也不能因为一句普通提醒超时，就让用户永远收不到回应。先用 mocked verdict 追踪可发送候选、回信、状态和恢复路径，再形成最小规格。不自动转交任何人，不借此设计全新升级 SOP，不实发验证。

### F9：断言通过不等于产品判断正确

`coliving-quality-inspect.ts` 同时有真实纯函数测试和大量 src.includes 文本哨兵；141 项不是 141 个真实人际场景。成本闸应以多步/重试/并发/中断的模拟行为测试为主，文本存在只能作辅助。

上一轮 Sonnet 主生成的一次昂贵失败不构成受控模型 A/B，也不足以得出“Sonnet 无收益/永远不适合”的结论。能确认的是那次开支和输出，不应将其冻结成选型事实。

## 实际金额证据：不是模型价格估算

读取 `tests/coliving-eval/reports/` 下以下八份 JSON 的 cost：

| UTC 报告时间（2026-09-12） | 已知 Gateway 美元 |
|---|---:|
| 01-04-00-306Z | 0.272356784 |
| 01-20-41-120Z | 1.053187838 |
| 01-35-46-842Z | 0.594326202 |
| 01-46-21-797Z | 0.472038274 |
| 01-53-10-291Z | 0.350143501 |
| 02-03-48-944Z | 1.036324867 |
| 02-12-29-616Z | 0.245028009 |
| 02-21-25-354Z | 0.314896416 |
| 合计 | **4.338301891** |

最后一份七轮：主生成 $0.060003，critic $0.064004，forced-sendReply $0.014299，redo $0.013317，finalFix $0.087290，judge $0.075983。最后一次 finalFix 比七轮主生成合计还贵；这是本样本，不是全产品平均。

最后一份报告的 32 次是包装器调用（7 main、16 critic、5 forced-sendReply、2 redo、1 finalFix、1 judge），不是 Vercel HTTP 请求数。报告未保留完整 step/cache 明细，无法据此计算真实缓存命中率或无缓存反事实费用。八次运行也不是完全相同的重复：中间改过实现，不能把前七次都称为浪费。

## 官方资料与缓存科普

- [Vercel Automatic Caching](https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching)：手动 marker 与 gateway auto 是可选方式；DeepSeek 支持隐式缓存。写了 auto 不保证实际命中。该页提示一次性请求也有缓存写入的成本权衡。
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)：前缀重用不是答案重用，仍要发送请求内容，也仍计入上下文；需要满足寿命、长度等条件。Sonnet 4.5/4.6 当前表价每百万 token：普通输入 $3、5 分钟缓存写 $3.75、读 $0.30、输出 $15。价格和门槛实施前重查。
- [Gateway 模型目录](https://ai-gateway.vercel.sh/v1/models)：本次查询 DeepSeek v4-flash 每百万 token 输入 $0.13、输出 $0.26、缓存读 $0.028，并注明可随上游变化。这个不是实际账单价格保证。
- [AI SDK generateText 参考](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)：网页本轮读取失败；hook/重试行为以本机安装包源码核对，不能照最新版类型直接改旧 beta 项目。
- [Gateway Generation Lookup](https://vercel.com/docs/ai-gateway/observability-and-spend/usage) 与 [Custom Reporting](https://vercel.com/docs/ai-gateway/observability-and-spend/custom-reporting)：可作为后续补账/对账依据，先确认可用 ID、权限、字段。本轮未调用账户接口。

AI Gateway 技能用于导航；其中“无程序化 metrics API”等描述与当前官方文档不一致，不能照抄。也不依据技能中的 response-cache 示例给住户短信缓存旧答案。

## 给后续 5.6 的执行任务

以下是基于本次代码审查的**工程提案**，不是 doctrine 原文，也不是行业规定。顺序可随证据调整；一次只派一个有边界的任务给 Claude Code。默认先 A，下一轮 B；安全发现 F8 可以独立提前。

### A · 补齐计费单位和证据（优先，尚未实现）

- 范围：现有 gateway-ledger、评测报告与相关调用边界；不要新建通用 agent 框架，不先改 prompt/路由。
- 在现有台账上区分 generation/step/可观测的 transport attempt；Gateway 内部重试若不可观测就标未知，不伪称全部 HTTP 已计数。
- 保存 runId/scenario/turn/stage/model、可取得的上游与 generation ID、usage 的非缓存输入/读/写/输出/推理、耗时、finishReason、实际或估算金额及依据。缺字段用 null/unknown，不能当零；不保存密钥或为记账复制真人正文。
- step 完成即保留费用；异常时保留之前完成步骤，避免 afterCall 再累计造成双计。覆盖嵌套 critic，不把子调用费用重复算进父调用。
- 先覆盖当前评测可达链（含 embedding），其它入口列覆盖表，不宣称全项目纳管。生产无 ledger 上下文时不改变行为。
- 免费验收：单步、多步、嵌套、缺 cost、部分成功后失败、零成本、并发，逐项核对总和及未知项；旧报告能读；不调用模型。
- 交付：真实运行的 mocked 测试证据、完整 diff、覆盖/未覆盖表。不是再增加几个源码关键词检查。

### B · 一轮开发共享预算 + 显式评测范围（A 后，尚未实现）

- 同一开发 runId 跨 CLI 续用费用记录，默认目标约 $4，不是每个命令各 $4。最小本地持久方案即可；并发需原子预留，进程中断可恢复。
- 在可控制的每个模型 step 前检查，已知费用+在途保守预留；有未知开支时不能继续当零放行。预留是估算，不把它报为精确硬美元上限；重试策略明确，计数与真实控制层一致。
- 默认开发入口先免费检查；付费入口显式选择场景及有限预算。Full 必须显式选，保留用户要求的全量能力，但不变成每天/每提交默认仪式。
- 不固定“10–30 条才算 Fast”：以受影响任务与预算选样本。改价/模型只记录版本，不擅自替换生产模型。
- 免费验收：两个独立进程同一 runId、并发争额度、跨 stage、预算中止仍产报告、缺价格/未知 cost、无参数不会启动全量付费；测试全用 stub。

### C · 复用旧输出重评（可与 B 换序，尚未实现）

- 复用 quality --report 的历史重审与 eval 现有断言函数；补免费 structural-only 重评，按需 judge-only 必须走 A/B 台账与预算。
- 保留原报告不覆盖；新报告记录源文件 hash、原生成 commit/模型（缺失标 unknown）、当前 evaluator 版本、场景/规格版本、新增花费。
- 历史输出评新断言只证明旧输出符合新断言，不证明新版大脑已经改善。上下文不足的断言/judge 标不可评，不能靠恢复出的猜测补全。
- 区分纯文本历史重评和现有 snapshot 世界状态重演；后者会调用大脑并写隔离测试屋，不是免费操作。
- 免费验收：旧报告无需网络即可结构重评；只改 HTML 不调模型；judge stub 只调用 judge；场景变化/缺状态有明确标记；原报告 hash 不变。

### D · 清理 relay 共同前提（可提前离线审规格，尚未实现）

- 业务依据：`domain/relay.md` 第二/五节、`always/identity.md` 的身份边界、`always/craft.md` 的必要理由与结果；老板强调“自然、合理、不揽未掌握的事”。不是省钱优先于人际效果。
- Claude 先指出 F6 中相互冲突的示例/规则，再最小修正；自然表达留给 LLM，不新增全局禁词/一律实名/每轮必须发送等规则。
- 把生成、critic、judge 的共同业务定义维护在明确来源，允许角色视图不同，不要求共用同一整段 prompt；独立审查不能只重复作者假设。
- 验收同时包含正常引语、AI 自己第一人称、无主语中性提醒、简短完成回执、讨论未授权、仅限制“调高”而非所有调温。对照原始需求和完整可见对白，不改输入讨好断言。
- 先免费校准、再最多一小组定向模型验证；相同错误修两轮仍复现，就留失败证据复查前提，不连续措辞试运气直到抽到绿。次数是当前工作节奏提案，可有新证据时调整，不是生产上限。

### E · 按数据优化缓存、输出与强模型触发（A 有证据后，尚未实现）

- 每次只验证一个假设：缓存前缀/断点，或某 stage 的输出 cap，或 F5 强审稿条件；不要一起动导致无法归因。
- 缓存先看真实指纹和 read/write，再选择保留手动/微调断点/auto；不把 TTL 提高或 SDK 升级当无风险一行改动。验证不变的输入语义与工具能力。
- cap 覆盖正常最大结构、reasoning、length/truncation 与错误处理；受截断不能变成 pass，也不无限重试。
- 强审稿对照首次提醒、同对象连续冲突、另一对象无关旧消息、高风险；不拿房屋年龄当语义风险的永久替代品。先观测，不先下调。
- 模型探针共用约 $4/轮预算，只用虚构最小上下文；失败即记录，不为证明缓存反复刷 API。基线能复用则复用，变了前缀要明示不可直接对比。
- 通过条件：可解释的成本/延迟变化，固定对照集没有新增关键语义错误；不能只看缓存命中率或 cheaper price。

### S · 故障不冒充验收（独立安全任务，尚未实现）

- 只读追踪 F8，从 critic verdict 一直到出站候选、实际发送入口和 case 状态。先 mock 超时/解析错误/强审稿不通过，证明现有行为。
- 提交一份最小方案：高风险未验收的原草稿不直接当安全消息发送；用户仍得到如实、有限的反馈，不自动升级给任何人。普通提醒和紧急求助也要有正常反例，避免一刀切静默。
- 这是产品行为变更，必须 Claude 实现、Codex 独立验收；不掺进 A 的纯计量修改，不实发。

## 持续交接纪律（本轮建立）

- 此文完成不等于 A–S 完成。后续每项更新“未开始/进行中/已验收、commit、免费/付费证据、剩余风险”，入口只指向当前一项，历史任务不自动继续执行。
- 不要求每轮读完整历史日志。读项目必读文件后，只追加本任务必要代码与最近相关记录；使用短 Claude 会话，默认 sonnet/medium。实现/修复一律交 Claude，Codex 不能自行补实现。
- 每次付费前写下这次要验证的具体不确定性、能否免费回答、范围和预算余额。不是要求老板再授权，而是开发者自行控制成本。
- 不用“读完一篇博客”“141 绿灯”“五个黄金案例”代替能力证明。审稿也可能错，测试也可能共享错误前提。保留失败与反例，不以语料逐渐丰富为理由每次全量重跑。
- 暂不做：购买硬件、自托管、换网关、全仓框架重构、盲目压缩 doctrine、关掉关键审稿、为短信开启答案缓存。

## 当前接棒点

下一次老板说继续此成本工作线：先派 **A**，不重跑 corpus-031，不执行 V7 的历史 19 阶段，不重复搭“已有缓存/已有台账/已有历史重审”。发现本审查与新代码不符，改证据和计划，不硬按旧方案实施。
