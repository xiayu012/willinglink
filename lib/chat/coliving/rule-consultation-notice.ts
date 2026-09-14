import "server-only";

import { z } from "zod";
import {
  FEATURE_COMPOSE_MAX_OUTPUT_TOKENS,
  structuredCall,
  type FeatureLlm,
  type FeatureUsage,
} from "./feature-llm";

/**
 * **共同规则协商的措辞层——只写文案，不决定「该不该发」。**
 *
 * 状态机（`lib/coordination/rule-consultation.ts`）只产出「发给谁」的结构化动作；
 * 文案由这里按**收窄后的字段**（这条规则是什么、这一步是征询还是定案通知）让模型写。
 * **状态机不写固定话术，这里也不决定权限 / 收件人**——收件人由状态机的动作绑定，
 * 这里只把已经定好的这一步写成一句自然的中文短信。
 *
 * ## 它**看不到**的东西（来源隐私）
 *
 * 提示词里**只有规则事实文本**，没有：是谁提出的、谁投诉了、任何人之外的对话原文、
 * 任何人的私人处境。这里的规则文本是**中性固定语义事实**（识别层收敛成的
 * `SHARED_SHOWER_DRAIN_HAIR_RULE_FACT`，见 `rule-consultation-session.ts`），**不是**
 * 发起人原句片段——原句里的姓名 / 指责 / 私人理由都不会传到这里，也不标记是谁说的。
 * `"initiator"` 字段根本不会传到这里——它在状态机内部，投影里都没有。
 *
 * ## 三种文案
 *
 * - `consult` —— 请一位还没表态的室友就这条规则表个态；
 * - `announce` —— 告诉一位室友：这条规则已经**所有人同意**、正式生效；
 * - `ack` —— 住户刚表态 / 问进度时，回他一句简短的确认或说明。
 *
 * **注意（已知边界）**：这不是主生成那条 doctrine 路径，而是一条收窄的小生成路径
 * （与已批准功能模块的 `compose` 同构）。措辞在启用前必须按 doctrine 走一遍人工阅读 /
 * 语义审稿（见 CLAUDE.md「机械检查证明不了语气」）。
 */

/** 三种文案的严格 schema：一个固定 JSON 对象，缺一项即安全不发送。 */
const RuleNoticesSchema = z.object({
  consult: z.string().min(1),
  announce: z.string().min(1),
  ack: z.string().min(1),
});

export type RuleNotices = z.infer<typeof RuleNoticesSchema>;

/** 台账阶段名与调用标识（测试 / 报告据此识别）。 */
export const RULE_NOTICE_STAGE = "rule:notice";
export const RULE_NOTICE_NAME = "rule_consultation_notice";

/**
 * 措辞系统提示：**只给这一次协商的规则事实**，要求简短、中性、说清合理理由、
 * 不念流程、不指名任何人、不透露是谁提出的。
 */
export function ruleNoticeSystem(rule: string): string {
  return [
    "你在一个合租房短信系统里，替一条**全屋共同规则**写通知。",
    `这条规则是：「${rule}」。`,
    "住户们正在一起确认这条规则，必须**所有人都同意**才算定案。",
    "",
    "请写三种短信，都用中文、简短（一两句）、自然、第三人称中性的口吻，各说清一个合理理由；",
    "不许念流程，不许出现「状态机 / 协商 / 投票 / 征询 / 流程」这类系统词：",
    "- consult：发给一位还没表态的室友，请他就这条规则表个态（同意或不同意都可以）。",
    "- announce：发给一位室友，告诉他这条规则已经**所有人都同意、正式生效**。",
    "- ack：住户刚表态或问进度时，回他一句简短的确认或说明。",
    "",
    "**绝对不许**提到是谁先提出这条规则的、有人投诉、或任何人的私人情况；",
    "也不要单独点名任何一位住户（规则本身说的「每个人」可以照说）。",
    "只输出一个 JSON 对象：{\"consult\":\"…\",\"announce\":\"…\",\"ack\":\"…\"}，不要输出任何别的文字。",
  ].join("\n");
}

/**
 * 一次模型调用，产出这三种文案。失败时抛 `FeatureCallError`（已带真实用量，不重试），
 * 由调用方安全不发送：`turn.ts` 在**事实推进之后绝不回落**普通流程，而是**零第三方出站**、
 * 给当前住户一句中性安全回复——**绝不用兜底文案假称已经通知**。
 */
export async function composeRuleNotices(
  rule: string,
  llm: FeatureLlm
): Promise<{ notices: RuleNotices; usage: FeatureUsage }> {
  const { value, usage } = await structuredCall(llm, {
    stage: RULE_NOTICE_STAGE,
    name: RULE_NOTICE_NAME,
    system: ruleNoticeSystem(rule),
    user: "请按上面的要求写这三种通知。",
    maxOutputTokens: FEATURE_COMPOSE_MAX_OUTPUT_TOKENS,
    schema: RuleNoticesSchema,
  });
  return { notices: value as RuleNotices, usage };
}
