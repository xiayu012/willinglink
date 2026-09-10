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
