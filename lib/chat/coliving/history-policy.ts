/**
 * **对话历史的有界化政策**——纯函数、零 import、零模型调用。
 *
 * ## 为什么要有它
 *
 * 主生成的消息数组是 `[...history, 这一句原话]`，而 `history` 以前是
 * **仓库给多少就塞多少**（`repo.getRecentTurns` 只按**条数**取，没有任何**体量**上限）。
 * 这条数组不是发一次就完了：带工具的一轮里**每调一次工具就把整条消息数组重发一遍**
 * （见 `turn.ts` 的提示词缓存说明），所以历史那一段的重量会被步数放大。评测台账里
 * 一轮主生成的输入是三万到五万多 token，其中历史既没有上限、也不在任何报告里可见。
 *
 * ## 它做什么、不做什么
 *
 * **做**：按**最旧先丢**的顺序，把历史收进一个明确的预算（条数 + 字符数）。
 * 最新的一两条一定留下——"他上一句说了什么"是连续性的锚，丢了它模型就会把
 * 已经问过、已经答过的事再问一遍（这个项目反复踩过的坑）。
 *
 * **不做**（都是有意为之，改动前先想清楚）：
 * - **不碰结构化运行时事实**。未结的事、现行规则、在等谁回话、最近跟谁说过什么，
 *   统统由 `buildContext` 拼进运行时状态，**不经过这个函数的入参**，
 *   因此结构上就不可能被这条政策删掉。这条函数只吃**对话文本**。
 * - **不调模型**：整份模块零 import，"压缩历史"这种要模型的活不在这里做
 *   （那会新增一次调用、还要把住户原话再送一次给模型）。
 * - **不改措辞、不做摘要、不重写任何一条**：留下的条目逐字原样。
 * - **不按主题筛选**：这里没有关键词表。判断哪条相关是模型在提示词里的事，
 *   代码只负责"别让它背一屋子陈年对话"。
 * - **不做角色规整**：丢只从最旧那头丢，不会把中间某条抽走或调换顺序；
 *   因此留下来的一定还是原来的先后。
 *
 * ## 观测
 *
 * 返回值里同时带上"考虑了多少 / 留下多少 / 丢掉多少 / 各多少字符"，**只记数字**，
 * 交给 `context-receipt.ts` 的 `ContextHistoryObservation` 进评测报告——
 * 这条政策本身也必须是可观测的，否则没人能判断它到底省了多少、有没有误伤。
 */

/** 喂给主生成的一条历史消息。与 `repo.getRecentTurns` 的返回同形。 */
export type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

/** 历史预算：条数 + 正文总字符数。两个都是上限，不是目标值。 */
export type HistoryBudget = {
  /** 最多保留几条（含必然保留的最新那条）。 */
  maxTurns: number;
  /** 保留部分的正文总字符数上限（按 `content.length` 累加，不折叠空白）。 */
  maxChars: number;
};

/**
 * 生产预算。
 *
 * `maxTurns` 取 8，与 `repo.getRecentTurns` 的默认条数**逐字一致**——这条政策
 * 不是来改"看几条"的，是来给"总共多重"补一个以前根本不存在的上限。
 *
 * `maxChars` 取 2000：一条短信正文量级在几十到两三百字符，八条正常往来远在
 * 这个数以下（所以真实语料的行为**不变**——这是刻意的，改行为不该顺手做）；
 * 会撞上它的是两种病态：住户粘贴一大段、或模型自己写出长回复，那时旧的那头
 * 被丢掉，而不是整条上下文被撑大。
 */
export const HISTORY_BUDGET: HistoryBudget = { maxTurns: 8, maxChars: 2000 };

export type HistoryPlan = {
  /** 真正要放进 `messages` 的那些（**旧→新**，与输入同序）。 */
  kept: HistoryTurn[];
  /** 仓库交过来的条数（政策之前的原样）。 */
  consideredTurns: number;
  keptTurns: number;
  droppedTurns: number;
  keptChars: number;
  droppedChars: number;
};

/**
 * 把历史收进预算。**从新往旧**收，收到预算用完为止；返回值按旧→新给出。
 *
 * 三条不变量（有确定性反例测试盯着，见 `history-policy.test.ts`）：
 * 1. **最新的一条一定留下**。哪怕它自己就超了字符预算——它是连续性的锚，
 *    丢掉它会让模型把上一轮已经说过的事当成没说过。预算约束的是**更旧**的那些；
 * 2. **只从最旧那头整条地丢**，不拆条、不截断单条正文、不重排；
 * 3. **留下的必须是原序列的一段连续后缀**：第一条收不进来的更旧条目就是分界线，
 *    从它往旧的一条都不留（不许因为"这条更短、装得下"再补回来——那会在中间
 *    留一个窟窿，"他上一句"与"更早的上下文"之间凭空断掉，比整体丢掉更难读懂）。
 *
 * `content.length` 就是字符数口径（与回执 `ContextHistoryObservation` 同源），
 * 不做归一化——这里量的是"这条消息有多长"，不是"有几个词"。
 */
export function planHistory(
  history: readonly HistoryTurn[],
  budget: HistoryBudget = HISTORY_BUDGET
): HistoryPlan {
  const kept: HistoryTurn[] = [];
  let keptChars = 0;
  let droppedChars = 0;
  // **拒绝是不可逆的**：一旦有一条更旧的收不进来，这条分界线就定了，
  // 再往旧的方向一条都不许补回来（见下面注释里的反例）。
  let exhausted = false;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (!turn) continue;
    const turnChars = turn.content.length;
    // 最新那条（kept 还是空）无条件保留；其余按预算收。
    const isNewest = kept.length === 0;
    const withinBudget =
      !exhausted &&
      kept.length < budget.maxTurns &&
      keptChars + turnChars <= budget.maxChars;
    if (isNewest || withinBudget) {
      kept.push(turn);
      keptChars += turnChars;
    } else {
      // 从最旧那头开始，剩下的全部丢弃——预算用尽之后不再往里挑，
      // 否则历史里会出现"缺了中间一段"的窟窿，比整体丢掉更难看懂。
      //
      // 这里**必须**把拒绝钉死：只丢这一条、下一轮又拿"这条更短、装得下"
      // 的旧条目补回来，留下的就不是连续后缀了。不均匀长度下这是真的会发生
      // （预算 100：最新 50 字 → 更旧那条 200 字装不下 → 再旧那条 5 字又装得下，
      // 于是 [5 字, 200 字, 50 字] 会留下第 1、3 条，中间凭空缺一段）。
      // 确定性反例见 `history-policy.test.ts` 的「不均匀长度」那条。
      exhausted = true;
      droppedChars += turnChars;
    }
  }
  kept.reverse();
  const consideredTurns = history.length;
  return {
    kept,
    consideredTurns,
    keptTurns: kept.length,
    droppedTurns: consideredTurns - kept.length,
    keptChars,
    droppedChars,
  };
}
