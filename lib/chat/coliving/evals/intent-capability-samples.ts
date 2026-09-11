/**
 * **「意图 → 能力」三张开发者期望映射 + 一个负例（评测专用）。**
 *
 * 这些样例是**开发者按需求逐字段手写的离线草案**——非模型生成、非老板核准，
 * 也没有任何在线效果证据。它们只用来证明「意图 × 能力」结构能表达现实差异，
 * 并把每个意图的原话依据、选中的能力、成熟度、允许工具、完成收据和边界原因
 * 并排摊开给人看。
 *
 * 三张样例分别对应任务卡要求的三个场景：
 * 1. **简单提醒**：一个意图、一个 available 能力——证明简单情况很轻；
 * 2. **先问小王 → 排草案 → 我定了再发**：至少拆出取数 / 草案 / 发布三个意图，
 *    `preview_before_publish` 只约束「发布」，不阻止已获准的「取数」；
 * 3. **024**：访客规则协调映射到 partial 共同规则能力；无既有依据的新费用分摊
 *    映射到 blocked；需要周姐确认是否接受缩窄范围，整条消息**不能判成一个 red**，
 *    也不开始被阻塞的费用动作。
 *
 * `NEGATIVE_SAMPLE` 是**刻意写坏的负例**（把 blocked 能力标成可执行），只给免费
 * 确定性检查用，不生成报告：证明校验器真的会拦，而不是只会给作者写的样例盖章。
 *
 * 完全离线：这里只有数据，没有模型、没有 repo、没有发送动作。
 */

import type {
  IntentCapabilitySample,
  IntentEnvelope,
} from "./intent-capability";

export const INTENT_CAPABILITY_SAMPLES: readonly IntentCapabilitySample[] = [
  {
    id: "sample-01-simple-reminder",
    title: "简单提醒：一个意图、一个可用能力",
    source:
      "任务卡场景 1：普通小事应该很轻——一条消息一个意图，字段很少、直接命中一个 available 能力，不需要为它填一堆无关状态。",
    context: {
      speaker: "阿哲",
      roster: ["阿哲", "大凯"],
      rawMessage: "请你提醒大凯，进我房间前先敲门。",
    },
    envelope: {
      intents: [
        {
          id: "remind-dakai",
          desiredOutcome: "大凯以后进阿哲房间之前先敲门",
          capabilityId: "send-targeted-message",
          target: "大凯",
          authorizationEvidence: "请你提醒大凯",
          constraints: [],
          completionCriteria: "这条提醒真的发给大凯了",
        },
      ],
    },
    expectations: [
      {
        intentId: "remind-dakai",
        executable: true,
        reason: "低风险、可核验的定向提醒；工具与投递收据都在，能力为 available",
      },
    ],
  },
  {
    id: "sample-02-collect-draft-publish",
    title: "先联系取数、排草案、发信人点头后再发布",
    source:
      "任务卡场景 2：一个请求里「联系小王收集时间」「排出草案」「发布排班」是三个意图——取数与草案可以推进，发布尚未获授权（先给我看、我定了再发）。限制只作用于发布意图，不阻止已获准的取数。",
    context: {
      speaker: "小林",
      roster: ["小林", "小王", "小陈"],
      rawMessage:
        "下礼拜厨房怎么排还没定。你先问问小王哪天方便，把表排出来先给我看看，我定了再发给大家。",
    },
    envelope: {
      intents: [
        {
          id: "collect-xiaowang",
          desiredOutcome: "知道小王下礼拜哪几天、大概几点能用厨房",
          capabilityId: "collect-constraint",
          target: "小王",
          authorizationEvidence: "你先问问小王哪天方便",
          constraints: [],
          completionCriteria: "小王的可用时间被问到并记录下来",
        },
        {
          id: "draft-schedule",
          desiredOutcome: "拿到小王的时间后排出一版下礼拜厨房草案",
          capabilityId: "draft-schedule",
          target: "下礼拜厨房排班",
          authorizationEvidence: "把表排出来先给我看看",
          constraints: [],
          completionCriteria: "草案排出来并先给发信人看到",
        },
        {
          id: "publish-schedule",
          desiredOutcome: "发信人点头后，把时间表发给各位室友并能回应",
          capabilityId: "distribute-schedule",
          target: "各位室友",
          // 本轮**未授权发布**：住户说「我定了再发」，所以没有授权原话。
          authorizationEvidence: null,
          constraints: [
            {
              kind: "preview_before_publish",
              evidence: "我定了再发给大家",
            },
          ],
          completionCriteria: "发信人确认后，各位室友各收到自己那份时段",
        },
      ],
    },
    expectations: [
      {
        intentId: "collect-xiaowang",
        executable: true,
        reason: "住户明确让去问小王，且没有暂不联系的限制：取数可以推进",
      },
      {
        intentId: "draft-schedule",
        executable: true,
        reason: "排草案是内部计算、不对外发送；住户已要求先排出来给他看",
      },
      {
        intentId: "publish-schedule",
        executable: false,
        reason:
          "住户说了「先给我看看，我定了再发」：发布尚未获授权，preview_before_publish 只约束这一个意图",
      },
    ],
  },
  {
    id: "sample-03-mixed-capability-024",
    title: "024：访客规则可协调（partial），新费用分摊 blocked",
    source:
      "任务卡场景 3：周姐把访客过夜（可协调）和无既有依据的新增水电分摊（当前不能自定）绑在一起。只做过夜会实质收窄原委托，需周姐确认；水电承担映射到 blocked。整条消息不是「一个 red」，但也不能开始被阻塞的费用动作。",
    context: {
      speaker: "周姐",
      roster: ["周姐", "小俊"],
      rawMessage:
        "小俊的女朋友这阵子几乎天天来，晚上就睡在这儿，洗澡做饭都在这儿，跟搬进来住没两样。他刚搬来那会儿我是说过可以带朋友回来，可这么下去水电费一直涨，房子也不是只住他一个。你帮我跟小俊谈谈吧，不能老这么住着，多出来的水电费也得想个办法。",
    },
    envelope: {
      intents: [
        {
          id: "guest-overnight-rule",
          desiredOutcome: "把小俊女友过夜的边界说清楚（频率、时长、提前告知）",
          capabilityId: "circulate-rule",
          target: "小俊",
          authorizationEvidence: "你帮我跟小俊谈谈吧",
          constraints: [],
          completionCriteria: "规则问过受影响的人并让小俊知道边界",
        },
        {
          id: "utility-cost-split",
          desiredOutcome: "把多出来的水电费由谁承担定下来",
          capabilityId: "decide-cost-split-without-basis",
          target: "多出来的水电费",
          authorizationEvidence: "多出来的水电费也得想个办法",
          constraints: [],
          completionCriteria: "有了一个各方认可的费用承担办法",
        },
      ],
    },
    expectations: [
      {
        intentId: "guest-overnight-rule",
        executable: false,
        reason:
          "只做过夜会实质收窄周姐的原委托（她同时要求处理水电费），需要周姐确认能否接受只做这一半；确认后本能力（partial）才可推进",
      },
      {
        intentId: "utility-cost-split",
        executable: false,
        reason:
          "缺少既有分摊依据却要由 AI 创设费用承担规则，能力为 blocked：不联系小俊、不起草费用规则，如实说明这项做不到",
      },
    ],
  },
];

/** 从样例信封里取某个意图（供报告/检查复用）。 */
export function intentById(
  envelope: IntentEnvelope,
  intentId: string
): IntentEnvelope["intents"][number] | undefined {
  return envelope.intents.find((intent) => intent.id === intentId);
}

/**
 * **刻意写坏的负例**：把 `decide-cost-split-without-basis`（blocked）标成
 * `executable: true`。它必须被 `validateIntentSample` 拦下
 * （`blocked_capability_marked_executable`），用它证明校验器真的会拦，而不是
 * 只会给自己手写的样例盖章。**不生成报告、不进 `INTENT_CAPABILITY_SAMPLES`。**
 */
export const NEGATIVE_SAMPLE: IntentCapabilitySample = {
  id: "negative-blocked-marked-executable",
  title: "负例：blocked 能力被标成可执行",
  source:
    "负例专用：无既有依据的新费用分摊当前不支持，任何把它标成可执行、准备联系住户的执行计划都必须被打回。",
  context: {
    speaker: "周姐",
    roster: ["周姐", "小俊"],
    rawMessage: "多出来的水电费也得想个办法，你帮我跟小俊谈谈吧。",
  },
  envelope: {
    intents: [
      {
        id: "utility-cost-split",
        desiredOutcome: "把多出来的水电费由谁承担定下来",
        capabilityId: "decide-cost-split-without-basis",
        target: "多出来的水电费",
        authorizationEvidence: "多出来的水电费也得想个办法",
        constraints: [],
        completionCriteria: "有了一个各方认可的费用承担办法",
      },
    ],
  },
  expectations: [
    {
      intentId: "utility-cost-split",
      // 故意写坏：blocked 能力不得被标为可执行。
      executable: true,
      reason: "（负例）错误地认为可以执行",
    },
  ],
};
