import type * as repo from "./repo";
import type { FeatureLlm, FeatureUsage } from "./feature-llm";
import type { SmsDeliveryDeps } from "./sms-delivery";

/**
 * **已批准功能的公共类型——只有形状，没有行为。**
 *
 * 每个功能是一个**真正的独立入口**（`ApprovedFeature` 的实现），自己写小 schema、
 * 小提示词与判据，各写各的朴素代码；这里只声明"功能入口长什么样"，好让代码里那份
 * **写死的已批准功能清单**能统一驱动路由。**这不是通用功能框架**：识别、字段、
 * 正文、回执全在各功能模块里，公共类型不替它们做任何判断。
 *
 * 老板 2026-09-13 定稿后识别分两步：**清单内的白名单路由**只调用一次模型，回答
 * "是不是明确交办清单里的某一项"（`features.ts` 的 `runApprovedFeature`）；命中后
 * 才调**被选中那一个功能自己**的 `extract` 抽取获准字段。因此功能模块只需要
 * `extract`（抽取本功能字段），不再各自回答 match/no-match——判断在路由那一次调用里。
 *
 * **用量必须一路带回来**：路由、抽取、生成每一步的 `usage` 都要向上传，哪怕没命中、
 * 失败或最终落回主生成，也不能丢（见 `FeatureCallError`）。
 */

/**
 * 抽取结果：本功能获准字段（`payload`，由各功能模块按自己的小 schema 收窄；路由不读它，
 * 只交给同功能的 `execute`）+ 这次抽取调用的真实用量。
 */
export type FeatureExtraction = {
  usage: FeatureUsage;
  payload: unknown;
};

/** 一次功能处理的产出：可投递的结果（没形成出站时为 null）+ 这次处理自己的用量。 */
export type FeatureExecution = {
  /** 收件人绑不上 / 生成不出正文时为 null（零出站，落回普通对话） */
  handling: FeatureHandling | null;
  /** `execute` 阶段（正文生成）自己的用量；路由与抽取的用量由调用方另行累加。 */
  usage: FeatureUsage;
};

/** 一次功能处理的产出，交给 `turn.ts` 落库与投递。 */
export type FeatureHandling = {
  status: "handled";
  /** 回给发起人的那句（模型生成；模型没给出安全短句时才用兜底） */
  reply: string;
  /**
   * 真的发给收件人的那条纯代码投递结果；收件人不可达时为 null（零出站）。
   */
  sms: {
    to: string;
    personId: string;
    text: string;
    communicationId: string;
  } | null;
  decisionId: string | null;
  /**
   * 仅 `unsupported` 保留轮有：**纯代码关联**到统一功能事实源（`feature-facts.ts`）
   * 的条目 id（关联不上就是 null；`turn.ts` 据此在 decision payload 里留一个很窄的
   * 结构化标记，供下一轮功能问答理解「刚才」）。不是自由文本，也不进正文。
   */
  unsupportedCapabilityId?: string | null;
};

export type FeatureContext = {
  /** 住户原始原话。**只在功能入口内部（收件人绑定 + 抽取）用** */
  text: string;
  members: readonly repo.Member[];
  senderPersonId: string;
  householdId: string;
  channel: string;
  senderIsTest: boolean;
};

export type FeatureDeps = {
  llm: FeatureLlm;
  delivery: SmsDeliveryDeps;
};

/**
 * 一个已批准功能。路由（`features.ts`，一次调用）决定"是不是这一件"；命中后：
 * `extract` 只抽取本功能获准字段，`execute` 绑定收件人、用收窄字段生成正文并投递。
 * **不命中（路由返回 none）就不执行**。两个功能各写各的朴素代码，允许重复。
 */
export type ApprovedFeature = {
  /** 功能 id。只用于台账、内部路由白名单与测试，**不是给主模型选的 functionId** */
  id: string;
  /** 落 decision / 收据时用的功能名 */
  label: string;
  /**
   * 给**内部路由**看的一句话功能定义（只描述"这一件"是什么，不进入任何正文，
   * 也不是给主生成模型的措辞）。
   */
  routeDescription: string;
  /** 命中后只抽取本功能获准字段（不再回答 match）。 */
  extract(text: string, llm: FeatureLlm): Promise<FeatureExtraction>;
  /** 绑定收件人 → 用收窄字段生成正文 → 投递；返回可投递结果与自己的用量。 */
  execute(
    extraction: FeatureExtraction,
    ctx: FeatureContext,
    deps: FeatureDeps
  ): Promise<FeatureExecution>;
};
