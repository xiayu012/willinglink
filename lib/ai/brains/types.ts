/**
 * 「大脑」模块的类型定义。
 *
 * 一个大脑 = 一份常驻准则（每轮必带） + 若干情境模块（按需加载） + 一组路由规则。
 * 设计意图见 lib/ai/brains/README.md。
 */

export type DoctrineModuleId = string;

/**
 * 分层。**声明顺序即默认优先级**（identity 最高、rubric 最低）。
 * 模块自己的 `layer` 字段决定它属于哪一层；同一层内仍按数组声明顺序。
 */
export type DoctrineLayer =
  | "identity"
  | "invariant"
  | "domain"
  | "communication"
  | "memory"
  | "tool"
  | "special-case"
  | "rubric";

export type DoctrineModule = {
  id: DoctrineModuleId;
  /** 人类可读的名字，出现在日志和调试输出里 */
  title: string;
  /** 相对该大脑 doctrine/ 目录的文件名 */
  file: string;
  /** 所属分层，见 DoctrineLayer 的默认优先级 */
  layer: DoctrineLayer;
  /** 人类可读的一句话说明，用于 brain:inspect 展示 */
  purpose?: string;
};

export type SignalCondition = {
  key: string;
  /** 期望相等值；省略时按 truthy 判断 */
  equals?: boolean | string;
};

export type RouteRule = {
  /**
   * 命中任一正则即视为「文本命中」；为空时这条规则只凭结构信号（when）路由。
   */
  match?: RegExp[];
  modules: DoctrineModuleId[];
  /**
   * 结构信号条件。为空时视为恒信号命中；给出时任一条件满足即视为信号命中。
   * 结构信号比文本关键词可靠（"他" 不一定提名字，名册匹配是确凿的人际信号）。
   */
  when?: SignalCondition[];
  /**
   * force = 无条件加载，不受 maxSituational 上限约束。
   * 只用于安全类与法律风险类——这些内容漏加载的代价远高于多占的上下文。
   */
  force?: boolean;
  /**
   * exclusive = 命中即只加载本规则的模块，忽略其余非 force 规则。
   * 用于简单事实询问（"垃圾周几倒"），避免为一句话查询拉进整份调解准则。
   * force 规则不受影响——安全永远优先。
   */
  exclusive?: boolean;
  /** 便于调试时说明为什么命中 */
  reason?: string;
};

export type Brain = {
  id: string;
  title: string;
  description: string;
  /** doctrine 文件所在目录的绝对路径 */
  doctrineDir: string;
  /**
   * 每轮必带。**数组顺序即优先级**——排在前面的是目标与仲裁条款，
   * 后面的是手法。两者冲突时以前者为准（这句话本身写在准则正文里）。
   *
   * 拆开的原因见 AGENT_LOG「按周轮换」事故：目标与手法混在一份文件里，
   * 模型无从判断哪条压哪条，会挑更具体的那条执行。
   */
  always: DoctrineModule[];
  /** 按情境加载 */
  situational: DoctrineModule[];
  /** 路由规则，按顺序求值 */
  routes: RouteRule[];
  /** 没有任何规则命中时加载的模块 */
  fallback: DoctrineModuleId[];
  /**
   * 非 force 的情境模块加载上限，控制上下文体量。
   * 默认 2。force 的不计入。
   */
  maxSituational?: number;
};

export type RoutingDecision = {
  moduleIds: DoctrineModuleId[];
  /** 每个模块为什么被加载，便于排查路由错误 */
  trace: Array<{ moduleId: DoctrineModuleId; reason: string; forced: boolean }>;
};

export type AssembledPrompt = {
  /** doctrine + runtime 拼在一起，给不需要分段的调用方（如 brain:inspect） */
  system: string;
  /**
   * 只有准则的那一段。**每轮之间逐字相同**——调用方应当把 prompt cache 的
   * 断点卡在这一段之后，否则运行时状态一变，整段缓存全部落空。
   */
  doctrine: string;
  /** 本轮运行时状态。每轮都在变，不进缓存。 */
  runtime: string;
  brainId: string;
  loadedModuleIds: DoctrineModuleId[];
  routing: RoutingDecision;
  /** 粗略字符数，便于监控上下文体量 */
  chars: number;
};
