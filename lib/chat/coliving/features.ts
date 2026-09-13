import "server-only";

import {
  addFeatureUsage,
  EMPTY_FEATURE_USAGE,
  FEATURE_ROUTE_MAX_OUTPUT_TOKENS,
  usageOfFeatureError,
  type FeatureLlm,
  type FeatureUsage,
} from "./feature-llm";
import type {
  ApprovedFeature,
  FeatureContext,
  FeatureDeps,
  FeatureExecution,
  FeatureExtraction,
  FeatureHandling,
} from "./feature-types";
import { nightLaundryFeature } from "./night-laundry-reminder";
import { personalItemFeature } from "./personal-item-reminder";
import { generateReplyOnlyReply } from "./reply-only";
import { generateUnsupportedReply } from "./unsupported";

/**
 * **已批准功能清单 + 一个只认清单的内部路由器——纯代码定义清单，只调一次模型。**
 *
 * 老板 2026-09-13 定稿：**功能**是唯一正式的最小批准单位（各写各的朴素代码，
 * 不强行抽象）。**清单写死在代码里**：模型没有机会新增
 * 或选择清单外的功能。
 *
 * ## 为什么是"一次路由"，不是"每个功能各判一次"
 *
 * 早期实现是 `Promise.all` 对每个已批准功能各调一次 `judge`。那意味着清单长到 20 项
 * 时，**每一条点名消息都要花 20 次模型调用**——这是不能接受的长期成本。现在改成
 * **一次白名单路由调用**：路由器读一遍原话，只在代码清单里选一个，或三个保留值
 * （`none` / `reply_only` / `unsupported`）之一。
 *
 * 这个路由**不是 LLM tool**、**不暴露给主 agent**、**不新增任何 tool schema**：
 * 它就是功能前门内部的一次**纯文本生成**——提示模型最终只输出一个裸 token，代码
 * `trim()` 后精确比对清单 id，和主生成的工具表毫无关系。
 *
 * ## 用量一路带回来
 *
 * `runApprovedFeature` 无论命中与否、成功或失败，都把**已经发生的每一次调用**的
 * 真实用量并进返回值：路由的用量**即使 none 也计**；命中后再加上被选中功能的抽取与
 * 生成用量；保留轮再加上小回复的用量；失败时用 `FeatureCallError` 带出的已完成 step
 * 用量。调用方（`turn.ts`）把它并进最终 `TurnUsage`——**绝不再丢掉未命中/失败调用的费用**。
 *
 * 命中**恰好一个**才执行（同时交办两个已批准功能时路由器返回 none，不猜）。主生成
 * 看到的工具表里没有功能工具、也没有短信工具。
 */

/** 代码里那份**写死的已批准功能清单**。新增功能 = 在这里加一行 + 一个朴素模块。 */
export const APPROVED_FEATURES: readonly ApprovedFeature[] = [
  nightLaundryFeature,
  personalItemFeature,
];

/** 路由器表示"清单里没有一件被明确交办"的保留值。 */
export const FEATURE_ROUTE_NONE = "none";

/**
 * 路由器的第二个保留结果：**请求明确围绕清单里的某一项，但这一轮不能立即执行**
 * （否定 / 征询 / 附条件 / 同时交办两件）。
 *
 * **它不是功能、不是工具、也不出现在清单里**：只是一个内部对话状态——由 `turn.ts`
 * 走一条**无工具、无出站**的小回复生成（`reply-only.ts`），只跟当前说话人讨论 / 确认
 * 这一轮不动作。它不授予任何清单外能力。
 */
export const FEATURE_ROUTE_REPLY_ONLY = "reply_only";

/**
 * 路由器的第三个保留结果：**住户明确要求 AI 去联系被点名的同住人、替他把话说给对方
 * （或请对方做一件事），但那件事的主题不在已批准功能清单里**（电视音量、卫生清洁、
 * 费用分摊、立全屋规矩、住宿去留等）。
 *
 * **它不是功能、不是工具、也不出现在清单里**：只是一个内部对话状态——由 `turn.ts`
 * 走一条**无工具、无第三方出站**的小回复生成（`unsupported.ts`），用一句真话说明
 * 这件事没有发出去 / 目前没法替他发给对方。它不授予任何清单外能力。
 *
 * 只有"点名要你出站找某人办事、但清单里没有这一件"才返回它；只是提到某位同住人、
 * 没让你联系他（闲聊 / 吐槽 / 陈述）仍走 `none`。
 */
export const FEATURE_ROUTE_UNSUPPORTED = "unsupported";

/** 路由调用的台账阶段名与调用标识（测试与报告据此识别）。 */
export const FEATURE_ROUTE_STAGE = "feature:route";
export const FEATURE_ROUTE_NAME = "feature_route";

function routeSystem(): string {
  return [
    "你是合租房短信系统的内部功能路由器。下面是一份**代码写死的已批准功能清单**。",
    "你只能选**清单里某一项**（选项值就是每行冒号左边的名字），或三个保留值之一：",
    `${FEATURE_ROUTE_NONE} / ${FEATURE_ROUTE_REPLY_ONLY} / ${FEATURE_ROUTE_UNSUPPORTED}。`,
    "不许选清单外的名字，也不许把清单里没有的诉求硬塞给某一项。",
    "",
    "已批准功能清单：",
    ...APPROVED_FEATURES.map((f) => `- ${f.id}：${f.routeDescription}`),
    "",
    `只有当住户**明确把这一件事交给你去做**（点名了要提醒的人，并要求你去提醒 / 跟他说、`,
    "主题正是清单里的某一项）时，才选对应的那一项。混合请求里，只要这一项**能独立执行**",
    "（夹带了别的诉求也不影响这一件单独办），仍然选它。",
    "",
    `选 ${FEATURE_ROUTE_REPLY_ONLY}：这句话**明确围绕清单里的某一项**，但这一轮不能立即执行——`,
    "- 住户在否定（「先别提醒他」「别急着替我说」「不用跟他说」）；",
    "- 在犹豫、征询你的意见（「要不要 / 该不该 / 你觉得要不要跟他提」）；",
    "- 把这件事绑在一件还没办的事上（「等他……再」「先……再」「除非……」）；",
    "- 同时明确交办了两个及以上已批准功能（不猜，但也不是与清单无关）。",
    `这几种情况不要硬塞给某一项，也不要当成 ${FEATURE_ROUTE_NONE}。`,
    "",
    `选 ${FEATURE_ROUTE_UNSUPPORTED}：住户**明确要求你去联系某位被点名的同住人、替他把`,
    "话说给对方 / 让对方做一件事**，但那件事的主题**不在上面的清单里**（电视音量、",
    "卫生清洁、费用分摊、立全屋规矩、住宿去留等）。这种「点名要你出站找某人办事、",
    `但清单里没有这一件」的请求，选 ${FEATURE_ROUTE_UNSUPPORTED}。`,
    `只是提到某位同住人、但并没有要你去联系他办事（闲聊、吐槽、陈述），仍选 ${FEATURE_ROUTE_NONE}。`,
    "",
    `选 ${FEATURE_ROUTE_NONE}：这句话**不是**要你出站找某位同住人办事——别的主题、杂事、`,
    "只是在闲聊，或提到同住人但没有让你联系他。",
    "",
    `最终**只输出一个词**：清单里某一项冒号左边的名字、${FEATURE_ROUTE_NONE}、${FEATURE_ROUTE_REPLY_ONLY}、或 ${FEATURE_ROUTE_UNSUPPORTED}。`,
    "不要输出 JSON、引号、标点、解释、代码块或任何其它文字；只输出这一个词本身。",
  ].join("\n");
}

/**
 * 路由：**一次**内部白名单纯文本调用，回答是不是明确交办了清单里的某一项。
 *
 * **裸 token 协议**（当前 AI SDK beta 的原生 `Output.choice` 与 DeepSeek 不兼容，会
 * 回 `{"name": …}` 这类对象并报错，见 `feature-llm.ts` 顶部说明）：提示模型只输出
 * 一个词，代码只接受 `trim()` 后**精确等于**清单里某个功能 id、`none`、或
 * `reply_only` 的值。清单外的词、JSON、带解释的整句……一律不命中——**清单外不可能
 * 命中**，绝不执行清单外功能。
 *
 * 返回命中的功能（`none` / `reply_only` / `unsupported` / 未知值都是 null）、是否命中
 * 保留结果 `reply_only`，以及是否是保留结果 `unsupported`，还有这次调用的真实用量。
 * **即使不命中，用量也要往上交**——那次调用已经花了钱。
 */
export async function routeApprovedFeature(
  text: string,
  llm: FeatureLlm
): Promise<{
  match: ApprovedFeature | null;
  replyOnly: boolean;
  unsupported: boolean;
  usage: FeatureUsage;
}> {
  const { text: modelText, usage } = await llm.generate({
    stage: FEATURE_ROUTE_STAGE,
    name: FEATURE_ROUTE_NAME,
    system: routeSystem(),
    user: text,
    // 输出只是一个词，但**推理 token 也计入这个上限**（DeepSeek V4.1 Flash）：
    // 128 会在输出前耗尽 → 截断。给足「推理 + 极短输出」的空间。
    maxOutputTokens: FEATURE_ROUTE_MAX_OUTPUT_TOKENS,
  });
  const token = modelText.trim();
  if (token === FEATURE_ROUTE_REPLY_ONLY) {
    return { match: null, replyOnly: true, unsupported: false, usage };
  }
  if (token === FEATURE_ROUTE_UNSUPPORTED) {
    return { match: null, replyOnly: false, unsupported: true, usage };
  }
  const match = APPROVED_FEATURES.find((f) => f.id === token) ?? null;
  return { match, replyOnly: false, unsupported: false, usage };
}

/**
 * 前门这一趟的结果类型：
 * - `feature`：命中某一项已批准功能并执行（可能 `handling: null` = 没形成出站）。
 * - `reply_only`：保留对话轮——明确围绕某项功能但这一轮不动作，只回当前住户一两句
 *   （`handling.sms` 必为 null）。
 * - `unsupported`：保留对话轮——明确要求联系点名室友办事但主题不在清单里，只回当前
 *   住户一句真话（`handling.sms` 必为 null）。
 * - `none`：与清单无关，落回普通（主生成）对话。
 */
export type FeatureRunMode = "feature" | "reply_only" | "unsupported" | "none";

/**
 * 功能前门的**唯一编排入口**：一次路由 → 命中才抽取该功能字段 → 该功能执行并投递；
 * 路由返回保留结果 `reply_only` / `unsupported` 时，改走**无工具、无出站**的小回复生成
 * （两者语义独立、提示词各写各的，但共用同一条纯机械管道）。
 *
 * 返回可投递结果（没形成出站时 `handling: null`）、这一趟的模式、命中的功能 id、以及
 * **这一趟全部**真实用量。任何一步抛错都**不向上抛**：把已完成调用的用量并进 `usage`，
 * 附上 `error` 让调用方落回普通对话并记录——**失败不是"什么都没发生、没花钱"**。
 */
export type ApprovedFeatureRun = {
  mode: FeatureRunMode;
  handling: FeatureHandling | null;
  /** 命中功能的 id；路由 `none` / `reply_only` / `unsupported` 或失败时为 null */
  featureId: string | null;
  /** 路由 + 抽取 + 生成（已发生的调用）的合计真实用量 */
  usage: FeatureUsage;
  /** 前门内部失败（用量已计入 `usage`）；调用方据此落回普通对话 */
  error?: unknown;
};

export async function runApprovedFeature(
  text: string,
  ctx: FeatureContext,
  deps: FeatureDeps
): Promise<ApprovedFeatureRun> {
  let usage = EMPTY_FEATURE_USAGE;
  const failed = (error: unknown): ApprovedFeatureRun => ({
    mode: "none",
    handling: null,
    featureId: null,
    usage: addFeatureUsage(usage, usageOfFeatureError(error)),
    error,
  });

  let match: ApprovedFeature | null;
  let replyOnly: boolean;
  let unsupported: boolean;
  try {
    const routed = await routeApprovedFeature(text, deps.llm);
    usage = addFeatureUsage(usage, routed.usage);
    match = routed.match;
    replyOnly = routed.replyOnly;
    unsupported = routed.unsupported;
  } catch (error) {
    return failed(error);
  }

  // 保留对话轮：明确围绕某项功能但这一轮不动作。**无工具、无出站**，只回当前住户
  // 一两句；失败不落回主生成（那会重新走到 proposeRule / recordPosition），而是用
  // 中性兜底收尾，并把已发生的真实用量照记。
  if (replyOnly) {
    const reply = await generateReplyOnlyReply(text, deps.llm);
    usage = addFeatureUsage(usage, reply.usage);
    return {
      mode: "reply_only",
      handling: {
        status: "handled",
        reply: reply.reply,
        sms: null,
        decisionId: null,
      },
      featureId: null,
      usage,
      ...(reply.error ? { error: reply.error } : {}),
    };
  }

  // 保留对话轮：住户明确要求联系点名室友办事，但主题不在清单里。**无工具、无出站**，
  // 只回当前住户一句真话（这件事没发出去 / 目前没法替他发）；同样绝不落回主生成
  // （那会重新走到 proposeRule / recordPosition，甚至再编一句「已经跟他说了」）。
  if (unsupported) {
    const reply = await generateUnsupportedReply(text, deps.llm);
    usage = addFeatureUsage(usage, reply.usage);
    return {
      mode: "unsupported",
      handling: {
        status: "handled",
        reply: reply.reply,
        sms: null,
        decisionId: null,
        // 纯代码关联到统一功能事实源的条目 id：`turn.ts` 收尾时把它（连同发起人）存进
        // decision payload，让下一轮功能问答能读到**结构化事实**，而不是靠模型自由文本。
        unsupportedCapabilityId: reply.capabilityId,
      },
      featureId: null,
      usage,
      ...(reply.error ? { error: reply.error } : {}),
    };
  }

  if (!match) return { mode: "none", handling: null, featureId: null, usage };

  let extraction: FeatureExtraction;
  try {
    extraction = await match.extract(text, deps.llm);
  } catch (error) {
    return failed(error);
  }
  usage = addFeatureUsage(usage, extraction.usage);

  let execution: FeatureExecution;
  try {
    execution = await match.execute(extraction, ctx, deps);
  } catch (error) {
    return failed(error);
  }
  usage = addFeatureUsage(usage, execution.usage);

  return { mode: "feature", handling: execution.handling, featureId: match.id, usage };
}
