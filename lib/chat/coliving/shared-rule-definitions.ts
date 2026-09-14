/**
 * 共同规则定义登记册（Shared-Rule Definition Registry）——**确定性数据 + 纯函数，不调模型**。
 *
 * 一条**全屋共同规则**定案后，系统要对本栋房子开放它对应的**精确功能**。当前唯一登记的规则是
 * 「**每个人洗完澡后清理地漏里的头发**」，对应 `blacklist.ts` 里那条精确黑名单功能
 * `ask-named-roommate-clean-shower-drain-hair`（对**这一户**加一条豁免，**绝不动黑名单本身**）。
 *
 * 「规则 ↔ 功能」必须**写死、精确到具体行为**：不能让模型事后从自由文本猜，也不能因「话题
 * 相近」就算同一件事。登记册按顺序取**第一个**命中，各定义必须互斥；当前正式定义只有一条。
 *
 * ## 本文件是共同规则的**唯一事实源**，且**不 import `rule-consultation-session.ts`**
 *
 * 窄识别的正则 / 纯函数与中性事实全放本文件；`rule-consultation-session.ts` 将来**单向 import
 * 本文件**。反向 import 会形成 session ↔ registry 循环依赖，禁止。`grantsFeatureId` 就是
 * `blacklist.ts` 那条功能的稳定 id，放行前用 `blacklistedCapabilityById` **精确核对**（对不上不放行）。
 *
 * 每项 = `id`（稳定身份，写进日志、定案后按 id 查表）+ `canonicalFact`（固定中性事实，**绝不带
 * 发起人原句**：姓名 / 指责 / 私人理由）+ `grantsFeatureId`（唯一功能 id）+ `proposalQualifier`
 * （本定义自己的纯代码复核，不用 LLM、不按单个关键词放行，**宁可漏判，不得误杀相邻行为**）。
 *
 * 粒度：**一项 = 一个精确行为，不是「一类主题」**（老板 2026-09-13）：是主题就拆成多条。
 */

/* ------------------------------------------------------------------ *
 * 窄识别：「每个人洗完澡后清理地漏里的头发」这一条规则的纯代码判据
 * ------------------------------------------------------------------ */

/** 共同范围信号：全屋规则面向所有人，而不是点名某一个人。 */
const ALL_MEMBERS_SIGNAL =
  /每个人|每人|人人|大家|咱们|所有人|全员|全体|各位|每个住户|都该|都要/;
/** 立规则框架信号：在**立一条规则 / 约定**，不是交办一次具体整改。 */
const RULE_FRAMING_SIGNAL =
  /规则|规矩|约定|统一|说好|商量好|定个|定一个|定一条|立个|立一条|以后都|以后大家/;
/** 洗澡语境。 */
const SHOWER_SIGNAL = /洗澡|淋浴|洗浴|洗完澡/;
/** 地漏。 */
const DRAIN_SIGNAL = /地漏/;
/** 头发。 */
const HAIR_SIGNAL = /头发|毛发|发丝/;
/** 清走动作（两字以上明确动作短语，避免「洗」这类单字假信号）。 */
const CLEAN_AWAY_SIGNAL =
  /清掉|清理|清干净|清走|清一下|清一清|清光|清出去|弄掉|弄走|弄干净|弄出去|捡掉|捡走|捡起来|捡干净|拿走|拿掉|拿出去|收走|收拾|扫掉|扫走|掏掉|掏出来|掏干净|处理掉|处理干净|除掉|去除|去掉|冲掉/;
/** 局部分句分隔：地漏 + 头发 + 清走动作要落在同一分句。 */
const CLAUSE_SPLIT = /[。．.！!？?；;，,、\n\r]+|\s{2,}/;

/* --- 提案 guard：完整复述规则后接否定 / 引用 / 举例 / 设想，都**不是**提案 --- */

/** 否定 / 劝阻信号：整句在否决或反对。 */
const PROPOSAL_NEGATION_SIGNAL =
  /别定|不要定|不定了|别立|不要立|不同意|不赞成|不赞同|不认同|不接受|反对|没必要定|不用定|凭什么|为什么不能|干嘛要定|为啥要定/;
/** 引用 / 假设 / 举例信号：整句在复述、引用、打比方或设想，不是自己提案。 */
const PROPOSAL_REFERENCE_SIGNAL =
  /引用|说的是|指的是|意思是|什么意思|刚才说|之前说|不是要定|没说要定|只是举例|举个例子|打个比方|比方说|假设|假如|如果只是/;
/** 询问看法（好不好 / 怎么看 / 觉得 …）——但**没有**任何建立规则动词时不算提案。 */
const OPINION_SEEKING_SIGNAL =
  /觉得|认为|怎么看|怎么想|意见|好不好|行不行|该不该|是不是|对不对|赞不赞成/;
/** 建立规则的明确动词：出现它才说明「真的在提规则」，不再按「只问看法」放过。 */
const RULE_MAKING_VERB = /定个|定一个|定一条|立个|立一条|约定|说好|商量好|统一/;

/** 这条规则的中性固定事实：所有日志 / 措辞层只用这一句（来源隐私）。 */
export const SHARED_SHOWER_DRAIN_HAIR_RULE_FACT = "每个人洗完澡后清理地漏里的头发";

/** 原句里是否有一处「地漏 + 头发 + 清走动作」同处一个分句（只作必要条件，不留分句）。 */
function hasLocalDrainHairCleanupClause(text: string): boolean {
  return text.split(CLAUSE_SPLIT).some((clause) => {
    const c = clause.trim();
    return !!c && DRAIN_SIGNAL.test(c) && HAIR_SIGNAL.test(c) && CLEAN_AWAY_SIGNAL.test(c);
  });
}

/**
 * **窄识别入口**：这句话是不是「大家立一条『洗完澡后清理地漏头发』的共同规则」。
 *
 * 需**同时**：① 共同范围；② 立规则框架；③ 洗澡语境；④「地漏 + 头发 + 清走动作」在同一分句；
 * 且**不含**否定 / 引用 / 举例 / 设想信号，**也不是**「只问看法而无建立规则动词」。缺一即
 * `false`（不用 LLM，也不是单个关键词）——宁可漏判，不得误杀相邻行为。
 *
 * 命中规则事实一律收敛为 `SHARED_SHOWER_DRAIN_HAIR_RULE_FACT`，**不携带发起人原句**
 * （姓名 / 指责 / 私人理由）；单方面点名、墙面头发、地漏疏通、抱怨、只问看法都不命中。
 */
export function recognizeSharedShowerDrainHairRule(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (PROPOSAL_NEGATION_SIGNAL.test(t)) return false;
  if (PROPOSAL_REFERENCE_SIGNAL.test(t)) return false;
  if (OPINION_SEEKING_SIGNAL.test(t) && !RULE_MAKING_VERB.test(t)) return false;
  if (!ALL_MEMBERS_SIGNAL.test(t)) return false;
  if (!RULE_FRAMING_SIGNAL.test(t)) return false;
  if (!SHOWER_SIGNAL.test(t)) return false;
  return hasLocalDrainHairCleanupClause(t);
}

/** 一条**全屋共同规则**的正式定义（稳定身份 + 固定中性事实 + 唯一功能映射 + 自己的复核）。 */
export interface SharedRuleDefinition {
  /** 稳定 id：直接表达这一个具体行为，写进事件日志、按 id 查表。 */
  id: string;
  /** 固定中性事实文本：日志 / 投影 / 措辞层只用这一句，绝不携带发起人原句。 */
  canonicalFact: string;
  /** 定案后对本户开放的**唯一**功能 id（`blacklist.ts` 那条）；由放行前精确核对，无则空串。 */
  grantsFeatureId: string;
  /** 本定义自己的纯代码提案复核（见 `recognizeSharedShowerDrainHairRule`）。 */
  proposalQualifier: (text: string) => boolean;
}

/** 当前唯一正式登记的这条共同规则的稳定 id。 */
export const SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID =
  "shower-drain-hair-after-use-v1";

/**
 * 这条共同规则的固定中性事实文本——**唯一事实源就在本文件**（`SHARED_SHOWER_DRAIN_HAIR_RULE_FACT`），
 * 状态机 / 措辞层 / 登记册都取它，三处**逐字一致**（不会各写一份而漂移）。
 */
export const SHOWER_DRAIN_HAIR_AFTER_USE_CANONICAL_FACT =
  SHARED_SHOWER_DRAIN_HAIR_RULE_FACT;

/**
 * 这条规则定案后对本户开放的**精确功能 id**——`blacklist.ts` 里「单方面叫别人在洗完澡后清理
 * 地漏头发」那条的稳定 id。这里**只是登记映射**：**不动黑名单本身**（它仍全局默认生效），
 * 放行时用 `blacklistedCapabilityById` 精确核对（表里没有就不放行）。单方面整改与共同规则是
 * **两件事**（见 `rule-consultation-session.ts` 开头），本映射只在共同规则定案后对本户解禁它。
 */
export const SHOWER_DRAIN_HAIR_AFTER_USE_GRANTS_FEATURE_ID =
  "ask-named-roommate-clean-shower-drain-hair";

/**
 * **正式登记的共同规则定义。** 顺序有意义：`recognizeSharedRuleDefinition` 取**第一个**
 * 命中的定义，因此各定义必须彼此互斥。今天只有一条。
 *
 * `proposalQualifier` 直接用本文件定义的窄识别入口 `recognizeSharedShowerDrainHairRule`：
 * 要求**同时**满足共同范围信号、立规则框架、洗澡语境、「地漏 + 头发 + 清走动作」落在同一分句，
 * 且**不是**复述后的否定 / 引用 / 举例 / 设想，也**不是**只问看法而无建立规则动词。
 */
export const SHARED_RULE_DEFINITIONS: readonly SharedRuleDefinition[] = [
  {
    id: SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID,
    canonicalFact: SHOWER_DRAIN_HAIR_AFTER_USE_CANONICAL_FACT,
    grantsFeatureId: SHOWER_DRAIN_HAIR_AFTER_USE_GRANTS_FEATURE_ID,
    proposalQualifier: recognizeSharedShowerDrainHairRule,
  },
];

/**
 * 按 **稳定 id 精确**取回定义：**只有完全相等才命中**（不做大小写折叠、不认前缀）。
 * 表里没有的 id 一律 `null`——这是「定案后只按 id 查表、不再从自由文本重新匹配」的落点。
 */
export function sharedRuleDefinitionById(id: string): SharedRuleDefinition | null {
  const key = typeof id === "string" ? id.trim() : "";
  if (!key) return null;
  return SHARED_RULE_DEFINITIONS.find((d) => d.id === key) ?? null;
}

/**
 * 把一句自然语言匹配到**已登记的共同规则定义**（纯代码，逐条跑各定义自己的
 * `proposalQualifier`，取第一个命中的）。命中返回**登记册里的定义对象**——它的每个字段都是
 * 登记册常量（`id` / `canonicalFact` / `grantsFeatureId`），**绝不携带住户原句**：
 * 即使原话里点名了某人、带了指责或私人理由，也不会被当作规则文本外传（来源隐私）。
 *
 * 这不是「话题分类器」：没命中任何定义就是 `null`，调用方应落回普通流程，
 * **不要**把它当成拒绝。
 */
export function recognizeSharedRuleDefinition(
  text: string
): SharedRuleDefinition | null {
  for (const def of SHARED_RULE_DEFINITIONS) {
    if (def.proposalQualifier(text)) return def;
  }
  return null;
}
