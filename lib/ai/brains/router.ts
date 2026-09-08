import type { Brain, RoutingDecision } from "./types";

const DEFAULT_MAX_SITUATIONAL = 2;

/**
 * 按关键词规则 + 结构信号决定这一轮加载哪些情境模块。
 *
 * 为什么不用向量检索：情境模块只有个位数，类别边界清晰，
 * 规则命中率高于 embedding 相似度，而且可解释、可测试、出错时知道原因。
 * 等模块涨到几十份、或需要检索各州法规这类长尾，再引入检索。
 *
 * 匹配语义：一条规则命中 = 文本命中 且 信号命中。
 * - 文本命中：`rule.match` 为空 或 任一正则命中 `text`。
 * - 信号命中：`rule.when` 为空 或 任一条件满足（`equals` 给定时比较
 *   `signals[key] === equals`，否则按 truthy 判断）。
 * 不给 `signals` 时，`when` 非空的规则不命中（等价于 `signals = {}`）。
 */
export function route(
  brain: Brain,
  text: string,
  signals?: Record<string, unknown>
): RoutingDecision {
  const trace: RoutingDecision["trace"] = [];
  const forced = new Set<string>();
  const matched: string[] = [];
  let exclusive: string[] | null = null;

  for (const rule of brain.routes) {
    const regexes = rule.match ?? [];
    let hit: RegExp | undefined;
    for (const re of regexes) {
      if (re.test(text)) {
        hit = re;
        break;
      }
    }
    const textHit = regexes.length === 0 || hit !== undefined;

    const signalHit = rule.when?.length
      ? rule.when.some((cond) => {
          const value = signals?.[cond.key];
          return cond.equals !== undefined
            ? value === cond.equals
            : Boolean(value);
        })
      : true;

    if (!textHit || !signalHit) {
      continue;
    }

    const reason =
      rule.reason ?? (hit ? `命中 ${hit.source}` : "命中结构信号规则");

    if (rule.force) {
      for (const id of rule.modules) {
        if (!forced.has(id)) {
          forced.add(id);
          trace.push({ moduleId: id, reason, forced: true });
        }
      }
      continue;
    }

    // 第一条命中的 exclusive 规则锁定非 force 部分
    if (rule.exclusive && exclusive === null) {
      exclusive = rule.modules;
      trace.push(
        ...rule.modules.map((id) => ({
          moduleId: id,
          reason: `${reason}（独占，短路其余规则）`,
          forced: false,
        }))
      );
      continue;
    }

    if (exclusive !== null) {
      continue;
    }

    for (const id of rule.modules) {
      if (!matched.includes(id)) {
        matched.push(id);
        trace.push({ moduleId: id, reason, forced: false });
      }
    }
  }

  const cap = brain.maxSituational ?? DEFAULT_MAX_SITUATIONAL;
  const pool = exclusive ?? matched;
  // force 的不占额度——安全类漏加载的代价远高于多占的上下文
  const kept = pool.filter((id) => !forced.has(id)).slice(0, cap);

  let moduleIds = [...forced, ...kept];

  if (moduleIds.length === 0) {
    moduleIds = brain.fallback;
    for (const id of moduleIds) {
      trace.push({ moduleId: id, reason: "无规则命中，走兜底", forced: false });
    }
  }

  return { moduleIds, trace };
}
