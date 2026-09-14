/**
 * 已定案投影 → 精确本户授权（Shared-Rule Grant Settlement）——**确定性收口，纯代码、不调模型**。
 *
 * 一条**全屋共同规则**在状态机里被**全员同意、定案**之后，本模块负责把「这条规则定案了」
 * 翻译成「**本户**开放它对应的那**一个**功能」这一条落盘授权。它是**唯一**把这两件事接起来
 * 的入口：调用方只交一份 `projectRule` 的投影，不需要自己拼 id、也不需要自己判断该不该写。
 *
 * ## 只有一条精确的 id 链能放行（绝不按话题 / 自由文本放行）
 *
 * 四个条件**缺一即 `not-eligible`**，且**一个文件、一个目录都不创建**：
 *
 * 1. `projection.state === "settled"`——未定案（`none` / `proposed` / `objected`）一律不放行；
 * 2. `projection.ruleDefinitionId` 是**非空字符串**——旧日志缺字段（`null`）、空串、空白
 *    都当作**未知**，不猜 id；
 * 3. `sharedRuleDefinitionById` **精确命中**（不做大小写折叠、不认前缀），且命中定义的 `id`
 *    必须**回指同一个 id**——未知 id 或返回的定义 id 对不上，都不放行；
 * 4. 命中的定义 `grantsFeatureId` **非空**，且 `blacklistedCapabilityById` **精确命中同一个
 *    id**——映射不在正式黑名单（或 id 对不上）就不放行。
 *
 * 因为全程只认**登记册里的常量 id**、不读规则正文，所以相邻行为（墙面头发、地漏疏通、
 * 单方面点名整改、别的主题规则）**不可能**借这条路径被放行——它们要么在提案时就没被登记册
 * 识别（定案日志里不会有这个 id），要么在 3 / 4 步被精确比对挡下。
 *
 * ## 写入 = 原样转交，不替调用方改写身份
 *
 * 放行后调用 `grantHouseholdFeature` 时**精确使用**：传入的 `householdId`、命中定义的
 * `grantsFeatureId`、命中定义的 `id`（作为 `sourceRuleDefinitionId`）。**幂等性靠 grant store**
 * （同一三元组重复调用不新增行），本模块不自己判重、不复制 grant store 逻辑。
 *
 * **写盘错误不吞**：任何 IO / 校验异常原样向上抛，由上层安全收口——本模块不假装写成功。
 */

import type { RuleProjection } from "../../coordination/rule-consultation";
import { blacklistedCapabilityById } from "./blacklist";
import {
  grantHouseholdFeature,
  type GrantHouseholdFeatureOptions,
  type GrantHouseholdFeatureResult,
  type HouseholdFeatureGrant,
} from "./household-feature-grants";
import {
  sharedRuleDefinitionById,
  type SharedRuleDefinition,
} from "./shared-rule-definitions";

/* ------------------------------------------------------------------ *
 * 结果：可判别联合（granted / already-granted / not-eligible）
 * ------------------------------------------------------------------ */

/**
 * 不放行的**稳定原因**（调用方 / 测试可据它区分，不要靠解析文案）：
 * - `not-settled` —— 投影不是 `settled`（`none` / `proposed` / `objected` 都归这里）。
 * - `missing-rule-definition-id` —— `ruleDefinitionId` 缺失（旧日志 `null`）、空串或空白。
 * - `unknown-rule-definition` —— id 非空但登记册里**精确**查不到。
 * - `definition-grants-no-feature` —— 命中定义没有可开放的 `grantsFeatureId`（空串）。
 * - `feature-not-blacklisted` —— 映射的功能 id 不在正式黑名单里（或表里 id 对不上）。
 */
export type SharedRuleGrantNotEligibleReason =
  | "not-settled"
  | "missing-rule-definition-id"
  | "unknown-rule-definition"
  | "definition-grants-no-feature"
  | "feature-not-blacklisted";

/**
 * 一次收口的结果：
 * - `granted` —— 本次**新写**了一条本户授权；
 * - `already-granted` —— 同三元组已存在，**没有新增行**（grant store 幂等）；
 * - `not-eligible` —— 条件不满足，**没有创建目录 / 文件**，`reason` 是稳定原因。
 */
export type SharedRuleGrantSettlementOutcome =
  | { status: "granted"; grant: HouseholdFeatureGrant }
  | { status: "already-granted"; grant: HouseholdFeatureGrant }
  | { status: "not-eligible"; reason: SharedRuleGrantNotEligibleReason };

/* ------------------------------------------------------------------ *
 * 依赖注入点（默认 = 生产登记册 / 黑名单 / grant store）
 * ------------------------------------------------------------------ */

/** 放行只看定义这两个字段；测试注入不必造完整的 `proposalQualifier`。 */
export type SharedRuleDefinitionLookup = Pick<
  SharedRuleDefinition,
  "id" | "grantsFeatureId"
>;

/** 黑名单核对只看稳定 id。 */
export interface BlacklistedCapabilityLookup {
  id: string;
}

/**
 * **仅供测试 / 特殊上层**注入的依赖；缺省一律用生产实现（生产调用不要传）。
 * 有了它，才能在不往生产注册表 / 黑名单里塞假条目的前提下，覆盖「映射不在黑名单」
 * 「定义没有功能 id」这类不可达分支。
 */
export interface SharedRuleGrantSettlementDeps {
  /** 缺省 `sharedRuleDefinitionById`（生产登记册，精确匹配）。 */
  definitionById?: (id: string) => SharedRuleDefinitionLookup | null;
  /** 缺省 `blacklistedCapabilityById`（生产黑名单，精确匹配）。 */
  blacklistedById?: (id: string) => BlacklistedCapabilityLookup | null;
  /** 缺省 `grantHouseholdFeature`（生产 grant store，幂等）。 */
  grant?: (opts: GrantHouseholdFeatureOptions) => GrantHouseholdFeatureResult;
}

/** `settleSharedRuleGrant` 的入参。 */
export interface SettleSharedRuleGrantOptions {
  /** 授权记录落盘目录（与 grant store 同一约定，由调用方决定；不放行就不建目录）。 */
  dir: string;
  /** 本户 id：**原样**转交 grant store，绝不替换成别的户。 */
  householdId: string;
  /** 状态机投影；本模块**只读** `state` 与 `ruleDefinitionId` 两个字段。 */
  projection: Pick<RuleProjection, "state" | "ruleDefinitionId">;
  /** 可选：覆盖 `grantedAt`（测试用）；缺省由 grant store 取当前时间。 */
  grantedAt?: string;
  /** 可选：依赖注入（缺省 = 生产）。 */
  deps?: SharedRuleGrantSettlementDeps;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

function notEligible(
  reason: SharedRuleGrantNotEligibleReason
): SharedRuleGrantSettlementOutcome {
  return { status: "not-eligible", reason };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * **唯一定案收口入口**：已定案投影 → 精确本户授权。
 *
 * 只有 `settled` + 非空 `ruleDefinitionId` + 登记册精确命中 + `grantsFeatureId` 非空且
 * 在正式黑名单里精确命中，才调用 `grantHouseholdFeature`；其余一律 `not-eligible`，
 * **不建目录、不写文件**。写盘错误原样抛出，不吞。
 */
export function settleSharedRuleGrant(
  options: SettleSharedRuleGrantOptions
): SharedRuleGrantSettlementOutcome {
  const definitionById = options.deps?.definitionById ?? sharedRuleDefinitionById;
  const blacklistedById = options.deps?.blacklistedById ?? blacklistedCapabilityById;
  const grant = options.deps?.grant ?? grantHouseholdFeature;

  // 1) 必须已定案（未全员同意绝不放行）。
  if (options.projection?.state !== "settled") return notEligible("not-settled");

  // 2) 稳定 id 必须存在（旧日志 null / 空串 / 空白 = 未知，不猜）。
  const ruleDefinitionId = options.projection.ruleDefinitionId;
  if (!isNonEmptyString(ruleDefinitionId)) {
    return notEligible("missing-rule-definition-id");
  }

  // 3) 登记册精确命中（未知 id 不放行），且命中定义的 `id` 必须回指同一个 id
  //    （查表实现串了条目 / 返回了别的定义，一律当作未知，绝不放行）。
  const definition = definitionById(ruleDefinitionId);
  if (!definition || definition.id !== ruleDefinitionId) {
    return notEligible("unknown-rule-definition");
  }

  // 4) 映射的功能 id 必须非空、且精确落在正式黑名单里（对不上不放行）。
  const featureId = definition.grantsFeatureId;
  if (!isNonEmptyString(featureId)) return notEligible("definition-grants-no-feature");
  const blacklisted = blacklistedById(featureId);
  if (!blacklisted || blacklisted.id !== featureId) {
    return notEligible("feature-not-blacklisted");
  }

  // 写入：精确用 传入 householdId + 命中的 featureId + 命中的定义 id（幂等交给 grant store）。
  const result = grant({
    dir: options.dir,
    householdId: options.householdId,
    featureId,
    sourceRuleDefinitionId: definition.id,
    grantedAt: options.grantedAt,
  });
  return result.appended
    ? { status: "granted", grant: result.grant }
    : { status: "already-granted", grant: result.grant };
}
