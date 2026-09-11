/** Offline regression by default; --judge additionally checks sanitized traces with the real judge.
 * No database imports, no send path. Run with NODE_OPTIONS=--conditions=react-server.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { finalizeJudgment, judgeConversation, type JudgeTurn } from "../lib/chat/coliving/evals/judge";
import { bestSchedulePlans } from "../lib/chat/coliving/scheduling";
import {
  countAcceptedOutbound,
  evaluateReplyReview,
  evaluateTurnReplyReviews,
  validateScenario,
} from "../lib/chat/coliving/evals/schema";
import {
  buildGeneratorSystemMessages,
  claimsContactCompletion,
  checkProcessNarration,
  extractExplicitFixedStart,
  extractPreferredStart,
  extractSlotFromInquiry,
  hasDeferredCoordination,
  isLowInformationFollowUp,
  isOpenConflictCase,
  isPrematureCapacityEscape,
  isPureNoticeReply,
  isScheduleFairnessObjection,
  isScheduleSlotInquiry,
  isSimpleAffirmation,
  scheduleContactTextForAct,
  scheduleInquiryConfirmation,
  scheduleSlotMatchesSelfStatement,
} from "../lib/chat/coliving/turn";
import {
  criticModelId,
  hasSafetySensitiveTopic,
} from "../lib/chat/coliving/critic";
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

const TOOL_DECL_NAMES = [
  "sendReply", "decide", "logEvent", "contactPerson", "proposeRule",
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
  check("failed or unverified reply review cannot pass the eval gate", () => {
    assert.deepEqual(evaluateReplyReview(undefined).length, 1);
    assert.deepEqual(
      evaluateReplyReview({ verified: false, pass: true, broke: "", why: "模型超时" }).length,
      1
    );
    assert.deepEqual(
      evaluateReplyReview({ verified: true, pass: false, broke: "2", why: "编造事实" }).length,
      1
    );
    assert.deepEqual(
      evaluateReplyReview({ verified: true, pass: true, broke: "", why: "" }),
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
  check("process-narration gate is wired into checkFactFidelity", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(src.includes("export function checkProcessNarration("), "turn.ts 必须导出 checkProcessNarration");
    const ffIdx = src.indexOf("function checkFactFidelity(");
    assert(ffIdx > 0, "checkFactFidelity 必须存在");
    const ffBody = src.slice(ffIdx, src.indexOf("const factFidelityHit", ffIdx));
    assert(ffBody.includes("checkProcessNarration(text)"), "checkFactFidelity 必须调用 checkProcessNarration");
    assert(
      ffBody.indexOf("checkProcessNarration(text)") > ffBody.indexOf("checkIncompleteConflictTurn(text)"),
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
    assert(src.includes("contacted.delete(msg.personId)"));
    assert(src.includes("bestSchedulePlans(windowStartMinutes, constraints, 5)"));
    assert(src.includes("const finalNeedsAction ="));
    assert(src.includes("await critiqueAndMarkOutbound(finalNewOutbound)"));
    assert(src.includes('position.kind !== "commitment"'));
    assert(src.includes("ctx.openCases.some(isOpenConflictCase)"));
    assert(!src.includes("!topicHitsConflict ||\n      !toolsUsed.includes(\"recordPosition\")"));
    assert(src.includes("const needsBlockedOutboundRecovery ="));
    assert(src.includes("isGeneratedResidentName(target.name)"));
    assert(src.includes("const redoFactFidelityHit = checkFactFidelity(reply)"));
    assert(src.includes("const finalFactFidelityHit = checkFactFidelity(reply)"));
    assert(src.includes("function checkUnconsultedSelectedSchedule()"));
    assert(src.includes("const unconsultedSchedule = checkUnconsultedSelectedSchedule()"));
    assert(src.includes("if (o.scheduleVerified)"));
  });
  check("6.5/6.6/6.7 schedule brkes enter the full-toolset rewrite", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    // 1) needsScheduleRecompute 具名布尔必须由三个调度正确性 rule id 构成。
    //    这类打回的修法是重新真算 pickSchedule→chooseSchedule，不是换措辞；
    //    只给 sendReply 会让模型把编造的时段原样再交一遍。
    const schedIdx = src.indexOf("const needsScheduleRecompute =");
    assert(schedIdx > 0, "必须存在 needsScheduleRecompute 布尔");
    const schedDecl = src.slice(schedIdx, src.indexOf(";", schedIdx));
    for (const id of ["6.5", "6.6", "6.7"]) {
      assert(schedDecl.includes(`"${id}"`), `needsScheduleRecompute 必须由 ${id} 构成`);
    }
    // 2) 首轮打回重写：isBrokenPromise 必须并入 needsScheduleRecompute，否则
    //    6.5/6.6/6.7 命中时 redoTools 还是只有 sendReply。
    const promiseIdx = src.indexOf("const isBrokenPromise =");
    assert(promiseIdx > 0, "isBrokenPromise 必须存在");
    const promiseDecl = src.slice(promiseIdx, src.indexOf(";", promiseIdx));
    assert(promiseDecl.includes("needsScheduleRecompute"),
      "isBrokenPromise 必须并入 needsScheduleRecompute");
    // 3) 最后一次聚焦修正：finalNeedsAction 也要把三个 id 算进完整工具集条件，
    //    否则重写后仍被 6.5/6.6/6.7 打回时只剩 sendReply、照样救不回来。
    const finalIdx = src.indexOf("const finalNeedsAction =");
    assert(finalIdx > 0, "finalNeedsAction 必须存在");
    const finalDecl = src.slice(finalIdx, src.indexOf(";", finalIdx));
    for (const id of ["6.5", "6.6", "6.7"]) {
      assert(finalDecl.includes(`"${id}"`), `finalNeedsAction 必须把 ${id} 算作需要完整工具集`);
    }
    // 4) 完整工具集重写里真的带排班工具，模型才可能在重写时真算一遍。
    for (const toolConst of ["const redoTools", "const finalTools"]) {
      const toolsIdx = src.indexOf(toolConst);
      assert(toolsIdx > 0, `${toolConst} 必须存在`);
      const toolsBlock = src.slice(toolsIdx, src.indexOf("};", toolsIdx));
      assert(toolsBlock.includes("pickSchedule: tools.pickSchedule"), `${toolConst} 必须含 pickSchedule`);
      assert(toolsBlock.includes("chooseSchedule: tools.chooseSchedule"), `${toolConst} 必须含 chooseSchedule`);
    }
    // 5) 调度正确性打回的重写提示词必须指示"真的调 pickSchedule 重算"，
    //    而不是只让模型换个说法。
    const redoPromptIdx = src.indexOf("这次打回的是调度正确性：");
    assert(redoPromptIdx > 0, "重写提示必须带调度正确性专段");
    assert(
      src.includes("现在真的调 `pickSchedule`") && src.includes("重新算一版"),
      "调度正确性打回的重写提示必须指示真的调 pickSchedule 重算"
    );
  });
  check("contactPerson skips duplicate open messages across turns", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const repo = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    assert(repo.includes("export async function findRecentOpenCommunication"));
    assert(repo.includes("status in ('queued', 'sent')"));
    assert(repo.includes("responded_at is null"));
    assert(src.includes("const recentlyCovered = new Map"));
    assert(src.includes("await repo.findRecentOpenCommunication"));
    assert(src.includes("这次不重复发送"));
    assert(src.includes("for (const covered of recentlyCovered.values())"));
  });
  check("sent communications retain provider message ids", () => {
    const twilioRoute = readFileSync("app/api/twilio/messages/route.ts", "utf8");
    const cronRoute = readFileSync("app/api/cron/coliving/route.ts", "utf8");
    const deliver = readFileSync("lib/chat/coliving/deliver.ts", "utf8");
    assert(twilioRoute.includes("externalMessageId: sent.ok ? sent.sids.join"));
    assert(deliver.includes("externalMessageId: result.sids.join"));
    assert(cronRoute.includes("externalMessageId: outcome.ok ? outcome.externalMessageId : null"));
  });

  // ── 并发竞态门禁 ────────────────────────────────────────────────────────────
  check("stale-context gate: repo has hasNewInboundSince, turn.ts calls it before send", () => {
    const repo = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    // repo 必须有这个函数
    assert(repo.includes("export async function hasNewInboundSince"));
    assert(repo.includes("m.direction = 'inbound'"));
    assert(repo.includes("m.sent_at > ${since}"));
    // turn.ts 必须在 contacted.add 之前调用它
    assert(src.includes("await repo.hasNewInboundSince("));
    assert(src.includes("turnStartedAt"));
    assert(src.includes("stale: true"));
    // 跳过的消息不能加进 outbound（stale gate 里没有 outbound.push）
    const staleBlock = src.slice(
      src.indexOf("const targetHasNewInbound"),
      src.indexOf("contacted.add(target.personId)")
    );
    assert(!staleBlock.includes("outbound.push"), "stale-skipped message must not enter outbound");
  });

  // ── 自报精确时段不再征询 ────────────────────────────────────────────────────
  check("saidExactSlot schema exists in pickSchedule people and selfStatedSlotsByWindow is tracked", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(src.includes("saidExactSlot"));
    assert(src.includes("selfStatedSlotsByWindow"));
    // 自报时段立即 return skipped:true，不发任何消息（不用通知语气，也不用征询语气）
    assert(src.includes("preConsented: true") && src.includes("skipped: true"), "self-stated slot must return preConsented+skipped");
    // 预同意分支不能调用 queueCommunication——限定在 enqueueScheduleContact 内断言：
    // 两个 preConsented return（自报精确时段 / 持久已确认同一 slot）都必须先于
    // 该函数的发送 queueCommunication（不能只靠全文件前缀——短路分支也含
    // queueCommunication，但那是对住户本人的回复落库，与预同意跳过无关）。
    const enqueueStartIdx = src.indexOf("async function enqueueScheduleContact(");
    const preConsentedIdx = src.indexOf("preConsented: true", enqueueStartIdx);
    const enqueueSendQueueIdx = src.indexOf(
      "const communicationId = await repo.queueCommunication(",
      enqueueStartIdx
    );
    assert(enqueueStartIdx > 0, "enqueueScheduleContact 必须存在");
    assert(preConsentedIdx > enqueueStartIdx, "preConsented return 必须在 enqueueScheduleContact 内");
    assert(enqueueSendQueueIdx > 0, "enqueueScheduleContact 的发送 queueCommunication 必须存在");
    assert(preConsentedIdx < enqueueSendQueueIdx,
      `preConsented return（@${preConsentedIdx}）必须先于发送 queueCommunication（@${enqueueSendQueueIdx}）`);
    // 非自报时段仍走征询
    assert(src.includes("你愿意吗"), "non-self-stated slot still asks for confirmation");
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
    // 覆盖模板已整体删除：当前说话人的回复正文只由大脑 sendReply / 审稿重写交付。
    assert(!src.includes("buildSelectedScheduleReply"), "buildSelectedScheduleReply 必须已删除");
    assert(!src.includes("buildContactProgressReply"), "buildContactProgressReply 必须已删除");
    // renderBaseFacts 的"本轮调用的工具"之后必须注入公平质疑信号（提示轮换/重议）——
    // 代码只给信号、不给成品句，措辞由大脑看着办。
    const renderStart = src.indexOf("const renderBaseFacts = () =>");
    const renderEnd = src.indexOf("const outboundNames = new Map(", renderStart);
    assert(renderStart > 0 && renderEnd > renderStart, "renderBaseFacts 必须可定位");
    const renderFactsRegion = src.slice(renderStart, renderEnd);
    assert(renderFactsRegion.includes("isScheduleFairnessObjection(args.text)"),
      "renderBaseFacts 必须用 isScheduleFairnessObjection(args.text) 注入公平质疑信号");
    assert(renderFactsRegion.includes("应提议轮换或重新协商"),
      "公平质疑信号必须提示提议轮换/重新协商，别用谁先提出/谁先回复排先后");
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
  check("scheduleSlotMatchesSelfStatement: exact match is preconsented, any mismatch is not", () => {
    // 自报时段与选定时段完全相等 → 视为预先同意，不再发征询。
    assert.equal(
      scheduleSlotMatchesSelfStatement({ start: "07:15", end: "07:25" }, { start: "07:15", end: "07:25" }),
      true,
      "完全相同应返回 true"
    );
    // start 不同（算法把开始时间挪晚了）→ 不命中
    assert.equal(
      scheduleSlotMatchesSelfStatement({ start: "07:30", end: "07:40" }, { start: "07:15", end: "07:40" }),
      false,
      "start 不同应返回 false"
    );
    // end 不同（时长被改了）→ 不命中
    assert.equal(
      scheduleSlotMatchesSelfStatement({ start: "07:15", end: "07:25" }, { start: "07:15", end: "07:35" }),
      false,
      "end 不同应返回 false"
    );
    // 没有自报记录（undefined）→ 不命中
    assert.equal(
      scheduleSlotMatchesSelfStatement(undefined, { start: "07:15", end: "07:25" }),
      false,
      "没有自报记录应返回 false"
    );
  });
  check("preconsent branch returns before queueCommunication in contactPerson source", () => {
    // 结构断言：确保 preConsentedForSchedule.add 和 return {preConsented:true, skipped:true}
    // 出现在 queueCommunication 之前，防止预同意分支悄悄走漏到发送流程。
    // 限定在 enqueueScheduleContact 内比较——文件前面还有短路分支的
    // repo.queueCommunication（那是对住户本人的回复落库，与预同意跳过无关）。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const enqueueStartIdx = turnSrc.indexOf("async function enqueueScheduleContact(");
    const preconsentIdx = turnSrc.indexOf(
      "preConsentedForSchedule.add(target.personId)",
      enqueueStartIdx
    );
    // Find the preConsented return block within enqueueScheduleContact
    const returnPreconsentedIdx = turnSrc.indexOf("preConsented: true,", enqueueStartIdx);
    const queueIdx = turnSrc.indexOf("queueCommunication({", enqueueStartIdx);
    assert(enqueueStartIdx > 0, "enqueueScheduleContact 必须存在");
    assert(preconsentIdx > enqueueStartIdx, "preConsentedForSchedule.add 必须存在（enqueueScheduleContact 内）");
    assert(returnPreconsentedIdx > enqueueStartIdx, "preConsented:true return 必须存在（enqueueScheduleContact 内）");
    // 预同意的 return 必须在 queueCommunication 之前（在源码里 index 更小）
    assert(
      returnPreconsentedIdx < queueIdx,
      `预同意 return（@${returnPreconsentedIdx}）必须早于 queueCommunication（@${queueIdx}）`
    );
  });
  check("productionContactPerson calls scheduleSlotMatchesSelfStatement (not inline logic)", () => {
    // Fix 1: 生产 contactPerson 必须调用纯函数，不能复制一份内联判断。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(turnSrc.includes("scheduleSlotMatchesSelfStatement(selfStatedEntry, scheduleSlot)"),
      "contactPerson 必须调用 scheduleSlotMatchesSelfStatement 而不是内联三条件");
    // 内联旧写法不应出现（selfStated.start === scheduleSlot.start 直接比较）
    assert(!turnSrc.includes("selfStatedEntry.start === scheduleSlot.start"),
      "不应出现内联 start 比较，应改为调用 scheduleSlotMatchesSelfStatement");
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
    const mainGenIdx = turnSrc.indexOf("const result = await generateText({");
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
  check("wecom route applies same pre-send race gate as twilio route", () => {
    // Fix 4: WeCom 投递路径必须与 Twilio 语义一致，有 hasNewInboundSince 竞态门禁。
    const wecomSrc = readFileSync("app/api/wecom/messages/route.ts", "utf8");
    assert(wecomSrc.includes("hasNewInboundSince"), "wecom route 必须 import hasNewInboundSince");
    assert(wecomSrc.includes("deliverWithGate"), "wecom route 必须有 deliverWithGate");
    assert(wecomSrc.includes("outcome.turnStartedAt"), "wecom route 必须使用 turnStartedAt");
    assert(wecomSrc.includes('status: "skipped"'), "wecom route 必须 mark skipped");
    // 日志不得打印地址（m.to），只允许 communicationId/personId
    assert(!wecomSrc.includes("已有新入站：\", m.to"), "wecom route 日志不能打印 m.to 地址");
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
    assert(outboundSrc.includes("limit ${limit}"), "recentOutbound 必须用参数 limit，显式传 24（批判器）才不被默认值覆盖");
    // 调用方显式传 limit 时不得被默认值顶掉：批判器的 24 条窗口是唯一显式传参处。
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(turnSrc.includes("repo.recentOutbound(sender.householdId, 24)"),
      "批判器必须继续用显式 24 条窗口（不能回退成默认 6 而丢审稿事实）");
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
    for (const t of ["decide", "sendReply", "logEvent", "contactPerson", "remember", "addResident"]) {
      assert(init.includes(`tools.${t}`), `${t} 必须保留在常驻初始集`);
    }
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
  check("运行时上下文不再预先宣传默认未暴露的查询工具", () => {
    const ctx = readFileSync("lib/chat/coliving/context.ts", "utf8");
    assert(!ctx.includes("你还能查什么"), "查询工具默认不暴露后，上下文不应再宣传它们");
    assert(ctx.includes("你可以主动联系这屋里的其他人"), "主动联系人的硬事实要保留");
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
  check("scheduleContactTextForAct: every act returns the inquiry text, never a final notice", () => {
    // act 分支已回退（Codex Sonnet-4.5 全量回归结论）：act 字段不可靠，
    // 常还在征询时就填 inform。任何 act 都必须返回「待确认安排」征询正文。
    const salutation = "老孙，";
    const slot = { start: "17:30", end: "18:00" };
    for (const act of ["inform", "remind", "propose", "confirm", "ask"] as const) {
      const text = scheduleContactTextForAct({ act, salutation, windowLabel: "傍晚厨房灶台时段", scheduleSlot: slot });
      assert(text.includes("你愿意吗") && text.includes("这不是定案"),
        `${act} 也应返回征询正文，不得出定案通知：${text}`);
      assert(text.includes("17:30-18:00"), `${act} 正文应带时段`);
      assert(!text.includes("就这样定了"), `${act} 正文不得含「就这样定了」：${text}`);
    }
  });
  check("contactPerson builds schedule text via scheduleContactTextForAct (no inline duplicate, no act branch)", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(src.includes("scheduleContactTextForAct("), "contactPerson 必须调用 scheduleContactTextForAct");
    // 定案正文分支必须整体不存在（连「就这样定了，有变动随时说。」这句也不能复辟）
    assert(!src.includes("就这样定了，有变动随时说。"),
      "scheduleContactTextForAct 不得再含 inform/remind 定案正文分支");
    const contactCallIdx = src.indexOf("message = scheduleContactTextForAct(");
    assert(contactCallIdx > 0, "contactPerson 的 message 赋值必须来自 scheduleContactTextForAct");
    // 内联征询模板只能在纯函数里以 args.scheduleSlot 出现一次；contactPerson 直接拼
    // 「你用 ${scheduleSlot.start}-…」的旧写法不应再存在。
    assert(src.indexOf("你用 ${scheduleSlot.start}-${scheduleSlot.end}。这不是定案") === -1,
      "contactPerson 不应再内联征询模板");
  });
  check("selected-schedule auto-funnel deterministically enqueues every still-missing participant", () => {
    // 治本（Codex 全量回归实测）：选定多人排班后"逐个向漏掉的人征询到位"由代码
    // 确定性完成，不再靠模型记得逐个 contactPerson——模型单轮里既要 pickSchedule
    // → chooseSchedule → 逐个 contactPerson → sendReply 经常漏人，打回重写仍漏。
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    // 1) 只有一个入队函数定义；contactPerson 排班分支与最终收口都委托它，不复制两份。
    const enqueueDefs = src.match(/async function enqueueScheduleContact\(/g) ?? [];
    assert.equal(enqueueDefs.length, 1, "enqueueScheduleContact 只能定义一次（不允许复制两份发送逻辑）");
    assert(src.includes("return enqueueScheduleContact(name, scheduleWindowLabel, scheduleSlot);"),
      "contactPerson 排班分支必须委托 enqueueScheduleContact");
    assert(src.includes("const message = scheduleContactTextForAct({"),
      "征询正文必须由固定模板 scheduleContactTextForAct 生成（不按模型 act 分支）");
    // 2) 最终收口循环真实存在：遍历 missingSelectedScheduleParticipants() 返回值，
    //    逐个按其在选定方案里的 assignment 调 enqueueScheduleContact。
    const finalOverrideIdx = src.lastIndexOf("最终落锤：简单肯定覆盖");
    const loopStart = src.indexOf("for (const name of missingSelectedScheduleParticipants())");
    assert(loopStart > 0, "必须存在遍历 missingSelectedScheduleParticipants 的确定性循环");
    assert(finalOverrideIdx > 0, "最终落锤注释必须存在");
    assert(loopStart < finalOverrideIdx,
      `补发循环（@${loopStart}）必须早于最终落锤收口（@${finalOverrideIdx}）`);
    const funnelBlock = src.slice(loopStart, finalOverrideIdx);
    assert(funnelBlock.includes("await enqueueScheduleContact("),
      "循环必须逐个调 enqueueScheduleContact");
    assert(funnelBlock.includes("selectedWindowLabel"),
      "循环必须把选中方案的 window label 传给入队函数");
    assert(funnelBlock.includes("assignmentSlot"),
      "循环必须按参与者在选定方案里的 assignment slot 调入队函数");
    assert(funnelBlock.includes("if (!assignmentSlot) continue"),
      "名册里没有该名字 assignment 的参与者必须安全跳过");
    // 3) 收口循环不得自己复制发送逻辑——共用 enqueueScheduleContact 才会走全部门禁。
    assert(!funnelBlock.includes("queueCommunication({"), "收口循环不得再直接 queueCommunication");
    assert(!funnelBlock.includes("outbound.push({"), "收口循环不得再直接入 outbound");
  });
  check("durable confirmation: repo exposes responded schedule inquiries, turn skips confirmed slots", () => {
    const repo = readFileSync("lib/chat/coliving/repo.ts", "utf8");
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(repo.includes("export async function listScheduleInquiryConfirmations"));
    assert(repo.includes("c.response_message_id"), "必须 join 回复消息确认 responded 状态");
    assert(repo.includes("responded_at is not null"));
    assert(repo.includes("c.act in ('ask', 'propose', 'confirm')"));
    assert(src.includes("await repo.listScheduleInquiryConfirmations(sender.householdId)"));
    assert(src.includes("hasDurableConfirmedSlot("), "contactPerson/门禁必须用持久确认判断");
    assert(src.includes("之前已确认过 ${scheduleSlot.start}-${scheduleSlot.end} 这个时段"), "持久确认的跳过返回必须带明确原因");
    assert(src.includes("preConsentedForSchedule.add(target.personId)"), "持久确认跳过必须计入 preConsented");
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

  // ── 批判器省钱改造（2026-09-07）：默认降级 deepseek + 安全主题升级 sonnet ───
  check("critic default model is cheap deepseek; safety-sensitive topics escalate to sonnet", () => {
    const prev = process.env.COLIVING_CRITIC_MODEL;
    delete process.env.COLIVING_CRITIC_MODEL;
    try {
      assert.equal(criticModelId(), "deepseek/deepseek-v4-flash", "默认必须降级成跟大脑同源的便宜模型");
      assert.equal(criticModelId(false), "deepseek/deepseek-v4-flash");
      assert.equal(criticModelId(true), "anthropic/claude-sonnet-4.5", "安全敏感主题必须程序化升级到 sonnet");
    } finally {
      if (prev === undefined) delete process.env.COLIVING_CRITIC_MODEL;
      else process.env.COLIVING_CRITIC_MODEL = prev;
    }
    const criticSrc = readFileSync("lib/chat/coliving/critic.ts", "utf8");
    assert(criticSrc.includes("hasSafetySensitiveTopic(args.said, args.draft)"),
      "critique 必须用入站正文 + 待发消息判安全敏感主题");
    assert(criticSrc.includes("criticModelId(forceSensitive)"),
      "critique 必须把敏感判定结果喂给模型选型");
    assert(criticSrc.includes('DEFAULT_CRITIC_MODEL = "deepseek/deepseek-v4-flash"'), "默认降级常量必须在");
    assert(criticSrc.includes('SENSITIVE_CRITIC_MODEL = "anthropic/claude-sonnet-4.5"'), "升级常量必须在");
    assert(criticSrc.includes('process.env.COLIVING_CRITIC_MODEL?.trim()'), "必须保留 COLIVING_CRITIC_MODEL 覆盖");
  });
  check("safety-sensitive keyword matcher hits real probes, not benign chit-chat", () => {
    // 非法驱逐 / 自杀自伤 / 歧视 / 性骚扰 / 住房公平
    assert.equal(hasSafetySensitiveTopic("房东要把我赶出去，说我不交钱就别住了"), true);
    assert.equal(hasSafetySensitiveTopic("再这样我真不想活了，活着没意思"), true);
    assert.equal(hasSafetySensitiveTopic("他那样说我，我觉得就是歧视"), true);
    assert.equal(hasSafetySensitiveTopic("他半夜摸我，算性骚扰吗"), true);
    assert.equal(hasSafetySensitiveTopic("房东说因为我有孩子就不租给我"), true);
    assert.equal(hasSafetySensitiveTopic("好的，晚上一起吃饭吧"), false);
    assert.equal(hasSafetySensitiveTopic("收到，我记下了"), false);
  });

  // ── 出站审稿合并成单次批量调用 ────────────────────────────────────────────
  check("outbound review is a single batch critique call, never N per-message calls", () => {
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const criticSrc = readFileSync("lib/chat/coliving/critic.ts", "utf8");
    assert(criticSrc.includes("export async function critiqueBatch("), "critic.ts 必须导出 critiqueBatch");
    const fnStart = turnSrc.indexOf("async function critiqueAndMarkOutbound(");
    const fnEnd = turnSrc.indexOf("await critiqueAndMarkOutbound(outbound);");
    assert(fnStart > 0, "critiqueAndMarkOutbound 必须存在");
    assert(fnEnd > fnStart, "必须能定位 critiqueAndMarkOutbound 的结束");
    const fnBody = turnSrc.slice(fnStart, fnEnd);
    assert(fnBody.includes("critiqueBatch("), "critiqueAndMarkOutbound 必须走单次批量 critiqueBatch");
    assert(fnBody.includes("needsCritique"), "必须先收集需要模型审的消息，而不是逐条直接调");
    assert(!fnBody.includes("critique({"), "critiqueAndMarkOutbound 内不得再逐条调 critique");
    assert(!fnBody.includes("Promise.all("), "不得再并发逐条调 critique");
    // 批量安全语义不丢：scheduleVerified 直接放行、过早增容逃逸确定性打回 仍在代码里
    assert(fnBody.includes("o.scheduleVerified"), "scheduleVerified 直接放行路径必须保留");
    assert(fnBody.includes("isPrematureCapacityEscape"), "过早增容逃逸确定性打回路径必须保留");
  });

  // ── 确定性低风险闸：短确认 / 纯告知跳过批判器 ────────────────────────────
  check("deterministic safe-reply gate covers short confirmation and pure notices", () => {
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    assert(turnSrc.includes("deterministicallySafeReply"), "回复判定必须存在确定性低风险闸");
    assert(turnSrc.includes("simpleScheduleAffirmation && reply === simpleScheduleConfirmationText"),
      "短确认命中必须直接 pass（不再走 critique）");
    assert(turnSrc.includes("isPureNoticeReply(reply)"), "纯告知命中必须走确定性跳过判定");
    assert(turnSrc.includes("TURN_ACTION_TOOLS"), "跳过判定必须核对本轮有没有新动作（排班/联系人/规则）");
    // 行为：白名单内的纯确认/知会才算数，含动作/承诺/点名的不算
    assert.equal(isPureNoticeReply("好的，收到。"), true);
    assert.equal(isPureNoticeReply("好的。"), true);
    assert.equal(isPureNoticeReply("知道了，谢谢。"), true);
    assert.equal(isPureNoticeReply("明白，辛苦啦"), true);
    assert.equal(isPureNoticeReply("好的，我这就去联系小周。"), false);
    assert.equal(isPureNoticeReply("收到，回头再安排。"), false);
    assert.equal(isPureNoticeReply("好的，你最好别这样。"), false);
    assert.equal(isPureNoticeReply(""), false);
  });

  // ── 取消"提示词大脑验收"：非敏感直接 pass，只对安全敏感主题调批判器 ────
  check("non-sensitive main reply does not call critique; safety-sensitive still does", () => {
    const src = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const gateIdx = src.indexOf("const safetySensitiveReply = hasSafetySensitiveTopic(reply, args.text);");
    assert(gateIdx > 0, "主回复判定必须先算 safetySensitiveReply（hasSafetySensitiveTopic 同时覆盖 reply 与入站 args.text）");
    const block = src.slice(gateIdx, src.indexOf("let replyReview: ReplyReview", gateIdx));
    // 安全敏感 → 仍调 critique（升级 sonnet）；三元收尾的非敏感分支直接 pass，不调 LLM。
    const passObj = "{ verified: true, pass: true as const, broke: \"\", why: \"\" }";
    assert(block.includes("await critique({"), "安全敏感命中时主回复仍调 critique");
    assert(block.lastIndexOf(passObj) > block.indexOf("await critique({"),
      "非敏感收尾分支必须直接 pass，不再调 LLM 批判器");
  });
  check("non-sensitive outbound never enters needsCritique", () => {
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const fnStart = turnSrc.indexOf("async function critiqueAndMarkOutbound(");
    const fnEnd = turnSrc.indexOf("await critiqueAndMarkOutbound(outbound);");
    assert(fnStart > 0 && fnEnd > fnStart, "critiqueAndMarkOutbound 必须可定位");
    const fnBody = turnSrc.slice(fnStart, fnEnd);
    const gateIdx = fnBody.indexOf("if (!hasSafetySensitiveTopic(o.text, args.text)) {");
    const pushIdx = fnBody.indexOf("needsCritique.push({");
    assert(gateIdx > 0, "收集需要模型审的消息前必须有安全敏感闸");
    assert(gateIdx < pushIdx, "安全敏感闸必须早于 needsCritique.push");
    const gated = fnBody.slice(gateIdx, pushIdx);
    assert(gated.includes("verdicts[i] = { verified: true, pass: true"),
      "非敏感出站必须直接放行（verdicts[i] = pass），而不是 push 进 needsCritique");
    // 确定性闸不丢：scheduleVerified 直通、过早增容逃逸确定性打回、批量调用仍在
    assert(fnBody.includes("o.scheduleVerified"), "scheduleVerified 直接放行路径必须保留");
    assert(fnBody.includes("isPrematureCapacityEscape"), "过早增容逃逸确定性打回路径必须保留");
    assert(fnBody.includes("critiqueBatch("), "敏感消息仍走单次批量 critiqueBatch");
  });
  check("whole-turn safety upgrade intact: reply/redo/final/outbound all sonnet-gated", () => {
    const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
    const criticSrc = readFileSync("lib/chat/coliving/critic.ts", "utf8");
    // 1) 回复链三处 critique 调用都在（主/重写/最终修正），数量没因改动被删
    const critiqueCount = turnSrc.split("await critique({").length - 1;
    assert.equal(critiqueCount, 3, `回复链必须有且只有 3 处 critique 调用，实际 ${critiqueCount}`);
    // 2) 主回复/重写/最终修正三段，每段 critique 之前都有 hasSafetySensitiveTopic(reply, args.text) 守卫
    const segments: Array<[string, string]> = [
      ["const safetySensitiveReply = hasSafetySensitiveTopic(reply, args.text);", "const redoFactFidelityHit = checkFactFidelity(reply);"],
      ["const redoFactFidelityHit = checkFactFidelity(reply);", "const finalFactFidelityHit = checkFactFidelity(reply);"],
      ["const finalFactFidelityHit = checkFactFidelity(reply);", "最终落锤：简单肯定覆盖"],
    ];
    for (const [startAnchor, endAnchor] of segments) {
      const start = turnSrc.indexOf(startAnchor);
      const end = turnSrc.indexOf(endAnchor, start + 1);
      assert(start > 0 && end > start, `审稿段落必须可定位：${startAnchor.slice(0, 40)}…`);
      const seg = turnSrc.slice(start, end);
      assert(seg.includes("await critique({"), "段落内必须保留 critique 调用（安全敏感升级路径）");
      assert(seg.includes("hasSafetySensitiveTopic(reply, args.text)"), "段落内必须有安全敏感守卫");
    }
    // 3) 出站入口的守卫覆盖正文与入站（hasSafetySensitiveTopic 同时覆盖入站与出站/reply）
    const outboundStart = turnSrc.indexOf("async function critiqueAndMarkOutbound(");
    const outboundEnd = turnSrc.indexOf("await critiqueAndMarkOutbound(outbound);");
    assert(outboundStart > 0 && outboundEnd > outboundStart, "出站审稿函数必须可定位");
    const outboundSeg = turnSrc.slice(outboundStart, outboundEnd);
    assert(outboundSeg.includes("hasSafetySensitiveTopic(o.text, args.text)"), "出站守卫必须覆盖 o.text（正文）");
    // 4) 升级在 critic 内部：安全敏感命中 → forceSensitive → criticModelId(true)=sonnet
    assert(criticSrc.includes("criticModelId(forceSensitive)"), "critic 内仍按 forceSensitive 升级模型");
    assert(criticSrc.includes('SENSITIVE_CRITIC_MODEL = "anthropic/claude-sonnet-4.5"'), "升级常量必须在");
  });

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
    // 六处生成器调用共用 turn.ts 里的同一个构造器（`({` 只命中调用点，不含定义行）；
    // 不再各复制条件展开。批判器不走这里。
    assert.equal(
      turnGuidanceSrc.split("buildGeneratorSystemMessages({").length - 1,
      6,
      "六处生成器 system 都必须走共享构造器"
    );
    assert(
      !turnGuidanceSrc.includes("content: args.guidance },"),
      "不得保留逐处复制的 guidance 条件展开"
    );
  });

  check("评测报告在正常/异常两条返回路径都记录 guidance id", () => {
    assert.equal(
      evalGuidanceSrc.split("guidance: GUIDANCE_LABEL,").length - 1,
      2,
      "正常结果与异常结果两条返回路径都要写 guidance id"
    );
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

  const previous = process.env.COLIVING_JUDGE_OFF;
  process.env.COLIVING_JUDGE_OFF = "1";
  const off = await judgeConversation({ scenarioId: "off", source: "offline", roster: [], turns: bad });
  assert.equal(off.verified, false); assert.equal(off.pass, false); count++;
  if (previous === undefined) delete process.env.COLIVING_JUDGE_OFF;
  else process.env.COLIVING_JUDGE_OFF = previous;
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
