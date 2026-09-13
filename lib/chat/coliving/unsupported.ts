import { z } from "zod";
import {
  FEATURE_UNSUPPORTED_MAX_OUTPUT_TOKENS,
  FeatureCallError,
  structuredCall,
  usageOfFeatureError,
  type FeatureLlm,
  type FeatureUsage,
} from "./feature-llm";

/**
 * **保留结果 `unsupported` 的小回复——不是功能、不是工具、不出站。**
 *
 * 老板 2026-09-13 返工要求：内部路由除「命中某一项功能」「none」「reply_only」之外，
 * 再多一个保留结果 `unsupported`（见 `features.ts`）——当住户**明确要求 AI 去联系
 * 被点名的同住人、替他把话说给对方 / 让对方做一件事**，但那件事的主题**不在已批准
 * 功能清单里**（电视音量、卫生清洁、费用分摊、立全屋规矩、住宿去留等）时返回它。
 * `none` 只留给「不是这种出站交办」的普通话。
 *
 * `unsupported` **不是一项已批准功能**，也不是工具：这里只管**跟当前说话人**用一句
 * 真话说明这件事没有发出去 / 目前没法替他发给对方，一两句。它**没有工具表、不联系任何
 * 人、不落任何第三方出站**，也**不假装已经替住户把话转达了**，更**不给假希望**
 * （「我待会儿就去说」）。**不主动罗列能力清单 / 内部规则**；只有当住户本轮**明确
 * 追问为什么办不了**时，才用一句话简单说明这类事情目前没开放。正文由模型写，这里
 * 不写死话术（只有模型完全生成不出可用回应时的中性兜底）。
 *
 * 与 `reply-only.ts` 共用同一条**纯机械管道**（`feature-llm.ts` 的 `structuredCall`），
 * 但语义彼此独立、提示词各写各的。用量照记，并进本轮台账（见 `turn.ts`）。
 *
 * 它看不见任何"能力清单"，也不讲内部边界。
 */

export const UNSUPPORTED_STAGE = "feature:unsupported";
export const UNSUPPORTED_NAME = "feature_unsupported";

/**
 * 模型完全写不出可用回应时的**中性兜底**（只在生成失败 / 空文本时用，不是常规话术）。
 * 只说"这件事没发出去"，不声称已发送、不列能力、不编事实、不给假希望。
 */
export const UNSUPPORTED_FALLBACK =
  "这件事我现在没法替你发给对方，还没有跟他说。";

/** 只接受一个字符串字段：回给当前说话人的那一两句。 */
const unsupportedSchema = z.object({
  reply: z.string().describe("回给当前说话人的一两句自然回应"),
});

function unsupportedSystem(): string {
  return [
    "你是这套合租房的 AI 协调员。",
    "住户刚说的这句话，是要你去联系另一位同住人、替他把话说给对方，或请对方做一件事；",
    "但**这件事你目前没法替他发出去**——它不在你能代住户发给别人的范围里。",
    "你只用**一两句**自然、口语的中文回应他，就这件事说句真话。",
    "",
    "必须做到：",
    "- 如实说明这件事你**没法替他发给对方**、现在没有发出去；不要含糊其辞让他以为已经办了。",
    "- 绝不声称已经替他说了 / 已经联系了谁 / 已经把话转达了 / 对方已经知道。",
    "- 不给假希望：不说「我待会儿就去说」「我帮你去跟他讲」这类你没有做的事。",
    "- **不要主动罗列你能做或不能做哪些事**，不讲内部规则、流程，也不提「白名单 / 能力 / 功能 / 未开放」这类词。",
    "- 只有当他**明确在追问为什么办不了 / 为什么不能发**时，才用一句话简单说明这类事情目前处理不了；否则不要主动解释原因。",
    "- 不替他记录立场、不替他下结论、不承诺以后会自动去办。",
    "",
    "只输出一个 JSON 对象，字段固定为 reply（字符串）：",
    '{"reply": "回给当前说话人的一两句自然回应"}',
    "不要输出 JSON 以外的任何文字、解释或 markdown 代码块标记。",
  ].join("\n");
}

/**
 * 生成 `unsupported` 的那一两句。**任何失败都不向上抛**：把已发生的真实用量带回来，并
 * 给一句中性兜底——调用方（`features.ts`）照常把这轮当保留对话轮收尾，**不落回主生成**
 * （落回主生成会重新走到 `proposeRule` / `recordPosition` 这类不该发生的动作）。
 */
export async function generateUnsupportedReply(
  text: string,
  llm: FeatureLlm
): Promise<{ reply: string; usage: FeatureUsage; error?: unknown }> {
  try {
    const { value, usage } = await structuredCall(llm, {
      stage: UNSUPPORTED_STAGE,
      name: UNSUPPORTED_NAME,
      schema: unsupportedSchema,
      system: unsupportedSystem(),
      // 小回复是**只对当前说话人**的，可以看他的原话（不存在披露给第三方的问题）。
      user: text,
      maxOutputTokens: FEATURE_UNSUPPORTED_MAX_OUTPUT_TOKENS,
    });
    const reply = ((value as z.infer<typeof unsupportedSchema>).reply ?? "").trim();
    if (!reply) {
      throw new FeatureCallError(
        UNSUPPORTED_STAGE,
        new Error("empty unsupported reply"),
        usage,
        "模型没有输出可用的 unsupported 回应"
      );
    }
    return { reply, usage };
  } catch (error) {
    return {
      reply: UNSUPPORTED_FALLBACK,
      usage: usageOfFeatureError(error),
      error,
    };
  }
}
