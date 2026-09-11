/**
 * **逐动作协调计划的三张开发者期望样例（V4 评测专用）。**
 *
 * 这些样例是**开发者按需求逐字段手写的离线草案**——非模型生成、非老板核准、
 * 也还没有任何在线效果证据。它们只用来证明「逐动作结构能表达现实里的真实差异」，
 * 并把每个动作的授权、就绪度、能力分区、状态、依赖和收据并排摊开给人看。
 *
 * 三张样例分别对应任务卡里的三个反例：
 * 1. 先联系取数、方案稍后确认（能联系收集时间，还不能发布排班）；
 * 2. 缺请求人关键时间（只问发信人一个必要问题，不联系第三方）；
 * 3. 024 混合能力边界（过夜可支持但等周姐决定、水电承担 red 停止，本轮无第三方出站）。
 *
 * 第四张 `SIMPLE_GREEN_SAMPLE` 是**最简单的单动作绿区提醒**，不生成报告，只给免费
 * 单元检查用：证明逐动作结构没有把普通小事复杂化（字段很少就能通过）。
 *
 * 完全离线：这里只有数据，没有模型、没有 repo、没有发送动作。
 */

import type { ActionPlan, ActionPlanContext } from "./action-plan";

export type ActionPlanSample = {
  id: string;
  /** 一句话标题，写在报告抬头。 */
  title: string;
  /** 这张样例想证明什么（开发者说明，不是老板口径）。 */
  source: string;
  context: ActionPlanContext;
  plan: ActionPlan;
};

const KITCHEN_ROSTER = ["小林", "小王", "小陈"];

export const ACTION_PLAN_SAMPLES: readonly ActionPlanSample[] = [
  {
    id: "sample-01-gather-then-confirm",
    title: "先联系取数、方案稍后确认",
    source:
      "反例一：一个请求里「联系小王收集时间」「排出草案」「发布排班」是三个动作——取数已授权，排草案等小王回复，发布尚未授权。整轮二分法无法同时表达。",
    context: {
      speaker: "小林",
      roster: KITCHEN_ROSTER,
      rawMessage:
        "下礼拜厨房怎么排还没定。你先问问小王哪天方便，把表排出来先给我看看，我定了再发给大家。",
    },
    plan: {
      actions: [
        {
          id: "contact-xiaowang",
          kind: "contact_person",
          purpose: "问小王下礼拜哪几天、大概几点能用厨房",
          authorization: "requester_requested",
          capability: "green",
          status: "waiting_reply",
          outbound: [
            {
              recipient: "小王",
              purpose: "收集可用时间",
              text: "下礼拜厨房排班还差你这边：你哪天、大概几点到几点方便用？说个大概就行。",
            },
          ],
          capabilityReasons: [
            "低风险、可核验：只问可用时间，不涉及处置、权利或费用",
          ],
        },
        {
          id: "make-schedule",
          kind: "make_schedule",
          purpose: "根据小王回复的可用时间排出下礼拜草案",
          authorization: "requester_requested",
          capability: "green",
          status: "planned",
          dependsOn: ["contact-xiaowang"],
          blockedReason: "等小王回复可用时间；他一回就先把草案排出来",
          capabilityReasons: [
            "排班是内部计算：先出草案、不对外发送",
          ],
        },
        {
          id: "publish-plan",
          kind: "publish_plan",
          purpose:
            "把小林点头后的时间表发给各人，让他们对时段可以回应",
          authorization: "needs_confirmation",
          capability: "green",
          status: "planned",
          dependsOn: ["make-schedule"],
          blockedReason:
            "等草案排出来，且要小林先看过方案点头，才把表发给各位征询意见",
          capabilityReasons: [
            "发布是把草案发给受影响的人、让他们有机会回应，不等于规则已经成立；但仍要等发信人确认后再发",
          ],
        },
      ],
      requesterReply:
        "已经问过小王哪天方便了；他一回我先排个草案给你看，你点头我再发给各位，看他们还有没有别的意见。",
    },
  },
  {
    id: "sample-02-missing-requester-fact",
    title: "缺请求人关键时间",
    source:
      "反例二：目标已委托不等于信息充分。缺发信人自己可用时间时，只该问他一个会改变安排的问题，不该为了证明『已行动』去联系别人。",
    context: {
      speaker: "小林",
      roster: KITCHEN_ROSTER,
      rawMessage: "你帮我安排一下做饭的时间吧，怎么排都行。",
    },
    plan: {
      actions: [
        {
          id: "ask-requester-availability",
          kind: "ask_requester",
          purpose: "问小林自己哪几天、大概几点能用厨房",
          authorization: "coordinator_duty",
          capability: "green",
          status: "done",
          requesterQuestion:
            "排之前我得先知道你自己哪天在家、大概几点到几点能用厨房——你说个大概就行。",
        },
        {
          id: "make-schedule",
          kind: "make_schedule",
          purpose: "根据小林的可用时间排出做饭表",
          authorization: "requester_requested",
          capability: "green",
          status: "planned",
          readiness: "missing_requester_fact",
          dependsOn: ["ask-requester-availability"],
          blockedReason: "还缺小林自己的可用时间，缺这个排不了",
          capabilityReasons: [
            "排班本身可做，等发信人补一个会改变安排的事实",
          ],
        },
      ],
      requesterReply:
        "排之前我得先知道你哪天在家、大概几点到几点能用厨房，你说个大概就行；我再把表排出来。",
    },
  },
  {
    id: "sample-03-mixed-capability-024",
    title: "024 混合能力边界",
    source:
      "反例三：周姐把访客过夜（可协调）和无既有依据的新增水电分摊（当前不能自定）绑在一起。只做过夜会实质收窄原委托，先等周姐决定；水电承担 red 停止；本轮无第三方出站。",
    context: {
      speaker: "周姐",
      roster: ["周姐", "小俊"],
      rawMessage:
        "小俊的女朋友这阵子几乎天天来，晚上就睡在这儿，洗澡做饭都在这儿，跟搬进来住没两样。他刚搬来那会儿我是说过可以带朋友回来，可这么下去水电费一直涨，房子也不是只住他一个。你帮我跟小俊谈谈吧，不能老这么住着，多出来的水电费也得想个办法。",
    },
    plan: {
      actions: [
        {
          id: "guest-overnight",
          kind: "establish_rule",
          purpose: "协调小俊女友过夜的边界（频率、时长、提前告知）",
          authorization: "needs_confirmation",
          capability: "green",
          status: "planned",
          blockedReason:
            "只做过夜会实质收窄周姐的原委托（她同时要求处理水电费），先等她决定是否接受只做这一半",
          requesterQuestion:
            "要是我先只处理访客过夜这部分，可以吗？",
          capabilityReasons: [
            "访客过夜频率属于共同生活规则，本身可以协调",
          ],
        },
        {
          id: "utility-split",
          kind: "establish_rule",
          purpose: "决定多出来的水电费由谁承担",
          authorization: "requester_requested",
          capability: "red",
          status: "stopped",
          blockedReason:
            "缺少既有分摊约定、账单明细或可核实依据，当前不能由 AI 创设新的费用承担规则",
          capabilityReasons: [
            "缺少既有依据却要由 AI 决定费用承担，超出当前可靠能力",
            "先联系小俊会制造这件事已经由 AI 接管的预期",
          ],
        },
      ],
      requesterReply:
        "访客过夜的边界我可以协调；水电费怎么分摊现在没有既定的依据，我不能替你们定。要是我先只处理访客过夜这部分，可以吗？你点头我再联系小俊。",
    },
  },
];

/**
 * 最简单的单动作绿区提醒（不生成报告，只给免费单元检查用）。
 * 只用 id/kind/purpose/authorization/capability/status/outbound 七个字段即通过，
 * 证明逐动作结构没有把普通小事复杂化。
 */
export const SIMPLE_GREEN_SAMPLE: ActionPlanSample = {
  id: "sample-04-simple-green",
  title: "简单绿区提醒（字段最少）",
  source: "防过度设计：普通小事应能用很少字段表达并通过校验。",
  context: {
    speaker: "阿哲",
    roster: ["阿哲", "大凯"],
    rawMessage: "请你提醒大凯，进我房间前先敲门。",
  },
  plan: {
    actions: [
      {
        id: "remind",
        kind: "contact_person",
        purpose: "提醒大凯进阿哲房间前先敲门",
        authorization: "requester_requested",
        capability: "green",
        status: "done",
        outbound: [
          {
            recipient: "大凯",
            purpose: "最小化边界提醒",
            // 只给一条普遍必要理由 + 可执行动作：不点投诉人、不提换衣服等私密细节，
            // 否则等于向大凯暴露信息来源和只有当事人才知道的现场（025/026 同类事故）。
            text: "跟你说个小事情：房间是每个人自己的私人空间，人也可能正不方便。以后进门前先敲一下，等里面应了再进去。",
          },
        ],
      },
    ],
    // 只给真实动作收据，不追加「他会不会照做」这类防御性免责声明。
    requesterReply: "已经把进门前先敲门这条提醒发给大凯了。",
  },
};
