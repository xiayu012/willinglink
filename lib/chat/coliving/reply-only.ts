import { z } from "zod";
import {
  FEATURE_REPLY_ONLY_MAX_OUTPUT_TOKENS,
  FeatureCallError,
  structuredCall,
  usageOfFeatureError,
  type FeatureLlm,
  type FeatureUsage,
} from "./feature-llm";

/**
 * **保留对话轮（reply_only）的小回复生成——不是功能、不是工具、不出站。**
 *
 * 老板 2026-09-13 返工要求：内部路由除「命中某一项功能」和「none」之外，多一个保留结果
 * `reply_only`（见 `features.ts`）——当住户的话**明确围绕已批准功能**，但这一轮不能立即
 * 执行（否定「先别发」、征询「要不要 / 该不该」、把这件事绑在另一件还没办的事上，或同时
 * 交办两件）时返回它。`none` 只留给真正无关的主题。
 *
 * `reply_only` **不是一项已批准功能**，也不是工具：这里只管**跟当前说话人**自然讨论 /
 * 确认「这一轮不动作」，一两句。它**没有工具表、不联系任何人、不落任何第三方出站**，
 * 也**不假装已经替住户把话转达了**。用量照记，并进本轮台账（见 `turn.ts`）。
 *
 * 它看不见任何"能力清单"，也不讲内部边界；正文由模型写，这里不写死话术（只有模型
 * 完全生成不出可用回应时的中性兜底）。
 */

export const REPLY_ONLY_STAGE = "feature:reply_only";
export const REPLY_ONLY_NAME = "feature_reply_only";

/**
 * 模型完全写不出可用回应时的**中性兜底**（只在生成失败 / 空文本时用，不是常规话术）。
 * 只说"这轮先不动"，不声称已发送、不列能力、不编事实。
 */
export const REPLY_ONLY_FALLBACK =
  "好，这一轮我先不替你发出去，你想好了再跟我说。";

/** 只接受一个字符串字段：回给当前说话人的那两句。 */
const replyOnlySchema = z.object({
  reply: z.string().describe("回给当前说话人的一两句自然回应"),
});

function replyOnlySystem(): string {
  return [
    "你是这套合租房的 AI 协调员。",
    "住户刚说的这句话，围绕的是一件你本来能替他办的提醒，但**这一轮不该执行任何动作**：",
    "他可能是在否定（让你先别发）、在犹豫、在征询你的意见，或者把这件事绑在一件还没办的事上。",
    "你只用**一两句**自然、口语的中文回应他，就这件事继续商量。",
    "",
    "必须做到：",
    "- 绝不声称已经替他说了 / 已经联系了谁 / 已经把话转达了——这一轮什么都没发。",
    "- 不列出你能做或不能做哪些事，不讲内部规则、流程，也不提「白名单 / 能力」这类词。",
    "- 不编造任何事已经发生；他给了条件（「等他……再」「先……再」），就顺着这个条件说明现在先不动。",
    "- 不替他记录立场、不替他下结论、不承诺以后会自动去办。",
    "",
    "只输出一个 JSON 对象，字段固定为 reply（字符串）：",
    '{"reply": "回给当前说话人的一两句自然回应"}',
    "不要输出 JSON 以外的任何文字、解释或 markdown 代码块标记。",
  ].join("\n");
}

/**
 * 生成 `reply_only` 的那一两句。**任何失败都不向上抛**：把已发生的真实用量带回来，并
 * 给一句中性兜底——调用方（`features.ts`）照常把这轮当保留对话轮收尾，**不落回主生成**
 * （落回主生成会重新走到 `proposeRule` / `recordPosition` 这类不该发生的动作）。
 */
export async function generateReplyOnlyReply(
  text: string,
  llm: FeatureLlm
): Promise<{ reply: string; usage: FeatureUsage; error?: unknown }> {
  try {
    const { value, usage } = await structuredCall(llm, {
      stage: REPLY_ONLY_STAGE,
      name: REPLY_ONLY_NAME,
      schema: replyOnlySchema,
      system: replyOnlySystem(),
      // 小回复是**只对当前说话人**的，可以看他的原话（不存在披露给第三方的问题）。
      user: text,
      maxOutputTokens: FEATURE_REPLY_ONLY_MAX_OUTPUT_TOKENS,
    });
    const reply = ((value as z.infer<typeof replyOnlySchema>).reply ?? "").trim();
    if (!reply) {
      throw new FeatureCallError(
        REPLY_ONLY_STAGE,
        new Error("empty reply_only reply"),
        usage,
        "模型没有输出可用的 reply_only 回应"
      );
    }
    return { reply, usage };
  } catch (error) {
    return {
      reply: REPLY_ONLY_FALLBACK,
      usage: usageOfFeatureError(error),
      error,
    };
  }
}
