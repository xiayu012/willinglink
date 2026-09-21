import type * as repo from "./repo";
import type { FeatureLlm, FeatureUsage } from "./feature-llm";
import type { LanguageDecision } from "./language";
import type { SmsDeliveryDeps } from "./sms-delivery";

/**
 * **已批准功能的公共类型——只有形状，没有行为。**
 *
 * 每个功能是一个**真正的独立入口**（`ApprovedFeature` 的实现），自己写小 schema、
 * 小提示词与判据，各写各的朴素代码；这里只声明"功能入口长什么样"，好让代码里那份
 * **写死的已批准功能清单**能统一驱动路由。**这不是通用功能框架**：识别、字段、
 * 正文、回执全在各功能模块里，公共类型不替它们做任何判断。
 *
 * 老板 2026-09-13 决策（默认宽容）：这份已批准清单**不是权限边界**，而是一条
 * **低成本、稳定的优化快路径**。识别分两步：**清单内的路由**只调用一次模型，回答
 * "是不是明确交办清单里的某一项"（`features.ts` 的 `runApprovedFeature`）；命中后
 * 才调**被选中那一个功能自己**的 `extract` 抽取获准字段。因此功能模块只需要
 * `extract`（抽取本功能字段），不再各自回答 match/no-match——判断在路由那一次调用里。
 * **没命中不等于拒绝**：路由返回 none 就落回完整 doctrine + 运行时主生成（那里有
 * 恢复的通用短信联系能力）；真正办不了的只有老板明确登记的**黑名单**（`blacklist.ts`）。
 *
 * **黑名单接在同一次路由里**（`blocked:<id>` token），不按关键词、不加第二次模型调用。
 * 它和这里的两项快路径一样，只在**原话点名了唯一一位同住人**时才会被前门看到——所以
 * **现在的黑名单定义面同样是"对点名的同住人执行某个功能"这一类**，不要假装它已经覆盖
 * 任意未来功能；要覆盖更多形态得先扩展前门。
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
};

export type FeatureContext = {
  /** 住户原始原话。**只在功能入口内部（收件人绑定 + 抽取）用** */
  text: string;
  members: readonly repo.Member[];
  senderPersonId: string;
  householdId: string;
  channel: string;
  senderIsTest: boolean;
  /**
   * 本轮住户语言判定。由前门（`features.ts` 的 `runApprovedFeature`）从 `turn.ts` 在
   * 轮次边界判一次后传进来的 `options.language` 注入；功能模块只往下传、**不自己重算**
   * ——正文与兜底回执都要说住户这一轮的语言，而这个判定不只取决于原话（还有会话回退），
   * 在功能模块里重算只会算出差的那一半。
   */
  language?: LanguageDecision;
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
  /**
   * **老板登记的中文功能名**：落 decision / 收据、`deliverSms` 的 `purposeLabel`、
   * 数据库那一侧、以及中文正文都用它，**一字不动**。
   */
  label: string;
  /**
   * 同一个功能的**自然英文显示名**：只在住户这一轮说英文时，用于给住户看的正文与
   * grounding 校验（取用只经 `feature-facts.ts` 的 `featureDisplayName`）。
   *
   * 与 `label` **并排登记在功能模块这一处**，不是第二份清单；它**不进**台账、
   * 数据库标签或内部路由——那些仍用 `label` / `id`。黑名单条目的名称与理由也不走这里
   * （那是老板登记的原话与安全事实，照旧原样引用）。
   */
  labelEn: string;
  /**
   * 给**内部路由**看的一句话功能定义（只描述"这一件"是什么，不进入任何正文，
   * 也不是给主生成模型的措辞）。
   */
  routeDescription: string;
  /**
   * 命中后只抽取本功能获准字段（不再回答 match）。
   * `language` 是本轮住户语言判定，照原样传给模型调用——**不要在功能模块里重算**。
   */
  extract(
    text: string,
    llm: FeatureLlm,
    language?: LanguageDecision
  ): Promise<FeatureExtraction>;
  /** 绑定收件人 → 用收窄字段生成正文 → 投递；返回可投递结果与自己的用量。 */
  execute(
    extraction: FeatureExtraction,
    ctx: FeatureContext,
    deps: FeatureDeps
  ): Promise<FeatureExecution>;
};
