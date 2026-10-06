/**
 * **这一户已经有人报过人了——不再向住户收名册。**
 *
 * 老板 2026-10-06：一个人报过之后，另一位成员开口时**又被问了一遍**「还住着谁、
 * 姓名和手机号」。原话：**「只需要一个人说过就彻底结束。不再问任何了。宁愿漏人
 * 也要少打扰用户。」**
 *
 * 判据是**这一户历史上记过的人**（`historicalCount`）——不数「确认住户」，也不数
 * **当前还在册的**。复审给的两条反例各自钉掉一半：①一位**不住这儿的宿管**报了唯一
 * 一位住户，按住户数算还是 1，可"已经有人报过"这件事已经发生；②这一户**曾经**记过
 * 多人、后来只剩一个人在册，按当前人数算会**重新开口**收名册——而老板要的是
 * 「彻底结束」。按人去重、含已离开与不住这儿的，只增不减，所以停下来之后不会自己松开。
 *
 * **停止收集 ≠ 名册齐全**：`complete` 仍按 `declared_size` 算，两件不同的事实——
 * 停了之后名册照旧可能漏人（老板接受漏人，不接受打扰）。**也只停收名册这一件事**：
 * 办事必须问的（住户交办、缺收件人号码、房号对不上唯一一套）照旧问，他主动报的照收。
 */
export type HouseholdRosterState = {
  /** 这一户**历史上记过的人**：按人去重，含已离开的（`valid_to` 非空）与明确不住这儿的 */
  historicalCount: number;
  /** 有人说过总人数、且名册上的人够数（`declared_size` 现场算出来的，不是存的） */
  complete: boolean;
};

/** 这一户已经有人报过人了。**不许改成只数当前在册的人**（见上面那两条反例）。 */
export function householdIntakeSupplied(roster: HouseholdRosterState): boolean {
  return roster.historicalCount > 1;
}

/**
 * 这一轮还要不要向住户收名册。齐全的、已经有人报过的都停；**全新的一户照旧收**
 * ——只报过房号、名册上还只有他自己的，原来那次室友问话照旧发生（老板两步收集的第一步）。
 */
export function shouldCollectRoster(roster: HouseholdRosterState): boolean {
  return !roster.complete && !householdIntakeSupplied(roster);
}
