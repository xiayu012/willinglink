/**
 * 排班落锤短句的语言贯通（`schedule-affirmation.ts`）的**确定性反例**：纯 Node 单测。
 *
 * 运行：
 *   `pnpm.cmd exec tsx lib/chat/coliving/schedule-affirmation.test.ts`
 *
 * **不调 LLM、不连 DB、不发送**：这条路径本来就是"模型没被调用、代码直接落锤"
 * 的那一条，所以它能被纯函数测穿。
 *
 * 钉住三件事：
 *
 * 1. **中文一字不动**：缺省与 `zh` 都必须与加语言闸之前逐字一致（改一个字就是回归）；
 * 2. **英文住户拿到英文**：`en` 时按同一件事、同一个时段说英文，**不新增事实**——
 *    时段字符串原样带过去，不改写、不补解释、不承诺别的；
 * 3. **判定是传进来的值，不是现推的**：`turn.ts` 在轮次边界判一次（含"原话定不了、
 *    读会话回退"那一档），三处落锤读的是同一个判定——所以这里也按"判定"而不是
 *    "这一句文本"来测（同一个 "ok" 配不同会话回退，会得到不同语言）。
 */

import assert from "node:assert/strict";
import { decideLanguage } from "./language";
import {
  SCHEDULE_AFFIRMATION_EN,
  SCHEDULE_AFFIRMATION_EN_NO_SLOT,
  SCHEDULE_AFFIRMATION_ZH,
  SCHEDULE_AFFIRMATION_ZH_NO_SLOT,
  scheduleAffirmationReply,
} from "./schedule-affirmation";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const SLOT = "18:00-20:00";

function main(): void {
  console.log("schedule affirmation（排班落锤短句的语言）");

  check("缺省与 zh：与加语言闸之前逐字一致（有具体时段 / 取不到时段两种）", () => {
    assert.equal(scheduleAffirmationReply(SLOT), SCHEDULE_AFFIRMATION_ZH(SLOT));
    assert.equal(scheduleAffirmationReply(SLOT), `好，${SLOT} 就定给你了。`);
    assert.equal(scheduleAffirmationReply(null), SCHEDULE_AFFIRMATION_ZH_NO_SLOT);
    assert.equal(scheduleAffirmationReply(null), "好，时段定了，按这个来。");
    assert.equal(scheduleAffirmationReply(SLOT, "zh"), `好，${SLOT} 就定给你了。`);
    assert.equal(scheduleAffirmationReply(null, "zh"), "好，时段定了，按这个来。");
  });

  check("en：说英文，时段原样带过去，不新增任何事实", () => {
    const withSlot = scheduleAffirmationReply(SLOT, "en");
    assert.equal(withSlot, SCHEDULE_AFFIRMATION_EN(SLOT));
    assert.equal(withSlot, `Got it — ${SLOT} is yours.`);
    // 时段字符串必须逐字带过去：不许改写成 "6pm"、不许换算、不许加解释。
    assert.ok(withSlot.includes(SLOT), "时段必须原样出现在正文里");
    assert.ok(!/[一-鿿]/.test(withSlot), "英文落锤里不许有汉字");
    const noSlot = scheduleAffirmationReply(null, "en");
    assert.equal(noSlot, SCHEDULE_AFFIRMATION_EN_NO_SLOT);
    assert.ok(!/[一-鿿]/.test(noSlot), "英文落锤里不许有汉字");
    // 不承诺别的：不出现"会通知别人 / 已经联系"这类它做不到的承诺。
    for (const text of [withSlot, noSlot]) {
      assert.ok(
        !/(ask|notify|tell|contact|message)\s+(the\s+)?(others|everyone|roommates)/i.test(
          text
        ),
        `落锤短句不许承诺去联系别人：${text}`
      );
    }
  });

  check("判定是轮次值：同一个 \"ok\"，会话回退不同就落成不同语言（不是拿这一句现推）", () => {
    // 中英混写 / 只回一个 "ok" 时，原话自己定不了——判定的依据是同一条会话线上
    // 最近的、判得出来的那一条。三处落锤读的都是这个判定。
    const en = decideLanguage("ok", [
      { role: "assistant", content: "Should I book the 18:00-20:00 slot for you?" },
    ]);
    assert.equal(en.source, "conversation-fallback");
    assert.equal(scheduleAffirmationReply(SLOT, en.language), `Got it — ${SLOT} is yours.`);

    const zh = decideLanguage("ok", [
      { role: "assistant", content: "那我把 18:00-20:00 这个时段定给你？" },
    ]);
    assert.equal(zh.source, "conversation-fallback");
    assert.equal(scheduleAffirmationReply(SLOT, zh.language), `好，${SLOT} 就定给你了。`);

    // 会话里也定不出来 → 默认中文，与加语言闸之前逐字一致。
    const fallbackDefault = decideLanguage("ok", []);
    assert.equal(fallbackDefault.source, "default");
    assert.equal(
      scheduleAffirmationReply(SLOT, fallbackDefault.language),
      `好，${SLOT} 就定给你了。`
    );
  });

  console.log(`\nschedule affirmation：${passed} 项检查全部通过`);
}

main();
