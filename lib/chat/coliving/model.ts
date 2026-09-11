/**
 * 合租房大脑用哪个模型。**只管这一个大脑，不影响项目里任何别的 AI。**
 *
 * 各条链路的模型互相独立，别在这里"顺手统一"：
 *   · 租房搜索      `lib/ai/models.ts` 的 DEFAULT_CHAT_MODEL
 *   · 小红书私信    `lib/chat/xhs-dm.ts` 的 XHS_DM_MODEL
 *   · 合租房管理员  这里
 *
 * 默认 `deepseek/deepseek-v4-flash`（老板 2026-09-07 拍板：**不上 opus、保持
 * 便宜**）。同一条真实投诉它 $0.004–0.011 一轮、sonnet-4.5 $0.127，便宜约 18 倍，
 * 三个安全探针（非法驱逐 / 自杀信号 / 住房公平陷阱）全过（见 AGENT_LOG 2026-08-30）。
 * 它在多轮冲突协调上的不可靠（跨轮忘偏好 / 编时段 / 慢到撞 gateway 超时）已由
 * **确定性代码**兜底：软偏好注入、自动补发漏人、6.x 打回重算、简单肯定短路等，
 * 不再靠换贵模型硬扛。
 *
 * 想临时换更强模型验一把：设 `COLIVING_MODEL=anthropic/claude-sonnet-4.5`。
 * 同在 gateway 上、值得一试的还有 `deepseek/deepseek-v4-pro`、
 * `minimax/minimax-m3`、`zai/glm-5.3`。
 * **注意 `zai/glm-5.3-flash` 试过，不行**——它反问问题、一个工具都不调。
 */
export const COLIVING_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

export function colivingModelId(): string {
  return process.env.COLIVING_MODEL?.trim() || COLIVING_DEFAULT_MODEL;
}

/**
 * relay「回给发信人的最终聚焦修正」这一条窄路径升级到的强模型。
 *
 * 背景（第六轮 relay 人工复核 029）：relay 回信的初稿先过便宜 critic，被打回后
 * 用默认模型重写；重写稿再被 critic 打回时，只剩最后一次聚焦修正机会。实测便宜
 * 模型这时只会复述内容、改不动，最终仍被拦——门禁判断是对的，缺的是最后这次
 * 生成的能力。**只把这最后一次生成升级到 sonnet**，用一次贵调用换一次真正改对
 * 的机会；其余生成路径（首稿、第一次重写、出站、非 relay）保持默认便宜模型。
 */
export const RELAY_FINAL_FIX_MODEL = "anthropic/claude-sonnet-4.5";

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
