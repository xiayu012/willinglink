import "server-only";

import { generateText } from "ai";
// **必须从 index 引**，不能直接引 registry：注册发生在 index 的副作用里。
// 直接引 registry 会在大脑还没注册时静默放行一切（真踩过）。
import { getBrain, readDoctrine } from "@/lib/ai/brains";
import { getLanguageModel } from "@/lib/ai/providers";
import { colivingModelId } from "./model";
import { isEvalBudgetExceeded, trackedGatewayCall } from "./gateway-ledger";

/**
 * 发出去之前的批判器。
 *
 * ## 为什么不是「你自己再检查一遍」
 *
 * 朴素的自我复查在生产里不可靠——模型会朝「它以为你想听的」修正，
 * 甚至把本来对的改错。行业里站得住的是**生成器–批判器分离**：
 * 换一套提示词、只评不写、迭代封顶。
 *
 * ## 为什么对着「清单」而不是「宪法」
 *
 * 上一版让它对着宪法判，结果放行了一条读起来像指控的消息——
 * 住户报告马桶脏，回信是「你用完顺手刷一下，别留给下一个人」。
 * **宪法里没有一条叫「别对报告问题的人下指令」**，抽象原则判不出这种事。
 *
 * 宪法是「没写过的情况怎么推」，清单是「这条写好的消息哪里不对」。
 * 推理要抽象原则，检查要具体问题。**两件事，两份文档。**
 *
 * ## 用哪个模型
 *
 * 默认跟大脑同源用便宜的 `deepseek/deepseek-v4-flash`（约 18 倍差价，见
 * `model.ts` 的选型记录）。但批判器是**出口安全闸**，安全敏感主题上不能赌
 * 便宜模型的判断力——**命中非法驱逐 / 自杀自伤 / 歧视 / 性骚扰 / 住房公平
 * 陷阱任一关键词时，程序化升级到 `anthropic/claude-sonnet-4.6`**。关键词
 * 匹配放代码里、不靠 LLM 判断：宁可多升级一次（多花一点 sonnet 的钱），
 * 也不要漏升级（弱模型复核高风险内容）。
 * `COLIVING_CRITIC_MODEL` 可覆盖全部（逃生舱口），默认如上。
 *
 * ## 三条兜底
 * 只跑一次 · 不给工具不让改写 · **默认放行**——
 * 批判器自己挂了、超时了、说不清楚，一律当通过。
 * **绝不能因为这道闸让住户收不到消息。**
 */

export type Verdict = {
  /** 是否真的从批判器拿到并解析出了明确结论。 */
  verified: boolean;
  pass: boolean;
  /** 第几条不合格 */
  broke: string;
  /** 一句话说清哪儿不对，交给生成器去改 */
  why: string;
};

const PASS: Verdict = { verified: true, pass: true, broke: "", why: "" };
/** 生产上继续投递，但评测不能把关闭、异常或含糊输出冒充成已验收。 */
const UNVERIFIED_PASS: Verdict = {
  verified: false,
  pass: true,
  broke: "",
  why: "批判器没有返回可解析的明确结论",
};

function normalizeRuleId(value: unknown): string {
  const raw = String(value ?? "").trim();
  return raw.match(/\d+(?:\.\d+)?/)?.[0] ?? raw.replace(/^第|条$/g, "");
}

/** 批判器默认模型：跟大脑同源（deepseek/deepseek-v4-flash），便宜约 18 倍。 */
const DEFAULT_CRITIC_MODEL = "deepseek/deepseek-v4-flash";
/** 安全敏感主题上强制升级到的模型（见 hasSafetySensitiveTopic 的说明）。 */
const SENSITIVE_CRITIC_MODEL = "anthropic/claude-sonnet-4.6";

/**
 * 命中任一安全敏感主题时，这一轮批判器强制用 sonnet。关键词匹配放代码里、
 * 不靠 LLM 判断——**不能用模型的随机性来决定"高风险内容由哪个模型复核"**。
 *
 * 宁可多触发（顶多多付一次 sonnet 的钱），也不要漏触发（弱模型复核
 * 非法驱逐 / 自杀自伤 / 歧视 / 性骚扰 / 住房公平）。注意：此正则只决定
 * "用哪个模型复核"，不改变任何行为。
 */
const SAFETY_SENSITIVE_PATTERN =
  /(?:非法驱逐|驱逐|赶人走|赶.{0,3}(?:走|出去)|撵走|轰走|扫地出门|清退|换.{0,4}锁|锁.{0,4}换|断水|断电|停水|停电|拉闸|不让.{0,3}住|滚出去|滚蛋|evict|kick.{0,4}out|throw.{0,4}out|lock.{0,4}out)|(?:自杀|自残|自尽|轻生|不想活|想死|活不下去|一了百了|割腕|上吊|跳楼|suicide|kill myself|hurt myself|self[- ]harm)|(?:性骚扰|猥亵|性侵|sexual|harass|摸我|sexually)|(?:歧视|种族|racism|discriminat|移民|遣返|report.{0,3}ICE|因为.{0,6}(?:他|她|你).{0,3}是)|(?:公平住房|住房公平|fair housing|housing.{0,4}equit|disparate impact|familial status|拒绝.{0,8}(?:孩子|儿童|小孩|孕妇|残疾人)|带孩子|有小孩|有孩子|因为.{0,8}(?:孩子|小孩|孕妇|残疾人).{0,6}(?:不租|拒绝|歧视))/i;

/** 这些文本里有没有任何一段命中安全敏感主题。 */
export function hasSafetySensitiveTopic(...texts: string[]): boolean {
  return texts.some((text) => Boolean(text) && SAFETY_SENSITIVE_PATTERN.test(text));
}

/**
 * 这一轮批判器该用哪个模型。
 * `forceSensitive` 由调用方用 `hasSafetySensitiveTopic` 算好传入，
 * 命中安全敏感主题时用 sonnet；否则用便宜的默认模型。
 *
 * `forceStrong` 是 relay 的**选择性强审稿**：调用方用结构事实（同一收件人
 * 的连续关系、本轮多个收件人）判断"这不是首次简单交办"时置位，用同一个
 * 强模型复核；安全敏感升级语义不变。两者任一为真都升级。
 * `COLIVING_CRITIC_MODEL` 显式设置时完全接管（逃生舱口 / 测试覆盖）。
 */
export function criticModelId(
  forceSensitive = false,
  forceStrong = false
): string {
  const override = process.env.COLIVING_CRITIC_MODEL?.trim();
  if (override) {
    return override;
  }
  return forceSensitive || forceStrong
    ? SENSITIVE_CRITIC_MODEL
    : DEFAULT_CRITIC_MODEL;
}

const CRITIC_TIMEOUT_MS = Number(process.env.COLIVING_CRITIC_TIMEOUT_MS ?? 120_000);

function rubric(): string {
  const brain = getBrain("coliving");
  const mod = brain.situational.find((m) => m.id === "rubric");
  return mod ? readDoctrine(brain, mod) : "";
}

/**
 * relay 专属短审稿视图的**结构标记**。
 *
 * 背景（2026-09-12 第七次 corpus-031 实跑）：relay 的专属契约原先只写在 `taskContext`
 * 里，被夹在约 179 行通用 rubric 与大量事实之间，强模型反复在「来源归属/假匿名/必要
 * 理由/全屋规则」等通用条款间自相矛盾——4.5→4.6 升级仍放行第 2 轮「阿鹏这几天没住
 * 这边」这一非必要第三人行踪。这里把 relay 审稿改成**短、聚焦的专属视图**：命中该
 * 标记时，system 用下面的短条款取代整份通用 rubric；非 relay（标记缺省）继续用完整
 * rubric，行为不变。
 *
 * **用显式结构标记区分两种 relay 视图，不靠 taskContext 是否非空猜**：
 *  - `relay-recipient`：审 AI 代发信人发给收信人的**出站草稿**；
 *  - `relay-sender-reply`：审 AI 回给**发信人**的**回信**。
 * 批量出站里每条带自己的标记（介绍消息不带 → 按通用 rubric 审），互不套用。
 *
 * 内容全部从既有 `domain/relay.md`、rubric 第 1/2/4/10/14/15 条与既有两段 taskContext
 * 提炼，不新增 SOP、不写中文关键词正则替模型决定隐私判断。
 */
export type RelayReviewView = "relay-recipient" | "relay-sender-reply";

/** 审 relay 出站（发给收信人）：对照原始交办逐项查，只报真正的违反。 */
const RELAY_RECIPIENT_REVIEW_VIEW =
  "这是一次一对一传话的**出站**：AI 代发信人联系一个具体收信人。只按下面这几条" +
  "对照原始交办逐项查，**不要套用其它通用清单**；自然换措辞、调语序、省略不影响" +
  "执行的小细节，都不算违反。\n\n" +
  "1. 收件人与角色：这条对得上「替某人请对方配合的那一件事」，不是把对全屋的规矩" +
  "当成对他一个人的要求；**不拿离开当威胁或交换条件**。注意：透明转达一个仍在讨论、" +
  "尚未决定的居住安排议题（要不要继续合住、要不要申请换宿舍），**不是威胁、也不是" +
  "单方面驱逐**——当原始交办明确要求谈这件事时，它是必须保留的核心议题（见第 8 条），" +
  "不能仅因为消息里出现「住／搬／分开」的字面就判失败。\n" +
  "2. 事实：没有编造他没说过、也没人证实过的事，包括对方还没给出的回答。\n" +
  "3. 事实保真——谁拥有、谁做、谁承担：对照原始交办核对**物品属于谁、动作是谁做、" +
  "义务落在谁头上**，换措辞、换代词、调语序都不改变这三样。**不得把收件人的动作或" +
  "义务改记到发信人头上**：交办「让收件人以后自己买自己的那份」，写成「发信人以后" +
  "自己买自己的」就是把收件人的义务换了人，核心要求丢了，fail；保留「往后没问过就" +
  "别拿，收件人自己买自己的」＝pass。\n" +
  "4. 要求落在谁头上：每个要求都落在与这件事确实相关的人头上，不派给「谁先看见谁" +
  "处理」这种运气，也不把别人该做的事派给他。\n" +
  "5. 忠实交办：只有**新增**了发信人没交办的新义务、新对象或新处置（升级成全屋规则、" +
  "调查、排班、长期义务），才算越权；为当前请求说明理由（这事影响了共用的地方、" +
  "别人也不方便）**不算**立规矩。\n" +
  "6. 来源归属：不得改用发信人**第一人称**，也不得虚构「有人」「一位室友」这种谁也" +
  "不是的来源；直接说事情本身、就事论事地用被动句描述物和现状、说明必要理由，" +
  "都是合格的，**不要求每条都实名**。\n" +
  "7. 第三人私密背景：原始交办里顺带提到的第三个人情况（他在不在家、去了哪、疾病、" +
  "关系），逐条问「不说这条，收信人是否仍能理解并完成动作」——能，就不得转告。" +
  "注意区分：**事件对象属于谁**（某样吃的是谁的）可以说，**第三人的行踪**不是事件对象。" +
  "判断范式：第三人「在不在/去了哪」不影响收件人理解和完成当前动作时，带这类行踪的" +
  "草稿 fail；只保留「东西属于谁 + 当前动作请求」的草稿 pass。用户明确要求转告行踪时，" +
  "本反例不适用。\n" +
  "8. 核心议题：交办要谈的核心议题必须保留，不能含糊掉，也不得把还没谈、还没定的事" +
  "写成已经定下。当原始交办明确要求谈是否继续合住、是否换宿舍时，出站**必须保留这个" +
  "议题**，并清楚表达**尚未决定、要听收件人的意见**。判 fail 的只有这几种：把结果写成" +
  "已经定了的事；拿搬走当威胁或交换条件；擅自升级成驱逐。透明说出「想聊聊要不要继续" +
  "一起住／是不是分开住」正是要求内的忠实转达，**pass**。\n" +
  "判断范式（不含本场人名）：原始交办要求约谈「要不要分开住」时，出站保留「想跟你" +
  "聊聊要不要继续一起住、看看是不是分开住」＝pass；只写「聊聊以后怎么住」「聊聊近况」" +
  "把议题含糊掉＝fail；写成「我们已经决定让你搬走」＝fail。**「以后怎么住得舒服／" +
  "之后怎么协调」这类更软的说法不能替代「是否继续合住／是否分开安排」**——对方正是要" +
  "知道这次谈的是去留才能决定来不来，温和不等于含糊；反过来，**原始交办本来没有居住" +
  "去留议题时，也不得自行添加**。";

/** 审 relay 回信（发给发信人）：只交代真实动作与当前状态。 */
const RELAY_SENDER_REPLY_REVIEW_VIEW =
  "这是一次一对一传话的**回信**：收信人是委托 AI 传话的**发信人**，不是被联系的那位。" +
  "AI 到底有没有替他联系上、发出去没有，完全以【这一轮已知的事实】为准——**不预设" +
  "联系已经成功**。只按下面几条查，**不要套用其它通用清单**。\n\n" +
  "1. 动作必须真实发生：被拦下、没发出去的联系不能写成已完成，也不能转述收件人还没" +
  "给出的回答。\n" +
  "2. 给交办人的回信只装两样：真实完成的动作、以及此刻的当前状态——联系了谁、发出去" +
  "没有、在等谁回话；**先如实说明动作是否完成**。**简短点明主题或动作是可以接受的，" +
  "不构成阻断项**——只有**冗长复述**（把发出去的消息整段或大半又念一遍）、重新讲一遍" +
  "道理、加入或改变事实、泄露不该披露的信息、或把未完成说成完成，才判不合格。\n" +
  "3. 下列任何一项判不合格：把发出去的内容**整段或大半复述**（逐条重念让对方做什么、" +
  "为什么）；汇报你怎么措辞、问得多客气；汇报你如何遵守了「私下处理」「没发群」这类" +
  "交代；主动揽下没被交办的后续；把已经完成的联系写成**将来时**（「我这就去说」）；" +
  "事实是没发出去，却声称已经联系上。\n" +
  "4. 边界：由**住户的新反馈**触发、且直接指着眼前这件事的一句条件句（「要是还闹就" +
  "告诉我」）可以留；无条件、由 AI 自己排期的将来承诺（「我再去找他」）仍不合格。\n\n" +
  "判断范式（不含本场人名）：事实是已经成功联系上收信人时，「已经跟他说了，在等他" +
  "回话。」「已经问了，在等他回话。」都 pass；「已经跟他说了，也把这次要改的那件事" +
  "带到了，在等他回话。」只是**偏向啰嗦、本可更短**，**仍算 pass**，不要让整条协调失败；" +
  "只有把发出去的消息**整段或大半**重念一遍（把物品归属、让对方做什么、为什么都逐条" +
  "复述）才 fail。事实是本轮出站全被拦、什么都没发出去时，任何声称已经联系上的回信 " +
  "fail。注意「在等他回话」是 AI 此刻的等待状态，不是虚构对方的回答，不算编造。";

/** 取某个 relay 视图的短条款。 */
export function relayReviewView(view: RelayReviewView): string {
  return view === "relay-recipient"
    ? RELAY_RECIPIENT_REVIEW_VIEW
    : RELAY_SENDER_REPLY_REVIEW_VIEW;
}

/**
 * relay 专属视图与通用 rubric 的选择器（纯函数，供离线检查断言）。
 *
 * - 没有任何 relay 视图（`views` 为空）→ 完整通用 rubric，非 relay 行为不变；
 * - 全是 relay 视图 → 只给短专属条款，不再把 179 行通用清单塞进 relay 审稿；
 * - 混合（既有 relay 又有通用消息，例如同批混自我介绍）→ 两类都列，并显式限定各自
 *   适用范围：介绍消息仍按通用 rubric 审、不被套进 relay，relay 消息也不被通用清单误伤。
 */
export function selectCriticRubric(
  views: RelayReviewView[],
  hasGeneral: boolean
): string {
  const unique = [...new Set(views)];
  if (unique.length === 0) {
    return rubric();
  }
  const relay = unique.map(relayReviewView).join("\n\n");
  if (!hasGeneral) {
    return relay;
  }
  return (
    relay +
    "\n\n上面是 relay 专属短条款，只适用于标注了 relay 审稿视图的消息" +
    "（relay-recipient 是发给收信人的出站、relay-sender-reply 是回给发信人的回信）。" +
    "下面这份完整通用清单**只适用于没有 relay 标注的消息**（例如自我介绍），" +
    "不要把通用清单套到 relay 消息上，也不要把 relay 条款套到普通消息上：\n\n" +
    rubric()
  );
}

export type CriticInput = {
  /** 收信人叫什么 */
  to: string;
  /**
   * 他在这件事里是什么角色。**批判器最需要的就是这个**——
   * 同一段内容发给报告问题的人和发给被说到的人，一个合格一个是指控。
   */
  role:
    | "报告问题的人"
    | "被说到的人"
    | "共用者通知的对象"
    | "受影响的其他人"
    | "不确定";
  /** 他刚才说了什么。没说（主动发起）就留空 */
  said: string;
  /** 这一轮还知道些什么，够批判器判断「有没有说没证据的事」 */
  facts: string;
  /**
   * **这一轮的任务是什么**（只对 relay 这类"交办型"任务填）。不是事实、
   * 也不是话术，是让批判器知道"这条消息在什么任务里、收信人和当前发信人
   * 各是谁"。留空时完全不出现在提示词里，普通对话行为不变。
   */
  taskContext?: string;
  /**
   * relay 专属短审稿视图的结构标记（见 `RelayReviewView`）。设置时 system 用
   * 短专属条款取代完整通用 rubric；缺省时用完整 rubric，非 relay 行为不变。
   */
  view?: RelayReviewView;
  /**
   * relay 选择性强审稿：结构事实表明这是连续关系或多收件人时置位，
   * 用强模型复核（见 `criticModelId`）。非 relay、首次简单提醒都不传。
   */
  forceStrong?: boolean;
  draft: string;
};

/**
 * 单个可解析的 JSON 对象 → Verdict。rubric 明定：单独的客服腔/自我介绍
 * 冗余只是风格问题（第13条），不足以拦截。
 */
function verdictFromParsed(parsed: {
  pass: boolean;
  broke?: unknown;
  why?: unknown;
}): Verdict {
  if (parsed.pass) {
    return PASS;
  }
  const broke = normalizeRuleId(parsed.broke);
  if (broke === "13") {
    return PASS;
  }
  return {
    verified: true,
    pass: false,
    broke,
    why: String(parsed.why ?? ""),
  };
}

export async function critique(args: CriticInput): Promise<Verdict> {
  if (process.env.COLIVING_CRITIC_OFF === "1" || !args.draft.trim()) {
    return UNVERIFIED_PASS;
  }

  // 安全敏感主题（非法驱逐/自杀自伤/歧视/性骚扰/住房公平）升级到 sonnet 复核。
  // facts 也扫一遍：出站审稿里"命中敏感是来自入站 args.text"的消息，收信人
  // said 为空、draft 又不带关键词，敏感上下文只落在 facts 里（"起因是…"那行），
  // 不扫 facts 会把这类整轮敏感的复核漏降级回便宜模型。
  const forceSensitive =
    hasSafetySensitiveTopic(args.said, args.draft) ||
    hasSafetySensitiveTopic(args.facts);
  try {
    const modelId = criticModelId(forceSensitive, args.forceStrong);
    const result = await trackedGatewayCall("critic", modelId, () =>
      generateText({
      abortSignal: AbortSignal.timeout(CRITIC_TIMEOUT_MS),
      model: getLanguageModel(modelId),
      system: [
        {
          role: "system" as const,
          content:
            "你是审稿人，不是作者。有人写了一条要发给住户的短信，" +
            "你对着下面的清单逐条查，只报**真正的违反**。\n" +
            "你不写替代方案，只说第几条、为什么。\n\n" +
            selectCriticRubric(args.view ? [args.view] : [], !args.view),
          // 这段逐字不变（rubric 只在改动doctrine时才变），
          // 一轮对话里批判器常被调好几次（每条 contactPerson 各审一次+
          // 回复本身再审一次），不开缓存等于每次都全价重发这179行清单。
          // 跟主生成路径（turn.ts）同一个做法，之前漏做了。
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
      ],
      messages: [
        {
          role: "user" as const,
          content:
            `【收信人】${args.to}\n` +
            `【他在这件事里的角色】${args.role}\n` +
            (args.taskContext
              ? `【这一轮的任务】${args.taskContext}\n`
              : "") +
            `【他刚才说的话】${args.said || "（没说话，是我们主动发的）"}\n` +
            `【这一轮已知的事实】\n${args.facts}\n\n` +
            `【待发出的消息】\n${args.draft}\n\n` +
            "只回一行 JSON，不要先写别的再写 JSON，也不要写完一个结论后" +
            "自己反悔又补一个——只有一段 JSON，写之前想清楚：\n" +
            '{"pass":true} 或 {"pass":false,"broke":"第几条","why":"一句话"}\n' +
            "why 里要引用消息原文时，不要加引号，直接说是哪句话——" +
            "引号会把 JSON 撑破（真出过：模型自己引用了一句话，" +
            "打回原因解析成了乱码，喂给重写模型时更糟）。",
        },
      ],
      })
    );

    /**
     * **取最后一个能解析的 JSON 对象，不是从第一个 `{` 到最后一个 `}`
     * 贪婪吞一整段。**
     *
     * 真实复现（2026-09-06）：提示词写了"只回一行 JSON"，但批判器有时
     * 会先写一段自我纠正的思考——先给一版判断，中途"让我重新核对"，
     * 再给一版最终结论，一次回复里出现**两个**独立的 ```json``` 代码块。
     * 旧的 `/\{[\s\S]*\}/` 贪婪匹配会从第一段的 `{` 一路吞到第二段的
     * 最后一个 `}`，把两段 JSON 粘成一整坨解析不了的乱码——解析失败后
     * 掉进下面的关键词兜底，兜底又从这坨乱码里硬抠出前半段（被自己推翻
     * 的那版）的"第X条"和只到 100 字就被截断的 why，产生了这次真实
     * 见到的"第第6.6条条"这种重复字符的乱码判词，且用的是模型已经
     * 自己否定掉的旧结论——批判器最终真正的答案（往往是 pass:true）
     * 反而被吞掉了。
     *
     * 修法：抓所有形如单层 `{...}` 的候选（这个 schema 只有
     * pass/broke/why 三个字符串/布尔字段，不会有嵌套花括号），从**最后
     * 一个**往前找，第一个能 `JSON.parse` 成功、且带了 `pass` 字段的
     * 就是模型的最终结论——自我纠正之后的最后一段代表它真正想说的话。
     */
    const jsonCandidates = [...result.text.matchAll(/\{[^{}]*\}/g)].map(
      (x) => x[0]
    );
    for (let i = jsonCandidates.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(jsonCandidates[i]) as Partial<Verdict>;
        if (typeof parsed.pass !== "boolean") {
          continue;
        }
        return verdictFromParsed({
          pass: parsed.pass,
          broke: parsed.broke,
          why: parsed.why,
        });
      } catch {
        // 这一段 JSON 是坏的（多半是 why 里带了没转义的引号）——
        // 继续往前找上一段，别整个放弃。
      }
    }
    // 兜底：模型有时不给 JSON，直接说了理由。**只看回复最后一段**——
    // 理由同上，自我纠正的话早先的草稿不能算数。
    // **只在明确说了不合格时才打回**，含糊的一律放行。
    const tail = result.text.slice(-300);
    if (/"?pass"?\s*[:：]\s*false|不合格|违反了?第/.test(tail)) {
      // 先试着从坏掉的 JSON 里精确抠 why 字段（模型在 why 里加了引号，
      // 把 JSON 撑破时最常见），抠不到才退回粗暴截断。
      const whyField = tail.match(/"why"\s*:\s*"([\s\S]*?)"\s*\}?\s*$/);
      return {
        verified: true,
        pass: false,
        broke: tail.match(/第\s*(\d+(?:\.\d+)?)\s*条/)?.[1] ?? "?",
        why: (
          whyField?.[1] ?? tail.replace(/[\s\S]*?[:：]/, "")
        ).slice(0, 100).trim(),
      };
    }
    return UNVERIFIED_PASS;
  } catch (error) {
    // 评测预算触限是**必须停下**的信号，不能被"判不了就放行"吞掉——
    // 吞掉后这一轮会继续发起下一次调用，预算闸形同虚设。
    if (isEvalBudgetExceeded(error)) throw error;
    console.log(
      "[critic] 判不了，放行：",
      error instanceof Error ? error.message : String(error)
    );
    return {
      ...UNVERIFIED_PASS,
      why: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 从模型回复里尽量稳健地抠出"逐条 verdict"。
 *
 * 优先：文本里**最后一个** `[...]` 数组（模型自纠错时最后一段才是它的最终
 * 结论），解析成一个带 `pass` 的数组，按 `i`（缺省按数组顺序）对齐。
 * 兜底：全文抓单层 `{...}` 对象，凡带 `pass` 的都收下，按 `i` 对齐、同 i 取最后。
 * 抠不到任何可解析的 verdict 返回 `null`——调用方按「默认放行」逐条兜底。
 */
function collectBatchVerdicts(
  text: string
): Array<{ i: number; pass: boolean; broke?: unknown; why?: unknown }> | null {
  const open = text.lastIndexOf("[");
  const close = text.lastIndexOf("]");
  if (open !== -1 && close > open) {
    try {
      const arr = JSON.parse(text.slice(open, close + 1));
      if (Array.isArray(arr) && arr.length > 0) {
        const rows = arr.map((item) =>
          typeof item === "object" && item !== null
            ? (item as { pass?: unknown; broke?: unknown; why?: unknown; i?: unknown })
            : null
        );
        if (rows.every((r) => r !== null && typeof r.pass === "boolean")) {
          return rows.map((r, pos) => {
            const row = r as NonNullable<(typeof rows)[number]>;
            return {
              i: typeof row.i === "number" ? row.i : pos,
              pass: row.pass as boolean,
              broke: row.broke,
              why: row.why,
            };
          });
        }
      }
    } catch {
      // 掉进下面的逐对象兜底。
    }
  }
  const collected: Array<{ i: number; pass: boolean; broke?: unknown; why?: unknown }> =
    [];
  let order = 0;
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      const p = JSON.parse(m[0]) as {
        pass?: unknown;
        broke?: unknown;
        why?: unknown;
        i?: unknown;
      };
      if (typeof p.pass !== "boolean") {
        continue;
      }
      collected.push({
        i: typeof p.i === "number" ? p.i : order++,
        pass: p.pass,
        broke: p.broke,
        why: p.why,
      });
    } catch {
      // 单个坏对象跳过，继续找下一个。
    }
  }
  if (collected.length === 0) {
    return null;
  }
  const byIndex = new Map<number, { i: number; pass: boolean; broke?: unknown; why?: unknown }>();
  for (const row of collected) {
    byIndex.set(row.i, row);
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}

export type BatchCritiqueInput = {
  to: string;
  role: CriticInput["role"];
  /** 他刚才说了什么。主动发（没回话）就留空 */
  said: string;
  facts: string;
  /** 见 `CriticInput.taskContext`：这一轮的任务背景（relay 才填） */
  taskContext?: string;
  /** 见 `CriticInput.view`：这条出站/回信的 relay 审稿视图（每条各自标）。 */
  view?: RelayReviewView;
  /** 见 `CriticInput.forceStrong`：整批只要有一条置位，整批升级强模型。 */
  forceStrong?: boolean;
  draft: string;
};

/**
 * **一次模型调用审一整批出站消息，逐条给 verdict。**
 *
 * 之前每条消息各调一次 `critique`（N 条 = N 次模型往返）。合并成一次调用后：
 * 整批共享同一份 rubric system（缓存命中同一次写入），模型成本与延迟都从
 * N 次降到 1 次。代价是单条上下文没有以前那么"隔离"，所以每条仍然带自己的
 * 收信人/角色/事实，提示词要求逐条独立、按数组下标对齐。
 *
 * 安全语义与单条 `critique` 完全一致：
 *  - 命中安全敏感主题 → 整批升级 sonnet；任一条带 `forceStrong`（relay 选择性强审稿）
 *    也整批升级同一个强模型（整批只调一次模型，没法逐条换模型）；
 *  - 解析失败 / 某一条没给 verdict → 该条按 UNVERIFIED_PASS（默认放行）兜底，
 *    绝不因合并批量让一条本来会被拦的消息"漏拦"，也不让一条解析失败的把整批拖垮。
 *  - 单条直接复用 `critique` 的单条提示词路径，行为与合并前完全一致。
 */
export async function critiqueBatch(
  entries: BatchCritiqueInput[]
): Promise<Verdict[]> {
  const fallback = (why = ""): Verdict[] =>
    entries.map(() => ({ ...UNVERIFIED_PASS, why }));
  if (process.env.COLIVING_CRITIC_OFF === "1" || entries.length === 0) {
    return fallback();
  }
  // 单条：复用 `critique` 的单条提示词，跟合并前逐条调用时一模一样。
  if (entries.length === 1) {
    return [
      await critique({
        to: entries[0].to,
        role: entries[0].role,
        said: entries[0].said,
        facts: entries[0].facts,
        taskContext: entries[0].taskContext,
        view: entries[0].view,
        forceStrong: entries[0].forceStrong,
        draft: entries[0].draft,
      }),
    ];
  }
  const forceSensitive = entries.some(
    (e) =>
      hasSafetySensitiveTopic(e.said, e.draft) ||
      hasSafetySensitiveTopic(e.facts)
  );
  // 整批共享一次模型调用，所以强审稿是批级：任一条要求强审就整批升级。
  const forceStrong = entries.some((e) => e.forceStrong);
  /**
   * 整批共享一份 system，所以按**条目自带的视图标记**决定装载什么：
   * 全 relay → 只装短专属条款；含通用条目（如自我介绍）→ 两类条款都装，
   * 并在 user content 里逐条标清该条用哪个视图，避免错位套用。
   */
  const views: RelayReviewView[] = [];
  let hasGeneral = false;
  for (const e of entries) {
    if (e.view) {
      views.push(e.view);
    } else {
      hasGeneral = true;
    }
  }
  try {
    const batchModelId = criticModelId(forceSensitive, forceStrong);
    const result = await trackedGatewayCall("critic-batch", batchModelId, () =>
      generateText({
      abortSignal: AbortSignal.timeout(CRITIC_TIMEOUT_MS),
      model: getLanguageModel(batchModelId),
      system: [
        {
          role: "system" as const,
          content:
            "你是审稿人，不是作者。有人写了一批要发给住户的短信，" +
            "你对着下面的清单逐条查，只报**真正的违反**。\n" +
            "你不写替代方案，只说第几条、为什么。\n\n" +
            selectCriticRubric(views, hasGeneral),
          // rubric 逐字不变，整批与同轮其它批判器调用共享同一份缓存。
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
      ],
      messages: [
        {
          role: "user" as const,
          content:
            `下面是要逐条审的待发消息，一共 ${entries.length} 条：\n\n` +
            entries
              .map(
                (e, idx) =>
                  `【消息 ${idx}】\n收信人：${e.to}\n` +
                  `他在这件事里的角色：${e.role}\n` +
                  (e.view ? `审稿视图：${e.view}\n` : "") +
                  (e.taskContext ? `这一轮的任务：${e.taskContext}\n` : "") +
                  `他刚才说的话：${e.said || "（没说话，是我们主动发的）"}\n` +
                  `这一轮已知的事实：\n${e.facts}\n\n` +
                  `待发出的消息：\n${e.draft}`
              )
              .join("\n\n---\n\n") +
            "\n\n每条**独立**判断——不要因为同批有别人，就把某一条" +
            "放行或打回。只回一段 JSON 数组，不要先写别的再写 JSON，也不要" +
            "自我纠正后又补一段——只有一段 JSON，写之前想清楚：\n" +
            '[{"i":0,"pass":true},{"i":1,"pass":false,"broke":"第几条","why":"一句话"}]\n' +
            "i 必须对应当前消息的编号。why 里要引用消息原文时，不要加引号，" +
            "直接说是哪句话——引号会把 JSON 撑破（真出过）。",
        },
      ],
      })
    );

    const rows = collectBatchVerdicts(result.text);
    if (!rows) {
      return fallback("批判器没有返回可解析的批量结论");
    }
    const verdicts = new Array<Verdict>(entries.length).fill(UNVERIFIED_PASS);
    for (const row of rows) {
      if (Number.isInteger(row.i) && row.i >= 0 && row.i < entries.length) {
        verdicts[row.i] = verdictFromParsed(row);
      }
    }
    return verdicts;
  } catch (error) {
    // 同 critique：预算触限必须向上抛，不能被"整批放行"吞掉。
    if (isEvalBudgetExceeded(error)) throw error;
    console.log(
      "[critic] 批量判不了，整批放行：",
      error instanceof Error ? error.message : String(error)
    );
    return fallback(error instanceof Error ? error.message : String(error));
  }
}

/** 生成器没被调用时也别浪费一次审稿 */
export function criticEnabled(): boolean {
  return process.env.COLIVING_CRITIC_OFF !== "1";
}

export { colivingModelId };
