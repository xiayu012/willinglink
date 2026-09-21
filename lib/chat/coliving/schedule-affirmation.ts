/**
 * **排班征询的落锤短句**——住户用「愿意 / 行 / 可以」这类简单肯定回了我们一条
 * 排班时段征询时，代码直接落的那一句话。
 *
 * 这条路径**模型根本没被调用**（`turn.ts` 的短路闸在主生成之前就收工了），所以
 * 正文只能由代码给——准则管不到一条不会被模型生成的句子。硬编码文案的纪律
 * （「硬编码的固定文案只留给模型根本没被调用的路径，并且要短、要中性」）在这里
 * 成立，但它还漏了另一半：**这类兜底最容易把语言闸打穿**。住户通篇英文、
 * 回一个 "sure"，模型那侧本来会说英文，代码却回一句中文——语言这条路最常
 * 就是被这种确定性兜底破坏的。
 *
 * 所以这里只做一件事：把同一条事实按**轮次语言判定**（`language.ts`）写成
 * 中文或英文。两种语言说的是同一件事、同一个时段，**不新增任何事实**——
 * 时段字符串（`18:00-20:00`）原样带过去，不改写成 "6pm" 这类再解释。
 *
 * 与 `reply-only.ts` 的 `replyOnlyFallback` / `blacklist.ts` 的
 * `blacklistedReply` 同一条口径：**缺省中文，与加语言闸之前逐字一致**；
 * 调用方传的是轮次判定（含会话回退），不是在这里拿这一句原话现推。
 */

import type { ResidentLanguage } from "./language";

/** 有具体时段时的中文短句。加语言闸之前逐字如此，改动即为回归。 */
export const SCHEDULE_AFFIRMATION_ZH =
  (slot: string) => `好，${slot} 就定给你了。`;

/** 取不到具体时段时的中文短句。同样逐字保留。 */
export const SCHEDULE_AFFIRMATION_ZH_NO_SLOT = "好，时段定了，按这个来。";

/** 同一条事实的英文写法：同一个时段、同样只说「定了」这一件事。 */
export const SCHEDULE_AFFIRMATION_EN =
  (slot: string) => `Got it — ${slot} is yours.`;

/** 取不到具体时段时的英文写法。 */
export const SCHEDULE_AFFIRMATION_EN_NO_SLOT =
  "Got it — the slot is set, go with that.";

/**
 * 按轮次语言判定选那一句。**缺省或 `zh` 都回中文**（与加语言闸之前逐字一致），
 * 只有 `en` 才回英文——判定本身由 `turn.ts` 在轮次边界判一次后传进来，
 * 这里不看原话、不另写正则（`reply-only.ts` 曾经自己写过一个汉字正则，
 * 就是这条纪律的反例）。
 */
export function scheduleAffirmationReply(
  slot: string | null,
  language: ResidentLanguage = "zh"
): string {
  if (language === "en") {
    return slot
      ? SCHEDULE_AFFIRMATION_EN(slot)
      : SCHEDULE_AFFIRMATION_EN_NO_SLOT;
  }
  return slot ? SCHEDULE_AFFIRMATION_ZH(slot) : SCHEDULE_AFFIRMATION_ZH_NO_SLOT;
}
