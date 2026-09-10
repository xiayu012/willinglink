# Codex 对 Golden Trace A/B 第一版的退回意见

## 验收结果

- `pnpm.cmd coliving:quality`：71 项通过。
- `pnpm.cmd exec tsc --noEmit`：只有 `components/ai-elements/speech-input.tsx:55-56` 两条仓库既有 TS2717，没有本次新增错误。
- `git diff --check`：通过。
- 文件范围正确，未碰 DB、路由、依赖或 `public/sw.js`。

第一版不直接接受，请做以下收窄修改。

## 必须修改 1 · 当前事实放在最后

当前 system 顺序是 `doctrine → runtime → guidance`。成功轨迹会比当前房屋状态更靠近用户消息，可能让示例压过眼前事实。

改成：

```text
doctrine（缓存） → experimental guidance（有才放） → runtime（当前事实，最后）
```

不传 guidance 时必须仍然严格是原来的 `doctrine → runtime`。

优先考虑在本轮内构造一个共享的 generator system 数组，让六个生成路径复用；不要六处复制相同条件展开。critic 不使用这个数组。

## 必须修改 2 · Guidance 只展示成功行为

当前三条轨迹每条都含“不说：某某坏句子”，其中还逐字重复了老板刚否决的“我先记录成你的陈述”等表达。成功示例实验不应再次把坏话喂给生成器。

删除逐字坏例和“不说”列表。每条只保留：

- 内部状态（简短）；
- 正确决定/动作；
- 对住户说的最终句子。

总长度应比当前更短。可以保留顶部一句原则：内部状态不可写进回复、示范不是模板。

## 必须修改 3 · 降低检查复杂度

本次行为代码约 70–100 行，却在 `coliving-quality-inspect.ts` 新增了约 130 行源码字符串断言，比例过高，且大量依赖精确源码文本、文件里是否出现单词，容易因无关重构误报。

保留能证明核心安全边界的最小检查：

1. 已知 id 能解析、未知 id 抛错、空值等于不启用；
2. guidance 内容有三条正向轨迹、分开内部与外部、没有刚删除的坏句原文；
3. 生成 system 顺序为 doctrine → guidance（可选）→ runtime；无 guidance 时 doctrine → runtime；
4. 报告正常/异常结果都记录 guidance id。

如果为第 3 项提取一个小的纯函数能同时减少六处重复并可直接测试，可以这样做。不要用扫描四个生产文件里是否出现 `guidance` 单词来证明安全；生产调用方不传可选参数、默认数组形状测试已经足够。

## 不要做

- 不运行付费模型评测。
- 不改 doctrine 正文。
- 不扩大到现场卡或组合工具。
- 不 commit、不 push。

---

## Codex 第二轮审查：最后收口

第二版的顺序和正向示例已通过，免费闸 70 项通过，tsc 只有两条既有 TS2717。还需两处收口：

### A. 生产模块不能反向依赖 eval guidance

当前 `turn.ts` import `./evals/guidance` 只为使用 `buildGeneratorSystemMessages`。这会把实验提示正文带入生产模块依赖图，层次反了。

把纯 system 构造器放回 `turn.ts` 并 export（质量脚本本来已经从 turn.ts 导入多项纯函数），或放在非 eval 的极小通用模块；`evals/guidance.ts` 只保留实验登记和解析。优先少文件、少抽象。

验收：`turn.ts` 不得 import `evals/guidance`，生产默认仍为 doctrine → runtime，实验时 doctrine → guidance → runtime。

### B. 直接锁住老板批准的隐私问句

增加一条最小确定性检查：

```text
checkProcessNarration("这个柜子只有你们两个人用，他可能会猜到是你。还要发吗？") === null
```

同时保留原先对“我不会说是你”“他会猜到是你提的”这类无必要过程播报的拦截。不要为此新增词表或改生产正则；当前目标句本来就能通过，只把这个边界固定下来。

### C. 再压缩新增检查

删除“递归扫描整个 doctrine 目录是否出现实验 id”这类收益很低的检查；实验登记文件的位置和生产无反向 import 已足够证明分层。报告源码断言只留正常/异常两条返回都记录 id，不必逐句检查 CLI 实现文本。

目标是让本次新增质量检查明显低于当前约 139 行，避免一个小实验带来比实现本身更重的源码文本测试。

完成后重跑三条免费闸，不扩大其他范围。
# 2026-09-10 · 离线推断性隐私现场卡第一轮审查

## 结论

方向和边界正确，但暂不验收。必须由 Claude Code 修复下面的确定性状态漏洞，Codex 不自行补实现。

## 必改：反推风险与 `ownerConsent=not_needed` 的矛盾可绕过门禁

当前 `validatePrivacyCard` 只在 `possible/likely + unknown` 时要求 `ask_owner`。如果模型输出：

```text
inferenceRisk = likely
ownerConsent = not_needed
recommendedAction = safe_to_contact_minimized
```

校验会通过。可是 schema/system 自己已经定义 `not_needed` 只表示“没有反推风险、无需征求”；存在 `possible/likely` 时，这个组合在语义上不可能成立，也正好绕过核心隐私阻塞。

请增加明确的状态一致性校验和 violation code：

- `possible/likely` 时，`ownerConsent` 不能是 `not_needed`；
- `none` 时，`ownerConsent` 应为 `not_needed`，避免无风险却制造虚假的待同意状态；如果你认为这里有合法例外，请在实现中给出具体业务例子，否则按严格一致性处理；
- 为两条方向分别增加免费 red case；
- 保持 `possible/likely + unknown → ask_owner`、`declined → stop` 等原有检查。

修完后运行 `pnpm.cmd coliving:quality`、`pnpm.cmd exec tsc --noEmit`、`git diff --check`。不要运行模型级隐私卡，不 commit/push。

---
# 2026-09-10 · 隐私现场卡模型兼容性退回

## 实际失败

Codex 在免费闸通过后只运行了授权的目标场景：

```text
pnpm.cmd coliving:privacy-card -- --scenario corpus-025-cleaning-privacy-2026-09-09
```

项目默认 `deepseek/deepseek-v4-flash` 返回：

```text
生成失败： No object generated: response did not match schema.
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
exit code 3221226505
```

没有生成 JSON/HTML。没有调用生产 turn 或任何发送动作。

## 必改

1. 不要继续用当前 `generateObject + gateway.languageModel` 组合。对照仓库已稳定使用的 `lib/chat/coliving/evals/judge.ts`：改为 `generateText + Output.object({ schema, name, description })`，模型通过 `getLanguageModel(MODEL_ID)` 获取，并设 `temperature: 0` 与合理超时。
2. 仍然必须是 SDK 结构化输出，不能退回手写 JSON 解析。
3. 成功路径从 `result.output` 取卡片并跑现有确定性校验。
4. 模型无法生成结构化对象、超时或网关失败时，必须清楚报“未生成/未验证”，退出非零；不得写一张假的通过卡。若能安全地写失败报告且不把卡片字段伪造成已生成，可以做，但不是必需。
5. 更新免费结构检查，确认 CLI 使用 `Output.object` 和 `getLanguageModel`，不再直接 `gateway.languageModel`、不再 import/call `generateObject`。
6. 运行免费三闸；不要再次运行模型场景，由 Codex 修后定向复测。不要 commit/push。

---
# 2026-09-10 · 模型现场卡停止与收窄决定

两次授权的 `deepseek/deepseek-v4-flash` 定向运行都返回同一结构化输出失败，第二次已经使用 `generateText + Output.object + getLanguageModel`。按停止条件，不再修“模型生成卡”。

请读取 `.claude/CODEX_TASK.md` 顶部新任务，把当前未提交实现收窄成人工标准卡：标准卡进入场景、CLI 只读校验并生成 HTML，完全删除模型/网关依赖。不要在失败实现上继续打补丁，不要运行模型，不要 commit/push。

---
# 2026-09-10 · 人工标准卡 CLI 入口退回

Codex 实跑文档中的标准命令：

```text
pnpm.cmd coliving:privacy-card -- --scenario corpus-025-cleaning-privacy-2026-09-09
```

脚本收到字面量 `--`，当前 `unknownFlags` 把它判为未知参数，退出 2：

```text
不支持的参数：--。首版只支持 --scenario <id>
```

请只修这一处：参数检查必须忽略标准的参数分隔符 `--`，同时仍拒绝真正未知的 `--turn`/`--model` 等参数。增加免费回归测试，证明 `--` 不被判未知而 `--model` 会被判未知。不要改用法，不扩大范围，不运行模型，不 commit/push。修后跑免费三闸。

---
# 2026-09-10 · 人工标准隐私卡验收结论

Claude Code 按三轮退回完成实现：封住 `likely + not_needed` 状态绕过；停止不兼容的模型结构化生成；改成人工标准卡；修复 pnpm 字面量 `--` 入口。

Codex 独立验证：

- `pnpm.cmd coliving:quality`：80 项离线检查全过；
- `pnpm.cmd coliving:privacy-card -- --scenario corpus-025-cleaning-privacy-2026-09-09`：成功生成 JSON/HTML，`阿哲 → 大凯 / likely / unknown / ask_owner`，业务校验通过；
- `git diff --check`：通过；
- `pnpm.cmd exec tsc --noEmit`：仅有既有 `components/ai-elements/speech-input.tsx:55-56` 两处 TS2717，与本任务无关；
- 源码复核确认 CLI 不导入 AI SDK/provider/model/.env，不导入生产 turn/repo，不调用联系工具；HTML 对场景与卡片文本做转义并明确标注非模型生成。

本里程碑验收通过。它仍是评测基础设施，尚未接入生产动作阻塞。

---
