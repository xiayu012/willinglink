/**
 * 合租房大脑用哪个模型。**只管这一个大脑，不影响项目里任何别的 AI。**
 *
 * 各条链路的模型互相独立，别在这里"顺手统一"：
 *   · 租房搜索      `lib/ai/models.ts` 的 DEFAULT_CHAT_MODEL
 *   · 小红书私信    `lib/chat/xhs-dm.ts` 的 XHS_DM_MODEL
 *   · 合租房管理员  这里
 *
 * 默认 `deepseek/deepseek-v4.1-flash`（老板 2026-09-11 拍板：**全链路统一到
 * V4.1 Flash、不上 opus**）。在此之前默认是 `deepseek/deepseek-v4-flash`
 * （2026-09-07 拍板，见 AGENT_LOG 2026-08-30 的成本与安全探针记录），
 * 现在生成、审稿、修正、语义判定四条文本链路全部换到 V4.1。
 * 它在多轮冲突协调上的不可靠（跨轮忘偏好 / 编时段 / 慢到撞 gateway 超时）仍由
 * **确定性代码**兜底：软偏好注入、自动补发漏人、6.x 打回重算、简单肯定短路等，
 * 不靠换贵模型硬扛。
 *
 * 想临时换更强模型验一把：设 `COLIVING_MODEL=anthropic/claude-sonnet-4.6`。
 * 同在 gateway 上、值得一试的还有 `deepseek/deepseek-v4-pro`、
 * `minimax/minimax-m3`、`zai/glm-5.3`。
 * **注意 `zai/glm-5.3-flash` 试过，不行**——它反问问题、一个工具都不调。
 */
export const COLIVING_DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";

export function colivingModelId(): string {
  return process.env.COLIVING_MODEL?.trim() || COLIVING_DEFAULT_MODEL;
}

/**
 * relay「回给发信人的最终聚焦修正」这一条窄路径升级到的强模型。
 *
 * 背景（第六轮 relay 人工复核 029）：relay 回信的初稿先过 critic，被打回后
 * 用默认模型重写；重写稿再被 critic 打回时，只剩最后一次聚焦修正机会。实测默认
 * 模型这时只会复述内容、改不动，最终仍被拦——门禁判断是对的，缺的是最后这次
 * 生成的能力。**只把这最后一次生成升级到强模型**，用一次贵调用换一次真正改对
 * 的机会；其余生成路径（首稿、第一次重写、出站、非 relay）保持默认生成模型。
 *
 * 2026-09-11 老板决定把文本链路统一到 V4.1 Flash，所以这个常量当前跟
 * `COLIVING_DEFAULT_MODEL` 是同一个 slug；但**保留独立的选型常量与升级分支**，
 * 以后要重新拉开强/弱差价时只改这里，不用动调用点结构。
 */
export const RELAY_FINAL_FIX_MODEL = "deepseek/deepseek-v4.1-flash";

/**
 * relay 回复重写路径该用哪个模型。
 *
 * **只有 relay 的最终聚焦修正（`stage: "finalFix"`）升级**；第一次重写
 * （`stage: "redo"`）、非 relay、以及所有别的生成路径一律用 `defaultModelId`。
 * 走到 `finalFix` 的前提是**初稿已被 critic 打回、便宜模型重写后仍被打回**，
 * 所以这个升级天然只落在"两次打回后的最后修正"上，不会放宽到首稿或首次重写。
 *
 * 抽成纯函数是为了可离线测试：给定 (relayActive, stage) 就能证明"只有窄路径
 * 升级"，不需要真的调模型或跑 relay 场景（见 `scripts/coliving-quality-inspect.ts`）。
 */
export function relayRewriteModelId(args: {
  relayActive: boolean;
  /** "redo" = 初稿被打回后的第一次重写；"finalFix" = 重写也被打回后的最后一次聚焦修正 */
  stage: "redo" | "finalFix";
  /** 未升级时要用的默认生产生成模型 */
  defaultModelId: string;
}): string {
  return args.relayActive && args.stage === "finalFix"
    ? RELAY_FINAL_FIX_MODEL
    : args.defaultModelId;
}

/**
 * relay 的**选择性强审稿**：这一轮该不该用强模型复核。
 *
 * 单纯首次的一对一提醒用默认便宜 critic 就够；只有结构事实表明这不是
 * "第一次简单交办"时才升级，避免把每次 relay 都变成一整批贵模型调用：
 *  - 本轮实际或尝试联系了**多个收件人**（越权通知、群发的风险更高）；
 *  - 或**这套房在本轮开始前已有「介绍之外」的实质出站往来**——同一段连续
 *    关系，容易累积旧账、泄露历史、把没定的事说成定了。
 *
 * **房屋级而不是收件人级**：模型漏调 `contactPerson` 时本轮 outbound 为空，
 * 从"本轮收件人"推不出任何东西；只有房屋级信号还能认出这是连续关系
 * （2026-09-11 corpus-031 第 6 轮：没联系却回"已经跟他说了"，强审稿恰好失效）。
 *
 * **只看结构事实**（出站记录、收件人集合），不猜语义：不看"单独/私下"
 * 这类中文措辞，也不看食品名或人名。非 relay 一律 false，普通对话不受影响。
 *
 * 抽成纯函数是为了可离线测试：给定几个结构事实就能证明"首次简单提醒不升级、
 * 连续关系/多收件人才升级"，不需要真的调模型或跑场景（见
 * `scripts/coliving-quality-inspect.ts`）。
 */
export function relayReviewNeedsStrong(args: {
  relayActive: boolean;
  /** 本轮实际或尝试联系的不同收件人数（含被审稿拦下的越权尝试）。 */
  recipientCount: number;
  /**
   * 本轮开始前，这套房是否已有「介绍之外」的实质出站往来。判断依据：
   * 每个新成员的第一次出站是介绍，所以**任一收件人**出站 ≥2 条，就说明
   * 至少有过一次介绍之外的实质传话。取全屋、不绑定本轮收件人。
   */
  houseHasPriorSubstantiveOutbound: boolean;
}): boolean {
  if (!args.relayActive) return false;
  return args.recipientCount > 1 || args.houseHasPriorSubstantiveOutbound;
}

/**
 * 影子跑（`lib/chat/coliving/shadow.ts`）候选版本要不要换一个模型跑，
 * 从而做真正的 A/B。不设就返回 `null`，调用方应当退回跟生产同一个模型——
 * 那种情况下影子跑提供的是"候选路径端到端可用性 + 语料沉淀"，**不提供
 * 模型差异对比**，这一点由调用方如实记录，不要假装是 A/B。
 *
 * `runColivingTurn` 早就支持 `modelId` 参数覆盖（原本是给测试用的），
 * 这里只是把它接到影子跑上。
 */
export function shadowCandidateModelId(): string | null {
  return process.env.COLIVING_SHADOW_MODEL?.trim() || null;
}
