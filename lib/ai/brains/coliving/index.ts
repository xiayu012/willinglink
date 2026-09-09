import { join } from "node:path";
import type { Brain } from "../types";

/**
 * 合租房管理大脑。
 *
 * 场景：美国低价合租房，互不相识的成年人分租一套房。
 * 准则来源与可靠性审计见 doctrine/ 目录外的调研档案（Downloads/合租房AI资料源）。
 */
export const colivingBrain: Brain = {
  id: "coliving",
  title: "合租房管理",
  description:
    "美国低价合租房的住户沟通、冲突调解、投诉受理、规则执行与记录留痕。",
  doctrineDir: join(process.cwd(), "lib/ai/brains/coliving/doctrine"),

  /**
   * 顺序即优先级。四份常驻，从抽象到具体：
   *
   *   identity       你是谁、能力面、住户处境、真实价值——先把身份立住
   *   constitution   十四条，正面表述、描述行为。**新情况从这里推**
   *   arbitration    目标与仲裁：三道闸、协调员定位、立场、禁区
   *   craft          手法：措辞、格式
   *
   * 为什么 identity 在最前：模型要先知道自己是谁、住户是什么处境，再读规则。
   * arbitration 属于 domain 层（想加情境仲裁模块时按同一层处理），但这份必须
   * 常驻——三道闸/禁区/决定权是每条消息的门槛，不能赌路由命中。
   *
   * 为什么要最上面那层：一个 bug 加一条规则，规则会越堆越多、互相抵消，
   * 而且没覆盖到的新情况照样出错。宪法是让它**能自己推**的那一层。
   * 十四条这个规模、正面表述、描述行为——都是照 C3AI（ACM Web Conf 2025）
   * 的实证结论定的，不是我拍的。
   */
  always: [
    {
      id: "identity",
      title: "身份与处境",
      file: "always/identity.md",
      layer: "identity",
      purpose: "你是谁、能力面、住户处境、真实价值——先立身份再谈规则",
    },
    {
      id: "constitution",
      title: "宪法十四条",
      file: "always/constitution.md",
      layer: "invariant",
      purpose: "不变的行为底线，没覆盖到的新情况回到这里推",
    },
    {
      id: "arbitration",
      title: "目标与仲裁",
      file: "always/arbitration.md",
      layer: "domain",
      // 它属于 domain 层，但必须常驻——三道闸/禁区/决定权是每条消息的门槛，
      // 不能像 conflict 那样等路由命中才加载。
      purpose: "三道闸、协调员定位、立场、禁区——任何话发出前的门槛",
    },
    {
      id: "craft",
      title: "手法",
      file: "always/craft.md",
      layer: "communication",
      purpose: "怎么说、怎么落地：格式与措辞",
    },
  ],

  /**
   * 审稿清单 `rubric` **不进任何一次生成**，只有批判器读它（critic.ts）。
   * 放在这里只是为了复用 doctrine 的读取与缓存——
   * 它没有对应的 route 规则，路由永远不会命中它。
   *
   * 为什么单独一份：宪法是「没写过的情况怎么推」，清单是「这条写好的消息
   * 哪里不对」。推理要抽象原则，检查要具体问题。用同一份文档干两件事，
   * 检查那一侧就会形同虚设（真出过：批判器放行了一条读起来像指控的消息）。
   */
  situational: [
    {
      id: "rubric",
      title: "审稿清单（仅批判器用）",
      file: "rubric/rubric.md",
      layer: "rubric",
    },
    {
      id: "conflict",
      title: "室友冲突调解",
      file: "domain/conflict.md",
      layer: "domain",
    },
    {
      id: "complaint-risk",
      title: "主动询问 / 投诉受理 / 风险升级",
      file: "domain/complaint-risk.md",
      layer: "domain",
    },
    {
      id: "tenancy",
      title: "入住 / 规则 / 退租",
      file: "domain/tenancy.md",
      layer: "domain",
    },
    {
      id: "money",
      title: "金钱边界",
      file: "special-cases/money.md",
      layer: "special-case",
    },
    {
      id: "shared-resources",
      title: "共用设施与资源争抢",
      file: "special-cases/shared-resources.md",
      layer: "special-case",
      purpose: "厨房/卫浴/洗衣/清洁/噪音/访客等共用资源的具体处置库",
    },
    {
      id: "records",
      title: "记录 / 转交 / 拒绝不当指令",
      file: "tool/records.md",
      layer: "tool",
    },
  ],

  routes: [
    // ── 安全与法律风险：无条件加载，不占额度 ──────────────────────────
    {
      match: [
        /打|threat|威胁|暴力|violence|刀|knife|武器|weapon|枪|gun/i,
        /自杀|自残|一了百了|不想活|suicide|kill myself|hurt myself/i,
        /性骚扰|猥亵|sexual|harass|摸我|骚扰/i,
        /家暴|domestic violence|男朋友打|老公打|伴侣打/i,
        /着火|起火|fire|煤气|燃气|gas leak|漏电/i,
      ],
      modules: ["complaint-risk"],
      force: true,
      reason: "安全信号，无条件加载风险与升级判据",
    },
    {
      match: [
        // 词序灵活：「换锁」「门锁换了」「把锁给换掉」都要命中
        /换.{0,6}锁|锁.{0,6}换|撬.{0,4}锁|锁.{0,4}(起来|上)/,
        /断水|断电|停水|停电|拉闸|把.{0,8}(东西|行李).{0,6}(搬|扔|清)|赶.{0,4}出去|撵走|轰走/,
        /lock.*(out|change)|change.*lock|shut.*(off|down).*(water|power|utilit)|evict|kick.*out|throw.*out/i,
        /歧视|discriminat|种族|因为(他|她)是|report.*ICE|举报.*移民|遣返/i,
        /报复|retaliat|因为.{0,10}投诉.{0,10}(所以|才)/,
      ],
      modules: ["records"],
      force: true,
      reason: "涉嫌歧视/报复/非法驱逐，无条件加载拒绝链条",
    },

    // ── 结构信号：提到其他住户 / 存在未结冲突 ──────────────────────
    // 名册匹配比关键词可靠（真实投诉说的是"做饭""挨饿"，不一定带"室友"字眼）；
    // 未结冲突本身就是比本轮关键词更可靠的结构信号。命中即无条件加载。
    {
      when: [{ key: "mentionsOther" }, { key: "hasOpenConflictCase" }],
      modules: ["conflict"],
      force: true,
      reason: "结构信号：提到其他住户，或存在未结冲突",
    },

    // ── 简单事实询问：短路，避免为一句话查询拉进整份准则 ──────────────
    // 三个条件同时满足才算：够短(≤30字) + 含疑问词 + 不涉及具体某个人。
    // 涉及人的短问句（"他几点回来的?"）不走这条——那可能是冲突或隐私问题。
    {
      match: [
        /^(?=[\s\S]{0,30}$)(?![\s\S]*(他|她|室友|房友|楼上|楼下|隔壁|那个人|roommate|housemate))[\s\S]*(周几|礼拜几|星期几|哪天|几点|什么时候|多久|多少钱|在哪|怎么走|规定|可以吗|行吗|能不能)/,
      ],
      modules: ["tenancy"],
      exclusive: true,
      reason: "简单事实询问（短句+疑问词+不涉及具体某人）",
    },

    // ── 常规情境 ────────────────────────────────────────────────
    {
      match: [
        /室友|房友|同住|roommate|housemate|楼上|楼下|隔壁|另一个人|那个人/,
        /吵|噪音|noise|loud|太响|睡不着|动静/,
        /脏|不洗|卫生|clean|dirty|垃圾|trash|臭|味|smell|油烟|做饭.*(味|臭)/,
        /占|抢|厨房|灶|卫生间|浴室|洗澡|洗手间|马桶|洗衣|冰箱|停车|客厅|阳台/,
        /kitchen|bathroom|shower|laundry|fridge|parking|living room/i,
        // 真实投诉的说法：多数不含设施名，只讲行为与感受
        /做饭|做菜|煮饭|用餐|吃饭|挨饿|等不到|轮不到|排不上/,
        /不公平|凭什么|一直占|老是占|总是占|太久|时间太长|每次都/,
        /轮流|排班|时段|错开|先来后到/,
        /带人|客人|guest|过夜|留宿|女朋友|男朋友.{0,4}住/,
      ],
      modules: ["conflict"],
      reason: "同住人之间的摩擦",
    },
    {
      // 资源争抢的处置库：只匹配「争抢/行为」信号，不匹配裸设施名
      // （避免「厨房漏水」这种报修也拉进资源处置库——报修走 records）
      match: [
        /做饭|做菜|煮饭|用餐|吃饭|挨饿|排班|时段|错开|先来后到|轮流/,
        /脏|不洗|卫生|垃圾|trash|臭|味|smell|油烟|清洁|打扫/,
        /吵|噪音|noise|loud|太响|睡不着|动静|外放/,
        /带人|客人|guest|过夜|留宿/,
        /占|抢|不公平|凭什么|一直占|老是占|总是占|太久|时间太长|每次都/,
        /冰箱|储物|纸巾|洗洁精|我的东西/,
        /kitchen|bathroom|shower|laundry|fridge|parking/i,
      ],
      modules: ["shared-resources"],
      reason: "共用设施/资源争抢的具体处置库",
    },
    {
      match: [
        /投诉|反映|受不了|忍不了|complain|不舒服|不顺手/,
        /丢了|被偷|不见了|steal|stolen|missing/,
        /怕|担心|不安全|scared|unsafe|afraid/,
      ],
      modules: ["complaint-risk"],
      reason: "投诉表达或风险信号",
    },
    {
      match: [
        /房租|租金|rent|押金|deposit|水电|账单|bill|utilit|分摊|split|欠|late|交钱|付款|pay/i,
      ],
      modules: ["money"],
      reason: "金钱相关",
    },
    {
      match: [
        /搬进|入住|新来|move in|新室友|刚到/,
        /搬走|退租|move out|不住了|退房|通知期/,
        /规矩|规则|rule|policy|几点|安静时段|quiet hours|能不能.*养|可以.*抽烟/,
      ],
      modules: ["tenancy"],
      reason: "入住 / 规则 / 退租",
    },
    {
      match: [
        /报修|坏了|修|漏水|leak|broken|fix|repair|不出热水|没热水|马桶|空调|暖气/,
        /记录|留痕|证据|record|document|之前说过/,
      ],
      modules: ["records"],
      reason: "报修转交或记录留痕",
    },
  ],

  // 判断不了时给风险与升级判据——它包含定级标准，是最安全的兜底
  fallback: ["complaint-risk"],

  // 资源争抢消息会同时命中 conflict + shared-resources，且可能叠加 complaint-risk，
  // 2 会挤掉安全/风险模块。
  maxSituational: 3,
};
