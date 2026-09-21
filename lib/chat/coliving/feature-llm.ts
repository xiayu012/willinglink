import "server-only";

import { NoOutputGeneratedError, generateText } from "ai";
import type { z } from "zod";
import { getLanguageModel } from "@/lib/ai/providers";
import { trackedGatewayCall } from "./gateway-ledger";
import {
  languageInstruction,
  residentLanguageInstruction,
  type LanguageDecision,
} from "./language";

/**
 * **功能入口内部那几次模型调用的公共管道——纯代码，不定义功能、不管边界。**
 *
 * 每个已批准功能自己写小 schema + 小提示词（一功能一模块，不强行抽象），但"怎么把
 * 提示词发出去、怎么取结果、怎么记 gateway 账"是所有功能一样的机械动作，收在这里，
 * 避免每个功能各抄一遍 `generateText` 接线、漏掉计费台账。
 *
 * ## 只用最朴素的纯文本协议，不碰原生结构化输出
 *
 * 生产模型（DeepSeek，见 `model.ts`）与当前 AI SDK beta 的**原生结构化输出不兼容**：
 * `Output.object` 先后返回过不同字段名 / 类型的对象（`{"id": …}`、`{"type": …}`），
 * 换成 `Output.choice` 后模型又回了 `{"name":"night_laundry"}`，SDK 直接报
 * "response must be an object that contains a choice value"。继续调 schema 是打地鼠。
 *
 * 所以这里**不用** `Output.object` / `Output.choice` / `Output.json`，**不用 tool
 * calling，不加任何重试**：每一次功能调用都是**一次普通 `generateText`**，拿到模型
 * 的纯文本后，由**纯代码**解析：
 *
 *   1. **路由**（`features.ts` 的 `routeApprovedFeature`）：提示模型最终只输出**一个
 *      裸白名单 token**（`none` / 各功能 id）。代码只接受 `trim()` 后**精确等于**清单
 *      里的 id 的值；JSON、带解释的整句、清单外的词……一律不命中（安全当 `none`，
 *      绝不执行清单外功能）。
 *   2. **抽取**（`:<id>:extract`）与**生成**（`:<id>:compose`）：提示模型只输出一个
 *      固定形状的 JSON 对象；公共层 `parseFeatureJson` 从文本里取出**单个** JSON
 *      对象并 `JSON.parse`，再交给调用方传入的 Zod schema `safeParse` **严格校验**。
 *      允许常见的 markdown 代码围栏（```json … ```），但**不做任意字段名兼容、不做
 *      宽松猜测**：解析或校验失败 = **安全不发送**，抛带 stage 诊断的
 *      `FeatureCallError`，**不重试**。
 *
 * `generate` 返回模型原始文本；抽取 / 生成经 `structuredCall` 收窄成结构值。这样功能
 * 模块可以各写各的具名类型，不需要在这里引入一个通用泛型框架。
 *
 * **这些调用都很短，必须给 `maxOutputTokens` 封顶**（`FeatureCallBase` 里必填），
 * 不允许任何一条短调用变成无上限输出；但上限要**给足推理空间**（见下面
 * `FEATURE_*_MAX_OUTPUT_TOKENS`），不能小到在文本产出前就截断。
 *
 * **用量绝不丢**：`generate` 成功时带回 `generateText` 的 step / token / gateway cost；
 * 抛错时已完成 step 的真实用量也会随 `FeatureCallError` 带出来。`parseFeatureJson`
 * 失败同样把这次 `generate` 的用量挂进 `FeatureCallError`——**哪怕 JSON 不合格、被
 * 推理把额度耗尽，这笔钱也已经花了，不能因为抛错就记 0**。
 *
 * **失败也要可诊断**：`FeatureCallError.message` **一律以 `stage=<阶段名>` 开头**
 * （路由 / 抽取 / 生成哪一步），随后是 `NoOutputGeneratedError` 的 cause，或解析 /
 * 校验诊断里**截断后的模型文本片段**；原始错误挂 `cause`，**绝不复制 system / user
 * 提示词**（那里可能有住户原话）。
 *
 * **免费离线测试用 mock 注入 `FeatureLlm`**：mock 只返回模型会返回的**原始文本**，
 * 真实解析 / 校验代码照跑——不调模型、不花钱，就能验证白名单精确解析、JSON 形状、
 * 坏 JSON / 多对象失败，以及功能模块到底把什么喂给了"生成"这一步。
 */

/** 与 `turn.ts` 的 `TurnUsage` 同形，让功能轮的用量能并回轮次台账。 */
export type FeatureUsage = {
  steps: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** gateway 报的真实计费金额（美元）。不是估算。 */
  costUsd: number;
};

export const EMPTY_FEATURE_USAGE: FeatureUsage = {
  steps: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costUsd: 0,
};

export function addFeatureUsage(
  a: FeatureUsage,
  b: FeatureUsage
): FeatureUsage {
  return {
    steps: a.steps + b.steps,
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/**
 * **短调用的输出上限（防截断，不是性能调优）。**
 *
 * 生产模型（DeepSeek V4.1 Flash，见 `model.ts`）是推理模型：**reasoning tokens 计入
 * `maxOutputTokens`**。128 / 320 / 1024 这种旧上限会在模型吐出正文 / JSON 之前就被推理
 * 消耗完 → `finishReason: "length"`（推理把额度用光，一个字段都产不出来）。真实 034
 * 复现过：日志只剩「No output generated.」而看不出是哪一步。
 *
 * 所以每一档都给一个**给足推理空间的保守上限**：这些输出实际极短（一个 token、两个
 * 字段、一条短信 + 一句回执），4096 是「推理 + 很短输出」的宽裕余量，硬上限照旧存在，
 * 不会变成无上限输出。数值不是精确预算；正式验收仍是真实语料逐轮人工阅读
 * （见 `docs/USER_FACING_CAPABILITY_TRUTH.md`）。
 */
export const FEATURE_ROUTE_MAX_OUTPUT_TOKENS = 4096;
export const FEATURE_EXTRACT_MAX_OUTPUT_TOKENS = 4096;
export const FEATURE_COMPOSE_MAX_OUTPUT_TOKENS = 4096;
/**
 * `reply_only` 小回复（不是功能、无工具、无出站）的输出上限。输出只有一两句自然回应，
 * 与其它短调用同一档，同样给足推理空间。
 */
export const FEATURE_REPLY_ONLY_MAX_OUTPUT_TOKENS = 4096;
/**
 * 统一功能问答（不是功能、无工具、无出站）的输出上限。住户问「你有什么功能 / 为什么
 * X 不能做 / 刚才为什么拒绝」这类产品功能边界时，回一两句自然中文；输出同样极短，
 * 与其它短调用同一档，给足推理空间。
 */
export const FEATURE_QA_MAX_OUTPUT_TOKENS = 4096;
/**
 * 任何短调用的输出上限下限（防回归到会在推理中途截断的值）。4096 是当前各档统一
 * 采用值；离线检查据此断言实际调用不会低于它。
 */
export const FEATURE_MIN_OUTPUT_TOKENS = 4096;

/**
 * 三种调用共用的字段（阶段名 / 输出名 / 提示词 / 输出上限）。
 *
 * `name` 只是**台账与 mock 用的调用标识**，不是 schema 名、更不是给主模型看的工具名。
 */
export type FeatureCallBase = {
  /** 计费台账用的阶段名，约定 `feature:route` / `feature:<id>:extract` / `feature:<id>:compose` */
  stage: string;
  /** 调用标识（台账 / mock / 报告用），不是工具名。 */
  name: string;
  system: string;
  user: string;
  /**
   * 输出 token 硬上限。**必填**：这些都是短调用（路由一个 token、抽取几个字段、
   * 生成一条短信加一句回执），不给上限就可能被 provider 默认值放大成大段输出。
   */
  maxOutputTokens: number;
  /**
   * 本轮住户语言判定（`language.ts` 的 `decideLanguage`）。**给了就用它**。
   *
   * 为什么必须能显式传：这里的语言指令原先一律从 `call.user` 现推，而
   * `<id>:compose` 那一步的 `call.user` **不是住户原话**，是 `composeUser(...)`
   * 拼出来的**中文字段清单**（`收件人：…／涉及的物品：…`）。于是住户用英文交办时，
   * 生成正文那一步拿到的语言指令反而是中文——快路径正文的语言从源头就是错的。
   * 轮次判定必须**从外面传进来**，不能在这里由 `user` 反推。
   */
  language?: LanguageDecision;
};

/**
 * **抽取 / 生成调用**：模型只输出一个固定形状的 JSON 对象，公共层 `structuredCall`
 * 解析后用这里传入的 `schema` 严格校验。`schema` 由各功能模块自己写（不强行共用），
 * 校验通过的值按各自 schema 收窄。
 */
export type FeatureStructuredCall = FeatureCallBase & {
  schema: z.ZodType;
};

/**
 * 功能模型调用的唯一注入接口：**一次纯文本生成，返回模型原始文本**。
 *
 * 路由的裸 token、抽取 / 生成的 JSON 都在 `text` 里，由**调用方之外的纯代码**解析
 * （`routeApprovedFeature` 的精确比对 / `structuredCall` 的 `parseFeatureJson`）。
 * 因此离线 mock 只要返回"模型会返回的文本"，真实解析 / 校验逻辑就会照跑。
 */
export type FeatureLlm = {
  generate(call: FeatureCallBase): Promise<{ text: string; usage: FeatureUsage }>;
};

/**
 * 功能调用失败时抛出的错误，**带上已经发生的真实用量**（可能为 0）。
 *
 * 为什么要带用量：模型吐出的文本解析不出合格 JSON、被 provider 截断等情况都会抛错，
 * 但请求已经发出去、token 已经花掉；抛错方的 `result.steps` 拿不到，只能靠调用时自己
 * 捕获的 step 记下来。上层用 `usageOfFeatureError` 把它加进本轮台账，**不把失败当 0**。
 *
 * `message` **一定带 `stage=<阶段名>` 前缀**：无论哪种错误，失败日志都要能一眼定位是
 * 路由 / 抽取 / 生成哪一步出的问题（真实 034 的日志只剩「No output generated」、看不出
 * stage，无法排查）。前缀之后是**收窄后的诊断摘要**（`featureErrorDiagnostics` 的
 * `NoOutputGeneratedError` cause，或解析 / 校验失败的截断文本），原始错误挂 `cause`，
 * **绝不复制 system / user 提示词**。
 */
export class FeatureCallError extends Error {
  readonly usage: FeatureUsage;
  /** 出错的阶段名（`feature:route` / `feature:<id>:extract` / `feature:<id>:compose`）。 */
  readonly stage: string;

  constructor(
    stage: string,
    cause: unknown,
    usage: FeatureUsage,
    message?: string
  ) {
    const detail =
      message ?? (cause instanceof Error ? cause.message : String(cause));
    // 无论错误类型（解析失败 / NoOutputGeneratedError / 其它），message 一律带 stage，
    // 失败日志必须能定位到是哪一步。
    super(`stage=${stage}: ${detail}`);
    this.name = "FeatureCallError";
    this.stage = stage;
    this.usage = usage;
    // 保留原始错误对象，方便上层与日志定位；message 只放**收窄后的诊断摘要**，
    // 绝不含 system / user 提示词。
    this.cause = cause;
  }
}

/** 从一个错误里取出可计入本轮台账的功能用量；不是功能调用错误就是 0。 */
export function usageOfFeatureError(error: unknown): FeatureUsage {
  return error instanceof FeatureCallError
    ? error.usage
    : { ...EMPTY_FEATURE_USAGE };
}

const FEATURE_ERROR_TEXT_LIMIT = 200;

/** 诊断用短片段：压成一行并截断，避免把整段模型输出塞进错误消息。 */
function truncateForDiagnostics(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > FEATURE_ERROR_TEXT_LIMIT
    ? `${oneLine.slice(0, FEATURE_ERROR_TEXT_LIMIT)}…`
    : oneLine;
}

/**
 * 给失败的功能调用拼一条可诊断的短消息。**绝不包含 system / user 提示词**（那里可能
 * 有住户原话），文本片段一律截断。
 *
 * 显式识别 `NoOutputGeneratedError`（推理耗尽上限 / `finishReason !== "stop"` 时 SDK
 * 在输出阶段抛的裸错误）：它没有 text / response / usage，至少留下错误名与 cause 供
 * 定位。都不是就返回 null（由调用方回落到默认 message；stage 前缀由 `FeatureCallError`
 * 统一加）。
 */
export function featureErrorDiagnostics(error: unknown): string | null {
  if (NoOutputGeneratedError.isInstance(error)) {
    const parts = ["NoOutputGeneratedError"];
    if (error.cause instanceof Error && error.cause.message) {
      parts.push(`cause=${truncateForDiagnostics(error.cause.message)}`);
    }
    return parts.join("; ");
  }
  return null;
}

/** 功能调用超时。小提示词、短输出，60 秒足够；可用环境变量覆盖。 */
const FEATURE_CALL_TIMEOUT_MS = Number(
  process.env.COLIVING_FEATURE_TIMEOUT_MS ?? 60_000
);

type StepLike = {
  providerMetadata?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  };
};

/** 从一次调用的 step 里读真实用量与计费（与 turn.ts 的 sumUsage 同一口径）。 */
function usageFromSteps(steps: readonly StepLike[]): FeatureUsage {
  const out: FeatureUsage = { ...EMPTY_FEATURE_USAGE, steps: steps.length };
  for (const step of steps) {
    const meta = step.providerMetadata as
      | {
          anthropic?: { usage?: Record<string, number> };
          gateway?: { cost?: string };
        }
      | undefined;
    const a = meta?.anthropic?.usage;
    if (a) {
      out.inputTokens += a.input_tokens ?? 0;
      out.cacheReadTokens += a.cache_read_input_tokens ?? 0;
      out.cacheWriteTokens += a.cache_creation_input_tokens ?? 0;
      out.outputTokens += a.output_tokens ?? 0;
    } else if (step.usage) {
      const u = step.usage;
      const read =
        u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0;
      out.inputTokens += Math.max((u.inputTokens ?? 0) - read, 0);
      out.cacheReadTokens += read;
      out.cacheWriteTokens += u.inputTokenDetails?.cacheWriteTokens ?? 0;
      out.outputTokens += u.outputTokens ?? 0;
    }
    const cost = Number(meta?.gateway?.cost);
    if (Number.isFinite(cost)) {
      out.costUsd += cost;
    }
  }
  return out;
}

/**
 * **一次功能模型调用的公共外壳**：超时、temperature 0、输出封顶、gateway 计费台账、
 * 失败用量回收与 stage 诊断。三种调用走同一套，不各抄一遍。
 *
 * 自己再捕获一份 step：成功时用 `result.steps`（权威），**失败时用这份**——抛错拿不到
 * `result.steps`，但已经完成的 step 是真的花了钱，必须能带出去。
 * `rec.stepOptions.onStepFinish`（有评测台账时才有）照样要调，两个都做。
 */
async function runFeatureGeneration(
  call: FeatureCallBase,
  modelId: string
): Promise<{ text: string; usage: FeatureUsage }> {
  const captured: StepLike[] = [];
  try {
    const result = await trackedGatewayCall(call.stage, modelId, (rec) =>
      generateText({
        abortSignal: AbortSignal.timeout(FEATURE_CALL_TIMEOUT_MS),
        model: getLanguageModel(modelId),
        // 判定与正文都要稳定复现，不要花样；措辞的自然由提示词里的收窄字段保证。
        temperature: 0,
        // 短调用一律封顶，不允许无上限输出。
        maxOutputTokens: call.maxOutputTokens,
        // Every short feature path (route, extraction, reply-only, and feature
        // Q&A) shares this boundary. The router returns a token, while any
        // resident-facing JSON strings must follow the resident's language.
        //
        // 语言取**轮次判定**（`call.language`），只有在调用方没给的时候才退回
        // 从 `call.user` 现推——那条退路对 `:compose` 是错的（`user` 是拼出来的
        // 中文字段清单，不是住户原话），只为兼容还没接上判定的旧调用而留。
        system: `${call.system}\n\n${
          call.language
            ? languageInstruction(call.language)
            : residentLanguageInstruction(call.user)
        }`,
        prompt: call.user,
        ...rec.stepOptions,
        onStepFinish: (step) => {
          captured.push(step as StepLike);
          return rec.stepOptions.onStepFinish?.(step);
        },
      })
    );
    return {
      text: result.text,
      usage: usageFromSteps(result.steps as readonly StepLike[]),
    };
  } catch (error) {
    // 失败也带出已发生的真实用量：用抛错前已完成的 step（带 gateway cost），一步都
    // 没完成时就是全 0——**不是"没花钱"，是这一步读不到 token**（真实计费另由
    // gateway 台账记）。诊断摘要放进 message，原始错误挂 cause，不复制提示词。
    const usage = usageFromSteps(captured);
    throw new FeatureCallError(
      call.stage,
      error,
      usage,
      featureErrorDiagnostics(error) ?? undefined
    );
  }
}

/** 生产实现：用当前生产模型（见 `model.ts`）做一次纯文本生成，并过一个计费台账。 */
export function productionFeatureLlm(modelId: string): FeatureLlm {
  return {
    generate(call) {
      return runFeatureGeneration(call, modelId);
    },
  };
}

/**
 * 只接受**恰好一个** JSON 对象：允许整段被一个常见 markdown 代码围栏包住
 * （```json … ```），围栏里必须就是那个 JSON 对象本身。不剥离前后解释文字、
 * 不猜字段名——多对象 / 夹带文字会在这里（或随后的 `JSON.parse`）失败。
 */
const FENCED_JSON = /^```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)\n?```$/;

function toJsonCandidate(text: string): string {
  const trimmed = text.trim();
  const fenced = FENCED_JSON.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * **公共层的纯文本 → 结构值解析。** 从模型文本里取单个 JSON 对象并 `JSON.parse`，
 * 再用调用方传入的 `schema` `safeParse` 严格校验；任何一步失败都抛带 stage 的
 * `FeatureCallError`（**用量照带**，不重试，调用方安全不发送）。
 */
export function parseFeatureJson(
  text: string,
  schema: z.ZodType,
  stage: string,
  usage: FeatureUsage
): unknown {
  const candidate = toJsonCandidate(text);
  if (!candidate.startsWith("{")) {
    throw new FeatureCallError(
      stage,
      new Error("model text is not a single JSON object"),
      usage,
      `模型没有输出单个 JSON 对象；text=${truncateForDiagnostics(text)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (cause) {
    throw new FeatureCallError(
      stage,
      cause,
      usage,
      `JSON.parse 失败：${cause instanceof Error ? cause.message : String(cause)}` +
        `；text=${truncateForDiagnostics(text)}`
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new FeatureCallError(
      stage,
      result.error,
      usage,
      `schema 校验失败：${truncateForDiagnostics(result.error.message)}` +
        `；text=${truncateForDiagnostics(text)}`
    );
  }
  return result.data;
}

/**
 * 抽取 / 生成的统一入口：一次 `generate` → 纯文本 JSON 严格解析。校验失败时抛出的
 * `FeatureCallError` 已经带上这次 `generate` 的真实用量，上层照常并进本轮台账。
 */
export async function structuredCall(
  llm: FeatureLlm,
  call: FeatureStructuredCall
): Promise<{ value: unknown; usage: FeatureUsage }> {
  const { text, usage } = await llm.generate(call);
  return { value: parseFeatureJson(text, call.schema, call.stage, usage), usage };
}
