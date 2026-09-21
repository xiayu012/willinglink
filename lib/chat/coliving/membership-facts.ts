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
export function placeholderName(role: Role, index: number): string {
  const noun =
    role === "landlord"
      ? "房东"
      : role === "manager"
        ? "管理人"
        : role === "coordinator"
          ? "协调人"
          : role === "tenant"
            ? "住客"
            : "联系人";
  return `${index}号${noun}`;
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
