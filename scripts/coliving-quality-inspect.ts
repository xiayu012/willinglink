/** Offline regression by default; --judge additionally checks sanitized traces with the real judge.
 * No database imports, no send path. Run with NODE_OPTIONS=--conditions=react-server.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "dotenv";
// 评测报告页面的渲染器只有一处：这条闸直接 import 它来验"产出成对"，
// 顺带证明导入这个模块不会执行它的 CLI（见下面那条 check）。
import { reportHtmlPathFor, writeReportHtml } from "./coliving-report";
import { assembleSystemPrompt } from "../lib/ai/brains";
import {
  finalizeJudgment,
  JUDGE_DEFAULT_MODEL,
  judgeConversation,
  judgeGuideText,
  judgeModelId,
  type JudgeTurn,
} from "../lib/chat/coliving/evals/judge";
import { bestSchedulePlans } from "../lib/chat/coliving/scheduling";
import { CHANNELS } from "../lib/chat/types";
import {
  containsHan,
  decideLanguage,
  observeLanguage,
  residentLanguage,
  residentLanguageInstruction,
} from "../lib/chat/coliving/language";
import {
  HISTORY_BUDGET,
  planHistory,
} from "../lib/chat/coliving/history-policy";
import { scheduleAffirmationReply } from "../lib/chat/coliving/schedule-affirmation";
import * as membershipFacts from "../lib/chat/coliving/membership-facts";
import {
  countAcceptedOutbound,
  evaluateReplyReview,
  evaluateTurnExpectation,
  evaluateTurnReplyReviews,
  validateScenario,
  type TurnOutcome,
} from "../lib/chat/coliving/evals/schema";
import {
  buildGeneratorSystemMessages,
  claimsContactCompletion,
  claimsUnsentThirdPartyContact,
  checkProcessNarration,
  checkSourcePrivacy,
  extractExplicitFixedStart,
  extractPreferredStart,
  extractSlotFromInquiry,
  finalizeFeatureTurn,
  hasDeferredCoordination,
  isLowInformationFollowUp,
  isOpenConflictCase,
  isPrematureCapacityEscape,
  isPureNoticeReply,
  isScheduleFairnessObjection,
  isScheduleSlotInquiry,
  isSimpleAffirmation,
  isUnsolicitedContactClaim,
  uncoveredBlockedPersonIds,
  coordinationReplyForSender,
  ruleNoticeFallback,
  RULE_NOTICE_FALLBACK,
  RULE_NOTICE_FALLBACK_EN,
  scheduleInquiryConfirmation,
  selectUnsentContactFallback,
  STANCE_ACK_REPLY,
  STANCE_ACK_REPLY_EN,
  TRUTHFUL_UNSENT_REPLY,
  TRUTHFUL_UNSENT_REPLY_EN,
  UNKNOWN_REPLY,
  UNKNOWN_REPLY_EN,
  unknownSenderReply,
  type FeatureFinalizeDeps,
} from "../lib/chat/coliving/turn";
import type { OutboundAction, State } from "../lib/coordination/types";
// 已开放的两项受约束第三方出站：**功能是代码里写死的清单，功能不是工具**。
// 主生成的工具表里既没有短信工具、也没有功能工具；`features.ts` 的功能前门在
// `buildContext` 之后、主生成之前对照清单，用**一次内部白名单路由调用**判「是不是明确
// 交办清单里的某一项」（不是每个功能各判一次、不新增 tool schema），命中才让**被选中
// 那一个功能**抽取本功能获准字段写正文——生成阶段看不到原始混合请求——再由纯代码的
// `sms-delivery.ts` 绑定原话点名且唯一的收件人并落库。各功能各写各的朴素模块
// （`night-laundry-reminder.ts` / `personal-item-reminder.ts`），不强行抽象。
// 这里不调真实模型（用注入的 mock `FeatureLlm`）、不写库；正文质量仍然证明不了
// （见 docs/USER_FACING_CAPABILITY_TRUTH.md）。
import {
  APPROVED_FEATURES,
  FEATURE_ROUTE_NAME,
  FEATURE_ROUTE_NONE,
  FEATURE_ROUTE_REPLY_ONLY,
  FEATURE_ROUTE_STAGE,
  routeApprovedFeature,
  runApprovedFeature,
} from "../lib/chat/coliving/features";
import {
  EMPTY_FEATURE_USAGE,
  FeatureCallError,
  FEATURE_MIN_OUTPUT_TOKENS,
  featureErrorDiagnostics,
  FEATURE_REPLY_ONLY_MAX_OUTPUT_TOKENS,
  FEATURE_QA_MAX_OUTPUT_TOKENS,
  FEATURE_ROUTE_MAX_OUTPUT_TOKENS,
  structuredCall,
  usageOfFeatureError,
  type FeatureCallBase,
  type FeatureLlm,
  type FeatureUsage,
} from "../lib/chat/coliving/feature-llm";
import {
  REPLY_ONLY_FALLBACK,
  REPLY_ONLY_NAME,
  REPLY_ONLY_STAGE,
} from "../lib/chat/coliving/reply-only";
// 受约束回复的**共享确定性 grounding 闸**（假承诺 / 把球踢回住户 / 换渠道 / 等以后）：
// 功能问答这条无工具、无出站路径用的是这条规则。
import { findGroundingViolations } from "../lib/chat/coliving/feature-grounding";
// 统一的产品功能问答入口（**不是功能、不是工具、不出站**）：通用边界问句识别 + 只把
// `feature-facts.ts` 事实源里有关的事实交给模型说人话，越界回落只含事实源事实的兜底。
import {
  FEATURE_QA_MAX_CHARS,
  FEATURE_QA_MAX_CHARS_EN,
  FEATURE_QA_NAME,
  FEATURE_QA_STAGE,
  asksAboutSelf,
  asksWhatIsAvailable,
  featureQaFallback,
  featureQaMaxChars,
  findUngroundedFeatureQaFacts,
  generateFeatureQaReply,
  isFeatureQaQuestion,
  runFeatureQa,
} from "../lib/chat/coliving/feature-qa";
// 用户可见功能事实源（运行时读取的单点数据文件）：专门优化的开放功能（只作反向守卫）
// + 与问题有关的黑名单条目。
import {
  buildFeatureQaFacts,
  featureDisplayName,
  selectBlacklistedCapabilities,
  type FeatureDisplayName,
} from "../lib/chat/coliving/feature-facts";
// 住户会读到的自我介绍 / 能力说明的**唯一出处**（纯 Markdown，代码不改写一个字）：
// 这里读的是文件本身，用来核对兜底正文逐字等于那四段。
import {
  COORDINATOR_COPY_HEADINGS,
  COORDINATOR_COPY_RELATIVE_PATH,
  COORDINATOR_IDENTITY_ANCHORS,
  coordinatorCopyPath,
  coordinatorCopyText,
} from "../lib/chat/coliving/coordinator-copy";
// 显式黑名单事实源（当前一项：单方面叫别人在洗完澡后清理地漏头发）：复用那一次功能路由的
// `blocked:<id>` token，不按关键词阻断；纯代码解析 + 条目自己的 qualifier 资格复核，
// 是「这件事办不了」的唯一起源。
import {
  BLACKLISTED_CAPABILITIES,
  blacklistRouteToken,
  blacklistedCapabilityByRouteToken,
  blacklistedCapabilityById,
  blacklistedReply,
  qualifiesShowerDrainCleanupRequest,
} from "../lib/chat/coliving/blacklist";
import type {
  FeatureContext,
  FeatureDeps,
  FeatureHandling,
} from "../lib/chat/coliving/feature-types";
import {
  parseOpenRuleSessionIntent,
  recognizeSharedShowerDrainHairRule,
  resolveRuleActionRecipients,
  ruleSessionEventsFile,
  SHARED_SHOWER_DRAIN_HAIR_RULE_FACT,
} from "../lib/chat/coliving/rule-consultation-session";
// 共同规则的稳定定义 id：唯一事实源在登记册里，这里只 import 常量、**不复制魔法字符串**。
import { SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID } from "../lib/chat/coliving/shared-rule-definitions";
import {
  checkRuleInvariants,
  foldRule,
  projectRule,
  receiptEventFor,
  reduceRule,
  stepRule,
} from "../lib/coordination/rule-consultation";
import type { RuleEvent, RuleIntent } from "../lib/coordination/rule-consultation";
import {
  AMBIGUOUS_SMS_RECIPIENT_REPLY,
  AMBIGUOUS_SMS_RECIPIENT_REPLY_EN,
  NO_NAMED_RECIPIENT_REPLY,
  NO_NAMED_RECIPIENT_REPLY_EN,
  deliverSms,
  resolveNamedRecipient,
  smsRecipientIneligibleReply,
  type SmsDeliveryDeps,
} from "../lib/chat/coliving/sms-delivery";
import {
  NIGHT_LAUNDRY_FEATURE_ID,
  nightLaundryExtractionSchema,
  nightLaundryFallbackReceipt,
} from "../lib/chat/coliving/night-laundry-reminder";
import {
  PERSONAL_ITEM_FEATURE_ID,
  personalItemExtractionSchema,
  personalItemFallbackReceipt,
} from "../lib/chat/coliving/personal-item-reminder";
import { NoOutputGeneratedError } from "ai";
// 只留离线视图选择器：生产已只生成，quality 脚本不再断言批判器生产接线/选型。
import { selectCriticRubric } from "../lib/chat/coliving/critic";
import {
  COLIVING_DEFAULT_MODEL,
  colivingModelId,
} from "../lib/chat/coliving/model";
import { COORDINATION_INTENT_MODEL } from "../lib/coordination/llm";
import {
  BatchBudget,
  currentEvalLedger,
  EVAL_MAX_OUTPUT_TOKENS_CEILING,
  EVAL_MAX_OUTPUT_TOKENS_ENV,
  evalMaxOutputTokensOption,
  GatewayCostLedger,
  gatewayCostFromResult,
  isEvalBudgetExceeded,
  mergeLedgerSnapshots,
  parseEvalMaxOutputTokens,
  runWithEvalLedger,
  trackedGatewayCall,
  type GenerationRecord,
  type StepUsageRecord,
} from "../lib/chat/coliving/gateway-ledger";
import {
  COLIVING_GUIDANCE_TEXTS,
  isKnownGuidanceId,
  isMissingGuidanceArg,
  knownGuidanceIds,
  resolveGuidance,
  resolveGuidanceArg,
} from "../lib/chat/coliving/evals/guidance";
import { findUnknownPrivacyCardFlags } from "../lib/chat/coliving/evals/privacy-card-args";
import {
  claimsContactAlreadyMade,
  COORDINATION_ACTION_BASES,
  COORDINATION_ACTION_STATUSES,
  COORDINATION_CAPABILITY_ZONES,
  COORDINATION_DECISION_STAGES,
  COORDINATION_DISCLOSURE_PLANS,
  COORDINATION_REQUESTED_ACTIONS,
  COORDINATION_SOURCE_CONSTRAINTS,
  COORDINATION_SOURCE_TYPES,
  COORDINATION_USER_GOALS,
  PRIVACY_INFERENCE_RISKS,
  PRIVACY_OWNER_CONSENTS,
  PRIVACY_RECOMMENDED_ACTIONS,
  validatePrivacyCard,
  type CoordinationBasisEntry,
  type PrivacyCardContext,
  type PrivacyTurnCard,
} from "../lib/chat/coliving/evals/privacy-turn-card";
import {
  ACTION_AUTHORIZATIONS,
  ACTION_CAPABILITIES,
  ACTION_KINDS,
  ACTION_READINESS,
  ACTION_STATUSES,
  THIRD_PARTY_ACTION_KINDS,
  validateActionPlan,
  type ActionItem,
  type ActionPlan,
  type ActionPlanContext,
} from "../lib/chat/coliving/evals/action-plan";
import { findUnknownActionPlanFlags } from "../lib/chat/coliving/evals/action-plan-args";
import {
  normalizeContextReceipt,
  normalizePromptComposition,
  normalizeTurnLedgerSummary,
  renderContextEngineeringPanelHtml,
  renderContextReceiptHtml,
  renderPromptCompositionHtml,
  renderTurnLedgerHtml,
  summarizeTurnLedger,
} from "../lib/chat/coliving/ledger-report";
import {
  isContextRetrievalToolName,
  returnedCharsOf,
  retrievalObservationsFrom,
} from "../lib/chat/coliving/context-receipt";
import {
  ACTION_PLAN_SAMPLES,
  SIMPLE_GREEN_SAMPLE,
} from "../lib/chat/coliving/evals/action-plan-samples";

const TOOL_DECL_NAMES = [
  "sendReply", "decide", "logEvent", "proposeRule",
  "recordStance", "notePartyAffected", "pickSchedule", "chooseSchedule",
  "recordShare", "scheduleReminder", "recordPosition", "addResident",
  "confirmRoster", "renamePerson", "remember", "closeCase", "noteObservation",
  "recall", "lookupHistory", "findSimilarCases", "checkEnvironment",
];

/** 统计每个工具"声明区"（xxx: tool({ … execute: async 前）里字符串字面量的总字符。
 *  含 schema 的 .describe()/description 及 enum 常量值；不含 execute 实现。
 *  作为"工具描述膨胀会直接烧每步 token"的源码级护栏。 */
function toolDeclarationLiteralChars(src: string, toolNames: string[]): number {
  let total = 0;
  for (const name of toolNames) {
    const startRe = new RegExp(`\\n\\s{4}${name}: tool\\({`);
    const startIdx = src.search(startRe);
    if (startIdx < 0) continue;
    const execIdx = src.indexOf("execute: async", startIdx);
    const block = src.slice(startIdx, execIdx);
    const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      const raw = (m[1] ?? m[2] ?? "").replace(/\\(["'\\])/g, "$1");
      total += raw.replace(/\$\{[^}]*\}/g, "").length;
    }
  }
  return total;
}

async function main() {
  let count = 0;
  const check = (name: string, fn: () => void) => { fn(); count++; console.log(`PASS ${name}`); };
  // 少数检查需要 await（AsyncLocalStorage 并发隔离），单独一个异步版本。
  const checkAsync = async (name: string, fn: () => Promise<void>) => {
    await fn();
    count++;
    console.log(`PASS ${name}`);
  };
  const bad: JudgeTurn[] = [{
    fromName: "小林", said: "大家的时间都告诉你了，安排好了吗？",
    reply: "方案已经分别发给他们两位了。",
    outbound: [
      { toName: "小周", text: "你可以晚半小时吗？", blocked: true },
      { toName: "小陈", text: "你愿意先用半小时吗？", blocked: true },
    ],
  }];
  check("real delivered false-completion finding fails", () => {
    const r = finalizeJudgment([{ severity: "high", turnIndex: 0, issue: "两条联系均被拦却声称已发出", quote: bad[0].reply }], bad);
    assert.equal(r.verified, true); assert.equal(r.pass, false);
  });
  check("old blocked-contact trace cannot satisfy the outbound gate", () => {
    assert.equal(countAcceptedOutbound(bad[0].outbound), 0);
    assert.equal(countAcceptedOutbound([...bad[0].outbound, { blocked: false }]), 1);
  });
  check("generation-only review evidence: unverified-by-design passes, deterministic failure still fails", () => {
    assert.deepEqual(evaluateReplyReview(undefined).length, 1);
    // 生产只生成：`verified:false` 是设计如此（没有 LLM 审稿），只要没有代码可证的
    // 确定性失败（pass:true）就放行——不能把"按设计没审"当成"审了没通过"。
    assert.deepEqual(
      evaluateReplyReview({ mode: "generation-only", verified: false, pass: true, broke: "", why: "" }),
      []
    );
    // 模式缺省按 generation-only 处理（简化/历史调用点），同样不因 verified:false 判失败。
    assert.deepEqual(
      evaluateReplyReview({ verified: false, pass: true, broke: "", why: "" }),
      []
    );
    // 确定性核对不合格一律红灯，不管有没有 LLM 审稿。
    assert.equal(
      evaluateReplyReview({ mode: "generation-only", verified: false, pass: false, broke: "0", why: "假完成" }).length,
      1
    );
    // 显式 LLM 审稿（离线/历史路径）没真的跑起来判过，仍算门禁失败。
    assert.equal(
      evaluateReplyReview({ mode: "llm-review", verified: false, pass: true, broke: "", why: "模型超时" }).length,
      1
    );
    assert.deepEqual(
      evaluateReplyReview({ mode: "llm-review", verified: true, pass: true, broke: "", why: "" }),
      []
    );
  });
  check("an earlier red reply review cannot be hidden by a green last turn", () => {
    const failures = evaluateTurnReplyReviews([
      { verified: true, pass: false, broke: "7", why: "承诺未执行" },
      { verified: true, pass: true, broke: "", why: "" },
    ]);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /第1轮/);
  });
  check("per-turn expectation reuses the scene-level wording and enforces recipient scope", () => {
    // 场景级 expect 与逐轮 expect 共用这一个纯函数，失败措辞必须逐字一致。
    assert.deepEqual(
      evaluateTurnExpectation(
        { minAcceptedOutbound: 1 },
        { toolsUsed: [], reply: "", outbound: [] }
      ),
      ["应有至少 1 条通过审稿的出站，实际 0 条；调用联系工具不等于联系成功"]
    );
    // 未声明 expect 的轮次不受任何单轮约束：单轮场景行为逐字不变。
    assert.deepEqual(
      evaluateTurnExpectation(undefined, { toolsUsed: [], reply: "随便", outbound: [] }),
      []
    );
    const scope = {
      minAcceptedOutbound: 1,
      mustUseTools: ["contactPerson"],
      mustContactNames: ["甲"],
      mustNotContactNames: ["乙", "丙"],
    };
    const outcome = (
      outbound: Array<{ toName: string; text: string; blocked?: boolean }>
    ) => ({ toolsUsed: ["contactPerson"], reply: "已经跟甲说了，等他回话。", outbound });
    // 有一条通过审稿、发给甲、没碰别人 → 通过。
    assert.deepEqual(
      evaluateTurnExpectation(scope, outcome([{ toName: "甲", text: "…", blocked: false }])),
      []
    );
    // 只调了工具、出站被审稿拦下：不算联系上（minAcceptedOutbound + mustContactNames 各一条）。
    assert.equal(
      evaluateTurnExpectation(scope, outcome([{ toName: "甲", text: "…", blocked: true }])).length,
      2
    );
    // 越权联系乙：即使被审稿拦下，越权尝试本身也算失败。
    const overreach = evaluateTurnExpectation(
      scope,
      outcome([
        { toName: "甲", text: "…", blocked: false },
        { toName: "乙", text: "…", blocked: true },
      ])
    );
    assert.equal(overreach.length, 1);
    assert.match(overreach[0], /乙/);
  });
  check("outboundMustMatch only inspects accepted outbound, symmetric with outboundMustNotMatch", () => {
    const expect = { outboundMustMatch: ["换宿舍|分开住"] };
    const outcome = (
      outbound: Array<{ toName: string; text: string; blocked?: boolean }>
    ) => ({ toolsUsed: ["contactPerson"], reply: "已经问他了。", outbound });
    // 通过审稿的出站命中核心议题 → 通过。
    assert.deepEqual(
      evaluateTurnExpectation(
        expect,
        outcome([{ toName: "甲", text: "想问问你要不要分开住", blocked: false }])
      ),
      []
    );
    // 出站没命中 → 一条失败（这是正向证据：议题不能被软化掉）。
    const miss = evaluateTurnExpectation(
      expect,
      outcome([{ toName: "甲", text: "想聊聊接下来怎么住", blocked: false }])
    );
    assert.equal(miss.length, 1);
    assert.match(miss[0], /没有命中该出现的模式/);
    // 被审稿拦下的草稿不算送达：命中也不算通过（与 MustNotMatch 只查通过的出站对称）。
    assert.equal(
      evaluateTurnExpectation(
        expect,
        outcome([{ toName: "甲", text: "要不要分开住", blocked: true }])
      ).length,
      1
    );
    // 未声明 outboundMustMatch 的场景行为逐字不变。
    assert.deepEqual(
      evaluateTurnExpectation(
        {},
        outcome([{ toName: "甲", text: "随便走走", blocked: false }])
      ),
      []
    );
    // 场景接线：corpus-031 最后一轮必须带这条正向证据，且整个 JSON 能被 schema 接受。
    const raw = JSON.parse(
      readFileSync(
        "lib/chat/coliving/evals/scenarios/corpus-031-reddit-repeated-relay-2026-09-11.json",
        "utf8"
      )
    );
    const scenario = validateScenario(raw, "corpus-031.json");
    const last = scenario.turns[scenario.turns.length - 1];
    const issuePatterns = last.expect?.outboundMustMatch ?? [];
    assert(issuePatterns.length > 0, "corpus-031 最后一轮要求出站命中核心议题");
    const issueHit = (text: string) => issuePatterns.some((p) => new RegExp(p).test(text));
    // 语义明确的等价说法都算命中：换宿舍/分开住/要不要继续一起住。
    for (const hit of [
      "问你要不要换宿舍",
      "聊聊要不要分开住",
      "聊聊以后怎么住、要不要继续一起住这件事",
      "问他还愿不愿意一起住",
    ]) {
      assert(issueHit(hit), `核心议题断言应命中：${hit}`);
    }
    // 只含糊说"聊聊以后怎么住/近况"不算——议题没传达到，正向证据必须红灯。
    for (const miss of ["聊聊以后怎么住", "聊聊近况", "想跟你坐下来谈谈"]) {
      assert(!issueHit(miss), `核心议题断言不该放过含糊说法：${miss}`);
    }
  });
  check("corpus-031 第 1 轮回归哨兵：出站须保留收件人自购义务，禁止把义务转给来源人（只认通过审稿的出站）", () => {
    const raw = JSON.parse(
      readFileSync(
        "lib/chat/coliving/evals/scenarios/corpus-031-reddit-repeated-relay-2026-09-11.json",
        "utf8"
      )
    );
    const scenario = validateScenario(raw, "corpus-031.json");
    const expect = scenario.turns[0].expect ?? {};
    assert(
      (expect.outboundMustMatch ?? []).length > 0,
      "第 1 轮必须正向要求出站保留收件人自购要点"
    );
    assert(
      (expect.outboundMustNotMatch ?? []).length > 0,
      "第 1 轮必须反向禁止把收件人的义务改记到来源人头上"
    );
    const outcome = (
      outbound: Array<{ toName: string; text: string; blocked?: boolean }>
    ) => ({
      toolsUsed: ["contactPerson"],
      reply: "已经跟小浩说了，在等他回话。",
      outbound,
    });
    // 通过审稿、正确保留「收件人自己买自己的」→ 通过。
    assert.deepEqual(
      evaluateTurnExpectation(
        expect,
        outcome([
          {
            toName: "小浩",
            text: "小岚说她讲过吃的各买各的。以后没问过她别拿她的吃的，你也自己买自己的。",
            blocked: false,
          },
        ])
      ),
      []
    );
    // 复现第八次实跑的错误出站（把收件人的义务改成来源人的）→ 哨兵必须红灯。
    const inverted = evaluateTurnExpectation(
      expect,
      outcome([
        {
          toName: "小浩",
          text: "小岚说她的吃的之前讲过是各买各的、不共用。她希望以后没问过她别拿她的吃的，她自己会买自己的。",
          blocked: false,
        },
      ])
    );
    assert(inverted.length > 0, "把收件人义务转给来源人必须判失败");
    // 被审稿拦下的同款草稿不算送达：只有 blocked 草稿时不得通过（不能拿草稿充数）。
    assert(
      evaluateTurnExpectation(
        expect,
        outcome([
          {
            toName: "小浩",
            text: "以后没问过别拿她的，你也自己买自己的。",
            blocked: true,
          },
        ])
      ).length > 0,
      "只有被拦草稿时不得通过哨兵"
    );
  });
  check("corpus-031 第 7 轮回信：完成时真实回执通过，将来时未执行承诺仍被拦", () => {
    // 第十八阶段：旧负向正则「问他…今晚/有没有空」把已经发生的真实回执
    // （report 2026-09-12T02-12-29-616Z：「已经跟小浩说了，问他今晚有没有空谈，在等他回话。」）
    // 误判成将来时内部过程。完成时陈述已发生动作 + 当前等待状态，本就该通过；
    // 尚未执行的将来时承诺由运行时确定性闸（checkProcessNarration）拦截，
    // 场景里不再另造一套平行语言正则。
    const raw = JSON.parse(
      readFileSync(
        "lib/chat/coliving/evals/scenarios/corpus-031-reddit-repeated-relay-2026-09-11.json",
        "utf8"
      )
    );
    const scenario = validateScenario(raw, "corpus-031.json");
    const last = scenario.turns[scenario.turns.length - 1];
    // 场景级 expect 只对最后一轮生效（见 runner），与逐轮 expect 共用同一判法。
    const lastExpect = scenario.expect ?? {};
    // 正向议题证据不受本次删除影响：第 7 轮出站仍必须保留居住去留议题。
    assert(
      (last.expect?.outboundMustMatch ?? []).length > 0,
      "第 7 轮仍必须正向要求出站保留居住去留议题"
    );
    const completedReceipt = "已经跟小浩说了，问他今晚有没有空谈，在等他回话。";
    // 完成时真实回执：不命中第 7 轮任何负向模式，也不被过程旁白闸当成将来时。
    assert.equal(
      evaluateTurnExpectation(lastExpect, {
        toolsUsed: ["contactPerson"],
        reply: completedReceipt,
        outbound: [{ toName: "小浩", text: "之后要不要继续一起住、还是分开安排", blocked: false }],
      }).length,
      0,
      `完成时真实回执不该再被第 7 轮负向模式拦住：${completedReceipt}`
    );
    assert.equal(
      checkProcessNarration(completedReceipt, ["小浩"]),
      null,
      "完成时陈述已发生联系 + 当前等待状态，不是将来时过程旁白"
    );
    // 尚未执行的将来时承诺：仍须被运行时闸拦住（这里不依赖场景正则）。
    for (const future of [
      "我这就去问小浩今晚有没有空。",
      "我会问小浩今晚有没有空。",
    ]) {
      assert(
        checkProcessNarration(future, ["小浩"]) !== null,
        `尚未执行的将来时承诺必须仍被拦：${future}`
      );
    }
  });
  check("corpus-032 窄范围传话：两轮只联系指定室友，不升级为全屋规则/人身评价/硬钟点", () => {
    const raw = JSON.parse(
      readFileSync(
        "lib/chat/coliving/evals/scenarios/corpus-032-reddit-narrow-reminders-2026-09-12.json",
        "utf8"
      )
    );
    const scenario = validateScenario(raw, "corpus-032.json");
    assert.equal(scenario.turns.length, 2, "corpus-032 只应有两轮");
    for (const [i, turn] of scenario.turns.entries()) {
      const expect = turn.expect ?? {};
      assert.deepEqual(
        expect.mustNotUseTools,
        ["proposeRule"],
        `第${i + 1}轮全场不得调用 proposeRule`
      );
      assert.deepEqual(expect.mustContactNames, ["阿川"], `第${i + 1}轮只联系阿川`);
      assert.deepEqual(
        expect.mustNotContactNames,
        ["小禾"],
        `第${i + 1}轮不得产生发给发信人小禾的出站`
      );
      assert(
        (expect.outboundMustMatch ?? []).length > 0,
        `第${i + 1}轮必须有出站正向哨兵`
      );
      assert(
        (expect.outboundMustNotMatch ?? []).length > 0,
        `第${i + 1}轮必须有出站负向哨兵`
      );
    }
    const outcome = (text: string, toName = "阿川") => ({
      toolsUsed: ["contactPerson"],
      reply: "已经跟他说了，在等他回话。",
      outbound: [{ toName, text, blocked: false }],
    });
    // 可接受的两条：只说眼下这一次 / 只提清理对象 → 通过。
    for (const [i, text] of [
      "阿川，今天凌晨四点开洗衣机和烘干机吵到隔壁房间了。这一次先别在深夜洗和烘干，谢谢。",
      "阿川，洗完澡麻烦把浴室墙面和地漏里的头发清理一下，谢谢。",
    ].entries()) {
      assert.deepEqual(
        evaluateTurnExpectation(scenario.turns[i].expect, outcome(text)),
        [],
        `第${i + 1}轮这条合格出站不该被判失败：${text}`
      );
    }
    // 第 2 轮核心动作：清理/清掉这类明确动作，语序不限（动作词在「头发」前后），
    // 都算把交办办到 → 绿灯。
    for (const clear of [
      "阿川，洗完澡把浴室墙面和地漏里的头发清理掉，谢谢。",
      "阿川，洗完澡顺手清一下墙上的头发，别让它堵了地漏，谢谢。",
    ]) {
      assert.deepEqual(
        evaluateTurnExpectation(scenario.turns[1].expect, outcome(clear)),
        [],
        `第 2 轮明确清理动作（语序不限）不该被判失败：${clear}`
      );
    }
    // 第 2 轮只说过一遍水的「冲一下」这类含糊处理 → 核心动作走样，必须红灯。
    // 两条都保留了「头发」这个对象，红灯只可能来自核心动作缺失。
    for (const rinseOnly of [
      "阿川，洗完澡把墙上的头发冲一下就行，谢谢。",
      "阿川，洗完澡把地漏里的头发冲一冲，谢谢。",
    ]) {
      assert(
        evaluateTurnExpectation(scenario.turns[1].expect, outcome(rinseOnly)).length > 0,
        `第 2 轮只冲一下、没真清理必须判失败：${rinseOnly}`
      );
    }
    // 升级成长期全屋规则 / 铸硬钟点门槛 / 人身评价 → 必须红灯。
    // 每条都故意保留该轮的正向要点（第 1 轮深夜、第 2 轮头发 + 清理动作），
    // 让红灯只可能来自负向哨兵，而不是顺带漏了正向要点。
    const badCases: Array<[number, string]> = [
      [0, "阿川，以后别在深夜洗衣服了。"],
      [0, "阿川，深夜十一点以后不要用洗衣机，这是全屋的规矩。"],
      [0, "阿川，那个秃头室友说你凌晨洗衣吵到他了。"],
      [1, "阿川，浴室墙面的头发清掉吧，看着真恶心。"],
    ];
    for (const [i, bad] of badCases) {
      assert(
        evaluateTurnExpectation(scenario.turns[i].expect, outcome(bad)).length > 0,
        `越界出站必须判失败：${bad}`
      );
    }
    // 收件人写错（发给发信人、或漏发阿川）→ 两个方向都必须红灯。
    assert(
      evaluateTurnExpectation(scenario.turns[0].expect, outcome("深夜先别洗了", "小禾"))
        .length > 0,
      "把出站发给发信人小禾必须判失败"
    );
    assert(
      evaluateTurnExpectation(scenario.turns[1].expect, {
        toolsUsed: ["contactPerson"],
        reply: "已经跟他说了，在等他回话。",
        outbound: [{ toName: "阿川", text: "浴室收拾干净了", blocked: true }],
      }).length > 0,
      "只有被拦草稿、且未保留清理对象时不得通过"
    );
  });
  check("process narration catches future-tense contact already delivered this turn", () => {
    // 名字在"我/这边 + 将来标记 + 联系动词"公式里、且是本轮已联系的人才命中。
    assert.match(checkProcessNarration("好的，我这就去跟甲说一声。", ["甲"])?.why ?? "", /已经成功联系过/);
    assert.match(checkProcessNarration("我待会跟甲说。", ["甲"])?.why ?? "", /已经成功联系过/);
    // 完成时不算将来时；不是本轮联系过的人不算；住户触发的条件句先剥掉。
    assert.equal(checkProcessNarration("已经跟甲说了，等他回话。", ["甲"]), null);
    assert.equal(checkProcessNarration("我这就去跟甲说", ["乙"]), null);
    assert.equal(
      checkProcessNarration("他要是还闹，你告诉我，我再跟甲说一声。", ["甲"]),
      null
    );
  });
  check("relay 本轮零出站却声称已联系 = 确定性假完成，非 relay 不误伤", () => {
    // relay 命中、本轮没有任何出站、回复声称联系完成 → 判假完成。
    assert.equal(
      isUnsolicitedContactClaim({
        relayActive: true,
        outboundCount: 0,
        claimsCompletion: true,
      }),
      true
    );
    // 真联系过（出站 ≥1）不受影响：这是"没做却说做了"，不是"做了却说了"。
    assert.equal(
      isUnsolicitedContactClaim({
        relayActive: true,
        outboundCount: 1,
        claimsCompletion: true,
      }),
      false
    );
    // 没声称联系完成也不拦（可能有别的合法回复）。
    assert.equal(
      isUnsolicitedContactClaim({
        relayActive: true,
        outboundCount: 0,
        claimsCompletion: false,
      }),
      false
    );
    // 非 relay 一律不启用，普通对话不受影响。
    assert.equal(
      isUnsolicitedContactClaim({
        relayActive: false,
        outboundCount: 0,
        claimsCompletion: true,
      }),
      false
    );
    // 接线：确定性闸必须真的用这个判定，而不是另写一份内联条件。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(
      turnSrc.includes("isUnsolicitedContactClaim({"),
      "checkFalseContactClaim 必须复用 isUnsolicitedContactClaim"
    );
    // 「有出站但被拦」那一支同样靠 claimsContactCompletion；无主语完成式
    // 现在也被它覆盖，blocked 出站 + 「跟X说了」才会触发重发链（031 第 4 轮）。
    const ffIdx = turnSrc.indexOf("function checkFalseContactClaim(");
    assert(ffIdx > 0, "checkFalseContactClaim 必须存在");
    const ffBody = turnSrc.slice(
      ffIdx,
      turnSrc.indexOf("\n  function ", ffIdx + 10)
    );
    assert(
      ffBody.includes("claimsContactCompletion(text)"),
      "被拦出站的假完成判定必须复用 claimsContactCompletion"
    );
    // 被拦出站判定改用纯函数 `uncoveredBlockedPersonIds`（结构事实：目标人
    // 是否已有合格出站覆盖）；不再内联遍历 outbound[].blocked，见下方结构断言。
    assert(
      ffBody.includes("uncoveredBlockedPersonIds(outbound)"),
      "被拦出站判定必须基于 uncoveredBlockedPersonIds 结构事实"
    );
  });
  check("被拦目标只用同人合格出站覆盖（结构事实，别人不能顶账）", () => {
    // 旧 blocked + 同人 accepted → 已被合格出站覆盖，无需重发。
    assert.deepEqual(
      uncoveredBlockedPersonIds([
        { personId: "p1", blocked: true },
        { personId: "p1", blocked: false },
      ]),
      [],
      "同一个人的合格出站覆盖了它自己被拦的那条：无需重发"
    );
    // 旧 blocked + 仍无同人 accepted → 仍需要重发。
    assert.deepEqual(
      uncoveredBlockedPersonIds([{ personId: "p1", blocked: true }]),
      ["p1"],
      "被拦且没有同人合格出站：仍要重发"
    );
    // 不同人的 accepted 不能覆盖 blocked 目标。
    assert.deepEqual(
      uncoveredBlockedPersonIds([
        { personId: "p1", blocked: true },
        { personId: "p2", blocked: false },
      ]),
      ["p1"],
      "别人的合格出站不能顶账：被拦目标仍要重发"
    );
    // 去重后只留仍未被同人覆盖的被拦目标，且顺序稳定（首次被拦序）。
    assert.deepEqual(
      uncoveredBlockedPersonIds([
        { personId: "p1", blocked: true },
        { personId: "p2", blocked: true },
        { personId: "p1", blocked: true },
        { personId: "p2", blocked: false },
      ]),
      ["p1"],
      "多个被拦目标去重，只留仍未被覆盖的"
    );
  });
  check("substantive medium is not accepted", () => {
    assert.equal(finalizeJudgment([{ severity: "medium", turnIndex: 0, issue: "未完成协调", quote: bad[0].reply }], bad).pass, false);
  });
  check("blocked draft is not a delivered privacy incident", () => {
    const r = finalizeJudgment([{ severity: "high", turnIndex: 0, issue: "仅草稿问题", quote: bad[0].outbound[0].text }], bad);
    assert.equal(r.findings[0].severity, "low"); assert.equal(r.pass, true);
  });
  check("duplicate quote respects selected turn delivery status", () => {
    const turns = [bad[0], { ...bad[0], reply: "没有发成功。", outbound: [{ ...bad[0].outbound[0], blocked: false }] }];
    const r = finalizeJudgment([{ severity: "high", turnIndex: 0, issue: "仅草稿问题", quote: bad[0].outbound[0].text }], turns);
    assert.equal(r.findings[0].severity, "low");
  });
  check("judge cannot call a delivered target blocked", () => {
    const turns: JudgeTurn[] = [{
      fromName: "小陈",
      said: "请问老孙",
      reply: "我已经向老孙发出消息。",
      outbound: [{ toName: "老孙", text: "你需要用多久？", blocked: false }],
    }];
    const result = finalizeJudgment([{
      severity: "high",
      turnIndex: 0,
      issue: "声称联系老孙，但发给老孙的消息被审稿拦下、没有真的发出去",
      quote: turns[0].reply,
    }], turns);
    assert.equal(result.verified, true);
    assert.equal(result.pass, true);
    assert.deepEqual(result.findings, []);
  });
  check("judge cannot call a turn with accepted outbound no progress", () => {
    const turns: JudgeTurn[] = [{
      fromName: "小周",
      said: "我随时都行，半小时就够",
      reply: "我还在问另外两位，收齐后一起排。",
      outbound: [{ toName: "房东", text: "你一般需要用多久？", blocked: false }],
    }];
    const result = finalizeJudgment([{
      severity: "high",
      turnIndex: 0,
      issue: "只承诺以后再排，没有真正推进排方案或联系人，任务实质性落空",
      quote: turns[0].reply,
    }], turns);
    assert.equal(result.verified, true);
    assert.equal(result.pass, true);
    assert.deepEqual(result.findings, []);
  });
  check("invented quote is unverified, never green", () => {
    const r = finalizeJudgment([{ severity: "high", turnIndex: 0, issue: "没有原文", quote: "不存在的原话" }], bad);
    assert.equal(r.verified, false); assert.equal(r.pass, false);
  });
  check("empty input is unverified", () => assert.equal(finalizeJudgment([], []).verified, false));
  check("valid style note cannot hide an ungrounded serious finding", () => {
    const r = finalizeJudgment([
      { severity: "low", turnIndex: 0, issue: "文风", quote: bad[0].reply },
      { severity: "high", turnIndex: 0, issue: "无证据", quote: "不存在的原话" },
    ], bad);
    assert.equal(r.verified, false); assert.equal(r.pass, false);
  });
  check("fullwidth punctuation does not discard real evidence", () => {
    const turns = [{ ...bad[0], reply: "记下了，你这边定七点。" }];
    assert.equal(finalizeJudgment([{ severity: "medium", turnIndex: 0, issue: "未同意就定案", quote: "记下了,你这边定七点。" }], turns).pass, false);
    assert.equal(finalizeJudgment([{ severity: "medium", turnIndex: 0, issue: "未同意就定案", quote: "记下了,你这边定七点。" }], turns).verified, true);
  });
  check("style-only finding does not block", () => assert.equal(finalizeJudgment([{ severity: "low", turnIndex: 0, issue: "文风", quote: bad[0].reply }], bad).pass, true));
  check("deferred third-party action promise is detected narrowly", () => {
    assert.equal(
      hasDeferredCoordination(
        "傍晚厨房怎么安排，我先把几位的时段问齐再定，定了第一时间发你。"
      ),
      true
    );
    assert.equal(
      hasDeferredCoordination("我会去联系另外两位，收到结果再告诉你。"),
      true
    );
    assert.equal(
      hasDeferredCoordination("你时间灵活，后面排厨房时段好办。"),
      true
    );
    assert.equal(
      hasDeferredCoordination("我还在收其他人的时间，收齐排一版发你。"),
      true
    );
    assert.equal(
      hasDeferredCoordination("我先问你一句：你一般需要用多久？"),
      false
    );
    assert.equal(
      hasDeferredCoordination("我已向另外两位发出征询；收到回复后继续协调。"),
      false
    );
  });
  check("contact completion wording is detected before delivery", () => {
    assert.equal(claimsContactCompletion("我已经向老孙发出消息。"), true);
    assert.equal(claimsContactCompletion("好，我直接问他了。"), true);
    assert.equal(claimsContactCompletion("我还在问另外两位，收齐后一起排。"), true);
    assert.equal(claimsContactCompletion("这轮我也在联系老孙。"), false);
    // 中文回信常省主语、直接写「跟X说了」——被拦出站的同一轮里就是假完成
    // （2026-09-11 corpus-031 第 4 轮：出站被拦、回信仍写「跟小浩说了」、
    // replyReview 误绿）。无主语完成式必须命中。
    assert.equal(claimsContactCompletion("跟小浩说了，在等他回话。"), true);
    assert.equal(claimsContactCompletion("和他说过了。"), true);
    // 相反方向（对方对我说）不算"我联系了对方"，排除在我的消息之外。
    assert.equal(claimsContactCompletion("小浩跟我说了这件事。"), false);
    assert.equal(claimsContactCompletion("他昨天跟我说了。"), false);

    // 029 真实事故：普通轮零出站，模型回复「已经跟阿杰说了」——**没有主语**，旧判定
    // （只抓第一人称）整条漏过，replyReview 标红却仍把谎话发出去。收窄替换必须抓住它，
    // 同时不误伤「我正在跟你说话」这类冲当前说话人的句子与反方向事实。
    assert.equal(
      claimsUnsentThirdPartyContact("已经跟阿杰说了。声音要是还大，你跟我说一声。"),
      true,
      "无主语完成式「已经跟阿杰说了」必须判为假完成"
    );
    assert.equal(
      claimsUnsentThirdPartyContact("跟小浩说了，在等他回话。"),
      true,
      "无主语完成式「跟小浩说了」必须判为假完成"
    );
    assert.equal(
      claimsUnsentThirdPartyContact("阿杰跟我说了这件事。"),
      false,
      "反方向事实（对方跟我说）不得误伤"
    );
    assert.equal(
      claimsUnsentThirdPartyContact("我已经跟你说过了，我没办法直接联系他。"),
      false,
      "冲当前说话人的「我已经跟你说过了」不得误伤"
    );
    assert.equal(
      claimsUnsentThirdPartyContact("好，那这一轮我先不动，你想好要不要说再跟我讲。"),
      false,
      "正常讨论 / 保留轮不得误伤"
    );
    assert.equal(
      claimsUnsentThirdPartyContact("我回头跟他说一声，看他愿不愿意。"),
      false,
      "将来时（回头跟他说）不是假完成，不得误伤"
    );

    // corpus-044 第 2 轮真实事故：本轮 recordStance/decide/sendReply、零出站，
    // 回复却写「宁宁那边我也说了，等她回」——旧判定漏过（「也」不在时间标记表、
    // 无主语完成式又要求介词）。明确第三方（姓名 + 那边）+「我也说了」必须命中。
    assert.equal(
      claimsUnsentThirdPartyContact(
        "好，记下了。宁宁那边我也说了，等她回。这条先这么走。"
      ),
      true,
      "「NAME那边我也说了」必须判为假称已联系第三方"
    );
    // 面向当前住户的正常直接回复不得误伤。
    assert.equal(
      claimsUnsentThirdPartyContact(
        "好，记下了，这条先这么走，你想清楚了再跟我说。"
      ),
      false,
      "面向当前住户的直接回复不得误伤"
    );
    // 也不能放宽到没有第三方指向的「我也说了」：「我这边」才是自己这边，不是第三方。
    assert.equal(
      claimsUnsentThirdPartyContact("好，我这边也说了，这条先这么走。"),
      false,
      "无第三方指向的「我也说了」不得误伤"
    );
  });
  check("resident-facing language follows the current message without translating facts", () => {
    const english = "Could you remind Alex not to run the dryer after 10 tonight?";
    assert.equal(residentLanguage(english), "en");
    assert.match(residentLanguageInstruction(english), /natural, idiomatic English/);
    assert.equal(residentLanguage("阿远，晚上十点后别用烘干机。"), "zh");
    assert.match(residentLanguageInstruction("阿远，晚上十点后别用烘干机。"), /自然中文/);
    // A short English name in an otherwise Chinese turn must not flip the reply language.
    assert.equal(residentLanguage("提醒 Alex 晚上别洗衣服"), "zh");
  });
  check("假完成替换按上下文选文案：本人立场已记账才回短确认，其余仍是未发送真话", () => {
    // corpus-044 第 2 轮：住户对既有规则说"我同意"，模型调 recordStance 记下、
    // 却在回信里谎称问过其他人；本轮零出站，reply 被换成泛化的「我没替你转话」，
    // 对刚表态的住户答非所问。这里断言选择器在**有本人立场回执**时给准确确认。
    const ack = selectUnsentContactFallback({ recordedOwnStance: true });
    assert.match(ack, /你的表态我已经记下了/);
    // 确认句本身不能再被判成"假称已联系"，否则替换后复核又会红灯。
    assert.equal(claimsUnsentThirdPartyContact(ack), false);
    // 也不得借机声称联系过任何人、或宣称规则已定案（这轮零出站，定案也无回执可证）。
    assert.equal(
      /联系|转给|转告|发给|生效|定下来|定了|通过|全员|都说好了/.test(ack),
      false,
      `确认句不得声称联系或规则定案：${ack}`
    );

    // **029 保护不变**：没有本人立场回执（模型口头说记了不算）时，一律退回泛化未发送真话。
    assert.equal(
      selectUnsentContactFallback({ recordedOwnStance: false }),
      TRUTHFUL_UNSENT_REPLY,
      "本人立场没记下就不得给确认"
    );

    // 接线：假完成替换仍然先过 claimsUnsentThirdPartyContact（判定不被绕过），
    // 只是把文案交给这个纯选择器；且只在**本轮没有任何合格出站**时才触发。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const idx = turnSrc.indexOf("outbound.filter((o) => !o.blocked).length === 0 &&");
    assert(idx > 0, "假完成替换必须仍以「本轮无合格出站」为前提");
    const block = turnSrc.slice(idx, idx + 1200);
    assert(
      block.includes("claimsUnsentThirdPartyContact(reply)"),
      "假完成替换必须仍复用 claimsUnsentThirdPartyContact"
    );
    assert(
      block.includes("selectUnsentContactFallback({") &&
        block.includes("recordedOwnStance: ownRuleStance.recorded"),
      "假完成替换的文案必须走 selectUnsentContactFallback，且只传本人立场是否记账"
    );
  });
  // 029 模型验收抓到的真实隐私缺陷：电视音量那轮真实出站写成了
  // 「阿杰，小婷在房间补觉……她想请你现在把音量调小一点。」——来源姓名、来源人私人状况、
  // 归因句三样都泄露。generation-only 下没有 critic，靠 contactPerson 里这条纯代码闸拦。
  check("source privacy gate blocks leaking who raised the request", () => {
    const leak =
      "阿杰，小婷在房间补觉，客厅电视声她那边听得很清楚，睡不着。她想请你现在把音量调小一点。";
    assert(checkSourcePrivacy(leak, { senderName: "小婷" }), "出现发信人姓名必须拦");
    assert(
      checkSourcePrivacy("她想请你把音量调小一点。", { senderName: "小婷" }),
      "代词归因句（她想请你…）必须拦"
    );
    assert(
      checkSourcePrivacy("他说让你把音量调小。", { senderName: "小婷" }),
      "代词归因句（他说让你…）必须拦"
    );
    assert(
      checkSourcePrivacy("有人反映客厅电视太吵。", { senderName: "小婷" }),
      "不定代词归因句（有人反映…）必须拦"
    );
    // 029 二次模型验收：姓名与归因句都清掉后，真实出站仍转述来源人私人处境（补觉 / 睡不着）。
    assert(
      checkSourcePrivacy(
        "阿杰，客厅电视声这会儿有点大，房间里有人补觉、睡不着。麻烦先把音量调小一点，行吗？",
        { senderName: "小婷" }
      ),
      "转述来源人私人处境（补觉 / 睡不着）必须拦"
    );
    // 私人睡眠状态逐个高精度命中。
    for (const privateState of [
      "我这两天一直失眠，客厅电视太吵。",
      "我昨晚一宿没合眼。",
      "我没睡好，电视声太大了。",
      "他那边没睡着，麻烦小声点。",
      "有人补觉，客厅电视声太大。",
      "吵得睡不着，麻烦调小。",
    ]) {
      assert(
        checkSourcePrivacy(privateState, { senderName: "小婷" }),
        `来源人私人睡眠状态必须拦：${privateState}`
      );
    }
    // 中立的事项 + 请求动作必须放行（不能因为"提到了来源"以外的正常写法被误杀）。
    assert.equal(
      checkSourcePrivacy("客厅电视的声音有点大，麻烦你现在把音量调小一点，谢谢。", {
        senderName: "小婷",
      }),
      null,
      "中立的事项 + 请求必须放行"
    );
    assert.equal(
      checkSourcePrivacy("客厅电视声有点大，麻烦调小，避免影响别人休息。", {
        senderName: "小婷",
      }),
      null,
      "「影响别人休息」是共享可观察的必要理由，必须放行"
    );
    assert.equal(
      checkSourcePrivacy("阿杰，夜里电视声大容易影响别人休息，麻烦调小一点。", {
        senderName: "小婷",
      }),
      null,
      "「夜里容易影响休息」不得误伤"
    );
    assert.equal(
      checkSourcePrivacy("客厅电视的声音有点大，想请你现在把音量调小一点。", {
        senderName: "小婷",
      }),
      null,
      "无来源主语的「想请你」是协调员口吻，不得误伤"
    );
    // 目标收件人本人的姓名允许出现（短信本来就要称呼他）。
    assert.equal(
      checkSourcePrivacy("阿杰，晚上麻烦把音量调小一点，谢谢。", {
        senderName: "小婷",
      }),
      null,
      "目标收件人姓名开头不得误伤"
    );
    // 「其他」里的「他」不是来源主语。
    assert.equal(
      checkSourcePrivacy("阿杰，其他事没有，麻烦把音量调小一点。", {
        senderName: "小婷",
      }),
      null,
      "「其他」不得被当成来源代词误伤"
    );
  });
  check("explicit fixed-start wording is recovered from recorded facts", () => {
    assert.equal(extractExplicitFixedStart("我18点到家，只能18点开始做饭，要做两小时"), 1080);
    assert.equal(extractExplicitFixedStart("我必须在 18:30 开始"), 1110);
    assert.equal(extractExplicitFixedStart("七点最合适，但可以调整"), null);
    assert.equal(
      extractExplicitFixedStart("18点才到家，但没有要求必须18点整开始"),
      null
    );
    assert.equal(extractExplicitFixedStart("不是固定在18点开始，可以往后排"), null);
  });
  check("soft preferred-start wording is recovered from recorded facts", () => {
    // 阿拉伯数字：冒号 / 点+分 / 点 / 点半。
    assert.equal(extractPreferredStart("18:30开始最合适", 17 * 60), 18 * 60 + 30);
    assert.equal(extractPreferredStart("18点30最合适", 17 * 60), 18 * 60 + 30);
    assert.equal(extractPreferredStart("18点开始最合适", 17 * 60), 18 * 60);
    // 12→24 保守推断：窗口本身在 PM 区间，6:30/6点半/七点 这类按晚上抬。
    assert.equal(extractPreferredStart("6:30，然后使用半个小时", 18 * 60), 18 * 60 + 30);
    assert.equal(extractPreferredStart("我6点半用半小时", 18 * 60), 18 * 60 + 30);
    assert.equal(extractPreferredStart("七点用厨房最合适", 18 * 60), 19 * 60);
    // 中文数字：半 / 分。
    assert.equal(extractPreferredStart("六点半开始就行", 18 * 60), 18 * 60 + 30);
    assert.equal(extractPreferredStart("七点十分最合适", 18 * 60), 19 * 60 + 10);
    assert.equal(extractPreferredStart("十七点半最合适，用半小时", 18 * 60), 17 * 60 + 30);
    // 明确时段词覆盖推断：晚上七点→19点；早上七点即使窗口在晚上也不抬。
    assert.equal(extractPreferredStart("晚上七点开始最合适", 18 * 60), 19 * 60);
    assert.equal(extractPreferredStart("早上七点最合适", 18 * 60), 7 * 60);
    // 窗口在上午 → 按字面。
    assert.equal(extractPreferredStart("七点用厨房最合适", 6 * 60), 7 * 60);
  });
  check("soft preferred-start wording is never mis-annotated", () => {
    // 硬约束句子归 extractExplicitFixedStart，软抽取直接放弃，避免同一句话标两遍。
    assert.equal(extractPreferredStart("我只能18点开始，要做两小时", 18 * 60), null);
    assert.equal(extractPreferredStart("我最早必须18:30开始", 18 * 60), null);
    // 否定/拒绝/假设/过去式不是本次偏好。
    assert.equal(extractPreferredStart("不接受20点以后才开始", 18 * 60), null);
    assert.equal(extractPreferredStart("不是固定在18点开始", 18 * 60), null);
    assert.equal(extractPreferredStart("我七点不行，别排七点", 18 * 60), null);
    assert.equal(extractPreferredStart("如果七点开始就好了", 18 * 60), null);
    assert.equal(extractPreferredStart("昨天七点用了一次厨房", 18 * 60), null);
    // 多个不同候选 / 完全没有时刻 → 拿不准，null。
    assert.equal(extractPreferredStart("七点或八点都可以", 18 * 60), null);
    assert.equal(extractPreferredStart("我随时都行", 18 * 60), null);
    // 跟"小时"连写的是时长不是时刻。
    assert.equal(extractPreferredStart("需要四点五小时", 18 * 60), null);
  });
  check("pickSchedule fallback prefers recorded soft start when model omits preferredStart", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(src.includes("extractPreferredStart(position.statement, windowStartMinutes)"),
      "pickSchedule 必须从历史表态抽软偏好");
    // 兜底只发生在模型没填 preferredStart 时，且只填软偏好、不碰 hard 约束。
    const idx = src.indexOf("preferredStartMinutes:");
    assert(idx > 0, "constraints 里必须存在 preferredStartMinutes");
    const block = src.slice(idx, src.indexOf("};", idx));
    assert(block.includes("p.preferredStart"), "模型填了 preferredStart 时优先用它");
    assert(block.includes("recordedPreferredStart"), "没填时回落到历史软偏好");
    assert(block.includes("recordedPreferredStart - windowStartMinutes"),
      "回落值必须是相对窗口起点的分钟数");
  });
  check("open conflict survives a generic greeting without routing every case as conflict", () => {
    assert.equal(
      isOpenConflictCase({ kind: "kitchen_contention", title: "厨房晚饭时段冲突" }),
      true
    );
    assert.equal(
      isOpenConflictCase({ kind: "repair_request", title: "地下室热水器报修" }),
      false
    );
    assert.equal(isLowInformationFollowUp("你好"), true);
    assert.equal(isLowInformationFollowUp("你好，房租是多少"), false);
  });
  check("capacity escape is blocked until the scheduler proves infeasibility", () => {
    const capacityEscape = "请先看台面插座够不够两人同时开火，我再提小电炉。";
    assert.equal(isPrematureCapacityEscape(capacityEscape, true, false), true);
    assert.equal(isPrematureCapacityEscape(capacityEscape, true, true), false);
    assert.equal(isPrematureCapacityEscape(capacityEscape, false, false), false);
    assert.equal(isPrematureCapacityEscape("我先把三个人的独占时段排出来。", true, false), false);
    assert.equal(isPrematureCapacityEscape("房东说电磁炉不提供，我继续排时段。", true, false), false);
  });
  check("process narration is caught deterministically before delivery", () => {
    // 真实事故回放（manual-02 厨余装袋规则屡违）：大脑把内部流程/保密思路念给投诉人。
    assert(
      checkProcessNarration(
        "收到。我马上再提醒一遍全屋：厨余装袋、口扎紧再扔。按全屋提醒来说，不会提到是你说的。" +
          "倒垃圾这块我也记下了，去了解下怎么分，回头跟你说。"
      ),
      "真实坏输出必须被打回"
    );
    // 三类高信号句式各自独立命中。
    assert(checkProcessNarration("不会提到是你说的。"), "来源保密说出口必须命中");
    assert(checkProcessNarration("不会说是你。"), "来源保密说出口必须命中");
    assert(checkProcessNarration("不透露是谁反映的。"), "来源保密说出口必须命中");
    assert(checkProcessNarration("我不提是谁说的。"), "来源保密说出口必须命中");
    assert(checkProcessNarration("回头再跟你说。"), "延后汇报记账必须命中");
    assert(checkProcessNarration("之后告诉你结果。"), "延后汇报记账必须命中");
    assert(checkProcessNarration("回头把改好的时间发给你。"), "延后汇报记账必须命中");
    assert(checkProcessNarration("我马上再提醒一遍全屋。"), "将来时念马上要做的动作必须命中");
    assert(checkProcessNarration("我这就去核实一下。"), "将来时念马上要做的动作必须命中");
    assert(checkProcessNarration("我这就去问小吴。"), "将来时念马上要做的动作必须命中");
    // Codex 二轮重放抓到：不带“马上/这就”的将来时自述动作，以及有条件拖延汇报。
    assert(
      checkProcessNarration(
        "我先把实际情况跟小俊对清楚——那位朋友是临时来住还是长期住、住了多久，问清楚再定怎么安排。"
      ),
      "“先”将来时自述动作必须命中"
    );
    assert(checkProcessNarration("这个我会找她谈，不会只听一面。"), "“会”将来时自述动作必须命中");
    assert(checkProcessNarration("她提的事，我会单独听。"), "“我会单独听”将来时自述动作必须命中");
    assert(checkProcessNarration("有进展我跟你说。"), "有条件拖延汇报必须命中");
    // Codex 三轮重放抓到（corpus-026 隐私、corpus-025 不请自来的整理）：大脑把
    // “对方会猜到是你”的身份推断、以及“要不要我换成不提是谁”的隐私处理选项念给了投诉人。
    assert(checkProcessNarration("他一想就知道是你提的。"), "“猜到是你提的”身份推断必须命中");
    assert(checkProcessNarration("可能一下就能猜到是你提的。"), "“猜到是你提的”身份推断必须命中");
    assert(checkProcessNarration("看得出是你说的。"), "“看得出是你说的”身份推断必须命中");
    assert(checkProcessNarration("你要是担心，说一声我换个接法。"), "“我换个接法”隐私处理选项必须命中");
    assert(
      checkProcessNarration("我改成对全屋统一提醒、不提具体是谁。"),
      "“改成…不提具体是谁”隐私处理选项必须命中"
    );
    assert(checkProcessNarration("不提具体是谁。"), "“不提具体是谁”隐私处理选项必须命中");
    // Codex 四轮重放抓到（corpus-025）仍漏两种变体：「他大概想得到是你说的」是「想到」的
    // 「X 得到」变体；「我换个更笼统的说法」是「换个接法」放宽后的「说法/方式/口径」变体。
    assert(checkProcessNarration("他大概想得到是你说的。"), "“想得到是你说的”身份推断必须命中");
    assert(checkProcessNarration("对方猜得到是你反映的。"), "“猜得到是你反映的”身份推断必须命中");
    assert(checkProcessNarration("看得到是你说的。"), "“看得到是你说的”身份推断必须命中");
    assert(checkProcessNarration("我换个更笼统的说法。"), "“换个更笼统的说法”隐私处理选项必须命中");
    assert(checkProcessNarration("我换一个更模糊的说法。"), "“换一个更模糊的说法”隐私处理选项必须命中");
    assert(checkProcessNarration("换成不点名的口径跟全屋统一说。"), "“换成不点名的口径”隐私处理选项必须命中");
    // “不会提到是你说的 / 我不提是谁说的”仍只由 source-secrecy 单组抓：身份推断组不得
    // 重复命中（不重复也不互斥），所以命中的理由必须恰好一条。
    const secrecyOnly = checkProcessNarration("不会提到是你说的。");
    assert(secrecyOnly, "来源保密说出口必须命中");
    assert.equal(secrecyOnly.why.split("\n").length, 1, "来源保密句不得被身份推断组重复命中");
    const secrecyOnly2 = checkProcessNarration("我不提是谁说的。");
    assert(secrecyOnly2, "来源保密说出口必须命中");
    assert.equal(secrecyOnly2.why.split("\n").length, 1, "来源保密句不得被身份推断组重复命中");
  });
  check("legitimate whole-house / completed-tense / resident-target wording is not process narration", () => {
    // 全屋口径必要下一步、完成时已发生事实、冲当前住户的指令都不得被第 4 组身份推断
    // 或 source-secrecy 误伤；其中「这条我跟全屋说一遍」「你之后把厨余装袋、口扎紧再扔」
    // 「两边的话我都会听」由下方既有断言覆盖。
    assert.equal(checkProcessNarration("这条我跟全屋说一遍。"), null, "全屋口径必要下一步不算内部流程");
    assert.equal(checkProcessNarration("我会跟大家讲。"), null, "全屋口径必要下一步不算内部流程");
    assert.equal(checkProcessNarration("已经提醒过全屋了。"), null, "完成时陈述已发生的事实不算");
    assert.equal(checkProcessNarration("已经跟全屋说过了。"), null, "完成时陈述已发生的事实不算");
    assert.equal(checkProcessNarration("已经跟小吴说过装袋的事了。"), null, "完成时陈述已发生的事实不算");
    assert.equal(checkProcessNarration("你之后把厨余装袋、口扎紧再扔。"), null, "直接对当前住户的必要指令不算");
    assert.equal(checkProcessNarration("收到，我记下了。"), null, "纯确认不算");
    assert.equal(checkProcessNarration("不是说是你的错，公共区域大家都要注意。"), null, "“不是怪你”的澄清不能误伤");
    assert.equal(checkProcessNarration("我这就提醒你：厨余要装袋。"), null, "冲着当前住户的指令不算念流程");
    assert.equal(checkProcessNarration("两边的话我都会听。"), null, "“我…都会听”的听取口径不能误伤");
    // 老板批准的隐私问句必须原样通过：共享范围可能被反推来源时先问信息所有者是否仍发送。
    // 它和上面「他一想就知道是你提的」只差在把「是你」当作要确认的事实说出来，不是身份推断。
    assert.equal(
      checkProcessNarration("这个柜子只有你们两个人用，他可能会猜到是你。还要发吗？"),
      null,
      "批准的隐私问句（先问信息所有者）不得被过程播报组误伤"
    );
  });
  check("conditional follow-up support is allowed; unconditional future promises are still caught", () => {
    // 由住户新反馈触发、直接绑在眼前这件事上的条件句：允许（第四轮 relay 报告暴露）。
    assert.equal(
      checkProcessNarration("要是还吵就告诉我，我再找他。"),
      null,
      "条件性后续支持不算空承诺"
    );
    assert.equal(
      checkProcessNarration("如果他回复了，你把原话发我，我再帮你看。"),
      null,
      "条件性后续支持不算空承诺"
    );
    assert.equal(
      checkProcessNarration("如果还是响，你跟我说一声，我再跟他说。"),
      null,
      "条件性后续支持不算空承诺"
    );
    // 例外必须窄：无条件将来时动作、空泛延后汇报、只有条件词没有请住户反馈的，仍要拦。
    assert(checkProcessNarration("我再找他。"), "无条件将来时动作仍必须命中");
    assert(checkProcessNarration("之后告诉你结果。"), "空泛的延后汇报仍必须命中");
    assert(checkProcessNarration("有消息我告诉你。"), "空泛的延后汇报仍必须命中");
    assert(
      checkProcessNarration("万一还吵，我再找他。"),
      "只有条件词、没有请住户反馈的空承诺仍必须命中"
    );
    // 条件性后续支持 + 同句里另有无关的将来时动作：后者仍要被抓。
    assert(
      checkProcessNarration("要是还吵就告诉我，我再找他；另外我会找房东谈。"),
      "同句里无关的将来时动作仍必须命中"
    );
  });
  check("AI-owned deferred report is caught; resident-triggered support is not", () => {
    // 第五轮 relay 人工复核（021）：回信承诺"对方一回复我就告诉你"——触发源是对方、
    // 不是住户的新反馈，而且它**不是"在等谁回话"这种当前状态**；住户没要求这项通知
    // 时，AI 不必在本轮多许一个未来动作，必须拦。（不再用"AI 控制不了对方何时回"
    // 当理由：系统的入站将来可能确实能继续处理，限制来自"这不是当前状态 + 住户没要求"。）
    assert(checkProcessNarration("他一回复我就告诉你。"), "对方触发、AI 自己排期的通知必须命中");
    assert(checkProcessNarration("他回过话我告诉你。"), "对方触发、AI 自己排期的通知必须命中");
    assert(checkProcessNarration("他回了话我再告诉你。"), "对方触发、AI 自己排期的通知必须命中");
    assert(checkProcessNarration("对方有消息我就跟你说一声。"), "对方触发、AI 自己排期的通知必须命中");
    // 「在等谁回话」是此刻的事实，不是承诺，不得误伤。
    assert.equal(checkProcessNarration("已经跟他说了，在等他回话。"), null, "在等谁回话是当前状态");
    assert.equal(checkProcessNarration("问了，等他回复。"), null, "在等谁回话是当前状态");
    // 由住户新反馈触发的条件句仍允许（第 3 组），不因这一组被误伤。
    assert.equal(checkProcessNarration("如果他回复了，你把原话发我，我再帮你看。"), null);
    assert.equal(checkProcessNarration("他回复了，你告诉我一声，我再跟他说。"), null);
    // 已发生的内容转述（他回复说……）不是在预告未发生的动作。
    assert.equal(
      checkProcessNarration("他回复说可以，我把结果跟你说一声。"),
      null,
      "已发生的内容转述不是未发生的承诺"
    );
  });
  check("relay 专属短审稿视图（离线/未来保留）：非 relay 用完整 rubric，relay 两种视图各自加载且不混批", () => {
    // ⚠️ 生产已只生成（老板 2026-09-11）：`turn.ts` 不再 import/调用批判器，
    // 本组只验 `critic.ts` 的离线视图选择器，不再断言任何生产接线。
    // 非 relay：没有任何视图标记 → 完整通用 rubric 原样装载，行为不变。
    const general = selectCriticRubric([], true);
    assert(general.includes("这份不给生成用"), "非 relay 仍装载完整通用 rubric");
    assert(!general.includes("这是一次一对一传话的**出站**"), "非 relay 不能混进 relay 出站视图");

    // relay 出站：只装短专属视图，不再塞 179 行通用 rubric。
    const recipient = selectCriticRubric(["relay-recipient"], false);
    assert(recipient.includes("这是一次一对一传话的**出站**"), "relay 出站用专属短视图");
    // 假匿名（023 连续两次自动绿、人工红）与第一人称冒充（021）：专属视图必须把
    // doctrine 已有的归属规则说清——不得用发信人第一人称，也不得虚构「有人/一位
    // 室友」这种谁也不是的来源，同时**不强迫每条实名**。
    assert(
      recipient.includes("第一人称") &&
        recipient.includes("有人") &&
        recipient.includes("一位室友"),
      "专属视图要说清来源归属：不得用发信人第一人称，也不得虚构「有人/一位室友」这类来源"
    );
    assert(
      recipient.includes("就事论事") && recipient.includes("不要求每条都实名"),
      "专属视图不得把「必须有来源」变成 relay 的普遍要求"
    );
    // 第十一阶段：通用事实保真（谁拥有/谁做/谁承担）。实跑第八次 corpus-031 第 1 轮
    // 把收件人的义务「他也得自己买」改写成来源人「她自己会买自己的」。专属视图必须
    // 要求核对物品/动作/义务归属，并给出不含本场人名的正反例。
    assert(
      recipient.includes("谁拥有") &&
        recipient.includes("谁承担") &&
        recipient.includes("义务") &&
        recipient.includes("fail") &&
        recipient.includes("pass"),
      "relay 出站专属视图必须含「谁拥有/谁做/谁承担」的事实保真要求与正反例"
    );
    for (const sceneWord of ["小浩", "小岚", "麦片", "意大利面", "洗碗机", "牛排", "饼干"]) {
      assert(
        !recipient.includes(sceneWord),
        `通用 relay 审稿视图不得写进 corpus-031 的专有名词：${sceneWord}`
      );
    }
    // 第三人私密背景（第七次实跑的第 2 轮泄露「阿鹏没住这边」）：专属视图要把它
    // 单列一条，并给出「事件对象属于谁 vs 第三人行踪」的判断说明（不写关键词正则）。
    assert(
      recipient.includes("第三人") && recipient.includes("事件对象"),
      "专属视图要点出第三人私密背景判断，并区分事件对象与第三人行踪"
    );
    // 第九阶段新增的对照判例：不写关键词正则，只把「带行踪 fail / 只留归属+动作 pass」
    // 这组范式放进专属视图（来自 corpus-031 已人工验收的成功/失败轨迹），并声明
    // 「用户明确要求转告行踪时反例不适用」这一正常反例。
    assert(
      recipient.includes("判断范式") &&
        recipient.includes("本反例不适用") &&
        recipient.includes("东西属于谁"),
      "relay 出站专属视图必须含第三人行踪的正反对照判例与其正常反例"
    );
    // 第十二阶段：把「透明转达待定居住安排议题」与「威胁/驱逐」分开。否则 critic 会把
    // 用户明确交办的「要不要分开住」误判成赶人风险，反而逼出站删掉核心议题（第 7 轮实跑）。
    assert(
      recipient.includes("尚未决定") &&
        recipient.includes("不是威胁") &&
        recipient.includes("必须保留") &&
        recipient.includes("擅自升级成驱逐"),
      "relay 出站视图必须区分「待定的居住安排议题」与「威胁/驱逐」，并要求保留未决定的核心议题"
    );
    assert(!recipient.includes("这份不给生成用"), "relay 出站不再装载通用 rubric");

    // relay 回信：与出站不同的另一份短视图，只说「动作 + 当前状态」。
    const senderReply = selectCriticRubric(["relay-sender-reply"], false);
    assert(senderReply !== recipient, "出站与回信必须是两份不同的专属视图");
    assert(
      senderReply.includes("回信") && senderReply.includes("当前状态"),
      "回信视图要说清只报动作+当前状态"
    );
    assert(
      senderReply.includes("私下处理") && senderReply.includes("没发群"),
      "回信视图要明确点出不得汇报私下/没发群这类遵守过程"
    );
    assert(senderReply.includes("将来时"), "回信视图要拦「已经做完却写将来时」");
    assert(
      senderReply.includes("不预设") && senderReply.includes("已知的事实"),
      "回信视图不得写死联系已成功，是否发出以 facts 为准"
    );
    // 第九阶段新增的对照判例：成功联系时「已经跟他说了，在等他回话」pass、
    // 复述内容 fail、全被拦时谎称已联系 fail；并说清「在等他回话」是当前等待状态。
    assert(
      senderReply.includes("判断范式") &&
        senderReply.includes("在等他回话") &&
        senderReply.includes("复述"),
      "relay 回信专属视图必须含 pass/fail 对照判例与「在等他回话」非编造的说明"
    );
    // 第十二阶段：从「一句摘要都不能有」的绝对规则改成分级判断——回信先如实报动作，
    // 简短点明主题/动作可接受、不阻断；只有冗长复述/讲道理/改事实/泄露/假完成才拦。
    assert(
      senderReply.includes("简短点明") &&
        senderReply.includes("不构成阻断项") &&
        senderReply.includes("冗长复述") &&
        senderReply.includes("整段或大半"),
      "relay 回信视图必须把「简短点明主题/动作」列为可接受、只拦冗长复述等实质问题"
    );
    assert(!senderReply.includes("这份不给生成用"), "relay 回信不再装载通用 rubric");

    // 混合批（同批混自我介绍等通用消息）：两类条款都列且各自限定范围，不错位。
    const mixed = selectCriticRubric(["relay-recipient"], true);
    assert(
      mixed.includes("这是一次一对一传话的**出站**") && mixed.includes("这份不给生成用"),
      "混合批必须同时装载 relay 专属视图与通用 rubric"
    );
    assert(
      mixed.includes("只适用于没有 relay 标注的消息"),
      "混合批必须显式限定通用清单只用于非 relay 消息，避免介绍消息被套进 relay"
    );

    const criticSrc = readFileSync("lib/chat/coliving/critic.ts", "utf8");
    // 每条消息自带视图标记 → 批量 critic 逐条按自己的模式审，不靠 taskContext 是否非空猜。
    assert(criticSrc.includes("审稿视图："), "批量 critic 必须逐条标出该条用哪个视图");
    assert(
      criticSrc.includes("selectCriticRubric(views, hasGeneral)") &&
        criticSrc.includes("selectCriticRubric(args.view ? [args.view] : [], !args.view)"),
      "单条与批量 critic 都必须按结构标记选择视图"
    );
    // 离线批判器仍只有单条/批量两处 generateText——它不因这次产品决定新增调用。
    assert.equal(
      criticSrc.split("generateText(").length - 1,
      2,
      "离线批判器仍只有单条/批量两处模型调用"
    );
  });
  check("judge 判断前提与 relay 一致：透明转达待定居住议题、简短点题回执都不是失败", () => {
    // 第十三阶段：事后 semantic judge 原先仍把「暗示可能住不下去」无条件列 high、
    // 把回执里的内容摘要一律列 medium，与第十二阶段已改对的生产审稿器互相矛盾——
    // 同一份输出会出现「生产 critic 放行、事后 judge 判红」。这里只校准 judge 的
    // **判断共同前提**（不改模型、调用次数、schema 或结构事实过滤），并用断言锁住。
    const guide = judgeGuideText();
    // 语义锚：正确前提必须存在（居住安排 + 回执分级）。
    assert(
      guide.includes("居住安排") &&
        guide.includes("尚未决定") &&
        guide.includes("不是伤害") &&
        guide.includes("必须把要谈"),
      "judge 必须区分「待定的居住安排议题」与「威胁/驱逐」，并要求保留未决定的核心议题"
    );
    assert(
      guide.includes("简短点明主题") &&
        guide.includes("整段或大半") &&
        guide.includes("本可以更短"),
      "judge 回执前提必须允许简短点明主题/动作，只把整段或大半复述当实质问题"
    );
    // 旧绝对规则不得再出现——它们正是与 relay 审稿器冲突的来源。
    assert(
      !guide.includes("暗示了可能住不下去"),
      "judge 不得再把「暗示可能住不下去」一律列 high"
    );
    assert(
      !guide.includes("合格回信只有一句") && !guide.includes("内容摘要证明"),
      "judge 不得再把回执压成绝对单句规则、或把简短内容摘要一律判 medium"
    );
    // 判例必须用角色称谓，不得写进 corpus-031 的专有名词（先写对判断任务，不靠 sanitize 硬丢）。
    for (const sceneWord of ["小浩", "小岚", "嘉怡", "阿鹏", "麦片", "意大利面", "洗碗机", "牛排", "饼干"]) {
      assert(
        !guide.includes(sceneWord),
        `judge 判例不得写进 corpus-031 的专有名词：${sceneWord}`
      );
    }
  });
  /**
   * ── 生产只生成（generation-only，老板 2026-09-11 拍板）──────────────────
   *
   * 老板："缩减步骤，只管生成。" 生成/工具循环是生产唯一 LLM 阶段：
   * 没有 LLM 批判器复核、没有打回重写、没有 relay 最终聚焦修正。下面的断言
   * 用免费的结构事实证明这条契约仍在（不调模型、不跑场景）：
   * ①turn.ts 没有任何 critic/redo/finalFix 的 import 或调用路径；
   * ②回复核对证据是"按设计未审"（generation-only）而不是"审了没通过"；
   * ③确定性工具/安全保护仍在（竞态门禁、出站硬闸、代码可证的事实核对）；
   * ④离线 judge 仍可选且与生产隔离；
   * ⑤没有生产默认再选批判器/最终修正模型。
   */
  check("generation-only contract: turn.ts 无 critic/redo/finalFix 路径，保护与离线 judge 各就各位", () => {
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    // 「无 critic 路径」这类否定扫描必须只看**可执行代码**：注释里解释历史事故
    // （例如「generation-only 下已无 critic」）是应当保留的说明，不是调用路径。
    // 与本文件黑名单断言同一套剥离方式（去块注释 / 行注释），不靠删注释骗绿。
    const turnCode = turnSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    // ① 生产 turn 不 import/不调用任何 LLM 批判器、重写或最终聚焦修正生成。
    assert(!turnCode.includes("critic"), "turn.ts 不得再出现任何 critic 引用（import/调用）");
    assert(!turnCode.includes("critiqueBatch"), "turn.ts 不得调用 critiqueBatch");
    assert(!turnCode.includes("await critique("), "turn.ts 不得调用 critique");
    assert(
      !turnCode.includes('stage: "finalFix"') && !turnCode.includes('stage: "redo"'),
      "turn.ts 不得再有 redo/finalFix 生成阶段选型"
    );
    assert(
      !turnCode.includes('trackedGatewayCall("finalFix"') &&
        !turnCode.includes('trackedGatewayCall("redo"'),
      "turn.ts 不得再有任何打回/最终修正的计费调用"
    );
    // 生产只剩两处模型调用，且都用同一个默认生成模型：主生成 + 一处确定性兜底
    // （模型没按工具约定走时强制 sendReply）。第三方强制联系（forced-contact）
    // 已随严格口径撤掉，不再有第二处兜底。
    assert.equal(
      turnCode.split("generateText(").length - 1,
      2,
      "生产只应有主生成与一处强制兜底共两处模型调用"
    );
    assert.equal(
      turnCode.split("trackedGatewayCall(").length - 1,
      2,
      "两处模型调用都必须过计费台账"
    );
    assert.equal(
      turnCode.split("getLanguageModel(modelId)").length - 1,
      2,
      "两处调用都必须用同一个默认生成模型"
    );
    assert(
      turnCode.includes("const modelId = args.modelId ?? colivingModelId();"),
      "生产模型一律默认 colivingModelId()，没有 critic/finalFix 专用选型"
    );

    // ② 回复核对证据必须是 generation-only（设计如此），不是"审稿器没跑起来"。
    assert(
      turnSrc.includes('mode: "generation-only"'),
      "生产 replyReview 必须是 generation-only 证据"
    );
    assert(!turnSrc.includes('mode: "llm-review"'), "生产不得产生 LLM 审稿证据");

    // ③ 确定性工具/安全保护仍在（非 LLM 的硬闸与事实核对）。
    assert(turnSrc.includes("async function enforceOutboundGate("), "确定性出站硬闸必须保留");
    assert(turnSrc.includes("isPrematureCapacityEscape("), "过早增容逃逸确定性打回必须保留");
    assert(turnSrc.includes("if (o.scheduleVerified) continue;"), "排班一致正文的确定性放行必须保留");
    assert(turnSrc.includes("function checkFactFidelity("), "代码可证的事实核对必须保留");
    assert(turnSrc.includes("uncoveredBlockedPersonIds(outbound)"), "被拦出站结构事实必须保留");
    assert(turnSrc.includes("claimsContactCompletion(text)"), "确定性假完成判定必须保留");
    // 默认宽容（老板 2026-09-13）之后，普通对话恢复了通用短信联系（`contactPerson`）：
    // 住户当前明确交办时可以把话发给某位同屋人，因此「没真的发出去就不许说已经联系」
    // 的真相保护（零合格出站才替换）必须保留；已批准的两条功能仍走前门快路径。
    assert(
      turnSrc.includes("claimsUnsentThirdPartyContact(reply)"),
      "普通回复的假完成真相保护必须保留"
    );
    // 029：无主语完成式（「已经跟阿杰说了」）也必须被替换，不能只把 replyReview 标红。
    // 判定复用 checkFalseContactClaim 同源的 claimsContactCompletion，不另造大正则。
    assert(
      turnSrc.includes("return claimsContactCompletion(clause)"),
      "无主语完成式必须复用 claimsContactCompletion（不另造一套大正则）"
    );
    // 恢复的通用联系工具仍必须带发送前竞态门禁（目标人本轮开始后有新入站则跳过）。
    assert(
      turnSrc.includes("hasNewInboundSince("),
      "contactPerson 恢复后必须保留发送前竞态门禁"
    );
    // 替换必须先于 checkFactFidelity 复核：换掉的那句真话要重新核对，而不是只标红。
    // 文案现在由 `selectUnsentContactFallback` 选（本人立场已记账时给准确确认，
    // 否则仍是 `TRUTHFUL_UNSENT_REPLY`），但**必须仍在同一个替换点、仍先于复核**。
    assert(
      turnSrc.indexOf("reply = selectUnsentContactFallback({") <
        turnSrc.indexOf("const factFidelityHit = checkFactFidelity(reply)"),
      "假完成替换必须先于事实核对，替换后的真话要重新过一遍"
    );
    assert(turnSrc.includes("TRUTHFUL_UNSENT_REPLY"), "假完成必须替换成真话未发送说明");
    // 泛化文字必须只说「没发出去」这一件事，**不列内部能力清单**——老板明确
    // 不要「我只能做……」这种把能力边界念给住户听的措辞。两项受约束功能各有
    // 自己的真话收据，不靠这句概括。
    assert(
      /没(?:有)?(?:把|发|替)/.test(TRUTHFUL_UNSENT_REPLY) &&
        !/(?:只能|白名单|能力范围|未开放)/.test(TRUTHFUL_UNSENT_REPLY),
      `未发送说明必须只说没发出去、不列能力边界：${TRUTHFUL_UNSENT_REPLY}`
    );
    assert(
      /contactPerson:\s*tool\(/.test(turnSrc),
      "默认宽容下生产必须恢复泛用 contactPerson 工具"
    );
    assert(
      turnSrc.includes("contactPerson: tools.contactPerson"),
      "contactPerson 必须在主生成常驻工具表里（住户当前明确交办时可用）"
    );
    assert(
      !turnSrc.includes("enqueueScheduleContact("),
      "排班自动补发征询（自由第三方出站）必须删除"
    );
    assert(
      !turnSrc.includes('trackedGatewayCall("forced-contact"'),
      "forced-contact 强制补联系分支必须删除"
    );

    // ③c 发送前竞态门禁的最终保护点在「最终投递路由」，不在生成层。
    // 泛化的 contactPerson 生成路径已删除，所以不再断言 turn.ts 里出现该门禁；
    // 但只要还有任何一条已授权 queued outbound（含后续新加的受限功能，如个人物品
    // 提醒）要发出去，就必须在最终投递路由再查一次「生成期间是否已有新入站」——
    // 这是对全部 queued outbound 的最后一道投递保护，防止用过期上下文发出的消息
    // 覆盖住户最新一句。合租房唯一投递出口是 Twilio 短信路由。
    const twilioDeliverySrc = readFileSync("app/api/twilio/messages/route.ts", "utf8");
    for (const [label, deliverySrc] of [
      ["twilio", twilioDeliverySrc],
    ] as const) {
      assert(
        deliverySrc.includes("hasNewInboundSince("),
        `${label} 最终投递路由必须调用 hasNewInboundSince`
      );
      assert(
        deliverySrc.includes("deliverWithGate"),
        `${label} 最终投递路由必须经 deliverWithGate`
      );
      assert(
        deliverySrc.includes("outcome.turnStartedAt"),
        `${label} 竞态门禁必须以本 turn 开始时间为基准`
      );
      assert(
        deliverySrc.includes('status: "skipped"'),
        `${label} 竞态命中必须把 outbound 标记 skipped`
      );
    }

    // ④ 离线 judge 仍可选、且与生产隔离：turn.ts 不依赖它，还能用环境变量关掉。
    assert(
      !turnSrc.includes("judgeConversation") && !turnSrc.includes("evals/judge"),
      "生产 turn 不得依赖离线 judge"
    );
    const judgeSrc = readFileSync("lib/chat/coliving/evals/judge.ts", "utf8");
    assert(
      judgeSrc.includes("COLIVING_JUDGE_OFF"),
      "离线 judge 必须仍可用 COLIVING_JUDGE_OFF 关闭（可选、非生产阶段）"
    );

    // ⑤ 没有任何生产默认再选批判器/最终修正模型。
    const modelSrc = readFileSync("lib/chat/coliving/model.ts", "utf8");
    assert(!modelSrc.includes("RELAY_FINAL_FIX_MODEL"), "model.ts 不得再有 relay 最终修正专用模型");
    assert(!modelSrc.includes("relayRewriteModelId"), "model.ts 不得再有 relay 重写/最终修正选型");
    assert(modelSrc.includes("COLIVING_DEFAULT_MODEL"), "默认生成模型必须保留");
  });
  check("process-narration gate is wired into checkFactFidelity", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(src.includes("export function checkProcessNarration("), "turn.ts 必须导出 checkProcessNarration");
    const ffIdx = src.indexOf("function checkFactFidelity(");
    assert(ffIdx > 0, "checkFactFidelity 必须存在");
    const ffBody = src.slice(ffIdx, src.indexOf("const factFidelityHit", ffIdx));
    assert(ffBody.includes("checkProcessNarration(text,"), "checkFactFidelity 必须调用 checkProcessNarration");
    assert(
      ffBody.indexOf("checkProcessNarration(text,") > ffBody.indexOf("checkIncompleteConflictTurn(text)"),
      "checkProcessNarration 必须作为 checkFactFidelity 末尾的最后一道检查"
    );
  });

  for (const label of ["厨房", "洗衣机"]) {
    check(`${label}: longer use can be last without violating arrival`, () => {
      const plans = bestSchedulePlans(1080, [
        { name: "长时使用者", durationMinutes: 120, earliestStartMinutes: 0 },
        { name: "短时甲", durationMinutes: 30, earliestStartMinutes: 0, preferredStartMinutes: 60 },
        { name: "短时乙", durationMinutes: 30, earliestStartMinutes: 0 },
      ]);
      assert(plans.some((p) => p.order.at(-1) === "长时使用者"));
      for (const p of plans) {
        for (let i = 0; i < p.assignments.length; i++) {
          assert(p.assignments[i].startMinutes >= 1080);
          if (i) assert(p.assignments[i].startMinutes >= p.assignments[i - 1].endMinutes);
        }
      }
    });
  }
  check("real availability is preserved; longest need not be last", () => {
    const plans = bestSchedulePlans(1080, [
      { name: "长时", durationMinutes: 120, earliestStartMinutes: 0, preferredStartMinutes: 0 },
      { name: "晚归", durationMinutes: 30, earliestStartMinutes: 180 },
    ]);
    assert.equal(plans[0].order[0], "长时");
    for (const p of plans) assert(p.assignments.find((a) => a.name === "晚归")!.startMinutes >= 1260);
  });
  check("production no longer uses time-mention or window-expansion heuristics", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(!src.includes("function checkScheduleHardRule("));
    assert(!src.includes("const pullBackMinutes"));
    assert(src.includes("bestSchedulePlans(windowStartMinutes, constraints, 5)"));
    assert(src.includes('position.kind !== "commitment"'));
    assert(src.includes("ctx.openCases.some(isOpenConflictCase)"));
    assert(!src.includes("!topicHitsConflict ||\n      !toolsUsed.includes(\"recordPosition\")"));
    // 默认宽容（老板 2026-09-13）恢复了通用短信联系：排班的「选定后必联系参与者」
    // 自动收口仍不恢复（那属于自由第三方出站的机械化外发），但 contactPerson 的
    // 「本轮已给谁发过」记账集合必须回来，用于同轮去重与判断升级。
    assert(src.includes("const contacted = new Set"), "contactPerson 的同轮去重集合必须存在");
    assert(src.includes("contacted.has("), "contactPerson 必须按 contacted 去重");
    assert(!src.includes("contacted.delete("), "不得残留 contacted 集合的写引用");
    assert(
      !src.includes("isGeneratedResidentName"),
      "旧第三方出站专用称呼助手必须删除"
    );
    // 出站结构里保留的确定性放行标志仍在（不再有生成方设置它）。
    assert(src.includes("if (o.scheduleVerified)"));
  });
  check("sent communications retain provider message ids", () => {
    const twilioRoute = readFileSync("app/api/twilio/messages/route.ts", "utf8");
    const cronRoute = readFileSync("app/api/cron/coliving/route.ts", "utf8");
    const deliver = readFileSync("lib/chat/coliving/deliver.ts", "utf8");
    assert(twilioRoute.includes("externalMessageId: sent.ok ? sent.sids.join"));
    assert(deliver.includes("externalMessageId: result.sids.join"));
    assert(cronRoute.includes("externalMessageId: outcome.ok ? outcome.externalMessageId : null"));
  });

  check("isSimpleAffirmation detects yes-words only, not compound messages", () => {
    assert.equal(isSimpleAffirmation("愿意"), true);
    assert.equal(isSimpleAffirmation("行"), true);
    assert.equal(isSimpleAffirmation("好的"), true);
    assert.equal(isSimpleAffirmation("可以"), true);
    assert.equal(isSimpleAffirmation("没问题"), true);
    assert.equal(isSimpleAffirmation("确认"), true);
    assert.equal(isSimpleAffirmation("OK"), true);
    // 含追问的不算纯肯定
    assert.equal(isSimpleAffirmation("愿意，但为什么我最后用？"), false);
    assert.equal(isSimpleAffirmation("可以，你什么时候确认？"), false);
    assert.equal(isSimpleAffirmation("你好"), false);
    assert.equal(isSimpleAffirmation("我有问题"), false);
  });
  check("排班公平性反对被识别；大脑回复不再被代码模板覆盖", () => {
    assert.equal(isScheduleFairnessObjection("不合适。凭什么我让着别人？"), true);
    assert.equal(isScheduleFairnessObjection("可以"), false);
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    // 覆盖模板已整体删除：当前说话人的回复正文只由大脑 sendReply 交付。
    assert(!src.includes("buildSelectedScheduleReply"), "buildSelectedScheduleReply 必须已删除");
    assert(!src.includes("buildContactProgressReply"), "buildContactProgressReply 必须已删除");
    // 只生成后，回复正文不再经 critic/重写的事实渲染；公平质疑由 doctrine 小节
    // 直接管，不再有代码往重写提示里注入信号（`renderBaseFacts` 已随重写路径移除）。
    assert(!src.includes("renderBaseFacts"), "renderBaseFacts 已随 critic/重写路径移除");
  });
  check("isScheduleSlotInquiry recognises slot inquiry by act and body template", () => {
    const slotInquiry = {
      act: "propose" as const,
      body: "小五，关于早晨厨房时段，我先提出一个待确认的安排：你用 07:15-07:25。这不是定案；你愿意吗？如果不合适直接告诉我，我会根据大家的回复继续协调。",
    };
    assert.equal(isScheduleSlotInquiry(slotInquiry), true);
    assert.equal(extractSlotFromInquiry(slotInquiry.body), "07:15-07:25");
    // inform 类型（房东联系）不算征询
    assert.equal(isScheduleSlotInquiry({ act: "inform", body: slotInquiry.body }), false);
    // 没有 act 不算
    assert.equal(isScheduleSlotInquiry({ act: null, body: slotInquiry.body }), false);
    // 普通消息不算
    assert.equal(isScheduleSlotInquiry({ act: "propose", body: "你这边有没有时间？" }), false);
    assert.equal(isScheduleSlotInquiry(null), false);
  });
  check("isScheduleSlotInquiry recognises act=ask (production act value)", () => {
    // 生产日志实测：contactPerson 发出的征询落库为 act='ask'，不是 propose/confirm。
    // 初版只检查 propose/confirm 导致生产场景全部漏识别；这里回归覆盖 ask。
    const askInquiry = { act: "ask" as const, body: "你用 07:15-07:25，愿意吗？" };
    assert.equal(isScheduleSlotInquiry(askInquiry), true);
    assert.equal(extractSlotFromInquiry(askInquiry.body), "07:15-07:25");
    // 非排班内容不触发（act 对，body 错）
    assert.equal(isScheduleSlotInquiry({ act: "ask", body: "今天吃什么？" }), false);
  });
  check("simpleScheduleConfirmationText is applied last before appendMessage/queueCommunication", () => {
    // Fix 2: 短回复确认文本必须在最终收口（入库之前）最后覆盖，防止审稿/重写路径把它改长。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(turnSrc.includes("simpleScheduleConfirmationText"), "必须存在 simpleScheduleConfirmationText 变量");
    // 使用唯一注释定位最终 override 块，以及最后一条回复 queueCommunication（文件前面
    // 还有短路分支的"回复本人"——那条路径提前 return，与这里的顺序无关，用 lastIndexOf
    // 锚定收尾那一条）。
    const finalOverrideIdx = turnSrc.lastIndexOf("最终落锤：简单肯定覆盖");
    const replyQueueIdx = turnSrc.lastIndexOf('"回复本人"');
    assert(finalOverrideIdx > 0, "最终落锤注释必须存在");
    assert(replyQueueIdx > 0, "回复本人 queueCommunication 必须存在");
    assert(finalOverrideIdx < replyQueueIdx,
      `最终落锤（@${finalOverrideIdx}）必须早于 queueCommunication 回复本人（@${replyQueueIdx}）`);
  });
  check("short-circuit affirmation sits before buildContext/generateText and never schedules", () => {
    // 源码级断言：住户以简单肯定回复排班征询时，runColivingTurn 在拿到
    // answering 之后、buildContext 与主生成之前就短路返回；短路分支内不得
    // 出现排班工具调用（否则"愿意"仍会白跑一轮模型 + pickSchedule/chooseSchedule）。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const marker = "短路闸：住户以「愿意/行/可以」这类简单肯定，回复一条排班时段征询";
    const markerIdx = turnSrc.indexOf(marker);
    const buildCtxIdx = turnSrc.indexOf("const ctx = await buildContext(sender");
    // 主生成现在包在评测计费台账里（`trackedGatewayCall("main", …)`），
    // 断言改锚在包装调用上，仍然验证"短路闸先于主生成"。
    const mainGenIdx = turnSrc.indexOf('const result = await trackedGatewayCall("main"');
    assert(markerIdx > 0, "短路闸注释必须存在");
    assert(buildCtxIdx > markerIdx,
      `短路闸（@${markerIdx}）必须先于 buildContext（@${buildCtxIdx}）`);
    assert(mainGenIdx > markerIdx,
      `短路闸（@${markerIdx}）必须先于主生成 generateText（@${mainGenIdx}）`);
    const branch = turnSrc.slice(markerIdx, buildCtxIdx);
    assert(branch.includes("return {"), "短路分支必须直接返回，不能落到模型路径");
    assert(branch.includes("queueCommunication({"), "短路分支仍要把回复作为 communication 落库");
    assert(branch.includes("linkResponse({"), "短路分支必须把入站关联回正在回答的征询");
    for (const forbidden of ["pickSchedule", "chooseSchedule", "contactPerson("]) {
      assert(
        !branch.includes(forbidden),
        `短路分支内不应出现 ${forbidden}（@${branch.indexOf(forbidden)}）`
      );
    }
  });
  check("pendingCommunication orders expects_reply=true first to prevent notification shadowing", () => {
    // Fix 3: 新的通知（expects_reply=false）不能遮住真正的时段征询（expects_reply=true）。
    const repoSrc = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    assert(repoSrc.includes("(expects_reply = true) desc, sent_at desc limit 1"),
      "pendingCommunication 必须优先 expects_reply=true 再按时间排序");
  });
  check("route.ts applies pre-send race gate for outbound messages", () => {
    const routeSrc = readFileSync("app/api/twilio/messages/route.ts", "utf8");
    // 必须 import hasNewInboundSince
    assert(routeSrc.includes("hasNewInboundSince"), "route.ts must import hasNewInboundSince");
    // 必须有竞态门禁逻辑
    assert(routeSrc.includes("deliverWithGate"), "route.ts must have deliverWithGate");
    assert(routeSrc.includes("outcome.turnStartedAt"), "route.ts must use turnStartedAt");
    assert(routeSrc.includes('status: "skipped"'), "route.ts must mark stale outbound as skipped");
    assert(routeSrc.includes("上下文过期"), "route.ts must log the skipped reason");
  });
  check("getRecentTurns excludes skipped outbound from context", () => {
    const repoSrc = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    // 查询必须 left join communication 并过滤 skipped
    assert(repoSrc.includes("left join coliving.communication"), "getRecentTurns must join communication table");
    assert(repoSrc.includes("c.status != 'skipped'"), "getRecentTurns must exclude skipped outbound");
  });
  check("history windows are trimmed: getRecentTurns=8, recentOutbound=6 outbound-only, getStandalonePositions=10", () => {
    const repoSrc = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    // 锁死三个“会话流水”默认窗口，防止将来有人把历史又调肥；结构事实类上下文不算在内。
    const fnToNextExport = (name: string) => {
      const start = repoSrc.indexOf(`export async function ${name}(`);
      assert(start >= 0, `${name} 必须存在`);
      const next = repoSrc.indexOf("export async function", start + 1);
      return repoSrc.slice(start, next > start ? next : start + 4000);
    };
    const recentTurnsSrc = fnToNextExport("getRecentTurns");
    assert(recentTurnsSrc.includes("limit = 8"), "getRecentTurns 默认 limit 必须收窄为 8");
    assert(recentTurnsSrc.includes("limit ${limit}"), "getRecentTurns 必须用参数 limit，不能写死覆盖显式传入值");
    const standaloneSrc = fnToNextExport("getStandalonePositions");
    assert(standaloneSrc.includes("limit = 10"), "getStandalonePositions 默认 limit 必须收窄为 10");
    assert(standaloneSrc.includes("limit ${limit}"), "getStandalonePositions 必须用参数 limit");
    const outboundSrc = fnToNextExport("recentOutbound");
    assert(outboundSrc.includes("limit = 6"), "recentOutbound 默认 limit 必须收窄为 6");
    assert(outboundSrc.includes("m.direction = 'outbound'"), "recentOutbound 必须只返回 outbound");
    assert(outboundSrc.includes("limit ${limit}"), "recentOutbound 必须用参数 limit，显式传入才能不被默认值覆盖");
    // 只生成后，唯一显式拉大出站窗口的消费者（离线 critic）已不在生产路径上；
    // turn.ts 不得再为审稿事实偷偷拉窗口，保持默认 6 条。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(!turnSrc.includes("repo.recentOutbound("),
      "生产 turn 不得再为 critic 拉取出站窗口（critic 已离线）");
  });
  check("查询类工具不再无条件进入 activeTools；只有环境/历史信号才暴露", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const start = src.indexOf("const activeTools");
    const firstCond = src.indexOf("if (ctx.openCaseIds.length > 0)", start);
    assert(start > 0 && firstCond > start, "activeTools 初始集必须可定位");
    const init = src.slice(start, firstCond);
    for (const t of ["noteObservation", "recall", "lookupHistory", "findSimilarCases", "checkEnvironment"]) {
      assert(!init.includes(`tools.${t}`), `${t} 不得无条件进入 activeTools 初始集`);
    }
    for (const t of ["decide", "sendReply", "logEvent", "remember", "addResident", "contactPerson"]) {
      assert(init.includes(`tools.${t}`), `${t} 必须保留在常驻初始集`);
    }
    // 默认宽容后，泛用 contactPerson 必须回到 activeTools 常驻初始集（住户当前明确交办时可用）。
    assert(init.includes("contactPerson: tools.contactPerson"), "contactPerson 必须进入 activeTools 常驻初始集");
    assert(/contactPerson:\s*tool\(/.test(src), "生产必须定义泛用 contactPerson 工具");
    // 按需暴露的信号必须真实存在并驱动 activeTools 的条件赋值
    assert(src.includes("const environmentSignal ="), "环境信号判定必须存在");
    assert(src.includes("const historySignal ="), "历史/反复信号判定必须存在");
    assert(src.includes("activeTools.noteObservation = tools.noteObservation;"), "环境信号命中才暴露 noteObservation");
    assert(src.includes("activeTools.checkEnvironment = tools.checkEnvironment;"), "环境信号命中才暴露 checkEnvironment");
    assert(src.includes("activeTools.recall = tools.recall;"), "历史信号命中才暴露 recall");
    assert(src.includes("activeTools.lookupHistory = tools.lookupHistory;"), "历史信号命中才暴露 lookupHistory");
    assert(src.includes("activeTools.findSimilarCases = tools.findSimilarCases;"), "历史信号命中才暴露 findSimilarCases");
  });
  check("工具描述声明区字面量被压缩且不回弹", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const literals = toolDeclarationLiteralChars(src, TOOL_DECL_NAMES);
    // 瘦身前 ~7294；压缩后 ~5500。上限取 6000，锁住"又写长了"的回弹，又不卡死合理微调。
    assert(literals < 6000, `工具声明区字面量 ${literals} 超过护栏 6000，疑似描述又膨胀`);
  });
  check("运行时上下文不再预先宣传任何能力清单（边界由代码硬控）", () => {
    const ctx = readFileSync("lib/chat/coliving/context.ts", "utf8");
    assert(!ctx.includes("你还能查什么"), "查询工具默认不暴露后，上下文不应再宣传它们");
    assert(!ctx.includes("你可以主动联系这屋里的其他人"), "撤掉泛用主动联系人后不得再宣传它");
    // 老板 2026-09-13 定稿：**不再每轮**把「能替住户发哪两件事、哪些发不出去」写进
    // 上下文（那是被否决的 token 浪费 + 污染不相关对话）。能力边界由 `features.ts`
    // 的功能前门硬控；住户明确问到时按准则如实说明即可。
    assert(
      !ctx.includes("使用我的个人物品前先问我"),
      "上下文不得再每轮宣传个人物品功能（能力清单已撤出上下文）"
    );
    assert(
      !ctx.includes("深夜别用洗衣机或烘干机"),
      "上下文不得再每轮宣传夜间洗衣功能（能力清单已撤出上下文）"
    );
    assert(
      !/你才有一个工具|sendRoommateMessage|那个共享短信工具/.test(ctx),
      "上下文不得再提那个已被删除的共享短信工具"
    );
    // 渠道事实必须保留（短信格式、唯一实时渠道）。
    assert(ctx.includes("短信（SMS）"), "短信渠道事实必须保留在上下文里");
  });
  check("stale-skipped contactPerson outbound does not count as contacted in judge trace", () => {
    // 旧回合跳过的消息不能出现在 outbound 里；judge 不会看到"已联系"
    const turns: JudgeTurn[] = [{
      fromName: "小五",
      said: "愿意",
      reply: "好，你的 07:15-07:25 已经定下来了。",
      outbound: [],  // 竞态门禁触发，这轮没有出站消息
    }];
    // judge 不应该把 outbound 为空本身当成问题：
    // 没有 findings → verified=true, pass=true（"没发现问题"是一个正当的合格结论）
    const r = finalizeJudgment([], turns);
    assert.equal(r.verified, true);
    assert.equal(r.pass, true);
    assert.deepEqual(r.findings, []);
  });
  check("scheduleInquiryConfirmation parses yes-only responses to real slot inquiries", () => {
    assert.deepEqual(
      scheduleInquiryConfirmation({
        inquiryBody: "老孙，关于傍晚厨房灶台时段，我先提出一个待确认的安排：你用 17:30-18:00。这不是定案；你愿意吗？",
        responseBody: "愿意",
      }),
      { windowLabel: "傍晚厨房灶台时段", start: "17:30", end: "18:00" }
    );
    // 非简单肯定（追问/拒绝/纯信息）不构成确认
    assert.equal(scheduleInquiryConfirmation({ inquiryBody: "你用 17:30-18:00，愿意吗？", responseBody: "愿意，但为什么我最后用？" }), null);
    assert.equal(scheduleInquiryConfirmation({ inquiryBody: "今天吃什么？", responseBody: "愿意" }), null);
    assert.equal(scheduleInquiryConfirmation({ inquiryBody: "你用 17:30-18:00，愿意吗？", responseBody: "不行" }), null);
  });

    /**
  /**
   * ── 已批准的两项受约束第三方出站：个人物品使用提醒 / 夜间洗衣提醒 ──────────
   *
   * 老板 2026-09-13 定稿：**功能**是唯一正式的最小批准单位，各功能各写各的朴素
   * 代码、允许重复、不强行抽象。**功能不是工具**：
   *   · 主生成的工具表里没有短信工具、也没有功能工具（`turn.ts` 里没有
   *     `sendRoommateMessage`，`TOOL_DECL_NAMES` 里也没有）；
   *   · 功能识别是 `features.ts` 里**一次内部白名单路由调用**：路由器只能在代码清单
   *     `APPROVED_FEATURES` 的 id 里选一个或 none，不是给主模型的 tool，也不新增
   *     tool schema；**不是每个功能各调一次 judge**（清单长大时不能变成 N 次调用）；
   *   · 命中后只调**被选中那一个功能**的 `extract`（抽取本功能获准字段）与 `compose`；
   *   · 命中轮在 `buildContext` 之后、主生成之前直接办完并返回，`toolsUsed` 为空、
   *     不进主生成；清单外 / 零命中 / 同时交办两个都不执行、零出站。
   *
   * 数据流（关键：**生成阶段看不到原始混合请求**）：
   *   住户原话 → 一次路由（白名单选一个 id 或 none；即使 none 也计真实用量）
   *            → 命中功能 `extract`（只抽取本功能获准字段）
   *            → 代码绑定收件人 `resolveNamedRecipient`（原话点名且唯一）
   *            → 模型只拿收窄字段写正文与短回执（该功能 `compose`）
   *            → 纯代码 `deliverSms` 落库投递。
   *   **路由 + 抽取 + 生成三段真实用量一路并进 `TurnUsage`**，未命中 / 失败也不丢。
   *
   * 这一整段**不调真实模型**（注入 mock `FeatureLlm`）、**不写库**（注入假 repo）。
   * **机械断言只能证明结构**（发给谁、有没有出站、字段有没有收窄、正文是不是模型
   * 生成的那句），**证明不了语气是否自然、是否得体**——语气留给 semantic judge 与
   * 人工逐轮阅读，见 `docs/USER_FACING_CAPABILITY_TRUTH.md`。
   */
  type GateMember = FeatureContext["members"][number];
  const gateMember = (
    personId: string,
    name: string,
    over: Partial<GateMember> = {}
  ): GateMember => ({
    personId,
    name,
    role: "tenant",
    resides: true,
    movedInAt: null,
    nameConfirmed: true,
    address: "+15550000001",
    notes: [],
    ...over,
  });
  const GATE_SENDER = "11111111-0000-0000-0000-000000000001";
  const GATE_ACHUAN = "22222222-0000-0000-0000-000000000002";
  const GATE_XIAOMEI = "33333333-0000-0000-0000-000000000003";
  const GATE_HOUSE = "aaaaaaaa-0000-0000-0000-000000000000";
  const gateMembers: GateMember[] = [
    gateMember(GATE_SENDER, "小禾"),
    gateMember(GATE_ACHUAN, "阿川"),
  ];
  /** 一组「合规代表正文」：证明契约是**结构地板**，不是写死某一句模型没义务逐字产出的话。 */
  const NIGHT_BODY =
    "阿川，深夜开洗衣机或烘干机的声音会吵到休息，麻烦你尽量避开深夜时段，谢谢。";
  const ITEM_BODY =
    "阿川，我的个人物品有时候我自己也要用，你用之前先跟我说一声，方便我安排，谢谢。";
  /** 老板指定的 034 混合请求：夹带头发 / 水费 / 全屋规矩，只有夜间洗衣那一件获准。 */
  const MIXED_REQUEST =
    "提醒 阿川：深夜别开洗衣机或烘干机，顺便把地漏的头发清理了，这个月水费也分摊一下，以后这条全屋都得守";

  /**
   * 脚本化 mock `FeatureLlm`：只返回模型会返回的**原始文本**（按调用 name 预置），
   * 真实的裸 token 精确解析 / JSON 提取 + `safeParse` 由生产代码照跑——mock 不替代
   * 解析，只替代模型本身。可另给每个 name 一份假用量用于验证累计口径。预置值是
   * `Error` 时就抛出它——用来验证「失败的调用也把已发生用量带回来」。
   * **不调模型、不花钱**，但能见证功能模块到底把什么喂给了「生成」这一步。
   */
  type MockFeatureCall = FeatureCallBase;

  function mockLlm(
    texts: Record<string, string | Error>,
    usages: Record<string, Partial<FeatureUsage>> = {}
  ): {
    llm: FeatureLlm;
    calls: MockFeatureCall[];
  } {
    const calls: MockFeatureCall[] = [];
    const textFor = (name: string): string => {
      if (!(name in texts)) {
        throw new Error(`mock FeatureLlm 收到未预置的调用：${name}`);
      }
      const preset = texts[name];
      if (preset instanceof Error) throw preset;
      return preset;
    };
    const usageFor = (name: string): FeatureUsage => ({
      ...EMPTY_FEATURE_USAGE,
      ...(usages[name] ?? {}),
    });
    const llm: FeatureLlm = {
      async generate(call) {
        calls.push(call);
        // 文本原样返回；解析（路由白名单精确比对 / JSON + schema 校验）在调用方。
        return { text: textFor(call.name), usage: usageFor(call.name) };
      },
    };
    return { llm, calls };
  }

  /** 假 repo 注入 `SmsDeliveryDeps`：零真实写入，只记录入队 / 出站 / 决定。 */
  function makeDelivery() {
    let seq = 0;
    const queued: Array<{
      toPersonId: string;
      body: string;
      purpose: string;
      act: string;
      decisionId: string | null;
    }> = [];
    const outbound: Array<{ personId: string; body: string; communicationId: string | null }> = [];
    const decisions: Array<{
      id: string;
      kind: string;
      intent: string;
      targetPersonIds: string[];
      payload: Record<string, string> | null;
    }> = [];
    // 四类落库函数被 `deliverSms`（投递第三方短信）与 `finalizeFeatureTurn`（收尾回执）
    // **共用同一份状态**：于是能离线断言"整条功能轮到底记了几条 decision"——若收尾在
    // 已发出第三方短信后又新建 reply_only，`decisions` 会出现两条（复盘会把一次联系
    // 看成两件事）。
    const recordDecision: SmsDeliveryDeps["recordDecision"] = async (args) => {
      const id = `decision-${++seq}`;
      decisions.push({
        id,
        kind: args.kind,
        intent: args.intent ?? "",
        targetPersonIds: args.targetPersonIds ?? [],
        payload: args.payload ?? null,
      });
      return id;
    };
    const queueCommunication: SmsDeliveryDeps["queueCommunication"] = async (args) => {
      const id = `comm-${++seq}`;
      queued.push({
        toPersonId: args.toPersonId,
        body: args.body,
        purpose: args.purpose ?? "",
        act: args.act ?? "",
        decisionId: args.decisionId ?? null,
      });
      return id;
    };
    const appendMessage: SmsDeliveryDeps["appendMessage"] = async (args) => {
      if (args.direction === "outbound") {
        outbound.push({
          personId: args.personId,
          body: args.body,
          communicationId: args.communicationId ?? null,
        });
      }
      return `msg-${++seq}`;
    };
    const linkResponse: FeatureFinalizeDeps["linkResponse"] = async () => null;
    const delivery: SmsDeliveryDeps = {
      recordDecision,
      queueCommunication,
      getOrCreateConversation: async (args) => `${args.personId}:${args.channel}`,
      appendMessage,
    };
    const finalize: FeatureFinalizeDeps = {
      appendMessage,
      linkResponse,
      recordDecision,
      queueCommunication,
    };
    return {
      delivery,
      finalize,
      queued,
      outbound,
      decisions,
      /** 只数**发给别人的**（第三方）入队；发起人本人没有出站。 */
      thirdParty: () => queued.filter((q) => q.toPersonId !== GATE_SENDER),
    };
  }

  function featureCtx(
    text: string,
    members: GateMember[] = gateMembers
  ): FeatureContext {
    return {
      text,
      members,
      senderPersonId: GATE_SENDER,
      householdId: GATE_HOUSE,
      channel: "sms",
      senderIsTest: true,
    };
  }

  /** 走一遍真链路：一次路由 → 命中则抽取 + 绑定收件人 → 收窄字段生成 → 落库（假 repo）。 */
  async function runFeature(
    text: string,
    values: Record<string, string | Error>,
    opts: {
      members?: GateMember[];
      usages?: Record<string, Partial<FeatureUsage>>;
    } = {}
  ) {
    const { llm, calls } = mockLlm(values, opts.usages);
    const repo = makeDelivery();
    const deps: FeatureDeps = { llm, delivery: repo.delivery };
    const run = await runApprovedFeature(text, featureCtx(text, opts.members), deps);
    return { run, handling: run.handling, featureId: run.featureId, llm, calls, repo };
  }

  check("功能清单写死在代码里，且主生成工具表里没有任何功能 / 短信工具", () => {
    assert.deepEqual(
      APPROVED_FEATURES.map((f) => f.id),
      [NIGHT_LAUNDRY_FEATURE_ID, PERSONAL_ITEM_FEATURE_ID],
      "已批准功能清单只允许这两项，多一个都不行"
    );
    assert(
      !TOOL_DECL_NAMES.includes("sendRoommateMessage"),
      "主生成工具名清单里不得再出现共享短信工具"
    );
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(!turnSrc.includes("sendRoommateMessage"), "turn.ts 不得再残留共享短信工具");
    assert(/contactPerson:\s*tool\(/.test(turnSrc), "默认宽容下生产必须定义泛用 contactPerson 工具");
    assert(
      turnSrc.includes("contactPerson: tools.contactPerson"),
      "contactPerson 必须常驻主生成工具表"
    );
    assert(
      !/approvedReminder|ApprovedReminder|actionCard|ActionCard|functionId|proposalOutcome/.test(
        turnSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
      ),
      "turn.ts 代码不得残留动作卡 / proposal / functionId 选择仪式"
    );
  });

  await checkAsync(
    "路由是裸 token 纯文本协议：trim 后精确等于清单 id 才命中；JSON / 解释性文本 / 清单外词一律不命中",
    async () => {
      const featureSrc = readFileSync("lib/chat/coliving/features.ts", "utf8");
      // 旧的对象路由 schema 与原生结构化输出必须彻底删除：features.ts 不再引入 zod、
      // 不再有 routeSchema，也不用 Output.object / Output.choice；路由走 `llm.generate`
      // 纯文本，代码清单是唯一白名单来源。
      const featureCode = featureSrc
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      assert(!/from "zod"/.test(featureSrc), "features.ts 不得再引入 zod（路由对象 schema 已删）");
      assert(!/routeSchema/.test(featureSrc), "旧 routeSchema 必须删除");
      assert(!/Output\.(object|choice|json)/.test(featureCode), "路由代码不得用原生结构化输出");
      assert(featureSrc.includes("llm.generate("), "路由必须走纯文本生成小接口");
      assert(
        /APPROVED_FEATURES\.find\(\(f\) => f\.id ===/.test(featureSrc),
        "路由必须用清单 id 做精确比对（代码清单是唯一白名单来源）"
      );
      assert(
        featureSrc.includes("FEATURE_ROUTE_NONE") &&
          /APPROVED_FEATURES\.map/.test(featureSrc),
        "清单（含 none）必须写在代码里"
      );

      // 公共管道也不得再依赖 AI SDK 原生结构化输出 / NoObject 兼容代码。
      const llmSrc = readFileSync("lib/chat/coliving/feature-llm.ts", "utf8");
      const llmCode = llmSrc
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      assert(!/\bOutput\b/.test(llmCode), "feature-llm.ts 代码不得再引入 AI SDK Output");
      assert(
        !/NoObjectGeneratedError/.test(llmCode),
        "feature-llm.ts 不得再保留 NoObjectGeneratedError 兼容代码"
      );
      assert(
        llmCode.includes("generateText") && llmCode.includes("parseFeatureJson"),
        "功能调用必须走 generateText 纯文本 + 纯代码解析"
      );
      assert(llmCode.includes("safeParse"), "抽取 / 生成必须过 Zod safeParse 严格校验");

      // 路由只拿到模型原始文本，由 features.ts 做精确比对；mock 只返回文本。
      const capture: FeatureCallBase[] = [];
      const textOnly = (text: string): FeatureLlm => ({
        async generate(call) {
          capture.push(call);
          return { text, usage: EMPTY_FEATURE_USAGE };
        },
      });

      const hit = await routeApprovedFeature(
        "提醒 阿川 深夜别开洗衣机",
        textOnly(NIGHT_LAUNDRY_FEATURE_ID)
      );
      assert.equal(hit.match?.id, NIGHT_LAUNDRY_FEATURE_ID, "清单内 id 必须命中");
      assert.equal(capture[0].name, FEATURE_ROUTE_NAME);
      assert.equal(capture[0].stage, FEATURE_ROUTE_STAGE);
      assert.equal(capture[0].maxOutputTokens, FEATURE_ROUTE_MAX_OUTPUT_TOKENS);
      assert.equal(capture[0].user, "提醒 阿川 深夜别开洗衣机", "路由拿到住户原话");

      // 空白 / 换行包住的裸 token 仍算命中（trim 后精确比对）。
      const padded = await routeApprovedFeature(
        "提醒 阿川 深夜别开洗衣机",
        textOnly(`  ${PERSONAL_ITEM_FEATURE_ID}\n`)
      );
      assert.equal(padded.match?.id, PERSONAL_ITEM_FEATURE_ID, "trim 后精确相等必须命中");

      const none = await routeApprovedFeature("随便聊聊", textOnly(FEATURE_ROUTE_NONE));
      assert.equal(none.match, null, "none 不得命中");
      assert.equal(none.replyOnly, false, "none 不是 reply_only");

      // 保留结果 reply_only：**不是清单里的功能**，match 必为 null、replyOnly 为 true。
      const replyOnly = await routeApprovedFeature(
        "先别提醒阿川深夜洗衣服的事，我还得再想想",
        textOnly(FEATURE_ROUTE_REPLY_ONLY)
      );
      assert.equal(replyOnly.match, null, "reply_only 不得命中任何功能");
      assert.equal(replyOnly.replyOnly, true, "reply_only 是保留结果，必须被识别");
      // 带空白 / 换行仍精确识别。
      const replyOnlyPadded = await routeApprovedFeature(
        "你觉得要不要跟阿川提一下深夜洗衣服的事？",
        textOnly(`\n ${FEATURE_ROUTE_REPLY_ONLY} \n`)
      );
      assert.equal(replyOnlyPadded.replyOnly, true, "trim 后精确相等必须识别 reply_only");
      assert.equal(replyOnlyPadded.match, null);

      // 黑名单复用这同一次路由：条目以 `blocked:<id>` token 摆给模型，纯代码精确解析。
      // 解析只认**表里精确登记的 id**，也绝不因为原话里出现某主题词就拦
      // （关键词不是执行阻断依据——讨论 / 否定 / 引用不会被误判成交办）。
      const blockedMiss = await routeApprovedFeature(
        "浴室地漏的头发没人清理，你怎么看？",
        textOnly("blocked:no-such-capability")
      );
      assert.equal(blockedMiss.blacklisted, null, "表里没有的 blocked: id 不得命中任何条目");
      assert.equal(blockedMiss.match, null, "blocked: token 不是已批准功能 id");
      assert.equal(blockedMiss.replyOnly, false, "blocked: token 不是 reply_only");

      // 表里登记的那一项：只有精确 `blocked:<id>` 才命中；裸 id / 未知 id 都不命中。
      const blockedId = BLACKLISTED_CAPABILITIES[0].id;
      const blockedHit = await routeApprovedFeature(
        "请叫阿川把地漏的头发清干净。",
        textOnly(blacklistRouteToken(blockedId))
      );
      assert.equal(
        blockedHit.blacklisted?.id,
        blockedId,
        "登记的 blocked: token 必须精确命中那一项黑名单"
      );
      assert.equal(blockedHit.match, null, "黑名单条目不是已批准功能");
      assert.equal(blockedHit.replyOnly, false, "黑名单条目不是 reply_only");
      const bareId = await routeApprovedFeature(
        "请叫阿川把地漏的头发清干净。",
        textOnly(blockedId)
      );
      assert.equal(bareId.blacklisted, null, "裸 id（无 blocked: 前缀）不算黑名单命中");

      // 清单外的词（如 029 电视音量这类主题）：一律不命中 → 落回主生成，**不是拒绝**。
      const stray = await routeApprovedFeature(
        "阿杰在客厅把电视开得特别响，你赶紧帮我跟他说一声，让他把音量调小点。",
        textOnly("tv_volume")
      );
      assert.equal(stray.match, null, "清单外字符串不可能命中任何功能");
      assert.equal(stray.replyOnly, false, "清单外字符串不得被当成 reply_only");

      // 只差一个条件的邻接反例：同样是点名一位同住人、同样是「要他处理一下」，但主题是
      // **异味 / 空气**而不是「清掉地漏里的头发」——路由 none 时必须零黑名单命中，落回
      // 完整协调流程，**不得**被这条黑名单按关键词误拦。
      const odor = await routeApprovedFeature(
        "屋里一股烂奶酪味，你跟阿杰说让他处理一下",
        textOnly(FEATURE_ROUTE_NONE)
      );
      assert.equal(odor.blacklisted, null, "异味交办不是这条黑名单主题，不得被拦");
      assert.equal(odor.match, null, "异味交办不是已批准功能");
      assert.equal(odor.replyOnly, false, "异味交办不是 reply_only");
      // 讨论 / 征询地漏头发话题（不是交办）同样不得被拦。
      const discussHygiene = await routeApprovedFeature(
        "浴室地漏的头发没人清理，你怎么看？",
        textOnly(FEATURE_ROUTE_NONE)
      );
      assert.equal(discussHygiene.blacklisted, null, "讨论 / 征询话题不得被当成交办拦截");

      // 解释性 / JSON / 字段名漂移文本：一律安全当 none，不解析、不猜。
      for (const explained of [
        "我觉得是 night_laundry",
        "结果：night_laundry。",
        '{"name":"night_laundry"}',
        '{"id":"night_laundry"}',
        '{"type":"none"}',
        "night_laundry 或 personal_item",
      ]) {
        const r = await routeApprovedFeature("提醒 阿川 深夜别开洗衣机", textOnly(explained));
        assert.equal(r.match, null, `解释性 / JSON 文本不得命中：${explained}`);
        assert.equal(r.replyOnly, false, `解释性 / JSON 文本不得被当成 reply_only：${explained}`);
      }
    }
  );

  await checkAsync(
    "地漏头发交办被黑名单收口：纯代码真话、零出站、不进抽取 / 生成；邻接非本功能请求不被误拦",
    async () => {
      const drainHair = BLACKLISTED_CAPABILITIES[0];
      // 前门那一次路由选中 blocked:<id>：整轮在功能入口内收口，**不进完整主生成、
      // 不调 contactPerson**——只回一句纯代码真话，零工具、零第三方出站，也不抽取 / 生成。
      const blocked = await runFeature(
        "阿川最近老把地漏堵住，头发也不清理。请叫他把地漏的头发清干净。",
        { feature_route: blacklistRouteToken(drainHair.id) }
      );
      assert.equal(blocked.run.mode, "blacklisted", "地漏头发交办必须由黑名单收口");
      assert.equal(blocked.handling?.status, "handled");
      assert.equal(blocked.handling?.reply, blacklistedReply(drainHair), "回复必须是纯代码真话");
      assert.equal(blocked.handling?.sms, null, "黑名单零第三方短信");
      assert.equal(blocked.repo.thirdParty().length, 0, "黑名单不得给任何人出站");
      assert.equal(blocked.repo.decisions.length, 0, "黑名单不产生联系决策（不进主生成）");
      assert.deepEqual(
        blocked.calls.map((c) => c.name),
        [FEATURE_ROUTE_NAME],
        "黑名单只花那一次路由，不抽取、不生成"
      );
      // 邻接反例（只差一个条件）：同样点名一位同住人、同样「让他处理一下」，但主题是
      // **异味 / 空气**，不是「清掉地漏里的头发」。路由 none → 落回完整协调流程（不是拒绝），
      // 不得被这条黑名单按主题词误拦。
      const odor = await runFeature("屋里一股烂奶酪味，你跟阿杰说让他处理一下", {
        feature_route: FEATURE_ROUTE_NONE,
      });
      assert.equal(odor.run.mode, "none", "异味交办不是黑名单，落回完整流程");
      assert.equal(odor.handling, null, "落回完整流程时前门不产出 handling");
      assert.equal(odor.repo.thirdParty().length, 0, "前门零出站（是否联系交主生成判断）");
    }
  );

  await checkAsync(
    "黑名单资格复核（纯代码）：路由即使选了 blocked:<id>，原话缺必要信号也落回完整流程",
    async () => {
      const drainHair = BLACKLISTED_CAPABILITIES[0];
      // 资格复核判据本身就写在这一个条目上（引擎无主题分支）。
      // Codex 2026-09-13 退回后补测：明确的**同义清走动作短语**同样要命中（清干净 / 弄掉 /
      // 清理掉 / 捡走 / 拿走），且都带「叫 / 让 / 请对方办」的交办语义。
      for (const ok of [
        "阿川最近老把地漏堵住，头发也不清理。请叫他把地漏的头发清干净。",
        "你让阿川洗完澡把地漏里的头发弄掉。",
        "你让阿川把地漏里的头发清理掉。",
        "叫阿川把地漏里的头发捡走。",
        "请让阿川把地漏里的头发拿走。",
      ]) {
        assert.equal(drainHair.qualifier(ok), true, `应具备本功能必要信号：${ok}`);
      }
      // 相邻行为都**不**具备必要信号：即使路由误选 blocked:<id>，也必须落回完整流程，
      // **不得**被这一项阻断（宁可漏判，不得误杀）。含裸关键词也算不过关。
      for (const adjacent of [
        "请叫阿川把浴室墙面的头发清掉。", // 墙面头发：有头发、没地漏
        "你让阿川把地漏疏通一下。", // 地漏疏通：有地漏、没头发
        "请让阿川把客厅好好打扫一遍。", // 一般打扫：没有地漏 + 头发
        "墙上那块污渍让阿川擦掉。", // 污渍
        "你跟阿杰说让他处理一下屋里的味道。", // 异味
        "你觉得要不要叫阿川清理地漏的头发？", // 征询，不是交办
        "地漏又堵了、头发好多，你说我该不该跟阿川提一下？", // 抱怨 / 问看法
        // Codex 2026-09-13 退回：第一版把「洗 / 弄 / 裸清」当清理信号、把单字「请」当交办，
        // 会把下面这些纯叙述 / 告知 / 提问误当成交办。收窄后必须全部落回完整流程。
        "通知阿川，洗完澡后地漏里有头发。", // 只告知存在，没有要求清走
        "让阿川知道，地漏里有头发，谁弄的还不知道。", // 让=告知对象；弄=来源叙述
        "请问地漏里的头发怎么清理？", // 疑问句，不是叫一位室友去办
      ]) {
        assert.equal(
          drainHair.qualifier(adjacent),
          false,
          `相邻行为不得通过资格复核：${adjacent}`
        );
        const run = await runFeature(adjacent, {
          feature_route: blacklistRouteToken(drainHair.id),
        });
        assert.equal(
          run.run.mode,
          "none",
          `资格复核不通过必须当作 none 落回完整流程：${adjacent}`
        );
        assert.equal(run.handling, null, `不通过时前门不产出 handling：${adjacent}`);
        assert.equal(
          run.repo.thirdParty().length,
          0,
          `不通过时前门零出站（是否联系交主生成判断）：${adjacent}`
        );
      }
    }
  );

  check("共同规则协商状态机：全员同意才定案、单方面整改不进入；接线默认关闭", () => {
    const A = "阿菲";
    const B = "小周";
    const C = "阿凯";
    const P = [A, B, C];
    const RULE = "每个人洗完澡后把地漏里的头发清掉";
    const propose: RuleIntent = {
      type: "propose_rule",
      rule: RULE,
      ruleDefinitionId: SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID,
    };
    const agree: RuleIntent = { type: "state_position", position: "agree" };
    const disagree: RuleIntent = { type: "state_position", position: "disagree" };
    const step = (events: readonly RuleEvent[], intent: RuleIntent, sender: string) =>
      stepRule(events, intent, { participants: P, sender });
    // 模拟「动作都送达成功」：追加对应回执事件（真机上由投递成功后的 deliverRuleActions 写）。
    const withReceipts = (
      evs: RuleEvent[],
      actions: ReturnType<typeof stepRule>["actions"]
    ): RuleEvent[] => {
      const out = [...evs];
      for (const a of actions) {
        const r = receiptEventFor(a);
        if (r) out.push(r);
      }
      return out;
    };

    // 提出 → 只向尚未表态的人征询；发起人视为同意、不被征询。
    const p = step([], propose, A);
    assert.deepEqual(p.actions, [
      { type: "consult", person: B },
      { type: "consult", person: C },
    ]);
    // **事实事件**里绝不出现 consulted / announced——那两个是送达回执，必须先发成功。
    assert.equal(
      p.events.some((e) => e.type === "consulted" || e.type === "announced"),
      false,
      "stepRule 只产出事实事件；consulted / announced 必须由送达成功后的调用方另记"
    );
    // 首次 rule_proposed 事实事件必须携带上层给出的稳定规则定义 id（不是从自由文本重猜）。
    const firstEvent = p.events[0];
    assert.equal(
      firstEvent.type === "rule_proposed" ? firstEvent.ruleDefinitionId : null,
      SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID,
      "首次事实事件必须携带稳定规则定义 id"
    );
    // 模拟两条征询都送达成功 → 才追加回执。
    let events: RuleEvent[] = withReceipts(p.events, p.actions);

    // 未全员同意前绝不定案。
    const b = step(events, agree, B);
    events = [...events, ...b.events];
    assert.equal(reduceRule(events), "proposed", "少一人同意绝不能定案");
    assert.equal(b.actions.every((a) => a.type !== "announce"), true, "未定案不得宣布");

    // 同意过的人不被重复征询。
    const ask = step(events, { type: "ask_status" }, A);
    assert.deepEqual(ask.actions, [{ type: "none" }], "已征询的人不重复问");

    // 全员同意 → 定案 + 向全员宣布；再模拟宣布都送达、不变量通过。
    const c = step(events, agree, C);
    events = [...events, ...c.events];
    assert.equal(reduceRule(events), "settled");
    assert.deepEqual(c.actions, [
      { type: "announce", person: A },
      { type: "announce", person: B },
      { type: "announce", person: C },
    ]);
    events = withReceipts(events, c.actions);
    assert.deepEqual(checkRuleInvariants(events), []);

    // 失败可重试：宣布只送达了 A（没记 B、C 的 announced）→ 问进度会补发 B、C。
    const partial: RuleEvent[] = [
      ...events.filter((e) => e.type !== "announced"),
      { type: "announced", person: A },
    ];
    assert.deepEqual(
      step(partial, { type: "ask_status" }, A).actions,
      [
        { type: "announce", person: B },
        { type: "announce", person: C },
      ],
      "没送达的宣布必须能在问进度时补发"
    );

    // 有人不同意 → 绝不定案，其余人同意也不翻转。
    let ev2: RuleEvent[] = step([], propose, A).events;
    const no = step(ev2, disagree, B);
    ev2 = [...ev2, ...no.events];
    assert.equal(reduceRule(ev2), "objected");
    const yes = step(ev2, agree, C);
    ev2 = [...ev2, ...yes.events];
    assert.equal(reduceRule(ev2), "objected", "有人反对后其余同意也不定案");
    assert.equal(yes.actions.every((a) => a.type !== "announce"), true);

    // 少一人同意就定案的手工日志必须被不变量挡下（C 已被征询却还没表态）。
    assert.ok(
      checkRuleInvariants([
        { type: "rule_proposed", rule: RULE, initiator: A },
        { type: "consulted", person: B },
        { type: "consulted", person: C },
        { type: "position_recorded", person: B, position: "agree" },
        { type: "rule_settled" },
      ]).length > 0,
      "少一人同意就定案必须报错"
    );

    // 投影不含任何来源身份字段（发起人只是参与者之一，不被打来源标签）。
    const proj = projectRule(ev2, { participants: P, sender: C });
    assert.equal(JSON.stringify(proj).includes("initiator"), false, "投影不得带来源身份字段");
    assert.equal(
      proj.ruleDefinitionId,
      SHOWER_DRAIN_HAIR_AFTER_USE_RULE_ID,
      "投影必须携带首次事件的稳定规则定义 id（按 id 查表，不从自由文本重猜）"
    );
    assert.equal(foldRule(ev2).initiator, A, "发起人只在内部快照里，供审计");

    // 窄识别：这条共同规则命中；单方面点名要求 / 相邻话题都不命中。
    assert.equal(
      recognizeSharedShowerDrainHairRule(
        "咱们能不能定一个规则，每个人洗完澡后把地漏里的头发清掉。"
      ).ok,
      true
    );
    for (const notIt of [
      "请叫阿川把地漏的头发清干净。",
      "你让阿川把地漏里的头发弄掉。",
      "咱们把浴室墙面的头发清掉吧。",
      "大家说地漏堵了要疏通，我们定个规则吧。",
      "咱们定个规则，大家轮流打扫客厅卫生。",
    ]) {
      assert.equal(
        recognizeSharedShowerDrainHairRule(notIt).ok,
        false,
        `不得进入共同规则状态机：${notIt}`
      );
    }

    // 来源隐私：规则事实是中性固定语义，不保留原句里的姓名 / 指责 / 私人理由。
    const accusatory =
      "阿川总不清理地漏的头发，烦死了，所以咱们定个规则，每个人洗完澡后把地漏里的头发清掉。";
    const recPrivacy = recognizeSharedShowerDrainHairRule(accusatory);
    assert.equal(recPrivacy.ok, true, "共同规则提案仍应被识别");
    assert.equal(
      recPrivacy.ok && recPrivacy.rule,
      SHARED_SHOWER_DRAIN_HAIR_RULE_FACT,
      "规则事实必须是中性固定语义事实"
    );
    assert.equal(
      recPrivacy.ok && /阿川|烦|总不/.test(recPrivacy.rule),
      false,
      "规则事实不得保留姓名 / 指责 / 理由"
    );

    // 身份按 personId：同名住户不合并，收件人按 id 解析。
    const roster = [
      { personId: "id-阿川-1", name: "阿川" },
      { personId: "id-阿川-2", name: "阿川" },
      { personId: "id-阿川-3", name: "阿川" },
    ];
    const recipients = resolveRuleActionRecipients(
      [
        { type: "consult", person: "id-阿川-2" },
        { type: "consult", person: "id-阿川-3" },
      ],
      roster
    );
    assert.deepEqual(
      recipients.map((r) => r.member.personId),
      ["id-阿川-2", "id-阿川-3"],
      "收件人必须按 personId 解析（同名也分得开、不串收）"
    );

    // 表态解析：不同意优先于同意；无关长句不被劫持。
    assert.deepEqual(parseOpenRuleSessionIntent("我不同意"), {
      type: "state_position",
      position: "disagree",
    });
    assert.equal(parseOpenRuleSessionIntent("我今天下班挺晚的还要去买菜"), null);

    // 会话文件按 household 分文件（同一 id 两侧换算一致）。
    assert.ok(
      ruleSessionEventsFile("/tmp/x", "h/hh").endsWith("h_hh.rule.events.jsonl"),
      "会话事件文件名必须按 household 安全化"
    );

    // 默认关闭的接线：env 闸 + 「未定案不得说生效」纯代码真话闸 + 会话入口。
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert.ok(src.includes("COLIVING_COORDINATION_SHARED_RULE"), "turn.ts 必须有默认关闭的 env 闸");
    assert.ok(src.includes("claimsSharedRuleSettled"), "turn.ts 必须有未定案不得说生效的真话闸");
    assert.ok(src.includes("advanceRuleConsultationSession"), "turn.ts 必须调用共同规则会话入口");
    assert.ok(
      src.includes("deliverRuleActions"),
      "turn.ts 投递必须走 deliverRuleActions（送达成功才记回执）"
    );
    assert.ok(
      src.includes("recordRuleReceipt"),
      "turn.ts 必须在本人回复落库之后才记回执"
    );
    // 回执只能由 receiptEventFor 映射产出；且 deliverRuleActions 必须先 send 成功、再记回执。
    const sessionSrc = readFileSync("lib/chat/coliving/rule-consultation-session.ts", "utf8");
    assert.ok(sessionSrc.includes("receiptEventFor"), "回执事件只能由 receiptEventFor 映射产出");
    assert.ok(
      sessionSrc.indexOf("await send(action)") < sessionSrc.indexOf("recordRuleReceipt(householdId, action"),
      "deliverRuleActions 必须先 send 成功、再记回执（顺序不能反）"
    );
    // 身份一律 personId：参与者名单不能用 display name，收件人按 id 解析。
    assert.ok(
      src.includes("resolveRuleActionRecipients"),
      "turn.ts 收件人必须按 personId 解析（不能按 display name）"
    );
    // 名单接线必须同时证明两件事：先排除已搬离者（resides===false），再映射 personId。
    // 只认这条具体形状，不放宽为「任意含 personId 的文本」。
    assert.ok(
      /const participants = members\s*\.filter\(\(m\) => m\.resides !== false\)\s*\.map\(\(m\) => m\.personId\)/.test(
        src
      ),
      "共同规则参与者名单必须排除 resides===false 且仍映射 personId（不是 display name）"
    );

    // 定案授权接线：settled 分支里先落本户精确授权，再生成文案——顺序不能反。
    const settleGrantIdx = src.indexOf("settleSharedRuleGrant({");
    const composeNoticesIdx = src.indexOf("await composeRuleNotices(");
    assert.ok(
      /if \(settled\) \{\s*const settlement = settleSharedRuleGrant\(/.test(src),
      "settled 时必须以 settleSharedRuleGrant 落本户精确授权"
    );
    assert.ok(
      settleGrantIdx !== -1 && composeNoticesIdx !== -1 && settleGrantIdx < composeNoticesIdx,
      "settleSharedRuleGrant 必须在 composeRuleNotices 之前（授权先于文案）"
    );
    assert.ok(
      /settleSharedRuleGrant\(\{\s*dir: resolveRuleSessionDir\(sessionDir\),\s*householdId: sender\.householdId,\s*projection: res\.projection,?\s*\}\)/.test(
        src
      ),
      "settleSharedRuleGrant 必须用 resolveRuleSessionDir(sessionDir) + sender.householdId + res.projection"
    );

    // 前门只在本户功能授权开关打开时读盘；grantedFeatureIds 只作为 runApprovedFeature
    // 第四参数传入，不并进静态 APPROVED_FEATURES 清单。（同一次调用还会带上本轮语言
    // 判定 `language`——两者都是**纯内存入参**，第四个参数是对象字面量、首键必须是
    // grantedFeatureIds，不是清单。）
    assert.ok(
      /if \(process\.env\.COLIVING_COORDINATION_SHARED_RULE === "1"\) \{\s*try \{\s*grantedFeatureIds = activeHouseholdFeatureIds\(/.test(
        src
      ),
      "只有 shared-rule flag === '1' 才读 activeHouseholdFeatureIds"
    );
    assert.equal(
      (src.match(/activeHouseholdFeatureIds\(/g) ?? []).length,
      1,
      "activeHouseholdFeatureIds 只能出现在 flag 闸内这一处，不能绕过开关读授权"
    );
    assert.ok(
      /runApprovedFeature\(\s*args\.text,[\s\S]*?\{ llm: featureLlm, delivery: smsDeliveryDeps \},\s*\{ grantedFeatureIds[^{}]*\}\s*\)/.test(
        src
      ),
      "grantedFeatureIds 必须作为 runApprovedFeature 第四参数传入"
    );
    assert.ok(
      src
        .split("\n")
        .filter((line) => line.includes("APPROVED_FEATURES"))
        .every((line) => !line.includes("grantedFeatureIds")),
      "不得把本户授权 grantedFeatureIds 并进静态 APPROVED_FEATURES"
    );
    assert.equal(
      /APPROVED_FEATURES\s*(?:\.push|\.unshift|\.splice|\.concat)\b/.test(src),
      false,
      "APPROVED_FEATURES 是静态清单，不得在 turn.ts 里被追加 / 合并授权"
    );
  });

  check("corpus-043 共同规则协商：姓名已确认，逐轮断言能在“对外出站为空”时失败", () => {
    const file =
      "lib/chat/coliving/evals/scenarios/corpus-043-shower-drain-hair-shared-rule-2026-09-13.json";
    const scenario = validateScenario(JSON.parse(readFileSync(file, "utf8")), file);

    // 前提：三位住户姓名都已确认。姓名未确认时可达性闸会拒绝一切对外出站，
    // 这正是付费跑出“outbound 全空却结构通过”的根因，必须在这里钉住。
    const names = (scenario.people ?? []).map((p) => p.name);
    assert.ok(names.length >= 3, "必须是至少三位住户的多人场景");
    for (const n of names) {
      assert.ok(
        (scenario.setup?.confirmedNames ?? []).includes(n),
        `住户「${n}」必须在 setup.confirmedNames 里确认姓名（否则对外出站会被闸掉）`
      );
    }

    // 每一轮都必须有机器断言——不能再出现 expect={} 的空场景靠“没断言”假通过。
    assert.ok(
      scenario.turns.every((t) => !!t.expect),
      "每一轮都必须带机器断言（不接受空 expect 假通过）"
    );

    const empty = (): TurnOutcome => ({ toolsUsed: [], reply: "", outbound: [] });
    const outTo = (toName: string, text: string): TurnOutcome["outbound"][number] => ({
      toName,
      text,
    });

    // 第 1 轮：分别征询另外两人。对外出站为空 → 必须判失败（这条断言就是防回归的）。
    const t1 = scenario.turns[0].expect!;
    assert.ok(
      evaluateTurnExpectation(t1, empty()).length > 0,
      "第1轮对外出站为空时必须判失败（不能结构假通过）"
    );
    assert.deepEqual(
      evaluateTurnExpectation(t1, {
        toolsUsed: [],
        reply: "",
        outbound: [outTo("小周", "地漏里的头发"), outTo("阿凯", "地漏里的头发")],
      }),
      []
    );

    // 第 3 轮：全员同意后向另外两人宣布。对外出站为空 → 必须判失败。
    const t3 = scenario.turns[2].expect!;
    assert.ok(
      evaluateTurnExpectation(t3, empty()).length > 0,
      "第3轮对外出站为空时必须判失败"
    );
    assert.deepEqual(
      evaluateTurnExpectation(t3, {
        toolsUsed: [],
        reply: "",
        outbound: [outTo("阿菲", "地漏头发"), outTo("小周", "地漏头发")],
      }),
      []
    );

    // 第 2 / 4 轮：只回当前发言人、不重复广播 / 通知——空出站应通过，一旦对外发就失败。
    for (const idx of [1, 3]) {
      const ex = scenario.turns[idx].expect!;
      assert.deepEqual(
        evaluateTurnExpectation(ex, empty()),
        [],
        `第${idx + 1}轮零第三方出站应通过`
      );
      assert.ok(
        evaluateTurnExpectation(ex, {
          toolsUsed: [],
          reply: "",
          outbound: [outTo("阿凯", "重复广播")],
        }).length > 0,
        `第${idx + 1}轮不该产生第三方出站`
      );
    }
  });

  check("收件人绑定：只能绑住户原话里点名且唯一的那位同住人（模型改不了人）", () => {
    const text =
      "阿川又拿了我放在客厅的充电器，用完也不放回去。你帮我跟他说一下，以后动我东西前先跟我打个招呼。";
    const ok = resolveNamedRecipient(text, gateMembers, GATE_SENDER);
    assert(ok.ok && ok.recipient.personId === GATE_ACHUAN, "点名唯一时绑定到阿川");
    assert.equal(
      resolveNamedRecipient("提醒一下，深夜别开洗衣机", gateMembers, GATE_SENDER).ok,
      false,
      "原话没点名时不得绑定"
    );
    assert.equal(
      resolveNamedRecipient("提醒小禾深夜别开洗衣机", gateMembers, GATE_SENDER).ok,
      false,
      "不得把发起人自己当收件人"
    );
    const three: GateMember[] = [
      gateMember(GATE_SENDER, "小禾"),
      gateMember(GATE_ACHUAN, "阿川"),
      gateMember(GATE_XIAOMEI, "小美"),
    ];
    const amb = resolveNamedRecipient("帮我提醒阿川小美深夜别开洗衣机", three, GATE_SENDER);
    assert.equal(amb.ok, false, "点名不止一位时不唯一，不得绑定");
    assert.equal(
      amb.ok === false && amb.reason === AMBIGUOUS_SMS_RECIPIENT_REPLY,
      true,
      "收件人不唯一时给住户的是一句澄清"
    );
  });

  check("可达性真话说明：姓名未确认 / 当前渠道无地址时不可发，可发时为 null", () => {
    assert.notEqual(
      smsRecipientIneligibleReply({ name: "阿川", nameConfirmed: false, address: "+1555" }),
      null,
      "姓名未确认必须给出真话说明"
    );
    assert.notEqual(
      smsRecipientIneligibleReply({ name: "阿川", nameConfirmed: true, address: null }),
      null,
      "没有地址必须给出真话说明"
    );
    assert.equal(
      smsRecipientIneligibleReply({ name: "阿川", nameConfirmed: true, address: "+1555" }),
      null,
      "姓名已确认且有地址时可发"
    );
  });

  /**
   * ── 表驱动：**收件人绑不上时那两句澄清按轮次语言说** ──────────────────────
   *
   * 这两句 `reason` 会被功能模块当**本轮回复**发给住户（`personal-item-reminder.ts` /
   * `night-laundry-reminder.ts` 的 `reply`），所以和正文一样必须说住户这一轮的语言。
   * 语言由轮次判定（经前门注入 `ctx.language`）传进来，**不在这里重算**：
   * `BARE_OK`（住户只回一个 `ok`）那一行的依据全在会话回退里，从原话现推只会推成中文。
   *
   * 中文那两行是既有口径，一字不动；英文那两行**不得夹汉字**（收件人姓名除外——那是
   * 名册里的名字，不是文案）。
   */
  check("表驱动：收件人澄清句跟随轮次判定（直接英文 / 中文一字不动 / 只回一个 ok 的会话回退）", () => {
    const zhDirect = decideLanguage("帮我提醒阿川小美深夜别开洗衣机");
    const enDirect = decideLanguage("please remind Alex and Xiaomei about the dryer");
    const zhFallback = decideLanguage("ok", [{ role: "user", content: "提醒阿川别开洗衣机" }]);
    const enFallback = decideLanguage("ok", [
      { role: "assistant", content: "Sure — I've asked Achuan to avoid the dryer." },
    ]);
    assert.equal(zhDirect.language, "zh");
    assert.equal(enDirect.language, "en");
    assert.equal(zhFallback.source, "conversation-fallback");
    assert.equal(zhFallback.language, "zh");
    assert.equal(enFallback.source, "conversation-fallback");
    assert.equal(enFallback.language, "en");

    const three: GateMember[] = [
      gateMember(GATE_SENDER, "小禾"),
      gateMember(GATE_ACHUAN, "阿川"),
      gateMember(GATE_XIAOMEI, "小美"),
    ];
    const ambiguous = "帮我提醒阿川小美深夜别开洗衣机";
    const unnamed = "提醒一下，深夜别开洗衣机";

    // 缺省 = 中文，与加语言闸之前逐字一致（既有调用一行不改）。
    const ambDefault = resolveNamedRecipient(ambiguous, three, GATE_SENDER);
    assert.equal(ambDefault.ok, false);
    assert.equal(ambDefault.ok === false && ambDefault.reason, AMBIGUOUS_SMS_RECIPIENT_REPLY);
    const unnamedDefault = resolveNamedRecipient(unnamed, three, GATE_SENDER);
    assert.equal(unnamedDefault.ok === false && unnamedDefault.reason, NO_NAMED_RECIPIENT_REPLY);

    const rows: readonly {
      language: "zh" | "en";
      ambiguous: string;
      unnamed: string;
      han: boolean;
    }[] = [
      {
        language: "zh",
        ambiguous: AMBIGUOUS_SMS_RECIPIENT_REPLY,
        unnamed: NO_NAMED_RECIPIENT_REPLY,
        han: true,
      },
      {
        language: "en",
        ambiguous: AMBIGUOUS_SMS_RECIPIENT_REPLY_EN,
        unnamed: NO_NAMED_RECIPIENT_REPLY_EN,
        han: false,
      },
    ];
    for (const row of rows) {
      // **逐字相等**：中文行仍是既有那两句（一字不动），英文行是登记好的英文句——
      // 不是"碰巧没汉字"的任意一句。
      const amb = resolveNamedRecipient(ambiguous, three, GATE_SENDER, row.language);
      assert.equal(amb.ok, false, `[${row.language}] 点名不止一位不得绑定`);
      assert.equal(amb.ok === false && amb.reason, row.ambiguous, `[${row.language}] 不唯一澄清句`);

      const unnamedRow = resolveNamedRecipient(unnamed, three, GATE_SENDER, row.language);
      assert.equal(unnamedRow.ok, false, `[${row.language}] 没点名不得绑定`);
      assert.equal(
        unnamedRow.ok === false && unnamedRow.reason,
        row.unnamed,
        `[${row.language}] 未点名澄清句`
      );

      // 可达性真话说明同样是住户可见的回复：按语言取，姓名原样嵌在句中。
      const unconfirmed = smsRecipientIneligibleReply(
        { name: "Alex", nameConfirmed: false, address: "+1555" },
        row.language
      );
      const noAddress = smsRecipientIneligibleReply(
        { name: "Alex", nameConfirmed: true, address: null },
        row.language
      );
      assert(unconfirmed && noAddress, `[${row.language}] 两种不可达都要给真话说明`);
      assert(unconfirmed!.includes("Alex") && noAddress!.includes("Alex"), "姓名原样保留");
      // 姓名（Alex）之外不得有汉字（中文行则必须仍是中文）。
      assert.equal(
        /[一-龥]/.test(unconfirmed! + noAddress!),
        row.han,
        `[${row.language}] 不可达说明的语言`
      );
      assert.notEqual(unconfirmed, noAddress, `[${row.language}] 两种原因不得混成同一句`);
    }
  });

  /**
   * ── 表驱动：**轮次里那几处代码写死的住户可见回复都跟随轮次判定** ──────────────
   *
   * 覆盖四条被点名的硬路径：
   *
   * 1. `unknownSenderReply`（认不出的号码）——**唯一允许按原话现推的地方**：认不出人就
   *    没有会话线，没有 `history` 可回退。判得出就按判出来的说，判不出仍是中文。
   * 2. `selectUnsentContactFallback`（假完成替换）——两个维度：本人立场是否记账 × 语言。
   * 3. `ruleNoticeFallback`（共同规则文案没写出来时的兜底）。
   * 4. `coordinationReplyForSender`（厨房排班状态机的四个模板 + 终态短句）——这条路径
   *    **英文可以走到**（识别看的是系统发出去的那条征询，与住户这一句的语言无关）。
   *
   * 中文每一格都必须**逐字**等于加语言闸之前的既有口径；英文每一格都不得夹汉字。
   */
  check("表驱动：认不出的号码 / 假完成替换 / 规则协商兜底 / 排班模板都跟随轮次判定", () => {
    const han = (s: string) => /[一-龥]/.test(s);

    // 1) 认不出的号码：按原话现推（如实测：英文原话回英文，中文 / 读不出的回中文）。
    assert.equal(unknownSenderReply("这个号码我这边没有记录"), UNKNOWN_REPLY);
    assert.equal(unknownSenderReply("Hi, who is this?"), UNKNOWN_REPLY_EN);
    assert.equal(
      unknownSenderReply("ok"),
      UNKNOWN_REPLY,
      "读不出的原话仍回中文（与加语言闸之前逐字一致）"
    );
    assert.equal(han(UNKNOWN_REPLY_EN), false);

    // 2) 假完成替换：本人立场记账 × 语言，四格。
    assert.equal(
      selectUnsentContactFallback({ recordedOwnStance: false }),
      TRUTHFUL_UNSENT_REPLY,
      "缺省中文、未记账：既有泛化未发送真话一字不动"
    );
    assert.equal(
      selectUnsentContactFallback({ recordedOwnStance: false, language: "en" }),
      TRUTHFUL_UNSENT_REPLY_EN
    );
    assert.equal(han(TRUTHFUL_UNSENT_REPLY_EN), false);
    assert.equal(
      selectUnsentContactFallback({ recordedOwnStance: true, language: "zh" }),
      STANCE_ACK_REPLY,
      "中文、已记账：既有短确认一字不动"
    );
    assert.equal(
      selectUnsentContactFallback({ recordedOwnStance: true, language: "en" }),
      STANCE_ACK_REPLY_EN,
      "英文、已记账：登记好的英文短确认"
    );
    assert.equal(han(STANCE_ACK_REPLY_EN), false);
    assert.equal(
      /联系|转给|转告|发给|生效|定下来|定了|通过|全员|都说好了|contacted|told|passed|effective|agreed/.test(
        selectUnsentContactFallback({ recordedOwnStance: true, language: "en" })
      ),
      false,
      "英文短确认同样不得声称联系过人或规则已定案"
    );

    // 3) 共同规则兜底：中文一字不动，英文是登记好的那一句。
    assert.equal(ruleNoticeFallback("zh"), RULE_NOTICE_FALLBACK);
    assert.equal(ruleNoticeFallback("en"), RULE_NOTICE_FALLBACK_EN);
    assert.equal(han(ruleNoticeFallback("en")), false);

    // 4) 厨房排班模板：五个分支 × 两种语言。中文逐字对照既有模板，英文不得夹汉字。
    const slot = { start: 18 * 60, end: 20 * 60 };
    const cases: readonly {
      label: string;
      actions: readonly OutboundAction[];
      state: State;
      zh: RegExp;
    }[] = [
      {
        label: "settle",
        actions: [{ type: "settle", person: "阿川", slot }],
        state: "settled",
        zh: /^定案：你 /,
      },
      {
        label: "propose",
        actions: [{ type: "propose", person: "阿川", slot }],
        state: "proposed",
        zh: /^关于厨房排班，先排你用 /,
      },
      {
        label: "remind",
        actions: [{ type: "remind", person: "阿川" }],
        state: "gathering",
        zh: /^还没收到你的做饭时间/,
      },
      {
        label: "blocked",
        actions: [
          {
            type: "blocked",
            reasons: [{ kind: "duration_over_window", message: "所有人合计需占用 900 分钟" }],
          },
        ],
        state: "gathering",
        zh: /^暂时排不开：/,
      },
      { label: "none/gathering", actions: [{ type: "none" }], state: "gathering", zh: /^收到，我记下了。$/ },
      { label: "none/settled", actions: [{ type: "none" }], state: "settled", zh: /^收到。$/ },
    ];
    for (const c of cases) {
      const zh = coordinationReplyForSender(c.actions, c.state, "阿川");
      assert.match(zh, c.zh, `[${c.label}] 中文模板一字不动`);
      const en = coordinationReplyForSender(c.actions, c.state, "阿川", "en");
      assert.equal(han(en), false, `[${c.label}] 英文模板不得夹汉字：${en}`);
      assert.notEqual(en, zh, `[${c.label}] 英文模板必须真的换了一种语言`);
    }
    // blocked 的英文分支**不转发**状态机的内部诊断（那是 `machine.ts` 的诊断文案，
    // 按 CLAUDE.md 的分工不翻译、也不该念给住户）：诊断串不得出现在英文回复里。
    const blockedEn = coordinationReplyForSender(
      [
        {
          type: "blocked",
          reasons: [{ kind: "duration_over_window", message: "所有人合计需占用 900 分钟" }],
        },
      ],
      "gathering",
      "阿川",
      "en"
    );
    assert.equal(
      blockedEn.includes("所有人合计需占用"),
      false,
      "英文 blocked 回复不得把中文内部诊断夹进英文句子"
    );
    // 中文 blocked 仍是既有口径：前缀 + 状态机的诊断原样带出。
    assert(
      coordinationReplyForSender(
        [
          {
            type: "blocked",
            reasons: [{ kind: "duration_over_window", message: "所有人合计需占用 900 分钟" }],
          },
        ],
        "gathering",
        "阿川"
      ).includes("所有人合计需占用 900 分钟"),
      "中文 blocked 回复仍照旧带出状态机诊断"
    );
  });

  /**
   * ── 静态审计闸：**指定模块里不许再出现新的「没被本地化的住户可见字面量」** ─────
   *
   * 它拦的不是"出现汉字"（中文本来就是一等公民），而是**住户可见的回复字面量没有成对的
   * 语言版本**：`language === "en" ? A_EN : A` 这种成对取用是允许的形状；单独写一句
   * 中文正文直接当回复返回，才是要拦的新债。
   *
   * 做法：把指定模块的**源码去掉注释**后逐行扫，凡是被当成 `reply` / `reason` 返回、
   * 或在 `return` 里直接写出的**字符串字面量**含汉字，就必须在同文件里能找到它的
   * 英文对应（同名前缀 + `_EN`，或同一表达式里的 `language === "en"` 三元）。
   *
   * **具名例外**（每一条都必须写明为什么英文走不到）：见下面的 `AUDIT_EXCEPTIONS`。
   * 例外表是**闭合**的：新增一条就必须在这里登记并说明理由，`assert` 会核对每条例外
   * 仍然真的存在于源码里，防止"例外表烂掉、实际早就不需要例外"。
   */
  check("静态审计闸：指定模块里住户可见的回复字面量必须有成对的语言版本", () => {
    const AUDITED_MODULES = [
      "lib/chat/coliving/turn.ts",
      "lib/chat/coliving/sms-delivery.ts",
      "lib/chat/coliving/blacklist.ts",
      "lib/chat/coliving/feature-facts.ts",
      "lib/chat/coliving/feature-qa.ts",
      "lib/chat/coliving/reply-only.ts",
      "lib/chat/coliving/schedule-affirmation.ts",
      "lib/chat/coliving/rule-consultation-notice.ts",
      "lib/chat/coliving/personal-item-reminder.ts",
      "lib/chat/coliving/night-laundry-reminder.ts",
    ] as const;

    /**
     * **具名例外**：这些含汉字的字面量没有成对的语言版本，但**它们根本不是说给住户的**。
     * 每一条都必须写明理由；理由站不住就该修代码，而不是往这张表里加一行。
     *
     * 表是**闭合**的：每条例外都必须仍然真的在源码里被命中，否则下面会断言失败、
     * 逼你把它删掉（防止表烂掉、例外的范围悄悄变大）。
     */
    const AUDIT_EXCEPTIONS: readonly {
      file: string;
      literals: readonly string[];
      why: string;
    }[] = [
      {
        file: "lib/chat/coliving/night-laundry-reminder.ts",
        literals: ["洗衣机", "烘干机", "深夜", "凌晨"],
        why:
          "`machineLabel` / `timeWindowLabel` 是**枚举到中性类别词的映射**，返回值只喂给 " +
          "`composeUser` 拼出的**提示词事实清单**（生成阶段看的收窄字段），不是发给住户的正文。" +
          "发给室友的正文由模型按 `composeSystem` 写、语言由 `structuredCall` 的语言指令定。",
      },
    ];

    /**
     * 去注释，但**保住行号**（块注释里的换行原样留着，行注释只删到行尾）：
     * 报错信息里的行号必须能直接在编辑器里跳过去，否则这条闸没法用。
     */
    const strip = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
        .replace(/\/\/[^\n]*/g, "");
    const literalsOf = (line: string): string[] => {
      const out: string[] = [];
      const re = /"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? "");
      return out;
    };
    /** 一句话里有没有"看得出是英文"的字面量（≥3 个连续 ASCII 字母）。 */
    const hasLatinLiteral = (text: string) =>
      literalsOf(text).some((l) => /[A-Za-z]{3}/.test(l) && !/[一-龥]/.test(l));
    /**
     * 这段话里有没有**语言分支**。两种写法都认：
     * `language === "en" ? A_EN : A`（三元，prettier 常拆成多行），
     * `if (language === "en") { return A_EN } return A`（提前返回），
     * 以及本文件惯用的 `const en = language === "en"` 之后再 `en ? … : …`。
     *
     * **这是启发式**：它证明"附近有一段按语言取用的代码"，不证明"这条字面量就在那条分支
     * 里"。所以它只当**新债的烟雾报警器**用——真要判断英文走不走得到，看下面的具名例外
     * 与 `language.test.ts` 的行为断言。
     */
    const hasLanguageBranch = (text: string) =>
      /language\s*(===|!==)\s*"(en|zh)"/.test(text) || /\ben\s*\?/.test(text);

    /**
     * 另一种允许的形状：**登记数据**。同一条事实的中英文并排登记，取用只经
     * `blacklistDisplayName` 这类解析函数（`label` / `labelEn`、`reason` / `reasonEn`），
     * 所以中文字面量旁边紧挨着就是一个 `…En` 标识符。
     */
    const hasRegisteredSibling = (text: string) => /\b\w*En\b/.test(text);

    /**
     * **顶层块**（顶格声明到下一个顶格声明之间）：这个项目里一个函数 / 一个功能对象就是
     * 一块。语言分支通常写成 `if (language === "en") { return … }` 再 `return 中文`，
     * 两者相隔可能十几行，所以"成对"要按**块**判，不能只看行或只看前后三行。
     */
    const topLevelBlocks = (lines: string[]) => {
      const starts: number[] = [];
      for (let i = 0; i < lines.length; i += 1) if (/^\S/.test(lines[i])) starts.push(i);
      return starts.map((start, idx) => ({
        start,
        end: (idx + 1 < starts.length ? starts[idx + 1] : lines.length) - 1,
      }));
    };
    const blockTextAt = (lines: string[], i: number): string => {
      const b = topLevelBlocks(lines).find((x) => x.start <= i && i <= x.end);
      return b ? lines.slice(b.start, b.end + 1).join("\n") : "";
    };

    /**
     * 这段话是不是**正则源码**（`new RegExp("…")` 里的模板串）。住户可见的正文里不会
     * 出现 `\s` / `[abc]` / `{1,3}` 这类元字符，所以按形状就能把它们排除掉——不然
     * 满篇中文的正则会被这条闸当成"没翻的回复"。
     */
    const looksLikeRegexSource = (l: string) =>
      /\\[sdwbSDWB]|\[[^\]]*\]|\{\d+,\d*\}|\(\?:/.test(l);

    /**
     * **内部记录字段**：这些字段的值进台账 / 数据库 / 报告，不是住户看到的字。
     * 任务明确不翻译数据库标签与内部报告，所以它们不在这条闸的范围里（**只列字段名，
     * 不列文件**：同一个字段名出现在哪个模块都是内部记录）。
     */
    const INTERNAL_RECORD_FIELDS = ["purposeLabel", "decisionIntent"] as const;

    /**
     * 这段字面量**所属的那一小段源码**：从它自己往上走到最近的语句边界（`return`、
     * 声明、闭合大括号、以 `;` 结尾的行），最多看 12 行。
     *
     * 为什么要往上走：prettier 会把一个字段的值（尤其是多行三元）拆到下面好几行，
     * 判定"这段字面量属于哪个字段 / 是不是工具返回值"必须看整段，只看一行会看漏。
     */
    const owningSpan = (lines: string[], i: number): string => {
      let start = i;
      for (let k = i; k >= 0 && k > i - 12; k -= 1) {
        const l = lines[k];
        start = k;
        if (
          /^\s*return\b/.test(l) ||
          /^\s*(export|const|let|var|function|async|class|declare)\b/.test(l) ||
          /^\s*\}/.test(l) ||
          /;\s*$/.test(l)
        ) {
          break;
        }
      }
      return lines.slice(start, i + 1).join("\n");
    };

    /**
     * 这段源码是不是**说给模型听的结果对象**——工具返回值（`{ ok, note }` /
     * `{ ok, reason }`）与纯代码闸的诊断（`checkSourcePrivacy` 的 `{ why }`）。
     * 按任务与 CLAUDE.md 的分工，这些**不翻译**：它们是内部诊断 / 报告，不是住户
     * 看到的字，所以整段不在这条闸的范围里。
     *
     * **这个判据有一个已知代价**：`{ ok: false, reason }` 也是某些**辅助函数**的返回形状
     * （`resolveNamedRecipient` 就是），而那种 `reason` 是设计成住户可见的。所以下面
     * 额外钉了一条：在 `sms-delivery.ts` 里，这类段中**一个中文字面量都不许有**——
     * 那个模块的 `reason` 必须走登记常量（`NO_NAMED_RECIPIENT_REPLY` 这类），
     * 一旦有人图省事写成内联中文，那条钉死会先响。
     */
    const isModelFacingSpan = (span: string) =>
      /\bok\s*:\s*(true|false)\b/.test(span) || /\bwhy\s*:/.test(span);

    /**
     * **工具定义的行范围**（`someTool: tool({ … })`）。
     *
     * 整个 `tool({ … })` 块——描述、schema、`execute` 里的返回值——都是**说给模型听的**：
     * 工具描述是提示词，`ok` / `note` / `reason` / `basis` 这些是回执与诊断。按任务与
     * CLAUDE.md 的分工一律不翻译，所以整块跳过。
     *
     * 范围怎么定：起头是缩进 `ind` 的 `<名字>: tool({`，收尾是**同样缩进**的 `}),`。
     * 用缩进相等（而不是"第一个 `}),`"）是为了不被 `execute` 里更深一层的 `}),` 提前截断。
     */
    const toolBlockEnds = (lines: string[]): number[] => {
      const ends = new Set<number>();
      for (let i = 0; i < lines.length; i += 1) {
        const m = /^(\s*)\w+\s*:\s*tool\(\{\s*$/.exec(lines[i]);
        if (!m) continue;
        const indent = m[1].length;
        for (let k = i + 1; k < lines.length; k += 1) {
          const c = /^(\s*)\}\),\s*$/.exec(lines[k]);
          if (c && c[1].length === indent) {
            for (let j = i; j <= k; j += 1) ends.add(j);
            i = k;
            break;
          }
        }
      }
      return [...ends];
    };

    /**
     * 一段源码片段里所有住户可见的、含汉字的字面量（带行号，另把"工具返回值"单列出来）。
     *
     * "住户可见"的判据是**语句级**的，不是行级的：一段字面量只要落在
     * `reply:` / `reason:` 字段，或者落在一条 `return` 语句里（含 prettier 拆到下面
     * 好几行的三元分支），就算住户可见；落在 `const` 声明、`.push(...)`、函数参数里的
     * 中文（结构化事实、给批判器的报告、工具错误）都不算。所以先按 `owningSpan`
     * 找到整条语句，再判。
     */
    const hanLiteralsIn = (lines: string[]) => {
      const found: { line: number; literal: string }[] = [];
      const toolResult: { line: number; literal: string }[] = [];
      const inToolBlock = new Set(toolBlockEnds(lines));
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        // `tool({ … })` 整块是说给模型听的（描述 / schema / 回执 / 诊断）。
        if (inToolBlock.has(i)) continue;
        // 造正则 / 跑正则的行不是住户可见的回复行。
        if (/new RegExp|matchAll\(|\.test\(|\.exec\(/.test(line)) continue;
        // zod 的 `.describe("…")` 是**给模型看的字段说明**，不是住户看到的字。
        if (/\.describe\(/.test(line)) continue;
        const lits = literalsOf(line).filter(
          (l) => /[一-龥]/.test(l) && l.trim().length >= 2 && !looksLikeRegexSource(l)
        );
        if (lits.length === 0) continue;
        const span = owningSpan(lines, i);
        const statementHead = span.split("\n")[0];
        // `return [ "…", "…" ].join("\n")` 是这个项目写**提示词**的固定形状（每一行一句
        // 系统提示），它整段都是说给模型听的，不是住户可见的回复。
        if (/^\s*return\s*\[/.test(statementHead)) continue;
        const isResidentFacing =
          /reply\s*[:=]/.test(line) ||
          /reason\s*[:=]/.test(line) ||
          /^\s*return\b/.test(line) ||
          /^\s*return\b/.test(statementHead);
        if (!isResidentFacing) continue;
        // 内部记录字段（台账 / 数据库 / 报告）的值不是住户可见的字。
        if (INTERNAL_RECORD_FIELDS.some((f) => new RegExp(`\\b${f}\\b`).test(span))) continue;
        // 说给模型听的结果对象也不是——但它们被单独记下来，供下面那条钉死的断言用。
        if (isModelFacingSpan(span)) {
          for (const literal of lits) toolResult.push({ line: i + 1, literal });
          continue;
        }
        for (const literal of lits) found.push({ line: i + 1, literal });
      }
      return { found, toolResult };
    };

    let audited = 0;
    const seen: { file: string; literal: string }[] = [];
    const toolResultSkips: { file: string; line: number; literal: string }[] = [];
    for (const file of AUDITED_MODULES) {
      const lines = strip(readFileSync(file, "utf8")).split("\n");
      const { found, toolResult } = hanLiteralsIn(lines);
      for (const s of toolResult) toolResultSkips.push({ file, ...s });
      for (const { line, literal } of found) {
        audited += 1;
        // 允许的形状一：**所在的那一块**里有语言分支——这条覆盖了绝大多数写法，
        // 因为 `if (language === "en") { return … }` 与后面的 `return 中文` 常常相隔
        // 十几行（中间还夹着别的语句），只看紧邻几行会误判。
        if (hasLanguageBranch(blockTextAt(lines, line - 1))) continue;
        // 允许的形状二：登记数据里中英文并排（`label` / `labelEn`），中文字面量旁边
        // 紧挨着就是一个 `…En` 标识符。
        const window = lines
          .slice(Math.max(0, line - 4), Math.min(lines.length, line + 3))
          .join("\n");
        if (hasRegisteredSibling(window)) continue;
        // 或这段字面量本身只是拼进一个成对常量（同一行内出现 `_EN`）。
        if (/_EN\b/.test(lines[line - 1])) continue;
        const ex = AUDIT_EXCEPTIONS.find(
          (e) => e.file === file && e.literals.some((l) => literal.includes(l))
        );
        if (ex) {
          seen.push({ file, literal });
          continue;
        }
        assert.fail(
          `${file} 第 ${line} 行出现了**没有成对语言版本**的住户可见字面量：` +
            `「${literal}」。请给它一个登记好的英文对应（` +
            `\`language === "en" ? X_EN : X\` 这种成对取用），` +
            `或在这条检查的具名例外里登记并写明英文为什么走不到。`
        );
      }
    }
    assert(audited > 0, "审计闸自己必须真的扫到了住户可见字面量（否则是空转）");
    // 钉死上面那条"工具返回值整段跳过"的代价：`sms-delivery.ts` 的
    // `{ ok: false, reason }` 是**住户可见**的澄清句，所以那个模块里 `ok:` 段中不允许
    // 出现任何中文字面量——`reason` 必须走登记常量。谁要是图省事写成内联中文，
    // 就会先撞上这条（否则它会被"工具返回值不翻译"那条静默放过）。
    const smsLeak = toolResultSkips.filter(
      (s) => s.file === "lib/chat/coliving/sms-delivery.ts"
    );
    assert.equal(
      smsLeak.length,
      0,
      `sms-delivery.ts 的 ok: 段里不许有内联中文字面量（reason 必须走登记常量）：` +
        smsLeak.map((s) => `第 ${s.line} 行「${s.literal}」`).join("；")
    );
    // 例外表是**闭合**的：每一条登记过的例外都必须仍然真的在源码里被命中，
    // 否则它就是一条烂掉的例外（代码早改了、表还留着），必须删掉。
    for (const ex of AUDIT_EXCEPTIONS) {
      for (const literal of ex.literals) {
        assert(
          seen.some((s) => s.file === ex.file && s.literal.includes(literal)),
          `具名例外已经不再命中源码了，请把它从例外表里删掉：${ex.file} / 「${literal}」`
        );
      }
    }
  });

  check("受约束出站源码闸：功能不是工具、边界纯代码、旧模块清干净", () => {
    for (const gone of [
      "approved-reminder.ts",
      "reminder-execution.ts",
      "reminder-ask.ts",
      "reminder-proposal.ts",
      "roommate-message.ts",
    ]) {
      assert(!existsSync(`lib/chat/coliving/${gone}`), `旧架构模块必须删除：${gone}`);
    }
    for (const kept of [
      "features.ts",
      "feature-llm.ts",
      "feature-types.ts",
      "sms-delivery.ts",
      "night-laundry-reminder.ts",
      "personal-item-reminder.ts",
      "reply-only.ts",
      "blacklist.ts",
    ]) {
      assert(existsSync(`lib/chat/coliving/${kept}`), `新架构模块必须存在：${kept}`);
    }
    const strip = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // 功能模块 / 清单 / 投递层 / reply_only 小回复 / 黑名单都不直接调模型
    // （模型调用只经 feature-llm.ts 那一个管道）。
    for (const file of [
      "features.ts",
      "sms-delivery.ts",
      "night-laundry-reminder.ts",
      "personal-item-reminder.ts",
      "reply-only.ts",
      "blacklist.ts",
    ]) {
      const src = readFileSync(`lib/chat/coliving/${file}`, "utf8");
      assert(
        !/generateText|generateObject|streamText|getLanguageModel/.test(src),
        `${file} 不得直接调模型（模型调用只经 feature-llm.ts 的管道）`
      );
    }
    const featureSrc = readFileSync("lib/chat/coliving/features.ts", "utf8");
    assert(
      /APPROVED_FEATURES/.test(featureSrc) &&
        /nightLaundryFeature/.test(featureSrc) &&
        /personalItemFeature/.test(featureSrc),
      "features.ts 必须写死已批准功能清单"
    );
    assert(
      !/\btool\(|inputSchema|functionId|actionCard/.test(strip(featureSrc)),
      "features.ts 不得把功能做成工具 / 动作卡"
    );
    // 一次白名单路由，不是每个功能各判一次：不得并行铺开 judge。
    assert(
      !strip(featureSrc).includes("Promise.all"),
      "features.ts 不得对功能清单并行逐个判定（清单长大 = 每条消息 N 次调用）"
    );
    assert(
      featureSrc.includes("FEATURE_ROUTE_NONE") &&
        /APPROVED_FEATURES\.map/.test(featureSrc) &&
        featureSrc.includes("runApprovedFeature"),
      "features.ts 必须由代码清单构造白名单路由并只暴露单一编排入口"
    );
    // reply_only 是**路由器的保留结果**，不是功能、不是工具、不在清单里：
    // 它由 reply-only.ts 的独立小回复生成承接（无工具、无出站）。
    assert(
      featureSrc.includes("FEATURE_ROUTE_REPLY_ONLY") &&
        featureSrc.includes("generateReplyOnlyReply"),
      "features.ts 必须把 reply_only 作为保留结果接线到独立小回复生成"
    );
    assert(
      !/id:\s*"reply_only"/.test(featureSrc) && !/reply_only/.test(
        APPROVED_FEATURES.map((f) => f.id).join(",")
      ),
      "reply_only 不得被登记成一项已批准功能"
    );
    const replyOnlySrc = readFileSync("lib/chat/coliving/reply-only.ts", "utf8");
    assert(
      replyOnlySrc.includes("REPLY_ONLY_STAGE") &&
        replyOnlySrc.includes("structuredCall") &&
        !/\btool\(|inputSchema|functionId|actionCard|deliverSms|contactPerson/.test(
          strip(replyOnlySrc)
        ),
      "reply_only 小回复必须无工具、无出站（不得出现工具 schema / 投递 / 联系）"
    );
    assert(
      !/\b(from|import)\b[^\n]*\brepo\b/.test(replyOnlySrc),
      "reply_only 不得直接写库（只生成一句回给当前住户的话）"
    );
    // 默认宽容后 unsupported 保留结果被移除：清单外主题不再被自动拒绝，落回主生成。
    assert(
      !featureSrc.includes("FEATURE_ROUTE_UNSUPPORTED") &&
        !featureSrc.includes("unsupported"),
      "features.ts 不得再保留只服务旧 default-deny 的 unsupported 路由"
    );
    assert(
      !existsSync("lib/chat/coliving/unsupported.ts"),
      "只服务旧 default-deny 的 unsupported.ts 必须删除"
    );
    // 显式黑名单是"办不了"的唯一起源：复用同一次功能路由的 `blocked:<id>` token，
    // 纯代码解析、零模型调用、表里没有的 id 恒不命中；**不得退回按关键词在原话上直接命中**。
    const blacklistSrc = readFileSync("lib/chat/coliving/blacklist.ts", "utf8");
    assert(
      blacklistSrc.includes("BLACKLISTED_CAPABILITIES") &&
        blacklistSrc.includes("blacklistedCapabilityByRouteToken") &&
        blacklistSrc.includes("blacklistRouteToken") &&
        blacklistSrc.includes("BLACKLIST_ROUTE_PREFIX"),
      "blacklist.ts 必须提供显式黑名单数据与复用那次路由的 blocked: token 解析"
    );
    // 这两条否定断言只扫**剥离注释后的代码**：blacklist.ts 顶部保留了"为什么淘汰
    // 旧的关键词命中"的历史说明，里面会提到这些被淘汰的函数名，不能在注释上误报。
    const blacklistCode = strip(blacklistSrc);
    assert(
      !/\bmatchBlacklistedCapabilityId\b/.test(blacklistCode),
      "黑名单执行阻断不得退回旧的关键词原话命中（讨论 / 否定 / 引用会被误判成交办）"
    );
    assert(
      !/\bselectBlacklistedCapabilities\b/.test(blacklistCode),
      "黑名单解析不得依赖问答侧的关键词关联函数"
    );
    // 老板 2026-09-13 纠正：黑名单**不是空表**——已登记唯一一项
    // 「单方面叫别人在洗完澡后清理地漏头发」（精确行为，不是"一类主题"）。
    // 但也不得因为"不在已批准清单里"就把别的主题塞进黑名单（只有老板点名要拒绝的才加）。
    assert(
      BLACKLISTED_CAPABILITIES.length === 1 &&
        BLACKLISTED_CAPABILITIES[0].id ===
          "ask-named-roommate-clean-shower-drain-hair" &&
        BLACKLISTED_CAPABILITIES[0].label ===
          "单方面叫别人在洗完澡后清理地漏头发",
      "当前黑名单只允许登记「单方面叫别人在洗完澡后清理地漏头发」一项（不是空表）"
    );
    assert(
      /const BLACKLISTED_CAPABILITIES[^=]*=\s*\[/.test(blacklistSrc) &&
        !/const BLACKLISTED_CAPABILITIES[^=]*=\s*\[\s*\]/.test(blacklistSrc),
      "blacklist.ts 的显式清单不得再写成空表"
    );
    assert(
      !/generateText|generateObject|structuredCall|getLanguageModel/.test(blacklistSrc),
      "黑名单匹配必须是纯代码，不得加任何 LLM 调用"
    );
    // 黑名单**复用同一次功能路由**：条目作为 blocked:<id> 选项进 routeSystem，
    // 解析走 blacklistedCapabilityByRouteToken，命中后走 mode "blacklisted"——
    // 不新增第二次 LLM 调用，也不在 turn.ts 里按关键词前置拦截。
    assert(
      featureSrc.includes("blacklistRouteToken") &&
        featureSrc.includes("blacklistedCapabilityByRouteToken") &&
        featureSrc.includes("BLACKLISTED_CAPABILITIES"),
      "features.ts 必须把黑名单复用进那一次路由（blocked: token），不另开调用"
    );
    assert(
      /mode:\s*"blacklisted"/.test(featureSrc) && /"blacklisted"/.test(featureSrc),
      "features.ts 必须提供 blacklisted 结果模式（纯代码真话回复、零出站）"
    );
    // 老板 2026-09-13 纠正：功能是**精确行为不是一类主题**——路由选中 `blocked:<id>` 只是
    // 模型判断，代码还要过**该条目自己的** `qualifier` 复核必要信号，不通过则落回完整流程。
    assert(
      /\bqualifier\b/.test(blacklistCode),
      "blacklist.ts 的条目必须带自己的纯代码资格复核（qualifier）"
    );
    assert(
      /blacklisted\.qualifier\(/.test(strip(featureSrc)),
      "features.ts 命中黑名单后必须再过该条目的 qualifier，不通过当作 none"
    );
    // Codex 2026-09-13 退回：资格复核第一版把 `洗` / 弄 / 裸 `清` / 裸 `除` 当清理信号，
    // 于是「洗完澡」「谁弄的」都会满足；单字「请」还会把「请问……」当交办。现在清理信号
    // 必须是明确的两字以上动作短语，且要与「地漏 + 头发」共现在同一局部片段（单测覆盖）。
    const cleanAwayDecl = /const CLEAN_AWAY_SIGNAL\s*=\s*\/([^/]*)\//.exec(blacklistCode);
    assert(
      cleanAwayDecl !== null && !/洗/.test(cleanAwayDecl[1]),
      "黑名单资格复核的清理信号不得含单字「洗」（会被「洗完澡」满足）"
    );
    assert(
      /CLEAN_AWAY_SIGNAL/.test(blacklistCode) && /CLAUSE_SPLIT/.test(blacklistCode),
      "黑名单资格复核必须用明确清走短语 + 局部片段共现（清走动作与地漏+头发同片段）"
    );
    assert(
      !/\bmatchBlacklistedCapabilityId\b/.test(
        strip(readFileSync("lib/chat/coliving/turn.ts", "utf8"))
      ),
      "turn.ts 不得再按关键词前置拦截黑名单（执行阻断只认那一次路由）"
    );
    // 每个功能各写各的 extract / execute，不再各自回答 match。
    for (const file of [
      "night-laundry-reminder.ts",
      "personal-item-reminder.ts",
    ]) {
      const src = readFileSync(`lib/chat/coliving/${file}`, "utf8");
      assert(
        /\bextract\b/.test(src) && /\bexecute\b/.test(src) && /\brouteDescription\b/.test(src),
        `${file} 必须各写各的 extract / execute 与路由定义`
      );
      assert(!/\bjudge\s*\(/.test(src), `${file} 不得再各自回答 match（judge 已并入一次路由）`);
    }
    const deliverySrc = readFileSync("lib/chat/coliving/sms-delivery.ts", "utf8");
    assert(
      deliverySrc.includes("resolveNamedRecipient") &&
        deliverySrc.includes("deliverSms") &&
        deliverySrc.includes("assertCanWrite"),
      "sms-delivery.ts 必须是纯代码的收件人绑定 + 落库投递（过发送硬闸）"
    );
    // 前门顺序：绑定收件人 → 一次路由 → 主生成；命中就收工，不进主生成。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(
      turnSrc.indexOf("resolveNamedRecipient(args.text") <
        turnSrc.indexOf("runApprovedFeature("),
      "收件人绑定必须先于功能路由"
    );
    assert(
      turnSrc.indexOf("runApprovedFeature(") <
        turnSrc.indexOf("assembleSystemPrompt({"),
      "功能前门必须在主生成之前"
    );
    assert(
      turnSrc.includes("runApprovedFeature(") && turnSrc.includes("finalizeFeatureTurn({"),
      "命中后必须由功能入口执行并收尾返回"
    );
    // 前门花掉的钱必须并进最终 TurnUsage：命中轮用 handling 的合计，落回主生成也要加。
    assert(
      turnSrc.includes("frontDoorUsage") &&
        turnSrc.includes("addFeatureUsage(frontDoorUsage, sumUsage(result.steps))"),
      "前门用量（含路由 none / 失败）必须并进本轮最终 TurnUsage"
    );
    // 大脑路由不得再按已被删除的候选信号装载 relay。
    const routeSrc = readFileSync("lib/ai/brains/coliving/index.ts", "utf8");
    assert(
      !routeSrc.includes("roommateMessageCandidate"),
      "大脑路由不得再引用已删除的候选信号"
    );
    assert(
      !/approvedReminder|actionCard|functionId/.test(strip(routeSrc)),
      "大脑路由代码不得残留动作卡命名"
    );
  });

  /**
   * ── 统一功能问答（`feature-qa.ts` + `feature-facts.ts`）的**免费离线**验证 ──
   *
   * 这条路径**不出站、不写库、不装旧 doctrine**：只把事实源里与问题有关的事实交给模型
   * 说人话，遗漏 / 说错事实就换成只含事实源事实的兜底。这里用 mock `FeatureLlm` 真的调用
   * `runFeatureQa` / `generateFeatureQaReply`，断言触发范围、grounding 校验、兜底与
   * 「通用边界不靠编」——不是拿源码里出现过常量冒充行为。
   */
  // 直接给登记好的功能本身：两个显示名（`label` / `labelEn`）并排登记在功能模块里，
  // 由事实源按本轮语言取用——不是在这里另抄一份中英对照表。
  const OPEN_FEATURES: readonly FeatureDisplayName[] = APPROVED_FEATURES;
  const openLabels = OPEN_FEATURES.map((f) => f.label);
  const openLabelsEn = OPEN_FEATURES.map((f) => f.labelEn);
  // 住户会读到的四段原文——**从内容文件现取**，本脚本不复制它们的内容（改文案只改 Markdown）。
  const IDENTITY_ZH = coordinatorCopyText("identity", "zh");
  const IDENTITY_EN = coordinatorCopyText("identity", "en");
  const CAPABILITIES_ZH = coordinatorCopyText("capabilities", "zh");
  const CAPABILITIES_EN = coordinatorCopyText("capabilities", "en");
  const combinedQuestion = "请问为什么连这么简单的功能都没有?那你有什么功能？";

  check(
    "自我介绍 / 能力说明的唯一出处是 doctrine 树里的纯 Markdown（TypeScript 里不再有副本）",
    () => {
      // ① 位置必须在 doctrine 资产树下：`next.config.ts` 的 output tracing 正是按
      //    `lib/ai/brains/**/doctrine/**/*.md` 配的，所以**不需要**新增追踪配置。
      assert(
        COORDINATOR_COPY_RELATIVE_PATH.startsWith("lib/ai/brains/coliving/doctrine/") &&
          COORDINATOR_COPY_RELATIVE_PATH.endsWith(".md"),
        "内容文件必须落在 doctrine 树内（部署追踪按那棵树配，不必新增配置）"
      );
      assert(
        coordinatorCopyPath() ===
          path.join(
            process.cwd(),
            "lib/ai/brains/coliving/doctrine/content/coordinator-self-description.md"
          ),
        "内容文件按仓库根解析（与 doctrine 读取同一套约定）"
      );
      const raw = readFileSync(coordinatorCopyPath(), "utf8");
      // ② 普通散文：没有 frontmatter，也没有 JSON / YAML 结构。
      assert(!/^---\s*$/m.test(raw), "内容文件不得有 frontmatter");
      assert(!/[{}]/.test(raw), "内容文件不得是 JSON / YAML（普通散文即可）");
      // ③ 四个标题各出现一次：改名 / 少一段都会被解析器与这条检查一起抓住。
      for (const heading of COORDINATOR_COPY_HEADINGS) {
        const occurrences = raw.split(`## ${heading}`).length - 1;
        assert.equal(occurrences, 1, `标题「${heading}」必须恰好出现一次（实际 ${occurrences}）`);
      }
      // ④ 四段都非空，且程序取到的就是文件里那串字（取用不改写一个字）。
      for (const heading of COORDINATOR_COPY_HEADINGS) {
        const [kind, language] = heading.split(".") as [
          "identity" | "capabilities",
          "zh" | "en",
        ];
        const text = coordinatorCopyText(kind, language);
        assert(text.trim().length > 0, `「${heading}」不得为空`);
        assert(raw.includes(text), `「${heading}」必须逐字取自内容文件`);
      }
      // ⑤ 那几段通用话在 TypeScript 里**没有副本**：否则又变成两个出处，改一处另一处还是旧的。
      for (const file of [
        "lib/chat/coliving/feature-facts.ts",
        "lib/chat/coliving/feature-qa.ts",
        "lib/chat/coliving/turn.ts",
      ]) {
        const src = readFileSync(file, "utf8");
        for (const text of [IDENTITY_ZH, IDENTITY_EN, CAPABILITIES_ZH, CAPABILITIES_EN]) {
          assert(!src.includes(text), `${file} 不得再复制住户可见文案：${text}`);
        }
      }
    }
  );

  check(
    "统一功能事实源：地漏头发交办是唯一「办不了」条目，开放功能来自 APPROVED_FEATURES",
    () => {
      // 数据质量不变量：每条黑名单条目的理由锚点必须取自它自己的 reason——
      // grounding 校验只读这份数据，引擎里没有主题分支。每条还必须有**自己的**资格复核。
      for (const c of BLACKLISTED_CAPABILITIES) {
        assert(c.validation.reasonAnchors.length > 0, `${c.id} 必须有理由锚点`);
        for (const a of c.validation.reasonAnchors) {
          assert(c.reason.includes(a), `${c.id} 的锚点「${a}」必须取自它自己的 reason`);
        }
        // 英文说法与英文锚点是**并排登记的数据**（不是运行时翻译），同样要成对且自洽：
        // 锚点必须取自它自己的英文理由，否则英文轮次的 grounding 永远判不通过。
        assert(c.labelEn.length > 0, `${c.id} 必须有英文说法（英文住户不该收到中文名称）`);
        assert(c.reasonEn.length > 0, `${c.id} 必须有英文理由`);
        assert(c.validation.reasonAnchorsEn.length > 0, `${c.id} 必须有英文理由锚点`);
        for (const a of c.validation.reasonAnchorsEn) {
          assert(c.reasonEn.includes(a), `${c.id} 的英文锚点「${a}」必须取自它自己的 reasonEn`);
        }
        assert(c.routeDescription.length > 0, `${c.id} 必须有路由定义（执行阻断的唯一依据）`);
        assert(c.keywords.length > 0, `${c.id} 必须保留关键词（只供问答关联预筛）`);
        assert(
          typeof c.qualifier === "function",
          `${c.id} 必须有自己很小的确定性资格复核（精确行为优先于省代码）`
        );
      }
      // 老板 2026-09-13 纠正：黑名单不是空表，且这一项是**精确行为不是一类主题**。
      assert(
        BLACKLISTED_CAPABILITIES.length === 1 &&
          BLACKLISTED_CAPABILITIES[0].id ===
            "ask-named-roommate-clean-shower-drain-hair" &&
          BLACKLISTED_CAPABILITIES[0].label ===
            "单方面叫别人在洗完澡后清理地漏头发",
        "当前黑名单只登记「单方面叫别人在洗完澡后清理地漏头发」一项"
      );
      const drainHair = BLACKLISTED_CAPABILITIES[0];
      // 住户可见的内容（名称 + 理由，**两种语言都是**）不得出现任何内部术语。
      assert(
        !/未开放|白名单|黑名单|路由|模型|提示词/.test(
          drainHair.label + drainHair.reason + drainHair.labelEn + drainHair.reasonEn
        ),
        "黑名单条目对住户可见的内容不得含内部术语"
      );
      // 名称必须表达**具体动作**，不得退回「卫生整改」这类大类叫法。
      assert(
        !/卫生整改|一类|这类/.test(drainHair.label),
        "黑名单名称不得用「一类主题」式的大类说法"
      );
      // 英文说法必须是**英文**：不含汉字，且与中文原话不是同一串（防"登记了但抄了中文"）。
      assert(!/[一-龥]/.test(drainHair.labelEn + drainHair.reasonEn), "英文说法不得含汉字");
      assert.notEqual(drainHair.labelEn, drainHair.label);
      assert.notEqual(drainHair.reasonEn, drainHair.reason);
      // 复用同一次路由：只有精确的 `blocked:<id>` 才命中；裸 id / 表外 id 都不算。
      assert.equal(
        blacklistedCapabilityByRouteToken(blacklistRouteToken(drainHair.id))?.id,
        drainHair.id,
        "blocked:<id> 必须命中对应条目"
      );
      assert.equal(
        blacklistedCapabilityByRouteToken(drainHair.id),
        null,
        "裸 id（无 blocked: 前缀）不算命中"
      );
      assert.equal(
        blacklistedCapabilityByRouteToken(blacklistRouteToken("no-such-capability")),
        null,
        "表里没有的 blocked: id 恒不命中"
      );
      assert.equal(blacklistedCapabilityById(drainHair.id)?.id, drainHair.id, "按 id 能取回条目");
      // 问答把「问题」关联到条目：只对**在问这项精确功能**的问题命中；别的主题 / 闲聊 / 相邻
      // 主题一律不选（否则会把普通协调请求、把「清墙面头发 / 疏通地漏」误说成「办不了」）。
      assert.equal(
        selectBlacklistedCapabilities("为什么不能让他清理地漏的头发？")[0]?.id,
        drainHair.id,
        "问到这项功能的问题要关联到该条目"
      );
      for (const q of [
        "为什么不行",
        "今天天气不错",
        // 相邻主题（只差一个条件）不得被关联到本条目。
        "为什么不能让他清理浴室墙面的头发？",
        "为什么不能让他把地漏疏通一下？",
        "为什么不能让他打扫一下卫生？",
        // 异味 / 空气不是「清掉地漏里的头发」，同一个收件人也不算黑名单主题。
        "屋里一股烂奶酪味，你跟阿杰说让他处理一下",
        combinedQuestion,
      ]) {
        assert.deepEqual(selectBlacklistedCapabilities(q), [], `不该关联黑名单的问题：${q}`);
      }
      // 纯代码真话回复：带 label + 老板给的理由，无内部术语，过通用 grounding 闸。
      const reply = blacklistedReply(drainHair);
      assert(
        reply.includes(drainHair.label) && reply.includes(drainHair.reason),
        "黑名单回复必须含条目名称与老板给的理由"
      );
      assert(
        !/未开放|白名单|黑名单|路由|提示词|不在.{0,6}(能力|功能)清单/.test(reply),
        "黑名单回复不得含内部术语"
      );
      assert.deepEqual(findGroundingViolations(reply), [], "黑名单真话回复必须过 grounding 闸");
      // 英文轮次取**登记的英文说法**：整句无汉字、名称与理由都在，中文原话不出现。
      const replyEn = blacklistedReply(drainHair, "en");
      assert(!/[一-龥]/.test(replyEn), `黑名单英文真话不得夹汉字：${replyEn}`);
      assert(
        replyEn.includes(drainHair.labelEn) && replyEn.includes(drainHair.reasonEn),
        "黑名单英文回复必须含英文名称与英文理由"
      );
      assert.deepEqual(findGroundingViolations(replyEn), [], "黑名单英文真话同样要过 grounding 闸");
      // 事实源：问到黑名单主题时带出该条目；问到能力清单时不带任何「办不了」条目。
      const drainHairBundle = buildFeatureQaFacts({
        openFeatures: OPEN_FEATURES,
        question: "为什么不能让他清理地漏的头发？",
      });
      assert.equal(
        drainHairBundle.blacklisted[0]?.id,
        drainHair.id,
        "问黑名单主题时事实源要带出该条目"
      );
      const bundle = buildFeatureQaFacts({
        openFeatures: OPEN_FEATURES,
        question: combinedQuestion,
      });
      assert.equal(bundle.blacklisted.length, 0, "问能力清单时不带任何「办不了」条目");
      // 功能名只剩反向守卫用途：清单本身不再交给模型（老板 2026-09-22 不列清单）。
      assert.deepEqual(
        [...bundle.forbiddenOpenFeatureNames],
        [...openLabels],
        "中文轮次的反向守卫就是 APPROVED_FEATURES 的登记名"
      );
      // 问能力只读内容文件的能力段，原文一字不改。
      assert.equal(bundle.blocks.length, 1, "问能力只读一段");
      assert.equal(bundle.blocks[0].kind, "capabilities", "问能力读的是能力段");
      assert.equal(bundle.blocks[0].text, CAPABILITIES_ZH, "能力段原文逐字来自内容文件");
      // 兜底同样只含内容文件原文：问能力时绝不编造「办不了」，也不列功能清单。
      const fb = featureQaFallback({ question: combinedQuestion, openFeatures: OPEN_FEATURES });
      assert.equal(fb, CAPABILITIES_ZH, "问能力的兜底就是内容文件的能力段原文");
      assert(!/办不了|没法|不能做/.test(fb), "问能力的兜底不得编造办不了");
      assert(!openLabels.some((l) => fb.includes(l)), "问能力不列功能清单");
    }
  );

  check("功能问答触发范围：直接问能力也进，普通交办 / 闲聊不进", () => {
    assert.equal(isFeatureQaQuestion(combinedQuestion), true);
    assert.equal(isFeatureQaQuestion("那你有什么功能？"), true);
    assert.equal(isFeatureQaQuestion("这件事刚才为什么办不了"), true);
    assert.equal(asksWhatIsAvailable(combinedQuestion), true, "合并追问要识别为在问能力清单");
    assert.equal(asksWhatIsAvailable("这件事刚才为什么办不了"), false);
    assert.equal(
      isFeatureQaQuestion("阿川最近老把地漏堵住，头发也不清理。请叫他把地漏的头发清干净。"),
      false,
      "普通交办不是功能边界元问题"
    );
    assert.equal(isFeatureQaQuestion("今天晚饭吃什么"), false, "闲聊不进");
  });

  await checkAsync("功能问答：直接问能力也进；无关消息一次模型都不调", async () => {
    const grounded = CAPABILITIES_ZH;
    const { llm } = mockLlm({ [FEATURE_QA_NAME]: JSON.stringify({ reply: grounded }) });
    const qa = await runFeatureQa({
      text: "那你有什么功能？",
      openFeatures: OPEN_FEATURES,
      llm,
    });
    assert(qa, "直接问能力必须进功能问答（通用入口）");
    assert.equal(qa!.reply, grounded, "说清能做什么的原文（内容文件那一段）原样接受");
    assert(!("error" in qa!));

    const { llm: unusedLlm, calls } = mockLlm({});
    const none = await runFeatureQa({
      text: "今天晚饭吃什么",
      openFeatures: OPEN_FEATURES,
      llm: unusedLlm,
    });
    assert.equal(none, null, "无关消息不触发功能问答");
    assert.equal(calls.length, 0, "无关消息一个模型调用都不花");
  });

  await checkAsync("功能问答 grounding：漏说原文 / 列出功能名 / 自创处置方案 / 超长一律回落兜底", async () => {
    const fb = featureQaFallback({ question: combinedQuestion, openFeatures: OPEN_FEATURES });
    const grounded = CAPABILITIES_ZH;
    const missedBlock = "我可以帮大家协调合住的事。";
    const leakedName = `${grounded}${openLabels[0]}`;
    const inventedPlan = `${grounded}我这就去跟阿川说。`;
    const bundle = buildFeatureQaFacts({
      openFeatures: OPEN_FEATURES,
      question: combinedQuestion,
    });

    // 直接检验通用校验函数本身：没说原文 / 列出功能名都必须报缺。
    assert.deepEqual(findUngroundedFeatureQaFacts(grounded, bundle), []);
    assert.equal(
      findUngroundedFeatureQaFacts(missedBlock, bundle).length,
      1,
      "没原样说出该说的那段原文必须报缺"
    );
    assert.equal(
      findUngroundedFeatureQaFacts(leakedName, bundle).length,
      1,
      "列出具体功能名必须报缺"
    );

    // grounding：漏说原文 / 列出功能名 / 自创处置方案都回落，并把原因带出来。
    for (const [label, reply] of [
      ["漏说原文", missedBlock],
      ["列出功能名", leakedName],
      ["自创处置方案", inventedPlan],
    ] as Array<[string, string]>) {
      const m = mockLlm({ [FEATURE_QA_NAME]: JSON.stringify({ reply }) });
      const qa = await runFeatureQa({
        text: combinedQuestion,
        openFeatures: OPEN_FEATURES,
        llm: m.llm,
      });
      assert.equal(qa!.reply, fb, `${label} 必须回落兜底`);
      assert(qa!.error, `${label} 回落时要把原因带出来`);
    }

    // 说了原文、也没多列的正文照样接受。
    const ok = mockLlm({ [FEATURE_QA_NAME]: JSON.stringify({ reply: grounded }) });
    const okQa = await runFeatureQa({
      text: combinedQuestion,
      openFeatures: OPEN_FEATURES,
      llm: ok.llm,
    });
    assert.equal(okQa!.reply, grounded, "内容文件的能力段原文要接受");
    assert(!("error" in okQa!));

    // 超长正文也回落（结构校验仍在）。
    const long = mockLlm({
      [FEATURE_QA_NAME]: JSON.stringify({ reply: grounded + "啊".repeat(FEATURE_QA_MAX_CHARS) }),
    });
    const longQa = await runFeatureQa({
      text: combinedQuestion,
      openFeatures: OPEN_FEATURES,
      llm: long.llm,
    });
    assert.equal(longQa!.reply, fb, "超长正文必须回落兜底");
  });

  await checkAsync(
    "功能问答的「刚才」窄引用：本人紧接追问补上被拒条目，没有引用时不继承",
    async () => {
      const drainHair = BLACKLISTED_CAPABILITIES[0];
      const question = "请问为什么连这么简单的功能都没有?那你有什么功能？";

      // 没有引用（其他住户 / 本人后来换过话题 / 隔得太久）：问题本身对不上条目 → 事实源
      // 不带任何「办不了」，兜底也不得凭空说出「刚才被拒」的主题。
      const noRefBundle = buildFeatureQaFacts({ openFeatures: OPEN_FEATURES, question });
      assert.equal(noRefBundle.blacklisted.length, 0, "没有引用时问能力清单不得带出黑名单条目");
      const noRefFb = featureQaFallback({ question, openFeatures: OPEN_FEATURES });
      assert(
        !noRefFb.includes(drainHair.label) && !/卫生整改|地漏|头发|看不到|整改/.test(noRefFb),
        "没有引用时兜底不得凭空说出「刚才被拒」的主题"
      );

      // 有引用（本人上一轮刚被拒、紧接追问）：事实源补上那一条，兜底必须说出名称 +
      // 登记原因，**并且**说清能做什么——**不靠旧主题关键词**，靠的是结构化引用。
      const refBundle = buildFeatureQaFacts({
        openFeatures: OPEN_FEATURES,
        question,
        referencedBlacklistedId: drainHair.id,
      });
      assert.equal(
        refBundle.blacklisted[0]?.id,
        drainHair.id,
        "引用命中时事实源补上那一条目"
      );
      const refFb = featureQaFallback({
        question,
        openFeatures: OPEN_FEATURES,
        referencedBlacklistedId: drainHair.id,
      });
      assert(refFb.includes(drainHair.label), "紧接追问的兜底必须说出被拒条目名称");
      for (const a of drainHair.validation.reasonAnchors) {
        assert(refFb.includes(a), `紧接追问的兜底必须保留登记原因锚点：${a}`);
      }
      assert(
        refFb.includes(CAPABILITIES_ZH),
        "紧接追问仍要说清能做什么（内容文件的能力段）"
      );
      assert(!openLabels.some((l) => refFb.includes(l)), "紧接追问同样不列功能清单");
      assert.deepEqual(findGroundingViolations(refFb), [], "含事实的兜底必须过 grounding 闸");

      // 模型正文覆盖事实才接受；漏掉被拒条目 / 原因 → 换回同样只含事实的兜底。
      const ok = mockLlm({ [FEATURE_QA_NAME]: JSON.stringify({ reply: refFb }) });
      const okQa = await runFeatureQa({
        text: question,
        openFeatures: OPEN_FEATURES,
        referencedBlacklistedId: drainHair.id,
        llm: ok.llm,
      });
      assert.equal(okQa!.reply, refFb, "覆盖被拒条目 + 能做什么的正文要接受");
      assert(!("error" in okQa!));

      const dropped = CAPABILITIES_ZH; // 只说能做什么、漏掉「刚才被拒」的条目与原因
      const bad = mockLlm({ [FEATURE_QA_NAME]: JSON.stringify({ reply: dropped }) });
      const badQa = await runFeatureQa({
        text: question,
        openFeatures: OPEN_FEATURES,
        referencedBlacklistedId: drainHair.id,
        llm: bad.llm,
      });
      assert.equal(badQa!.reply, refFb, "漏掉被拒条目与原因的正文必须回落只含事实的兜底");
      assert(badQa!.error, "回落时要把原因带出来");

      // 无引用时同样的正文就是合规的（不该被要求补一条并不存在的「刚才」）。
      const noRefOk = mockLlm({ [FEATURE_QA_NAME]: JSON.stringify({ reply: CAPABILITIES_ZH }) });
      const noRefOkQa = await runFeatureQa({
        text: question,
        openFeatures: OPEN_FEATURES,
        referencedBlacklistedId: null,
        llm: noRefOk.llm,
      });
      assert.equal(
        noRefOkQa!.reply,
        CAPABILITIES_ZH,
        "没有引用时不要求补被拒条目，说清能做什么即可"
      );
    }
  );

  /**
   * ── 住户问起「你是谁 / 你怎么工作」时的自称问答（2026-09-20 扩展） ──
   *
   * 走的是**同一条**功能问答路径：零工具、零第三方出站、不装旧 doctrine，只多拿一条
   * 身份段（内容 Markdown 的 `identity.*`，与 doctrine 的「AI 协调员」同一口径）。
   * 这里盯三件事：①认出「问自己」且**不吞掉普通交办**；②回答用住户那一轮的语言；
   * ③不泄露内部（模型 / 数据库 / 工具）也不把两项专门优化说成全部能力。
   */
  check("自称问答：中英文问句都进，普通交办 / 带诉求的追问一律不进", () => {
    // 认得出的问法（中英各若干；含招呼、「请问」、语气词、连着两问）。
    for (const q of [
      "你是谁？",
      "你好，请问你是做什么的？",
      "你是谁啊？你能做什么呢？",
      "你是什么人",
      "你是 AI 吗",
      "你是不是真人",
      "你到底是谁",
      "你是这套房子的管理员吗",
      "介绍一下你自己",
      "你平时怎么工作的",
      "Who are you?",
      "What’s this number?",
      "Are you a bot?",
      "how do you work",
      "Introduce yourself",
      "What's your role?",
    ]) {
      assert.equal(asksAboutSelf(q), true, `应当认出是在问我自己：${q}`);
      assert.equal(isFeatureQaQuestion(q), true, `应当进功能问答：${q}`);
    }
    // 认不出的：**普通交办与闲聊**，以及**后面还挂着别的要求**的追问。后者是这条扩展
    // 最危险的失效方式——吞掉就等于住户交办的事没人办。这些句子整条都不得进功能问答。
    for (const q of [
      "今天晚饭吃什么",
      "帮我提醒 Alex 晚上别用烘干机",
      "阿川最近老把地漏堵住，头发也不清理。请叫他把地漏的头发清干净。",
      "阿远，我是刚搬来的，想问问半夜洗衣机的事，你能帮我跟他说一下吗？",
      "你好，我是刚搬进来的，室友半夜洗衣服很吵，能帮我跟他说一声吗？",
      "Hi, I just moved in - the dryer beeps late at night. Can you ask Jordan to empty it before 10?",
      "Hi, what can you do about the dryer beeping at night? Can you ask Jordan to stop it?",
      "what can you do about the noise next door?",
      "你是谁？顺便帮我跟阿川说一声别半夜洗衣服",
      "你是什么意思",
      "你是做什么工作的",
    ]) {
      assert.equal(asksAboutSelf(q), false, `不得把普通交办 / 闲聊认成问我自己：${q}`);
      assert.equal(isFeatureQaQuestion(q), false, `不得进功能问答：${q}`);
    }
    // **纯问能力是另一种问法，不是问你自己**（老板 2026-09-22 契约）：整句合规也认，
    // 但它只读能力段。从前 `Hi, what can you do?` 被算成"问我自己"，于是住户问一句能力，
    // 收到的是身份段 + 能力段两段——这一栏现在就钉住"只读能力段"。
    for (const q of ["你能做什么", "你有什么功能？", "Hi, what can you do?", "what can you do"]) {
      assert.equal(asksAboutSelf(q), false, `纯问能力不得算成问你自己：${q}`);
      assert.equal(asksWhatIsAvailable(q), true, `必须认成问能力：${q}`);
      assert.equal(isFeatureQaQuestion(q), true, `仍要进功能问答：${q}`);
      const decision = decideLanguage(q);
      const fb = featureQaFallback({ question: q, openFeatures: OPEN_FEATURES, language: decision });
      assert.equal(
        fb,
        decision.language === "en" ? CAPABILITIES_EN : CAPABILITIES_ZH,
        `问能力只读能力段原文：${q}`
      );
      assert(
        !fb.includes(decision.language === "en" ? IDENTITY_EN : IDENTITY_ZH),
        `问能力不得夹身份段：${q}`
      );
    }
    // 「你会做什么菜」是**带具体主题**的问法：与上面那几句的区别是整句不再只是在问能力，
    // 所以不算问你自己（它是问能力句式命中的，口径与本次改动无关，不为它立新规）。
    assert.equal(asksAboutSelf("你会做什么菜"), false, "有具体主题的「会做什么」不是问我自己");
  });

  check("自称问答：身份段与 doctrine 的角色名一致，住户可见内容不掺内部架构", () => {
    // 角色名必须与权威来源一致（doctrine/always/identity.md 的「AI 协调员」「不自称管理员」）。
    // 这份 doctrine 是权威来源，本次改动**没有**碰它；身份段只是与它口径一致的一段文案。
    const identity = readFileSync(
      "lib/ai/brains/coliving/doctrine/always/identity.md",
      "utf8"
    );
    assert(
      identity.includes("AI 协调员") && identity.includes("不是「管理员」"),
      "doctrine 身份段仍是「AI 协调员 / 不是管理员」——身份文案与它同一口径"
    );
    assert(IDENTITY_ZH.includes("AI 协调员"), "中文身份段必须说清角色名");
    assert(/AI coordinator/i.test(IDENTITY_EN), "英文身份段必须说清角色名");
    // 住户可见的那几段里不得出现内部架构 / 工具 / 模型 / 数据库。
    for (const text of [IDENTITY_ZH, IDENTITY_EN, CAPABILITIES_ZH, CAPABILITIES_EN]) {
      assert(
        !/模型|数据库|工具|接口|API|架构|系统提示|提示词|白名单|路由|database|\bmodel\b|\btools?\b|\bapi\b|\barchitecture\b/i.test(
          text
        ),
        "住户可见文案不得暴露内部架构 / 工具 / 模型 / 数据库"
      );
    }
    // 锚点来自 doctrine 的硬规则：「AI」两字不能省。
    assert.deepEqual([...COORDINATOR_IDENTITY_ANCHORS], ["AI"], "报身份的锚点就是「AI」不能省");
  });

  check("自称问答：中文问句只读内容文件的中文身份段，别的问法不背这一段", () => {
    const selfBundle = buildFeatureQaFacts({
      openFeatures: OPEN_FEATURES,
      question: "你是谁？",
      selfIntro: true,
    });
    assert.equal(selfBundle.blocks.length, 1, "问身份只读一段");
    assert.equal(selfBundle.blocks[0].kind, "identity", "读的是身份段");
    assert.equal(selfBundle.blocks[0].text, IDENTITY_ZH, "原文逐字来自内容文件的 identity.zh");
    // 别的问法不背这段（省 token，也不跑题）。
    const boundaryBundle = buildFeatureQaFacts({
      openFeatures: OPEN_FEATURES,
      question: combinedQuestion,
    });
    assert(
      !boundaryBundle.blocks.some((b) => b.kind === "identity"),
      "功能边界问句不带身份段"
    );
    assert(
      !buildFeatureQaFacts({ openFeatures: OPEN_FEATURES, question: "为什么不能让他清理地漏的头发？" })
        .blocks.some((b) => b.kind === "identity"),
      "黑名单主题问句不带身份段"
    );

    // 兜底：问起自己时说的就是那段原文——不列功能、不讲办不到的事，且过 grounding 闸。
    const fb = featureQaFallback({ question: "你是谁？", openFeatures: OPEN_FEATURES });
    assert.equal(fb, IDENTITY_ZH, "自称兜底逐字等于内容文件的身份段");
    assert(!openLabels.some((l) => fb.includes(l)), "自称兜底不列功能清单");
    assert(
      !/办不了|没法|不能做|不是做不到/.test(fb),
      "问身份不顺带讲办不到的事，也不背完整流程那段"
    );
    assert.deepEqual(findGroundingViolations(fb), [], "自称兜底必须过 grounding 闸");
    // 漏说身份（少了「AI」）要被 grounding 抓出来。
    assert.deepEqual(findUngroundedFeatureQaFacts(fb, selfBundle), []);
    const noRole = "我是这套房子的协调员，帮住在这里的人沟通日常合住的事。";
    assert(
      findUngroundedFeatureQaFacts(noRole, selfBundle).some((m) => m.includes("身份")),
      "不说「AI」= 没披露身份，必须报缺"
    );
  });

  await checkAsync("自称问答：英文问句用英文回答，中文问句口径不变", async () => {
    const enQuestion = "Who are you?";
    // 英文正文：内容文件那两段英文原文 + 一句最简短的英文收尾 —— 长度落在「中文上限之外、
    // 英文上限之内」，用来证明上限是按语言取的（英文上限本来就该比中文宽）。
    const enReply = `${IDENTITY_EN} ${CAPABILITIES_EN} If anything comes up around the house, just let me know.`;
    assert(!containsHan(enReply), "英文自称正文里不得出现任何汉字");
    assert(
      enReply.length > FEATURE_QA_MAX_CHARS && enReply.length <= FEATURE_QA_MAX_CHARS_EN,
      `这条英文正文要落在「中文上限之外、英文上限之内」（实际 ${enReply.length}），用来证明上限是按语言取的`
    );
    assert.equal(featureQaMaxChars(enQuestion), FEATURE_QA_MAX_CHARS_EN);
    assert.equal(featureQaMaxChars("你是谁？"), FEATURE_QA_MAX_CHARS, "中文上限一字不动");
    const en = mockLlm({ [FEATURE_QA_NAME]: JSON.stringify({ reply: enReply }) });
    const enQa = await runFeatureQa({
      text: enQuestion,
      openFeatures: OPEN_FEATURES,
      language: decideLanguage(enQuestion),
      llm: en.llm,
    });
    assert(enQa, "英文自称问句必须进功能问答");
    assert.equal(enQa!.reply, enReply, "含英文原文的正文要原样接受");
    assert(!("error" in enQa!), "英文正文不得因为中文口径的长度上限被误换兜底");
    assert.equal(en.calls.length, 1, "自称问答只花一次模型调用");
    assert.equal(en.calls[0].name, FEATURE_QA_NAME);
    // 交给模型的事实里不再有功能名（问身份不列清单，中文名更不该出现）。
    for (const l of [...openLabelsEn, ...openLabels]) {
      assert(!en.calls[0].system.includes(l), `英文轮次不得把功能名交给模型：${l}`);
    }
    // 英文兜底也是英文（一个汉字都没有），说的就是文件里的英文身份段。
    const enFb = featureQaFallback({
      question: enQuestion,
      openFeatures: OPEN_FEATURES,
      language: decideLanguage(enQuestion),
    });
    assert.equal(enFb, IDENTITY_EN, "英文自称兜底逐字等于内容文件的 identity.en");
    assert(!containsHan(enFb), "英文自称兜底里一个汉字都不许有");
    assert(
      !openLabelsEn.some((l) => enFb.includes(l)) && !/办不了|没法|不是做不到/.test(enFb),
      "英文兜底不列功能清单，也不得编造办不了"
    );
    // 中文问句走中文兜底。
    assert(
      featureQaFallback({ question: combinedQuestion, openFeatures: OPEN_FEATURES }) ===
        CAPABILITIES_ZH,
      "问能力的中文兜底就是内容文件的能力段"
    );
    // 语言判定复用 language.ts：混了中文的英文问句仍按中文处理。
    assert.equal(featureQaMaxChars("提醒 Alex 晚上别用烘干机"), FEATURE_QA_MAX_CHARS);
  });

  await checkAsync("自称问答：泄露内部 / 列出功能 / 说成「只有两项」/ 自创方案一律回落兜底", async () => {
    const fb = featureQaFallback({ question: "你是谁？", openFeatures: OPEN_FEATURES });
    const good = IDENTITY_ZH;
    const okRun = mockLlm({ [FEATURE_QA_NAME]: JSON.stringify({ reply: good }) });
    const okQa = await runFeatureQa({ text: "你是谁？", openFeatures: OPEN_FEATURES, llm: okRun.llm });
    assert.equal(okQa!.reply, good, "内容文件的身份段原文要接受");
    assert(!("error" in okQa!));

    // 四类必须回落：暴露内部实现 / 列出功能 / 把两项说成全部能力 / 承诺去联系。逐条报原因。
    for (const [label, reply] of [
      ["暴露内部实现", "我是这套房的 AI 协调员，背后是一个大模型加数据库和一堆工具。"],
      ["列出功能清单", `${IDENTITY_ZH}我还能${openLabels.join("、")}。`],
      ["说成只有两项功能", `${IDENTITY_ZH}只有这两项功能：${openLabels.join("、")}。`],
      ["承诺去联系", `${IDENTITY_ZH}我这就去跟阿川说。`],
    ] as Array<[string, string]>) {
      const m = mockLlm({ [FEATURE_QA_NAME]: JSON.stringify({ reply }) });
      const qa = await runFeatureQa({ text: "你是谁？", openFeatures: OPEN_FEATURES, llm: m.llm });
      assert.equal(qa!.reply, fb, `${label} 必须回落只含事实源事实的兜底`);
      assert(qa!.error, `${label} 回落时要把原因带出来`);
      assert.deepEqual(findGroundingViolations(fb), [], "换上的兜底自己必须干净");
    }
  });

  await checkAsync("自称问答：不调工具、不产生任何第三方出站（与既有口径同一条）", async () => {
    const { llm, calls } = mockLlm({
      [FEATURE_QA_NAME]: JSON.stringify({ reply: IDENTITY_ZH }),
    });
    const qa = await runFeatureQa({ text: "你是谁？", openFeatures: OPEN_FEATURES, llm });
    assert(qa, "自称问句要进功能问答");
    // 这条路径只经 feature-llm 的小生成调用：既没有工具表，也不可能出站。
    assert.equal(calls.length, 1, "自称问答只有一次模型调用（没有任何工具调用）");
    assert.equal(calls[0].stage, FEATURE_QA_STAGE);
    const qaSrcSelf = readFileSync("lib/chat/coliving/feature-qa.ts", "utf8");
    assert(
      !/deliverSms|contactPerson|queueCommunication|tool\(/.test(qaSrcSelf.replace(/\/\/.*$/gm, "")),
      "feature-qa.ts 不接投递层、不点收件人（自称扩展不得改动第三方动作权限）"
    );
  });


  check("corpus-035 两句原文逐字保留，且这轮功能问答无工具 / 无出站 / 不装旧 doctrine", () => {
    const raw = readFileSync(
      "lib/chat/coliving/evals/scenarios/corpus-035-unsupported-feature-followup-2026-09-12.json",
      "utf8"
    );
    const scenario = validateScenario(JSON.parse(raw), "corpus-035.json");
    assert.equal(scenario.turns.length, 2, "corpus-035 只应有两轮");
    assert.equal(
      scenario.turns[0].text,
      "阿川最近老把地漏堵住，头发也不清理。请叫他把地漏的头发清干净。"
    );
    assert.equal(scenario.turns[1].text, "请问为什么连这么简单的功能都没有?那你有什么功能？");
    for (const [i, turn] of scenario.turns.entries()) {
      // `minAcceptedOutbound` 是下限：0 只是不设最低出站要求（这一轮不必发出第三方短信），
      // 不是「禁止出站」。
      assert.equal(turn.expect?.minAcceptedOutbound, 0, `第${i + 1}轮不设最低出站要求`);
    }
    // 老板 2026-09-13 纠正：第一轮「请叫阿川把地漏的头发清干净」是**已登记的显式黑名单**
    // （单方面叫别人在洗完澡后清理地漏头发），由功能前门那次路由选中
    // `blocked:ask-named-roommate-clean-shower-drain-hair` 后、再过该条目自己的纯代码
    // 资格复核**收口**——零工具、零第三方出站、不进完整主生成。机器断言据此要求：
    // 不得调 `contactPerson`、不得发给任何人，回复只保留老板给的理由（且用具体功能名）。
    assert.deepEqual(
      scenario.turns[0].expect?.mustNotUseTools,
      ["contactPerson"],
      "第一轮不得进入主生成去调 contactPerson"
    );
    assert.deepEqual(
      scenario.turns[0].expect?.mustNotContactNames,
      ["阿川", "小禾"],
      "第一轮黑名单收口，不得发给任何人"
    );
    assert.deepEqual(
      scenario.turns[0].expect?.replyMustMatch,
      ["单方面叫别人在洗完澡后清理地漏头发", "看不到", "程度", "整改"],
      "第一轮回复必须含具体功能名与老板给的理由锚点"
    );
    assert.deepEqual(
      scenario.turns[0].expect?.replyMustNotMatch,
      ["卫生整改", "未开放", "白名单", "黑名单", "路由", "提示词", "不在.{0,6}(能力|功能)清单"],
      "第一轮回复不得含内部术语，也不得退回大类旧称"
    );
    // 第二轮是**同一住户紧接着**的功能边界追问：无工具、无出站；且必须说出刚刚被拒的
    // 具体功能名与登记原因、并列出全部专门优化功能——由结构化引用 + grounding
    // 共同保证（不是「不继承」，也不是按关键词乱猜主题）。
    assert.deepEqual(scenario.turns[1].expect?.mustNotContactNames, ["阿川", "小禾"], "第二轮不得联系任何人");
    assert.deepEqual(scenario.turns[1].expect?.mustNotUseTools, ["contactPerson"], "第二轮无工具");
    assert.deepEqual(
      scenario.turns[1].expect?.replyMustMatch,
      [
        "单方面叫别人在洗完澡后清理地漏头发",
        "看不到",
        "程度",
        "整改",
        "个人物品使用提醒",
        "夜间洗衣提醒",
      ],
      "第二轮紧接着追问：必须说出具体功能名 + 登记原因，并列全专门优化功能"
    );
    assert.deepEqual(
      scenario.turns[1].expect?.replyMustNotMatch,
      ["卫生整改", "未开放", "白名单", "黑名单", "路由", "提示词"],
      "第二轮仍不得出现内部术语，也不得退回大类旧称"
    );
    assert.equal(isFeatureQaQuestion(scenario.turns[1].text), true, "第二轮进功能问答");
    assert.equal(
      isFeatureQaQuestion(scenario.turns[0].text),
      false,
      "第一轮是黑名单交办（由功能前门收口），不进功能问答"
    );

    // 本闸只应看**真实代码**，不该被字符串 / 模板串 / 正则字面量里的字样误伤。本文件里
    // feature-qa.ts 的「内部术语黑名单」正则本身就含 functionId——只看注释会把它当代码，
    // 造成假阳性。这里做一次小扫描，把注释、'…' / "…" 字符串、`…` 模板串、/…/ 正则里的
    // 内容换成空格（模板 ${...} 插值里的代码保留）；够了，不需要完整词法分析。
    const stripNonCode = (src: string): string => {
      const regexPrefix = new Set([
        "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%",
        "~", "^", "<", ">",
      ]);
      type Frame = { kind: "code" | "template"; depth: number };
      const stack: Frame[] = [{ kind: "code", depth: 0 }];
      let out = "";
      let prev = "";
      let i = 0;
      const n = src.length;
      while (i < n) {
        const frame = stack[stack.length - 1];
        const c = src[i];
        const d = src[i + 1];
        if (frame.kind === "template") {
          if (c === "\\") i += 2;
          else if (c === "`") {
            stack.pop();
            prev = "`";
            i += 1;
          } else if (c === "$" && d === "{") {
            stack.push({ kind: "code", depth: 1 });
            i += 2;
          } else i += 1;
          continue;
        }
        if (c === "/" && d === "/") {
          i += 2;
          while (i < n && src[i] !== "\n") i += 1;
          continue;
        }
        if (c === "/" && d === "*") {
          i += 2;
          while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
          i += 2;
          continue;
        }
        if (c === "`") {
          stack.push({ kind: "template", depth: 0 });
          i += 1;
          continue;
        }
        if (c === "'" || c === '"') {
          i += 1;
          while (i < n) {
            if (src[i] === "\\") i += 2;
            else if (src[i] === c) {
              i += 1;
              break;
            } else i += 1;
          }
          out += " ";
          prev = c;
          continue;
        }
        if (c === "/" && (prev === "" || regexPrefix.has(prev))) {
          i += 1;
          let inClass = false;
          while (i < n) {
            const ch = src[i];
            if (ch === "\\") {
              i += 2;
              continue;
            }
            if (ch === "\n") break;
            if (ch === "[") inClass = true;
            else if (ch === "]") inClass = false;
            else if (ch === "/" && !inClass) {
              i += 1;
              break;
            }
            i += 1;
          }
          while (i < n && /[a-z]/i.test(src[i])) i += 1;
          out += " ";
          prev = "/";
          continue;
        }
        if (stack.length > 1 && c === "}") {
          frame.depth -= 1;
          if (frame.depth === 0) stack.pop();
          else out += c;
          prev = c;
          i += 1;
          continue;
        }
        if (stack.length > 1 && c === "{") {
          frame.depth += 1;
          out += c;
          prev = c;
          i += 1;
          continue;
        }
        out += c;
        if (!/\s/.test(c)) prev = c;
        i += 1;
      }
      return out;
    };

    // 源码闸：功能问答既不是工具、也不出站、不读旧 doctrine（模型调用只经 feature-llm）。
    const qaSrc = readFileSync("lib/chat/coliving/feature-qa.ts", "utf8");
    assert(
      !/\btool\(|inputSchema|functionId|actionCard|deliverSms|contactPerson/.test(
        stripNonCode(qaSrc)
      ) && !/generateText|generateObject|streamText|getLanguageModel/.test(qaSrc),
      "feature-qa.ts 不得是工具 / 不得直接出站 / 不得直接调模型"
    );
    assert(
      !/(?:from\s*["'][^"']*(?:sms-delivery|repo|brains)[^"']*["'])/.test(qaSrc),
      "feature-qa.ts 不得接投递层 / repo / 旧 doctrine 大脑"
    );
    const turnSrcQa = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(
      turnSrcQa.indexOf("runApprovedFeature(") < turnSrcQa.indexOf("isFeatureQaQuestion(") &&
        turnSrcQa.indexOf("isFeatureQaQuestion(") <
          turnSrcQa.indexOf("assembleSystemPrompt({"),
      "功能问答必须在已批准功能前门之后、主生成之前"
    );
    assert(
      turnSrcQa.includes("runFeatureQa("),
      "turn.ts 必须接线功能问答入口"
    );
    // 「刚才为什么」的窄引用：问答只读**本人 + 紧接本人上一条入站 + 72h**的黑名单引用
    // （`repo.latestBlacklistReference`），不退回旧 default-deny 的 latestDecision /
    // latestUnsupportedReference；读取时就按 sender.personId 收窄，别的住户顶不掉。
    assert(
      turnSrcQa.includes("repo.latestBlacklistReference(") &&
        !turnSrcQa.includes("latestUnsupportedReference(") &&
        !turnSrcQa.includes("latestDecision("),
      "turn.ts 功能问答必须读本人黑名单结构化引用，不得退回旧 default-deny 引用"
    );
    assert(
      /repo\.latestBlacklistReference\(\{[\s\S]*?personId:\s*sender\.personId/.test(
        turnSrcQa
      ),
      "读黑名单引用时必须按 sender.personId 收窄（不是取完全屋再比）"
    );
  });

  check("术语哨兵：旧集合层「任务能力」不再作为现行正式层，当前入口/运行时/场景不再出现", () => {
    // 老板 2026-09-13 决定：取消「任务能力」集合层，正式的最小批准单位、产品实现单位
    // 与白名单执行单位改为「功能」。这条哨兵刻意**只扫当前口径的文件**（当前入口文档、
    // 活跃运行时注释、当前场景 source）；历史资产（AGENT_LOG / INTENT_* / ROADMAP 等）
    // 保留该词作为证据，因此**不做全仓零出现断言**，避免误伤历史记录。
    const currentTermFree = [
      "CLAUDE.md",
      "docs/USER_FACING_CAPABILITY_TRUTH.md",
      "lib/chat/coliving/features.ts",
      "lib/chat/coliving/sms-delivery.ts",
      "lib/chat/coliving/evals/scenarios/personal-item-reminder-2026-09-12.json",
      "lib/chat/coliving/evals/scenarios/corpus-033-personal-item-reminder-2026-09-12.json",
      "lib/chat/coliving/evals/scenarios/corpus-034-night-laundry-reminder-2026-09-12.json",
      "lib/chat/coliving/evals/scenarios/corpus-032-reddit-narrow-reminders-2026-09-12.json",
    ];
    for (const file of currentTermFree) {
      assert(
        !readFileSync(file, "utf8").includes("任务能力"),
        `${file} 当前口径不得再用旧集合层用语定义正式层`
      );
    }
    // 取代关系必须写进当前入口：正式单位是「功能」。
    assert(
      readFileSync("CLAUDE.md", "utf8").includes("唯一正式"),
      "CLAUDE.md 必须写明「功能」是唯一正式的最小批准单位"
    );
  });

  // 真实语料实跑正文：模型在本路径无出站的情况下，多说了「你可能得直接跟他说一下」——
  // 把事推回住户。共享 grounding 闸必须拦住它。
  const CORPUS_035_R1_BAD =
    "这件事我没法替你转给阿川，现在也没发出去。你可能得直接跟他说一下，让他把地漏的头发清干净。";

  check("受约束回复 grounding 闸：把球踢回住户 / 换渠道 / 等以后必须被拦，中性真话不受影响", () => {
    // 实跑原句：把事推回住户 → 必须被拦。
    assert(
      findGroundingViolations(CORPUS_035_R1_BAD).length > 0,
      "「你可能得直接跟他说一下」是把事推回住户，必须被拦"
    );
    for (const bad of [
      "你可以直接跟阿川说一声。",
      "你可以自己找房东协调一下。",
      "你们自己沟通就行了。",
      "建议找物业反映。",
      "这件事以后再说吧。",
      "你可以换个方式试试。",
      "我这就去跟阿川说。",
    ]) {
      assert(findGroundingViolations(bad).length > 0, `越界正文必须被拦：${bad}`);
    }

    // 只讲事实的中性真话不得被误伤——否则会一直回落、把好回复也换掉。
    for (const ok of [
      "这件事我现在没法替你转给阿川，现在还没跟他说。",
      "这件事不是我能替你转达给别人的。",
      openLabels.join("、"),
    ]) {
      assert.deepEqual(
        findGroundingViolations(ok),
        [],
        `只讲事实的正文不得被误判：${ok}`
      );
    }
  });

  // ── decision.payload 的 JSONB 编码根因回归（不连库、不调模型） ──
  //
  // 真实事故：第一轮 decision 的 payload 落库成了 JSONB 顶层字符串，读取端取字段读成
  // null。根因是 `${JSON.stringify(obj)}::jsonb`：首次执行参数类型还是 unknown（按文本
  // 发），但 PostgreSQL 的 ParameterDescription 会把解析出的 jsonb(3802) 写回该参数并缓存
  // 预处理语句，**第二次及以后**驱动就按 jsonb 序列化器把已 stringify 的参数再
  // stringify 一次。修法：用 postgres.js 的 `json()`（同 `shadow.ts` 先例）。
  // 边界：只守 `recordDecision`；`finishOutreachRun` 的 `skipped_reason` 是同一驱动根因，
  // 但属另一条路径、且没有既有行为测试，按任务边界不顺手改。
  check("decision payload 用 postgres.js json() 写对象，不再 JSON.stringify(...)::jsonb", () => {
    const repo = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    const sliceFn = (sig: string) => {
      const i = repo.indexOf(sig);
      assert(i >= 0, `找不到 ${sig}`);
      const j = repo.indexOf("\nexport ", i + sig.length);
      return repo.slice(i, j > 0 ? j : undefined);
    };
    const recordBody = sliceFn("export async function recordDecision(");
    assert(
      /\.json\(\s*args\.payload\b/.test(recordBody),
      "recordDecision 的 payload 必须走 postgres.js 的 json()（显式 jsonb 参数）"
    );
    // 去掉块注释再查旧写法，避免把注释里解释根因的示例当成真代码。
    const codeOnly = recordBody.replace(/\/\*[\s\S]*?\*\//g, "");
    assert(
      !/JSON\.stringify\([^)]*\)\s*::jsonb/.test(codeOnly),
      "recordDecision 不得再用 JSON.stringify(...)::jsonb——缓存预处理语句上会被驱动双重编码"
    );
  });

  check("decision payload 双重编码会读回 null（纯函数复现根因，不连库）", () => {
    const payload = { kind: "contact_one", personId: "p1" };
    // postgres.js 对 jsonb(3802) 参数的序列化：把绑定值 JSON.stringify。
    const boundToStoredText = (bound: unknown) => JSON.stringify(bound);
    // 读取端 `payload->>'kind'` 的等价语义：先解析顶层，再取字段。
    const kindOf = (stored: string): string | null => {
      const top = JSON.parse(stored) as unknown;
      return top !== null && typeof top === "object"
        ? ((top as Record<string, unknown>).kind as string | undefined) ?? null
        : null;
    };
    // 旧写法：先把对象 stringify 再绑定，驱动第二次起会再 stringify 一次 → 顶层是 JSON 字符串。
    assert.equal(
      kindOf(boundToStoredText(JSON.stringify(payload))),
      null,
      "预字符串化再绑定会被驱动双重编码，payload->> 读回 null"
    );
    // 新写法：对象直接交给 json() → 顶层是对象 → 读回字段。
    assert.equal(kindOf(boundToStoredText(payload)), "contact_one");
  });

  // ── 黑名单「刚才」引用：读取时就按发起人 + 「紧接着本人上一条入站」收窄（源码闸，不连库） ──
  //
  // 真实缺陷：黑名单收口后同一住户紧接着追问「为什么连这么简单的功能都没有」，问题本身不含
  // 主题词，光靠 keywords 对不上条目 → 追问会丢掉刚被拒的理由。修法用一条**窄结构化引用**：
  // 收口那一轮由纯代码把 `{ blacklistedCapabilityId, personId }` 写进 decision payload，读取
  // 时按 personId 收窄 + 只认结构化字段 + 72h + 「本人同屋之后没有更新的入站消息」。此闸只查
  // SQL 是否具备这四件事，不重复实现选择语义、不连库。
  check("黑名单「刚才」引用：按发起人收窄 + 结构化字段 + 72h + 本人之后无更新入站", () => {
    const repoStr = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    const start = repoStr.indexOf("export async function latestBlacklistReference(");
    assert(start >= 0, "repo 必须有 latestBlacklistReference");
    const end = repoStr.indexOf("\nexport ", start + 1);
    const body = repoStr.slice(start, end > 0 ? end : undefined);
    assert(
      /d\.payload->>'personId'\s*=\s*\$\{args\.personId\}/.test(body),
      "SQL 必须按发起人收窄（不是先取全屋最新再在调用方比）"
    );
    assert(
      body.includes("d.payload->>'blacklistedCapabilityId' is not null"),
      "只认结构化黑名单引用（blacklistedCapabilityId 非空），不读自由文本"
    );
    assert(
      body.includes("args.withinHours ?? 72") && body.includes("interval"),
      "必须有与既有对话关联（linkResponse / pendingCommunication）一致的 72h 新鲜度窗口"
    );
    assert(
      body.includes("c.household_id = ${args.householdId}") &&
        /not exists[\s\S]*m\.direction = 'inbound'[\s\S]*m\.sent_at > d\.decided_at/.test(body),
      "必须排除本人**同一栋房子**里这条 decision 之后更新的入站消息（换过话题后不得再当「刚才」）"
    );
    // 写入端：收口那一轮把结构化引用交给 recordDecision 的 payload（走 json()）。
    const turnStr = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(
      turnStr.includes("blacklistedCapabilityId: featureRun.blacklistedCapabilityId") &&
        turnStr.includes("personId: sender.personId"),
      "黑名单收口必须把 { blacklistedCapabilityId, personId } 写进这一轮 decision payload"
    );
  });

  check("受约束提醒场景：结构自洽（谁收、零出站轮、旧工具名清干净）", () => {
    const loadScenario = (file: string) =>
      validateScenario(
        JSON.parse(readFileSync(`lib/chat/coliving/evals/scenarios/${file}`, "utf8")),
        file
      );
    for (const file of [
      "personal-item-reminder-2026-09-12.json",
      "corpus-033-personal-item-reminder-2026-09-12.json",
      "corpus-034-night-laundry-reminder-2026-09-12.json",
    ]) {
      const raw = readFileSync(`lib/chat/coliving/evals/scenarios/${file}`, "utf8");
      assert(!raw.includes("sendRoommateMessage"), `${file} 不得再引用已删除的共享短信工具`);
      const scenario = loadScenario(file);
      const members = (scenario.people ?? []).map((p) =>
        gateMember(p.phone, p.name, { address: p.phone })
      );
      let sawSend = false;
      for (const [i, turn] of scenario.turns.entries()) {
        const expect = turn.expect ?? {};
        const where = `${file} 第${i + 1}轮`;
        if ((expect.minAcceptedOutbound ?? 0) > 0) {
          sawSend = true;
          const recipientName = (expect.mustContactNames ?? [])[0]!;
          const r = resolveNamedRecipient(turn.text, members, turn.from);
          assert(r.ok, `${where}收件人必须绑定原话点名的那位${r.ok ? "" : " — " + r.reason}`);
          assert.equal(r.recipient.name, recipientName, `${where}绑定到 ${recipientName}`);
          assert.deepEqual(expect.mustNotContactNames, ["小禾"], `${where}不得发给发起人`);
        } else {
          assert.equal(expect.minAcceptedOutbound, 0, `${where}非交办轮必须明写零出站`);
        }
      }
      assert(sawSend, `${file} 至少要有一轮证明已批准功能能发出去`);
    }
    // 029 电视音量：明确要求联系点名室友、主题不在专门优化清单 → 落回完整协调流程，
    // 由主生成恢复的泛用联系能力真的发给阿杰（场景明写这几条）。
    const tv = loadScenario("corpus-029-tv-volume-relay-2026-09-11.json");
    assert.equal(tv.expect?.minAcceptedOutbound, 1, "029 必须真的发出第三方提醒");
    assert.deepEqual(tv.expect?.mustUseTools, ["contactPerson"], "029 必须用泛用联系能力");
    assert.deepEqual(tv.expect?.mustContactNames, ["阿杰"], "029 收件人是原话点名的阿杰");
    assert.deepEqual(tv.expect?.mustNotContactNames, ["小婷"], "029 不得发给发起人");
    const tvReplyBans = tv.expect?.replyMustNotMatch ?? [];
    assert(
      tvReplyBans.some((p) => new RegExp(p).test("客厅那位")),
      "029 回复禁词必须能抓住不点名收件人的含糊指代"
    );
    const tvOutboundBans = tv.expect?.outboundMustNotMatch ?? [];
    assert(
      tvOutboundBans.some((p) => new RegExp(p).test("48 小时没合眼")),
      "029 出站禁词必须能抓住转述发信人私人状况的写法"
    );
    // 模型验收抓到的真实泄露：029 出站同时含来源姓名、补觉/睡不着私人状况、归因句。
    // 机器禁词必须能整体抓住它，防止再次假绿（通用代码闸见 checkSourcePrivacy）。
    const tvRealLeak =
      "阿杰，小婷在房间补觉，客厅电视声她那边听得很清楚，睡不着。她想请你现在把音量调小一点。";
    assert(
      tvOutboundBans.some((p) => new RegExp(p).test(tvRealLeak)),
      "029 出站禁词必须能抓住真实泄露（来源姓名 / 补觉 / 她想请你）"
    );
    // 二次模型验收的真实泄露：来源姓名与归因句都清掉后，仍转述来源人私人处境（补觉 / 睡不着）。
    const tvSecondLeak =
      "阿杰，客厅电视声这会儿有点大，房间里有人补觉、睡不着。麻烦先把音量调小一点，行吗？";
    assert(
      tvOutboundBans.some((p) => new RegExp(p).test(tvSecondLeak)),
      "029 出站禁词必须能抓住二次泄露（补觉 / 睡不着这类私人处境）"
    );
    assert(
      !tvOutboundBans.some((p) => new RegExp(p).test("阿杰，麻烦把客厅电视音量调小点。")),
      "029 出站禁词不得误伤正常的中性提醒"
    );
    // 034 混合请求那一轮不再被快路径截取：整条落回完整主流程，由主生成用 contactPerson
    // 真的联系阿川（场景只断言结构性事实，不断言正文只讲洗衣）。
    const mixed = loadScenario("corpus-034-night-laundry-reminder-2026-09-12.json");
    const mixedTurn = mixed.turns.find((t) => t.text.includes("顺便把地漏的头发"));
    assert(mixedTurn, "034 必须保留老板指定的混合请求那一轮");
    assert.equal(
      mixedTurn.expect?.minAcceptedOutbound,
      1,
      "034 混合轮仍要真的发出第三方提醒（走完整主流程）"
    );
    assert.deepEqual(
      mixedTurn.expect?.mustUseTools,
      ["contactPerson"],
      "034 混合轮必须由主生成的泛用联系能力办，而不是快路径"
    );
    assert.deepEqual(
      mixedTurn.expect?.mustContactNames,
      ["阿川"],
      "034 混合轮收件人是原话点名的阿川"
    );
    assert(
      !(mixedTurn.expect?.mustNotUseTools ?? []).includes("contactPerson"),
      "034 混合轮不得再禁止主生成用 contactPerson"
    );
  });

  /**
   * ── 受约束提醒的**行为**验证（假 repo + mock FeatureLlm，不碰数据库、不发真短信）──
   *
   * 免费测试必须**真的调用公开函数、断言到底入队了几条 / 正文是什么 / 收件人是谁 /
   * 生成阶段看到了什么 / 花了多少**，而不是拿「源码里出现过某常量」冒充行为证据。覆盖：
   *   · **只调一次路由**（不是每个功能各判一次），未被选中的功能一次都不调；
   *   · **整条恰好一件事**才走快路径：纯夜间洗衣交办抽取只保留获准字段，生成阶段
   *     看不到来源情境（原话 / 时间 / 空间细节 / 我房间 / 我被吵醒）；
   *   · **混合请求（夹带别的诉求）路由 none**：前门不截取、零出站零写入，整条落回
   *     完整主流程（不再是"只办已获准的那一件、把其余丢掉"）；
   *   · 两个功能正文都来自模型生成（mock 返回**模型原始文本**，真实 JSON 解析 +
   *     schema 校验后原样发出），收窄字段随功能不同；
   *   · 主题不在专门优化清单里（如 029 电视音量）：路由 none → 前门零出站、零写入、
   *     不进抽取 / 生成，落回完整协调流程（那里由主生成按 doctrine + 本轮 intent 判断
   *     要不要用 `contactPerson` 联系）；
   *   · `reply_only`（否定 / 征询 / 附条件）：**不是功能、不是工具**，无工具、无出站、
   *     零写入，只回当前住户一两句；失败也只回中性兜底、绝不落回主生成；
   *     **"同时交办两件"不属于 reply_only**——那是 `none`、整条交给完整主流程；
   *   · **黑名单复用同一次路由**：条目作为 `blocked:<id>` 选项摆给模型，只有模型判定
   *     住户正在交办它时才拦（当前登记唯一一项「单方面叫别人在洗完澡后清理地漏头发」），
   *     再过**该条目自己的**纯代码资格复核（缺必要信号则当作 none 落回完整流程），
   *     纯代码真话回复、零出站；表里没有的 id 恒不拦、不加第二次调用；
   *   · **用量准确累计**：route + 选中功能 extract + compose 三段全计；route none
   *     也计；失败调用已完成 step 的用量也不丢；每条短调用都有正的最大输出上限；
   *   · 收件人由代码绑定原话（模型改不了人）；不可达 → 真话说明、零写入；
   *   · 落任何写入都仍过 assertCanWrite 硬闸（功能入口不是绕过发送硬闸的后门）。
   */
  // 假 repo 零真实写入，但**直接发送要过 assertCanWrite 硬闸**。按 guard 的正规姿势
  // 放行：显式开 `COLIVING_LOCAL_WRITE=1`，且目标就是测试屋（所有调用传 senderIsTest:true）。
  // **不把 NEXT_RUNTIME 设成 nodejs 冒充生产运行时**——那是绕过硬闸，不是启用它。跑完还原。
  const savedLocalWrite = process.env.COLIVING_LOCAL_WRITE;
  process.env.COLIVING_LOCAL_WRITE = "1";
  try {
    await checkAsync(
      "混合请求（夹带别的诉求）：路由 none → 前门不截取、零出站零写入，整条落回完整主流程",
      async () => {
        const { run, handling, featureId, calls, repo } = await runFeature(MIXED_REQUEST, {
          // 老板指定样本：整条交办里夹带了别的诉求（头发 / 水费 / 全屋规矩）。
          // 路由必须返回 none——**不许只挑出「深夜别用洗衣机」那一段来办、把其余丢掉**。
          feature_route: FEATURE_ROUTE_NONE,
        });
        assert.equal(featureId, null, "混合请求不得命中任何已批准功能");
        assert.equal(run.mode, "none", "混合请求必须整条落回完整主流程（不是拒绝）");
        assert.equal(handling, null, "前门不得截取其中一件来执行");
        assert.equal(run.error, undefined, "none 是正常结果，不是失败");
        // **只调一次路由**，不是每个功能各判一次；none 也不进任何功能的抽取 / 生成。
        const routeCalls = calls.filter((c) => c.name === FEATURE_ROUTE_NAME);
        assert.equal(routeCalls.length, 1, "路由只允许一次调用");
        assert.equal(routeCalls[0].stage, FEATURE_ROUTE_STAGE);
        assert.equal(routeCalls[0].user, MIXED_REQUEST, "路由阶段拿到住户原话");
        assert.equal(
          calls.filter(
            (c) => c.name.endsWith("_extract") || c.name.endsWith("_message")
          ).length,
          0,
          "none 不进任何功能的抽取 / 生成（整条交给完整主流程）"
        );
        assert.equal(repo.thirdParty().length, 0, "前门零第三方出站");
        assert.equal(repo.queued.length, 0, "前门零写入（由完整主流程处理）");
        assert.equal(repo.decisions.length, 0, "前门零决定");
      }
    );

    await checkAsync(
      "纯夜间洗衣交办（整条恰好一件）：快路径命中，生成阶段看不到来源情境",
      async () => {
        // 与上面的混合样本同一主题，但**整条恰好只有这一件事**——这才走快路径。
        const pureRequest = "提醒 阿川，深夜别开洗衣机或烘干机，机器挨着我房间那面墙，昨天凌晨四点我被吵醒了。";
        const { handling, featureId, calls, repo } = await runFeature(pureRequest, {
          feature_route: NIGHT_LAUNDRY_FEATURE_ID,
          // mock 返回的是**模型原始文本**，真实的 JSON 提取 + schema 校验照跑。
          // 抽取只留三个中性类别字段：设备类别 / 时段 / 是否影响休息。
          night_laundry_extract: JSON.stringify({
            machine: "both",
            timeWindow: "pre_dawn",
            affectsRest: true,
          }),
          night_laundry_message: JSON.stringify({
            message: NIGHT_BODY,
            receipt: "好，已经跟阿川说了，在等他回话。",
          }),
        });
        assert.equal(featureId, NIGHT_LAUNDRY_FEATURE_ID, "纯交办必须命中夜间洗衣这一项");
        assert.equal(
          calls.filter((c) => c.name === FEATURE_ROUTE_NAME).length,
          1,
          "路由只调一次"
        );
        assert.equal(
          calls.filter((c) => c.name.startsWith("personal_item")).length,
          0,
          "未被选中的功能一次都不能调（不再是 N 个 judge 并行）"
        );
        assert(handling, "命中且收件人唯一时必须办完");
        // 生成阶段：只拿三个中性类别字段，看不到原话，更看不到来源情境。
        const compose = calls.find((c) => c.name === "night_laundry_message");
        assert(compose, "必须走到生成阶段");
        assert(compose!.user.includes("阿川"), "生成阶段可以知道收件人");
        assert(
          compose!.user.includes("洗衣机和烘干机"),
          "生成阶段拿到的是设备类别，不是原始设备描述"
        );
        assert(compose!.user.includes("凌晨"), "生成阶段拿到的是时段类别，不是原始时间原话");
        // **来源情境绝不能被喂进生成阶段**（否则模型可能第一人称复述，把 AI 写成受影响
        // 的住户）：原始时间原话、原始空间细节、原始请求本身，一个都不许出现。
        assert(!compose!.user.includes(pureRequest), "生成阶段看不到原始请求");
        for (const privateDetail of ["昨天凌晨四点", "机器挨着我房间那面墙", "我房间", "我被吵醒"]) {
          assert(
            !compose!.user.includes(privateDetail),
            `来源情境「${privateDetail}」绝不能进入生成阶段的输入`
          );
        }
        // 真的只发这一条、正文是模型写的那句。
        assert.equal(repo.thirdParty().length, 1, "恰好一条第三方出站");
        assert.equal(repo.thirdParty()[0].toPersonId, GATE_ACHUAN, "收件人只能是阿川");
        assert.equal(repo.thirdParty()[0].body, NIGHT_BODY, "正文是模型生成的那句，不是常量");
        assert.equal(repo.queued.length, 1, "恰好一条投递");
        assert.equal(handling!.sms?.text, NIGHT_BODY);
        assert.equal(handling!.reply, "好，已经跟阿川说了，在等他回话。", "回执用模型写的那句");
      }
    );

    await checkAsync(
      "个人物品功能：收窄字段随功能不同，正文来自模型生成，空回执才回落兜底",
      async () => {
        const request =
          "阿川又拿了我搁在客厅的充电器，用完也不吭声。你帮我跟他讲一声，下次动我东西前先跟我打个招呼。";
        const { featureId, handling, calls, repo } = await runFeature(request, {
          feature_route: PERSONAL_ITEM_FEATURE_ID,
          personal_item_extract: JSON.stringify({
            item: "客厅的充电器",
            notPutBack: true,
          }),
          personal_item_message: JSON.stringify({ message: ITEM_BODY, receipt: "" }),
        });
        assert.equal(featureId, PERSONAL_ITEM_FEATURE_ID, "个人物品交办必须命中个人物品这一项");
        assert.equal(
          calls.filter((c) => c.name === FEATURE_ROUTE_NAME).length,
          1,
          "路由只调一次"
        );
        assert.equal(
          calls.filter((c) => c.name.startsWith("night_laundry")).length,
          0,
          "未被选中的夜间洗衣功能一次都不能调"
        );
        const compose = calls.find((c) => c.name === "personal_item_message");
        assert(compose, "必须走到生成阶段");
        assert(compose!.user.includes("客厅的充电器"), "生成阶段拿到本功能获准的物品");
        assert(compose!.user.includes("没有归位"), "生成阶段拿到的是归位与否这个中性字段");
        assert(!/洗衣|烘干|深夜/.test(compose!.user), "生成阶段不得看到另一功能的主题");
        // 来源情境 / 原始请求 / 第一人称描述一律不能喂进生成阶段：否则模型可能用
        // 第一人称冒充物品主人（「我的东西」「我搁在」）。
        assert(!compose!.user.includes(request), "生成阶段看不到原始请求");
        for (const privateDetail of ["我搁在", "用完也不吭声", "我东西"]) {
          assert(
            !compose!.user.includes(privateDetail),
            `来源情境「${privateDetail}」绝不能进入生成阶段的输入`
          );
        }
        assert(handling, "命中且收件人唯一时必须办完");
        assert.equal(repo.thirdParty().length, 1, "恰好一条第三方出站");
        assert.equal(repo.thirdParty()[0].toPersonId, GATE_ACHUAN, "收件人只能是阿川");
        assert.equal(repo.thirdParty()[0].body, ITEM_BODY, "正文是模型生成的那句，不是常量");
        assert.equal(
          handling!.reply,
          personalItemFallbackReceipt("阿川"),
          "模型回执为空时才回落到兜底短句"
        );
      }
    );

    await checkAsync(
      "none（与清单无关的普通话）：落回普通对话，零出站、零写入、不进抽取/生成",
      async () => {
        const members = [gateMember(GATE_SENDER, "小禾"), gateMember(GATE_ACHUAN, "阿杰")];
        const { run, handling, featureId, calls, repo } = await runFeature(
          "最近天气凉了，屋里有点冷。",
          { feature_route: "none" },
          {
            members,
            usages: {
              feature_route: { steps: 1, inputTokens: 50, outputTokens: 2, costUsd: 0.004 },
            },
          }
        );
        assert.equal(featureId, null, "普通话不得命中任何已批准功能");
        assert.equal(run.mode, "none", "普通话必须落回普通对话");
        assert.equal(handling, null, "没命中就不执行");
        assert.equal(run.error, undefined, "none 是正常结果，不是失败");
        assert.equal(repo.queued.length, 0, "零写入");
        assert.equal(repo.thirdParty().length, 0, "零第三方出站");
        assert.equal(repo.decisions.length, 0, "零决定");
        assert.equal(calls.length, 1, "只调一次路由");
        assert.equal(calls[0].name, FEATURE_ROUTE_NAME);
        assert.equal(
          calls.filter((c) => c.name.endsWith("_extract") || c.name.endsWith("_message")).length,
          0,
          "none 不进抽取 / 生成"
        );
        // 即使 none，路由这次调用真实花的钱也必须计回来。
        assert.equal(run.usage.steps, 1);
        assert.equal(run.usage.inputTokens, 50);
        assert.equal(run.usage.costUsd, 0.004, "route none 也要计费");
      }
    );

    await checkAsync(
      "reply_only（不是功能、不是工具）：明确围绕已批准功能但本轮不动作 → 无工具、无出站、只回当前住户",
      async () => {
        const text = "先别提醒阿川深夜洗衣服的事，我还得再想想，别急着替我说。";
        const replyText = "好，那这一轮我先不动，你想好要不要说再跟我讲。";
        const { run, handling, featureId, calls, repo } = await runFeature(
          text,
          {
            feature_route: FEATURE_ROUTE_REPLY_ONLY,
            feature_reply_only: JSON.stringify({ reply: replyText }),
          },
          {
            usages: {
              feature_route: { steps: 1, inputTokens: 40, outputTokens: 1, costUsd: 0.001 },
              feature_reply_only: { steps: 1, inputTokens: 60, outputTokens: 20, costUsd: 0.002 },
            },
          }
        );
        assert.equal(run.mode, "reply_only", "保留对话轮必须显式标成 reply_only");
        assert.equal(featureId, null, "reply_only 不是功能，featureId 必须为 null");
        assert(handling, "保留对话轮也要给当前住户一句回应");
        assert.equal(handling!.sms, null, "reply_only 绝不产生任何出站");
        assert.equal(handling!.decisionId, null, "reply_only 不落决定");
        assert.equal(handling!.reply, replyText, "回给当前住户的是模型生成的那句，不是常量");
        // 零第三方出站、零写入、零决定：它不是功能、不是工具。
        assert.equal(repo.queued.length, 0, "零写入");
        assert.equal(repo.thirdParty().length, 0, "零第三方出站");
        assert.equal(repo.decisions.length, 0, "零决定");
        // 两次调用：一次路由 + 一次小回复；绝不进任何功能的抽取 / 生成。
        assert.equal(calls.length, 2, "恰好两次调用：路由 + reply_only");
        assert.equal(calls[0].name, FEATURE_ROUTE_NAME);
        assert.equal(calls[1].name, REPLY_ONLY_NAME);
        assert.equal(calls[1].stage, REPLY_ONLY_STAGE);
        assert.equal(
          calls[1].maxOutputTokens,
          FEATURE_REPLY_ONLY_MAX_OUTPUT_TOKENS,
          "reply_only 用独立档位常量，不写字面量"
        );
        assert(calls[1].user === text, "小回复只对当前说话人，可以看他的原话");
        assert.equal(
          calls.filter((c) => c.name.endsWith("_extract") || c.name.endsWith("_message")).length,
          0,
          "reply_only 不进任何功能的抽取 / 生成"
        );
        // 用量照记：路由 + 小回复两段都并进本轮。
        assert.equal(run.usage.steps, 2);
        assert.equal(run.usage.inputTokens, 100);
        assert.equal(run.usage.outputTokens, 21);
        assert.equal(Math.round(run.usage.costUsd * 1000) / 1000, 0.003);
      }
    );

    await checkAsync(
      "reply_only 生成失败 → 中性兜底收尾，绝不落回主生成（不调 proposeRule 之类）",
      async () => {
        const boom = new FeatureCallError(
          REPLY_ONLY_STAGE,
          new Error("reply_only json invalid"),
          { ...EMPTY_FEATURE_USAGE, steps: 1, inputTokens: 30, outputTokens: 5, costUsd: 0.002 }
        );
        const { run, handling, calls, repo } = await runFeature(
          "先别提醒阿川深夜洗衣服的事，我还得再想想。",
          { feature_route: FEATURE_ROUTE_REPLY_ONLY, feature_reply_only: boom },
          {
            usages: {
              feature_route: { steps: 1, inputTokens: 40, outputTokens: 1, costUsd: 0.001 },
            },
          }
        );
        assert.equal(run.mode, "reply_only", "失败也必须留在 reply_only 收尾");
        assert.equal(run.featureId, null);
        assert(handling, "失败也要给当前住户一句中性兜底");
        assert.equal(handling!.sms, null, "兜底也绝不出站");
        assert.equal(handling!.reply, REPLY_ONLY_FALLBACK, "失败回落到中性兜底短句");
        assert.equal(repo.thirdParty().length, 0, "零第三方出站");
        assert.equal(repo.decisions.length, 0, "零决定");
        assert.equal(
          calls.filter((c) => c.name.endsWith("_extract") || c.name.endsWith("_message")).length,
          0,
          "失败不得落回任何功能的抽取 / 生成"
        );
        // 失败调用已发生的真实用量不得丢。
        assert.equal(run.usage.steps, 2, "路由 + 失败的 reply_only");
        assert.equal(run.usage.costUsd, 0.003, "路由 + 失败调用已花的钱都要照记");
        assert.equal(run.error, boom, "失败作为 error 暴露（供日志定位，但不当成落回主生成的理由）");
      }
    );

    await checkAsync(
      "生成阶段拿不出正文 → 不执行、零写入（前门落回普通对话）",
      async () => {
        const { run, handling, repo } = await runFeature("提醒 阿川 深夜别开洗衣机", {
          feature_route: NIGHT_LAUNDRY_FEATURE_ID,
          night_laundry_extract: JSON.stringify({
            machine: "both",
            timeWindow: "late_night",
            affectsRest: false,
          }),
          night_laundry_message: JSON.stringify({ message: "", receipt: "好。" }),
        });
        assert.equal(run.mode, "feature", "命中过功能就是 feature 模式，即使没形成出站");
        assert.equal(handling, null, "空正文不得形成出站");
        assert.equal(repo.queued.length, 0, "零写入");
        assert.equal(repo.thirdParty().length, 0, "零第三方出站");
      }
    );

    await checkAsync(
      "收件人不可达：真话说明、零写入（sms 为 null），且不再调生成",
      async () => {
        const unreachable = [
          gateMember(GATE_SENDER, "小禾"),
          gateMember(GATE_ACHUAN, "阿川", { nameConfirmed: false }),
        ];
        const { featureId, handling, calls, repo } = await runFeature(
          "提醒 阿川 用我的个人物品前先问我",
          {
            feature_route: PERSONAL_ITEM_FEATURE_ID,
            personal_item_extract: JSON.stringify({ item: "个人物品", notPutBack: false }),
            // 不预置 personal_item_message：不可达时它在 execute 里就返回，根本不该被调到。
          },
          { members: unreachable }
        );
        assert.equal(featureId, PERSONAL_ITEM_FEATURE_ID, "交办本身命中");
        assert(handling, "命中但收件人不可达时也要给住户一句真话");
        assert.equal(handling!.sms, null, "不可达 → 零出站");
        assert.match(handling!.reply, /姓名还没确认/, "回给住户的是真话说明");
        assert.equal(repo.queued.length, 0, "不可达时零写入");
        assert.equal(repo.thirdParty().length, 0, "不可达时零第三方出站");
        assert.equal(
          calls.filter((c) => c.name === "personal_item_message").length,
          0,
          "不可达时不得再调生成"
        );
      }
    );

    await checkAsync(
      "用量准确累计：一次路由 + 选中功能抽取 + 生成三段都并进 run.usage",
      async () => {
        const { run, calls } = await runFeature(
          "提醒 阿川：深夜别开洗衣机或烘干机",
          {
            feature_route: NIGHT_LAUNDRY_FEATURE_ID,
            night_laundry_extract: JSON.stringify({
              machine: "both",
              timeWindow: "late_night",
              affectsRest: false,
            }),
            night_laundry_message: JSON.stringify({ message: NIGHT_BODY, receipt: "好。" }),
          },
          {
            usages: {
              feature_route: { steps: 1, inputTokens: 100, outputTokens: 3, costUsd: 0.001 },
              night_laundry_extract: { steps: 1, inputTokens: 200, outputTokens: 10, costUsd: 0.002 },
              night_laundry_message: { steps: 1, inputTokens: 300, outputTokens: 20, costUsd: 0.003 },
            },
          }
        );
        assert(run.handling, "命中必须办完");
        assert.equal(calls.length, 3, "恰好三次调用：路由 + 抽取 + 生成");
        assert.equal(calls[0].name, FEATURE_ROUTE_NAME, "第一次就是路由");
        assert.equal(run.usage.steps, 3);
        assert.equal(run.usage.inputTokens, 600);
        assert.equal(run.usage.outputTokens, 33);
        assert.equal(Math.round(run.usage.costUsd * 1000) / 1000, 0.006);
        assert(
          calls.every((c) => Number.isInteger(c.maxOutputTokens) && c.maxOutputTokens > 0),
          "每条短调用都必须有正的最大输出上限"
        );
        // 上限必须**在合理推理输出之前不会截断**：DeepSeek V4.1 Flash 把 reasoning
        // tokens 计入 maxOutputTokens，128 / 320 这种旧值会在文本产出前耗尽（真实
        // 复现过 NoOutputGeneratedError），守一个下限防回归。
        assert(
          calls.every((c) => c.maxOutputTokens >= FEATURE_MIN_OUTPUT_TOKENS),
          `每条短调用的上限都必须 ≥ ${FEATURE_MIN_OUTPUT_TOKENS}（推理也占额度）`
        );
        assert.equal(
          calls[0].maxOutputTokens,
          FEATURE_ROUTE_MAX_OUTPUT_TOKENS,
          "路由档位用统一常量，不写字面量"
        );
      }
    );

    await checkAsync(
      "失败调用也计入：抽取抛错时，路由已花的钱与失败调用用量都不丢",
      async () => {
        const boom = new FeatureCallError(
          "feature:night_laundry:extract",
          new Error("extract json invalid"),
          {
            ...EMPTY_FEATURE_USAGE,
            steps: 1,
            inputTokens: 40,
            outputTokens: 7,
            costUsd: 0.002,
          }
        );
        const { run, calls, repo } = await runFeature("提醒 阿川 深夜别开洗衣机", {
          feature_route: NIGHT_LAUNDRY_FEATURE_ID,
          night_laundry_extract: boom,
        }, {
          usages: {
            feature_route: { steps: 1, inputTokens: 30, outputTokens: 1, costUsd: 0.001 },
          },
        });
        assert.equal(run.error, boom, "失败要作为 error 暴露（调用方落回普通对话）");
        assert.equal(run.handling, null);
        assert.equal(run.featureId, null);
        assert.equal(run.usage.steps, 2, "路由 + 失败的抽取");
        assert.equal(run.usage.costUsd, 0.003, "route + 失败抽取的真实用量都要计入");
        assert.equal(repo.thirdParty().length, 0, "失败时零出站");
        assert.equal(
          calls.filter((c) => c.name.endsWith("_message")).length,
          0,
          "抽取失败后不得再调生成"
        );
      }
    );

    await checkAsync(
      "功能轮收尾不重复记 decision：真发出第三方短信时复用 deliverSms 的 contact_one，只有无出站才新建 reply_only",
      async () => {
        const gateSender = {
          personId: GATE_SENDER,
          name: "小禾",
          role: "tenant" as const,
          householdId: GATE_HOUSE,
          householdLabel: "评测功能轮收尾",
          dwellingId: "dwelling-gate",
          isTest: true,
        };
        const finalizeArgs = (handling: FeatureHandling) =>
          ({
            text: "提醒 阿川 深夜别开洗衣机",
            channel: "sms",
            decisionIntent: "已批准功能（night_laundry）命中",
            handling,
            usage: EMPTY_FEATURE_USAGE,
            sender: gateSender,
            conversationId: "conv-gate",
            modelId: "test-model",
            turnStartedAt: new Date(0),
          }) satisfies Parameters<typeof finalizeFeatureTurn>[0];

        // —— 1. 功能真的把短信发给室友：deliverSms 已落一条 contact_one，收尾必须复用 ——
        const { handling, repo } = await runFeature("提醒 阿川 深夜别开洗衣机", {
          feature_route: NIGHT_LAUNDRY_FEATURE_ID,
          night_laundry_extract: JSON.stringify({
            machine: "washer",
            timeWindow: "late_night",
            affectsRest: true,
          }),
          night_laundry_message: JSON.stringify({
            message: NIGHT_BODY,
            receipt: "好，已经跟阿川说了，在等他回话。",
          }),
        });
        assert(handling?.sms, "这一轮必须真的发出第三方短信");
        assert.equal(repo.decisions.length, 1, "deliverSms 恰好落一条 decision");
        assert.equal(repo.decisions[0].kind, "contact_one", "投递落的是 contact_one");
        const contactDecisionId = repo.decisions[0].id;
        assert.equal(
          handling!.decisionId,
          contactDecisionId,
          "handling 必须把这条联系决策带回收尾"
        );

        const outcome = await finalizeFeatureTurn(finalizeArgs(handling!), repo.finalize);
        assert.equal(
          repo.decisions.length,
          1,
          "收尾不得再新建第二条 decision（否则复盘会把一次联系看成两件事）"
        );
        assert.equal(
          repo.decisions.filter((d) => d.kind === "reply_only").length,
          0,
          "已经真的发出去了，就不该再落一条 reply_only"
        );
        assert.equal(
          outcome.decisionId,
          contactDecisionId,
          "TurnOutcome.decisionId 必须复用 contact_one，而不是收尾新建的 reply_only"
        );
        assert.equal(outcome.outbound.length, 1, "第三方出站照旧返回给调用方投递");
        assert.equal(outcome.outbound[0].personId, GATE_ACHUAN, "出站仍是原话点名的阿川");
        const receipt = repo.queued.find((q) => q.toPersonId === GATE_SENDER);
        assert(receipt, "必须有一条回给发起人的回执");
        assert.equal(
          receipt!.decisionId,
          contactDecisionId,
          "回给发起人的回执 communication 必须挂同一条 contact_one decision"
        );

        // —— 2. reply_only 保留轮：没有第三方短信可挂 → 才新建一条 reply_only ——
        const ro = makeDelivery();
        const replyOnlyOutcome = await finalizeFeatureTurn(
          finalizeArgs({
            status: "handled",
            reply: "好，这一轮我先不替你发出去，你想好了再跟我说。",
            sms: null,
            decisionId: null,
          }),
          ro.finalize
        );
        assert.equal(ro.decisions.length, 1, "无出站时恰好新建一条 decision");
        assert.equal(ro.decisions[0].kind, "reply_only", "无出站时新建的是 reply_only");
        assert.equal(
          replyOnlyOutcome.decisionId,
          ro.decisions[0].id,
          "TurnOutcome.decisionId 是新建的 reply_only"
        );
        assert.equal(replyOnlyOutcome.outbound.length, 0, "reply_only 零出站");
        assert.equal(
          ro.queued.find((q) => q.toPersonId === GATE_SENDER)?.decisionId,
          ro.decisions[0].id,
          "reply_only 的回执挂新建的 reply_only decision"
        );

        // —— 3. 收件人不可达 / 没形成第三方出站：同样新建 reply_only（不是 contact_one） ——
        const unreachable = makeDelivery();
        const unreachableOutcome = await finalizeFeatureTurn(
          finalizeArgs({
            status: "handled",
            reply: "阿川 的姓名还没确认，我暂时没法把提醒发给他。",
            sms: null,
            decisionId: null,
          }),
          unreachable.finalize
        );
        assert.equal(unreachable.decisions.length, 1);
        assert.equal(
          unreachable.decisions[0].kind,
          "reply_only",
          "不可达没有联系决策，只落一条 reply_only"
        );
        assert.equal(unreachableOutcome.decisionId, unreachable.decisions[0].id);
        assert.equal(unreachableOutcome.outbound.length, 0, "不可达零出站");

        // —— 4. 黑名单收口：收尾把**窄结构化引用**写进 decision payload（供紧接着追问） ——
        const bl = makeDelivery();
        await finalizeFeatureTurn(
          {
            ...finalizeArgs({
              status: "handled",
              reply: blacklistedReply(BLACKLISTED_CAPABILITIES[0]),
              sms: null,
              decisionId: null,
            }),
            decisionPayload: {
              blacklistedCapabilityId: BLACKLISTED_CAPABILITIES[0].id,
              personId: GATE_SENDER,
            },
          },
          bl.finalize
        );
        assert.equal(bl.decisions.length, 1, "黑名单收口恰好新建一条 decision");
        assert.deepEqual(
          bl.decisions[0].payload,
          {
            blacklistedCapabilityId: BLACKLISTED_CAPABILITIES[0].id,
            personId: GATE_SENDER,
          },
          "黑名单收口必须把结构化引用写进 decision payload（代码写死的 id，不是自由文本）"
        );
        assert.equal(bl.thirdParty().length, 0, "黑名单收口零第三方出站");
      }
    );

    check("抽取 schema 只收有限结构字段（required、无任意 detail、越界/缺字段一律拒绝）", () => {
      // **返工核心约束**：抽取不再放任意的 detail 原文，只保留有限的结构字段
      // （枚举 / 布尔 / nullable 字符串）——生成阶段因此看不到来源情境，不可能把
      // 「我房间」「我被吵醒」这类第一人称复述进发给室友的正文。
      // 字段全是 required（无 optional：部分 provider 结构化输出兼容性差），
      // 缺字段会被 `safeParse` 拒绝 → 安全不发送；未知一律落到中性值。
      for (const [label, field] of [
        ["night_laundry.machine", nightLaundryExtractionSchema.shape.machine],
        ["night_laundry.timeWindow", nightLaundryExtractionSchema.shape.timeWindow],
        ["night_laundry.affectsRest", nightLaundryExtractionSchema.shape.affectsRest],
        ["personal_item.item", personalItemExtractionSchema.shape.item],
        ["personal_item.notPutBack", personalItemExtractionSchema.shape.notPutBack],
      ] as const) {
        assert.equal(field.isOptional(), false, `${label} 不得是 optional（缺字段必须被拒）`);
      }
      // 物品「没指明」要能表达 → required + nullable（显式 null 被接受）。
      assert.equal(
        personalItemExtractionSchema.shape.item.isNullable(),
        true,
        "personal_item.item 必须是 nullable（没有就显式 null）"
      );
      // 旧的任意 detail 字段必须彻底删掉。
      for (const [label, shape] of [
        ["夜间洗衣", nightLaundryExtractionSchema.shape],
        ["个人物品", personalItemExtractionSchema.shape],
      ] as const) {
        assert(!("detail" in shape), `${label}抽取不得再留任意 detail 字段`);
      }

      // 合法值接受。
      assert.equal(
        nightLaundryExtractionSchema.safeParse({
          machine: "both",
          timeWindow: "pre_dawn",
          affectsRest: true,
        }).success,
        true,
        "合法夜间洗衣字段必须被接受"
      );
      assert.equal(
        personalItemExtractionSchema.safeParse({ item: null, notPutBack: false }).success,
        true,
        "物品显式为 null 必须被接受"
      );
      // 缺字段被拒（required）。
      assert.equal(
        nightLaundryExtractionSchema.safeParse({ machine: "washer" }).success,
        false,
        "缺字段必须被拒（required）"
      );
      assert.equal(
        personalItemExtractionSchema.safeParse({ item: "充电器" }).success,
        false,
        "缺 notPutBack 必须被拒（required）"
      );
      // 越界枚举 / 自由文本 / 类型漂移一律被拒：字段是有限结构，不是自由文本。
      assert.equal(
        nightLaundryExtractionSchema.safeParse({
          machine: "washing machine",
          timeWindow: "pre_dawn",
          affectsRest: true,
        }).success,
        false,
        "枚举外的设备类别必须被拒"
      );
      assert.equal(
        nightLaundryExtractionSchema.safeParse({
          machine: "both",
          timeWindow: "凌晨四点",
          affectsRest: true,
        }).success,
        false,
        "自由文本时段必须被拒（只能枚举）"
      );
      assert.equal(
        nightLaundryExtractionSchema.safeParse({
          machine: "both",
          timeWindow: "pre_dawn",
          affectsRest: "yes",
        }).success,
        false,
        "布尔字段不得接受字符串"
      );
    });

    await checkAsync(
      "抽取/生成走纯文本 JSON 协议：合法 JSON / code fence 通过；坏 JSON / 多对象 / 错字段安全失败且用量不丢",
      async () => {
        const stage = "feature:night_laundry:extract";
        const call = {
          stage,
          name: "night_laundry_extract",
          schema: nightLaundryExtractionSchema,
          system: "s",
          user: "u",
          maxOutputTokens: 4096,
        };
        const genUsage = {
          ...EMPTY_FEATURE_USAGE,
          steps: 1,
          inputTokens: 40,
          outputTokens: 7,
          costUsd: 0.002,
        };
        const fromText = (text: string): FeatureLlm => ({
          async generate() {
            return { text, usage: genUsage };
          },
        });

        // 合法 JSON 通过，并带回真实用量（gateway cost 照计）。
        const ok = await structuredCall(
          fromText('{"machine":"both","timeWindow":"pre_dawn","affectsRest":true}'),
          call
        );
        assert.deepEqual(ok.value, { machine: "both", timeWindow: "pre_dawn", affectsRest: true });
        assert.equal(ok.usage.costUsd, 0.002, "通过的调用带回真实用量");

        // 常见 markdown 代码围栏允许（围栏里就是那个 JSON 对象）。
        const fenced = await structuredCall(
          fromText(
            '```json\n{"machine":"unspecified","timeWindow":"late_night","affectsRest":false}\n```'
          ),
          call
        );
        assert.deepEqual(fenced.value, {
          machine: "unspecified",
          timeWindow: "late_night",
          affectsRest: false,
        });

        // 坏 JSON / 多对象 / 错字段 / 字段类型错 / 枚举越界 / 夹带解释文字 / 根本不是对象：
        // 一律安全失败（抛带 stage 的 FeatureCallError），且这次 generate 已花的
        // 用量必须挂在错误上，不得丢成 0。
        for (const bad of [
          '{"machine": "both"', // 坏 JSON（未闭合）
          '{"machine":"both","timeWindow":"late_night","affectsRest":false}{"machine":"washer","timeWindow":"late_night","affectsRest":true}', // 多对象
          '{"machine":"both"}', // 缺 required 字段
          '{"machine":1,"timeWindow":"late_night","affectsRest":false}', // 字段类型错
          '{"machine":"washing machine","timeWindow":"late_night","affectsRest":false}', // 枚举越界
          '好的，结果是 {"machine":"both","timeWindow":"late_night","affectsRest":false}', // 夹带解释文字
          "深夜", // 不是 JSON 对象
        ]) {
          let caught: unknown;
          try {
            await structuredCall(fromText(bad), call);
          } catch (error) {
            caught = error;
          }
          assert(caught instanceof FeatureCallError, `必须安全失败：${bad}`);
          assert.equal((caught as FeatureCallError).stage, stage, "失败必须带 stage");
          assert.match(
            (caught as FeatureCallError).message,
            /^stage=feature:night_laundry:extract: /,
            "失败 message 必须以 stage 开头"
          );
          assert.equal(
            usageOfFeatureError(caught).costUsd,
            0.002,
            "解析失败也不能把这次 generate 的用量丢成 0"
          );
        }

        // 诊断里的模型文本必须截断，不能把整段输出塞进错误消息。
        const longErr = await structuredCall(
          fromText(`好的，这是结果 {"machine":${"x".repeat(400)}}`),
          call
        ).then(
          () => null,
          (error: unknown) => error
        );
        assert(longErr instanceof FeatureCallError);
        assert(
          !(longErr as FeatureCallError).message.includes("x".repeat(300)),
          "诊断里的模型文本必须截断"
        );

        // 普通错误没有 SDK 诊断字段：回落默认 message，但 **仍须带 stage**。
        const plain = new Error("network reset");
        assert.equal(featureErrorDiagnostics(plain), null);
        const plainWrapped = new FeatureCallError(
          stage,
          plain,
          EMPTY_FEATURE_USAGE
        );
        assert.equal(
          plainWrapped.message,
          `stage=${stage}: network reset`,
          "任何错误类型的 message 都必须带 stage（否则日志无法定位）"
        );
      }
    );

    // 真实 034 复现：推理把 maxOutputTokens 耗尽 → 输出为空 → SDK 抛
    // NoOutputGeneratedError（无 text / response / usage）。以前只回落成
    // 「No output generated.」，日志看不出是哪一步；现在至少要带 stage 与 cause。
    check("NoOutputGeneratedError：诊断带 stage + cause；已完成 step 的用量照计", () => {
      const stage = "feature:personal_item:compose";
      const noOutput = new NoOutputGeneratedError({
        cause: new Error("max output tokens reached before any output"),
      });
      const diag = featureErrorDiagnostics(noOutput);
      assert(diag, "NoOutputGeneratedError 必须有诊断摘要");
      assert.match(diag!, /NoOutputGeneratedError/);
      assert.match(diag!, /cause=max output tokens reached/);
      // 已完成 step 的真实用量（onStepFinish 已触发）必须能经 FeatureCallError 带出来——
      // 推理耗尽的那次调用 step 本身是完成的，不能因为读不到错误自带 usage 就记 0。
      const captured = {
        ...EMPTY_FEATURE_USAGE,
        steps: 1,
        inputTokens: 500,
        outputTokens: 4096,
        costUsd: 0.004,
      };
      const wrapped = new FeatureCallError(stage, noOutput, captured, diag!);
      assert.equal(wrapped.stage, stage);
      assert.equal(wrapped.cause, noOutput);
      assert.equal(
        wrapped.message,
        `stage=${stage}: ${diag}`,
        "NoOutput 的 message 也必须带 stage"
      );
      assert.equal(
        usageOfFeatureError(wrapped).outputTokens,
        4096,
        "NoOutput 时已完成 step 的 token 不得丢"
      );
      assert.equal(usageOfFeatureError(wrapped).costUsd, 0.004, "已发生的费用照记");
    });

    check("两个已批准功能仍是各自独立的模块（各写各的 extract / execute）", () => {
      assert.equal(APPROVED_FEATURES.length, 2, "当前只批准两项");
      const ids = APPROVED_FEATURES.map((f) => f.id);
      assert.equal(new Set(ids).size, ids.length, "两个功能 id 必须互异");
      for (const f of APPROVED_FEATURES) {
        assert.equal(typeof f.extract, "function", `${f.id} 必须有自己的抽取`);
        assert.equal(typeof f.execute, "function", `${f.id} 必须有自己的执行`);
        assert(f.routeDescription.trim().length > 0, `${f.id} 必须有路由定义`);
      }
    });

    await checkAsync(
      "落库仍过 assertCanWrite 硬闸：不开 COLIVING_LOCAL_WRITE 时直接发送被拦、零写入",
      async () => {
        const repo = makeDelivery();
        const savedLocal = process.env.COLIVING_LOCAL_WRITE;
        const savedRuntime = process.env.NEXT_RUNTIME;
        delete process.env.COLIVING_LOCAL_WRITE;
        delete process.env.NEXT_RUNTIME;
        try {
          await assert.rejects(
            () =>
              deliverSms(
                {
                  householdId: GATE_HOUSE,
                  channel: "sms",
                  senderIsTest: true,
                  purposeLabel: "夜间洗衣提醒",
                  recipient: gateMembers[1],
                  text: NIGHT_BODY,
                },
                repo.delivery
              ),
            /本地进程不许写真实数据/,
            "没开 COLIVING_LOCAL_WRITE 时直接发送必须被硬闸拦下"
          );
          assert.equal(repo.queued.length, 0, "被硬闸拦下时零写入");
          assert.equal(repo.thirdParty().length, 0, "被硬闸拦下时零第三方出站");
        } finally {
          if (savedLocal === undefined) delete process.env.COLIVING_LOCAL_WRITE;
          else process.env.COLIVING_LOCAL_WRITE = savedLocal;
          if (savedRuntime === undefined) delete process.env.NEXT_RUNTIME;
          else process.env.NEXT_RUNTIME = savedRuntime;
        }
        // 兜底短句本身不得主动列能力 / 讲内部边界。
        for (const t of [
          nightLaundryFallbackReceipt("阿川"),
          personalItemFallbackReceipt("阿川"),
        ]) {
          assert(
            !/只能|能帮|帮不了|做不到|没办法|不能替|未开放|白名单|能力范围/.test(t),
            `兜底短句不得主动讲能力边界：${t}`
          );
        }
      }
    );
  } finally {
    if (savedLocalWrite === undefined) delete process.env.COLIVING_LOCAL_WRITE;
    else process.env.COLIVING_LOCAL_WRITE = savedLocalWrite;
  }

  // ── 文本链路统一 V4.1 Flash（2026-09-11 老板决定）─────────────────────────
  check("production generation and offline judge/intent roles still default to V4.1 Flash", () => {
    // 生产批判器/relay 最终修正的选型断言已随"只生成"整体移除（见上面的
    // generation-only contract）。这里只锁仍在用的角色：主生成、离线语义判定、
    // 排班协商意图解析，以及它们各自的显式覆盖逃生舱口。
    const saved = {
      COLIVING_MODEL: process.env.COLIVING_MODEL,
      COLIVING_JUDGE_MODEL: process.env.COLIVING_JUDGE_MODEL,
    };
    delete process.env.COLIVING_MODEL;
    delete process.env.COLIVING_JUDGE_MODEL;
    try {
      const v41 = "deepseek/deepseek-v4.1-flash";
      assert.equal(COLIVING_DEFAULT_MODEL, v41, "主生成默认必须是 V4.1 Flash");
      assert.equal(colivingModelId(), v41, "未设覆盖时主生成必须用 V4.1 Flash");
      assert.equal(JUDGE_DEFAULT_MODEL, v41, "评测语义判定默认必须是 V4.1 Flash");
      assert.equal(judgeModelId(), v41, "未设覆盖时语义判定必须用 V4.1 Flash");
      assert.equal(
        COORDINATION_INTENT_MODEL,
        v41,
        "排班协商意图解析（coordination-bridge/session 依赖）默认必须是 V4.1 Flash"
      );
      // 显式覆盖仍生效：只有设了环境变量才改。
      process.env.COLIVING_MODEL = "some/override-main";
      process.env.COLIVING_JUDGE_MODEL = "some/override-judge";
      assert.equal(colivingModelId(), "some/override-main", "COLIVING_MODEL 覆盖必须仍生效");
      assert.equal(judgeModelId(), "some/override-judge", "COLIVING_JUDGE_MODEL 覆盖必须仍生效");
    } finally {
      const restore = (key: keyof typeof saved) => {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      };
      restore("COLIVING_MODEL");
      restore("COLIVING_JUDGE_MODEL");
    }
  });

  /**
   * 生产批判器的接线断言已随"只生成"产品决定整体移除（老板 2026-09-11）。
   * 契约由本文件两条免费断言接管，不再重复：
   *  - "generation-only contract"：turn.ts 无 critic/critiqueBatch/redo/finalFix
   *    的 import/调用路径，且没有生产默认再选批判器/最终修正模型；
   *  - "generation-only review evidence"：只生成证据（`verified:false` 属设计如此）
   *    被 eval 接受，确定性失败仍红灯；`llm-review` 未验证仍算门禁失败。
   * `critic.ts` 的离线/未来实现（视图选择、离线批量）仍由上面的离线专项断言覆盖。
   */

  /**
   * ── 评测实验 guidance（Golden Trace A/B）──
   *
   * 只证明四条核心安全边界，不靠扫生产源码里的单词：
   * ①空值 = 不启用、已知 id 可解析、未知 id 抛错；
   * ②guidance 是纯正向三条轨迹、内外分栏、不含被删掉的坏句原文；
   * ③生成 system 顺序固定 doctrine → guidance(可选) → runtime，六处生成路径共用 turn.ts 的构造器；
   * ④报告正常/异常两条返回路径都记录 guidance id；CLI 缺值闸真的调用
   *    isMissingGuidanceArg（仅此两处源码断言）。
   * 分层靠结构保证：构造器在生产 turn.ts、登记表在 evals，生产不反向 import；
   * 不再逐句扫 doctrine 目录是否出现实验 id。全免费、确定性，不调模型。
   */
  const evalGuidanceSrc = readFileSync("scripts/coliving-eval.ts", "utf8");
  const turnGuidanceSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");

  check("guidance：空值不启用、已知 id 可解析、未知 id 抛错", () => {
    assert.equal(resolveGuidanceArg(undefined), undefined, "空值 = 不启用");
    assert.equal(resolveGuidanceArg(null), undefined);
    assert.equal(resolveGuidanceArg(""), undefined);
    const text = resolveGuidance("concise-coordination-v1");
    assert.equal(
      resolveGuidanceArg("concise-coordination-v1"),
      text,
      "CLI 解析路径与直接解析必须一致"
    );
    assert.equal(isKnownGuidanceId("concise-coordination-v1"), true);
    assert.equal(isKnownGuidanceId("does-not-exist"), false);
    assert.throws(() => resolveGuidance("does-not-exist"), /未知的 guidance id/);
    assert.throws(() => resolveGuidanceArg("does-not-exist"), /未知的 guidance id/);
    assert.deepEqual(Object.keys(COLIVING_GUIDANCE_TEXTS), knownGuidanceIds());
  });

  check("guidance：--guidance 后紧跟另一个 flag 视为缺值，不当成未知 id", () => {
    // 回归：`--guidance --judge-off` 里 argValue 取到的是 "--judge-off"。
    // 必须判定为缺值（走统一的缺值报错），而不是当未知 id 报错。
    assert.equal(isMissingGuidanceArg("--judge-off"), true, "下一个参数是 flag → 缺值");
    assert.equal(isMissingGuidanceArg("--judge-advisory"), true);
    assert.equal(isMissingGuidanceArg(null), true, "参数缺席 → 缺值");
    assert.equal(isMissingGuidanceArg(""), true, "空串 → 缺值");
    assert.equal(
      isMissingGuidanceArg("concise-coordination-v1"),
      false,
      "已登记 id 不是缺值"
    );
    // CLI 必须真的用这个判定，否则函数正确也拦不住 bug。
    assert(
      evalGuidanceSrc.includes("isMissingGuidanceArg(GUIDANCE_ID)"),
      "coliving-eval.ts 的缺值闸必须调用 isMissingGuidanceArg"
    );
  });

  check("guidance 是三条正向轨迹、内外分栏，且不含被删掉的坏句原文", () => {
    const text = resolveGuidance("concise-coordination-v1");
    for (const trace of ["轨迹一", "轨迹二", "轨迹三"]) {
      assert(text.includes(trace), `缺少 ${trace}（目标询问/劝退过度规则/隐私询问）`);
    }
    assert(
      text.includes("内部状态") && text.includes("对住户说"),
      "必须分栏「内部状态」与「对住户说」"
    );
    assert(/不要照抄|不是模板/.test(text), "必须声明示范不要求逐字照搬、不得固定句式");
    // 第一版把「不说：某某坏句子」逐字喂回生成器，已被退回——坏句原文不得复现。
    for (const removed of [
      "我先记录成你的陈述",
      "还没有查实",
      "你希望我怎么处理",
      "这不合规",
      "我先去核实作息",
      "他绝对不会知道",
    ]) {
      assert(!text.includes(removed), `被删掉的坏句原文不得复现：${removed}`);
    }
  });

  check("生成 system 顺序 doctrine → guidance(可选) → runtime；无 guidance 时 doctrine → runtime", () => {
    const noGuidance = buildGeneratorSystemMessages({ doctrine: "D", runtime: "R" });
    assert.deepEqual(
      noGuidance.map((m) => m.content),
      ["D", "R"],
      "无 guidance 时严格是 doctrine → runtime"
    );
    assert.deepEqual(
      buildGeneratorSystemMessages({ doctrine: "D" }).map((m) => m.content),
      ["D"],
      "runtime 为空时不产生空 system 消息"
    );
    const withGuidance = buildGeneratorSystemMessages({ doctrine: "D", guidance: "G", runtime: "R" });
    assert.deepEqual(
      withGuidance.map((m) => m.content),
      ["D", "G", "R"],
      "当前事实 runtime 必须排在实验 guidance 之后"
    );
    assert.deepEqual(
      withGuidance[0].providerOptions,
      { anthropic: { cacheControl: { type: "ephemeral" } } },
      "doctrine 段必须带 prompt cache 断点"
    );
    assert(!noGuidance.some((m) => m.content === "G"), "无 guidance 时数组里没有实验附件");
    // 两处生成器调用共用 turn.ts 里的同一个构造器（`({` 只命中调用点，不含定义行）：
    // 主生成、强制投递（forced-sendReply）；不再各复制条件展开。批判器不走这里。
    assert.equal(
      turnGuidanceSrc.split("buildGeneratorSystemMessages({").length - 1,
      2,
      "两处生成器 system 都必须走共享构造器"
    );
    assert(
      !turnGuidanceSrc.includes("content: args.guidance },"),
      "不得保留逐处复制的 guidance 条件展开"
    );
  });

  check("评测报告在正常/预算中止/异常返回路径都记录 guidance id", () => {
    // 不硬编码"应该有 2 条"这种脆弱计数：预算中止是和异常并列的**第三条**
    // 返回路径（`runScenario` 的 loopBudgetStop 提前返回），以后还可能加新的。
    // 改成**成对不变量**：凡带本地账 `cost: ledger.snapshot()` 的结果返回，
    // 就必须同时带 `guidance: GUIDANCE_LABEL`——新增路径两者一起出现才通过，
    // 只加账、漏了 guidance 立刻失败。
    const costStamps = evalGuidanceSrc.split("cost: ledger.snapshot()").length - 1;
    const guidanceStamps =
      evalGuidanceSrc.split("guidance: GUIDANCE_LABEL").length - 1;
    assert(
      costStamps >= 3,
      `正常/预算中止/异常三条返回路径都应写本地账，实际 ${costStamps} 条`
    );
    assert.equal(
      guidanceStamps,
      costStamps,
      "每条带本地账的结果返回路径都必须同时记录 guidance id（成对出现）"
    );
    // 三条路径确实各自存在（用各自独有的事实措辞做锚，不用可被凑数满足的固定计数）
    for (const anchor of [
      "评测预算停止：", // runScenario 的预算中止返回
      "场景执行异常：", // runScenarioSafely 的 catch 返回
      "pass: failures.length === 0,", // runScenario 的正常返回
    ]) {
      assert(
        evalGuidanceSrc.includes(anchor),
        `预期中的返回路径锚点不存在：${anchor}`
      );
    }
  });

  /**
   * ── 离线期望「本轮协调动作卡」（只读、离线、评测专用）──
   *
   * 免费确定性检查：验场景 schema 对 `privacyCard` 的合法/非法处理、纯函数
   * 校验器的 green/red cases（目的优先、无披露动作不得带收件人、无披露卡回复
   * 不得偷偷承诺联系第三人、有披露计划必须有依据与名册内收件人、
   * likely+unknown 只能 ask_owner、basis 逐字段必须有非 project_glue 来源），
   * 三张离线期望卡全部通过，以及 CLI/模块**完全没接模型、
   * 网关、.env 或生产动作**。全程不调模型、不联网。结构边界靠"不得 import
   * 生产 turn / repo、不得出现模型/动作调用形式"保证；注释里解释边界时允许
   * 出现这些名字（只查调用/导入形式，不误伤文档）。
   */
  const privacyCardSrc = readFileSync(
    "lib/chat/coliving/evals/privacy-turn-card.ts",
    "utf8"
  );
  const privacyCliSrc = readFileSync(
    "scripts/coliving-privacy-card.ts",
    "utf8"
  );
  const basisEntry = (
    fields: string[],
    sourceType: CoordinationBasisEntry["sourceType"],
    sourceRef: string,
    rule: string
  ): CoordinationBasisEntry => ({ fields, sourceType, sourceRef, rule });
  // 逐字段覆盖业务字段的通用依据，保证 green fixture 不会因为 basis 缺来源
  // 而被判失败。清单必须与 privacy-turn-card 的 REQUIRED_BASIS_FIELDS 对齐
  // （userGoal / requestedAction / actionBasis / sourceConstraint /
  //  decisionStage / disclosurePlan / proposedRecipients / outboundMessages /
  //  actionStatus / sourceOwner / sensitiveClaims / inferenceRisk / riskReasons /
  //  ownerConsent / recommendedAction / residentReply /
  //  capabilityZone / capabilityReasons）。
  const fullBasis = (): CoordinationBasisEntry[] => [
    basisEntry(["userGoal", "requestedAction"], "owner_direction", "老板产品定义 · 管理入口", "住户围绕联系/排班/定规则/通知等管理动作而来"),
    basisEntry(["actionBasis", "decisionStage", "sourceConstraint"], "owner_direction", "老板产品定义 · 明确请求即授权", "明确点名要求联系即已授权，非隐藏来源时不再请示"),
    basisEntry(["disclosurePlan", "proposedRecipients", "outboundMessages"], "external_standard", "ICO Purpose limitation", "只为既定目的对外联系"),
    basisEntry(["inferenceRisk", "ownerConsent", "riskReasons"], "doctrine", "domain/conflict.md · 六", "反推风险与同意判定"),
    basisEntry(["recommendedAction", "actionStatus"], "doctrine", "always/constitution.md · 承诺必须兑现", "说了要联系就必须真的联系并回报状态"),
    basisEntry(["sourceOwner", "sensitiveClaims"], "doctrine", "tool/records.md · 一", "事实与判断分离"),
    basisEntry(["sensitiveClaims"], "external_standard", "ICO Data minimisation", "只披露最少必要内容"),
    basisEntry(["residentReply"], "doctrine", "always/craft.md · 输出格式", "只回动作收据，不复述道理"),
    basisEntry(["capabilityZone", "capabilityReasons"], "owner_direction", "老板明确要求 · 协调能力边界（CAPABILITY_BOUNDARY_V0.md）", "绿/黄/红三档由可观察信号判断；红区针对无依据创设规则，不是遇到冲突就停"),
  ];
  const outboundTo = (recipient: string, text: string) => ({
    recipient,
    purpose: "最小化边界提醒",
    text,
  });
  // 已授权 + 明确请求 + 无来源限制 → 立即最小化联系并完成（corpus-025 形态）。
  const authorizedCard: PrivacyTurnCard = {
    userGoal: "contact_person",
    requestedAction: "contact_person",
    actionBasis: "explicit_user_request",
    sourceConstraint: "none",
    decisionStage: "authorized",
    disclosurePlan: "approved_to_send",
    sourceOwner: "阿哲",
    proposedRecipients: ["大凯"],
    sensitiveClaims: ["大凯每周进阿哲房间打扫、动他的私人物品"],
    inferenceRisk: "likely",
    riskReasons: ["屋里只有阿哲和大凯两人", "内容涉及私人房间和物品"],
    ownerConsent: "approved",
    recommendedAction: "contact_now_minimized",
    outboundMessages: [outboundTo("大凯", "进室友房间或动室友东西前先征得本人同意。")],
    actionStatus: "completed",
    residentReply: "已经提醒大凯，之后进你房间或动你东西前要先征得你同意。",
    decisionSummary: "明确请求已授权联系，立即最小化联系并回报动作收据",
    capabilityZone: "green",
    capabilityReasons: ["低风险、动作明确、可核验的边界提醒", "只在两人之间最小披露"],
    basis: fullBasis(),
  };
  // 讨论阶段：允许且应当没有出站，只给具体方案或一个必要问题。
  const deliberatingCard: PrivacyTurnCard = {
    userGoal: "make_schedule",
    requestedAction: "make_schedule",
    actionBasis: "explicit_user_request",
    sourceConstraint: "none",
    decisionStage: "deliberating",
    disclosurePlan: "considering",
    sourceOwner: "阿哲",
    proposedRecipients: [],
    sensitiveClaims: ["厨房时段还没定"],
    inferenceRisk: "not_applicable",
    riskReasons: [],
    ownerConsent: "not_needed",
    recommendedAction: "make_schedule",
    outboundMessages: [],
    actionStatus: "not_started",
    residentReply: "我建议厨房先给你连续两小时，其余时段分给另外两位；你觉得这个顺序行吗？",
    decisionSummary: "还在讨论排班方案，本轮没有出站",
    capabilityZone: "green",
    capabilityReasons: ["低风险、可逆的排班讨论", "计划未确认前不出站"],
    basis: fullBasis(),
  };
  // 隐藏来源冲突：唯一允许没有出站的阻塞态，先问信息所有者是否仍发送。
  const blockedCard: PrivacyTurnCard = {
    userGoal: "contact_person",
    requestedAction: "contact_person",
    actionBasis: "explicit_user_request",
    sourceConstraint: "conceal_source",
    decisionStage: "authorized",
    disclosurePlan: "considering",
    sourceOwner: "阿哲",
    proposedRecipients: ["大凯"],
    sensitiveClaims: ["大凯每周进阿哲房间打扫、动他的私人物品"],
    inferenceRisk: "likely",
    riskReasons: ["屋里只有两人，独有细节可反推来源"],
    ownerConsent: "unknown",
    recommendedAction: "ask_owner",
    outboundMessages: [],
    actionStatus: "blocked_for_consent",
    residentReply: "屋里就你们两个人，大凯可能会猜到是你提的。还要我去跟他说吗？",
    decisionSummary: "隐藏来源冲突，先问信息所有者是否仍发送",
    capabilityZone: "yellow",
    capabilityReasons: ["隐私风险可以明确说明，并由信息所有者在行动前决定", "不是行为或权利本身超出能力"],
    basis: fullBasis(),
  };
  // 讨论阶段收手的停止态。
  const stopCard: PrivacyTurnCard = {
    ...deliberatingCard,
    recommendedAction: "stop",
    residentReply: "好，这轮先不联系任何人。",
  };
  // 讨论阶段的规则协调：coordinate_rule 在 deliberating 下允许且应当没有出站，
  // 只给方案。不能拿 make_schedule 代表所有讨论态，必须专门覆盖 coordinate_rule。
  const deliberatingRuleCard: PrivacyTurnCard = {
    userGoal: "establish_rule",
    requestedAction: "establish_rule",
    actionBasis: "explicit_user_request",
    sourceConstraint: "none",
    decisionStage: "deliberating",
    disclosurePlan: "considering",
    sourceOwner: "阿哲",
    proposedRecipients: [],
    sensitiveClaims: ["访客过夜规则还没定"],
    inferenceRisk: "not_applicable",
    riskReasons: [],
    ownerConsent: "not_needed",
    recommendedAction: "coordinate_rule",
    outboundMessages: [],
    actionStatus: "not_started",
    residentReply: "我建议先定访客过夜的频率，再定新增费用怎么分摊；这个顺序你觉得行吗？",
    decisionSummary: "还在讨论规则方案，本轮没有出站",
    capabilityZone: "green",
    capabilityReasons: ["规则方案可以在讨论中形成，未确认前不出站"],
    basis: fullBasis(),
  };
  // 信息所有者明确拒绝后的停止终态：stop + stopped + cancelled + 无出站。
  // 这是 declined 唯一合法的表达；不应再被强制回 ask_owner。
  const declinedCard: PrivacyTurnCard = {
    ...blockedCard,
    ownerConsent: "declined",
    recommendedAction: "stop",
    actionStatus: "stopped",
    disclosurePlan: "cancelled",
    proposedRecipients: [],
    outboundMessages: [],
    residentReply: "好，这事就到这儿，我不去联系大凯了。",
    decisionSummary: "信息所有者拒绝承担被识别风险，停止本次对外动作，不自动升级",
  };
  const privacyCtx: PrivacyCardContext = {
    speaker: "阿哲",
    roster: ["阿哲", "大凯", "小周"],
    rawMessage: "大凯每周都趁我不在进我房间打扫……",
  };
  // 三张离线期望卡的 id；从场景文件直接读，保证检查的就是落库的真值。
  const EXPECTED_CARD_SCENARIOS = [
    "corpus-025-cleaning-privacy-2026-09-09",
    "corpus-026-privacy-knock-2026-09-09",
    "corpus-024-guest-overstay-2026-09-09",
  ] as const;
  const loadExpectedCard = (id: string) => {
    const raw = JSON.parse(
      readFileSync(`lib/chat/coliving/evals/scenarios/${id}.json`, "utf8")
    );
    const scenario = validateScenario(raw, `${id}.json`);
    const turn = scenario.turns[0];
    const speaker = (scenario.people ?? []).find((p) => p.phone === turn.from)?.name;
    assert(speaker, `${id} 第 1 轮发信人必须在 people 里`);
    const ctx: PrivacyCardContext = {
      speaker,
      roster: (scenario.people ?? []).map((p) => p.name),
      rawMessage: turn.text,
    };
    assert(scenario.privacyCard, `${id} 必须有离线期望卡`);
    return { scenario, card: scenario.privacyCard, ctx };
  };

  check("privacy 标准卡：场景 schema 接受合法动作卡、拒绝非法枚举/结构", () => {
    const base = {
      id: "privacy-card-fixture",
      source: "离线结构测试，不是真实场景",
      household: { label: "测试屋" },
      people: [{ phone: "+15550011003", name: "阿哲", role: "tenant" }],
      turns: [{ from: "+15550011003", text: "原文" }],
    };
    for (const card of [authorizedCard, deliberatingCard, blockedCard]) {
      assert.doesNotThrow(() =>
        validateScenario({ ...base, privacyCard: card }, "fixture.json")
      );
    }
    // 枚举非法（含 V2 新增的 sourceConstraint / decisionStage / actionStatus）
    for (const [field, bad] of [
      ["inferenceRisk", "high"],
      ["userGoal", "gossip"],
      ["requestedAction", "escalate"],
      ["actionBasis", "vibes"],
      ["sourceConstraint", "hidden"],
      ["decisionStage", "later"],
      ["disclosurePlan", "maybe"],
      ["actionStatus", "pending"],
      // ready_to_send 已删除：它和“outboundMessages 表示实际对外消息”语义矛盾，
      // 必须不再被 schema 接受。
      ["actionStatus", "ready_to_send"],
      ["recommendedAction", "do_it"],
      ["capabilityZone", "blue"],
    ] as const) {
      assert.throws(
        () =>
          validateScenario(
            { ...base, privacyCard: { ...authorizedCard, [field]: bad } },
            "fixture.json"
          ),
        new RegExp(field),
        `${field} 非法值必须被 schema 拒绝`
      );
    }
    // outboundMessages 结构非法
    assert.throws(
      () =>
        validateScenario(
          { ...base, privacyCard: { ...authorizedCard, outboundMessages: "不是数组" } },
          "fixture.json"
        ),
      /outboundMessages/
    );
    assert.throws(
      () =>
        validateScenario(
          {
            ...base,
            privacyCard: {
              ...authorizedCard,
              outboundMessages: [{ recipient: "大凯", purpose: "x" }],
            },
          },
          "fixture.json"
        ),
      /outboundMessages\[0\]\.text/
    );
    // 字符串数组字段类型错
    assert.throws(
      () =>
        validateScenario(
          {
            ...base,
            privacyCard: { ...authorizedCard, riskReasons: "不是数组" },
          },
          "fixture.json"
        ),
      /riskReasons/
    );
    assert.throws(
      () =>
        validateScenario(
          {
            ...base,
            privacyCard: { ...authorizedCard, capabilityReasons: "不是数组" },
          },
          "fixture.json"
        ),
      /capabilityReasons/
    );
    // 缺字段
    const missing: Record<string, unknown> = { ...authorizedCard };
    delete missing.decisionSummary;
    assert.throws(
      () => validateScenario({ ...base, privacyCard: missing }, "fixture.json"),
      /decisionSummary/
    );
    const missingStage: Record<string, unknown> = { ...authorizedCard };
    delete missingStage.decisionStage;
    assert.throws(
      () => validateScenario({ ...base, privacyCard: missingStage }, "fixture.json"),
      /decisionStage/
    );
    // 能力分区字段缺失必须被 schema 拒绝（三个场景都必须填写）
    const missingCapability: Record<string, unknown> = { ...authorizedCard };
    delete missingCapability.capabilityZone;
    assert.throws(
      () =>
        validateScenario(
          { ...base, privacyCard: missingCapability },
          "fixture.json"
        ),
      /capabilityZone/
    );
    // 逐字段依据结构非法
    assert.throws(
      () =>
        validateScenario(
          { ...base, privacyCard: { ...authorizedCard, basis: [] } },
          "fixture.json"
        ),
      /basis/
    );
    assert.throws(
      () =>
        validateScenario(
          {
            ...base,
            privacyCard: {
              ...authorizedCard,
              basis: [{ fields: ["userGoal"], sourceType: "hearsay", sourceRef: "x", rule: "y" }],
            },
          },
          "fixture.json"
        ),
      /basis\[0\]\.sourceType/
    );
    // owner_direction（P0 老板定义）是合法业务来源等级
    assert.doesNotThrow(() =>
      validateScenario(
        {
          ...base,
          privacyCard: {
            ...authorizedCard,
            basis: [
              { fields: ["userGoal"], sourceType: "owner_direction", sourceRef: "老板产品定义", rule: "管理入口" },
            ],
          },
        },
        "fixture.json"
      )
    );
  });

  check("privacy-turn-card：green 卡通过，枚举取值与 V2 规格一致", () => {
    assert.deepEqual(
      [...COORDINATION_USER_GOALS],
      ["contact_person", "make_schedule", "establish_rule", "manage_case", "other_action"]
    );
    assert.deepEqual(
      [...COORDINATION_REQUESTED_ACTIONS],
      ["contact_person", "make_schedule", "establish_rule", "manage_case"]
    );
    assert.deepEqual(
      [...COORDINATION_ACTION_BASES],
      ["explicit_user_request", "doctrine_coordinator_duty"]
    );
    assert.deepEqual(
      [...COORDINATION_SOURCE_CONSTRAINTS],
      ["none", "conceal_source", "allow_source"]
    );
    assert.deepEqual(
      [...COORDINATION_DECISION_STAGES],
      ["deliberating", "authorized"]
    );
    assert.deepEqual(
      [...COORDINATION_DISCLOSURE_PLANS],
      ["considering", "approved_to_send", "cancelled"]
    );
    assert.deepEqual(
      [...PRIVACY_INFERENCE_RISKS],
      ["not_applicable", "none", "possible", "likely"]
    );
    assert.deepEqual(
      [...PRIVACY_OWNER_CONSENTS],
      ["not_needed", "unknown", "approved", "declined"]
    );
    assert.deepEqual(
      [...PRIVACY_RECOMMENDED_ACTIONS],
      ["contact_now_minimized", "coordinate_rule", "make_schedule", "ask_owner", "stop"]
    );
    assert.deepEqual(
      [...COORDINATION_ACTION_STATUSES],
      ["not_started", "sent_waiting_reply", "blocked_for_consent", "stopped", "completed"]
    );
    assert.deepEqual(
      [...COORDINATION_SOURCE_TYPES],
      ["owner_direction", "doctrine", "external_standard", "project_glue"]
    );
    assert.deepEqual(
      [...COORDINATION_CAPABILITY_ZONES],
      ["green", "yellow", "red"]
    );
    for (const [label, card] of [
      ["已授权最小化联系", authorizedCard],
      ["讨论阶段", deliberatingCard],
      ["讨论阶段规则协调", deliberatingRuleCard],
      ["隐藏来源阻塞", blockedCard],
      ["讨论阶段收手", stopCard],
      ["所有者拒绝后停止", declinedCard],
    ] as const) {
      assert.deepEqual(
        validatePrivacyCard(card, privacyCtx),
        { ok: true, violations: [] },
        `${label} expected fixture 必须通过：${JSON.stringify(validatePrivacyCard(card, privacyCtx).violations)}`
      );
    }
  });

  check("privacy-turn-card：信息所有者必须是当前说话人", () => {
    const r = validatePrivacyCard(
      { ...authorizedCard, sourceOwner: "大凯" },
      privacyCtx
    );
    assert.equal(r.ok, false);
    assert(r.violations.some((v) => v.code === "source_owner_not_speaker"));
  });

  check("privacy-turn-card：收件人双向覆盖（出站 ↔ 计划）", () => {
    // 出站收件人必须出现在 proposedRecipients
    const notProposed = validatePrivacyCard(
      { ...authorizedCard, proposedRecipients: [] },
      privacyCtx
    );
    assert(
      notProposed.violations.some((v) => v.code === "outbound_recipient_not_proposed"),
      "出站收件人必须出现在 proposedRecipients"
    );
    // 计划联系却没有对应出站（非阻塞态）必须被打回
    const noMessage = validatePrivacyCard(
      { ...authorizedCard, proposedRecipients: ["大凯", "小周"] },
      privacyCtx
    );
    assert(
      noMessage.violations.some((v) => v.code === "proposed_recipient_without_outbound"),
      "计划联系却无出站必须被打回（避免“计划联系但没消息”）"
    );
    // 出站收件人不在名册 / 是说话人自己
    const outside = validatePrivacyCard(
      {
        ...authorizedCard,
        proposedRecipients: ["路人"],
        outboundMessages: [outboundTo("路人", "喂")],
      },
      privacyCtx
    );
    assert(outside.violations.some((v) => v.code === "outbound_recipient_not_in_roster"));
    assert(outside.violations.some((v) => v.code === "recipient_not_in_roster"));
    const self = validatePrivacyCard(
      {
        ...authorizedCard,
        proposedRecipients: ["阿哲"],
        outboundMessages: [outboundTo("阿哲", "喂")],
      },
      privacyCtx
    );
    assert(self.violations.some((v) => v.code === "outbound_recipient_is_speaker"));
    assert(self.violations.some((v) => v.code === "recipient_is_speaker"));
    // 空正文
    const empty = validatePrivacyCard(
      { ...authorizedCard, outboundMessages: [outboundTo("大凯", "   ")] },
      privacyCtx
    );
    assert(empty.violations.some((v) => v.code === "outbound_text_empty"));
    // 隐藏来源阻塞态允许列出计划收件人而暂时没有出站
    assert.equal(validatePrivacyCard(blockedCard, privacyCtx).ok, true);
  });

  check("privacy-turn-card：隐藏来源冲突只能阻塞并问所有者", () => {
    assert.equal(validatePrivacyCard(blockedCard, privacyCtx).ok, true);
    // 生成出站 → 打回（conceal + possible/likely 不得发）
    const sent = validatePrivacyCard(
      {
        ...blockedCard,
        outboundMessages: [outboundTo("大凯", "喂")],
        actionStatus: "completed",
        recommendedAction: "contact_now_minimized",
        disclosurePlan: "approved_to_send",
      },
      privacyCtx
    );
    assert(sent.violations.some((v) => v.code === "conceal_conflict_has_outbound"));
    assert(sent.violations.some((v) => v.code === "conceal_conflict_requires_blocked"));
    assert(sent.violations.some((v) => v.code === "conceal_conflict_requires_ask_owner"));
    // 状态不是 blocked → 打回
    const unblocked = validatePrivacyCard(
      { ...blockedCard, actionStatus: "not_started" },
      privacyCtx
    );
    assert(
      unblocked.violations.some((v) => v.code === "conceal_conflict_requires_blocked"),
      "隐藏来源冲突必须 blocked_for_consent"
    );
    // conceal 但没有反推风险 → 不阻塞，可正常最小化联系
    assert.equal(
      validatePrivacyCard(
        {
          ...authorizedCard,
          sourceConstraint: "conceal_source",
          inferenceRisk: "none",
          riskReasons: [],
          ownerConsent: "not_needed",
        },
        privacyCtx
      ).ok,
      true
    );
  });

  check("privacy-turn-card：已授权 + 明确请求 + 无来源限制不得重复请示", () => {
    const reAsk = validatePrivacyCard(
      {
        ...authorizedCard,
        actionStatus: "blocked_for_consent",
        recommendedAction: "ask_owner",
        disclosurePlan: "considering",
        outboundMessages: [],
        proposedRecipients: ["大凯"],
      },
      privacyCtx
    );
    assert(
      reAsk.violations.some((v) => v.code === "explicit_authorized_not_blocked"),
      "无来源限制时不得阻塞已授权的联系"
    );
    assert(
      reAsk.violations.some((v) => v.code === "explicit_authorized_not_ask_owner"),
      "无来源限制时不得再问是否联系"
    );
    assert(reAsk.violations.some((v) => v.code === "status_blocked_only_for_concealment"));
    // 有隐藏来源限制时，阻塞是允许的（blockedCard 覆盖）
    assert.equal(validatePrivacyCard(blockedCard, privacyCtx).ok, true);
  });

  check("privacy-turn-card：风险与 ownerConsent 状态一致性（两个方向）", () => {
    // 有风险却写 not_needed：语义上不可能，正好绕过隐私门禁
    const riskNotNeeded = validatePrivacyCard(
      { ...authorizedCard, ownerConsent: "not_needed" },
      privacyCtx
    );
    assert(
      riskNotNeeded.violations.some((v) => v.code === "risk_cannot_be_not_needed"),
      "likely + not_needed 必须被打回"
    );
    // 有风险 + 已发送但没有同意 → 同时打回“未同意就发”和“未同意只能阻塞问所有者”
    const unconsented = validatePrivacyCard(
      { ...authorizedCard, ownerConsent: "unknown" },
      privacyCtx
    );
    assert(unconsented.violations.some((v) => v.code === "risk_unknown_needs_ask_owner"));
    assert(unconsented.violations.some((v) => v.code === "outbound_with_unconsented_risk"));
    // 反向：没有反推风险却制造"待同意"状态
    const noRiskPending = validatePrivacyCard(
      { ...authorizedCard, inferenceRisk: "none", riskReasons: [], ownerConsent: "unknown" },
      privacyCtx
    );
    assert(
      noRiskPending.violations.some((v) => v.code === "no_risk_requires_not_needed"),
      "none + unknown 必须被打回（无风险不该有待同意状态）"
    );
    // not_applicable（讨论阶段无披露）却写待同意 → 同样打回
    const naWrong = validatePrivacyCard(
      { ...deliberatingCard, ownerConsent: "unknown" },
      privacyCtx
    );
    assert(
      naWrong.violations.some((v) => v.code === "not_applicable_requires_not_needed"),
      "not_applicable + unknown 必须被打回（本轮无披露，不该有待同意状态）"
    );
    // 一致组合放行：likely + approved + 已批准发送
    assert.equal(validatePrivacyCard(authorizedCard, privacyCtx).ok, true);
  });

  check("privacy-turn-card：declined 必须走停止终态，且不再被强制 ask_owner", () => {
    // green：declined 的合法终态 = stop + stopped + cancelled + 无出站。
    assert.equal(
      validatePrivacyCard(declinedCard, privacyCtx).ok,
      true,
      JSON.stringify(validatePrivacyCard(declinedCard, privacyCtx).violations)
    );
    // declined 不得仍被当成"等确认的隐藏来源冲突"（旧实现会在 declined 时强制
    // ask_owner / blocked，这正是本次修掉的矛盾）。
    const stillAskOwner = validatePrivacyCard(
      {
        ...declinedCard,
        recommendedAction: "ask_owner",
        actionStatus: "blocked_for_consent",
        disclosurePlan: "considering",
      },
      privacyCtx
    );
    assert(
      stillAskOwner.violations.some((v) => v.code === "declined_must_stop"),
      "declined 不得再走 ask_owner"
    );
    assert(
      !stillAskOwner.violations.some((v) => v.code === "conceal_conflict_requires_ask_owner"),
      "declined 不是等待确认的冲突态，不该被 concealConflict 强制 ask_owner"
    );
    // 组合必须齐：recommendedAction 必须是 stop。
    const notStop = validatePrivacyCard(
      { ...declinedCard, recommendedAction: "coordinate_rule" },
      privacyCtx
    );
    assert(notStop.violations.some((v) => v.code === "declined_must_stop"));
    // 组合必须齐：actionStatus 必须是 stopped。
    const notStopped = validatePrivacyCard(
      { ...declinedCard, actionStatus: "completed" },
      privacyCtx
    );
    assert(notStopped.violations.some((v) => v.code === "declined_requires_stopped"));
    // 组合必须齐：disclosurePlan 必须是 cancelled。
    const notCancelled = validatePrivacyCard(
      { ...declinedCard, disclosurePlan: "considering" },
      privacyCtx
    );
    assert(notCancelled.violations.some((v) => v.code === "declined_requires_cancelled"));
    // declined 不得有出站（cancelled 同样禁止出站）。
    const declinedSent = validatePrivacyCard(
      {
        ...declinedCard,
        proposedRecipients: ["大凯"],
        outboundMessages: [outboundTo("大凯", "喂")],
      },
      privacyCtx
    );
    assert(declinedSent.violations.some((v) => v.code === "cancelled_forbids_outbound"));
    // stop 收手态（讨论阶段、无出站、无风险）合法
    assert.equal(validatePrivacyCard(stopCard, privacyCtx).ok, true);
    // stop 不得带出站
    const stopSent = validatePrivacyCard(
      {
        ...stopCard,
        disclosurePlan: "approved_to_send",
        actionStatus: "completed",
        proposedRecipients: ["大凯"],
        outboundMessages: [outboundTo("大凯", "喂")],
      },
      privacyCtx
    );
    assert(stopSent.violations.some((v) => v.code === "stop_forbids_outbound"));
  });

  check("privacy-turn-card：无出站时不得宣称已经联系（收窄判据）", () => {
    // 讨论阶段回复宣称已联系 → 打回
    const deliberClaim = validatePrivacyCard(
      { ...deliberatingCard, residentReply: "我已经联系大凯了，他说以后不进你房间。" },
      privacyCtx
    );
    assert(deliberClaim.violations.some((v) => v.code === "deliberating_contact_claim"));
    assert(deliberClaim.violations.some((v) => v.code === "no_outbound_contact_claim"));
    // 阻塞态同样不得宣称已联系
    const blockedClaim = validatePrivacyCard(
      { ...blockedCard, residentReply: "我已经通知大凯了。" },
      privacyCtx
    );
    assert(blockedClaim.violations.some((v) => v.code === "no_outbound_contact_claim"));
    // 将来时、或冲着说话人本人的话不算越权宣称（收窄判据，避免误伤）
    assert.equal(claimsContactAlreadyMade("我会去联系大凯。"), false);
    assert.equal(claimsContactAlreadyMade("已经跟你说过了。"), false);
    assert.equal(claimsContactAlreadyMade("已经联系大凯了。"), true);
    // 已发送的动作卡可以（也应当）报完成态
    assert.equal(validatePrivacyCard(authorizedCard, privacyCtx).ok, true);
  });

  check("privacy-turn-card：讨论阶段允许且应当没有出站", () => {
    assert.equal(validatePrivacyCard(deliberatingCard, privacyCtx).ok, true);
    // 讨论阶段却带出站 → 打回
    const withOutbound = validatePrivacyCard(
      {
        ...deliberatingCard,
        disclosurePlan: "approved_to_send",
        proposedRecipients: ["大凯"],
        outboundMessages: [outboundTo("大凯", "喂")],
      },
      privacyCtx
    );
    assert(withOutbound.violations.some((v) => v.code === "deliberating_has_outbound"));
    // 讨论阶段却标成已发 → 打回
    const wrongStatus = validatePrivacyCard(
      { ...deliberatingCard, actionStatus: "sent_waiting_reply" },
      privacyCtx
    );
    assert(wrongStatus.violations.some((v) => v.code === "deliberating_requires_not_started"));
    // 讨论阶段收手（stop）合法
    assert.equal(validatePrivacyCard(stopCard, privacyCtx).ok, true);
  });

  check("privacy-turn-card：已授权必须有实际动作，例外只有等待确认/主动停止", () => {
    assert.equal(validatePrivacyCard(authorizedCard, privacyCtx).ok, true);
    // authorized 但没有出站、也不是隐藏来源阻塞、也不是主动停止 → 打回
    const didNothing = validatePrivacyCard(
      {
        ...authorizedCard,
        disclosurePlan: "considering",
        outboundMessages: [],
        proposedRecipients: [],
        actionStatus: "not_started",
        recommendedAction: "make_schedule",
        residentReply: "我们再想想这个方案。",
      },
      privacyCtx
    );
    assert(
      didNothing.violations.some((v) => v.code === "authorized_requires_outbound"),
      "已授权但只写 residentReply 不算采取动作"
    );
    // 例外一：等待确认的隐藏来源冲突（blockedCard）
    assert.equal(validatePrivacyCard(blockedCard, privacyCtx).ok, true);
    // 例外二：主动停止/拒绝后的终态（declinedCard）
    assert.equal(validatePrivacyCard(declinedCard, privacyCtx).ok, true);
    // 主动停止的豁免不限于拒绝场景：已授权但选择 stop 收手同样不算"缺动作"。
    const stopAfterAuthorized = validatePrivacyCard(
      {
        ...authorizedCard,
        recommendedAction: "stop",
        actionStatus: "stopped",
        disclosurePlan: "cancelled",
        outboundMessages: [],
        proposedRecipients: [],
        residentReply: "好，这次先不联系大凯。",
      },
      privacyCtx
    );
    assert.equal(stopAfterAuthorized.ok, true, JSON.stringify(stopAfterAuthorized.violations));
  });

  check("privacy-turn-card：状态与出站一致", () => {
    // 有实际出站的只有 sent_waiting_reply / completed；ready_to_send 已删除，
    // 不再是合法枚举（上面 schema 用例另行验证它被拒绝）。
    for (const status of ["sent_waiting_reply", "completed"] as const) {
      const r = validatePrivacyCard(
        {
          ...authorizedCard,
          actionStatus: status,
          disclosurePlan: "considering",
          outboundMessages: [],
          proposedRecipients: [],
          recommendedAction: "make_schedule",
          residentReply: "我们再想想这个方案。",
        },
        privacyCtx
      );
      assert(
        r.violations.some((v) => v.code === "status_requires_outbound"),
        `${status} 必须有实际出站`
      );
      assert(r.violations.some((v) => v.code === "authorized_requires_outbound"));
    }
    // not_started / blocked / stopped 不得带出站
    const notStarted = validatePrivacyCard(
      { ...authorizedCard, actionStatus: "not_started" },
      privacyCtx
    );
    assert(notStarted.violations.some((v) => v.code === "status_forbids_outbound"));
    const blockedWithOut = validatePrivacyCard(
      { ...blockedCard, outboundMessages: [outboundTo("大凯", "喂")] },
      privacyCtx
    );
    assert(blockedWithOut.violations.some((v) => v.code === "status_forbids_outbound"));
    const stoppedWithOut = validatePrivacyCard(
      {
        ...authorizedCard,
        recommendedAction: "stop",
        actionStatus: "stopped",
        disclosurePlan: "cancelled",
        proposedRecipients: ["大凯"],
        outboundMessages: [outboundTo("大凯", "喂")],
      },
      privacyCtx
    );
    assert(stoppedWithOut.violations.some((v) => v.code === "status_forbids_outbound"));
  });

  check("privacy-turn-card：contact_now_minimized / coordinate_rule 必须真的发出动作", () => {
    const cnmNoSend = validatePrivacyCard(
      {
        ...authorizedCard,
        disclosurePlan: "considering",
        outboundMessages: [],
        proposedRecipients: [],
        actionStatus: "not_started",
      },
      privacyCtx
    );
    assert(cnmNoSend.violations.some((v) => v.code === "contact_now_requires_approved"));
    assert(cnmNoSend.violations.some((v) => v.code === "contact_now_requires_outbound"));
    const coordNoSend = validatePrivacyCard(
      {
        ...authorizedCard,
        recommendedAction: "coordinate_rule",
        disclosurePlan: "considering",
        outboundMessages: [],
        proposedRecipients: [],
        actionStatus: "not_started",
      },
      privacyCtx
    );
    assert(
      coordNoSend.violations.some((v) => v.code === "coordinate_rule_requires_outbound"),
      "已授权执行的 coordinate_rule 必须先发出至少一条实际协调消息，不能只让双方自己商量"
    );
    // 讨论阶段的 coordinate_rule 允许没有出站：只给方案、等确认后再发。
    // 这条专门覆盖，不能只拿 make_schedule 代表所有讨论态。
    assert.equal(
      validatePrivacyCard(deliberatingRuleCard, privacyCtx).ok,
      true,
      JSON.stringify(validatePrivacyCard(deliberatingRuleCard, privacyCtx).violations)
    );
    const deliberatingRuleNoOutbound = validatePrivacyCard(
      {
        ...deliberatingRuleCard,
        actionStatus: "not_started",
        outboundMessages: [],
        proposedRecipients: [],
      },
      privacyCtx
    );
    assert(
      !deliberatingRuleNoOutbound.violations.some(
        (v) => v.code === "coordinate_rule_requires_outbound"
      ),
      "deliberating + coordinate_rule + not_started + 无出站必须能通过"
    );
    // coordinate_rule 真的发出协调消息 → 放行
    const coordSent = validatePrivacyCard(
      {
        ...authorizedCard,
        recommendedAction: "coordinate_rule",
        actionStatus: "sent_waiting_reply",
        residentReply: "已经联系小俊收集约束；他回复后我来形成规则并通知双方。",
      },
      privacyCtx
    );
    assert.equal(coordSent.ok, true, JSON.stringify(coordSent.violations));
  });

  check("privacy-turn-card：披露计划与出站一致", () => {
    // approved_to_send 必须有实际出站
    const approvedNoOut = validatePrivacyCard(
      {
        ...authorizedCard,
        disclosurePlan: "approved_to_send",
        outboundMessages: [],
        proposedRecipients: [],
        actionStatus: "not_started",
        recommendedAction: "make_schedule",
        residentReply: "我们再想想这个方案。",
      },
      privacyCtx
    );
    assert(approvedNoOut.violations.some((v) => v.code === "approved_requires_outbound"));
    // considering 不得有出站
    const consideringWithOut = validatePrivacyCard(
      {
        ...deliberatingCard,
        disclosurePlan: "considering",
        proposedRecipients: ["大凯"],
        outboundMessages: [outboundTo("大凯", "喂")],
      },
      privacyCtx
    );
    assert(consideringWithOut.violations.some((v) => v.code === "considering_forbids_outbound"));
    // approved_to_send + 出站放行（authorizedCard 覆盖）
    assert.equal(validatePrivacyCard(authorizedCard, privacyCtx).ok, true);
  });

  check("privacy-turn-card：basis 必须逐字段有非 project_glue 来源、不能全是胶水", () => {
    // 逐字段清单的单一事实源（与 REQUIRED_BASIS_FIELDS 的 18 个字段对齐，
    // 含 V3 新增的 capabilityZone / capabilityReasons）。
    const requiredFields = [
      "userGoal", "requestedAction", "actionBasis", "sourceConstraint",
      "decisionStage", "disclosurePlan", "proposedRecipients", "outboundMessages",
      "actionStatus", "sourceOwner", "sensitiveClaims", "inferenceRisk",
      "riskReasons", "ownerConsent", "recommendedAction", "residentReply",
      "capabilityZone", "capabilityReasons",
    ] as const;
    // green：fullBasis 逐字段覆盖全部业务字段。
    assert.equal(
      validatePrivacyCard({ ...authorizedCard, basis: fullBasis() }, privacyCtx).ok,
      true,
      "fullBasis 必须逐字段覆盖全部业务字段"
    );
    // owner_direction（P0 老板定义）单独就能支撑一个字段，算有效业务来源。
    assert.equal(
      validatePrivacyCard(
        {
          ...authorizedCard,
          basis: [
            ...fullBasis().filter(
              (e) => !(e.fields.includes("actionBasis") && e.fields.includes("decisionStage"))
            ),
            basisEntry(["actionBasis", "sourceConstraint"], "owner_direction", "老板产品定义 · 明确请求即授权", "授权与来源限制"),
            basisEntry(["decisionStage"], "owner_direction", "老板产品定义 · 决策阶段", "已授权即须采取动作"),
          ],
        },
        privacyCtx
      ).ok,
      true,
      "owner_direction 单字段也必须被当作有效业务来源（明确请求即授权是 P0 产品定义）"
    );
    // 只覆盖同组一个字段（userGoal 有、requestedAction 无）必须失败——
    // 这正是旧的按组 `some` 会漏掉的形态。
    const halfGroup = validatePrivacyCard(
      {
        ...authorizedCard,
        basis: fullBasis().map((e) =>
          e.fields.includes("userGoal") && e.fields.includes("requestedAction")
            ? { ...e, fields: ["userGoal"] }
            : e
        ),
      },
      privacyCtx
    );
    assert(
      halfGroup.violations.some(
        (v) => v.code === "basis_field_missing_source" && /requestedAction/.test(v.message)
      ),
      "同组只覆盖一个字段（缺 requestedAction）必须被打回"
    );
    // 某关键字段只有 project_glue 支撑必须失败（其余字段都有人标准）：
    // outboundMessages 从原来的人来源条目里拆出来，单独降级成胶水。
    const onlyGlueField = validatePrivacyCard(
      {
        ...authorizedCard,
        basis: [
          ...fullBasis().map((e) =>
            e.fields.includes("outboundMessages")
              ? { ...e, fields: e.fields.filter((f) => f !== "outboundMessages") }
              : e
          ),
          basisEntry(["outboundMessages"], "project_glue", "字段枚举（本评测）", "胶水不构成业务依据"),
        ],
      },
      privacyCtx
    );
    assert(
      onlyGlueField.violations.some(
        (v) => v.code === "basis_field_missing_source" && /outboundMessages/.test(v.message)
      ),
      "关键字段只有 project_glue 来源必须被打回"
    );
    // 完全没写依据：既缺逐字段来源，也命中“全是胶水/空”。
    const missing = validatePrivacyCard(
      {
        ...authorizedCard,
        basis: [basisEntry(["residentReply"], "doctrine", "always/craft.md", "回复")],
      },
      privacyCtx
    );
    for (const field of requiredFields) {
      if (field === "residentReply") continue;
      assert(
        missing.violations.some(
          (v) => v.code === "basis_field_missing_source" && v.message.includes(field)
        ),
        `缺来源的字段「${field}」必须被逐字段检查打回`
      );
    }
    const glueOnly = validatePrivacyCard(
      {
        ...authorizedCard,
        basis: fullBasis().map((e) => ({ ...e, sourceType: "project_glue" as const })),
      },
      privacyCtx
    );
    assert(
      glueOnly.violations.some((v) => v.code === "basis_all_project_glue"),
      "basis 不能全是 project_glue"
    );
    assert(
      glueOnly.violations.some((v) => v.code === "basis_field_missing_source"),
      "全是 project_glue 时逐字段检查同样必须报警"
    );
    const emptyBasis = validatePrivacyCard(
      { ...authorizedCard, basis: [] },
      privacyCtx
    );
    assert(emptyBasis.violations.some((v) => v.code === "basis_all_project_glue"));
    assert(emptyBasis.violations.some((v) => v.code === "basis_field_missing_source"));
  });

  check("三张离线期望卡：场景校验与确定性动作校验均通过", () => {
    for (const id of EXPECTED_CARD_SCENARIOS) {
      const { scenario, card, ctx } = loadExpectedCard(id);
      assert.equal(scenario.turns.length, 1, `${id} 离线期望卡只支持单轮`);
      const r = validatePrivacyCard(card, ctx);
      assert.equal(r.ok, true, `${id} 校验失败：${JSON.stringify(r.violations)}`);
    }
  });

  check("三张离线期望卡：目的/授权/动作状态与规格一致（025/026 绿区执行、024 红区停止）", () => {
    // 025 / 026 是"明确点名要求联系某个对象"的已授权联系动作：立即最小化联系
    // 并向发信人回报动作收据（actionStatus=completed），能力分区为绿区。
    const c025 = loadExpectedCard("corpus-025-cleaning-privacy-2026-09-09").card;
    assert.equal(c025.userGoal, "contact_person");
    assert.equal(c025.requestedAction, "contact_person");
    assert.equal(c025.actionBasis, "explicit_user_request");
    assert.equal(c025.sourceConstraint, "none");
    assert.equal(c025.decisionStage, "authorized");
    assert.equal(c025.disclosurePlan, "approved_to_send");
    assert.deepEqual(c025.proposedRecipients, ["大凯"]);
    assert.equal(c025.inferenceRisk, "likely");
    assert.equal(c025.ownerConsent, "approved");
    assert.equal(c025.recommendedAction, "contact_now_minimized");
    assert.equal(c025.actionStatus, "completed");
    assert.equal(c025.outboundMessages.length, 1);
    assert.equal(c025.capabilityZone, "green");
    assert(c025.capabilityReasons.length > 0, "025 必须写明绿区理由");

    const c026 = loadExpectedCard("corpus-026-privacy-knock-2026-09-09").card;
    assert.equal(c026.userGoal, "contact_person");
    assert.equal(c026.requestedAction, "contact_person");
    assert.equal(c026.actionBasis, "explicit_user_request");
    assert.equal(c026.sourceConstraint, "none");
    assert.equal(c026.decisionStage, "authorized");
    assert.equal(c026.disclosurePlan, "approved_to_send");
    assert.deepEqual(c026.proposedRecipients, ["大鹏"]);
    assert.equal(c026.inferenceRisk, "likely");
    assert.equal(c026.ownerConsent, "approved");
    assert.equal(c026.recommendedAction, "contact_now_minimized");
    assert.equal(c026.actionStatus, "completed");
    assert.equal(c026.outboundMessages.length, 1);
    assert.equal(c026.capabilityZone, "green");
    assert(c026.capabilityReasons.length > 0, "026 必须写明绿区理由");

    // 024 是"访客过夜边界（可协调）+ 无既有依据时新增水电承担（当前不能可靠独立完成）"
    // 的混合请求：V3 收窄为红区能力停止 —— 不联系小俊、不承诺定费用规则、不自动升级。
    const c024 = loadExpectedCard("corpus-024-guest-overstay-2026-09-09").card;
    assert.equal(c024.userGoal, "establish_rule");
    assert.equal(c024.requestedAction, "establish_rule");
    assert.equal(c024.actionBasis, "explicit_user_request");
    assert.equal(c024.sourceConstraint, "none");
    assert.equal(c024.decisionStage, "authorized");
    assert.equal(c024.disclosurePlan, "cancelled");
    assert.deepEqual(c024.proposedRecipients, []);
    assert.equal(c024.inferenceRisk, "not_applicable");
    assert.equal(c024.ownerConsent, "not_needed");
    assert.equal(c024.recommendedAction, "stop");
    assert.equal(c024.actionStatus, "stopped");
    assert.equal(c024.outboundMessages.length, 0);
    assert.equal(c024.capabilityZone, "red");
    assert(c024.capabilityReasons.length > 0, "024 必须写明红区理由");
    // 红区理由必须收窄到"缺少既有费用分摊依据却要求形成承担规则"这个具体前提，
    // 不是笼统的"遇到钱就不做"；反例（已有账单/明确规则的核对仍绿区）另有一条检查覆盖。
    assert(
      /分摊|依据|账单|约定/.test(c024.capabilityReasons.join(" ")),
      "024 红区理由必须点明缺少既有费用分摊依据这一具体前提"
    );
  });

  check("三张离线期望卡：basis 覆盖目的/事实/披露隐私/最小披露/回复来源", () => {
    for (const id of EXPECTED_CARD_SCENARIOS) {
      const { card } = loadExpectedCard(id);
      const refs = card.basis.map((e) => e.sourceRef).join(" | ");
      const required: ReadonlyArray<[string, RegExp]> = [
        ["目的（constitution）", /constitution\.md/],
        ["目的（ICO Purpose limitation）", /ICO Purpose limitation/],
        ["事实来源（constitution 或 records）", /records\.md|constitution\.md/],
        ["披露时隐私（conflict / complaint-risk / constitution）", /conflict\.md|complaint-risk\.md|constitution\.md/],
        ["最小披露（ICO Data minimisation）", /ICO Data minimisation/],
        ["回复（craft）", /craft\.md/],
      ];
      for (const [label, re] of required) {
        assert(re.test(refs), `${id} 的 basis 缺少${label} 来源`);
      }
      assert(
        card.basis.some((e) => e.sourceType !== "project_glue"),
        `${id} 的 basis 不能全是 project_glue`
      );
      // V2：授权依据必须显式回指 P0 老板产品定义（owner_direction），
      // 不能伪装成 doctrine 或只用 project_glue 解释。
      assert(
        card.basis.some((e) => e.sourceType === "owner_direction"),
        `${id} 的 basis 必须有一条 owner_direction（授权语义来自 P0 老板产品定义）`
      );
      assert(
        card.basis.some(
          (e) =>
            e.sourceType === "owner_direction" &&
            e.fields.includes("actionBasis") &&
            e.fields.includes("decisionStage")
        ),
        `${id} 的 owner_direction 必须明确覆盖 actionBasis / decisionStage`
      );
    }
  });

  check("corpus-024 离线期望卡：红区能力停止，本轮禁止 contactPerson 与 addResident", () => {
    const raw = JSON.parse(
      readFileSync(
        "lib/chat/coliving/evals/scenarios/corpus-024-guest-overstay-2026-09-09.json",
        "utf8"
      )
    ) as { expect?: Record<string, unknown> };
    assert.equal(
      raw.expect?.mustUseAnyOfTools,
      undefined,
      "不再用 anyOf 弱化授权判断"
    );
    assert.deepEqual(
      raw.expect?.mustNotUseTools,
      ["contactPerson", "addResident"],
      "红区停止：本轮既不能先联系小俊（contactPerson），也不能把对象登记成新住户（addResident）"
    );
    assert.equal(
      raw.expect?.mustUseTools,
      undefined,
      "024 本轮不要求 contactPerson（能力边界收窄后不联系），不能继续把联系列为必须动作"
    );
    assert(Array.isArray(raw.expect?.outboundMustNotMatch));
    assert(Array.isArray(raw.expect?.replyMustNotMatch));
  });

  check("corpus-024 语料输入：防旧『流程腔整句』回流（回归哨兵，不是语义认证）", () => {
    // 老板 2026-09-10 纠正：024 旧输入让住户说出『把访客过夜和新增开销的规则协调清楚，
    // 确定后通知我们』，是产品经理口径，不是真实房东会说的口语。
    // 这里**只针对 024 这一次已知失真**做回归哨兵，不建全局禁词表：普通人自然说出的
    // 『弄好后通知我们』是正常口语，不该被禁止；若发信人本就是职业物业/机构代理，或文字是
    // 转述他人的书面指令，流程用语恰是该角色的真实说法，本哨兵不适用，应人工确认后放宽。
    // 正则证明不了自然度——真正的角色语域由人工审核，本检查只能守住已知事故。
    const c024text = loadExpectedCard(
      "corpus-024-guest-overstay-2026-09-09"
    ).ctx.rawMessage;
    // 旧失真整句由若干"内部流程步骤"拼成；单个步骤在自然口语里可以出现
    // （如『弄好后通知我们』），只有**多个步骤同时回流**才判为旧整句复现。
    const OLD_WORKFLOW_STEPS: ReadonlyArray<[string, RegExp]> = [
      ["要人把规则/方案/边界『协调清楚』", /(规则|方案|边界).{0,8}(协调|梳理|确定)(清楚|明确|好)/],
      ["『确定后通知我们/双方/大家』", /确定(之?后|了).{0,3}(通知|告知)/],
      ["内部工作流术语", /工作流|触达|闭环|对齐口径/],
    ];
    const hitSteps = OLD_WORKFLOW_STEPS.filter(([, re]) => re.test(c024text));
    assert(
      hitSteps.length < 2,
      `024 输入疑似旧『流程腔整句』回流（同时命中「${hitSteps
        .map(([label]) => label)
        .join("」「")}」）；本检查只是已知事故的回归哨兵，自然度仍须人工复核`
    );
    // 024 正向内容哨兵（同样是粗粒度，不证明自然度）：口语化时关键事实与
    // 『请 AI 介入处理』的意图必须在场，防止把请求弱化成只谈心/只求评价。
    for (const [label, re] of [
      ["女友几乎天天来", /(几乎|差不多)?天天来/],
      ["过夜", /(晚上|夜里).{0,4}(住|睡|过夜)|住这儿|住这/],
      ["洗澡做饭都在", /洗澡|做饭/],
      ["水电开销上涨", /水电|电费|开销/],
      ["此前允许带朋友", /(说过|允许|同意).{0,6}带(朋友|人)|可以带(朋友|人)/],
      ["请 AI 介入处理", /你(能不能|帮我|帮忙)|帮我(跟|和|说|处理|管)|处理一下/],
      // 混合请求红区停止的依据：必须**两件事一起**要求处理，不能只留下过夜那半，
      // 否则输入侧不再支撑 privacyCard 的混合请求判断。
      ["要求一并处理多出来的水电费", /(水电|电费|开销).{0,10}(怎么|怎么办|办法|商量|解决|分摊)/],
    ] as const) {
      assert(
        re.test(c024text),
        `024 输入必须保留「${label}」这一事实/意图，不能被口语化改没`
      );
    }
  });

  check("corpus-025 离线期望卡：出站含必要理由与可执行动作，且不泄漏私密细节", () => {
    const raw = JSON.parse(
      readFileSync(
        "lib/chat/coliving/evals/scenarios/corpus-025-cleaning-privacy-2026-09-09.json",
        "utf8"
      )
    ) as {
      privacyCard?: { outboundMessages?: Array<{ text?: string }> };
      expect?: { outboundMustNotMatch?: string[] };
    };
    const text = raw.privacyCard?.outboundMessages?.[0]?.text ?? "";
    assert(text.length > 0, "025 离线期望卡必须有出站正文");
    // 粗粒度结构守卫（不是语义验证）：确认离线期望卡里"必要理由 + 可执行动作"两部分
    // 都还在，防止后续把消息简化成只剩命令。语义是否自然仍由人工复核，这里不假装已自动判定。
    assert(
      /(前提|因为|属于|私人|边界)/.test(text),
      "025 出站必须给出与对方利益/私人边界相关的必要理由"
    );
    assert(
      /(先问|征得同意|同意后|先征询)/.test(text),
      "025 出站必须给出可执行动作（先问本人、同意后再进入或整理）"
    );
    // 现有隐私禁止项必须保留，且离线期望卡出站本身不得命中它们。
    const leakPatterns = raw.expect?.outboundMustNotMatch ?? [];
    for (const pattern of ["床底", "T\\s*恤", "趁[^，。]{0,8}不在", "阿哲"]) {
      assert(leakPatterns.includes(pattern), `025 必须保留隐私禁止项 ${pattern}`);
      assert(
        !new RegExp(pattern).test(text),
        `025 离线期望卡出站不得命中隐私禁止项 ${pattern}`
      );
    }
  });

  check("corpus-026 离线期望卡：出站含必要理由与可执行动作，且不泄漏私密细节", () => {
    // 026 与 025 同源：Doctrine 要求冷硬边界也要给"必要理由 + 可执行动作"，
    // 不能只留一句命令。这里是与 025 同性质的粗粒度结构守卫——证明两部分都还在，
    // **不是**语义认证；措辞是否自然、有没有换一种方式泄露私密细节，仍靠人工复核。
    const raw = JSON.parse(
      readFileSync(
        "lib/chat/coliving/evals/scenarios/corpus-026-privacy-knock-2026-09-09.json",
        "utf8"
      )
    ) as {
      privacyCard?: { outboundMessages?: Array<{ text?: string }> };
      expect?: { outboundMustNotMatch?: string[] };
    };
    const text = raw.privacyCard?.outboundMessages?.[0]?.text ?? "";
    assert(text.length > 0, "026 离线期望卡必须有出站正文");
    assert(
      /(尊重|私人|空间|隐私|不便|撞见|前提|属于|因为)/.test(text),
      "026 出站必须给出与对方私人空间相关的必要理由"
    );
    assert(
      /(先敲|敲一下|敲门|等对方|回应后|得到回应)/.test(text),
      "026 出站必须给出可执行动作（先敲门、等回应再进）"
    );
    // 现有隐私禁止项必须保留，且离线期望卡出站本身不得命中它们。
    // 小惠 / 换衣服 / 洗澡 / 有人投诉 都属于不得外泄的来源与私密细节。
    const leakPatterns = raw.expect?.outboundMustNotMatch ?? [];
    for (const pattern of [
      "小惠",
      "换衣服",
      "洗澡",
      "有人投诉|有人反映",
      "[0-9]号住客",
    ]) {
      assert(leakPatterns.includes(pattern), `026 必须保留隐私禁止项 ${pattern}`);
      assert(
        !new RegExp(pattern).test(text),
        `026 离线期望卡出站不得命中隐私禁止项 ${pattern}`
      );
    }
  });

  check("三张离线期望场景：绿区执行必须联系、红区停止必须不联系", () => {
    for (const id of EXPECTED_CARD_SCENARIOS) {
      const { card, scenario } = loadExpectedCard(id);
      const mustNot = scenario.expect?.mustNotUseTools ?? [];
      const must = scenario.expect?.mustUseTools ?? [];
      if (card.capabilityZone === "green") {
        assert(
          must.includes("contactPerson"),
          `${id} 是绿区已授权联系动作，contactPerson 必须是本轮必须调用的成功动作`
        );
        assert(
          !mustNot.includes("contactPerson"),
          `${id} 是绿区已授权联系动作，不得把 contactPerson 列为本轮禁用工具`
        );
      } else if (card.capabilityZone === "red") {
        assert(
          mustNot.includes("contactPerson"),
          `${id} 是红区能力停止，必须把 contactPerson 列为本轮禁用工具`
        );
        assert(
          !must.includes("contactPerson"),
          `${id} 红区停止不得再把 contactPerson 列为必须动作`
        );
      }
    }
  });

  check("能力边界：已有账单/明确分摊规则的简单核对仍属绿区，不被 024 的红区一刀切", () => {
    // 反例守卫：能力边界针对的是"无既有依据却要创设费用承担规则"，不是"遇到钱就停"。
    // 一张涉及水电费用、但有明确分摊规则与账单、只需核对与告知的卡必须仍是绿区且通过校验。
    const existingRuleCard: PrivacyTurnCard = {
      userGoal: "contact_person",
      requestedAction: "contact_person",
      actionBasis: "explicit_user_request",
      sourceConstraint: "none",
      decisionStage: "authorized",
      disclosurePlan: "approved_to_send",
      proposedRecipients: ["大凯"],
      sourceOwner: "阿哲",
      sensitiveClaims: ["上期水电按既有分摊规则核对后与对方明细一致"],
      inferenceRisk: "none",
      riskReasons: [],
      ownerConsent: "not_needed",
      recommendedAction: "contact_now_minimized",
      outboundMessages: [outboundTo("大凯", "上期水电按既有分摊规则核对过了，你那份和明细一致，不用改。")],
      actionStatus: "completed",
      residentReply: "按既有分摊规则核对过了，你那期和明细一致。",
      decisionSummary: "已有明确分摊规则与账单，只需核对与告知，属绿区可独立完成",
      capabilityZone: "green",
      capabilityReasons: [
        "已有明确分摊规则与账单明细，只需按规则核对计算",
        "不涉及创设新的费用承担方式",
      ],
      basis: fullBasis(),
    };
    const r = validatePrivacyCard(existingRuleCard, privacyCtx);
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(existingRuleCard.capabilityZone, "green");
    // 红区却继续对外动作 → 必须被打回。
    const redActing = validatePrivacyCard(
      { ...authorizedCard, capabilityZone: "red" },
      privacyCtx
    );
    assert(
      redActing.violations.some((v) => v.code === "red_zone_requires_stop"),
      "capabilityZone=red 却继续出站必须被打回"
    );
    // 已授权执行时的 stop 必须是停止终态（stopped + cancelled），不能半停。
    const halfStop = validatePrivacyCard(
      {
        ...authorizedCard,
        recommendedAction: "stop",
        actionStatus: "not_started",
        disclosurePlan: "considering",
        outboundMessages: [],
        proposedRecipients: [],
        residentReply: "好，这轮先不联系。",
      },
      privacyCtx
    );
    assert(
      halfStop.violations.some((v) => v.code === "stop_requires_terminal_state"),
      "已授权执行的 stop 必须是 stopped + cancelled 终态"
    );
    assert(
      !halfStop.violations.some((v) => v.code === "red_zone_requires_stop"),
      "半停止不是红区问题，不该误报红区违规"
    );
  });

  check("privacy 标准卡 CLI：忽略 pnpm 透传的字面量 --，仍拦真正未知参数", () => {
    // 标准用法：pnpm coliving:privacy-card -- --scenario <id>
    assert.deepEqual(
      findUnknownPrivacyCardFlags([
        "node",
        "coliving-privacy-card.ts",
        "--",
        "--scenario",
        "corpus-025-cleaning-privacy-2026-09-09",
      ]),
      [],
      "字面量 -- 是参数分隔符，不能被判成未知参数"
    );
    assert.deepEqual(
      findUnknownPrivacyCardFlags([
        "node",
        "coliving-privacy-card.ts",
        "--",
        "--scenario",
        "corpus-025-cleaning-privacy-2026-09-09",
        "--model",
        "x",
      ]),
      ["--model"],
      "--model 仍必须被判未知"
    );
    assert.deepEqual(
      findUnknownPrivacyCardFlags([
        "node",
        "coliving-privacy-card.ts",
        "--",
        "--turn",
        "2",
      ]),
      ["--turn"],
      "--turn 仍必须被判未知"
    );
    assert.deepEqual(
      findUnknownPrivacyCardFlags(["node", "coliving-privacy-card.ts", "--scenario", "x"]),
      [],
      "已知 flag 本身不是未知参数"
    );
    assert(
      privacyCliSrc.includes("findUnknownPrivacyCardFlags(process.argv)"),
      "CLI 必须用这个共享纯函数做未知参数判定（否则测试与实现脱钩）"
    );
  });

  check("privacy 标准卡完全离线：不接模型/网关/.env，也不接生产动作", () => {
    for (const src of [privacyCardSrc, privacyCliSrc]) {
      assert(
        !/from\s+["'][^"']*chat\/coliving\/turn["']/.test(src),
        "隐私标准卡代码不得 import 生产 turn.ts"
      );
      assert(
        !/from\s+["'][^"']*coliving\/repo["']/.test(src),
        "隐私标准卡代码不得 import 生产 repo（不写数据库）"
      );
      assert(!src.includes("contactPerson("), "不得调用联系住户的工具");
      assert(!src.includes("runColivingTurn("), "不得调用生产回合函数");
    }
    // 完全离线：CLI 里不得出现任何模型/网关/.env 依赖。标准卡是人写的，
    // 模型生成卡两次实跑都失败，已停止且不再引入。
    for (const banned of [
      "generateText",
      "generateObject",
      "Output.object",
      "getLanguageModel",
      "gateway",
      "dotenv",
      "@ai-sdk",
      'from "ai"',
    ]) {
      assert(
        !privacyCliSrc.includes(banned),
        `离线 CLI 不得出现 ${banned}（标准卡不调模型）`
      );
    }
    assert(
      privacyCardSrc.includes("export function validatePrivacyCard"),
      "校验器必须是导出的纯函数"
    );
    assert(privacyCliSrc.includes("validateScenario("), "CLI 必须先走场景校验");
    assert(
      privacyCliSrc.includes("validatePrivacyCard("),
      "CLI 必须跑确定性业务校验"
    );
    assert(privacyCliSrc.includes("privacyCard"), "CLI 必须从场景读人工标准卡");
  });

  /**
   * ── 离线逐动作协调计划（V4 结构实验，只读、离线、评测专用）──
   *
   * 免费确定性检查：证明逐动作结构能表达 V3 整轮二分表达不了的差异，且校验器
   * 对「收据 / 授权 / 就绪度 / 能力分区 / 依赖」的规则真的会拦人。全程不调模型、
   * 不联网、不写库。语义由开发者手写样例给出，这里只查状态一致性。
   */
  const actionPlanSrc = readFileSync(
    "lib/chat/coliving/evals/action-plan.ts",
    "utf8"
  );
  const actionPlanSamplesSrc = readFileSync(
    "lib/chat/coliving/evals/action-plan-samples.ts",
    "utf8"
  );
  const actionPlanArgsSrc = readFileSync(
    "lib/chat/coliving/evals/action-plan-args.ts",
    "utf8"
  );
  const actionPlanCliSrc = readFileSync(
    "scripts/coliving-action-plan.ts",
    "utf8"
  );
  const apCtx: ActionPlanContext = {
    speaker: "小林",
    roster: ["小林", "小王"],
    rawMessage: "（评测用语境）",
  };
  const apOut = (recipient: string) => ({
    recipient,
    purpose: "最小化边界提醒",
    text: "（评测用出站正文）",
  });
  // 中性动作：needs_confirmation + planned + 无出站 → 不触发任何规则，
  // 供构造「只差一条待测违规」的最小 fixture。
  const apNeutral = (over: Partial<ActionItem>): ActionItem => ({
    id: "n",
    kind: "make_schedule",
    purpose: "（评测用动作）",
    authorization: "needs_confirmation",
    capability: "green",
    status: "planned",
    ...over,
  });
  const apViolates = (plan: ActionPlan, code: string): boolean =>
    validateActionPlan(plan, apCtx).violations.some((v) => v.code === code);

  check("逐动作计划：五个轴正交且复用 V3 能力分区（不另立会漂移的定义）", () => {
    assert.deepEqual(
      [...ACTION_CAPABILITIES],
      [...COORDINATION_CAPABILITY_ZONES],
      "能力分区必须就是 V3 的绿/黄/红，避免两份定义漂移"
    );
    assert.deepEqual([...ACTION_KINDS].length, 5, "动作种类只有 5 个正交取值");
    assert.deepEqual(
      [...ACTION_AUTHORIZATIONS].length,
      4,
      "授权依据只有 4 个取值（含 needs_confirmation）"
    );
    assert.deepEqual(
      [...ACTION_READINESS].length,
      2,
      "信息就绪度只有 2 个取值（缺省即 ready）"
    );
    assert.deepEqual([...ACTION_STATUSES].length, 4, "执行状态只有 4 个取值");
    for (const kind of THIRD_PARTY_ACTION_KINDS) {
      assert(
        (ACTION_KINDS as readonly string[]).includes(kind),
        `需要第三方出站的种类「${kind}」必须是合法 kind`
      );
    }
  });

  check("逐动作计划：三张开发者期望样例 + 简单绿区样例全部通过确定性校验", () => {
    for (const sample of ACTION_PLAN_SAMPLES) {
      const result = validateActionPlan(sample.plan, sample.context);
      assert.equal(
        result.ok,
        true,
        `样例「${sample.id}」应通过校验，实际违规：${result.violations
          .map((v) => `${v.actionId ?? "plan"}·${v.code}`)
          .join("、")}`
      );
    }
    const simple = validateActionPlan(
      SIMPLE_GREEN_SAMPLE.plan,
      SIMPLE_GREEN_SAMPLE.context
    );
    assert.equal(
      simple.ok,
      true,
      `简单绿区提醒应通过校验，实际违规：${simple.violations
        .map((v) => v.code)
        .join("、")}`
    );
  });

  check("逐动作计划：id 重复 / 依赖不存在 / 自依赖被拦", () => {
    assert(
      apViolates(
        { actions: [apNeutral({ id: "dup" }), apNeutral({ id: "dup" })], requesterReply: "好。" },
        "duplicate_action_id"
      ),
      "重复 action id 必须被打回"
    );
    assert(
      apViolates(
        { actions: [apNeutral({ id: "x", dependsOn: ["x"] })], requesterReply: "好。" },
        "self_dependency"
      ),
      "动作不能依赖自己"
    );
    assert(
      apViolates(
        { actions: [apNeutral({ id: "x", dependsOn: ["ghost"] })], requesterReply: "好。" },
        "unknown_dependency"
      ),
      "依赖不存在动作必须被打回"
    );
  });

  check("逐动作计划：空计划（actions=[] 只配一句 requesterReply）单独被拦", () => {
    // 反例：没有任何动作、只写一句回复——等于用一句 requesterReply 冒充整轮行动。
    assert(
      apViolates(
        { actions: [], requesterReply: "好的，我来处理。" },
        "empty_actions"
      ),
      "actions 为空时即使有 requesterReply 也必须打回 empty_actions"
    );
    // 正例：只要有一个合法动作就不得误报 empty_actions。
    const oneAction = validateActionPlan(
      { actions: [apNeutral({ id: "a" })], requesterReply: "好的。" },
      apCtx
    );
    assert.equal(
      oneAction.ok,
      true,
      `至少一个动作的计划应通过，实际违规：${oneAction.violations
        .map((v) => v.code)
        .join("、")}`
    );
    assert.equal(
      oneAction.violations.some((v) => v.code === "empty_actions"),
      false,
      "非空计划不得误报 empty_actions"
    );
  });

  check("逐动作计划：声称已发出/完成必须有本动作收据，requesterReply 不能冒充", () => {
    assert(
      apViolates(
        {
          actions: [
            apNeutral({
              id: "c",
              kind: "contact_person",
              authorization: "requester_requested",
              status: "waiting_reply",
            }),
          ],
          requesterReply: "已经问过小王了。",
        },
        "waiting_reply_without_receipt"
      ),
      "标 waiting_reply 却没有出站收据必须被打回"
    );
    assert(
      apViolates(
        {
          actions: [
            apNeutral({
              id: "c",
              kind: "publish_plan",
              authorization: "requester_requested",
              status: "done",
            }),
          ],
          requesterReply: "已经发给大家了。",
        },
        "done_send_action_without_receipt"
      ),
      "对外动作标 done 却没有收据、只靠回复宣称，必须被打回"
    );
    assert(
      apViolates(
        { actions: [apNeutral({ id: "n" })], requesterReply: "已经联系小王了。" },
        "reply_claims_contact_without_receipt"
      ),
      "无任何出站却宣称已联系必须被打回"
    );
  });

  check("逐动作计划：仍需确认 / 已被拒绝的动作不得提前对第三方执行", () => {
    assert(
      apViolates(
        {
          actions: [
            apNeutral({
              id: "c",
              kind: "contact_person",
              authorization: "needs_confirmation",
              status: "waiting_reply",
              outbound: [apOut("小王")],
            }),
          ],
          requesterReply: "好的。",
        },
        "confirmation_required_but_acted"
      ),
      "needs_confirmation 的动作确认前不得出站"
    );
    assert(
      apViolates(
        {
          actions: [apNeutral({ id: "c", authorization: "denied" })],
          requesterReply: "好的。",
        },
        "denied_but_acted"
      ),
      "denied 的动作只能停止"
    );
  });

  check("逐动作计划：缺发信人关键事实只封该动作及其依赖，不整轮连坐", () => {
    // 相邻反例：同一消息里「先问小王周末能不能修门」和「帮我排厨房时间」是两件事。
    // 厨房安排缺发信人自己的可用时间，但**独立**的修门询问仍可正常出站。
    const kitchenMissing = apNeutral({
      id: "kitchen",
      kind: "make_schedule",
      authorization: "requester_requested",
      readiness: "missing_requester_fact",
      blockedReason: "缺发信人自己的可用时间",
    });
    const independentRepair = apNeutral({
      id: "ask-wang-repair",
      kind: "contact_person",
      authorization: "requester_requested",
      status: "waiting_reply",
      outbound: [apOut("小王")],
    });
    const independent = validateActionPlan(
      {
        actions: [independentRepair, kitchenMissing],
        requesterReply: "修门的事我问小王了；厨房排班还缺你自己的时间。",
      },
      apCtx
    );
    assert.equal(
      independent.ok,
      true,
      `独立动作（修门询问）应能出站、不被缺项连坐，实际违规：${independent.violations
        .map((v) => `${v.actionId ?? "plan"}·${v.code}`)
        .join("、")}`
    );
    // 缺项动作自身不得出站/执行（为了过闸联系第三方也不行）。
    assert(
      apViolates(
        {
          actions: [
            apNeutral({
              id: "sched",
              kind: "contact_person",
              authorization: "requester_requested",
              readiness: "missing_requester_fact",
              status: "waiting_reply",
              outbound: [apOut("小王")],
            }),
          ],
          requesterReply: "我问问小王。",
        },
        "missing_requester_fact_executed"
      ),
      "缺发信人关键事实的动作自身不得出站/执行"
    );
    // 依赖缺项动作的动作（含隔一层的传递依赖）同样被拦。
    assert(
      apViolates(
        {
          actions: [
            kitchenMissing,
            apNeutral({
              id: "draft",
              kind: "make_schedule",
              authorization: "requester_requested",
              status: "planned",
              dependsOn: ["kitchen"],
            }),
            apNeutral({
              id: "publish",
              kind: "publish_plan",
              authorization: "requester_requested",
              status: "done",
              dependsOn: ["draft"],
              outbound: [apOut("小王")],
            }),
          ],
          requesterReply: "排好了就发。",
        },
        "missing_requester_fact_blocks_dependent"
      ),
      "依赖（含传递依赖）缺项动作的动作不得执行"
    );
    // 一轮问两个问题 → 打回。
    assert(
      apViolates(
        {
          actions: [
            apNeutral({ id: "q1", requesterQuestion: "问题一？" }),
            apNeutral({ id: "q2", requesterQuestion: "问题二？" }),
          ],
          requesterReply: "请问……",
        },
        "multiple_requester_questions"
      ),
      "一轮最多一个会改变处置的问题"
    );
    // ask_requester 的收据是问话，不能有第三方出站；标 done 必须给问题。
    assert(
      apViolates(
        {
          actions: [
            apNeutral({
              id: "ask",
              kind: "ask_requester",
              authorization: "coordinator_duty",
              status: "done",
              requesterQuestion: "你哪天方便？",
              outbound: [apOut("小王")],
            }),
          ],
          requesterReply: "请问……",
        },
        "ask_requester_forbids_outbound"
      ),
      "向发信人问话的动作不得产生第三方出站"
    );
    assert(
      apViolates(
        {
          actions: [
            apNeutral({
              id: "ask",
              kind: "ask_requester",
              authorization: "coordinator_duty",
              status: "done",
            }),
          ],
          requesterReply: "请问……",
        },
        "ask_requester_requires_question"
      ),
      "ask_requester 标 done 必须给出那个问题"
    );
  });

  check("逐动作计划：red 停止且不牵连同计划其它动作", () => {
    assert(
      apViolates(
        {
          actions: [apNeutral({ id: "u", capability: "red" })],
          requesterReply: "这个我做不了。",
        },
        "red_requires_stop"
      ),
      "red 动作必须 stopped"
    );
    assert(
      apViolates(
        {
          actions: [
            apNeutral({
              id: "u",
              capability: "red",
              status: "stopped",
              outbound: [apOut("小王")],
            }),
          ],
          requesterReply: "这个我做不了。",
        },
        "red_forbids_outbound"
      ),
      "red 动作不得有第三方出站"
    );
    // 同计划里绿区已发出 + 红区停止：red 不得把绿区也改写为红（校验器不跨动作传播）。
    const mixed = validateActionPlan(
      {
        actions: [
          apNeutral({
            id: "guest",
            kind: "contact_person",
            authorization: "requester_requested",
            capability: "green",
            status: "waiting_reply",
            outbound: [apOut("小王")],
          }),
          apNeutral({
            id: "utility",
            kind: "establish_rule",
            authorization: "denied",
            capability: "red",
            status: "stopped",
            capabilityReasons: ["缺少既有依据却要决定费用承担，超出当前可靠能力"],
          }),
        ],
        requesterReply: "过夜的事我问了对方；水电分摊这轮我做不了。",
      },
      apCtx
    );
    assert.equal(
      mixed.ok,
      true,
      `绿+红混合计划应当通过（red 不牵连同计划其它动作），实际违规：${mixed.violations
        .map((v) => `${v.actionId ?? "plan"}·${v.code}`)
        .join("、")}`
    );
    assert.equal(
      mixed.violations.some((v) => v.code === "red_requires_stop"),
      false,
      "绿区动作不得被红区牵连误报"
    );
  });

  check("逐动作计划：依赖未满足不得发布（满足后放行）", () => {
    const collect = apNeutral({
      id: "collect",
      kind: "contact_person",
      authorization: "requester_requested",
      status: "waiting_reply",
      outbound: [apOut("小王")],
    });
    const publishWaiting = apNeutral({
      id: "publish",
      kind: "publish_plan",
      authorization: "requester_requested",
      status: "done",
      dependsOn: ["collect"],
      outbound: [apOut("小王")],
    });
    assert(
      apViolates(
        { actions: [collect, publishWaiting], requesterReply: "表先给小林看过才发。" },
        "dependency_not_satisfied"
      ),
      "依赖的收集动作还没完成时不得发布"
    );
    const satisfied = validateActionPlan(
      {
        actions: [{ ...collect, status: "done" }, publishWaiting],
        requesterReply: "表先给小林看过才发。",
      },
      apCtx
    );
    assert.equal(
      satisfied.ok,
      true,
      `依赖满足后应放行，实际违规：${satisfied.violations
        .map((v) => v.code)
        .join("、")}`
    );
  });

  check("逐动作计划：简单单动作绿区提醒字段很少即可通过（防过度设计）", () => {
    const action = SIMPLE_GREEN_SAMPLE.plan.actions[0];
    assert(action, "简单样例必须有一个动作");
    assert.deepEqual(
      Object.keys(action).sort(),
      ["authorization", "capability", "id", "kind", "outbound", "purpose", "status"],
      "简单动作只填 7 个字段：readiness/dependsOn/blockedReason/requesterQuestion 都可缺省"
    );
    // 已授权绿区已做完的动作不能只写 planned 混过去（V3「已授权必须出站」的逐动作版）。
    assert(
      apViolates(
        {
          actions: [
            apNeutral({
              id: "remind",
              kind: "contact_person",
              authorization: "requester_requested",
              capability: "green",
              status: "planned",
            }),
          ],
          requesterReply: "好的。",
        },
        "actionable_but_not_acted"
      ),
      "已获请求 + 绿区 + 就绪 + 无依赖的动作不能只标 planned"
    );
    // blockedReason 只是解释，不授权绕过：写了理由仍必须拦，防止它变成一句话过闸的口子。
    assert(
      apViolates(
        {
          actions: [
            apNeutral({
              id: "remind",
              kind: "contact_person",
              authorization: "requester_requested",
              capability: "green",
              status: "planned",
              blockedReason: "我打算下一轮再做",
            }),
          ],
          requesterReply: "好的。",
        },
        "actionable_but_not_acted"
      ),
      "写了 blockedReason 也不能只标 planned：理由只解释，不改变校验结果"
    );
    // 报错文案必须指回结构化条件，而不是暗示「写段理由就能过闸」。
    const actionable = validateActionPlan(
      {
        actions: [
          apNeutral({
            id: "remind",
            kind: "contact_person",
            authorization: "requester_requested",
            capability: "green",
            status: "planned",
          }),
        ],
        requesterReply: "好的。",
      },
      apCtx
    );
    const actionableMsg =
      actionable.violations.find((v) => v.code === "actionable_but_not_acted")
        ?.message ?? "";
    assert(
      actionableMsg.includes("blockedReason"),
      "报错应说明 blockedReason 只解释、不授权绕过"
    );
    assert(
      !actionableMsg.includes("写明阻塞原因"),
      "报错不得再暗示写一段 free-text 理由就能过闸"
    );
  });

  // 本样例的**粗粒度**防回归：只守已知的 025/026 同类隐私事故（点名投诉人、
  // 带出只有当事人才知道的私密现场），符合「一条普遍必要理由 + 可执行动作」。
  // **不是完整语义认证**：正则证明不了措辞自然、也没有覆盖没列到的泄漏词，
  // 自然度与全部语义仍由人工审查（见任务卡「不用关键词判断自然度或语义正确」）。
  check("逐动作计划：简单绿区样例的出站不点投诉人、不带私密细节（粗粒度防回归，非语义认证）", () => {
    const action = SIMPLE_GREEN_SAMPLE.plan.actions[0];
    assert(action, "简单样例必须有一个动作");
    const outboundText = (action.outbound ?? []).map((m) => m.text).join("\n");
    assert(outboundText.trim().length > 0, "简单样例必须有出站正文");
    const leakedPhrases = [
      SIMPLE_GREEN_SAMPLE.context.speaker, // 「阿哲」：不得点名投诉人
      "换衣服", // 只有当事人才知道的私密细节
      "正忙着",
    ];
    for (const leaked of [...new Set(leakedPhrases.filter(Boolean))]) {
      assert(
        !outboundText.includes(leaked),
        `简单样例出站不得出现「${leaked}」：这一条只守已知的 025/026 同类隐私事故，不能证明整段话自然`
      );
    }
    // 只给真实动作收据：出现「提醒」字样（已提醒），且不得回流防御性免责声明
    // 「保证 / 会不会照做 / 没法替他」——住户要的是动作是否发出，不是替第三方
    // 承诺服从或推责。本检查只是**本事故的回归哨兵**（粗粒度正则），不证明措辞
    // 自然、也不覆盖没列到的免责说法；自然度仍由人工审查。
    assert(
      SIMPLE_GREEN_SAMPLE.plan.requesterReply.includes("提醒"),
      "requesterReply 应报告提醒已发出（真实动作收据）"
    );
    const disclaimerPhrases = ["保证", "会不会照做", "没法替他"];
    for (const disclaimer of disclaimerPhrases) {
      assert(
        !SIMPLE_GREEN_SAMPLE.plan.requesterReply.includes(disclaimer),
        `requesterReply 不得回流免责声明「${disclaimer}」：本检查只是本事故的回归哨兵，不能证明整段话自然`
      );
    }
  });

  check("逐动作计划 CLI：忽略 pnpm 透传的字面量 --，仍拦真正未知参数", () => {
    assert.deepEqual(
      findUnknownActionPlanFlags([
        "node",
        "coliving-action-plan.ts",
        "--",
        "--sample",
        "sample-01-gather-then-confirm",
      ]),
      [],
      "字面量 -- 是参数分隔符，不能被判成未知参数"
    );
    assert.deepEqual(
      findUnknownActionPlanFlags([
        "node",
        "coliving-action-plan.ts",
        "--",
        "--sample",
        "x",
        "--model",
        "y",
      ]),
      ["--model"],
      "--model 仍必须被判未知"
    );
    assert.deepEqual(
      findUnknownActionPlanFlags([
        "node",
        "coliving-action-plan.ts",
        "--scenario",
        "x",
      ]),
      ["--scenario"],
      "只支持 --sample；--scenario 必须被判未知"
    );
    assert(
      actionPlanCliSrc.includes("findUnknownActionPlanFlags(process.argv)"),
      "CLI 必须用这个共享纯函数做未知参数判定（否则测试与实现脱钩）"
    );
  });

  check("逐动作计划完全离线：不接模型/网关/.env，也不接生产动作", () => {
    for (const src of [
      actionPlanSrc,
      actionPlanSamplesSrc,
      actionPlanArgsSrc,
      actionPlanCliSrc,
    ]) {
      assert(
        !/from\s+["'][^"']*chat\/coliving\/turn["']/.test(src),
        "逐动作计划代码不得 import 生产 turn.ts"
      );
      assert(
        !/from\s+["'][^"']*coliving\/repo["']/.test(src),
        "逐动作计划代码不得 import 生产 repo（不写数据库）"
      );
      assert(!src.includes("contactPerson("), "不得调用联系住户的工具");
      assert(!src.includes("runColivingTurn("), "不得调用生产回合函数");
      assert(!src.includes("validatePrivacyCard("), "不得让 V3 整轮不变量控制 V4 动作");
    }
    for (const banned of [
      "generateText",
      "generateObject",
      "Output.object",
      "getLanguageModel",
      "gateway",
      "dotenv",
      "@ai-sdk",
      'from "ai"',
    ]) {
      assert(
        !actionPlanCliSrc.includes(banned),
        `离线 CLI 不得出现 ${banned}（不调模型）`
      );
    }
    assert(
      actionPlanSrc.includes("export function validateActionPlan"),
      "校验器必须是导出的纯函数"
    );
    assert(
      actionPlanSrc.includes('from "./privacy-turn-card"'),
      "必须复用 V3 的 OutboundMessage / 能力分区 / claimsContactAlreadyMade"
    );
    assert(
      actionPlanCliSrc.includes("validateActionPlan("),
      "CLI 必须跑确定性业务校验"
    );
    assert(
      actionPlanCliSrc.includes("ACTION_PLAN_SAMPLES"),
      "CLI 必须从开发者手写样例读期望计划"
    );
  });

  /**
   * 一对一传话情境的**路由回归哨兵**。新加的 `relay` 模块只在住户明确把
   * 一件要跟另一个人说的话/做的事交给你时加载——漏加载，代传话就退回
   * 通用调解/立规流程（021 真实事故就是"提醒某人别半夜进屋"被写成全屋规则）；
   * 误加载，则普通求助也会背上传话边界。这里只用确定性文本断言路由，
   * 不判断措辞好坏（措辞由 doctrine 与 judge 管）。
   */
  check("relay 情境：明确的传话表达加载 domain/relay.md，非传话请求不误命中", () => {
    const shouldLoad = [
      "你帮我问问他能不能接受？",
      "你能不能帮我把这个跟他说了？",
      "你跟他说一声吧，以后有事先敲门",
      "你赶紧帮我跟他说一声，让他把音量调小",
      "麻烦你替我转告他一声",
      // 口语里常不带"帮我"、收信人用姓名（2026-09-11 corpus-031 第 2、6 轮漏加载的真实说法）。
      "你现在单独跟小浩说，没得到阿鹏同意就别动阿鹏的吃的",
      "你私下提醒他把门口这些饼干屑扫掉，别发群里",
      "你提醒他一下，别在大半夜进屋",
      // **英文说法**（2026-09-21 真实产品事故）：住户全程写英文、点名了室友，
      // 原路由一条都没命中 → 这一轮只装了 conflict，`domain/relay.md` 不在提示词里，
      // 模型按投诉受理的五要素反过来追问「他什么时候用、留下什么」，一条都没发出去。
      // 第一句就是那条真实事故原话（见 corpus-047 场景）。
      "小五 always messes up the kitchen and doesn't tidy up. You tell him to clean up the kitchen every time he finishes using it",
      "Alex keeps leaving dishes in the sink. Please tell him to wash them after he eats.",
      "Could you remind Jordan about the rule we agreed on?",
      "Can you ask him to keep the noise down at night?",
      "Tell her to clean the bathroom after using it.",
      "Could you help me ask him about the parking spot?",
    ];
    for (const text of shouldLoad) {
      assert(
        assembleSystemPrompt({ brainId: "coliving", routeOn: text }).loadedModuleIds.includes("relay"),
        `应命中 relay：${text}`
      );
    }
    const shouldNotLoad = [
      "帮我看看垃圾是周几倒",
      "帮我安排一下厨房的时段",
      "我昨天跟他说了，他说知道了",
      "你到底是房东那边的还是我们租客这边的？",
      // 在**询问 AI 的历史**、没有任何交办动作的完成式/经验式说法：`(?!了|过)`
      // 把这类从"祈使/委托"里排除（2026-09-11 第五阶段 matcher 的误命中）。
      "你昨天跟小明说了什么？",
      "你之前跟房东讲过吗？",
      "你上周提醒过他了吗？",
      // 英文的同一组反例：`(?<!\b(?:did|do|does|have|had|…)\s)` 是中文 `(?!了|过)` 的
      // 对等收窄；`\bme\b|\bus\b` 排除"对着 AI 自己说话"；宾语只收第三人称单数，
      // 对全屋/一群人的说法不是一对一交办（与中文形态同宽，不因英文放宽）。
      "Did you tell him about the kitchen?",
      "You tell me what to do about the kitchen.",
      "Please tell everyone about the trash schedule.",
      "Can you talk to everyone about the noise?",
      "I already told him about it.",
      // 纯投诉、没有交办任何动作——照旧走冲突/清洁流程，不装 relay。
      "The kitchen is a mess and I'm tired of it.",
      "The kitchen is always dirty after he cooks.",
    ];
    for (const text of shouldNotLoad) {
      assert(
        !assembleSystemPrompt({ brainId: "coliving", routeOn: text }).loadedModuleIds.includes("relay"),
        `不该命中 relay：${text}`
      );
    }
  });

  /**
   * relay doctrine 的 few-shot 转化判例哨兵（第十四阶段）。corpus-031 第 2 轮生成端
   * 反复把物主行踪带进出站、把收件人的义务反转给来源人，根因是缺可模仿的成功转化。
   * 这里只做**源码级字符串检查**：判例确实以「原始交办 → 合格/不合格」进入 doctrine，
   * 且失败判例是本场景不可复制的通用对照。它**不证明**默认模型会照做——自然语言能力
   * 由实跑与人工验收判断，不是这段断言能认证的。
   */
  check("relay doctrine 转化判例：成功/失败对照已进入 doctrine，且不含 corpus-031 专有名词", () => {
    const relayDoc = readFileSync("lib/ai/brains/coliving/doctrine/domain/relay.md", "utf8");
    assert(relayDoc.includes("原始交办"), "判例必须以「原始交办 → 出站」形式呈现");
    assert(relayDoc.includes("合格") && relayDoc.includes("不合格"), "判例必须给出合格与不合格对照");
    // 两条判例各自的教学点：删掉与动作无关的第三人行踪；义务稳定落在收件人，不反转、不改成报备。
    assert(relayDoc.includes("行踪"), "判例要展示第三人行踪对完成动作无关、必须删掉");
    assert(relayDoc.includes("义务"), "判例要展示义务归属不得因改写而反转");
    for (const sceneWord of ["小岚", "嘉怡", "阿鹏", "小浩", "麦片", "意大利面", "洗碗机", "牛排", "饼干", "温控器"]) {
      assert(!relayDoc.includes(sceneWord), `通用 relay doctrine 不得写进 corpus-031 的专有名词：${sceneWord}`);
    }
  });

  /**
   * 第十五阶段：约谈议题被「温和地删掉」的对照判例。第 7 轮原始交办明确要谈
   * 「要不要分开住」，通过审稿的出站却写成「一起商量往后怎么住更舒服。没定什么结论」，
   * 把决定收件人是否参加所必需的议题盖掉；抽象条款「必须保留核心议题」不足以稳定识别。
   * doctrine 与出站专属审稿视图都要有这组「温和≠含糊」的语义对照。仍是源码级字符串
   * 检查：它**不证明**默认模型会照做，自然语言能力由实跑与人工验收判断。
   */
  check("relay 约谈议题对照判例：doctrine 与出站专属视图都有「温和≠含糊」的语义对照，且无本语料专名", () => {
    const relayDoc = readFileSync("lib/ai/brains/coliving/doctrine/domain/relay.md", "utf8");
    // 议题要直说去留（继续一起住 / 分开安排），不能含糊成「以后怎么住得更舒服」。
    assert(
      relayDoc.includes("继续一起住") && relayDoc.includes("分开安排"),
      "doctrine 判例要明说约谈议题是「继续一起住 / 分开安排」"
    );
    assert(
      relayDoc.includes("温和") && relayDoc.includes("含糊"),
      "doctrine 判例要点出「温和不等于含糊」"
    );
    assert(
      relayDoc.includes("以后怎么住得更舒服"),
      "doctrine 判例要给出被含糊掉的失败对照"
    );
    // 出站专属视图：同一判断范式——更软的说法不能替代去留议题，且不得无中生有。
    const recipient = selectCriticRubric(["relay-recipient"], false);
    assert(
      recipient.includes("以后怎么住得舒服") &&
        recipient.includes("不能替代") &&
        recipient.includes("是否继续合住") &&
        recipient.includes("是否分开安排"),
      "出站专属视图要明确「以后怎么住得舒服 / 之后怎么协调」不能替代「是否继续合住 / 是否分开安排」"
    );
    assert(
      recipient.includes("不得自行添加"),
      "出站专属视图要保留正常反例：原始交办没有居住去留议题时不得自行添加"
    );
    for (const sceneWord of ["小岚", "嘉怡", "阿鹏", "小浩", "麦片", "意大利面", "洗碗机", "牛排", "饼干", "温控器"]) {
      assert(!relayDoc.includes(sceneWord), `doctrine 约谈判例不得写进 corpus-031 的专有名词：${sceneWord}`);
      assert(!recipient.includes(sceneWord), `通用 relay 审稿视图不得写进 corpus-031 的专有名词：${sceneWord}`);
    }
  });

  /**
   * 第十六阶段：群体约谈合格例的**代理人称**哨兵。旧合格例写成「我们几个想跟你聊聊」，
   * 让 AI 混进住户群体用第一人称说话——收件人读到的是"AI 也在这群人里"，而不是
   * "这几个人托 AI 来约我"。这是措辞/人称错误，不是要恢复 LLM 复审。
   *
   * 只锚定**这一条通用合格例**：它必须用第三人称点明是哪几位住户在约，且不得含
   * 那条误导性的第一人称形式。**不做全局「我们」禁令**——住户原始交办里说「我们商量了
   * 一阵」是自然说法，其它语境也可能合法使用（原始交办保留原样即是证据）。
   * 仍是源码级字符串检查：它**不证明**默认模型会照做，真实措辞由实跑与人工验收判断。
   */
  check("relay 群体约谈合格例：第三人称点明住户在约，且不含 AI 混入群体的「我们几个想跟你聊聊」", () => {
    const relayDoc = readFileSync("lib/ai/brains/coliving/doctrine/domain/relay.md", "utf8");
    // 第三人称人类归属：约人的必须是可核查的住户（名字 + "住户"），不是 AI 自称。
    assert(
      relayDoc.includes("和另外两位住户想跟你聊聊"),
      "群体约谈合格例要用第三人称点明住户在约（如「阿明和另外两位住户想跟你聊聊」）"
    );
    assert(
      !relayDoc.includes("我们几个想跟你聊聊"),
      "群体约谈合格例不得用第一人称「我们几个想跟你聊聊」——那会让 AI 听起来属于住户群体"
    );
    // 正常反例：住户原始交办里的「我们商量了一阵」是自然的第一人称，不得被一并禁掉。
    assert(
      relayDoc.includes("我们商量了一阵"),
      "原始交办里的住户第一人称「我们」是自然说法，不得被这条哨兵误伤"
    );
  });

  const previous = process.env.COLIVING_JUDGE_OFF;
  process.env.COLIVING_JUDGE_OFF = "1";
  const off = await judgeConversation({ scenarioId: "off", source: "offline", roster: [], turns: bad });
  assert.equal(off.verified, false); assert.equal(off.pass, false); count++;
  if (previous === undefined) delete process.env.COLIVING_JUDGE_OFF;
  else process.env.COLIVING_JUDGE_OFF = previous;

  // ── 评测计费台账（gateway-ledger.ts）：纯离线，不发任何模型调用 ────────
  /** 伪造一次 generateText 结果：每步一个 gateway.cost（undefined = 缺字段）。 */
  const fakeGatewayResult = (costs: Array<string | undefined>) => ({
    steps: costs.map((cost) =>
      cost === undefined ? { providerMetadata: {} } : { providerMetadata: { gateway: { cost } } }
    ),
  });

  check("评测台账：已知花费逐步累加、缺 cost 记 unknown（不当 0）", () => {
    const ledger = new GatewayCostLedger({});
    ledger.beforeCall("main", "m1");
    ledger.afterCall(
      "main",
      "m1",
      gatewayCostFromResult(fakeGatewayResult(["0.10", "0.20"]))
    );
    ledger.beforeCall("critic", "m2");
    ledger.afterCall(
      "critic",
      "m2",
      gatewayCostFromResult(fakeGatewayResult([undefined]))
    );
    const snap = ledger.snapshot();
    assert.equal(snap.calls, 2, "两次调用都要登记");
    assert.ok(
      Math.abs(snap.knownCostUsd - 0.3) < 1e-9,
      `已知花费应为 0.30，实际 ${snap.knownCostUsd}`
    );
    assert.equal(snap.unknownCostCalls, 1, "缺 cost 的那次必须记 unknown，不能当 0");
    assert.equal(snap.stopped, false);
    assert.equal(snap.byStage.find((b) => b.key === "main")?.calls, 1);
    assert.equal(snap.byModel.find((b) => b.key === "m2")?.unknownCostCalls, 1);
  });
  check("评测台账：步级 cost 缺失 => 该次整笔 unknown，绝不按 0 计", () => {
    const reading = gatewayCostFromResult(fakeGatewayResult(["0.05", undefined]));
    assert.equal(reading.unknown, true, "只要有一步缺 cost 就标 unknown");
    assert.ok(Math.abs(reading.costUsd - 0.05) < 1e-9, "已知的部分照实累加");
    assert.equal(gatewayCostFromResult(fakeGatewayResult([])).unknown, true);
  });
  check("评测台账：调用数硬上限，第 N+1 次在发起前被拒", () => {
    const ledger = new GatewayCostLedger({ maxModelCalls: 2 });
    ledger.beforeCall("main", "m");
    ledger.afterCall("main", "m", { costUsd: 0.01, unknown: false });
    ledger.beforeCall("redo", "m");
    ledger.afterCall("redo", "m", { costUsd: 0.01, unknown: false });
    assert.throws(
      () => ledger.beforeCall("finalFix", "m"),
      (error: unknown) => isEvalBudgetExceeded(error),
      "第 3 次调用必须抛预算错误"
    );
    const snap = ledger.snapshot();
    assert.equal(snap.calls, 2, "被拒的调用不计入已发起数");
    assert.equal(snap.stopped, true);
    assert.match(snap.stopReason ?? "", /硬上限/);
    // 触限后已花的钱留在快照里（报告不丢已花成本）。
    assert.ok(snap.knownCostUsd > 0, "触限后已花成本必须留在快照里");
  });
  check("评测台账：金额达线后拦下一次，单次可略越线、已花成本照留", () => {
    const ledger = new GatewayCostLedger({ maxCostUsd: 0.25 });
    ledger.beforeCall("main", "m");
    ledger.afterCall("main", "m", { costUsd: 0.3, unknown: false });
    assert.throws(
      () => ledger.beforeCall("redo", "m"),
      (error: unknown) => isEvalBudgetExceeded(error),
      "已知累计已到线，下一次必须被拒"
    );
    const snap = ledger.snapshot();
    assert.equal(snap.calls, 1, "单次请求可略越线，但不发下一次");
    assert.ok(snap.knownCostUsd >= 0.25, "已知花费照实记，不粉饰");
    assert.equal(snap.stopped, true);
  });
  check("评测台账：多场景快照可合并，按 stage/model 聚合", () => {
    const a = new GatewayCostLedger({ maxModelCalls: 10 });
    a.beforeCall("main", "m");
    a.afterCall("main", "m", { costUsd: 0.1, unknown: false });
    const b = new GatewayCostLedger({ maxModelCalls: 10 });
    b.beforeCall("main", "m");
    b.afterCall("main", "m", { costUsd: 0.2, unknown: true });
    const total = mergeLedgerSnapshots([a.snapshot(), b.snapshot()]);
    assert.equal(total.calls, 2);
    assert.ok(Math.abs(total.knownCostUsd - 0.3) < 1e-9);
    assert.equal(total.unknownCostCalls, 1);
    const main = total.byStage.find((x) => x.key === "main");
    assert.equal(main?.calls, 2);
    assert.equal(main?.unknownCostCalls, 1);
  });
  check("评测台账：整批共享预算——多场景账本共用一个总上限，第 N+1 次全局被拒", () => {
    // 关键回归：`--max-model-calls` 是**整批**上限，不是每场景各一份。
    // 两个场景共用一份预算、各有一份本地台账；全局只能调 2 次。
    const budget = new BatchBudget({ maxModelCalls: 2 });
    const localA = new GatewayCostLedger({}, budget);
    const localB = new GatewayCostLedger({}, budget);
    localA.beforeCall("main", "m");
    localA.afterCall("main", "m", { costUsd: 0.1, unknown: false });
    localB.beforeCall("main", "m");
    localB.afterCall("main", "m", { costUsd: 0.2, unknown: false });
    // 第 3 次（不管从哪个场景发起）都必须被整批共享上限拒。
    assert.throws(
      () => localA.beforeCall("redo", "m"),
      (error: unknown) => isEvalBudgetExceeded(error),
      "第 3 次调用必须被整批共享上限拒绝"
    );
    assert.throws(
      () => localB.beforeCall("redo", "m"),
      (error: unknown) => isEvalBudgetExceeded(error),
      "被拒后任何场景的后续调用都拒"
    );
    const global = budget.snapshot();
    assert.equal(global.calls, 2, "整批只放行 2 次调用");
    assert.ok(Math.abs(global.knownCostUsd - 0.3) < 1e-9, "全局已知花费累加");
    assert.equal(global.stopped, true);
    assert.match(global.stopReason ?? "", /硬上限/);
    // 本地账各记各的收据，不放大成 N 份上限、也不串场。
    assert.equal(localA.snapshot().calls, 1, "A 的本地账只记 A 的一次");
    assert.equal(localB.snapshot().calls, 1, "B 的本地账只记 B 的一次");
    assert.equal(localA.snapshot().stopped, true, "本地账要能反映共享预算已停止");
    // 合并本地账 = 全局总数：相加既不重复计费，也不漏。
    const merged = mergeLedgerSnapshots([localA.snapshot(), localB.snapshot()]);
    assert.equal(
      merged.calls,
      global.calls,
      "合并本地账的调用数必须等于整批总数（不重复计费）"
    );
    assert.ok(
      Math.abs(merged.knownCostUsd - global.knownCostUsd) < 1e-9,
      "合并本地账的金额必须等于整批总数（不重复计费）"
    );
  });
  await checkAsync(
    "评测台账：共享预算下并发上下文仍各记各的本地收据（不串场）",
    async () => {
      const budget = new BatchBudget({ maxModelCalls: 10 });
      const ledgerA = new GatewayCostLedger({}, budget);
      const ledgerB = new GatewayCostLedger({}, budget);
      await Promise.all([
        runWithEvalLedger(ledgerA, async () => {
          await trackedGatewayCall("main", "a", async () => fakeGatewayResult(["0.10"]));
          await trackedGatewayCall("redo", "a", async () => fakeGatewayResult(["0.20"]));
        }),
        runWithEvalLedger(ledgerB, async () => {
          await trackedGatewayCall("main", "b", async () => fakeGatewayResult(["0.05"]));
        }),
      ]);
      assert.equal(ledgerA.snapshot().calls, 2, "A 的本地账只记 A 的两次");
      assert.equal(ledgerB.snapshot().calls, 1, "B 的本地账只记 B 的一次");
      assert.ok(Math.abs(ledgerA.snapshot().knownCostUsd - 0.3) < 1e-9);
      assert.ok(Math.abs(ledgerB.snapshot().knownCostUsd - 0.05) < 1e-9);
      const global = budget.snapshot();
      assert.equal(global.calls, 3, "共享预算记全局 3 次");
      assert.ok(Math.abs(global.knownCostUsd - 0.35) < 1e-9);
      assert.equal(global.stopped, false, "没到上限不该停");
    }
  );
  check("评测台账：金额线是整批共享的软上限（单次可略越线，之后全局拦住）", () => {
    const budget = new BatchBudget({ maxCostUsd: 0.25 });
    const a = new GatewayCostLedger({}, budget);
    const b = new GatewayCostLedger({}, budget);
    a.beforeCall("main", "m");
    a.afterCall("main", "m", { costUsd: 0.3, unknown: false });
    assert.throws(
      () => b.beforeCall("main", "m"),
      (error: unknown) => isEvalBudgetExceeded(error),
      "场景 A 花过线后，场景 B 的下一次也必须被拒（金额线整批共享）"
    );
    assert.equal(budget.snapshot().calls, 1, "越线的那一次已发起，但不再发下一次");
    assert.ok(budget.snapshot().knownCostUsd >= 0.25, "已知花费照实记，不粉饰");
  });
  await checkAsync("评测台账：并发场景各记各的账（AsyncLocalStorage 隔离）", async () => {
    // A 上限 1、B 上限 3：两者 Promise.all 并发。若共享一个可变全局，
    // B 的第二次调用会被 A 的次数/花费拖下水；隔离则各按各的上限走。
    const ledgerA = new GatewayCostLedger({ maxModelCalls: 1 });
    const ledgerB = new GatewayCostLedger({ maxModelCalls: 3 });
    const [a, b] = await Promise.all([
      runWithEvalLedger(ledgerA, async () => {
        await trackedGatewayCall("main", "a", async () => fakeGatewayResult(["0.50"]));
        try {
          await trackedGatewayCall("redo", "a", async () => fakeGatewayResult(["0.50"]));
          return "allowed";
        } catch (error) {
          return isEvalBudgetExceeded(error) ? "budget" : "other";
        }
      }),
      runWithEvalLedger(ledgerB, async () => {
        await trackedGatewayCall("main", "b", async () => fakeGatewayResult(["0.01"]));
        await trackedGatewayCall("redo", "b", async () => fakeGatewayResult(["0.01"]));
        return "two-ok";
      }),
    ]);
    assert.equal(a, "budget", "A 的第 2 次只该被 A 自己的上限拒");
    assert.equal(b, "two-ok", "B 不受 A 的次数/花费影响（没有共享全局）");
    assert.equal(ledgerA.snapshot().calls, 1);
    assert.equal(ledgerB.snapshot().calls, 2);
    assert.ok(Math.abs(ledgerA.snapshot().knownCostUsd - 0.5) < 1e-9);
    assert.ok(Math.abs(ledgerB.snapshot().knownCostUsd - 0.02) < 1e-9);
  });
  await checkAsync("评测台账：没有台账时原样透传（生产行为不变）", async () => {
    assert.equal(currentEvalLedger(), undefined, "生产上下文里没有台账");
    const marker = { value: 42 };
    const returned = await trackedGatewayCall("main", "m", async () => marker);
    assert.equal(returned, marker, "无台账必须原样返回 run 的结果，不包不改");
    // 没设预算（本地台账自建无上限内部预算）时也不限流：与原来"不设限"一致。
    const ledger = new GatewayCostLedger({});
    for (let i = 0; i < 5; i++) {
      ledger.beforeCall("main", "m");
      ledger.afterCall("main", "m", { costUsd: 1, unknown: false });
    }
    assert.equal(ledger.snapshot().calls, 5);
    assert.equal(ledger.snapshot().stopped, false, "没设上限就不该停");
  });

  /**
   * ── 主生成输出上限（评测定向实验，不是生产优化）──────────────────────
   *
   * 开关在 `gateway-ledger.ts` 的 `evalMaxOutputTokensOption`：只有「评测台账在 +
   * `COLIVING_EVAL_MAX_OUTPUT_TOKENS` 是合法正整数」才给主生成传 `maxOutputTokens`。
   * 下面逐条钉住任务要求的边界：无台账不传、台账+未设不传、台账+合法传、
   * 非法值永不成为模型参数、原有生成配置不退化。全离线，不调模型、不写库。
   */
  check("输出上限解析：只认 1..安全上限 的整数，空/负/0/小数/超限一律非法", () => {
    assert.deepEqual(parseEvalMaxOutputTokens(undefined), { status: "unset" });
    assert.deepEqual(parseEvalMaxOutputTokens(null), { status: "unset" });
    for (const raw of [
      "",
      "   ",
      "0",
      "-1",
      "1.5",
      "abc",
      "Infinity",
      "NaN",
      String(EVAL_MAX_OUTPUT_TOKENS_CEILING + 1),
    ]) {
      assert.equal(
        parseEvalMaxOutputTokens(raw).status,
        "invalid",
        `「${raw}」应判非法，不能变成模型参数`
      );
    }
    assert.deepEqual(parseEvalMaxOutputTokens("4096"), {
      status: "valid",
      value: 4096,
    });
    assert.deepEqual(
      parseEvalMaxOutputTokens(String(EVAL_MAX_OUTPUT_TOKENS_CEILING)),
      { status: "valid", value: EVAL_MAX_OUTPUT_TOKENS_CEILING },
      "安全上限本身应合法"
    );
  });
  await checkAsync("输出上限：无台账时即使设了变量也不传（生产逐字不变）", async () => {
    const saved = process.env[EVAL_MAX_OUTPUT_TOKENS_ENV];
    process.env[EVAL_MAX_OUTPUT_TOKENS_ENV] = "4096";
    try {
      assert.equal(currentEvalLedger(), undefined, "生产上下文里没有台账");
      assert.deepEqual(
        evalMaxOutputTokensOption(),
        {},
        "无台账必须返回空对象，绝不传 cap"
      );
    } finally {
      if (saved === undefined) delete process.env[EVAL_MAX_OUTPUT_TOKENS_ENV];
      else process.env[EVAL_MAX_OUTPUT_TOKENS_ENV] = saved;
    }
  });
  await checkAsync("输出上限：有台账但未设不传；设合法值才传 maxOutputTokens", async () => {
    const saved = process.env[EVAL_MAX_OUTPUT_TOKENS_ENV];
    const withLedger = () =>
      runWithEvalLedger(new GatewayCostLedger({}), async () =>
        evalMaxOutputTokensOption()
      );
    try {
      delete process.env[EVAL_MAX_OUTPUT_TOKENS_ENV];
      assert.deepEqual(await withLedger(), {}, "台账在但未设＝基线，不传");
      process.env[EVAL_MAX_OUTPUT_TOKENS_ENV] = "4096";
      assert.deepEqual(await withLedger(), { maxOutputTokens: 4096 });
    } finally {
      if (saved === undefined) delete process.env[EVAL_MAX_OUTPUT_TOKENS_ENV];
      else process.env[EVAL_MAX_OUTPUT_TOKENS_ENV] = saved;
    }
  });
  await checkAsync("输出上限：非法值在台账内也永不成为模型参数", async () => {
    const saved = process.env[EVAL_MAX_OUTPUT_TOKENS_ENV];
    try {
      for (const raw of [
        "",
        "0",
        "-3",
        "2.5",
        "nope",
        String(EVAL_MAX_OUTPUT_TOKENS_CEILING + 1),
      ]) {
        process.env[EVAL_MAX_OUTPUT_TOKENS_ENV] = raw;
        const option = await runWithEvalLedger(
          new GatewayCostLedger({}),
          async () => evalMaxOutputTokensOption()
        );
        assert.deepEqual(
          option,
          {},
          `非法值「${raw}」绝不能成为 maxOutputTokens`
        );
      }
    } finally {
      if (saved === undefined) delete process.env[EVAL_MAX_OUTPUT_TOKENS_ENV];
      else process.env[EVAL_MAX_OUTPUT_TOKENS_ENV] = saved;
    }
  });
  check("输出上限：展开空对象不改生成配置，只有启用时才多一个 maxOutputTokens", () => {
    // 生产（无台账）展开 `evalMaxOutputTokensOption()` 后，一个键都不多。
    const base = {
      model: "m",
      system: "s",
      messages: [],
      tools: {},
      stopWhen: [],
    };
    const noLedger = { ...base, ...evalMaxOutputTokensOption() };
    assert.deepEqual(noLedger, base, "无台账展开后与原来逐键相同");
    assert.equal("maxOutputTokens" in noLedger, false);
    // 启用时只多这一个键，其余原样。
    const enabled = { ...base, ...{ maxOutputTokens: 4096 } };
    const { maxOutputTokens: cap, ...rest } = enabled;
    assert.equal(cap, 4096);
    assert.deepEqual(rest, base, "启用也不动其它生成配置");
  });
  check("输出上限：turn.ts 只在主生成展开实验开关，两处兜底生成不传 cap", () => {
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(
      turnSrc.includes("evalMaxOutputTokensOption"),
      "turn.ts 必须引入实验开关"
    );
    assert.equal(
      turnSrc.split("...evalMaxOutputTokensOption()").length - 1,
      1,
      "实验开关只能展开一次"
    );
    assert.equal(
      (turnSrc.match(/maxOutputTokens\s*:/g) ?? []).length,
      0,
      "turn.ts 不得自己写 maxOutputTokens 参数，只能经开关"
    );
    const mainIdx = turnSrc.indexOf('trackedGatewayCall("main"');
    const capIdx = turnSrc.indexOf("...evalMaxOutputTokensOption()");
    const forcedReplyIdx = turnSrc.indexOf(
      'trackedGatewayCall("forced-sendReply"'
    );
    assert.ok(
      mainIdx >= 0 && capIdx > mainIdx && capIdx < forcedReplyIdx,
      "cap 必须在主生成的 options 里（且在兜底生成之前）"
    );
    // 两处生成器调用数量不变（本实验没新增调用路径）。
    assert.equal(turnSrc.split("trackedGatewayCall(").length - 1, 2);
  });
  check("Gateway 自动缓存：主/forced-sendReply 共用同一请求级 prompt-prefix 缓存策略", () => {
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    // 共享常量本身就是文档化的请求级 gateway caching='auto'，带类型注解。
    assert(
      /const GENERATOR_GATEWAY_CACHE_OPTIONS: SharedV3ProviderOptions = \{\s*gateway: \{ caching: "auto" \},\s*\};/.test(
        turnSrc
      ),
      "共享常量必须是请求级 providerOptions.gateway.caching='auto'"
    );
    // 恰好两处生成器各用一次，不许顺手加到别的 generateText / embedding 调用上。
    const refs = [
      ...turnSrc.matchAll(/providerOptions: GENERATOR_GATEWAY_CACHE_OPTIONS/g),
    ].map((m) => m.index ?? -1);
    assert.equal(refs.length, 2, "两处生成器都要启用同一策略，不多不少");
    // 每一处都必须落在对应 stage 的 generateText options 区间里
    // （stage 锚点起点 → 下一个 stage 锚点起点）。
    const anchors = [
      'trackedGatewayCall("main"',
      'trackedGatewayCall("forced-sendReply"',
    ].map((s) => turnSrc.indexOf(s));
    assert(!anchors.includes(-1), "两个 stage 锚点都要能找到");
    for (let i = 0; i < anchors.length; i++) {
      const start = anchors[i];
      const end = i + 1 < anchors.length ? anchors[i + 1] : turnSrc.length;
      assert.equal(
        refs.filter((r) => r > start && r < end).length,
        1,
        `stage ${i} 的生成请求必须带上 gateway 自动缓存`
      );
    }
    // 保留 Anthropic 手动断点：自动缓存是补充，不是替换。
    assert.equal(
      turnSrc.split('anthropic: { cacheControl: { type: "ephemeral" } }')
        .length - 1,
      1,
      "doctrine system 的 Anthropic cacheControl marker 必须保留"
    );
    // 只开 prompt-prefix 缓存，不得引入应用级回复缓存（避免把住户正文/
    // 运行时状态冻成可复用答案）。
    assert(
      !/responseCache|response_cache|cache:\s*true/.test(turnSrc),
      "只开 prompt-prefix 缓存，不得引入应用级回复缓存"
    );
  });
  check("输出上限：coliving-eval 启动即校验变量、非法退出，并把生效值写进报告", () => {
    const src = readFileSync("scripts/coliving-eval.ts", "utf8");
    assert(
      src.includes("parseEvalMaxOutputTokens(") &&
        src.includes('EVAL_OUTPUT_PARSE.status === "invalid"'),
      "设了非法值必须启动即报错，不静默退回不设"
    );
    assert(
      src.includes("r.evalMaxOutputTokens = EVAL_OUTPUT_CAP"),
      "报告要记录本次是否启用输出上限"
    );
    assert(
      src.includes("主生成输出上限="),
      "终端头部要显示本次是否启用"
    );
  });
  check("评测预算闸已接进 coliving-eval，报告在正常/触限/异常三路都带台账", () => {
    const src = readFileSync("scripts/coliving-eval.ts", "utf8");
    assert(
      src.includes("runWithEvalLedger(ledger"),
      "每个场景必须跑在自己的本地台账上下文里"
    );
    // 上限是**整批共享**的：只建一份 BatchBudget，场景本地台账挂上去，
    // 本地不再各带 CLI 上限（否则 N 个场景把总预算放大 N 倍）。
    assert.equal(
      src.split("new BatchBudget(").length - 1,
      1,
      "整批只能建一份共享预算（不是每场景一份）"
    );
    assert(
      /new GatewayCostLedger\(\s*\{\}\s*,\s*batchBudget\s*\)/.test(src),
      "场景本地台账必须挂到整批共享预算上（本地不自带上限）"
    );
    assert(
      !/new GatewayCostLedger\(\{[^}]*max/.test(src),
      "GatewayCostLedger 构造时不得再带 CLI 上限"
    );
    assert(
      src.includes("maxCostUsd: MAX_COST_USD") &&
        src.includes("maxModelCalls: MAX_MODEL_CALLS"),
      "限额必须来自 CLI 参数，并挂在共享预算上"
    );
    assert(
      src.includes("for (const r of results) r.budget = budgetSnapshot"),
      "报告要给每个场景贴上整批共享预算快照（含停止原因）"
    );
    assert(
      src.split("cost: ledger.snapshot()").length - 1 >= 3,
      "正常返回、轮次触限、异常三条路径都要带台账（报告不丢已花成本）"
    );
    assert(
      src.includes("isEvalBudgetExceeded(error)"),
      "预算错误必须被识别成停止信号，而不是普通失败"
    );
    assert(
      src.includes("mergeLedgerSnapshots(results.map((r) => r.cost))"),
      "终端汇总要合并各场景台账"
    );
    assert(
      src.indexOf("writeFileSync(reportPath") > 0,
      "报告在退出前写出，触限不丢"
    );
    // 不改生产：只有 turn/critic/judge 的 generateText 走包装，生产无台账即透传。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    // 生产只剩两处生成器 Gateway 调用，都要过计费台账：
    // 主生成（"main"），以及模型没按工具约定走时被拦下的一处确定性兜底
    // ——强制 sendReply（"forced-sendReply"）。
    assert.equal(
      turnSrc.split("trackedGatewayCall(").length - 1,
      2,
      "turn.ts 两处生成器 Gateway 调用（main / forced-sendReply）都要过计费台账"
    );
    const criticSrc = readFileSync("lib/chat/coliving/critic.ts", "utf8");
    assert.equal(
      criticSrc.split("trackedGatewayCall(").length - 1,
      2,
      "critic.ts 单条/批量两处都要过计费台账"
    );
    const judgeSrc = readFileSync("lib/chat/coliving/evals/judge.ts", "utf8");
    assert.equal(
      judgeSrc.split("trackedGatewayCall(").length - 1,
      1,
      "judge.ts 判定调用要过计费台账"
    );
  });

  check("提示词组成观测：turn/eval 只记长度与名称，报告安全兼容旧 JSON", () => {
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(
      turnSrc.includes("export type PromptComposition = {"),
      "观测类型必须导出，供评测 runner 复用"
    );
    assert(
      turnSrc.includes("promptComposition: PromptComposition | null;"),
      "TurnOutcome 必须带可空观测字段（null=本轮没走模型）"
    );
    // TurnOutcome 返回点都要显式给出：不调主模型的路径显式 null
    // （未知号码 / 厨房排班接管 / 短路 / 已批准功能前门命中 / 共同规则协商接管，
    // 不是 0），主生成路径给真实长度/名称。
    // 已批准功能现在在 `buildContext` 之后、主生成之前由功能前门直接办完并早返回
    // （`finalizeFeatureTurn`），这是一条新的不调主模型的路径。
    // 共同规则协商接管（`maybeSharedRuleReply`，默认关闭）同样不构建主提示词，只是另调
    // 一次收窄的文案生成；它**有两个**显式 null 的返回点：正常返回，以及「事实已推进后
    // 出错、绝不回落旧流程」的安全返回。因此这里比之前多一条。
    assert.equal(
      turnSrc.split("promptComposition: null,").length - 1,
      6,
      "六条不走主模型的返回点（未知号码/接管/短路/功能前门/共同规则正常/共同规则安全兜底）都要显式 null"
    );
    assert(
      turnSrc.includes("doctrineChars: doctrine.length") &&
        turnSrc.includes("runtimeChars: runtime.length") &&
        turnSrc.includes("systemChars: chars") &&
        turnSrc.includes("moduleIds: loadedModuleIds") &&
        turnSrc.includes("toolNames: exposedToolNames"),
      "主生成返回点必须记 doctrine/runtime/system 字符数与模块/工具名，不是正文"
    );
    // 只记名字/长度：观测里不得出现运行时正文变量或住户原话变量。
    assert(
      !/promptComposition[\s\S]{0,400}(ctx\.text|args\.text|runtimeContext)/.test(
        turnSrc
      ),
      "观测里不得出现运行时正文或住户原话"
    );

    const evalSrc = readFileSync("scripts/coliving-eval.ts", "utf8");
    assert(
      evalSrc.includes("promptComposition: last.promptComposition"),
      "逐轮记录必须把观测带进报告 JSON"
    );

    // 报告侧纯函数：三态防御，不 NaN、不为旧报告补 0。
    assert.equal(
      normalizePromptComposition(undefined),
      undefined,
      "旧报告字段缺席 → 不展示，不补 0"
    );
    assert.equal(
      normalizePromptComposition(null),
      null,
      "null = 本轮没走模型，不是 0 字符"
    );
    const badComp = normalizePromptComposition({
      doctrineChars: Number.NaN,
      runtimeChars: "x",
      systemChars: -1,
      moduleIds: [1, 2],
      toolNames: ["sendReply", "contactPerson"],
      toolCount: Number.POSITIVE_INFINITY,
    });
    if (!badComp) throw new Error("形状认识的对象要归一化");
    assert.equal(badComp.doctrineChars, null, "NaN → 未知");
    assert.equal(badComp.runtimeChars, null, "非数字 → 未知");
    assert.equal(badComp.systemChars, null, "负数 → 未知");
    assert.equal(badComp.moduleIds, null, "非字符串数组 → 未知");
    assert.equal(badComp.toolCount, 2, "数量坏值时用工具名数量兜底");

    assert.equal(
      renderPromptCompositionHtml(undefined),
      "",
      "旧报告不渲染观测块"
    );
    const rendered = [
      renderPromptCompositionHtml(null),
      renderPromptCompositionHtml(badComp),
      renderPromptCompositionHtml({}),
    ];
    for (const html of rendered) {
      assert(!html.includes("NaN"), "观测块绝不能渲染出 NaN");
      assert(!html.includes("undefined"), "观测块绝不能渲染出 undefined");
    }
    assert(
      renderPromptCompositionHtml(badComp).includes(
        "不构成删除或精简 doctrine 的依据"
      ),
      "报告必须明说这只是观测，不构成删 doctrine 的依据"
    );
  });

  /**
   * ── 上下文回执：只有分节 id / 字符数与检索足迹（名字 / 次数 / 字符数） ──
   *
   * 回执是观察层，跟上面的 prompt 观测同一条纪律：它只回答"这一轮上下文由
   * 哪些分节拼成、各占多少字符，模型额外去查了哪几类、各拉回多少字符"，
   * **不回答里面写了什么**。所以要证四件事：
   *  1. **源级**：`ContextReceipt` 的形状里没有任何承载正文的字段（连工具
   *     入参都没有承载字段），`buildContext` 只按 `lines` 的字符数记账
   *     （不把分节文本存进收据）；
   *  2. **离线渲染**：把一份**被刻意塞进"样例机密正文"**的收据喂给渲染函数，
   *     输出里绝不能出现那段正文——分节只读 `id` / `chars`，工具名只留
   *     代码认识的名字，多余字段一律不读、不渲染；
   *  3. **折字符数不抛**：非字符串 / 数不出来的返回内容只记"未知"，绝不上抛
   *     （观测坏了不能连累这一轮对话）；
   *  4. **旧报告兼容**：字段缺席时整个块不渲染（不补 0、不 NaN），旧格式的
   *     工具名列表照旧能读成"次数与字符数未知"。
   */
  check("上下文回执：分节 id / 字符数与检索足迹，渲染不暴露正文", () => {
    // 形状与工具名单在纯模块里（零 import）：运行时、评测脚本、报告层共用一份，
    // 不许在别处再立一套收据类型或再写一份检索工具名单。
    const receiptSrc = readFileSync(
      "lib/chat/coliving/context-receipt.ts",
      "utf8"
    );
    const sectionTypeStart = receiptSrc.indexOf(
      "export type ContextReceiptSection = {"
    );
    assert(sectionTypeStart > 0, "ContextReceiptSection 类型必须导出");
    assert(
      receiptSrc.includes(
        "export type ContextReceipt = ContextSectionsReceipt & {"
      ),
      "ContextReceipt 类型必须导出，供 turn/eval/报告复用"
    );
    assert.equal(
      receiptSrc.split("export const CONTEXT_RETRIEVAL_TOOL_NAMES = [").length - 1,
      1,
      "按需检索工具名单只能有一处定义"
    );
    // 类型声明区块 = 分节类型 + 收据类型；到工具名单为止，把渲染/装配代码排除在外。
    const receiptTypeBlock = receiptSrc.slice(
      sectionTypeStart,
      receiptSrc.indexOf("export const CONTEXT_RETRIEVAL_TOOL_NAMES = [")
    );
    // 只查**声明行**（跳过注释，与其它运行时代码扫描同一规矩）：注释里引一句
    // `text` 是在说明字符数的口径，不是承载正文的字段。
    const receiptDeclLines = receiptTypeBlock
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (t) =>
          t.length > 0 &&
          !t.startsWith("//") &&
          !t.startsWith("*") &&
          !t.startsWith("/*")
      );
    assert(
      receiptDeclLines.every((line) => !/\b(text|body|content|query|output)\b/.test(line)),
      "收据类型里不得出现任何正文/入参承载字段——收据只有名字与数字"
    );
    // **结构行**：类型头与闭合大括号。它们不承载任何字段，单独登记（且**逐个
    // 写死**：多出一个没登记的类型头——比如新起一个收据类型——照样当场失败），
    // 好让下面那条白名单**只管字段声明行**。
    const RECEIPT_STRUCTURAL_LINES = [
      "export type ContextReceiptSection = {",
      "export type ContextSectionsReceipt = {",
      "export type ContextRetrievalObservation = {",
      "export type ContextLanguageObservation = {",
      "export type ContextHistoryObservation = {",
      "export type ContextReceipt = ContextSectionsReceipt & {",
      "};",
    ];
    // 只可能出现在字段位置上；`};` 之外的未登记行一律判为字段并当场失败
    // （所以上面那几行之外，任何新行都不会被当成结构行放过去）。
    const receiptFieldLines = receiptDeclLines.filter(
      (line) => !RECEIPT_STRUCTURAL_LINES.includes(line)
    );
    // **精确白名单**：不是"检查有没有 text"，而是"只允许这几行存在"。多出任何
    // 一行（新的承载字段）都会当场失败，不用等有人想起来给它加一条负面断言。
    // 按需检索观测那三个字段（name / calls / returnedChars）就是在这里逐个审过的。
    const RECEIPT_FIELD_ALLOWLIST = [
      "id: string;",
      "chars: number;",
      "sections: ContextReceiptSection[];",
      "name: string;",
      "calls: number;",
      "returnedChars: number | null;",
      "retrievalObservations: ContextRetrievalObservation[];",
      // 语言判定那两个字段：都是**代码认识的枚举**（不是任意字符串），
      // 逐条审过才放进白名单——枚举的取值面由下面的运行时检查钉住。
      `language: "en" | "zh";`,
      `source: "direct" | "conversation-fallback" | "default";`,
      // 历史有界化：只允许五个有限非负计数，一个承载字段都没有。
      "consideredTurns: number;",
      "keptTurns: number;",
      "droppedTurns: number;",
      "keptChars: number;",
      "droppedChars: number;",
      "language: ContextLanguageObservation;",
      "history: ContextHistoryObservation;",
    ];
    assert(
      receiptFieldLines.every((line) => RECEIPT_FIELD_ALLOWLIST.includes(line)),
      `收据类型只允许这几行声明，出现了没审过的字段：${receiptFieldLines
        .filter((line) => !RECEIPT_FIELD_ALLOWLIST.includes(line))
        .join(" | ")}`
    );
    assert.equal(
      receiptFieldLines.length,
      RECEIPT_FIELD_ALLOWLIST.length,
      "收据类型的字段声明行必须与白名单逐条对应（少一条就是有字段被删了）"
    );
    // context.ts 只产出"分节那半"，不许再另立一套收据形状。
    const ctxSrc = readFileSync("lib/chat/coliving/context.ts", "utf8");
    assert(
      !ctxSrc.includes("export type ContextReceipt"),
      "收据类型只在纯模块 context-receipt.ts 定义，context.ts 不得另立一套"
    );
    // 分节收据由 buildContext 逐节收尾产出：12 个稳定分节 id（条件分节没出现就
    // 自然不进列表），字符数一律由 lines 切片算出来（不是把正文存起来）。
    assert.equal(
      ctxSrc.split("endSection(").length - 1,
      12,
      "12 个稳定分节各收尾一次（id 由代码写死）"
    );
    for (const id of [
      "unknowns",
      "now",
      "channel",
      "answering",
      "first-contact",
      "roster",
      "sender-landlord",
      "house-rules",
      "awaiting-replies",
      "open-cases",
      "standalone-positions",
      "recent-outbound",
    ]) {
      assert(
        ctxSrc.includes(`endSection("${id}")`),
        `稳定分节 id 必须写死：${id}`
      );
    }
    assert(
      ctxSrc.includes("chars: lines.slice(sectionStart).join(\"\\n\").length"),
      "字符数只能从已构建的行算出来，不许另存分节正文"
    );
    assert(
      ctxSrc.includes("receipt: { sections },"),
      "收据必须随 ColivingContext 一起返回"
    );

    // turn：只有主提示词那条路径带收据，其余路径显式 null。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(
      turnSrc.includes("contextReceipt: ContextReceipt | null;"),
      "TurnOutcome 必须带可空收据字段（null=本轮没走主提示词）"
    );
    assert.equal(
      turnSrc.split("contextReceipt: null,").length - 1,
      6,
      "六条不走主提示词的返回点都要显式 null（与 promptComposition 同一批）"
    );
    assert(
      turnSrc.includes("contextReceipt: {") &&
        turnSrc.includes("...ctx.receipt,") &&
        turnSrc.includes(
          "retrievalObservations: retrievalObservationsFrom(retrievalCallFootprints),"
        ),
      "主生成返回点必须带上 buildContext 的分节 + 本轮真跑过的按需检索足迹"
    );
    // 语言判定与历史有界化都挂在**同一条**主生成返回点上（都是"这一轮实际怎么
    // 发出请求"的观测）。两栏都只记枚举与计数：语言那栏是判定 + 来源，历史那栏
    // 是五个数字，一个字正文都不带——形状本身由纯类型定义，见下面的形状检查。
    assert(
      turnSrc.includes("language: observeLanguage(language),") &&
        turnSrc.includes("consideredTurns: historyPlan.consideredTurns,") &&
        turnSrc.includes("droppedChars: historyPlan.droppedChars,"),
      "语言判定与有界历史的计数必须随主生成回执带出（只记枚举与数字）"
    );
    assert(
      turnSrc.includes("retrievalObservationsFrom") &&
        turnSrc.includes("from \"./context-receipt\""),
      "按需检索足迹只能从纯模块的名单与纯函数里折出来，不在 turn.ts 里另写一份"
    );
    // 调用与返回按 `toolCallId` 配对：工具抛错时那一轮**没有** toolResult，
    // 按下标配对会把下一个返回安到上一个调用头上，字符数就记错了人。
    // 同时，返回内容在**当行**就折成数字（`returnedCharsOf`），装配数组里只留
    // 名字与数字——结构上不存在"读完还留着正文引用"的窗口。
    assert(
      turnSrc.includes("outputByCallId.set(toolResult.toolCallId, toolResult.output)") &&
        turnSrc.includes(
          "chars: output === undefined ? null : returnedCharsOf(output),"
        ),
      "工具返回必须按 toolCallId 配对，且当行折成数字（数组里不许留返回内容）"
    );
    // 装配数组的元素类型本身不许有承载字段：`RetrievalToolCall` 只有名字与数字。
    const footprintStart = receiptSrc.indexOf("export type RetrievalToolCall = {");
    assert(footprintStart > 0, "RetrievalToolCall 类型必须导出");
    const footprintFields = receiptSrc
      .slice(footprintStart, receiptSrc.indexOf("};", footprintStart))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (t) => t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
      );
    assert.deepEqual(
      footprintFields,
      ["export type RetrievalToolCall = {", "name: string;", "chars: number | null;"],
      "RetrievalToolCall 只能有 name / chars 两个字段——返回内容不许有承载字段"
    );
    // 收据附近不得出现运行时正文（`ctx.text`）、住户原话 / 工具入参
    // （`args.text`、`call.args`）或**原生工具调用对象**（`toolCalls`，每个都
    // 带着入参）。**禁词表没有任何例外**：装配数组 `retrievalCallFootprints`
    // 从一开始就只有名字与数字（返回内容在当行折成字符数，见上面那条与
    // `RetrievalToolCall` 的类型断言），所以这里不需要、也不许为任何标识符开口子。
    assert(
      !/contextReceipt[\s\S]{0,400}(ctx\.text|args\.text|toolCalls|call\.args)/.test(
        turnSrc
      ),
      "收据里不得出现运行时正文、住户原话或工具调用参数"
    );

    // eval：逐轮记录带进报告 JSON。
    const evalSrc = readFileSync("scripts/coliving-eval.ts", "utf8");
    assert(
      evalSrc.includes("contextReceipt: last.contextReceipt"),
      "逐轮记录必须把收据带进报告 JSON"
    );

    // 报告渲染：三态防御；坏节丢弃、坏字符数记未知；绝不放 NaN/undefined。
    assert.equal(
      normalizeContextReceipt(undefined),
      undefined,
      "旧报告字段缺席 → 不展示"
    );
    assert.equal(
      normalizeContextReceipt(null),
      null,
      "null = 本轮没构建上下文，不是 0 个分节"
    );
    assert.equal(
      normalizeContextReceipt({ sections: "不是数组" }),
      undefined,
      "形状不认识 → 不渲染"
    );
    // **样例机密正文**：刻意塞进收据对象（含检索观测）的额外字段，用来证明
    // 渲染不会带出正文。工具名位置上塞的是一段"名字"，名单外的名字一个都不留。
    const SAMPLE_SECRET = "样例机密正文-SHOULD-NOT-APPEAR-42";
    const normalized = normalizeContextReceipt({
      sections: [
        { id: "roster", chars: 128, text: SAMPLE_SECRET },
        { id: 7, chars: 10 },
        { id: "house-rules", chars: Number.NaN, statement: SAMPLE_SECRET },
      ],
      retrievalObservations: [
        { name: "recall", calls: 2, returnedChars: 640, query: SAMPLE_SECRET },
        { name: SAMPLE_SECRET, calls: 1, returnedChars: 10 },
        { name: "lookupHistory", calls: Number.NaN, returnedChars: -1 },
        { name: "findSimilarCases", calls: 1, returnedChars: Number.POSITIVE_INFINITY },
        { name: "recall", calls: 9, returnedChars: 9 },
      ],
    });
    assert.ok(normalized, "形状认识的收据要归一化");
    assert.deepEqual(
      normalized.sections,
      [
        { id: "roster", chars: 128 },
        { id: "house-rules", chars: null },
      ],
      "只取 id 与字符数：非字符串 id 丢弃，坏字符数记未知"
    );
    for (const s of normalized.sections) {
      assert.deepEqual(
        Object.keys(s),
        ["id", "chars"],
        "归一化后的分节只能有 id/chars 两个键"
      );
    }
    // 检索足迹只留代码写死名单里的名字；坏计数（NaN / Infinity / 负数）记未知。
    assert.deepEqual(
      normalized.retrievalObservations,
      [
        { name: "recall", calls: 2, returnedChars: 640 },
        { name: "lookupHistory", calls: null, returnedChars: null },
        { name: "findSimilarCases", calls: 1, returnedChars: null },
      ],
      "检索足迹只留名单里的名字、同名只留第一条，坏次数/坏字符数记未知"
    );
    for (const o of normalized.retrievalObservations ?? []) {
      assert.deepEqual(
        Object.keys(o),
        ["name", "calls", "returnedChars"],
        "归一化后的检索观测只能有 name/calls/returnedChars 三个键"
      );
      assert.ok(
        isContextRetrievalToolName(o.name),
        "归一化后的工具名必须仍在那份写死的名单里"
      );
    }
    // **旧报告兼容**：旧格式只有工具名列表、没有次数与字符数 → 名字照旧显示，
    // 两个数字记"未知"（不是 0，也不是"这一栏没了"）。
    assert.deepEqual(
      normalizeContextReceipt({
        sections: [],
        retrievalToolNames: ["recall", SAMPLE_SECRET, "lookupHistory"],
      })?.retrievalObservations,
      [
        { name: "recall", calls: null, returnedChars: null },
        { name: "lookupHistory", calls: null, returnedChars: null },
      ],
      "旧格式的工具名列表要照旧读出来，次数与字符数记未知"
    );
    // 旧报告连检索这一栏都没有 → 未知（不是"没跑检索"）。
    assert.equal(
      normalizeContextReceipt({ sections: [] })?.retrievalObservations,
      null,
      "缺检索那一栏 → 未知，不猜成空"
    );
    // 类型不对（不是数组）→ 未知；数组里坏条目丢弃，剩下的空列表就是"真没跑"。
    assert.equal(
      normalizeContextReceipt({ sections: [], retrievalObservations: 7 })
        ?.retrievalObservations,
      null,
      "不是数组 → 未知"
    );
    assert.deepEqual(
      normalizeContextReceipt({
        sections: [],
        retrievalObservations: [{ name: 7 }],
      })?.retrievalObservations,
      [],
      "名字不是字符串的条目丢弃，空数组 = 明确没跑检索"
    );

    // ── 折字符数：非字符串 / 数不出来的返回只记未知，绝不上抛 ─────────────
    // 真工具返回的是对象（不是字符串），所以字符数是**数出来的**：只数字符串与
    // 键名，标量不计；数不出来（函数 / symbol / 超深 / 超节点）记 null，不抛。
    assert.equal(returnedCharsOf("四个字"), 3, "字符串按自身长度算");
    assert.equal(
      returnedCharsOf({ who: "阿May", note: null, count: 3 }),
      "who".length + "阿May".length + "note".length + "count".length,
      "对象累加键名与字符串值，数字/null 不计（只数检索负担，不数标点）"
    );
    assert.equal(returnedCharsOf(undefined), 0, "undefined 本身没有字符串内容");
    const cycle: Record<string, unknown> = { a: "x" };
    cycle.self = cycle;
    assert.equal(
      returnedCharsOf({ fn: () => "SHOULD-NOT-APPEAR" }),
      null,
      "函数数不出来 → 未知（不调它、也不把它的返回值带出来）"
    );
    assert.equal(
      returnedCharsOf(cycle),
      null,
      "自引用对象撞到深度/节点边界 → 未知，不无限递归、不抛"
    );
    const throwingGetter: Record<string, unknown> = {};
    Object.defineProperty(throwingGetter, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter 抛错");
      },
    });
    assert.equal(
      returnedCharsOf(throwingGetter),
      null,
      "读不动的属性（抛错的 getter）→ 未知，绝不向上抛"
    );
    assert.equal(
      returnedCharsOf(Symbol("SHOULD-NOT-APPEAR")),
      null,
      "symbol / 函数 / bigint 数不出来 → 未知"
    );
    // 一次调用数不出来 → 这条工具整条记未知，**不拿偏小的和冒充总数**。
    assert.deepEqual(
      retrievalObservationsFrom([
        { name: "recall", chars: 120 },
        { name: "recall", chars: null },
      ]),
      [{ name: "recall", calls: 2, returnedChars: null }],
      "同一次工具只要有一次读不出字符数，整条记未知（次数照算）"
    );
    assert.deepEqual(
      retrievalObservationsFrom([
        { name: "lookupHistory", chars: 31 },
        { name: "recall", chars: 8 },
        { name: SAMPLE_SECRET, chars: 999 },
      ]),
      [
        { name: "lookupHistory", calls: 1, returnedChars: 31 },
        { name: "recall", calls: 1, returnedChars: 8 },
      ],
      "名单外的工具一个都不进观测，名单内的按写死顺序返回"
    );
    assert.deepEqual(
      retrievalObservationsFrom([]),
      [],
      "一次检索都没跑 → 空数组（明确没跑），不是未知"
    );
    assert(
      !JSON.stringify(
        retrievalObservationsFrom([{ name: "recall", chars: 12 }])
      ).includes(SAMPLE_SECRET),
      "折出来的观测里只剩名字与数字，带不出任何正文"
    );

    assert.equal(
      renderContextReceiptHtml(undefined),
      "",
      "旧报告不渲染收据块"
    );
    const receiptHtml = renderContextReceiptHtml(normalized);
    const rendered = [
      renderContextReceiptHtml(null),
      receiptHtml,
      renderContextReceiptHtml({ sections: [] }),
      renderContextReceiptHtml({}),
      renderContextReceiptHtml({ sections: [], retrievalObservations: [] }),
    ];
    for (const html of rendered) {
      assert(!html.includes("NaN"), "收据块绝不能渲染出 NaN");
      assert(!html.includes("undefined"), "收据块绝不能渲染出 undefined");
      assert(
        !html.includes(SAMPLE_SECRET),
        "渲染绝不能暴露分节正文或工具入参（样例机密文本不得出现）"
      );
    }
    // 紧凑列表：每行一个节 id + 字符数；未知字符数照实说"未知"。
    assert(
      receiptHtml.includes("<li>") &&
        receiptHtml.includes("roster") &&
        receiptHtml.includes("128"),
      "收据要渲染成紧凑列表：节 id + 字符数"
    );
    assert(
      receiptHtml.includes("house-rules") && receiptHtml.includes("未知"),
      "坏字符数显示为未知，不显示成 0"
    );
    // 按需检索足迹：名字 + 次数 + 数字符足迹。
    assert(
      receiptHtml.includes("recall") &&
        receiptHtml.includes("lookupHistory") &&
        receiptHtml.includes("640 字符"),
      "报告要列出本轮跑过的按需检索工具名、次数与返回字符数"
    );
    // 份额：只有一个已知分节时它占 100%（分母只算已知的那部分）。
    assert(receiptHtml.includes("100%"), "分节要给出占已知合计的份额");
    // 两种"没有"分得清：**真的没跑**说"（无"，**旧报告没记**说"未知"。
    const emptyRetrievalHtml = renderContextReceiptHtml({
      sections: [],
      retrievalObservations: [],
    });
    assert(
      emptyRetrievalHtml.includes("（无") && emptyRetrievalHtml.includes("0 次调用"),
      "没跑任何按需检索时明说无，不显示成未知"
    );
    assert(
      renderContextReceiptHtml({ sections: [] }).includes("旧报告没记这一栏"),
      "旧报告缺这一栏时明说是旧报告没记，不与'没跑检索'混为一谈"
    );

    // ── **一项都没记 ≠ 0**：旧版回执只记了工具名（次数/字符数全未知）──────
    // 这是最容易写错的一格：按 `(c ?? 0)` 求和会渲染出"共 0 次调用"，而事实
    // 是"跑了这两个工具、只是没记次数"——两者读起来正好相反。所以这里钉死：
    // 全未知时只写"未知"，一个 0 都不许出现。
    const legacyNamesHtml = renderContextReceiptHtml({
      sections: [{ id: "roster", chars: 128 }],
      retrievalToolNames: ["recall", "lookupHistory"],
    });
    assert(
      legacyNamesHtml.includes("recall") && legacyNamesHtml.includes("lookupHistory"),
      "旧格式的工具名照旧渲染（不能因为没记次数就连名字都不显示）"
    );
    assert(
      !legacyNamesHtml.includes("0 次调用") &&
        !legacyNamesHtml.includes("共 0 字符") &&
        legacyNamesHtml.includes("调用次数 未知") &&
        legacyNamesHtml.includes("不按 0 算"),
      "次数/字符数全未知时只许写未知，绝不许求和成 0（旧格式回执就吃这一格）"
    );
    // 分节那一半同理：全部节都没回报字符数时，合计也不许写成"0 字符"。
    const allUnknownSections = renderContextReceiptHtml({
      sections: [
        { id: "roster", chars: Number.NaN },
        { id: "house-rules", chars: Number.NaN },
      ],
      retrievalObservations: [],
    });
    assert(
      !allUnknownSections.includes("0 字符") &&
        allUnknownSections.includes("没有一节回报字符数"),
      "没有一节回报字符数时合计记未知，不写成 0 字符（份额也算不出来）"
    );
    // 对照：**部分**已知时下界照给（那是诚实的），别把这条修过头成一律未知。
    const partialKnown = renderContextReceiptHtml({
      sections: [{ id: "roster", chars: 128 }],
      retrievalObservations: [
        { name: "recall", calls: 2, returnedChars: 640 },
        { name: "lookupHistory", calls: Number.NaN, returnedChars: Number.NaN },
      ],
    });
    assert(
      partialKnown.includes("2（部分已知，是下界）") &&
        partialKnown.includes("640（部分已知，是下界）"),
      "有已知项时给下界并标'部分已知'——别把全未知的修法套到部分已知上"
    );

    // 报告页真的挂了这块（html 报告侧）：三块并进同一个面板，报告层不再自己
    // 分别调渲染器——口径只有一处。
    const reportSrc = readFileSync("scripts/coliving-report.ts", "utf8");
    assert(
      reportSrc.includes("renderContextEngineeringPanelHtml({") &&
        reportSrc.includes("contextReceipt: t.contextReceipt,") &&
        reportSrc.includes("turnLedger: t.turnLedger,"),
      "HTML 报告必须把提示词组成 / 收据 / 本轮账并进 Context Engineering 面板"
    );
  });

  /**
   * ── 评测产出成对：`.json` 旁边自动有一份同名 `.html` ────────────────────
   *
   * 渲染器**只有一处**（`scripts/coliving-report.ts` 的 `writeReportHtml`）。
   * 这条检查钉住两件在真实跑批里才会暴露的事：
   *  1. **导入不等于执行**：`coliving-eval` 是 `import` 这个模块来复用渲染器的，
   *     若 CLI 的 `main()` 在导入时无条件执行，跑批会中途被报告脚本抢走
   *     （读 `--report`、写文件、甚至 `process.exit`）。本闸自身就是活证据
   *     （它导入了这个模块还跑到了这里），这里再把守卫写成可读的断言；
   *  2. **真的成对落盘**：用真实的写出函数产出一对同名产物，并确认页面是
   *     自包含的（双击就能看，没有外链脚本）。
   *
   * 不跑模型、不连数据库、不发送；只在系统临时目录里写两个小文件。
   */
  check("评测报告成对产出：共用同一渲染器，导入不执行 CLI，落盘同名 .html", () => {
    const reportSrc = readFileSync("scripts/coliving-report.ts", "utf8");
    const evalSrc = readFileSync("scripts/coliving-eval.ts", "utf8");

    // ① 渲染器只有一处：报告脚本导出它，评测脚本 import 它（不 shell 出去、不复制）。
    assert(
      /export function writeReportHtml\(/.test(reportSrc) &&
        reportSrc.includes("renderReportHtml(results, sourcePath)"),
      "报告脚本必须导出唯一的写出函数 writeReportHtml"
    );
    assert(
      /import \{[^}]*writeReportHtml[^}]*\} from "\.\/coliving-report"/.test(evalSrc),
      "评测脚本必须 import 同一个渲染器，而不是另写一份 / 起子进程"
    );
    assert(
      !/child_process|execSync|spawnSync/.test(evalSrc),
      "评测脚本不得 shell 出去跑报告命令"
    );
    // ② CLI 必须留在直接执行的守卫后面——否则导入方一进来就被抢走。
    assert(
      /if \(isDirectRun\(\)\) \{\s*try \{\s*main\(\);/.test(reportSrc),
      "报告脚本的 CLI 必须只在直接执行时运行（import 不得触发 main）"
    );
    // ③ 同名规则只有一处：评测那边也必须用它取名，不许自己再拼一遍。
    assert(
      /export function reportHtmlPathFor\(/.test(reportSrc) &&
        evalSrc.includes("reportHtmlPathFor(reportPath)") &&
        evalSrc.includes('const reportPath = path.join(reportDir, `${stamp}.json`)'),
      "评测产出必须由同一个 stamp 出 .json、并用报告脚本的同名规则取名 .html"
    );
    assert(
      evalSrc.includes("writeReportHtml(htmlPath, results, reportPath)") &&
        evalSrc.indexOf("报告网页已写入") < evalSrc.indexOf("报告数据已写入"),
      "写完 JSON 后必须紧接着用同一份 results 写 HTML，且终端先打印网页路径"
    );

    // ④ 真的写一对出来（用真实写出函数，走真实的报告结构）。
    const tmp = mkdtempSync(path.join(tmpdir(), "coliving-pair-"));
    try {
      const jsonPath = path.join(tmp, "2026-01-01T00-00-00-000Z.json");
      const results = [{
        id: "pair-fixture",
        source: "离线夹具：只验产出成对，不是模型跑批结果",
        pass: true,
        failures: [],
        turns: [{
          fromName: "甲",
          fromRole: "resident",
          said: "提醒一下乙",
          reply: "好的。",
          toolsUsed: [],
          outbound: [],
        }],
        judge: { pass: true, verified: false, findings: [] },
        ms: 1,
      }];
      writeFileSync(jsonPath, JSON.stringify(results, null, 2), "utf8");
      // 走**评测那条路的同一个取名规则**，不在这里另写一条。
      const htmlPath = reportHtmlPathFor(jsonPath);
      writeReportHtml(htmlPath, results, jsonPath);

      assert(existsSync(htmlPath), "同名 .html 必须被写出来");
      assert.equal(
        path.basename(htmlPath).replace(/\.html$/, ""),
        path.basename(jsonPath).replace(/\.json$/, ""),
        ".html 必须与 .json 同名（同目录、同基名）"
      );
      const html = readFileSync(htmlPath, "utf8");
      assert(html.startsWith("<!doctype html>"), "页面必须是完整 HTML 文档");
      assert(html.includes("pair-fixture"), "页面必须渲染出这一次的场景");
      assert(
        !/<script[^>]+src=/i.test(html) && !/https?:\/\//.test(html.replace(/https?:\/\/www\.w3\.org/g, "")),
        "页面必须自包含：不引外链脚本 / CDN"
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  /**
   * ── 语言判定进回执：词汇表不许漂移、只认枚举、渲染不带正文 ──────────────
   *
   * 回执里那两栏（语言 / 历史）是**代码写死的枚举与计数**，报告 JSON 里塞什么
   * 字符串都进不了渲染。这条检查钉住三点：
   *  1. **词汇表一致性不靠比字符串**：直接跑语言层自己的判定（`decideLanguage`），
   *     再把判定交给回执层归一化，断言**原样认下来**——新增一种 source 却被回执
   *     静默丢掉，是这条设计真正的风险，只有跑一遍才证明得了；
   *  2. 名单外的值（`fr` / `telepathy` / 缺字段）整栏记**未知**，不猜一种语言；
   *  3. 渲染：认识的说人话、不认识的明说未知、真实的 0 照实写 0，且绝不出现
   *     NaN / undefined / 任何正文。
   */
  check(
    "语言判定进回执：三种来源 / 两种语言都能归一化，只认枚举、渲染不带正文",
    () => {
      const SAMPLE_SECRET = "SHOULD-NOT-SURVIVE-language";
      const decisions = [
        decideLanguage("Could you remind Alex not to run the dryer after 10 tonight?"),
        decideLanguage("提醒 Alex 晚上别用烘干机"),
        decideLanguage("ok", [
          { role: "assistant", content: "Should I book the 18:00-20:00 slot for you?" },
        ]),
        decideLanguage("ok", []),
      ];
      assert.deepEqual(
        [...new Set(decisions.map((d) => d.source))].sort(),
        ["conversation-fallback", "default", "direct"],
        "夹具必须真的覆盖三种判定来源，否则这条检查是空转"
      );
      assert.deepEqual(
        [...new Set(decisions.map((d) => d.language))].sort(),
        ["en", "zh"],
        "夹具必须覆盖两种语言"
      );
      for (const d of decisions) {
        const normalized = normalizeContextReceipt({
          sections: [],
          language: observeLanguage(d),
          history: {
            consideredTurns: 0,
            keptTurns: 0,
            droppedTurns: 0,
            keptChars: 0,
            droppedChars: 0,
          },
        });
        assert.ok(normalized, "形状认识的收据要归一化");
        assert.deepEqual(
          normalized.language,
          { language: d.language, source: d.source },
          "语言层产出的判定必须被回执层原样认下来（两套词汇表不许漂移）"
        );
        assert.deepEqual(
          Object.keys(normalized.language ?? {}).sort(),
          ["language", "source"],
          "语言那一栏只有判定与来源两个键"
        );
      }

      // 只认枚举：名单外的值整栏记未知，且不残留任何正文。
      assert.equal(
        normalizeContextReceipt({
          sections: [],
          language: { language: "fr", source: "telepathy", text: SAMPLE_SECRET },
        })?.language,
        null,
        "名单外的语言 / 来源整栏记未知，不替它猜一种语言出来"
      );
      assert.equal(
        normalizeContextReceipt({ sections: [], language: { language: "en" } })
          ?.language,
        null,
        "缺 source 也算形状不认识（不许半栏照收）"
      );
      assert.equal(
        normalizeContextReceipt({ sections: [], language: "en" })?.language,
        null,
        "整栏不是对象也记未知"
      );
      assert(
        !JSON.stringify(
          normalizeContextReceipt({
            sections: [],
            language: { language: "fr", source: "telepathy", text: SAMPLE_SECRET },
          })
        ).includes(SAMPLE_SECRET),
        "归一化后的回执不得残留任何正文"
      );

      const html = renderContextReceiptHtml({
        sections: [],
        language: { language: "en", source: "conversation-fallback" },
        history: {
          consideredTurns: 12,
          keptTurns: 8,
          droppedTurns: 4,
          keptChars: 900,
          droppedChars: 300,
        },
      });
      assert(
        html.includes("英文") && html.includes("conversation-fallback"),
        "渲染要给出认识的语言与来源"
      );
      assert(
        html.includes("12 条") && html.includes("8 条") && html.includes("4 条"),
        "渲染要给出历史的考虑 / 保留 / 丢弃条数"
      );
      assert(
        html.includes("900 字符") && html.includes("300 字符"),
        "渲染要给出历史的保留 / 丢弃字符数"
      );
      // **真实的 0 照实写 0**：一条没丢 != 没记这件事，两者不许糊成一个。
      const zero = renderContextReceiptHtml({
        sections: [],
        history: {
          consideredTurns: 3,
          keptTurns: 3,
          droppedTurns: 0,
          keptChars: 120,
          droppedChars: 0,
        },
      });
      assert(
        zero.includes("有界化丢掉 0 条") && zero.includes("丢掉 0 字符"),
        "真实的 0 要显示成 0，不许写成未知"
      );
      const legacy = renderContextReceiptHtml({ sections: [] });
      assert(
        legacy.includes("旧报告没记这一栏"),
        "旧报告缺这两栏时明说是没记，不猜语言、也不按 0 条算"
      );
      for (const out of [html, zero, legacy]) {
        assert(
          !out.includes("NaN") && !out.includes("undefined"),
          "回执块不许渲染出 NaN / undefined"
        );
        assert(!out.includes(SAMPLE_SECRET), "回执块不许带出任何正文");
      }
    }
  );

  /**
   * ── 对话历史有界化：只吃对话文本、只记数字、结构化事实不经它手 ────────────
   *
   * 这条政策的成立条件是"它**只**作用在主生成的消息数组上"。最有价值的反例
   * 不是"它会不会算错"，而是"它会不会哪天被接到结构化运行时事实上去"——
   * 那才是真的会删掉未结的事 / 现行规则 / 在等谁回话。所以这里同时钉住：
   *  1. 政策模块**零 import**（结构上碰不到 DB / 模型 / 出站，也就不可能新增
   *     一次模型调用），且只接受对话数组；
   *  2. `turn.ts` 里它只作用在 `history` 上，两处消息装配读同一份有界历史；
   *  3. 结构化运行时事实照旧走 `system` 那一路（`buildContext` 拼的 `runtime`），
   *     一个字都不经过这条政策；
   *  4. 计数进回执只记数字，对话正文一个字都不进。
   */
  check(
    "历史有界化：只作用在对话历史上（结构化运行时事实不经它手），计数进回执",
    () => {
      const policySrc = readFileSync(
        "lib/chat/coliving/history-policy.ts",
        "utf8"
      );
      assert.deepEqual(
        policySrc
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^import\b/.test(line) || /^} from /.test(line)),
        [],
        "history-policy.ts 必须零 import（纯函数，碰不到数据库 / 模型 / 出站）"
      );

      const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
      assert(
        turnSrc.includes("const historyPlan = planHistory(history, HISTORY_BUDGET);"),
        "有界化只能作用在对话历史上（不是 ctx.text / runtime）"
      );
      assert.equal(
        turnSrc.split("...boundedHistory,").length - 1,
        2,
        "主生成与强制补回复两条消息装配必须读同一份有界历史（口径不许分叉）"
      );
      assert(
        turnSrc.includes("language: observeLanguage(language),") &&
          turnSrc.includes("consideredTurns: historyPlan.consideredTurns,"),
        "语言判定与历史有界化都要随主生成回执带出"
      );
      // 结构化运行时事实（未结的事 / 现行规则 / 在等谁回话）照旧整份进 system：
      // 它们由 buildContext 拼成 `runtime`，压根不是这条政策的入参。
      assert(
        turnSrc.includes("system: buildGeneratorSystemMessages({") &&
          turnSrc.includes("runtime,") &&
          readFileSync("lib/chat/coliving/context.ts", "utf8").includes(
            "receipt: { sections },"
          ),
        "结构化运行时事实走 system 那一路（buildContext 的 runtime），不经过历史政策"
      );
      // 注释里点 `repo.getRecentTurns` / `buildContext` 是文档（说明它为什么存在），
      // 不算访问——只在去掉注释后的代码上查这些记号。
      const policyBody = policySrc
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(/\r?\n/)
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
      for (const forbidden of ["runtime", "repo.", "generateText", "await"]) {
        assert(
          !policyBody.includes(forbidden),
          `历史政策的代码里不许出现 ${forbidden}（结构化事实与模型调用都不是它的射程）`
        );
      }

      // 长历史：有界、最新一条留下、账目自洽；正文一个字都不进回执。
      const longHistory = Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `第${i}条 对话正文不该进回执 ${"x".repeat(300)}`,
      }));
      const plan = planHistory(longHistory, HISTORY_BUDGET);
      assert.ok(
        plan.keptTurns <= HISTORY_BUDGET.maxTurns &&
          plan.keptChars <= HISTORY_BUDGET.maxChars,
        "长历史必须收在预算内（以前没有任何体量上限）"
      );
      assert.equal(plan.kept.at(-1), longHistory.at(-1), "最新那条必须留下");
      assert.equal(
        plan.keptTurns + plan.droppedTurns,
        plan.consideredTurns,
        "保留 + 丢弃 = 考虑（回执里那三个数字必须自洽）"
      );
      const normalized = normalizeContextReceipt({
        sections: [],
        history: {
          consideredTurns: plan.consideredTurns,
          keptTurns: plan.keptTurns,
          droppedTurns: plan.droppedTurns,
          keptChars: plan.keptChars,
          droppedChars: plan.droppedChars,
        },
      });
      assert.deepEqual(
        normalized?.history,
        {
          consideredTurns: 40,
          keptTurns: plan.keptTurns,
          droppedTurns: plan.droppedTurns,
          keptChars: plan.keptChars,
          droppedChars: plan.droppedChars,
        },
        "有界化的计数原样进回执（只记数字）"
      );
      const historyHtml = renderContextReceiptHtml({
        sections: [],
        history: normalized?.history,
      });
      assert(
        !JSON.stringify(normalized).includes("不该进回执") &&
          !historyHtml.includes("不该进回执"),
        "回执与渲染都不得带出任何一条对话正文"
      );
      // 坏计数记未知，不显示成 0。
      const dirty = normalizeContextReceipt({
        sections: [],
        history: {
          consideredTurns: Number.NaN,
          keptTurns: -1,
          droppedTurns: "4",
          keptChars: Number.POSITIVE_INFINITY,
        },
      });
      assert.deepEqual(
        dirty?.history,
        {
          consideredTurns: null,
          keptTurns: null,
          droppedTurns: null,
          keptChars: null,
          droppedChars: null,
        },
        "坏计数一律记未知（不是 0）"
      );
      assert(
        !renderContextReceiptHtml({ sections: [], history: dirty?.history }).includes(
          "NaN"
        ),
        "坏计数渲染成未知，不许出现 NaN"
      );
    }
  );

  /**
   * ── 排班落锤短句：三处读同一个轮次语言判定，turn.ts 里不再写死中文 ────────
   *
   * 这条路径**模型根本没被调用**，所以它是语言闸最容易被代码兜底打穿的地方
   * （英文住户回一个 "ok"，收到的却是一句中文）。钉住两点：`turn.ts` 里不许再
   * 出现写死的中文落锤短句；两处装配读的都是**轮次判定**（含会话回退），
   * 而不是各自拿原话现推——同一个 "ok" 在两种会话下必须落成两种语言。
   */
  check(
    "排班落锤短句：两处装配都读轮次语言判定，turn.ts 里不再写死中文",
    () => {
      const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
      assert.equal(
        turnSrc.split("scheduleAffirmationReply(").length - 1,
        2,
        "短路闸与模型后收口两处都走同一个函数"
      );
      assert(
        !turnSrc.includes("好，${slot} 就定给你了。") &&
          !turnSrc.includes("好，时段定了，按这个来。"),
        "turn.ts 里不许再写死中文落锤短句（那等于把语言闸打穿）"
      );
      assert(
        turnSrc.includes("scheduleAffirmationReply(slot, language.language)"),
        "落锤短句读的是轮次判定，不是拿这一句原话现推"
      );
      // 同一个 "ok"，会话回退不同 → 两种语言；都读不出来 → 默认中文逐字不变。
      const enFallback = decideLanguage("ok", [
        { role: "assistant", content: "Should I book the 18:00-20:00 slot for you?" },
      ]);
      const zhFallback = decideLanguage("ok", [
        { role: "assistant", content: "那我把 18:00-20:00 这个时段定给你？" },
      ]);
      assert.equal(enFallback.source, "conversation-fallback");
      assert.equal(zhFallback.source, "conversation-fallback");
      assert.equal(scheduleAffirmationReply("18:00-20:00", enFallback.language), "Got it — 18:00-20:00 is yours.");
      assert.equal(scheduleAffirmationReply("18:00-20:00", zhFallback.language), "好，18:00-20:00 就定给你了。");
      assert.equal(
        scheduleAffirmationReply("18:00-20:00", decideLanguage("ok", []).language),
        "好，18:00-20:00 就定给你了。",
        "都读不出来时默认中文，与加语言闸之前逐字一致"
      );
    }
  );

  /**
   * ── 免费静态检查：分节收据只有安全 id + 有限计数，绝无 text/body ────────
   *
   * 上面那条 check 覆盖端到端渲染（含"样例机密正文"不被带出）。这条把**形状**
   * 单拎出来，不接模型、不接数据库、不写出站，纯读源码 + 纯函数归一化，钉死两点：
   *  1. `ContextReceiptSection` 的声明里没有 `text` / `body` 这类承载正文的字段
   *     （词边界匹配，避免误伤其它标识符里的子串）；
   *  2. 一个分节收据只保留「安全 id（非空字符串）+ 有限非负计数」，溢出/负数/NaN
   *     记为未知，非字符串 id 或空 id 直接丢弃——结构上带不出任意正文或 NaN。
   */
  check("上下文回执分节形状：无 text/body 字段，只有安全 id + 有限计数", () => {
    const src = readFileSync("lib/chat/coliving/context-receipt.ts", "utf8");
    const start = src.indexOf("export type ContextReceiptSection = {");
    assert(start > 0, "ContextReceiptSection 必须导出");
    const sectionType = src.slice(start, src.indexOf("};", start));
    // 只认**字段声明行**，其余一律忽略：空行、注释（说明字符数口径时会引 `text`，
    // 那不是承载字段）、类型声明头 `export type ... = {`、以及花括号本身。按换行 /
    // 花括号 / 分号切词，再用锚定正则只留 `标识符: 类型` 形态的字段——声明头与收尾
    // 括号无论怎么排版（单独一行、与字段同行）都不会被当成字段。
    const fieldLines = sectionType
      .split(/[\r\n{};]/)
      .map((t) => t.trim())
      .filter(
        (t) =>
          t.length > 0 &&
          !t.startsWith("//") &&
          !t.startsWith("*") &&
          !t.startsWith("/*") &&
          /^[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*[^;{}]+$/.test(t)
      )
      .map((t) => `${t};`);
    assert(
      fieldLines.every((line) => !/\b(text|body)\b/.test(line)),
      "ContextReceiptSection 不得有任何 text / body 之类的正文承载字段"
    );
    assert.deepEqual(
      fieldLines,
      ["id: string;", "chars: number;"],
      "ContextReceiptSection 只能有 id: string 与 chars: number 两个字段"
    );

    // 纯函数归一化：坏 id 丢弃；坏计数（NaN/Infinity/负数/字符串）记为未知，不是 0。
    const normalized = normalizeContextReceipt({
      sections: [
        { id: "roster", chars: 128, text: "SHOULD-NOT-SURVIVE", body: "SHOULD-NOT-SURVIVE" },
        { id: "now", chars: Number.POSITIVE_INFINITY },
        { id: "channel", chars: Number.NaN },
        { id: "house-rules", chars: -5 },
        { id: "", chars: 10 },
        { id: 7, chars: 10 },
      ],
    });
    assert.ok(normalized, "形状认识的收据要归一化");
    assert.deepEqual(
      normalized.sections,
      [
        { id: "roster", chars: 128 },
        { id: "now", chars: null },
        { id: "channel", chars: null },
        { id: "house-rules", chars: null },
      ],
      "只留安全 id + 有限计数：非字符串/空 id 丢弃，坏计数记为未知"
    );
    for (const s of normalized.sections) {
      assert.deepEqual(Object.keys(s), ["id", "chars"], "分节只能有 id 与 chars 两个键");
      assert.equal(typeof s.id, "string", "id 只能是字符串");
      assert.ok(
        s.chars === null || (Number.isFinite(s.chars) && s.chars >= 0),
        "chars 要么是有限非负数，要么是未知（null）"
      );
    }
  });

  /**
   * ── corpus-045 英文烘干机规则：合法语料 + 全英文住户轮次 + 只有主生成带安全回执 ──
   *
   * 这是英文响应层与上下文收据的**开发-验收环**（离线、确定性、不调模型）：
   *  1. 语料本身要合法——直接走 `validateScenario`，不在这里另立一套格式判断；
   *  2. 住户轮次必须真的是英文原话——直接复用语言层自己的判定
   *     （`residentLanguage`），**不在这里另写一套"按关键词猜语言"的业务逻辑**，
   *     也不翻译、不改写场景对话；
   *  3. 评测逐轮记录里的 `ContextReceipt` **只在主生成那条路径上有值**（早返回 /
   *     功能前门一律显式 null），结构上只可能有安全字段（id/chars + 代码认识的
   *     检索工具名），稳定分节非空。
   * **不硬编码任何模型句子**：整条检查只认语法结构与归一化后的形状。
   */
  check(
    "corpus-045 英文烘干机规则：语料合法、住户轮次全英文、只有主生成带安全回执",
    () => {
      const file =
        "lib/chat/coliving/evals/scenarios/corpus-045-english-dryer-rule-2026-09-20.json";
      const scenario = validateScenario(
        JSON.parse(readFileSync(file, "utf8")),
        file
      );
      assert.ok(scenario.turns.length > 0, "corpus-045 至少一轮住户原话");

      // 住户轮次全英文：直接用语言层自己的判定（`residentLanguage` 返回 "en"），
      // 不在这里另写一套按关键词猜语言的逻辑；被翻回中文（Han 字符）会立刻变 "zh"。
      for (const [i, t] of scenario.turns.entries()) {
        assert.ok(t.text.trim().length > 0, `corpus-045 turns[${i}] 不得为空`);
        assert.equal(
          residentLanguage(t.text),
          "en",
          `corpus-045 turns[${i}] 必须是英文住户原话（不得被翻译）`
        );
      }
      // 预置的住户可见历史用同一口径（都是住户看得到的英文正文）。
      for (const [i, m] of (scenario.setup?.priorMessages ?? []).entries()) {
        assert.equal(
          residentLanguage(m.body),
          "en",
          `corpus-045 setup.priorMessages[${i}] 必须是英文住户可见正文`
        );
      }

      // ── 回执只随主生成带出：早返回 / 功能前门显式 null ─────────────────
      const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
      assert(
        turnSrc.includes("contextReceipt: ContextReceipt | null;"),
        "回合结果必须带可空 ContextReceipt（null=没走主生成）"
      );
      assert.equal(
        turnSrc.split("contextReceipt: {").length - 1,
        1,
        "只有主生成那一条返回路径能带 ContextReceipt 对象"
      );
      assert.equal(
        turnSrc.split("contextReceipt: null,").length - 1,
        6,
        "六条非主生成返回点都必须显式 null（与 promptComposition 同一批）"
      );
      assert(
        turnSrc.includes("...ctx.receipt,") &&
          turnSrc.includes(
            "retrievalObservations: retrievalObservationsFrom(retrievalCallFootprints),"
          ),
        "主生成回执必须来自 buildContext 的分节 + 本轮真跑过的按需检索足迹"
      );

      // 评测（eval）逐轮记录：契约里有**文档化的可空** ContextReceipt 与逐轮账，
      // 且只从主生成结果的 `last.contextReceipt` 原样带进报告 JSON。
      const evalSrc = readFileSync("scripts/coliving-eval.ts", "utf8");
      assert(
        evalSrc.includes("contextReceipt: ContextReceipt | null;") &&
          evalSrc.includes("contextReceipt: last.contextReceipt,"),
        "评测逐轮记录必须沿用可空 ContextReceipt，并只从主生成结果带进报告"
      );
      assert(
        evalSrc.includes("turnLedger: TurnLedgerSummary | null;") &&
          evalSrc.includes(
            "turnLedger: summarizeTurnLedger(ledger.snapshot().generationRecords, i),"
          ),
        "评测逐轮记录必须按 turn 标签折出本轮账，而不是另起一套埋点"
      );
      // 报告：字段**可缺省**（旧报告不展示），原样透传给三态渲染。
      const reportSrc = readFileSync("scripts/coliving-report.ts", "utf8");
      assert(
        /contextReceipt\?: unknown;/.test(reportSrc) &&
          reportSrc.includes("contextReceipt: t?.contextReceipt,") &&
          /turnLedger\?: unknown;/.test(reportSrc) &&
          reportSrc.includes("turnLedger: t?.turnLedger,"),
        "报告契约必须把 ContextReceipt 与本轮账都标成可缺省（旧报告不展示）并原样透传"
      );

      // ── 只可能有安全字段：拿一份**故意塞进正文**的收据归一化 ───────────
      const SAMPLE_SECRET = "SHOULD-NOT-SURVIVE-corpus-045";
      const safe = normalizeContextReceipt({
        sections: [
          { id: "unknowns", chars: 120, text: SAMPLE_SECRET },
          { id: "now", chars: 42, body: SAMPLE_SECRET },
        ],
        retrievalObservations: [
          { name: "recall", calls: 1, returnedChars: 88, output: SAMPLE_SECRET },
          { name: SAMPLE_SECRET, calls: 1, returnedChars: 1 },
          { name: "not-a-tool", calls: 1, returnedChars: 1 },
        ],
      });
      assert.ok(safe, "形状认识的收据要归一化");
      assert.deepEqual(
        safe.sections,
        [
          { id: "unknowns", chars: 120 },
          { id: "now", chars: 42 },
        ],
        "归一化后只能留下安全字段 id/chars，正文与额外字段一律丢弃"
      );
      assert.deepEqual(
        safe.retrievalObservations,
        [{ name: "recall", calls: 1, returnedChars: 88 }],
        "检索足迹只留代码认识的名单，名单外字符串丢弃"
      );
      assert(
        !JSON.stringify(safe).includes(SAMPLE_SECRET),
        "归一化后的收据不得残留任何正文"
      );

      // ── 稳定分节非空：主生成回执的 sections 来自 buildContext ──────────
      const ctxSrc = readFileSync("lib/chat/coliving/context.ts", "utf8");
      assert(
        ctxSrc.includes("receipt: { sections },"),
        "分节回执必须随上下文一起返回（主生成回执的 sections 由此而来）"
      );
      // 顶层（两空格缩进）无条件收尾的稳定分节每轮都在 → sections 必然非空；
      // 条件分节是更深的缩进，没出现就不进列表。
      for (const id of [
        "unknowns",
        "now",
        "channel",
        "roster",
        "house-rules",
        "open-cases",
      ]) {
        assert(
          new RegExp(`^  endSection\\("${id}"\\);`, "m").test(ctxSrc),
          `主生成回执的非空稳定分节必须无条件收尾：${id}`
        );
      }
    }
  );

  /**
   * ── 逐轮账：按已有的 turn 标签折，且"没有主生成"与"0"必须分开 ──────────
   *
   * 这一栏的用途是让人比较各轮的上下文/生成负担，所以最要紧的不是数字好看，
   * 而是**三种状态分得清**：
   *  1. **没有主生成**（功能前门 / 状态机接管 / 未知号码 / 简单肯定短路）→
   *     `null`。这几条路径里有的确实调了模型（前门路由、写正文），但把它们
   *     算进"本轮主生成的上下文成本"会直接把结论带偏；
   *  2. **不可用**（旧报告没这个字段、或这一轮压根没记账）→ 也不出数字；
   *  3. **真实的 0**（跑过主生成、上游如实回报 0）→ 照实显示 0。
   *
   * 判据只看代码写死的 `stage === "main"`，**不靠"这一轮有没有记录"猜**——
   * 功能前门那一轮是有记录的（路由 + 写正文都带同一个 turn 标签）。
   * 全程纯函数 + 固定夹具，不接模型、不读数据库、不发任何请求。
   */
  check("逐轮账：按 turn 标签折，没有主生成记 null、真 0 才显示 0", () => {
    const step = (
      index: number,
      over: Partial<StepUsageRecord> = {}
    ): StepUsageRecord => ({
      index,
      inputTotalTokens: 1000,
      inputUncachedTokens: 200,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      outputTokens: 50,
      reasoningTokens: 10,
      costUsd: 0.001,
      finishReason: "stop",
      durationMs: null,
      providerId: "test-provider",
      upstreamProviderId: "test-upstream",
      generationId: "gen-test",
      requestId: "req-test",
      ...over,
    });
    const gen = (
      seq: number,
      stage: string,
      turnIndex: number | null,
      over: Partial<GenerationRecord> = {}
    ): GenerationRecord => ({
      seq,
      runId: "run-test",
      scenarioId: "scenario-test",
      turnIndex,
      stage,
      modelId: "test-model",
      operationKind: "text-generation",
      status: "completed",
      steps: [step(0)],
      completedSteps: 1,
      knownCostUsd: 0.001,
      unknownCostSteps: 0,
      unknownCost: false,
      durationMs: 12,
      transportAttempts: null,
      transportObservability: "不可观测",
      ...over,
    });
    /**
     * 第 1 轮（turnIndex 0）：主生成（两步：一次工具往返）×1 + 兜底补回复 ×1
     * + 工具里触发的向量化 ×1。**三种 stage 都带同一个轮标签**，所以"本轮
     * generation 数"本来就不等于"主生成数"。
     */
    const records: GenerationRecord[] = [
      // 第 2 轮：功能前门只调了路由与写正文，**没有主生成**。
      gen(0, "feature:route", 1),
      gen(1, "feature:qa", 1),
      gen(2, "main", 0, { steps: [step(0), step(1)], completedSteps: 2 }),
      gen(3, "forced-sendReply", 0, {
        steps: [],
        completedSteps: 0,
        knownCostUsd: 0,
      }),
      gen(4, "embed", 0, {
        operationKind: "embedding",
        steps: [],
        completedSteps: 0,
        knownCostUsd: 0,
      }),
      // 第 4 轮：跑了主生成，但上游没回报 token 与金额。
      gen(5, "main", 3, {
        steps: [step(0, { inputTotalTokens: null, costUsd: null })],
        knownCostUsd: 0,
        unknownCostSteps: 1,
        unknownCost: true,
      }),
      // judge 跑在轮外、不带轮标签 → 不属于任何一轮。
      gen(6, "judge", null, { knownCostUsd: 0.5 }),
    ];

    const turn0 = summarizeTurnLedger(records, 0);
    assert.ok(turn0, "第 1 轮有主生成 → 必须有账");
    assert.equal(turn0.mainGenerations, 1, "只数 stage=main 的那条");
    assert.equal(
      turn0.generations,
      3,
      "本轮 generation 含兜底补回复与工具内向量化（不是只有主生成）"
    );
    assert.equal(turn0.completedSteps, 2, "step 数按本轮所有 generation 累加");
    assert.equal(turn0.tokens.inputTotalTokens.known, 2000, "token 按已知项求和");
    assert.equal(turn0.tokens.inputTotalTokens.hasUnknown, false, "全部回报 → 完整");
    assert.equal(
      turn0.knownCostUsd,
      0.001,
      "金额按本轮已知项求和（兜底补回复与向量化在这里没花钱）"
    );
    assert.equal(
      turn0.tokens.cacheReadTokens.known,
      1600,
      "缓存读 token 同样按本轮累加（这一步决定优化该不该动缓存断点）"
    );

    // 功能前门那一轮：有记录、也有花掉的钱，但**没有任何主生成** → null。
    // 这里绝不能返回一个 `generations: 2` 的"账"，那会被读成"这轮主生成很便宜"。
    assert.equal(
      summarizeTurnLedger(records, 1),
      null,
      "只有功能前门路由/写正文的轮次没有主生成账（不是 0）"
    );
    // 压根没调模型的轮次（未知号码 / 短路 / 状态机接管）同样 null。
    assert.equal(summarizeTurnLedger(records, 2), null, "没有记录 → 没有这一层");
    // judge 不带轮标签，不会漏进任何一轮（也不该给它编一个轮号）。
    assert.equal(summarizeTurnLedger(records, 6), null, "轮外调用不属于任何一轮");

    // 上游没回报 token / 金额的那一轮：账在，但每一栏都标"部分已知"。
    const turn3 = summarizeTurnLedger(records, 3);
    assert.ok(turn3, "有主生成 → 有账，哪怕回报不全");
    assert.equal(turn3.tokens.inputTotalTokens.hasUnknown, true, "未回报 → 标未知");
    assert.equal(
      turn3.tokens.outputTokens.known,
      50,
      "同类 token 里已知的那部分照样求和"
    );
    assert.equal(turn3.unknownCostGenerations, 1, "未知花费的 generation 要计数");

    // ── 三态渲染：缺席 / null / 真 0 各说各的 ──────────────────────────
    assert.equal(renderTurnLedgerHtml(undefined), "", "旧报告不渲染本轮账");
    const noMain = renderTurnLedgerHtml(null);
    assert(
      noMain.includes("没有主生成账") && !noMain.includes("$0.000000"),
      "null 必须明说没有主生成账，绝不能渲染成 $0.000000"
    );
    assert.equal(
      normalizeTurnLedgerSummary(undefined),
      undefined,
      "字段缺席 = 旧报告，不展示"
    );
    assert.equal(normalizeTurnLedgerSummary(null), null, "null = 没有主生成");
    assert.equal(
      normalizeTurnLedgerSummary("不是对象"),
      undefined,
      "形状不认识 → 不渲染，避免把别的东西当成账"
    );
    // 已知金额这一栏没记（null）时不能借 0 显示成"没花钱"。
    const noCost = renderTurnLedgerHtml({
      generations: 1,
      mainGenerations: 1,
      completedSteps: 1,
      tokens: {},
      knownCostUsd: null,
      unknownCostGenerations: null,
    });
    assert(
      noCost.includes("未知") && !noCost.includes("$0.000000"),
      "金额没记 → 未知，不许补成 $0.000000"
    );
    // 真实的 0 照实显示 0，且不误标"未知"。
    const realZero = renderTurnLedgerHtml({
      generations: 1,
      mainGenerations: 1,
      completedSteps: 1,
      tokens: { outputTokens: { known: 0, hasUnknown: false } },
      knownCostUsd: 0,
      unknownCostGenerations: 0,
    });
    assert(
      realZero.includes("$0.000000") && !realZero.includes("下界"),
      "真 0 就显示 $0.000000（这是唯一该出现它的情形），也不误标成下界"
    );
    // 坏值（NaN / 负数 / 字符串）一律记未知，不渲染出 NaN。
    const dirty = renderTurnLedgerHtml({
      generations: Number.NaN,
      mainGenerations: -1,
      completedSteps: "3",
      tokens: { cacheReadTokens: Number.POSITIVE_INFINITY },
      knownCostUsd: Number.NaN,
      unknownCostGenerations: -2,
    });
    assert(
      !dirty.includes("NaN") && !dirty.includes("undefined"),
      "坏字段只能渲染成未知，不许出现 NaN / undefined"
    );

    // ── 面板：三块并排，全缺席时明说是旧格式报告 ──────────────────────
    const legacy = renderContextEngineeringPanelHtml({});
    assert(
      legacy.includes("旧格式报告") && legacy.includes("缺席"),
      "三块都缺席时明说是旧格式报告，不空白、也不当成 0"
    );
    const panel = renderContextEngineeringPanelHtml({
      promptComposition: {
        doctrineChars: 100,
        runtimeChars: 50,
        systemChars: 150,
        moduleIds: [],
        toolNames: [],
        toolCount: 0,
      },
      contextReceipt: {
        sections: [{ id: "roster", chars: 128 }],
        retrievalObservations: [
          { name: "recall", calls: 1, returnedChars: 640 },
        ],
      },
      turnLedger: turn0,
    });
    for (const piece of ["recall", "640 字符", "roster", "本轮已知花费"]) {
      assert(
        panel.includes(piece),
        `面板必须把三块观测并在一起（缺了：${piece}）`
      );
    }
    assert(
      panel.includes("不做正确性判断") || panel.includes("不构成"),
      "面板必须明说这只是观测，不做正确性判断、不构成改动依据"
    );
    assert(
      renderContextEngineeringPanelHtml({
        promptComposition: undefined,
        contextReceipt: undefined,
        turnLedger: turn0,
      }).includes("本轮已知花费"),
      "只有本轮账有值时照样渲染，其余两块缺席不影响"
    );
  });

  /**
   * ── 观测只进评测报告：生产持久化层一个字都不认识它们 ────────────────────
   *
   * 这份观测的存在理由就是"让人在评测报告里解释成本"，所以它**不许**变成
   * 生产数据：不落库、不进生产日志、不进住户可见文本、不参与决策。这条用
   * 两道独立的结构性证据钉死：
   *  1. **形状模块零 import**：`context-receipt.ts` 连一行 import 都没有，
   *     结构上碰不到数据库、模型、出站；
   *  2. **引用面白名单**：源码根（`lib/` / `scripts/` / `app/` / `components/`，
   *     `lib/db` 就在其中）里提到这些观测字段名的文件，只能是我逐个审过的
   *     那几个——运行时装配 + 评测脚本 + 报告渲染，**没有任何持久化 / 路由 /
   *     出站模块**。报告产物目录（`reports/`、`tests/coliving-eval/reports/`）
   *     不在扫描范围内：那是这份观测**该**出现的地方，不在"生产引用面"里。
   */
  check("逐轮观测不落生产：形状模块零 import，引用面只有白名单那几个文件", () => {
    const RECEIPT_MODULE = path.join(
      "lib",
      "chat",
      "coliving",
      "context-receipt.ts"
    );
    const receiptSrc = readFileSync(RECEIPT_MODULE, "utf8");
    const importLines = receiptSrc
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^import\b/.test(line) || /^} from /.test(line));
    assert.deepEqual(
      importLines,
      [],
      "context-receipt.ts 必须零 import（纯形状 + 纯函数），结构上碰不到数据库/模型"
    );

    // 只扫源码根：排除报告产物、依赖、构建产物与其它 worktree。
    const SKIP_DIRS = new Set([
      "node_modules",
      ".next",
      "dist",
      "build",
      "coverage",
      "reports",
    ]);
    const SEARCHED_EXT = /\.(ts|tsx|js|mjs|cjs|sql)$/;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          walk(p);
        } else if (SEARCHED_EXT.test(e.name)) {
          files.push(path.normalize(p));
        }
      }
    };
    for (const root of ["lib", "scripts", "app", "components"]) {
      if (existsSync(root)) walk(root);
    }
    assert.ok(files.length > 0, "源码扫描必须真的扫到文件（否则这条检查是空转）");

    const FIELD_NAMES = [
      "retrievalObservations",
      "retrievalToolNames",
      "turnLedger",
      "TurnLedgerSummary",
      "summarizeTurnLedger",
    ];
    // 白名单 = 形状定义 + 运行时装配 + 评测 runner + 报告渲染 + 这份检查本身。
    const ALLOWED = new Set(
      [
        RECEIPT_MODULE,
        path.join("lib", "chat", "coliving", "turn.ts"),
        path.join("lib", "chat", "coliving", "ledger-report.ts"),
        path.join("scripts", "coliving-eval.ts"),
        path.join("scripts", "coliving-report.ts"),
        path.join("scripts", "coliving-quality-inspect.ts"),
      ].map((f) => path.normalize(f))
    );
    const referencing = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return FIELD_NAMES.some((name) => src.includes(name));
    });
    const unexpected = referencing.filter((f) => !ALLOWED.has(f));
    assert.deepEqual(
      unexpected,
      [],
      `这些观测字段只许出现在白名单文件里，多出来的引用面要逐个审：${unexpected.join(", ")}`
    );
    // 白名单必须逐条对上：少一条说明这套观测已经从某个环节掉了（白名单变摆设）。
    assert.deepEqual(
      [...ALLOWED].filter((f) => !referencing.includes(f)),
      [],
      "白名单里每个文件都必须真的在引用这套观测"
    );
  });

  /**
   * ── outreach.ts 的裸 generateText 不在评测路径上 ───────────────────────
   *
   * outreach.ts 的 `compose()` 直接调 `generateText`，**没走**
   * `trackedGatewayCall`。要证明它不会在 coliving-eval 里发生：全仓扫 import
   * 形式，唯一 import 它的是独立 CLI `scripts/coliving-outreach.ts`
   * （`pnpm coliving:outreach`，跟评测 runner 无关）。评测路径上会调模型的
   * 三个模块（turn/critic/judge）都不 import 它，因此它的调用发不出去。
   * 只查 import 形式，不扫正文（注释/表名里出现 "outreach" 属正常）。
   */
  check("评测路径不含 outreach：其未纳管的 generateText 发不出", () => {
    const importRe = /(?:from\s*|import\(\s*)["']([^"']*\/outreach)["']/g;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name.startsWith(".")) continue;
          walk(p);
        } else if (/\.tsx?$/.test(e.name)) {
          files.push(p);
        }
      }
    };
    for (const root of ["lib", "scripts"]) walk(root);
    const importers = files
      .filter((f) => {
        importRe.lastIndex = 0;
        return importRe.test(readFileSync(f, "utf8"));
      })
      .map((f) => f.replace(/\\/g, "/"));
    assert.ok(
      importers.length > 0,
      "至少独立 CLI 应该 import outreach（否则这个扫描本身失效）"
    );
    for (const f of importers) {
      assert.equal(
        f,
        "scripts/coliving-outreach.ts",
        `只有独立 CLI 能 import outreach，评测路径不得依赖它：${f}`
      );
    }
  });

  /**
   * ── 短信是合租房唯一实时渠道（老板 2026-09-12 彻底放弃企业微信）─────────
   *
   * 目标不是"少一个渠道名"，而是**保证企业微信的运行路径真的没了**：
   * CHANNELS 不含 wecom、三条已知运行文件已删除、package 没有自检命令、
   * proxy 不再放行 /api/wecom，且 app/、lib/ 与 scripts/ 的非注释代码里不再
   * 出现 wecom/WECOM（本检查文件为写断言必须含该字面量，自身排除；解释
   * "已移除"的注释允许保留；迁移历史不属运行时，另行排除）。
   * Twilio 短信路由与个人物品受限提醒必须原样保留并可投递。
   */
  check("短信唯一：CHANNELS 只剩 web/sms，企业微信运行路径全部删除", () => {
    assert.deepEqual(
      [...CHANNELS],
      ["web", "sms"],
      "CHANNELS 只能含 web/sms（企业微信与小红书私信均已下线）"
    );
    for (const p of [
      "app/api/wecom/messages/route.ts",
      "lib/chat/wecom.ts",
      "scripts/wecom-selftest.ts",
    ]) {
      assert(!existsSync(p), `企业微信运行文件必须删除：${p}`);
    }
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    assert(
      !Object.keys(pkg.scripts ?? {}).some((k) => /wecom/i.test(k)),
      "package.json 不得再保留 wecom:* 命令"
    );
    const proxySrc = readFileSync("proxy.ts", "utf8");
    assert(!proxySrc.includes("/api/wecom"), "proxy.ts 不得再放行 /api/wecom");

    // 运行时正文扫描：app/、lib/、scripts/（排除迁移历史与本检查文件自身），
    // 只查非注释行，避免把"wecom 已移除"的说明性注释误判成残留运行路径。
    // 本检查文件必须写出 "/api/wecom"、wecom:* 等字面量才能断言"不得存在"，
    // 那是断言文本不是可达入口，故按路径排除。
    const selfPath = "scripts/coliving-quality-inspect.ts";
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name).replace(/\\/g, "/");
        if (e.isDirectory()) {
          if (
            e.name === "node_modules" ||
            e.name.startsWith(".") ||
            p.includes("lib/db/migrations")
          ) {
            continue;
          }
          walk(p);
        } else if (/\.tsx?$/.test(e.name) && p !== selfPath) {
          const lines = readFileSync(p, "utf8").split(/\r?\n/);
          lines.forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) {
              return;
            }
            if (/wecom/i.test(line)) hits.push(`${p}:${i + 1}`);
          });
        }
      }
    };
    walk("app");
    walk("lib");
    walk("scripts");
    assert.equal(
      hits.length,
      0,
      `运行时代码不得残留 wecom 调用/字面量：${hits.join(", ")}`
    );
  });

  /**
   * ── 小红书私信下线，房源采集与评论草稿保留（老板 2026-09-12 严格口径）───────
   *
   * 收窄的是"实时消息通道"：私信 adapter（/api/xhs/messages）、私信提示词与
   * 出站排版（lib/chat/xhs-dm.ts）、集简云出站（lib/chat/jijyun.ts）运行文件
   * 全部删除，`xhs` 只作为评论草稿的帖主身份命名空间留在 `ConversationSource`
   * 里，不再是 `CHANNELS` 的实时渠道。
   * 房源采集与帖子评论草稿是**其它产品能力，必须仍在**——不能连它们一起删掉。
   */
  check("小红书私信下线：私信/集简云运行文件已删除，房源采集与评论草稿保留", () => {
    for (const p of [
      "app/api/xhs/messages/route.ts",
      "lib/chat/xhs-dm.ts",
      "lib/chat/jijyun.ts",
      "lib/chat/redact-contact.ts",
    ]) {
      assert(!existsSync(p), `小红书私信运行文件必须删除：${p}`);
    }
    assert(
      !(CHANNELS as readonly string[]).includes("xhs"),
      "CHANNELS 不得含 xhs（私信通道已下线，xhs 只是评论草稿的身份命名空间）"
    );
    for (const p of [
      "app/api/xhs/rental-ingest/route.ts",
      "app/api/xhs/comment-reply/route.ts",
    ]) {
      assert(existsSync(p), `小红书房源采集/评论草稿路由必须保留：${p}`);
    }
    // 运行时代码不得残留私信专属标识（XHS_DM 模型名、JIJYUN 出站 webhook）。
    // 只查非注释行（本检查文件为写断言必须含这些字面量，按路径排除；
    // 解释"已移除"的注释允许保留；迁移历史不属运行时，另行排除）。
    const selfPath = "scripts/coliving-quality-inspect.ts";
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name).replace(/\\/g, "/");
        if (e.isDirectory()) {
          if (
            e.name === "node_modules" ||
            e.name.startsWith(".") ||
            p.includes("lib/db/migrations")
          ) {
            continue;
          }
          walk(p);
        } else if (/\.tsx?$/.test(e.name) && p !== selfPath) {
          const lines = readFileSync(p, "utf8").split(/\r?\n/);
          lines.forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) {
              return;
            }
            if (/XHS_DM|JIJYUN/i.test(line)) hits.push(`${p}:${i + 1}`);
          });
        }
      }
    };
    walk("app");
    walk("lib");
    walk("scripts");
    assert.equal(
      hits.length,
      0,
      `运行时代码不得残留小红书私信标识（XHS_DM / JIJYUN）：${hits.join(", ")}`
    );
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    assert(
      !Object.keys(pkg.scripts ?? {}).some((k) => /xhs.?dm|jijyun/i.test(k)),
      "package.json 不得再保留小红书私信命令"
    );
  });

  check("短信唯一：Twilio 投递路径与两项已批准功能仍保留（功能不是工具）", () => {
    const twilioSrc = readFileSync("app/api/twilio/messages/route.ts", "utf8");
    assert(
      twilioSrc.includes('channel: "sms"'),
      "Twilio 路由必须仍以 sms 渠道跑合租大脑"
    );
    assert(
      twilioSrc.includes("hasNewInboundSince") &&
        twilioSrc.includes("deliverWithGate"),
      "Twilio 短信投递的发送前竞态门禁必须保留"
    );
    // 功能前门：turn.ts 在 buildContext 之后、主生成之前，经一次白名单路由判定并直接办完。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(
      turnSrc.includes("runApprovedFeature(") && turnSrc.includes("finalizeFeatureTurn("),
      "两项已批准功能必须由 turn.ts 的功能前门接入（一次路由，不经工具调用）"
    );
    assert(
      !turnSrc.includes("sendRoommateMessage"),
      "共享短信工具已删，不得以任何形式回归 turn.ts"
    );
    // 清单写死在 features.ts；两个功能模块存在。
    const featureSrc = readFileSync("lib/chat/coliving/features.ts", "utf8");
    assert(
      featureSrc.includes("nightLaundryFeature") &&
        featureSrc.includes("personalItemFeature") &&
        featureSrc.includes("APPROVED_FEATURES"),
      "已批准功能清单必须写死在 features.ts"
    );
    assert(
      existsSync("lib/chat/coliving/night-laundry-reminder.ts") &&
        existsSync("lib/chat/coliving/personal-item-reminder.ts"),
      "两项功能各写各的朴素模块，必须存在"
    );
    // 纯代码投递层：收件人绑定 + 落库发送 + 发送硬闸。
    const deliverySrc = readFileSync("lib/chat/coliving/sms-delivery.ts", "utf8");
    assert(
      deliverySrc.includes("resolveNamedRecipient") &&
        deliverySrc.includes("deliverSms") &&
        deliverySrc.includes("assertCanWrite"),
      "sms-delivery.ts 必须是纯代码的收件人绑定 + 落库投递（过 assertCanWrite）"
    );
    // 旧共享工具模块已删除。
    assert(
      !existsSync("lib/chat/coliving/roommate-message.ts"),
      "旧架构的共享短信工具 roommate-message.ts 必须删除"
    );
  });



  check("名册登记：身份与居住是两件独立的事（纯事实层，含三态与合并规则）", () => {
    const f = membershipFacts;
    // **号码本身不说明任何一件事。** 不说居住 = 不知道（null），不是「住着」。
    assert.equal(f.residesFromInput(undefined), null, "不填居住必须是「不知道」");
    assert.equal(f.residesFromInput(null), null, "不填居住必须是「不知道」");
    assert.equal(f.residesFromInput("unknown"), null, "unknown 必须落成 null");
    assert.equal(f.residesFromInput("confirmed_lives"), true);
    assert.equal(f.residesFromInput("confirmed_not_living"), false);
    // 房东住自己房子 / 宿管不住这儿，两种都要能记 —— 角色不决定居住。
    assert.notEqual(
      f.residesFromInput("confirmed_lives"),
      f.residesFromInput("confirmed_not_living"),
      "三态必须真的分得开，不能都塌成同一个值"
    );
    // 角色标签与占位名逐个人话化，**不许把内部英文枚举值印进上下文**。
    for (const role of f.ROLES) {
      const label = f.roleLabel(role);
      assert.ok(label.length > 0, `${role} 缺人话标签`);
      assert.ok(!/^[a-z]+$/.test(label), `${role} 的标签不得直接是内部枚举值`);
      assert.ok(f.placeholderName(role, 2).length > 0, `${role} 缺占位名`);
    }
    assert.ok(
      !f.placeholderName("manager", 2).includes("住客"),
      "物业/宿管不得被叫成「2号住客」——占位名不能顺手断言身份与居住"
    );
    assert.ok(
      f.roleLabel("coordinator").includes("不是你"),
      "名册里的人类协调人必须与系统自己区分开"
    );
    // 合并规则：**明说的事实才覆盖，省略一律保留原值**。
    const known = { role: "manager", resides: false, note: "B栋宿管" } as const;
    assert.deepEqual(f.mergeMembershipFacts(known, {}), known, "再报一次号码不得抹掉已知事实");
    assert.deepEqual(
      f.mergeMembershipFacts(known, { role: "other", resides: null, note: "   " }),
      known,
      "「不知道」不是事实，不得盖掉已经知道的"
    );
    assert.deepEqual(
      f.mergeMembershipFacts(
        { role: "other", resides: null, note: null },
        { role: "manager", resides: false, note: null }
      ),
      { role: "manager", resides: false, note: null },
      "后来说明身份与居住必须能补进同一条关系"
    );
    // 摆在一起算人头：房东（住自己房子）+ 两个租客 = 3 个住户，
    // 物业有号码但不住这儿，不进这个数（口径同 `resides is not false`）。
    const roster = [
      { role: "landlord", resides: true },
      { role: "tenant", resides: true },
      { role: "tenant", resides: true },
      { role: "manager", resides: false },
      { role: "other", resides: null },
    ] as const;
    assert.equal(
      roster.filter((m) => m.resides !== false).length,
      4,
      "确认不住在这里的人不得被算成住户（号码不说明居住）"
    );
  });
  check("名册登记：addResident 不再把世界写死成「房东→租客→住在这里」", () => {
    const repo = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    const turn = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const start = repo.indexOf("export async function addResident(");
    assert(start > 0, "必须能定位 addResident");
    const body = repo.slice(start, repo.indexOf("── 成员变更（换人）", start));
    // 事实层是唯一来源，入库只转出去 —— 不在这里另写一套会漂移的判断。
    assert(repo.includes("export type { ResidenceInput, Role }"), "repo 必须转出纯模块的 Role / ResidenceInput");
    assert(body.includes("mergeMembershipFacts("), "已认识的人必须走合并规则，不覆盖已知事实");
    assert(body.includes("placeholderName("), "占位名必须按角色给（宿管不能叫「N号住客」）");
    assert(
      !/role \?\? "tenant"|"tenant", true/.test(body),
      "入库路径不得把角色默认成 tenant、也不得把居住默认成 true"
    );
    assert(
      /update coliving\.membership[\s\S]*valid_to is null/.test(body),
      "同一个人的补充信息必须 UPDATE 已有关系行，不得重复插一条"
    );
    // 三态居住输入与五档角色是工具边界上的事实，漏一个就静默回到老推论。
    for (const role of membershipFacts.ROLES) {
      assert(turn.includes(`"${role}"`), `addResident 的 role 取值必须含 ${role}`);
    }
    for (const input of membershipFacts.RESIDENCE_INPUTS) {
      assert(turn.includes(`"${input}"`), `addResident 的 residence 三态必须含 ${input}`);
    }
    assert(
      /只填对方真说过的|不猜|别猜|没说是谁就别填/.test(turn),
      "工具描述必须明说：身份与居住没听到就别猜"
    );
    assert(
      /宿管|物业/.test(turn) && /不是这栋房子的 AI 协调者|不在名册上|那不是你/.test(turn),
      "工具描述必须把宿管/物业与系统自己的协调者身份分开"
    );
  });
  check("名册登记：schema 与迁移放行 manager，且既有记录不被降级", () => {
    const base = readFileSync("lib/db/migrations/manual/coliving-world.sql", "utf8");
    assert(
      /role\s+text not null[\s\S]{0,120}'manager'/.test(base),
      "基础 schema 的 role check 必须含 manager"
    );
    const migration = "lib/db/migrations/manual/coliving-world-18.sql";
    assert(existsSync(migration), "必须新增顺序手动迁移 coliving-world-18.sql");
    const sql = readFileSync(migration, "utf8");
    assert(/check \(role in \([^)]*'manager'[^)]*\)\)/.test(sql), "迁移必须把 manager 加进 role check");
    assert(
      /drop constraint if exists membership_role_check/.test(sql),
      "迁移必须先 drop 旧 check，重复执行不出错"
    );
    assert(
      !/update coliving\.membership\s+set/.test(sql),
      "本批只放宽角色取值，不得改动任何已有行的 role / resides（不降级既有记录）"
    );
    assert(
      readFileSync("scripts/coliving-db.ts", "utf8").includes('"coliving-world-18.sql"'),
      "迁移必须接进 coliving-db 的执行清单，否则永远不生效"
    );
    // 同一人在同一栋房子同时只有一条生效关系 —— 「不重复登记」靠它兜着。
    assert(
      /create unique index if not exists membership_active_uniq[\s\S]*valid_to is null/.test(base),
      "membership_active_uniq 必须保留（不重复登记的唯一约束）"
    );
    // 场景语料：新增的登记边界场景必须结构合法（不跑付费评测，只校验形状）。
    const scenarioFile =
      "lib/chat/coliving/evals/scenarios/corpus-046-manager-not-resident-2026-09-21.json";
    const scenario = validateScenario(
      JSON.parse(readFileSync(scenarioFile, "utf8")),
      scenarioFile
    );
    assert(
      (scenario.people ?? []).some((p) => p.role === "manager" && p.resides === false),
      "登记边界场景必须真的写进一个「不住在这里的物业/宿管」"
    );
    assert(
      (scenario.people ?? []).some((p) => p.role === "landlord" && p.resides !== false),
      "登记边界场景必须保留「房东就住在这栋房子里」这个正常事实"
    );
  });

  /**
   * corpus-047 英文厨房交办：**语料形状 + 关键回归断言真的写进了场景**。
   *
   * 真实事故（2026-09-21）：住户用英文点名交办（「You tell him to clean up the kitchen
   * every time he finishes using it」），功能前门返回 `none`、路由又一条英文形态都没命中
   * → 这一轮只装了 conflict，`domain/relay.md` 根本不在提示词里；模型按投诉受理的五要素
   * 反过来追问「他什么时候用厨房、留下什么」，一条提醒都没发出去（decision 落成
   * reply_only）。本场景把这条原话冻成一条英文回归。
   *
   * 这里只做确定性断言：原话必须**按原话判成英文**（压过中文人名与会话历史）、场景必须
   * 结构合法，且五件事必须写进场景断言——真的调用 contactPerson 发给小五、不产生发给
   * 发信人阿泽的出站、出站保留「每次用完厨房就收拾」的动作与频次且不泄露来源、回信与
   * 出站是英文（除登记姓名 阿泽 / 小五 外不得有汉字），以及 2026-09-21 隔离实跑暴露的
   * 第五条：**一次性交办不留自主后续**（不许 `scheduleReminder`、回信不许许将来承诺）。
   * **它证明不了英文出站读起来自然、有没有把话说重**——那要留给 semantic judge 与
   * 人工逐轮阅读。
   */
  check("corpus-047 英文厨房交办：语料合法，且「联系小五 / 不泄露来源 / 保留动作频次 / 英文回信与出站 / 不留自主后续」写进断言", () => {
    const file =
      "lib/chat/coliving/evals/scenarios/corpus-047-english-kitchen-tidy-relay-2026-09-21.json";
    const scene = validateScenario(JSON.parse(readFileSync(file, "utf8")), file);
    const expect = scene.expect;
    assert.ok(expect, "corpus-047 必须带场景级 expect");
    assert.ok(
      scene.turns.length >= 1 &&
        scene.turns[0].text.includes("小五") &&
        /You tell him to clean up the kitchen every time he finishes using it/.test(
          scene.turns[0].text
        ),
      "corpus-047 第一轮必须是那条真实事故原话（点名小五 + 英文交办动词）"
    );
    // 原话自己就判得出英文：依据是**原话**，不是会话回退 / 默认中文——汉字（小五）
    // 不得把它拖进中文会话回退，否则英文住户收到中文回复。
    const firstTurn = decideLanguage(scene.turns[0].text);
    assert.equal(firstTurn.language, "en", "corpus-047 第一轮必须是英文轮次");
    assert.equal(firstTurn.source, "direct", "依据必须是原话本身，不是会话回退");

    // ① 真的联系小五、且不发给发信人——反问式 intake（decision 落 reply_only、
    //    零出站）会在这里露馅。
    assert.ok(
      (expect.mustUseTools ?? []).includes("contactPerson"),
      "corpus-047 必须要求真的调用 contactPerson——只回一句问句不算办到"
    );
    assert.ok(
      (expect.mustContactNames ?? []).includes("小五"),
      "corpus-047 必须要求有一条通过审稿的出站发给小五"
    );
    assert.deepEqual(
      expect.mustNotContactNames,
      ["阿泽"],
      "corpus-047 不得产生发给发信人阿泽的出站"
    );
    assert.ok(
      (expect.minAcceptedOutbound ?? 0) >= 1,
      "corpus-047 至少一条通过审稿的出站"
    );

    // ② 出站保留「厨房 + 每次用完就收拾」这个动作与频次：拿场景自己的正向断言跑几条
    //    样本正文——保留动作与频次的那条必须全中；丢掉收拾动作、或丢掉频次的那两条
    //    必须至少漏一条，否则这条回归挡不住「只发一句泛泛的提醒」。
    const out = expect.outboundMustMatch ?? [];
    const outPasses = (body: string): boolean =>
      out.length > 0 && out.every((p) => new RegExp(p).test(body));
    assert.ok(
      outPasses(
        "Hi 小五 — could you clean up the kitchen after each time you use it? Thanks."
      ),
      "corpus-047 出站断言必须放过一条保留收拾动作与「每次用完」频次的英文正文"
    );
    // 2026-09-21 一次实跑里，出站实际写的是 `after you use`——和 `after using` /
    // 「after each time」是同义的频次写法，此前没被收进来，导致一条全部达标（点名
    // 小五、无来源泄露、英文、保留收拾动作与频次）的正文被误判失败。这里把那条真实
    // 正文钉进样本，防止再把这条等价写法收窄回去。
    assert.ok(
      outPasses(
        "Hi 小五 — after you use the kitchen, please clean up after yourself: wipe the counter and put your dishes and things away. It's a shared kitchen and it's been getting left messy after use."
      ),
      "corpus-047 出站断言必须放过 `after you use` 这条与 `after using` 等价的频次写法"
    );
    for (const [label, body] of [
      [
        "收拾动作",
        "Hi 小五 — could you sort out the kitchen after each time you use it? Thanks.",
      ],
      ["「每次用完」的频次", "Hi 小五 — could you clean up the kitchen? Thanks."],
    ] as const) {
      assert.ok(
        !outPasses(body),
        `corpus-047 出站断言必须要求${label}——丢掉它就该判失败`
      );
    }
    // ③ 不泄露来源：不得出现来源人姓名，也不得把原话里对收信人的定性（搞乱厨房 /
    //    从来不收拾）转述出去——同样真跑一遍场景自己的反向断言。
    const outNo = expect.outboundMustNotMatch ?? [];
    const outLeaks = (body: string): boolean =>
      outNo.some((p) => new RegExp(p).test(body));
    assert.ok(
      outLeaks("Hi 小五 — 阿泽 asked me to pass this on. Please clean the kitchen."),
      "corpus-047 出站断言必须挡住来源人姓名「阿泽」"
    );
    assert.ok(
      outLeaks(
        "Hi 小五 — you always leave the kitchen dirty, please clean up after each use."
      ),
      "corpus-047 出站断言必须挡住转述对收信人的定性"
    );
    assert.ok(
      (expect.replyMustNotMatch ?? []).length >= 2,
      "corpus-047 回信至少要挡住「他什么时候用 / 留下什么」的盘问，以及写回中文"
    );

    // ④ 英文轮次：回信与出站各要有一条「除登记姓名（阿泽 / 小五）外不得出现汉字」的
    //    反向断言、和一条正面要求含英文词的断言。这里把场景里那条正则**真跑一遍**
    //    （不是把同一句话抄两遍）：只有登记姓名的英文正文必须放过，换成中文必须命中。
    const behaves = (p: string, hit: string, miss: string): boolean => {
      try {
        const r = new RegExp(p);
        return r.test(hit) && !r.test(miss);
      } catch {
        return false;
      }
    };
    for (const [field, label, enSample, zhSample] of [
      [
        "outboundMustNotMatch",
        "出站",
        "Okay — I've asked 小五 to clean the kitchen after each use.",
        "好，我已经让小五每次用完厨房都收拾干净。",
      ],
      [
        "replyMustNotMatch",
        "回信",
        "Thanks 阿泽, I passed it on.",
        "好，我已经跟小五说过了。",
      ],
    ] as const) {
      assert.ok(
        (expect[field] ?? []).some((p) => behaves(p, zhSample, enSample)),
        `corpus-047 ${label}必须有一条「除登记姓名（阿泽 / 小五）外不得出现汉字」的反向断言`
      );
    }
    for (const [field, label] of [
      ["outboundMustMatch", "出站"],
      ["replyMustMatch", "回信"],
    ] as const) {
      assert.ok(
        (expect[field] ?? []).some((p) => behaves(p, "I will do it now.", "好，我现在就去办。")),
        `corpus-047 ${label}必须有一条正面要求「正文含真正的英文词」的断言`
      );
    }

    // ⑤ **一次性交办不留自主后续**（2026-09-21 隔离实跑暴露的过度帮忙）：办完这一件
    //    之后，那一次实跑又调了两次 `scheduleReminder`，回信也写了「I'll check back
    //    with you in a couple weeks」。这两样都不是住户交办的，所以场景必须把
    //    「不许排自主的将来动作」「回信不许许将来承诺」都钉成断言。这里不只查字段在不在，
    //    还**真跑一遍**：那条实跑里写出来的正文必须命中，一句只有「已联系 + 在等回话」
    //    的短回执必须放过——否则这条加严会连合格回执一起误杀。
    for (const tool of ["proposeRule", "scheduleReminder"] as const) {
      assert.ok(
        (expect.mustNotUseTools ?? []).includes(tool),
        `corpus-047 必须禁止 ${tool}——一次性交办办完就停，不再排规则或自主的将来动作`
      );
    }
    const cleanReceipt =
      "Done — I've asked 小五 to clean up the kitchen after each use. Waiting to hear back.";
    for (const [label, offending] of [
      [
        "带时点的将来回访承诺",
        "I've passed it on to 小五. I'll check back with you in a couple weeks.",
      ],
      ["不带时点的将来承诺", "Passed it on to 小五 — will follow up with you later."],
    ] as const) {
      assert.ok(
        (expect.replyMustNotMatch ?? []).some((p) => behaves(p, offending, cleanReceipt)),
        `corpus-047 回信断言必须挡住${label}，同时放过一句只有「已联系 + 在等回话」的短回执`
      );
    }
  });

  console.log(`${count} offline checks passed (not a live conversation-quality certification).`);

  const reportIndex = process.argv.indexOf("--report");
  if (process.argv.includes("--judge") || reportIndex >= 0) {
    config({ path: ".env.local", quiet: true } as Parameters<typeof config>[0]);
    config({ path: ".env", quiet: true } as Parameters<typeof config>[0]);
    if (reportIndex >= 0) {
      const reportPath = process.argv[reportIndex + 1];
      assert(reportPath, "--report requires a path");
      // Redact contacts before parsing or transmitting any historical material.
      const redactContacts = (s: string) => s.replace(/\+?\d[\d ()-]{8,}\d/g, (m) => m.replace(/\D/g, "").length >= 10 ? "[已移除联系方式]" : m);
      const redacted = redactContacts(readFileSync(reportPath, "utf8"));
      const records = JSON.parse(redacted) as Array<{ id: string; turns: JudgeTurn[]; [key: string]: unknown }>;
      // This is a re-audit of historical generated text, never a new generation run.
      for (const record of records) {
        const names = [...new Set(record.turns.flatMap((t) => [t.fromName, ...t.outbound.map((o) => o.toName)]))].filter(Boolean);
        let safeTurns = JSON.stringify(record.turns.map(({ fromName, said, reply, outbound }) => ({ fromName, said, reply, outbound: outbound.map(({ toName, text, blocked }) => ({ toName, text, blocked })) })));
        for (const [i, name] of names.sort((a, b) => b.length - a.length).entries()) {
          safeTurns = safeTurns.split(name).join(`参与者${i + 1}`);
        }
        record.turns = JSON.parse(safeTurns);
        assert.equal(redactContacts(safeTurns), safeTurns, "contact redaction failed");
        record.judge = await judgeConversation({ scenarioId: record.id, source: "历史对话重新验收；判断协调是否有效、是否尊重已知限制、联系状态是否如实。不是新版本生成结果。", roster: [], turns: record.turns });
        record.source = "历史对话重新验收（不是新版本生成结果）";
        console.log(JSON.stringify({ id: record.id, judge: record.judge }));
      }
      const output = reportPath.replace(/\.json$/i, "-reaudit.json");
      assert.notEqual(output, reportPath, "input must end in .json");
      writeFileSync(output, JSON.stringify(records, null, 2));
      return;
    }
    const good: JudgeTurn[] = [{
      fromName: "小林", said: "我18点到家，做饭要两小时，另外两位各用半小时。",
      reply: "18点到家不代表一定要18点开始。两小时都放在前面，会让其他人一直等。我建议先让两位各用半小时，再留给你连续两小时；这个顺序还要征求大家同意。我已经分别发出了征求意见的消息，等大家回复再确认。",
      outbound: [
        { toName: "小周", text: "厨房先给你和另一位各留半小时，再给需要久一点的住户连续两小时。你愿意先用吗？", blocked: false },
        { toName: "小陈", text: "厨房先给你和另一位各留半小时，再给需要久一点的住户连续两小时。你愿意先用吗？", blocked: false },
      ],
    }];
    for (const [id, turns, expected] of [["false-completion", bad, false], ["reasonable-proposal", good, true]] as const) {
      const result = await judgeConversation({ scenarioId: id, source: "脱敏离线验收器对照，不是生产重放", roster: [], turns: [...turns] });
      console.log(JSON.stringify({ id, ...result }));
      assert.equal(result.verified, true, `${id}: judge unavailable`);
      assert.equal(result.pass, expected, `${id}: wrong semantic verdict`);
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
