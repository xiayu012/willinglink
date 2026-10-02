import { coordinatorCopyText } from "./coordinator-copy";
import type { ResidentLanguage } from "./language";

/**
 * **首次接触的固定事实：那条自我介绍是哪一句、按哪种语言说。**
 *
 * 纯模块：**零 DB、零模型、零随机**。`turn.ts` 与免费闸 `/coliving:quality`
 * 读的是同一份，不另立会漂移的第二份实现。
 *
 * 老板 2026-10-01 的口径：任何号码正常进入对话，不再彻底模板拒绝；**每个尚未成功收到
 * 这条固定介绍的人主动开口**时，**第一条是这条固定的自我介绍**（按对方语言），
 * **第二条才是正常回复**。
 * 这两条是两次独立的外呼，不是一句话拼起来的。
 *
 * **"这个人还要不要被介绍一次"不在这里判**——那是库里的原子占位
 * （`repo.claimFirstIntroduction` / `repo.awaitFirstIntroductionDelivered`），
 * 只认**这一条固定介绍自己**有没有真的送到过（收窄到同一个 `purpose`）。会话历史里
 * 有没有 assistant 消息**不作数**：普通回复、提醒、别的已发出通信都不能替代它。
 */

/**
 * 这条外呼的 `purpose`——库里的**结构化标记**，不是给住户看的字。
 *
 * 两个地方按它收窄：① `claimFirstIntroduction` 判「这个号码是不是已经被介绍过」；
 * ② 复核时能一眼分出「这条是那两句固定介绍之一」而不是模型的自由输出。
 */
export const INTRODUCTION_PURPOSE = "首次自我介绍";

/** 落 decision 时写的意图（治理记录，与住户看到的字无关）。 */
export const INTRODUCTION_INTENT = "首次接触：先发固定自我介绍，再正常回复";

/**
 * **那条固定的自我介绍原文。**
 *
 * 逐字取自单点文案 `doctrine/content/coordinator-self-description.md` 的
 * `identity.zh` / `identity.en`（见 `coordinator-copy.ts`）——**这里不写第二份、
 * 不改写、不拼接、不润色**。同一个语言判定（`decideLanguage`）一路传下来，
 * 不在这里重推语言（`language.ts` 的纪律：一轮里只判一次）。
 */
export function introductionIn(language: ResidentLanguage): string {
  return coordinatorCopyText("identity", language);
}

/**
 * **首次介绍没送到时终止本轮的错误。**
 *
 * 首条没到就往下发第二条，住户收到的第一句就不是自我介绍。所以本轮到此为止：
 * 抛出去由 `app/api/twilio/messages/route.ts` 既有的 catch 记账，**下一条入站**重试
 * （介绍那条 communication 已记 `failed`，`claimFirstIntroduction` 会再给一次机会）。
 */
export class IntroductionNotDelivered extends Error {
  constructor(reason: string) {
    super(`[coliving] 首次介绍没送到，本轮不再生成第二条：${reason}`);
    this.name = "IntroductionNotDelivered";
  }
}
