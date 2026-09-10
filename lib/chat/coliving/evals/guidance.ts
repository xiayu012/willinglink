/**
 * **仅评测显式启用的成功轨迹 guidance（Golden Trace A/B）。**
 *
 * 目的：验证少量成功轨迹能否让当前大脑在保持动作与工具能力的前提下，
 * 对外只给必要结果/理由/动作/一个问题（不播报内部记录、核实与判断过程），
 * 并在两人共享范围可能被反推来源时，把是否披露的决定交还给信息所有者。
 *
 * 边界（重要）：
 * - **默认关闭。** 生产 `runColivingTurn` 不传 guidance 时，生成器看到的
 *   system 内容与模块逐字不变（system 构造器 `buildGeneratorSystemMessages`
 *   在 turn.ts，无 guidance 时就是 doctrine → runtime）。本文件只做实验登记
 *   与解析，不被生产模块反向依赖。
 * - **只通过登记 id 选择**，不接受任意外部文本；未知 id 立即抛错。
 * - 不属于常驻 doctrine，**不要**放进 `lib/ai/brains/coliving/doctrine/always`。
 * - 只喂生成器，不喂批判器（critic 的 rubric 不注入这些示例）。
 *
 * 版本化：改动示范内容就换一个新 id（例如 `-v2`），不要原地改旧 id，
 * 否则历史评测报告无法区分当时跑的是哪一版。
 */

/**
 * 登记表：id → guidance 正文。只增不改语义，改内容请新增 id。
 *
 * 内容是**纯正向示范**：每条只写「内部状态 / 决定 / 对住户说」，不写任何
 * "不要说某某坏句子"的负例——成功轨迹实验不该把坏话再喂给生成器。
 */
export const COLIVING_GUIDANCE_TEXTS = {
  "concise-coordination-v1": `## 实验附件：成功轨迹示范（concise-coordination-v1）

下面是三条简短的示范，只用来说明**内部判断**和**发出去的话**该各是什么分量：
「内部状态」是你自己心里知道的，不写进回复；「对住户说」才是最终回复应有的样子。
示范不是模板——不要照抄句子，也不要固定开场或句式。

### 轨迹一｜先问清当事人要什么
- 内部状态：他说「已经第二次了，我真受不了」，但没说清要的是以后别再发生，还是这次也要补回来。
- 决定：直接问清目标；记录和核实由我自己做。
- 对住户说：你现在更在意以后别再动你的东西，还是这次也需要补回来？

### 轨迹二｜用一句必要理由劝退明显过度的规则
- 内部状态：他要求「十点后完全不准洗澡」，没有租约依据、也不紧急，却会让夜班回来的人没法正常用浴室。
- 决定：讲清理由并给出可执行的替代，核实步骤自己去做。
- 对住户说：十点后完全不让洗不合适，夜班回来的人也得正常用浴室。可以改成十点后尽量缩短、保持安静。

### 轨迹三｜共享范围里可能被反推来源时，先问信息所有者
- 内部状态：柜子只有两个人共用，照原话提醒很容易被对方推断出是谁反映的，眼下又不紧急。
- 决定：如实说明可能被推断，把是否发送交还给决定的人，也绝不把提醒扩到不用这个柜子的人。
- 对住户说：这个柜子只有你们两个人用，他可能会猜到是你。还要发吗？`,
} as const;

export type ColivingGuidanceId = keyof typeof COLIVING_GUIDANCE_TEXTS;

/** 已登记的 guidance id，用于 CLI 报错提示与离线检查。 */
export function knownGuidanceIds(): ColivingGuidanceId[] {
  return Object.keys(COLIVING_GUIDANCE_TEXTS) as ColivingGuidanceId[];
}

export function isKnownGuidanceId(id: string): id is ColivingGuidanceId {
  return Object.prototype.hasOwnProperty.call(COLIVING_GUIDANCE_TEXTS, id);
}

/**
 * id → guidance 正文。**未登记的 id 立即抛错**，不静默降级成基线，
 * 避免评测报告把"跑错了实验"记成"基线通过"。
 */
export function resolveGuidance(id: string): string {
  if (!isKnownGuidanceId(id)) {
    throw new Error(
      `未知的 guidance id「${id}」；已登记：${knownGuidanceIds().join("、")}`
    );
  }
  return COLIVING_GUIDANCE_TEXTS[id];
}

/**
 * CLI 参数解析：空值（null/undefined/空串）→ `undefined`，即基线、不加附件；
 * 非空但未登记 → 抛错（不接受任意外部文本）。`--guidance` 只给了 flag、
 * 没给值的情况由调用方先拦，不走这里。
 */
export function resolveGuidanceArg(
  raw: string | null | undefined
): string | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  return resolveGuidance(raw.trim());
}

/**
 * `--guidance` 只给了 flag、没给值：下一个参数缺席（null/undefined）、是空白、
 * 或者本身又是一个 `--flag`（例如 `--guidance --judge-off`）——都算缺值。
 * CLI 用它在解析前打印统一的缺值报错，避免把 `--judge-off` 误当成未知 id。
 */
export function isMissingGuidanceArg(raw: string | null | undefined): boolean {
  return (
    raw === null || raw === undefined || raw.trim() === "" || raw.startsWith("--")
  );
}
