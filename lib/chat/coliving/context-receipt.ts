/**
 * **上下文回执的形状与工具名单**（纯模块：零 import、不碰 server-only / 数据库 /
 * 模型，运行时、评测脚本与报告渲染层都能安全复用）。
 *
 * 这个模块只定义"回执长什么样"、以及"怎么把一次工具返回折成一个数字"，
 * 不负责产生它，也不负责渲染它：
 * - 运行时段落（sections）由 `context.ts` 的 `buildContext` 逐节产出；
 * - 按需检索的**调用次数与返回字符数**由 `turn.ts` 在主生成收尾时补上
 *   （那时才知道模型调了什么、拿回了什么）；
 * - 渲染与归一化在 `ledger-report.ts`。
 *
 * ⚠️ 隐私纪律：回执**永远只有名字和数字**，没有承载正文的字段。这份类型定义是
 * 硬边界——它没有 body/text 之类的字段，所以住户原话、名册、规则文本、电话号
 * 在结构上就进不了回执；离线回归直接拿它和渲染层验证（见
 * `scripts/coliving-quality-inspect.ts`）。
 */

/**
 * 上下文分节的**收据**：只记分节 id 与字符数，**绝不记分节正文**。
 *
 * 与 `turn.ts` 的 `PromptComposition` 同一条纪律：观测只回答"这一轮运行时
 * 上下文由哪些节构成、各占多少"，不回答"里面写了什么"。
 */
export type ContextReceiptSection = {
  /** 分节 id，由代码写死、与文案无关（改措辞不会改 id）。 */
  id: string;
  /**
   * 这一节贡献的字符数。按最终运行时正文的换行口径算，只含本节自己的行
   * （含节尾空行），**不含**与下一节之间的那个连接换行。
   */
  chars: number;
};

/** `buildContext` 能确定的那部分回执：本轮上下文由哪些稳定分节拼成。 */
export type ContextSectionsReceipt = {
  /** 这一轮真正出现的分节，按出现顺序；条件分节没出现就不在列表里。 */
  sections: ContextReceiptSection[];
};

/**
 * **一类按需检索工具在某一轮的调用观测**：名字、调用次数、返回的字符串字符数。
 *
 * 这三个字段就是这份观测的全部——工具入参（查询原文）、返回正文、住户姓名、
 * 号码、id、哈希一概不进这里：它们既没有承载字段，也不参与下面任何一步计算
 * （字符数是**数出来就丢**的：不拼接、不序列化、不保留返回内容本身）。
 */
export type ContextRetrievalObservation = {
  /** 工具名，只可能是 `CONTEXT_RETRIEVAL_TOOL_NAMES` 里写死的名字。 */
  name: string;
  /** 本轮调用次数（与 `toolsUsed` 的口径一致：调一次算一次）。 */
  calls: number;
  /**
   * 本轮这些调用**返回内容里的字符串字符数合计**。
   * `null` = 至少有一次调用读不出字符数（没拿到返回、返回内容读不动、
   * 或超出下面的探测边界）→ 记**未知**，不报一个偏小的下界冒充总数。
   */
  returnedChars: number | null;
};

/**
 * 一轮的**完整上下文回执**（随 `TurnOutcome` 落到评测报告）：
 * 分节清单 + 本轮**真的跑过**的按需检索观测。
 *
 * 检索那半由 `turn.ts` 在主生成收尾时补上——`buildContext` 那一刻还不知道
 * 模型会调什么工具。两者都只是名字/数字，绝无正文。
 */
export type ContextReceipt = ContextSectionsReceipt & {
  /** 本轮跑过的按需检索工具观测（按下面写死的名单顺序，没跑就是空数组）。 */
  retrievalObservations: ContextRetrievalObservation[];
};

/**
 * **按需检索类工具**：只读、拉取额外上下文——不写字、不出站、不改状态。
 * 模型要靠自己判断"这轮要不要额外查"，所以它们默认不摆出来（见 `turn.ts`
 * 里 activeTools 的查询/观察组），命中结构或话题信号才给。
 *
 * 回执只报这些工具里**本轮真的跑过**的名字：名单写死在代码里，模型无法通过
 * 任何输入让回执带上别的字符串——报告渲染层也照这份名单过筛（`isContextRetrievalToolName`），
 * 所以连"旧报告 JSON 被人塞了别的字符串"都不会显示出来。
 */
export const CONTEXT_RETRIEVAL_TOOL_NAMES = [
  "checkEnvironment",
  "findSimilarCases",
  "lookupHistory",
  "recall",
] as const;

/** 某个名字是不是代码写死的按需检索工具。报告渲染层用它过筛。 */
export function isContextRetrievalToolName(name: string): boolean {
  return (CONTEXT_RETRIEVAL_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * 一次工具调用的**观测输入**：名字 + **已经折好的**字符数。
 *
 * 注意这里**没有**承载返回内容的字段：调用方必须在拿到返回的那一刻就调
 * `returnedCharsOf` 把它折成数字，随后**只把数字传进来**。这样连"读完还留着
 * 引用"的窗口都不存在——装配用的数组里从头到尾只有名字与数字，即使它被误
 * 序列化也带不出任何正文。
 */
export type RetrievalToolCall = {
  name: string;
  /** 这次调用返回内容的字符串字符数；`null` = 没拿到返回 / 数不出来（未知）。 */
  chars: number | null;
};

/**
 * 结构探测的边界：超过就整条记**未知**，不给一个看起来精确的偏小下界。
 * 边界存在的理由是"数不出来就别硬数"——真实工具返回是几个到几十个字段的小对象，
 * 离边界很远；能撞上边界的只有异常大或自引用的返回，那种情况下报"未知"比报
 * 一个截断后的数字更诚实。
 */
const FOOTPRINT_MAX_DEPTH = 6;
const FOOTPRINT_MAX_NODES = 1000;

/**
 * JSON 里 `Date` 固定序列化成 24 个字符（`"2026-09-20T12:34:56.789Z"`）。
 * 直接给这个常数，**不调 `toISOString()`**——那样就构造出一个字符串了。
 */
const ISO_DATE_CHARS = 24;

/**
 * 数一份返回内容里的**字符串字符数**（含对象的键名），不构造、不保留任何字符串。
 *
 * 口径说明（报告里也照这个说法写）：
 * - 字符串 → 它自己的长度；对象/数组 → 递归累加**键名与字符串值**的字符数；
 *   数字、布尔、null 这类标量不计（它们不是字符串内容，也不构成检索负担）；
 * - `Date` 按 JSON 序列化的 24 个字符计；
 * - **读不出来就是 `null`（未知），不是 0**：取值/枚举抛错（getter、Proxy）、
 *   遇到数不出来的类型（函数、symbol、bigint）、超出深度或节点预算，一律 `null`。
 *
 * 这是**近似**口径（不是 JSON 字节数：不含标点与转义），用途是横向比较每轮
 * "模型额外拉回来多少东西"，不是精确计费；所以它不参与任何决策，只进评测报告。
 */
function countStringChars(
  value: unknown,
  depth: number,
  budget: { nodes: number }
): number | null {
  if (budget.nodes <= 0 || depth > FOOTPRINT_MAX_DEPTH) return null;
  budget.nodes -= 1;
  if (typeof value === "string") return value.length;
  if (
    value === null ||
    typeof value === "undefined" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return 0;
  }
  if (typeof value !== "object") return null; // 函数 / symbol / bigint：数不出来
  try {
    if (value instanceof Date) return ISO_DATE_CHARS;
    if (Array.isArray(value)) {
      let total = 0;
      for (const item of value) {
        const chars = countStringChars(item, depth + 1, budget);
        if (chars === null) return null;
        total += chars;
      }
      return total;
    }
    const record = value as Record<string, unknown>;
    let total = 0;
    for (const key of Object.keys(record)) {
      total += key.length;
      const chars = countStringChars(record[key], depth + 1, budget);
      if (chars === null) return null;
      total += chars;
    }
    return total;
  } catch {
    // 任何一步读不动（抛错的 getter、Proxy、宿主对象）都只是"这一条数不出来"，
    // **绝不向上抛**：观测坏了不能连累这一轮对话。
    return null;
  }
}

/**
 * 一份工具返回的**字符串字符数**；读不出来是 `null`（未知），**不是 0**。
 *
 * 纯函数、零副作用，也不依赖任何 SDK 类型：调用方把 `output` 原样传进来即可。
 * 它不会保存、不会序列化、不会把返回内容写进任何地方——只回一个数字或 null。
 */
export function returnedCharsOf(output: unknown): number | null {
  return countStringChars(output, 0, { nodes: FOOTPRINT_MAX_NODES });
}

/**
 * 把本轮**每一次**工具调用折成按需检索观测：只留名单里的工具，
 * 按名单顺序返回（顺序稳定，报告前后可比）。
 *
 * - 次数按"调用"算：调用方应当**逐次调用**传进来（哪怕这次没拿到返回），
 *   这样次数与 `toolsUsed` 一致，不会因为一次工具抛错就少算一次；
 * - 字符数只要有**一次**读不出来就整条记 `null`：部分已知的和不是总数，
 *   报出去会被读成"这轮只拉回这么点"，比"未知"更误导；
 * - 输入只有名字与数字（见 `RetrievalToolCall`）：返回正文从来没被传进来过。
 */
export function retrievalObservationsFrom(
  calls: readonly RetrievalToolCall[]
): ContextRetrievalObservation[] {
  const byName = new Map<
    string,
    { calls: number; chars: number; unmeasurable: boolean }
  >();
  for (const call of calls) {
    if (!isContextRetrievalToolName(call.name)) continue;
    const entry =
      byName.get(call.name) ?? { calls: 0, chars: 0, unmeasurable: false };
    entry.calls += 1;
    if (call.chars === null || call.chars === undefined) {
      entry.unmeasurable = true;
    } else {
      entry.chars += call.chars;
    }
    byName.set(call.name, entry);
  }
  return CONTEXT_RETRIEVAL_TOOL_NAMES.filter((name) => byName.has(name)).map(
    (name) => {
      const entry = byName.get(name);
      // filter 已经保证存在；这里显式判一次只是为了不给类型留 undefined。
      if (!entry) return { name, calls: 0, returnedChars: null };
      return {
        name,
        calls: entry.calls,
        returnedChars: entry.unmeasurable ? null : entry.chars,
      };
    }
  );
}
