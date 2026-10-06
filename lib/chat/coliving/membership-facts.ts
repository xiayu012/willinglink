/**
 * 名册上「这个人跟这栋房子是什么关系」的纯事实层。**零 import**——
 * 运行时（`repo.ts`）、评测脚本、离线免费闸读的是同一份，不各写一套会漂移的判断。
 *
 * 这里只有两件独立的事实，**不许互相推**：
 *
 *   · `role`    —— 他是什么身份（租客 / 业主 / 宿管物业 / 协调人 / 还不知道）
 *   · `resides` —— 他此刻住不住在这里（true / false / **null = 不知道**）
 *
 * 曾经把世界写死成「房东 → 租客 → 住在这里」：角色只有两种，号码一进来
 * `resides` 就是 `true`。结果是宿管、物业、代为传话的协调人全被记成租客，
 * 而且系统笃定地说他住在这儿。**号码本身从来不说明任何一件事。**
 * 房东住在自己房子里（`role=landlord, resides=true`）和宿管不住这儿
 * （`role=manager, resides=false`）都是正常世界的一部分。
 */

export type Role = "tenant" | "landlord" | "manager" | "coordinator" | "other";

export const ROLES: readonly Role[] = [
  "tenant",
  "landlord",
  "manager",
  "coordinator",
  "other",
];

/**
 * 录入边界上的**三态**居住输入。用三态而不是 `boolean`，是因为
 * 「没提」和「明确说了不知道」都必须能表达成 `null`，
 * 而 `undefined`（干脆没填）与它们又有区别——见 `mergeMembershipFacts`。
 */
export type ResidenceInput =
  | "confirmed_lives"
  | "confirmed_not_living"
  | "unknown";

export const RESIDENCE_INPUTS: readonly ResidenceInput[] = [
  "confirmed_lives",
  "confirmed_not_living",
  "unknown",
];

/**
 * 三态输入 → 库里那个 `boolean | null`。
 *
 * **省略（undefined/null）= 不知道**，不是「住着」。号码到手就当作他住这儿，
 * 正是这次要修的那个推论。
 */
export function residesFromInput(
  input: ResidenceInput | null | undefined
): boolean | null {
  if (input === "confirmed_lives") {
    return true;
  }
  if (input === "confirmed_not_living") {
    return false;
  }
  return null;
}

/**
 * 角色的人话标签，给上下文里的名册用。**这不是给住户的措辞**——
 * 发给住户的话一律归准则管，代码只管名册渲染得不含混。
 *
 * `coordinator` 特意标出「人类」：这个系统自己就是协调者，
 * 名册里出现一个光秃秃的「协调人」会让模型把自己和这个人搞混。
 */
export function roleLabel(role: Role): string {
  switch (role) {
    case "tenant":
      return "租客";
    case "landlord":
      return "房东";
    case "manager":
      return "宿管/物业";
    case "coordinator":
      return "协调人（人类，不是你）";
    case "other":
      return "还不知道是什么身份的联系人";
  }
}

/**
 * 没听到真名时的占位名。**按角色给中性词**——把宿管、物业叫成
 * 「2号住客」等于用占位名顺手断言了身份和居住，两件我们都没确认过的事。
 *
 * 占位名是内部编号，任何情况下不许说进消息（渲染层逐人标 `nameConfirmed`，
 * 见 `context.ts`）。
 */
export const PLACEHOLDER_NOUNS: Readonly<Record<Role, string>> = {
  landlord: "房东",
  manager: "管理人",
  coordinator: "协调人",
  tenant: "住客",
  other: "联系人",
};

export function placeholderName(role: Role, index: number): string {
  return `${index}号${PLACEHOLDER_NOUNS[role]}`;
}

/**
 * 这个名字是不是`placeholderName`发的内部编号。
 *
 * **认占位名必须问生成它的那份表**，不许另抄一份格式。记过一次事故：
 * 别处硬写了「`n号住客` = 占位名」的格式判断，后来占位名词表按角色分了家
 * （宿管是`n号管理人`），那份硬写的判断从此静默失效——占位名被当成真名
 * 念给住户听。所以生成与识别共用同一个`PLACEHOLDER_NOUNS`。
 */
export function isPlaceholderName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    return false;
  }
  const nouns = Object.values(PLACEHOLDER_NOUNS).join("|");
  return new RegExp(`^[0-9]+号(?:${nouns})$`).test(trimmed);
}

/**
 * 「他本人叫什么，我们还不知道」——决定要不要在第一次接触里自然地问一句
 * 「怎么称呼你」。
 *
 * **两件事同时成立才算不知道**，缺一不可：
 *
 *   · `!nameConfirmed` —— 没有人确认过这个名字。`addResident` 只在库里写了
 *     `display_name`，**从没把 `name_confirmed` 置真**，所以房主导入的名册、
 *     室友转述来的名字读出来都是 `false`。**只看这一位会把已经知道的名字
 *     再问一遍。**
 *   · `isPlaceholderName(name)` —— 名字本身就是内部编号（`3号住客`），
 *     也就是「从没听见真名」。
 *
 * 合起来才是「我们手上这个名字不是真名，而且没有人替他确认过」。
 */
export function selfNameUnknown(
  member: { name: string; nameConfirmed: boolean } | null | undefined
): boolean {
  if (!member) {
    return true;
  }
  return !member.nameConfirmed && isPlaceholderName(member.name);
}

/** `nameProvenanceMark` 用的两种标注，出成常量供离线闸逐字比对。 */
export const PLACEHOLDER_NAME_MARK = "〔占位名，不是真名，不可念出口〕";
export const UNCONFIRMED_NAME_MARK = "〔还没经他本人确认，别当成定论〕";

/**
 * 名册里这个名字该**怎么标给模型看**（`context.ts` 逐人渲染时贴在名字后面）。
 *
 * 三态，跟 `selfNameUnknown` 是同一套判据的两种用法：
 *
 *   · 他本人确认过（`nameConfirmed`）→ **不标**，可以照常说。
 *   · 名字是内部编号（`isPlaceholderName`）→ 标「占位名…不可念出口」，
 *     **任何情况下不许说进消息**。
 *   · **名字是真名、只是没人替他确认过**（室友转述来的、名册里导入的：
 *     `addResident` 只写 `display_name`，从不把 `name_confirmed` 置真）→
 *     标「还没经他本人确认」。
 *
 * **第三态是这次补的**（2026-10-06）。以前这里只有「确认过 / 没确认过」两态，
 * 第二种和第三种标的是同一句话——于是名册里一个室友转述来的真名会被标成
 * 「占位名，不可念出口」，与「这个名字我们已经知道了、不必再问」直接打架：
 * 模型一边被告知不能念、一边被告知别问，最后两边都不做。
 *
 * **判据只放这一处**：不要靠在别处写一句「名字带 X 字样的是占位符」——
 * 占位名格式一改那句话就静默失效（真踩过：AI 把「2号、3号」念进了短信）。
 * `nameConfirmed` 那条安全线**一位没动**：没确认过的名字照样带标注。
 */
export function nameProvenanceMark(member: {
  name: string;
  nameConfirmed: boolean;
}): string {
  if (member.nameConfirmed) {
    return "";
  }
  return isPlaceholderName(member.name)
    ? PLACEHOLDER_NAME_MARK
    : UNCONFIRMED_NAME_MARK;
}

export type MembershipFacts = {
  role: Role;
  resides: boolean | null;
  note: string | null;
};

/**
 * 已经认识的人又被提到一次时，**哪些新信息可以写进去**。
 *
 * 规矩只有一条：**只有说出口的事实才覆盖，省略一律保留原值。**
 * 再报一次号码（这次什么都没多说）绝不能把上次问出来的「他是宿管、不住这儿」
 * 抹掉——那不是补充信息，那是把已知事实倒退回未知。
 * 所以 `role` 里的 `other`、`resides` 里的 `null` 都按「没信息」处理，不覆盖。
 */
export function mergeMembershipFacts(
  existing: MembershipFacts,
  supplied: {
    role?: Role | null;
    resides?: boolean | null;
    note?: string | null;
  }
): MembershipFacts {
  const role =
    supplied.role && supplied.role !== "other" ? supplied.role : existing.role;
  const resides =
    supplied.resides === true || supplied.resides === false
      ? supplied.resides
      : existing.resides;
  const note = supplied.note?.trim() ? supplied.note : existing.note;
  return { role, resides, note };
}
