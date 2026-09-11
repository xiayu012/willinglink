/**
 * **用户意图 × 能力模块架构 V0（评测专用，纯结构 + 纯函数校验）。**
 *
 * 老板方向：把系统整理成「能力模块」，让能力边界更清楚；同时把住户找上来的
 * **意图和目的**作为长期开发的一等维度。Codex 与既有 H3–H6、工具链盘点、V4
 * 逐动作计划对齐，但两个退化必须避免：
 *
 * 1. **能力模块不能退化成一堆提示词文件**——所以每个模块是「动词 + 可验收结果」，
 *    必须写清必要输入、**允许使用的真实工具名**、成功收据、停止条件和 doctrine 来源；
 *    `available | partial | blocked` 由外部可观察条件决定，不由模型自报信心。
 * 2. **意图不能退化成一个单标签分类器**——所以一条消息可以拆成**多个**意图项，
 *    每项各自表达目标、动作、对象、授权原话、限制和完成标准。
 *
 * 本模块只做三件事（完全离线，不接生产）：
 * - 定义**能力模块 registry**、**跨模块门禁（cross-cutting policies）**和
 *   **领域 playbook** 三份索引的类型与内容；
 * - 定义**用户意图契约** `IntentEnvelope`（核心业务字段 ≤ 6 个）；
 * - 提供**纯函数**校验：registry 一致性、意图证据可追溯、blocked 不得被当成可执行。
 *
 * 边界（写死在代码里，别在这里加东西）：
 * - **不接入生产**：`runColivingTurn`、critic、`contactPerson` 都不引用本文件；
 *   这里没有 repo、没有 DB、没有任何发送动作，只有类型、纯数据和纯函数。
 * - **不 import 生产 turn/repo**：工具名核对靠读取 `turn.ts` 源码文本
 *   （`extractProductionToolNames`），不是 import 它。
 * - **不调用模型/网关、不加载 .env、不联网**。
 * - 语义判断由开发者手写的离线期望样例给出；这里只做状态一致性校验，
 *   **不用正则或关键词声称已经验证「意图理解正确」**。
 *
 * 与 V4 `action-plan.ts` 的关系：V4 管**一轮请求内部的逐动作执行状态**
 * （planned / waiting_reply / done / stopped、依赖、收据）。本文件**不复制**那套
 * 执行状态——意图项只表达**用户侧**的目标、授权、限制和完成标准；能力模块只表达
 * **系统侧**当前能可靠做到什么（成熟度），两者在报告里并排展示、互不冒充。
 */

// ── 能力模块成熟度 ─────────────────────────────────────────────────────────

/**
 * 能力当前成熟度。**由外部可观察条件决定，不问模型自报信心。**
 *
 * ⚠️ **`available` 不等于「线上稳定可用」**：本轮只有离线结构和事故记录，
 * 没有任何在线效果证据。`available` 只表示该能力**已经有一组当前已实现的确定性执行构件
 * （代码）与可核验回执**，不表示模型在有竞争注意力时会稳定地路由到它、按顺序编排它，
 * 也不表示线上效果已验证。`available` 与 `partial` 的区别只在**是否已有可核验的确定性
 * 构件**，不在「模型是否总会用它」。
 * - `available`：具备当前已实现的确定性执行构件 + 可核验回执（仍依赖模型正确路由）；
 * - `partial`：结构存在，但**历史有漏动作/漏通知证据**，或依赖尚未建立的组合工具，
 *   **不得当作稳定可用**（报告必须显式区分，见 `MATURITY_STABILITY`）；
 * - `blocked`：当前版本不独立协调，**没有任何允许执行工具、没有成功收据**。
 */
export const CAPABILITY_MATURITIES = ["available", "partial", "blocked"] as const;
export type CapabilityMaturity = (typeof CAPABILITY_MATURITIES)[number];

/**
 * 成熟度 → 报告用稳定性措辞。用来机械保证「partial 不被报告包装成稳定可用」：
 * `partial` 的稳定性词必须既不是 `available` 的、也不含「stable/稳定可用」字样。
 * `available` 的措辞也刻意不用 `stable`——它只表示确定性执行构件已具备。
 */
export const MATURITY_STABILITY: Record<CapabilityMaturity, string> = {
  available: "components_only",
  partial: "partial_only",
  blocked: "unsupported",
};

/**
 * 报告里展示的成熟度标签（不加载远程资源，纯字符串）。
 * **`available` 的标签必须同时说明它不代表模型路由或线上效果稳定**，否则会超出本轮离线证据。
 */
export const MATURITY_LABEL: Record<CapabilityMaturity, string> = {
  available:
    "具备执行构件（available）——仅指确定性构件与可核验回执已实现，不代表模型路由或线上效果稳定",
  partial: "部分可用（partial）——结构存在但历史有漏动作证据，不得当作稳定能力",
  blocked: "当前不支持（blocked）",
};

// ── 能力模块 ───────────────────────────────────────────────────────────────

/** 一个能力模块 = 一个「动词 + 可验收结果」。至少说明下面这些字段。 */
export type CapabilityModule = {
  /** 稳定 id，全 registry 唯一。 */
  id: string;
  /** 人话标题（动词 + 对象）。 */
  title: string;
  /** **可验收结果**：什么发生了才算这件事做成了（不是「尽力了」）。 */
  verifiableOutcome: string;
  maturity: CapabilityMaturity;
  /** 必要输入：缺了就不该开始。 */
  requiredInputs: string[];
  /**
   * 允许使用的**实际工具名**——必须存在于当前生产工具定义
   * （`lib/chat/coliving/turn.ts`，由 `extractProductionToolNames` 核对）。
   * `blocked` 模块必须为空数组。
   */
  allowedTools: string[];
  /** 成功收据：什么可核验的记录证明结果真的发生。`blocked` 必须为空数组。 */
  successReceipts: string[];
  /** 主要停止条件：命中就不该开始或必须停下。 */
  stopConditions: string[];
  /** Doctrine / 来源引用（文件·小节）。 */
  sources: string[];
  /** 相关领域 playbook id（指向 `DOMAIN_PLAYBOOKS`）。 */
  playbooks: string[];
};

/**
 * **首批能力模块（最多 7 个，从当前真实工具链归纳）。**
 *
 * 成熟度判断依据（不因为 `turn.ts` 有某个工具就把整条多步能力标成 available）：
 * - 排班「生成草案」是**两个工具**的链（`pickSchedule` 算候选 → `chooseSchedule` 选定），
 *   生产 `turn.ts` 有多处真实事故注释记录模型漏调 `pickSchedule`/`chooseSchedule`、
 *   自己心算数字、或链路耗尽（例如 `turn.ts` 关于「模型没有照抄工具返回的数字，自己
 *   心算/瞎编了一版」「单轮 pickSchedule → chooseSchedule → 逐个 contactPerson →
 *   sendReply 经常漏掉一个或几个」的注释）→ `partial`，**不得写「历史无漏步骤证据」**；
 * - 「收集约束 / 分发方案 / 分发规则 / 开冲突跟进」都是跨多个可独立失败调用的链，
 *   历史有漏动作、漏通知、漏记录证据（见 `TOOL_CHAIN_INVENTORY.md` 链路 1–4）
 *   → 一律 `partial`，即使单个工具都存在；
 * - 「无既有依据时决定新费用分摊」没有可靠依据，且现有 doctrine 明确不许 AI 自定
 *   → `blocked`，不得列出任何执行工具。
 */
export const CAPABILITY_REGISTRY: readonly CapabilityModule[] = [
  {
    id: "send-targeted-message",
    title: "发送一条定向消息",
    verifiableOutcome:
      "指定对象收到一条最小化、目的明确的短信（提醒/告知），本轮产生该收件人的真实投递收据",
    maturity: "available",
    requiredInputs: [
      "收件人姓名（必须在名册内）",
      "这条消息的目的",
      "最小化正文（不泄露来源、不夹带内部过程）",
      "发出依据（住户明确请求，或协调员职责）",
    ],
    // 只留 contactPerson：sendReply 是回复**当前发信人**，不是向指定第三方定向联系，
    // 也没有对应当前 success receipt，故不得列为本能力的允许执行工具。
    allowedTools: ["contactPerson"],
    successReceipts: ["contactPerson 返回的该收件人投递结果（含 sentTo）"],
    stopConditions: [
      "收件人不在名册，或没有登记地址",
      "正文将暴露信息来源或只有当事人才知道的私密细节",
      "住户要求隐藏来源且存在可反推风险",
      "本轮已经给同一个人发过（不重复联系）",
    ],
    sources: [
      "always/identity.md",
      "always/craft.md",
      "tool/records.md",
      "domain/conflict.md（不透露是谁反映的）",
    ],
    playbooks: [],
  },
  {
    id: "collect-constraint",
    title: "联系参与者收集一个约束",
    verifiableOutcome:
      "一名参与者的可用时间/偏好约束被问到并被记录，可在后续计算或规则里被引用",
    maturity: "partial",
    requiredInputs: [
      "目标参与者姓名（名册内）",
      "要收集的具体约束（时间/偏好/边界）",
      "一个明确的问法（contactPerson 的 act=ask）",
      "记录去向（recordPosition，未立案也可记）",
    ],
    allowedTools: ["contactPerson", "recordPosition"],
    successReceipts: [
      "contactPerson 返回的投递结果",
      "recordPosition 返回 ok（该人表态已入库）",
    ],
    stopConditions: [
      "缺发信人自己的关键事实时，不得为了「已行动」去联系别人",
      "住户要求暂不发送，或要求隐藏来源且存在反推风险",
      "本轮已联系过该参与者",
    ],
    sources: [
      "domain/conflict.md（分别私聊、事实化）",
      "tool/records.md（送达记录）",
      "always/craft.md",
    ],
    playbooks: ["scheduling"],
  },
  {
    id: "draft-schedule",
    title: "生成排班草案",
    verifiableOutcome:
      "在给定窗口与硬约束下，代码穷举出候选并**选定唯一草案**（内部计算，不对外发送）",
    // 成熟度 = partial：确定性构件（scheduling.ts 的穷举 + pickSchedule/chooseSchedule
    // 两个工具）确实实现且可核验，但这条是**两工具链**，生产 turn.ts 有多处真实事故注释
    // 记录模型漏调 pickSchedule/chooseSchedule、自己心算数字或链路耗尽——因此不得标
    // available，也不得声称「历史无漏步骤证据」。
    maturity: "partial",
    requiredInputs: [
      "窗口名与窗口起点（HH:MM）",
      "至少两人的占用时长与时间约束（硬约束/软偏好分开填）",
    ],
    allowedTools: ["pickSchedule", "chooseSchedule"],
    successReceipts: [
      "chooseSchedule 返回 ok（该窗口已选定候选，后续消息必须对齐它）",
    ],
    stopConditions: [
      "参与人少于两人（一个人不需要排）",
      "硬约束互相顶死、物理上无可行候选",
      "缺发信人自己的关键可用时间（先问，不硬排）",
    ],
    sources: [
      "special-cases/scheduling.md",
      "always/arbitration.md（方案由协调员算）",
      "lib/chat/coliving/scheduling.ts（组合计算交给代码）",
    ],
    playbooks: ["scheduling"],
  },
  {
    id: "distribute-schedule",
    title: "向受影响者分发排班草案",
    verifiableOutcome:
      "每位受影响者各收到**自己那份**时段并有机会回应；份额与受影响关系入库",
    maturity: "partial",
    requiredInputs: [
      "已选定方案的 windowLabel",
      "每位参与者的 scheduleSlot（必须与选定候选一致）",
      "受影响者名单",
      "沟通口径（为什么这样排，一句话）",
    ],
    allowedTools: [
      "chooseSchedule",
      "contactPerson",
      "recordShare",
      "notePartyAffected",
    ],
    successReceipts: [
      "每位受影响者一条 contactPerson 投递收据（scheduleVerified）",
      "每位参与者一条 recordShare 已入库",
      "受影响关系 notePartyAffected 已入库",
    ],
    stopConditions: [
      "尚未用 chooseSchedule 选定方案",
      "消息里的时段与选定候选不一致（代码会拒绝执行）",
      "有人不在名册内，或本轮重复联系",
    ],
    sources: [
      "always/constitution.md（每位受影响者收到自己那份）",
      "tool/records.md（分栏记录、送达）",
      ".claude/TOOL_CHAIN_INVENTORY.md（链路 1；组合工具 publishSchedulePlan 尚未实现）",
    ],
    playbooks: ["scheduling"],
  },
  {
    id: "circulate-rule",
    title: "分发共同规则提议并收集立场",
    verifiableOutcome:
      "规则草案已发给每位居住者，逐人立场入库；**全问过**才判定成立，有异议则不算成立",
    maturity: "partial",
    requiredInputs: [
      "规则草案（kind + 一句话 statement，含具体钟点与人名）",
      "受影响的居住者名单（不能默认名册全屋）",
      "已有表态（谁已明确同意/异议）",
    ],
    allowedTools: ["proposeRule", "contactPerson", "recordStance"],
    successReceipts: [
      "proposeRule 返回 ruleId",
      "每位居住者一条 contactPerson 投递收据",
      "recordStance 逐人入库；closeConsultationIfComplete 判定是否问全",
    ],
    stopConditions: [
      "把「已发送」当成「已同意」",
      "还没问全就宣布规则成立",
      "有人提了异议却仍宣布成立",
      "参与范围没有界定（不能把名册自动当全屋）",
    ],
    sources: [
      "always/arbitration.md（共同事项参与权）",
      "domain/conflict.md（向另一方求证、形成约定）",
      "special-cases/house-rules.md",
    ],
    playbooks: ["guest", "noise", "cleanliness"],
  },
  {
    id: "open-conflict-followup",
    title: "开启冲突跟进并进入等待状态",
    verifiableOutcome:
      "案件已建立/复用；报告内容记为**一方主张**并保留来源；受影响者已标记；另一方已联系；等待状态已建",
    maturity: "partial",
    requiredInputs: [
      "报告内容（发生了什么）",
      "被谈到的人",
      "影响范围",
      "需要向另一方确认的一个问题",
      "披露边界（能不能暴露来源）",
    ],
    allowedTools: [
      "logEvent",
      "recordPosition",
      "notePartyAffected",
      "contactPerson",
      "scheduleReminder",
    ],
    successReceipts: [
      "caseId 已返回（新建或复用）",
      "party_claim 记录已入库并保留来源",
      "受影响者名单已入库",
      "对另一方的投递收据",
      "等待状态（在等谁回话）已建",
    ],
    stopConditions: [
      "只有单方陈述却准备给另一方定性",
      "存在可反推的来源暴露风险且信息所有者未同意",
      "命中安全、法律、报复、非法驱逐等升级信号",
    ],
    sources: [
      "domain/conflict.md（异步调解流程）",
      "domain/complaint-risk.md（受理与风险分级）",
      "tool/records.md（事实/主张/未知分栏、跟进闭环）",
    ],
    playbooks: ["noise", "cleanliness", "guest"],
  },
  {
    id: "decide-cost-split-without-basis",
    title: "无既有依据时决定新费用分摊",
    verifiableOutcome:
      "（当前版本不支持）在账面缺乏既有分摊依据时，由 AI 创设一套新的费用承担规则",
    maturity: "blocked",
    requiredInputs: [
      "既有分摊约定或可核实的账单明细——**无既有依据时这项前提不存在，因此不可执行**",
    ],
    allowedTools: [],
    successReceipts: [],
    stopConditions: [
      "缺少既有分摊依据，却要求 AI 自行确定谁承担多少",
      "需要 AI 判断「谁用得多」并据此分配费用",
      "涉及金钱权限，超出协调员可独立处理的范围",
    ],
    sources: [
      "special-cases/money.md（无约定不自行确定分摊方式）",
      "always/arbitration.md（不决定收多少、扣多少、免多少）",
      ".claude/CAPABILITY_BOUNDARY_V0.md（能力边界：做不到就说清具体限制）",
    ],
    playbooks: ["money"],
  },
];

// ── 跨模块门禁（cross-cutting policies）────────────────────────────────────

/**
 * 跨模块门禁：隐私、事实来源、决定权、公平、完成收据。
 * **不是能力模块**：没有任何工具、没有成熟度、不能被当成可执行动作调用。
 * 它们约束所有模块，因此集中一处，避免在每个模块里复制成会漂移的副本。
 */
export type CrossCuttingPolicy = {
  id: string;
  title: string;
  /** 这条门禁约束哪些能力模块（capability id）。 */
  appliesToCapabilities: string[];
  /** 门禁要求（一句正面、可判断的话）。 */
  rule: string;
  sources: string[];
};

export const CROSS_CUTTING_POLICIES: readonly CrossCuttingPolicy[] = [
  {
    id: "privacy-disclosure",
    title: "隐私与披露最小化",
    appliesToCapabilities: [
      "send-targeted-message",
      "collect-constraint",
      "distribute-schedule",
      "circulate-rule",
      "open-conflict-followup",
    ],
    rule:
      "不透露是谁反映的；只给收件人必须知道的信息；存在可反推风险且信息所有者未同意时，联系行为阻塞",
    sources: [
      "always/constitution.md",
      "always/craft.md",
      "domain/complaint-risk.md（来源暴露）",
      "domain/conflict.md（保护来源）",
    ],
  },
  {
    id: "fact-source",
    title: "事实来源可追溯",
    appliesToCapabilities: [
      "collect-constraint",
      "distribute-schedule",
      "circulate-rule",
      "open-conflict-followup",
      "decide-cost-split-without-basis",
    ],
    rule:
      "区分可核实事实 / 一方主张 / 系统记录 / 未知；一方说法不得改写成已证实的陈述",
    sources: [
      "always/constitution.md",
      "tool/records.md",
      "rubric/rubric.md",
    ],
  },
  {
    id: "decision-rights",
    title: "决定权归属",
    appliesToCapabilities: [
      "draft-schedule",
      "distribute-schedule",
      "circulate-rule",
      "open-conflict-followup",
      "decide-cost-split-without-basis",
    ],
    rule:
      "流程与计算由协调员负责；共同生活规则要问过受影响者一轮才算成立；个人边界由当事人决定；费用承担不由 AI 创设",
    sources: [
      "always/arbitration.md",
      "domain/conflict.md",
      "special-cases/money.md",
    ],
  },
  {
    id: "fairness",
    title: "公平与可执行",
    appliesToCapabilities: ["draft-schedule", "distribute-schedule", "circulate-rule"],
    rule:
      "分配要算过且合理，不依赖住户长期记忆或人工监督；公平尺度由代码给出，不靠模型心算",
    sources: ["always/constitution.md", "always/arbitration.md"],
  },
  {
    id: "completion-receipts",
    title: "完成收据与承诺兑现",
    appliesToCapabilities: [
      "send-targeted-message",
      "collect-constraint",
      "distribute-schedule",
      "circulate-rule",
      "open-conflict-followup",
    ],
    rule:
      "说了要联系谁本轮就真的联系到，并有该动作自己的投递记录；未完成不得说成已完成",
    sources: [
      "always/constitution.md",
      "tool/records.md",
      "always/craft.md",
    ],
  },
];

// ── 领域 playbook ──────────────────────────────────────────────────────────

/**
 * 领域 playbook：guest / noise / cleanliness / money / scheduling 等专项做法，
 * **只在命中话题时检索**。它不是能力模块——没有工具、没有成熟度，不能冒充可执行动作，
 * 也不该各自复制成同构能力模块。
 */
export type DomainPlaybook = {
  id: string;
  title: string;
  /** 这个 playbook 在什么话题下才被检索。 */
  scope: string;
  sources: string[];
};

export const DOMAIN_PLAYBOOKS: readonly DomainPlaybook[] = [
  {
    id: "guest",
    title: "访客 / 过夜",
    scope: "有人带朋友回来、过夜、长时间停留引发共用资源使用变化时检索",
    sources: ["special-cases/guests.md", "special-cases/house-rules.md"],
  },
  {
    id: "noise",
    title: "噪音 / 安静时段",
    scope: "休息时段、持续噪音、安静时段规则时检索",
    sources: ["special-cases/noise.md"],
  },
  {
    id: "cleanliness",
    title: "清洁 / 共用空间",
    scope: "公共区域清洁、分工、卫生投诉时检索",
    sources: ["special-cases/cleanliness.md"],
  },
  {
    id: "money",
    title: "金钱 / 费用",
    scope: "租金、押金、公用费用、私人债务、费用分摊时检索（含能力边界）",
    sources: ["special-cases/money.md"],
  },
  {
    id: "scheduling",
    title: "排班 / 共用资源时段",
    scope: "共用设施（厨房、卫生间等）时段分配与重排时检索",
    sources: ["special-cases/scheduling.md"],
  },
];

// ── registry 索引 ──────────────────────────────────────────────────────────

/** 三份索引的集合。校验与报告都从这一个对象读。 */
export type CapabilityRegistryIndex = {
  capabilities: readonly CapabilityModule[];
  policies: readonly CrossCuttingPolicy[];
  playbooks: readonly DomainPlaybook[];
};

export const CAPABILITY_REGISTRY_INDEX: CapabilityRegistryIndex = {
  capabilities: CAPABILITY_REGISTRY,
  policies: CROSS_CUTTING_POLICIES,
  playbooks: DOMAIN_PLAYBOOKS,
};

/** 首批能力模块上限（超过就说明在给整个产品一次建模，该收窄）。 */
export const MAX_CAPABILITIES = 7;

// ── 用户意图契约 ───────────────────────────────────────────────────────────

/**
 * 明确限制的种类。**挂在具体意图项上**——限制只作用于它所属的那个意图，
 * 不跨意图连坐（例如「先给我看」只约束「发布」，不阻止已获准的「取数」）。
 */
export const INTENT_CONSTRAINT_KINDS = [
  "preview_before_publish",
  "hold_before_send",
  "conceal_source",
] as const;
export type IntentConstraintKind = (typeof INTENT_CONSTRAINT_KINDS)[number];

export const INTENT_CONSTRAINT_LABEL: Record<IntentConstraintKind, string> = {
  preview_before_publish: "先给我看（对外前要发信人点头）",
  hold_before_send: "暂不发送（本轮不对外）",
  conceal_source: "隐藏来源（不要暴露是我提的）",
};

/**
 * **明确要求「本轮别对外」的限制**——挂上它们却把该动作标为可执行，自相矛盾。
 *
 * ⚠️ `conceal_source` **不在此列**：隐藏来源是「怎么发」的约束（披露方式），
 * 不是「发不发」的授权，不能一刀切地当成禁止执行。它只在存在可反推风险时才升级为阻塞
 * （由 capability 的 stopConditions 与 cross-cutting policy 判断），不在意图层机械禁止。
 */
export const EXECUTION_BLOCKING_CONSTRAINTS: readonly IntentConstraintKind[] = [
  "preview_before_publish",
  "hold_before_send",
];

/** 一条明确限制 + 它的原话依据（依据必须是 `rawMessage` 的子串）。 */
export type IntentConstraint = {
  kind: IntentConstraintKind;
  evidence: string;
};

/**
 * **用户意图契约——核心业务字段恰好 6 个。**
 *
 * 一个 `IntentItem` 只表达**用户侧**的目标、动作、对象、授权、限制和完成标准；
 * **不复制 V4 的执行状态和依赖**（没有 status / readiness / dependsOn / 收据）。
 *
 * | 业务字段 | 含义 | 任务卡要求 |
 * |---|---|---|
 * | `desiredOutcome` | 用户想达到的结果（自然语言短句，不强迫穷举） | ✓ |
 * | `capabilityId` | 当前请求的动作（选中的 registry capability） | ✓ |
 * | `target` | 作用对象 | ✓ |
 * | `authorizationEvidence` | 授权依据的原话片段（`null`=本轮未授权该动作） | ✓ |
 * | `constraints` | 明确限制（各自带原话依据） | ✓ |
 * | `completionCriteria` | 用户认为怎样算完成 | ✓ |
 *
 * `id` 是**结构性字段**（供依赖/期望引用），不计入 6 个业务字段。
 */
export type IntentItem = {
  /** 稳定 id，信封内唯一（结构性字段，不算业务字段）。 */
  id: string;
  desiredOutcome: string;
  capabilityId: string;
  target: string;
  /** 授权依据的**原文片段**（必须逐字出现在 `rawMessage` 中）；`null`=本轮未授权该动作。 */
  authorizationEvidence: string | null;
  constraints: IntentConstraint[];
  completionCriteria: string;
};

/** 一条消息拆出的多个意图项。 */
export type IntentEnvelope = {
  intents: IntentItem[];
};

/** 6 个业务字段（用于机器断言「核心字段不超过 6 个」）。 */
export const INTENT_BUSINESS_FIELDS = [
  "desiredOutcome",
  "capabilityId",
  "target",
  "authorizationEvidence",
  "constraints",
  "completionCriteria",
] as const;

/** 校验器需要的确定性语境——全部来自样例，不让模型编。 */
export type IntentContext = {
  speaker: string;
  roster: string[];
  rawMessage: string;
};

/**
 * 开发者对**单个意图**的期望执行结论。
 *
 * ⚠️ 这是**开发者手写的映射判断**，不是模型输出、不是老板核准，也**不是 V4 的逐动作
 * 执行状态机**（V4 管 planned/waiting_reply/done/stopped 与依赖、收据）。这里只有一个
 * 由「能力成熟度 + 用户授权」推出的二元结论：这个动作当前能不能执行。
 * 它存在的唯一目的，是让「blocked capability 不得被标为可执行」变成可机械证伪的断言。
 */
export type IntentExpectation = {
  intentId: string;
  /** `true`=开发者认为这个动作当前可以执行；`false`=当前不得执行。 */
  executable: boolean;
  /** 一句话说明为什么（开发者口径，给人工复核看）。 */
  reason: string;
};

/** 一张开发者手写的「意图 → 能力」映射样例。 */
export type IntentCapabilitySample = {
  id: string;
  title: string;
  /** 这张样例想证明什么（开发者说明，不是老板口径）。 */
  source: string;
  context: IntentContext;
  envelope: IntentEnvelope;
  expectations: IntentExpectation[];
};

// ── 校验结果类型 ───────────────────────────────────────────────────────────

export type RegistryViolationCode =
  | "empty_registry"
  | "too_many_capabilities"
  | "empty_capability_id"
  | "duplicate_capability_id"
  | "empty_verifiable_outcome"
  | "unknown_tool"
  | "blocked_has_allowed_tools"
  | "blocked_has_success_receipts"
  | "missing_stop_conditions"
  | "missing_sources"
  | "unknown_playbook"
  | "policy_id_collides"
  | "playbook_id_collides"
  | "duplicate_policy_id"
  | "duplicate_playbook_id"
  | "empty_policy_rule"
  | "empty_playbook_scope";

export type RegistryViolation = {
  capabilityId?: string;
  code: RegistryViolationCode;
  message: string;
};

export type RegistryValidation = {
  ok: boolean;
  violations: RegistryViolation[];
};

export type IntentViolationCode =
  | "empty_intents"
  | "empty_intent_id"
  | "duplicate_intent_id"
  | "too_many_business_fields"
  | "empty_desired_outcome"
  | "empty_target"
  | "empty_completion_criteria"
  | "unknown_capability"
  | "evidence_not_in_message"
  | "empty_constraint_evidence"
  | "missing_expectation"
  | "duplicate_expectation"
  | "unknown_expectation_intent"
  | "blocked_capability_marked_executable"
  | "missing_authorization_but_executable"
  | "execution_constraint_conflict";

export type IntentViolation = {
  intentId?: string;
  code: IntentViolationCode;
  message: string;
};

export type IntentValidation = {
  ok: boolean;
  violations: IntentViolation[];
};

// ── 工具名核对 ─────────────────────────────────────────────────────────────

/**
 * 从生产 `turn.ts` 源码文本里抽出**当前实际声明**的工具名。
 *
 * 刻意不 import `turn.ts`（那样会带上整个生产模块、repo 和 AI SDK）；这里只做
 * 源码文本解析，用来核对 registry 里的 `allowedTools` 没有漂移。
 * 匹配形态是 `    toolName: tool({`（`const tools = {` 里的声明）。
 */
export function extractProductionToolNames(src: string): string[] {
  const re = /\n\s{4}([A-Za-z_$][\w$]*)\s*:\s*tool\s*\(\s*\{/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    names.add(m[1] as string);
  }
  return [...names];
}

// ── registry 校验 ──────────────────────────────────────────────────────────

/**
 * **纯函数 registry 一致性校验。**
 *
 * 不变量：
 * 1. 至少一个能力模块，且**不超过 7 个**（超过说明在给整个产品一次建模，该收窄）；
 * 2. capability id 非空且唯一；policy / playbook id 也各自唯一；
 * 3. capability id **不得与 policy / playbook id 相同**——三者是不同种类，
 *    不能互相冒充；
 * 4. 每个模块的 `allowedTools` 必须是**当前生产工具定义里真实存在的名字**；
 * 5. `blocked` 模块**不得有允许执行工具、不得有成功执行收据**；
 * 6. 每个模块要有停止条件与来源；引用到的 playbook 必须存在。
 */
export function validateCapabilityRegistry(
  index: CapabilityRegistryIndex,
  options: { productionToolNames: readonly string[] }
): RegistryValidation {
  const violations: RegistryViolation[] = [];
  const productionTools = new Set(options.productionToolNames);

  if (index.capabilities.length === 0) {
    violations.push({
      code: "empty_registry",
      message: "能力模块 registry 不能为空",
    });
  }
  if (index.capabilities.length > MAX_CAPABILITIES) {
    violations.push({
      code: "too_many_capabilities",
      message: `首批能力模块 ${index.capabilities.length} 个，超过上限 ${MAX_CAPABILITIES}：先收窄，不要给整个产品一次建模`,
    });
  }

  const capabilityIds = new Set<string>();
  for (const module of index.capabilities) {
    if (!module.id.trim()) {
      violations.push({ code: "empty_capability_id", message: "能力模块 id 不能为空" });
    } else if (capabilityIds.has(module.id)) {
      violations.push({
        capabilityId: module.id,
        code: "duplicate_capability_id",
        message: `能力模块 id「${module.id}」重复：registry 内 id 必须唯一`,
      });
    } else {
      capabilityIds.add(module.id);
    }
    if (!module.verifiableOutcome.trim()) {
      violations.push({
        capabilityId: module.id,
        code: "empty_verifiable_outcome",
        message: `能力模块「${module.id}」必须写清可验收结果`,
      });
    }
    for (const tool of module.allowedTools) {
      if (!productionTools.has(tool)) {
        violations.push({
          capabilityId: module.id,
          code: "unknown_tool",
          message: `能力模块「${module.id}」列了不存在的工具「${tool}」：allowedTools 必须是当前生产工具定义里真实存在的名字`,
        });
      }
    }
    if (module.maturity === "blocked") {
      if (module.allowedTools.length > 0) {
        violations.push({
          capabilityId: module.id,
          code: "blocked_has_allowed_tools",
          message: `blocked 模块「${module.id}」不得列出允许执行工具（当前列出：${module.allowedTools.join("、")}）`,
        });
      }
      if (module.successReceipts.length > 0) {
        violations.push({
          capabilityId: module.id,
          code: "blocked_has_success_receipts",
          message: `blocked 模块「${module.id}」不得有成功执行收据`,
        });
      }
    }
    if (module.stopConditions.length === 0) {
      violations.push({
        capabilityId: module.id,
        code: "missing_stop_conditions",
        message: `能力模块「${module.id}」必须至少写一条主要停止条件`,
      });
    }
    if (module.sources.length === 0) {
      violations.push({
        capabilityId: module.id,
        code: "missing_sources",
        message: `能力模块「${module.id}」必须至少给一条 Doctrine/来源引用`,
      });
    }
  }

  const playbookIds = new Set<string>();
  for (const playbook of index.playbooks) {
    if (playbookIds.has(playbook.id)) {
      violations.push({
        code: "duplicate_playbook_id",
        message: `playbook id「${playbook.id}」重复`,
      });
    }
    playbookIds.add(playbook.id);
    if (!playbook.scope.trim()) {
      violations.push({
        code: "empty_playbook_scope",
        message: `playbook「${playbook.id}」必须写清什么话题下才检索`,
      });
    }
  }

  const policyIds = new Set<string>();
  for (const policy of index.policies) {
    if (policyIds.has(policy.id)) {
      violations.push({
        code: "duplicate_policy_id",
        message: `cross-cutting policy id「${policy.id}」重复`,
      });
    }
    policyIds.add(policy.id);
    if (!policy.rule.trim()) {
      violations.push({
        code: "empty_policy_rule",
        message: `cross-cutting policy「${policy.id}」必须写清门禁要求`,
      });
    }
  }

  // 三份索引不得互相冒充：id 不能跨类重合。
  for (const id of capabilityIds) {
    if (policyIds.has(id)) {
      violations.push({
        capabilityId: id,
        code: "policy_id_collides",
        message: `「${id}」同时出现在 capability 与 cross-cutting policy 里：门禁不能冒充能力模块`,
      });
    }
    if (playbookIds.has(id)) {
      violations.push({
        capabilityId: id,
        code: "playbook_id_collides",
        message: `「${id}」同时出现在 capability 与 playbook 里：领域 playbook 不能冒充能力模块`,
      });
    }
  }

  // 模块引用的 playbook 必须存在。
  for (const module of index.capabilities) {
    for (const playbookId of module.playbooks) {
      if (!playbookIds.has(playbookId)) {
        violations.push({
          capabilityId: module.id,
          code: "unknown_playbook",
          message: `能力模块「${module.id}」引用了不存在的 playbook「${playbookId}」`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

// ── 意图 / 样例校验 ────────────────────────────────────────────────────────

/**
 * **纯函数意图校验**（不含期望结论，只查契约本身）。
 *
 * 不变量：
 * 1. 至少一个意图项；id 非空且唯一；`desiredOutcome`/`target`/`completionCriteria` 非空；
 * 2. 每项选中的 `capabilityId` 必须存在于 registry；
 * 3. `authorizationEvidence` 非 null 时必须是 `rawMessage` 的**逐字子串**（来源校验，
 *    不是用关键词猜意图）；每条 constraint 的 `evidence` 同样必须是原文子串。
 */
export function validateIntentEnvelope(
  envelope: IntentEnvelope,
  index: CapabilityRegistryIndex,
  context: IntentContext
): IntentValidation {
  const violations: IntentViolation[] = [];
  const known = new Set(index.capabilities.map((c) => c.id));

  if (envelope.intents.length === 0) {
    violations.push({
      code: "empty_intents",
      message: "意图信封至少要有一个意图项（不能只有一句整体判断）",
    });
  }

  const ids = new Set<string>();
  for (const intent of envelope.intents) {
    if (!intent.id.trim()) {
      violations.push({ code: "empty_intent_id", message: "intent id 不能为空" });
    } else if (ids.has(intent.id)) {
      violations.push({
        intentId: intent.id,
        code: "duplicate_intent_id",
        message: `intent id「${intent.id}」重复：信封内 id 必须唯一`,
      });
    } else {
      ids.add(intent.id);
    }

    if (!intent.desiredOutcome.trim()) {
      violations.push({
        intentId: intent.id,
        code: "empty_desired_outcome",
        message: `意图「${intent.id}」必须写清想达到的结果`,
      });
    }
    if (!intent.target.trim()) {
      violations.push({
        intentId: intent.id,
        code: "empty_target",
        message: `意图「${intent.id}」必须写清作用对象`,
      });
    }
    if (!intent.completionCriteria.trim()) {
      violations.push({
        intentId: intent.id,
        code: "empty_completion_criteria",
        message: `意图「${intent.id}」必须写清用户认为怎样算完成`,
      });
    }
    if (!known.has(intent.capabilityId)) {
      violations.push({
        intentId: intent.id,
        code: "unknown_capability",
        message: `意图「${intent.id}」选中的能力「${intent.capabilityId}」不在 registry 里`,
      });
    }

    // 来源校验：授权原话必须能在本轮原文里逐字找到。
    if (intent.authorizationEvidence !== null) {
      const evidence = intent.authorizationEvidence.trim();
      if (!evidence || !context.rawMessage.includes(evidence)) {
        violations.push({
          intentId: intent.id,
          code: "evidence_not_in_message",
          message: `意图「${intent.id}」的授权依据「${intent.authorizationEvidence}」不能在 rawMessage 里逐字找到：原话证据必须是原文子串，不能靠关键词猜`,
        });
      }
    }
    for (const constraint of intent.constraints) {
      const evidence = constraint.evidence.trim();
      if (!evidence) {
        violations.push({
          intentId: intent.id,
          code: "empty_constraint_evidence",
          message: `意图「${intent.id}」的限制「${constraint.kind}」必须给出原话依据`,
        });
      } else if (!context.rawMessage.includes(evidence)) {
        violations.push({
          intentId: intent.id,
          code: "evidence_not_in_message",
          message: `意图「${intent.id}」的限制依据「${constraint.evidence}」不能在 rawMessage 里逐字找到`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * **纯函数样例校验** = 契约校验 + 开发者期望结论的一致性。
 *
 * 期望结论额外检查（把「不该执行的动作不得被标为可执行」变成可机械证伪的断言）：
 * 1. 每个意图恰有一条期望；期望不得指向不存在的意图、不得重复；
 * 2. **`blocked` 能力对应的意图不得被标为 `executable: true`**。
 *    （`partial` 允许 `executable: true`——它能做，只是不得被说成稳定可用，
 *     那条由报告措辞 `MATURITY_STABILITY` / `MATURITY_LABEL` 保证。）
 * 3. **`authorizationEvidence === null` 却 `executable: true`** 必须被打回
 *    （没有授权原话，本轮就没有可执行依据）；
 * 4. **带 `preview_before_publish` / `hold_before_send` 却 `executable: true`**
 *    必须被打回（限制明确要求本轮别对外，与「可执行」自相矛盾）。
 *    `conceal_source` 不在其列——它约束披露方式，不自动禁止执行。
 */
export function validateIntentSample(
  sample: IntentCapabilitySample,
  index: CapabilityRegistryIndex
): IntentValidation {
  const base = validateIntentEnvelope(sample.envelope, index, sample.context);
  const violations: IntentViolation[] = [...base.violations];

  const capabilityMaturity = new Map(
    index.capabilities.map((c) => [c.id, c.maturity] as const)
  );
  const intentIds = new Set(sample.envelope.intents.map((i) => i.id));
  const seen = new Set<string>();

  for (const expectation of sample.expectations) {
    if (!intentIds.has(expectation.intentId)) {
      violations.push({
        intentId: expectation.intentId,
        code: "unknown_expectation_intent",
        message: `期望结论指向不存在的意图「${expectation.intentId}」`,
      });
      continue;
    }
    if (seen.has(expectation.intentId)) {
      violations.push({
        intentId: expectation.intentId,
        code: "duplicate_expectation",
        message: `意图「${expectation.intentId}」有重复的期望结论`,
      });
      continue;
    }
    seen.add(expectation.intentId);
  }

  for (const intent of sample.envelope.intents) {
    if (!seen.has(intent.id)) {
      violations.push({
        intentId: intent.id,
        code: "missing_expectation",
        message: `意图「${intent.id}」缺少开发者期望结论（executable / reason）`,
      });
    }
    const maturity = capabilityMaturity.get(intent.capabilityId);
    const expectation = sample.expectations.find((e) => e.intentId === intent.id);
    if (expectation?.executable === true && maturity === "blocked") {
      violations.push({
        intentId: intent.id,
        code: "blocked_capability_marked_executable",
        message: `意图「${intent.id}」选中的能力「${intent.capabilityId}」成熟度为 blocked，却被标为可执行：blocked capability 不得被标为可执行`,
      });
    }
    // `authorizationEvidence === null` 说明本轮没有授权原话，不能同时标为可执行。
    if (expectation?.executable === true && intent.authorizationEvidence === null) {
      violations.push({
        intentId: intent.id,
        code: "missing_authorization_but_executable",
        message: `意图「${intent.id}」没有授权原话（authorizationEvidence 为 null），却被标为可执行：没有可追溯的授权依据就不算可执行`,
      });
    }
    // 带「本轮别对外」的限制却标为可执行，自相矛盾（conceal_source 不在此列）。
    if (expectation?.executable === true) {
      const blocking = intent.constraints.filter((c) =>
        EXECUTION_BLOCKING_CONSTRAINTS.includes(c.kind)
      );
      if (blocking.length > 0) {
        violations.push({
          intentId: intent.id,
          code: "execution_constraint_conflict",
          message: `意图「${intent.id}」带有「${blocking
            .map((c) => c.kind)
            .join("、")}」限制却被标为可执行：要求本轮别对外的限制与可执行结论冲突`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
