/**
 * **人工标准隐私卡检查器（离线、只读、评测专用，不接生产）。**
 *
 * 用法：
 *   pnpm coliving:privacy-card -- --scenario corpus-025-cleaning-privacy-2026-09-09
 *
 * 它做的是（也只做这些）：
 * - 从 `lib/chat/coliving/evals/scenarios/` 按 id 读一个已有场景，先走
 *   `validateScenario`；
 * - 取出场景里**人工核准的标准卡**（`privacyCard`，由老板/Codex 逐字段核对
 *   后写进场景文件），用 `validatePrivacyCard` 跑确定性业务校验；
 * - 生成 JSON + HTML 供人工查看，校验失败时醒目报红并非零退出。
 *
 * 边界（写死在代码里，别在这里加东西）：
 * - **完全离线**：不 import AI SDK / provider / model，不加载 `.env`，
 *   不联网，不调用任何模型。标准卡是人写的，不是模型生成的。
 * - **不调用 `runColivingTurn`**，不调 critic、contactPerson，不写数据库，
 *   不发 Twilio / 企微 / 小红书。整条链路只是"读场景 → 校验 → 写报告"。
 * - 说话人、名册、原文全部来自场景文件，不让任何外部输入编。
 * - 首版只支持单轮场景；遇到快照或多轮场景明确报"不支持"，不猜名册/轮次。
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findUnknownPrivacyCardFlags } from "../lib/chat/coliving/evals/privacy-card-args";
import {
  validatePrivacyCard,
  type PrivacyCardContext,
  type PrivacyTurnCard,
} from "../lib/chat/coliving/evals/privacy-turn-card";
import {
  type EvalScenario,
  validateScenario,
} from "../lib/chat/coliving/evals/schema";

const SCENARIOS_DIR = path.join(
  process.cwd(),
  "lib/chat/coliving/evals/scenarios"
);
const REPORT_DIR = path.join(
  process.cwd(),
  "tests/coliving-eval/reports/privacy-cards"
);

// ── CLI args（首版只认 --scenario）─────────────────────────────────────────
function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

// pnpm 会把标准用法里的字面量 `--` 原样透传给脚本，它不是未知参数；
// 真正未知的 `--turn`/`--model` 仍会被 findUnknownPrivacyCardFlags 拦下。
const unknownFlags = findUnknownPrivacyCardFlags(process.argv);
if (unknownFlags.length > 0) {
  console.error(
    `不支持的参数：${unknownFlags.join("、")}。首版只支持 --scenario <id>` +
      "（标准卡从场景文件读取，不需要 --turn/--model）。"
  );
  process.exit(2);
}

const SCENARIO_ID = argValue("scenario");
if (!SCENARIO_ID) {
  console.error("用法：pnpm coliving:privacy-card -- --scenario <id>");
  process.exit(2);
}

// ── 读场景 + 校验 ─────────────────────────────────────────────────────────
function loadScenarioById(id: string): EvalScenario {
  const files = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const raw = JSON.parse(readFileSync(path.join(SCENARIOS_DIR, f), "utf8"));
    if ((raw as { id?: string })?.id === id) {
      return validateScenario(raw, f);
    }
  }
  throw new Error(
    `找不到场景 id「${id}」（目录：lib/chat/coliving/evals/scenarios/）`
  );
}

type PrivacyCardReport = {
  scenarioId: string;
  scenarioSource: string;
  /** 明示卡片来源，避免与已停止的"模型生成卡"混淆。 */
  cardOrigin: "场景文件人工核准的标准隐私卡（非模型生成）";
  turnIndex: number;
  turnCount: number;
  checkedAt: string;
  context: PrivacyCardContext;
  card: PrivacyTurnCard;
  validation: ReturnType<typeof validatePrivacyCard>;
};

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function list(items: string[]): string {
  return items.length === 0
    ? '<p class="empty">（无）</p>'
    : `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
}

function renderHtml(data: PrivacyCardReport): string {
  const { card: c, validation: v } = data;
  const badge = v.ok
    ? '<span class="badge ok">确定性校验通过</span>'
    : `<span class="badge bad">确定性校验失败（${v.violations.length}）</span>`;
  const violations = v.ok
    ? ""
    : `<div class="violations"><h2>校验失败项</h2><ul>${v.violations
        .map((x) => `<li><code>${esc(x.code)}</code>：${esc(x.message)}</li>`)
        .join("")}</ul></div>`;
  const roster = data.context.roster.map((n) => esc(n)).join("、");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>人工标准隐私卡 · ${esc(data.scenarioId)}</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; margin: 24px; color: #1c1c1e; line-height: 1.6; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin: 18px 0 6px; color: #3a3a3c; }
  .meta { color: #6b6b70; font-size: 13px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 13px; color: #fff; }
  .badge.ok { background: #2e7d32; } .badge.bad { background: #c62828; }
  .card, .violations { border: 1px solid #d9d9de; border-radius: 8px; padding: 12px 16px; margin-top: 8px; }
  .violations { border-color: #c62828; background: #fdf1f1; }
  table { border-collapse: collapse; width: 100%; margin-top: 6px; }
  td { border-bottom: 1px solid #ececf0; padding: 6px 8px; vertical-align: top; }
  td.k { width: 190px; color: #6b6b70; }
  .empty { color: #9a9aa0; }
  ul { margin: 4px 0; padding-left: 20px; }
  blockquote { margin: 6px 0; padding: 8px 12px; background: #f4f4f6; border-left: 3px solid #b9b9c0; }
  code { background: #f0f0f3; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<h1>人工标准隐私卡 · ${esc(data.scenarioId)}</h1>
<p class="meta">卡片来源：${esc(data.cardOrigin)} ｜ 第 ${data.turnIndex}/${data.turnCount} 轮 ｜ 校验时间：${esc(data.checkedAt)} ｜ ${badge}</p>

<h2>场景</h2>
<p class="meta">${esc(data.scenarioSource)}</p>

<h2>说话人与名册</h2>
<table>
  <tr><td class="k">当前说话人</td><td>${esc(data.context.speaker)}</td></tr>
  <tr><td class="k">名册</td><td>${roster}</td></tr>
  <tr><td class="k">本轮原文</td><td><blockquote>${esc(data.context.rawMessage)}</blockquote></td></tr>
</table>

<h2>标准隐私卡</h2>
<div class="card">
<table>
  <tr><td class="k">信息所有者 sourceOwner</td><td>${esc(c.sourceOwner)}</td></tr>
  <tr><td class="k">拟联系对象 proposedRecipients</td><td>${list(c.proposedRecipients)}</td></tr>
  <tr><td class="k">敏感事实 sensitiveClaims</td><td>${list(c.sensitiveClaims)}</td></tr>
  <tr><td class="k">反推风险 inferenceRisk</td><td><b>${esc(c.inferenceRisk)}</b></td></tr>
  <tr><td class="k">风险依据 riskReasons</td><td>${list(c.riskReasons)}</td></tr>
  <tr><td class="k">所有者同意 ownerConsent</td><td><b>${esc(c.ownerConsent)}</b></td></tr>
  <tr><td class="k">建议动作 recommendedAction</td><td><b>${esc(c.recommendedAction)}</b></td></tr>
  <tr><td class="k">住户回复 residentReply</td><td><blockquote>${esc(c.residentReply)}</blockquote></td></tr>
  <tr><td class="k">判断摘要 decisionSummary</td><td>${esc(c.decisionSummary)}</td></tr>
</table>
</div>
${violations}
</body>
</html>
`;
}

function main() {
  const scenario = loadScenarioById(SCENARIO_ID as string);

  if (scenario.snapshot) {
    console.error(
      `场景「${scenario.id}」是快照重放（snapshot=${scenario.snapshot}）；` +
        "标准卡需要从场景文件取说话人与名册，暂不支持快照，不猜名册。"
    );
    process.exit(2);
  }
  if (!scenario.privacyCard) {
    console.error(
      `场景「${scenario.id}」没有保存人工标准隐私卡（privacyCard）。` +
        "标准卡由老板/Codex 核对后写进场景文件；本工具不生成卡片。"
    );
    process.exit(2);
  }
  if (scenario.turns.length !== 1) {
    console.error(
      `场景「${scenario.id}」有 ${scenario.turns.length} 轮；首版标准卡只支持单轮场景，` +
        "不做轮次猜测。"
    );
    process.exit(2);
  }

  const people = scenario.people ?? [];
  const turn = scenario.turns[0];
  const speaker = people.find((p) => p.phone === turn.from)?.name;
  if (!speaker) {
    throw new Error(
      `场景「${scenario.id}」第 1 轮发信人 ${turn.from} 不在 people 列表里`
    );
  }
  const context: PrivacyCardContext = {
    speaker,
    roster: people.map((p) => p.name),
    rawMessage: turn.text,
  };

  const validation = validatePrivacyCard(scenario.privacyCard, context);

  const checkedAt = new Date().toISOString();
  const report: PrivacyCardReport = {
    scenarioId: scenario.id,
    scenarioSource: scenario.source,
    cardOrigin: "场景文件人工核准的标准隐私卡（非模型生成）",
    turnIndex: 1,
    turnCount: scenario.turns.length,
    checkedAt,
    context,
    card: scenario.privacyCard,
    validation,
  };

  const stamp = checkedAt.replace(/[:.]/g, "-");
  const baseName = `${scenario.id}-gold-${stamp}`;
  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(REPORT_DIR, `${baseName}.json`);
  const htmlPath = path.join(REPORT_DIR, `${baseName}.html`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(htmlPath, renderHtml(report), "utf8");

  console.log(
    `人工标准隐私卡已检查：${baseName}\n` +
      `  说话人「${speaker}」，inferenceRisk=${report.card.inferenceRisk}，` +
      `ownerConsent=${report.card.ownerConsent}，recommendedAction=${report.card.recommendedAction}\n` +
      `  确定性校验：${validation.ok ? "通过" : `失败（${validation.violations.length} 项）`}\n` +
      `  JSON：${jsonPath}\n  HTML：${htmlPath}`
  );
  if (!validation.ok) {
    for (const violation of validation.violations) {
      console.error(`  - [${violation.code}] ${violation.message}`);
    }
    process.exit(1);
  }
}

try {
  main();
} catch (e) {
  console.error("检查失败：", e instanceof Error ? e.message : e);
  process.exit(1);
}
