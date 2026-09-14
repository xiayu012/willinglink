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
import {
  BLACKLISTED_CAPABILITIES,
  blacklistRouteToken,
  blacklistedCapabilityByRouteToken,
  blacklistedReply,
  type BlacklistedCapability,
} from "./blacklist";
import { nightLaundryFeature } from "./night-laundry-reminder";
import { personalItemFeature } from "./personal-item-reminder";
import { generateReplyOnlyReply } from "./reply-only";

/**
 * **已批准功能清单 + 一个只认清单的内部路由器——纯代码定义清单，只调一次模型。**
 *
 * 老板 2026-09-13 决策（默认宽容）：**功能**仍是唯一正式的**最小产品单位**（各写各的
 * 朴素代码，不强行抽象），但这份清单**不再是权限边界**，而是一条**低成本、稳定的优化
 * 快路径**：
 *
 * - **命中**清单里恰好一项 → 走窄上下文、独立投递（抽取本功能获准的有限结构字段，
 *   由模型写一句自然正文，纯代码绑定原话点名的唯一收件人并落库）。这是**更快、更省**
 *   的路径，已批准功能的体验一字不变。
 * - **没命中（`none`）不等于拒绝**：落回**完整的 doctrine + 运行时主生成**。那里恢复
 *   了通用的短信联系能力（`turn.ts` 的 `contactPerson`），主生成按当前意图 / 流程判断
 *   是否该替住户联系同屋人。清单外的请求**不得因"不在清单里"自动拒绝**。
 * - **真正办不了只有一个来源**：老板明确登记的**黑名单**（`blacklist.ts`，当前一项
 *   「单方面叫别人在洗完澡后清理地漏头发」）。它**复用这同一次路由**（黑名单条目也作为
 *   可选项用 `blocked:<id>` token 摆给模型），**只有模型判定住户正在交办该黑名单功能时才
 *   拦**——不按关键词、**不加第二次 LLM 调用**；表里没有的事项、或经讨论 / 否定 / 引用 /
 *   提问，都不拦。**功能是精确行为、不是一类主题**：路由选中后还会过**该条目自己的**
 *   `qualifier` 做一次纯代码资格复核，不通过就当作 `none` 落回完整流程。
 *
 * ## 为什么是"一次路由"，不是"每个功能各判一次"
 *
 * 早期实现是 `Promise.all` 对每个已批准功能各调一次 `judge`。那意味着清单长到 20 项
 * 时，**每一条点名消息都要花 20 次模型调用**——这是不能接受的长期成本。现在改成
 * **一次清单内路由调用**：路由器读一遍原话，只在代码清单里选一个，或保留值 `none` /
 * `reply_only`。
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
 * 命中**恰好一个**、且**整条交办恰好完整落在这一个功能里**才执行。只要同一句话里还夹带
 * 另一项**需要执行**的诉求（无论是另一个已批准功能，还是任何清单外请求），路由就返回
 * `none`，**整条交给完整主流程**——不截走一小段、不静默丢掉其余。主生成看到的工具表里
 * 没有功能工具（通用短信联系工具 `contactPerson` 是独立的一层能力）。
 */

/** 代码里那份**写死的已批准功能清单**。新增功能 = 在这里加一行 + 一个朴素模块。 */
export const APPROVED_FEATURES: readonly ApprovedFeature[] = [
  nightLaundryFeature,
  personalItemFeature,
];

/**
 * 路由器表示"清单里没有一件被明确交办"的保留值。**它不等于拒绝**：`turn.ts` 收到
 * `none` 会把这一轮落回完整的 doctrine + 运行时主生成。
 */
export const FEATURE_ROUTE_NONE = "none";

/**
 * 路由器的第二个保留结果：**请求明确围绕清单里的某一项，但这一轮不能立即执行**
 * （否定 / 征询 / 附条件）。
 *
 * **它不是功能、不是工具、也不出现在清单里**：只是一个内部对话状态——由 `turn.ts`
 * 走一条**无工具、无出站**的小回复生成（`reply-only.ts`），只跟当前说话人讨论 / 确认
 * 这一轮不动作。它不授予任何清单外能力。
 *
 * **"同时明确交办两件"不属于这里**：那要走 `none`、整条交给完整主流程——取一件、
 * 丢掉另一件是错的，`reply_only` 又会让整条都不执行。否定/征询/附条件与"夹带别的
 * 诉求"是两回事，前者本轮本就不该动作，后者本轮该做、只是该由完整流程做。
 */
export const FEATURE_ROUTE_REPLY_ONLY = "reply_only";

/** 路由调用的台账阶段名与调用标识（测试与报告据此识别）。 */
export const FEATURE_ROUTE_STAGE = "feature:route";
export const FEATURE_ROUTE_NAME = "feature_route";

function routeSystem(): string {
  const blockedOptions = BLACKLISTED_CAPABILITIES.map(
    (c) => `- ${blacklistRouteToken(c.id)}：${c.routeDescription}`
  );
  return [
    "你是合租房短信系统的内部功能路由器。下面是一份**代码写死的已批准功能清单**。",
    `你只能选**清单里某一项**（选项值就是每行冒号左边的名字），或两个保留值之一：`,
    `${FEATURE_ROUTE_NONE} / ${FEATURE_ROUTE_REPLY_ONLY}。`,
    "不许选清单外的名字，也不许把清单里没有的诉求硬塞给某一项。",
    "",
    "已批准功能清单（这些是专门优化、更快更省的两件；**没列在这里的诉求不是被拒绝**，",
    "会有别的流程处理）：",
    ...APPROVED_FEATURES.map((f) => `- ${f.id}：${f.routeDescription}`),
    "",
    `只有当住户**把整整一件事交给你去做**（点名了要提醒的人，并要求你去提醒 / 跟他说、`,
    "主题正好是清单里的某一项、且这句话里没有别的还要办的事）时，才选对应的那一项。",
    `**只要同一句话里还夹带了另一项需要去办的诉求**（不管是另一件已批准功能，还是任何`,
    `别的请求），就不要选任何功能，改选 ${FEATURE_ROUTE_NONE}——让整条交给完整流程，`,
    "不要只挑出其中一件、把其余悄悄丢掉。",
    "",
    `选 ${FEATURE_ROUTE_REPLY_ONLY}：这句话**明确围绕清单里的某一项**，但这一轮不能立即执行——`,
    "- 住户在否定（「先别提醒他」「别急着替我说」「不用跟他说」）；",
    "- 在犹豫、征询你的意见（「要不要 / 该不该 / 你觉得要不要跟他提」）；",
    "- 把这件事绑在一件还没办的事上（「等他……再」「先……再」「除非……」）。",
    `这几种情况不要硬塞给某一项，也不要当成 ${FEATURE_ROUTE_NONE}。`,
    "",
    `选 ${FEATURE_ROUTE_NONE}：这句话**不是**"恰好把一件清单里的事完整交给你"——别的主题、`,
    "杂事、只是在闲聊、提到同住人但没有让你用某一项**专门优化功能**去提醒他，或者**一句" +
      "话里同时交办了不止一件事**（例如既要提醒这件事、又要顺便办别的）。",
    `**注意**：${FEATURE_ROUTE_NONE} 只是"没命中这条快路径"，**不是"这件事不做"**；`,
    "这类请求会交给完整的协调流程处理。",
    "",
    ...(blockedOptions.length
      ? [
          "另有**明确办不了**的事项（只有住户**正在交办**该事项时才选；只是讨论它、否定它、",
          "引用它、问它为什么不行，都**不要**选）：",
          ...blockedOptions,
          "",
        ]
      : []),
    `最终**只输出一个词**：清单里某一项冒号左边的名字、${FEATURE_ROUTE_NONE}、或 ${FEATURE_ROUTE_REPLY_ONLY}${
      blockedOptions.length ? "、或某个 blocked: 开头的办不了事项" : ""
    }。`,
    "不要输出 JSON、引号、标点、解释、代码块或任何其它文字；只输出这一个词本身。",
  ].join("\n");
}

/**
 * 路由：**一次**内部清单路由纯文本调用，回答是不是明确交办了清单里的某一项。
 *
 * **裸 token 协议**（当前 AI SDK beta 的原生 `Output.choice` 与 DeepSeek 不兼容，会
 * 回 `{"name": …}` 这类对象并报错，见 `feature-llm.ts` 顶部说明）：提示模型只输出
 * 一个词，代码只接受 `trim()` 后**精确等于**清单里某个功能 id、`none`、或
 * `reply_only` 的值。清单外的词、JSON、带解释的整句……一律不命中。
 *
 * 返回命中的功能（`none` / `reply_only` / 黑名单 / 未知值都是 null）、是否命中保留结果
 * `reply_only`、命中的黑名单条目（路由没选 `blocked:<id>` 时为 null），以及这次调用的
 * 真实用量。**即使不命中，用量也要往上交**——那次调用已经花了钱。
 *
 * **黑名单复用这一次调用**：条目以 `blocked:<id>` token 摆给模型，代码用
 * `blacklistedCapabilityByRouteToken` 精确解析；**没有第二次 LLM 调用**，也**不按关键词**
 * 判断住户是不是在交办它。
 */
export async function routeApprovedFeature(
  text: string,
  llm: FeatureLlm
): Promise<{
  match: ApprovedFeature | null;
  replyOnly: boolean;
  blacklisted: BlacklistedCapability | null;
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
    return { match: null, replyOnly: true, blacklisted: null, usage };
  }
  const blacklisted = blacklistedCapabilityByRouteToken(token);
  if (blacklisted) {
    return { match: null, replyOnly: false, blacklisted, usage };
  }
  const match = APPROVED_FEATURES.find((f) => f.id === token) ?? null;
  return { match, replyOnly: false, blacklisted: null, usage };
}

/**
 * 前门这一趟的结果类型：
 * - `feature`：命中某一项已批准功能并执行（可能 `handling: null` = 没形成出站）。
 * - `reply_only`：保留对话轮——明确围绕某项功能但这一轮不动作，只回当前住户一两句
 *   （`handling.sms` 必为 null）。
 * - `blacklisted`：那一次路由判定住户**正在交办**一项老板明确登记的黑名单功能，用
 *   **纯代码**真话回复、零出站（`handling.sms` 必为 null）。路由没选 `blocked:<id>` 时
 *   不会出现。
 * - `none`：没命中快路径，落回普通（主生成）对话——**不是拒绝**。
 */
export type FeatureRunMode = "feature" | "reply_only" | "blacklisted" | "none";

/**
 * 功能前门的**唯一编排入口**：一次路由 → 命中才抽取该功能字段 → 该功能执行并投递；
 * 路由返回保留结果 `reply_only` 时，改走**无工具、无出站**的小回复生成。
 *
 * 返回可投递结果（没形成出站时 `handling: null`）、这一趟的模式、命中的功能 id、以及
 * **这一趟全部**真实用量。任何一步抛错都**不向上抛**：把已完成调用的用量并进 `usage`，
 * 附上 `error` 让调用方落回普通对话并记录——**失败不是"什么都没发生、没花钱"**。
 */
export type ApprovedFeatureRun = {
  mode: FeatureRunMode;
  handling: FeatureHandling | null;
  /** 命中功能的 id；路由 `none` / `reply_only` 或失败时为 null */
  featureId: string | null;
  /**
   * `mode: "blacklisted"` 时命中的黑名单条目 id（其余模式为 null）。调用方据此把
   * `{ blacklistedCapabilityId, personId }` 写进这一轮 decision payload——供住户
   * **紧接着**追问「刚才为什么」时关联到统一事实源里的同一条目。
   */
  blacklistedCapabilityId: string | null;
  /** 路由 + 抽取 + 生成（已发生的调用）的合计真实用量 */
  usage: FeatureUsage;
  /** 前门内部失败（用量已计入 `usage`）；调用方据此落回普通对话 */
  error?: unknown;
};

/**
 * `runApprovedFeature` 的可选入参（**第四参数，缺省 = 空**）。
 *
 * `grantedFeatureIds`：**已经就某几个精确 id 取得授权的功能 / 黑名单条目**。目前只用于
 * 黑名单——被授权的那一条不再走"纯代码真话拒绝"，而是返回标准 `none` 让调用方落回主流程。
 * 缺省为空集：既有调用一行不改，默认拒绝行为逐字不变。**纯内存入参**：不读磁盘、不加模型
 * 调用、不写进 `APPROVED_FEATURES`（它仍只是那两条快路径的清单）。
 */
export type ApprovedFeatureRunOptions = {
  /** 精确 id 集合（只接受只读数组）。只做**精确相等**匹配，不做前缀 / 邻近 id 放行。 */
  grantedFeatureIds?: readonly string[];
};

export async function runApprovedFeature(
  text: string,
  ctx: FeatureContext,
  deps: FeatureDeps,
  options: ApprovedFeatureRunOptions = {}
): Promise<ApprovedFeatureRun> {
  let usage = EMPTY_FEATURE_USAGE;
  const failed = (error: unknown): ApprovedFeatureRun => ({
    mode: "none",
    handling: null,
    featureId: null,
    blacklistedCapabilityId: null,
    usage: addFeatureUsage(usage, usageOfFeatureError(error)),
    error,
  });

  let match: ApprovedFeature | null;
  let replyOnly: boolean;
  let blacklisted: BlacklistedCapability | null;
  try {
    const routed = await routeApprovedFeature(text, deps.llm);
    usage = addFeatureUsage(usage, routed.usage);
    match = routed.match;
    replyOnly = routed.replyOnly;
    blacklisted = routed.blacklisted;
  } catch (error) {
    return failed(error);
  }

  // 黑名单：那一次路由判定住户**正在交办**一项老板明确登记办不了的功能。**纯代码**
  // 真话回复、零出站，不回主生成（否则又会绕回同一件事）。路由没选 `blocked:<id>`
  // 时 `blacklisted` 为 null，这段走不到。
  if (blacklisted) {
    // **资格复核**（判据写死在**条目自己**身上，不是引擎里的主题分支）：老板 2026-09-13
    // 纠正"功能是精确行为、不是一类主题"。路由选中 `blocked:<id>` 只是模型判断"像在交办"；
    // 再用该条目的 `qualifier` 由纯代码确认原话确实同时具备本功能的必要信号（地漏 + 头发 +
    // 叫 / 让 / 请对方清理；点名收件人已由前门保证）。不通过就当作 `none` 落回完整流程——
    // **宁可漏判，不得误杀相邻行为**（墙面头发 / 疏通地漏 / 一般卫生 / 异味 / 讨论）。
    if (!blacklisted.qualifier(text)) {
      return {
        mode: "none",
        handling: null,
        featureId: null,
        blacklistedCapabilityId: null,
        usage,
      };
    }
    // **已获准的这一条例外（exact grant）**：资格复核已通过 ⇒ 原话确实在交办这一条，但
    // 该 id 已被精确授权，于是只**撤销黑名单拒绝**、按标准 `none` 落回**完整主流程**去执行；
    // 它**不**走 `APPROVED_FEATURES` 快路径（这份清单仍只是那两条快路径）。只认精确 id。
    if (options.grantedFeatureIds?.includes(blacklisted.id)) {
      return {
        mode: "none",
        handling: null,
        featureId: null,
        blacklistedCapabilityId: null,
        usage,
      };
    }
    return {
      mode: "blacklisted",
      handling: {
        status: "handled",
        reply: blacklistedReply(blacklisted),
        sms: null,
        decisionId: null,
      },
      featureId: null,
      blacklistedCapabilityId: blacklisted.id,
      usage,
    };
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
      blacklistedCapabilityId: null,
      usage,
      ...(reply.error ? { error: reply.error } : {}),
    };
  }

  if (!match)
    return {
      mode: "none",
      handling: null,
      featureId: null,
      blacklistedCapabilityId: null,
      usage,
    };

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

  return {
    mode: "feature",
    handling: execution.handling,
    featureId: match.id,
    blacklistedCapabilityId: null,
    usage,
  };
}
