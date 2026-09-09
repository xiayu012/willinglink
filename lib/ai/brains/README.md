# 大脑（brains）模块

多个 AI 产品共用一套「准则组装」机制，各自的准则内容互相隔离。

**一个大脑 = 常驻准则（每轮必带）+ 情境模块（按需加载）+ 路由规则。**

---

## 为什么这样设计

**为什么不用向量检索**：情境模块只有个位数，类别边界清晰。
规则命中率高于 embedding 相似度，而且**可解释、可测试、出错时知道原因**——
`pnpm brain:inspect` 会打印每个模块为什么被加载。
等模块涨到几十份、或需要检索各州法规这类长尾，再引入检索。

**为什么准则用 .md 不是 .ts**：这些准则会被频繁编辑。
改行为 = 改一个 markdown 文件，不用重训、不用改代码——这是本设计的主要优势。
代价是需要 `next.config.ts` 的 `outputFileTracingIncludes`（已配好）。

**为什么常驻放最前**：便于上游做 prompt caching，前缀稳定才能命中缓存。

**为什么常驻是数组而不是一份文件**：`always` 按顺序拼，**顺序即优先级**——
前面是目标与仲裁条款，后面是手法，正文里写明冲突时以前者为准。
起因是一次真实事故：目标（别让住户费脑子）和手法（按周轮换）混在同一份
1.6 万字文件里，没有任何东西说明谁压谁，模型按"具体压抽象"挑了错的那条。
**准则变长时，缺的往往不是内容而是仲裁。** 详见 AGENT_LOG 2026-08-30。

## 目录

```
lib/ai/brains/
  types.ts       Brain / DoctrineModule / RouteRule / SignalCondition 类型
  registry.ts    大脑注册表
  router.ts      路由引擎（match 文本 + when 信号，force / exclusive / 上限）
  loader.ts      doctrine 读取与缓存
  assemble.ts    组装 system prompt
  index.ts       对外入口 + 注册
  coliving/
    index.ts     合租房大脑：模块清单（带 layer）+ 路由规则
    doctrine/    准则正文（按层分目录，编辑这里就能改行为）
      always/              常驻层，每轮必带，数组顺序即同一层内优先级
        identity.md        [identity]  你是谁、能力面、住户处境、真实价值
        constitution.md    [invariant] 宪法十四条，新情况从这里推
        arbitration.md     [domain]    三道闸、协调员定位、立场、禁区（常驻，见下）
        craft.md           [communication] 手法：格式、措辞
      domain/              domain 层：情境仲裁模块
        conflict.md        室友冲突调解
        complaint-risk.md  主动询问 / 投诉受理 / 风险升级
        tenancy.md         入住 / 规则 / 退租
      special-cases/       special-case 层：单点例外（后续细模块也放这层）
        money.md           金钱边界
        shared-resources.md 共用设施与资源争抢
      tool/                tool 层：工具使用规则
        records.md         记录 / 转交 / 拒绝不当指令
      rubric/              rubric 层：审稿清单（仅批判器读，不进任何一次生成）
        rubric.md          审稿清单
```

每个模块有一个 `layer` 字段，分层的**默认优先级**（在同一脑内按模块实际声明顺序拼，
但 layer 给出跨脑一致的语义尺度）：

```
identity → invariant → domain → communication → memory → tool → special-case → rubric
```

`arbitration.md` 声明为 `layer: "domain"`，但它必须常驻——三道闸/禁区/决定权是
每条消息的门槛，不能赌路由命中，所以放在 `always/`。

## 用法

```ts
import { assembleSystemPrompt } from "@/lib/ai/brains";

const { system, loadedModuleIds } = assembleSystemPrompt({
  brainId: "coliving",
  routeOn: userMessage,
  runtimeContext: houseAndResidentState, // 可选，状态库落地后接这里
});
```

**只能在服务端调用**（doctrine 走 fs 读取）。

## 路由规则：命中来源 × 命中后的行为

一条规则命中 = **文本命中 且 信号命中**：

- **文本命中**：`rule.match` 为空 或 任一正则命中本轮 `text`。
- **信号命中**：`rule.when` 为空 或 任一条件满足（`equals` 给定时比较
  `signals[key] === equals`，否则按 truthy 判断）。

一条 RouteRule 可以只用文本（`match`）、只用信号（`when`），或两者都要。

| 命中后的行为 | 语义 | 用于 |
|---|---|---|
| 普通 | 命中即加入候选，受 `maxSituational` 上限（默认 2）约束 | 常规情境 |
| `force: true` | 无条件加载，**不占额度** | 安全信号、以及结构信号——漏加载的代价远高于多占上下文 |
| `exclusive: true` | 命中即只加载本规则模块，短路其余普通规则（force 仍叠加） | 简单事实询问，避免为「垃圾周几倒」拉进整份调解准则 |

**什么时候用信号（`when`），不用文本（`match`）**：关键词永远有漏网——真实
投诉说的是"做饭""挨饿""不公平"，不是"厨房""室友""吵"。凡调用方能以结构化
方式拿到信号（名册里提到别的住户、存在未结冲突的 case），就比词表可靠。
调用方算好信号后经 `assembleSystemPrompt({ signals })` 传入，路由引擎在
`route(brain, text, signals)` 里把文本与信号放在同一层判断。**不给 `signals` 时，
`when` 非空的规则不命中**（等价于 `signals = {}`）——纯文本调用方（如
`brain:inspect`、cron）不受信号规则影响。

## 新增一个情境 / 特殊场景模块

1. 在对应层目录加 `.md`：常规调解场景放 `domain/`，金钱这类单点例外放
   `special-cases/`，工具使用规则放 `tool/`。资源争抢类模块放
   `special-cases/`，路由用行为/争抢关键词而不是裸设施名，避免报修误载。
2. 在 `coliving/index.ts` 的 `situational` 里注册：`id` / `title` / `file` /
   `layer` / `purpose`（一句话说明，供 `brain:inspect` 展示）。
3. 按需在 `routes` 加一条规则：文本关键词能用 `match`；有结构信号就用 `when`；
   两者都不少就都写。安全类记得 `force: true`。
4. 跑 `pnpm brain:inspect --probes`，确认命中的模块与理由符合预期。

**工具 schema（第 7 层）不在 doctrine 里**：`doctrine` 只放"工具使用规则"
（记录、转交、拒绝不当指令该怎么做），工具本身的 schema 仍在
`lib/chat/coliving/turn.ts` 的 `tool({...})` 里按需摘取。

## 检查工具

```bash
pnpm brain:inspect                    # 跑路由探针（13 条文本 + 2 条信号）
pnpm brain:inspect "房租要晚几天"       # 看单句命中哪些模块、为什么
pnpm brain:inspect --full "..."       # additionally 打印完整 system prompt
pnpm brain:inspect --brains           # 列出已注册的大脑
```

**改了路由规则或准则文件，跑一次 `pnpm brain:inspect`。**
路由错误不会报错，只会悄悄加载错模块。

## 新增一个大脑

1. 建 `lib/ai/brains/<id>/doctrine/`，放常驻 .md（可多份，顺序即优先级）和若干情境 .md
2. 建 `lib/ai/brains/<id>/index.ts`，导出 `Brain`（清单 + 路由规则）
3. 在 `index.ts` 里 `registerBrain(...)`
4. 在 `scripts/brain-inspect.ts` 里加探针

## 与现有租房搜索 prompt 的关系

**目前没有迁移 `lib/ai/prompts.ts`。** 那是搜索链路的核心，
`.claude/AGENT_LOG.md` 里记着大量踩过的坑，动它风险高、收益低。

将来若要迁移，路径是：把 `regularPrompt` 拆成常驻层 +
按工具/意图切分的情境模块，路由按「搜房 / 通勤 / 求租帖 / 闲聊」分。
迁移前先跑 `pnpm search-eval` 建立基线。

## 运行时状态与工具（合租房大脑已接）

**运行时状态**由调用方拼进 `runtimeContext`。合租房那边是
`lib/chat/coliving/context.ts` 从 `coliving` schema 的世界模型取——
默认只给核心状态（住的是谁、现行规则、没了结的事），
历史与判例让模型自己调工具查。**这一层缺了，准则只能给通用建议。**

**工具**在 `lib/chat/coliving/turn.ts`：判断、记录、联系他人、定共同规则、
查历史、找相似判例、查周边环境。缺了工具，这套东西只是聊天机器人。

**注意 prompt cache 的断点**：`assembleSystemPrompt` 返回的 `doctrine`
每轮逐字相同（可缓存），`runtime` 每轮都变（不可缓存）。
调用方要把它们作为两条 system message 传，只给 `doctrine` 那条打 cacheControl。
整段一起缓存 = 运行时状态一变就全部落空，等于没开。
带工具时**一轮不止一次模型调用**（每个工具一次往返，每次重发整个提示词），
所以这个缓存是本模块最大的一笔省钱。
