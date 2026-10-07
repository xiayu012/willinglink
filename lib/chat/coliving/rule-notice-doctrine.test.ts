/**
 * 共同规则通知的措辞来源：**离线反例**。
 *
 * 运行：`pnpm.cmd exec tsx lib/chat/coliving/rule-notice-doctrine.test.ts`
 *
 * 盯的是**来源**，不是措辞好不好——语气好不好读要人工看（CLAUDE.md「机械检查证明不了
 * 语气」）。这里只证明三件会真出事的事：
 *
 * 1. 五段标题少一段 / 空一段 → **直接报错**，不静默退回代码里的旧句子；
 * 2. 立场段的锚点被删 → 报错（否则通知会悄悄变回「我定的标准」那种口吻）；
 * 3. 提示词是**从文件拼出来的**，不是代码里写死的字符串——把文件改了，提示词跟着变。
 *
 * 纯离线：只读文件与纯函数，不调模型、不连库、不发短信。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  loadRuleNoticeDoctrine,
  parseRuleNoticeDoctrine,
  RULE_NOTICE_AUTHORITY_ANCHOR,
  RULE_NOTICE_SECTIONS,
} from "./rule-notice-doctrine";

let checks = 0;
async function check(
  what: string,
  fn: () => void | Promise<void>
): Promise<void> {
  await fn();
  checks += 1;
  console.log(`ok ${checks} - ${what}`);
}

const VALID = [
  "# 说明",
  "",
  "## authority",
  "这条规则不是你定的，是他们自己的。",
  "",
  "## privacy",
  "不许提是谁提的。",
  "",
  "## consult",
  "请还没表态的人表个态。",
  "",
  "## announce",
  "告诉他这条已经成立。",
  "",
  "## ack",
  "回一句如实的确认。",
  "",
].join("\n");

async function main(): Promise<void> {
  await check("五个标题齐了就能读出五段", () => {
    const parsed = parseRuleNoticeDoctrine(VALID, "fixture.md");
    assert.deepEqual(Object.keys(parsed).sort(), [...RULE_NOTICE_SECTIONS].sort());
    assert.equal(parsed.announce, "告诉他这条已经成立。");
  });

  await check("标题之外的内容（编辑须知、别的标题）不会被拼进提示词", () => {
    const parsed = parseRuleNoticeDoctrine(VALID, "fixture.md");
    assert.ok(!parsed.authority.includes("说明"));
    assert.ok(!JSON.stringify(parsed).includes("# 说明"));
  });

  await check("少一段直接报错，并指出缺的是哪一段", () => {
    const missing = VALID.replace("## ack\n回一句如实的确认。\n", "");
    assert.throws(
      () => parseRuleNoticeDoctrine(missing, "fixture.md"),
      /ack/
    );
  });

  await check("某一段留空直接报错（空段等于没有约束）", () => {
    const empty = VALID.replace("不许提是谁提的。", "   ");
    assert.throws(
      () => parseRuleNoticeDoctrine(empty, "fixture.md"),
      /空的/
    );
  });

  await check("同一个标题出现两次直接报错（否则改一处、另一处还是旧的）", () => {
    const duplicated = VALID.replace(
      "## privacy",
      "## authority\n再写一遍。\n\n## privacy"
    );
    assert.throws(
      () => parseRuleNoticeDoctrine(duplicated, "fixture.md"),
      /两次/
    );
  });

  await check(`立场段少了「${RULE_NOTICE_AUTHORITY_ANCHOR}」直接报错`, () => {
    const defanged = VALID.replace(
      "这条规则不是你定的，是他们自己的。",
      "写通知要客气一点。"
    );
    assert.throws(
      () => parseRuleNoticeDoctrine(defanged, "fixture.md"),
      /锚点/
    );
  });

  await check("仓库里那份文件本身能读出来（真文件过同一套校验）", () => {
    const doctrine = loadRuleNoticeDoctrine();
    assert.ok(doctrine.authority.length > 0);
    assert.ok(doctrine.announce.includes("已经成立"));
  });

  await check("提示词由文件拼出来，不是代码里写死的字符串", async () => {
    const source = readFileSync(
      new URL("./rule-consultation-notice.ts", import.meta.url),
      "utf8"
    );
    assert.ok(
      source.includes("loadRuleNoticeDoctrine()"),
      "系统提示必须从 doctrine 文件读立场，不能又写回 .ts 里"
    );
    for (const section of RULE_NOTICE_SECTIONS) {
      assert.ok(
        source.includes(`d.${section}`),
        `文件里的「${section}」必须真的被拼进提示词`
      );
    }
    // 被删掉的那句旧立场不许悄悄回来：它正是「AI 有个人权威」那个口吻的来源。
    assert.ok(
      !source.includes("我定的标准"),
      "不许把立场再写回代码字符串"
    );
  });

  console.log(
    `\nrule-notice doctrine：${checks} 项全过（零模型、零短信、零数据库）。`
  );
}

main().catch((error) => {
  console.error("\nFAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
