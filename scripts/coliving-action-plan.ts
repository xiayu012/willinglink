/**
 * **离线「逐动作协调计划」报告生成器（V4，评测专用，不接生产）。**
 *
 * 用法：
 *   pnpm coliving:action-plan                 # 生成全部开发者期望样例
 *   pnpm coliving:action-plan -- --sample sample-03-mixed-capability-024
 *
 * 它做的是（也只做这些）：
 * - 取 `lib/chat/coliving/evals/action-plan-samples.ts` 里**开发者手写**的离线期望
 *   计划（非模型生成、非老板核准）；
 * - 用 `validateActionPlan` 跑确定性业务校验；
 * - 为每张样例生成 JSON + HTML，把每个动作的授权/就绪度/能力区/状态/依赖/收据并排
 *   摊开展示，供人工核对；
 * - 校验失败时醒目报红并非零退出。
 *
 * 边界（写死在代码里，别在这里加东西）：
 * - **完全离线**：不 import AI SDK / provider / model，不加载 `.env`，不联网，
 *   不调用任何模型。
 * - **不调用 `runColivingTurn`**，不调 critic、contactPerson，不写数据库，
 *   不发 Twilio / 企微 / 小红书。整条链路只是「读样例 → 校验 → 写报告」。
 * - 报告里不展示任何隐藏思维链，只展示填好的字段与校验结果。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findUnknownActionPlanFlags } from "../lib/chat/coliving/evals/action-plan-args";
import {
  validateActionPlan,
  type ActionItem,
  type ActionPlan,
  type ActionPlanContext,
  type ActionPlanValidation,
} from "../lib/chat/coliving/evals/action-plan";
import {
  ACTION_PLAN_SAMPLES,
  type ActionPlanSample,
} from "../lib/chat/coliving/evals/action-plan-samples";

const REPORT_DIR = path.join(
  process.cwd(),
  "tests/coliving-eval/reports/action-plans"
);

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const unknownFlags = findUnknownActionPlanFlags(process.argv);
if (unknownFlags.length > 0) {
  console.error(
    `不支持的参数：${unknownFlags.join("、")}。只支持 --sample <id>（省略则生成全部样例）。`
  );
  process.exit(2);
}

const sampleId = argValue("sample");
const samples = sampleId
  ? ACTION_PLAN_SAMPLES.filter((s) => s.id === sampleId)
  : ACTION_PLAN_SAMPLES;
if (samples.length === 0) {
  console.error(
    `找不到样例 id「${sampleId}」。可用：${ACTION_PLAN_SAMPLES.map((s) => s.id).join("、")}`
  );
  process.exit(2);
}

type ActionPlanReport = {
  sampleId: string;
  title: string;
  sampleSource: string;
  /** 明示来源：开发者手写的离线草案，避免被当成模型输出或老板核准。 */
  planOrigin: "开发者手写的离线逐动作期望计划（非模型生成、非老板核准）";
  checkedAt: string;
  context: ActionPlanContext;
  plan: ActionPlan;
  validation: ActionPlanValidation;
};

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const KIND_LABEL: Record<string, string> = {
  ask_requester: "问发信人",
  contact_person: "联系第三方",
  make_schedule: "计算/拟方案",
  publish_plan: "对外发布方案",
  establish_rule: "形成规则",
};
const AUTH_LABEL: Record<string, string> = {
  requester_requested: "发信人已请求",
  coordinator_duty: "协调员职责",
  needs_confirmation: "等发信人确认",
  denied: "发信人已拒绝",
};
const READINESS_LABEL: Record<string, string> = {
  ready: "信息就绪",
  missing_requester_fact: "缺发信人关键事实",
};
const STATUS_LABEL: Record<string, string> = {
  planned: "已计划未动作",
  waiting_reply: "已发出等回复",
  done: "本轮已完成",
  stopped: "已停止",
};
const STATUS_CLASS: Record<string, string> = {
  planned: "st-planned",
  waiting_reply: "st-waiting",
  done: "st-done",
  stopped: "st-stopped",
};
const CAPABILITY_LABEL: Record<string, string> = {
  green: "绿区 · 可独立处理",
  yellow: "黄区 · 有限处理",
  red: "红区 · 当前不独立协调",
};
const CAPABILITY_CLASS: Record<string, string> = {
  green: "zone-green",
  yellow: "zone-yellow",
  red: "zone-red",
};

function label(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}

function inlineList(items: string[] | undefined): string {
  return items && items.length > 0
    ? items.map((x) => esc(x)).join("；")
    : '<span class="muted">—</span>';
}

function renderReceipts(action: ActionItem): string {
  const outbound = action.outbound ?? [];
  if (outbound.length === 0) {
    return '<span class="muted">（无出站）</span>';
  }
  return outbound
    .map(
      (m) => `<div class="receipt">
        <div class="muted">收件人：<b>${esc(m.recipient)}</b> ｜ 目的：${esc(m.purpose)}</div>
        <blockquote>${esc(m.text)}</blockquote>
      </div>`
    )
    .join("");
}

function renderActionRow(action: ActionItem, index: number): string {
  const deps =
    (action.dependsOn ?? []).length > 0
      ? (action.dependsOn ?? []).map((d) => `<code>${esc(d)}</code>`).join(" ")
      : '<span class="muted">—</span>';
  const statusClass = STATUS_CLASS[action.status] ?? "st-planned";
  const zoneClass = CAPABILITY_CLASS[action.capability] ?? "zone-yellow";
  const extras: string[] = [];
  if (action.blockedReason) {
    extras.push(
      `<div class="sub"><b>阻塞/停止原因：</b>${esc(action.blockedReason)}</div>`
    );
  }
  if (action.requesterQuestion) {
    extras.push(
      `<div class="sub"><b>问发信人的问题：</b>${esc(action.requesterQuestion)}</div>`
    );
  }
  if ((action.capabilityReasons ?? []).length > 0) {
    extras.push(
      `<div class="sub"><b>能力分区理由：</b>${inlineList(action.capabilityReasons)}</div>`
    );
  }
  return `<tr>
    <td><div class="idx">#${index + 1}</div><div class="title">${esc(action.purpose)}</div><div class="muted"><code>${esc(action.id)}</code> ｜ ${esc(label(KIND_LABEL, action.kind))}</div>${extras.join("")}</td>
    <td>${esc(label(AUTH_LABEL, action.authorization))}</td>
    <td>${esc(label(READINESS_LABEL, action.readiness ?? "ready"))}</td>
    <td><span class="zone ${zoneClass}">${esc(label(CAPABILITY_LABEL, action.capability))}</span></td>
    <td><span class="st ${statusClass}">${esc(label(STATUS_LABEL, action.status))}</span></td>
    <td>${deps}</td>
    <td>${renderReceipts(action)}</td>
  </tr>`;
}

function renderHtml(data: ActionPlanReport): string {
  const { validation: v } = data;
  const badge = v.ok
    ? '<span class="badge ok">确定性校验通过</span>'
    : `<span class="badge bad">确定性校验失败（${v.violations.length}）</span>`;
  const violations = v.ok
    ? ""
    : `<div class="violations"><h2>校验失败项</h2><ul>${v.violations
        .map(
          (x) =>
            `<li>${x.actionId ? `<code>${esc(x.actionId)}</code> ` : ""}<code>${esc(x.code)}</code>：${esc(x.message)}</li>`
        )
        .join("")}</ul></div>`;
  const rows = data.plan.actions.map(renderActionRow).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>离线逐动作协调计划（开发者草案，非模型生成、非老板核准）· ${esc(data.sampleId)}</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; margin: 24px; color: #1c1c1e; line-height: 1.6; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin: 18px 0 6px; color: #3a3a3c; }
  .meta { color: #6b6b70; font-size: 13px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 13px; color: #fff; }
  .badge.ok { background: #2e7d32; } .badge.bad { background: #c62828; }
  .violations { border: 1px solid #c62828; background: #fdf1f1; border-radius: 8px; padding: 12px 16px; margin-top: 8px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { border: 1px solid #ececf0; padding: 8px; vertical-align: top; text-align: left; }
  th { background: #f4f4f6; font-size: 13px; }
  td { font-size: 13px; }
  .idx { color: #9a9aa0; font-size: 12px; }
  .title { font-weight: 600; margin: 2px 0; }
  .muted { color: #9a9aa0; }
  .sub { margin-top: 4px; font-size: 12px; color: #3a3a3c; }
  code { background: #f0f0f3; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  blockquote { margin: 4px 0; padding: 6px 10px; background: #f4f4f6; border-left: 3px solid #b9b9c0; }
  .receipt { margin-top: 2px; }
  .zone, .st { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; color: #fff; white-space: nowrap; }
  .zone-green { background: #2e7d32; } .zone-yellow { background: #f0b429; color: #3a2a00; }
  .zone-red { background: #c62828; }
  .st-planned { background: #8a8a90; } .st-waiting { background: #1f6feb; }
  .st-done { background: #2e7d32; } .st-stopped { background: #6b6b70; }
  .note { margin-top: 8px; padding: 6px 10px; background: #fff8e1; border-left: 3px solid #f0b429; font-size: 13px; }
</style>
</head>
<body>
<h1>离线逐动作协调计划（开发者草案，非模型生成、非老板核准） · ${esc(data.sampleId)}</h1>
<p class="meta">样例标题：${esc(data.title)} ｜ 校验时间：${esc(data.checkedAt)} ｜ ${badge}</p>
<p class="meta">来源说明：${esc(data.sampleSource)}</p>

<h2>本轮语境（来自样例，不让模型编）</h2>
<table>
  <tr><th>发信人</th><td>${esc(data.context.speaker)}</td></tr>
  <tr><th>名册</th><td>${data.context.roster.map((n) => esc(n)).join("、")}</td></tr>
  <tr><th>本轮原文</th><td><blockquote>${esc(data.context.rawMessage)}</blockquote></td></tr>
</table>

<h2>逐动作计划（授权 · 就绪度 · 能力区 · 状态 · 依赖 · 收据）</h2>
<table>
  <tr><th>动作</th><th>授权</th><th>就绪度</th><th>能力区</th><th>状态</th><th>依赖</th><th>收据</th></tr>
  ${rows}
</table>

<h2>回给发信人的那一句</h2>
<blockquote>${esc(data.plan.requesterReply)}</blockquote>

<p class="note">这是结构实验：只证明逐动作结构能表达现实差异，<b>不证明模型能正确填卡</b>，也不证明它优于现有 context。样例由开发者手写，未经老板核准。</p>
${violations}
</body>
</html>
`;
}

function buildReport(sample: ActionPlanSample): ActionPlanReport {
  return {
    sampleId: sample.id,
    title: sample.title,
    sampleSource: sample.source,
    planOrigin: "开发者手写的离线逐动作期望计划（非模型生成、非老板核准）",
    checkedAt: new Date().toISOString(),
    context: sample.context,
    plan: sample.plan,
    validation: validateActionPlan(sample.plan, sample.context),
  };
}

const checkedAt = new Date().toISOString();
const stamp = checkedAt.replace(/[:.]/g, "-");
mkdirSync(REPORT_DIR, { recursive: true });

let failed = 0;
for (const sample of samples) {
  const report = buildReport(sample);
  report.checkedAt = checkedAt;
  const baseName = `${sample.id}-expected-${stamp}`;
  const jsonPath = path.join(REPORT_DIR, `${baseName}.json`);
  const htmlPath = path.join(REPORT_DIR, `${baseName}.html`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(htmlPath, renderHtml(report), "utf8");
  console.log(
    `逐动作期望计划：${sample.id}（${sample.title}）\n` +
      `  动作数：${report.plan.actions.length}，确定性校验：${
        report.validation.ok
          ? "通过"
          : `失败（${report.validation.violations.length} 项）`
      }\n` +
      `  JSON：${jsonPath}\n  HTML：${htmlPath}`
  );
  if (!report.validation.ok) {
    failed += 1;
    for (const violation of report.validation.violations) {
      console.error(
        `  - [${violation.actionId ? `${violation.actionId} · ` : ""}${violation.code}] ${violation.message}`
      );
    }
  }
}

if (failed > 0) {
  process.exit(1);
}
