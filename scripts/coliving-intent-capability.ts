/**
 * **「用户意图 × 能力模块」离线报告生成器（V0，评测专用，不接生产）。**
 *
 * 用法：
 *   pnpm coliving:intent-capability                 # 生成全部开发者期望样例
 *   pnpm coliving:intent-capability -- --sample sample-02-collect-draft-publish
 *
 * 它做的是（也只做这些）：
 * - 校验 `lib/chat/coliving/evals/intent-capability.ts` 里的 capability registry：
 *   id 唯一、模块 ≤ 7、allowedTools **确实存在于当前生产工具定义**、blocked 无工具无收据、
 *   cross-cutting policies 与 playbooks 不混入 capability registry；
 * - 取 `intent-capability-samples.ts` 里**开发者手写**的离线「意图 → 能力」映射
 *   （非模型生成、非老板核准），跑确定性校验；
 * - 为每张样例生成 JSON + HTML，把每个意图的原话证据、选中能力、成熟度、允许工具、
 *   完成收据、边界原因和相关 doctrine/playbook 并排摊开展示，供人工核对；
 * - 校验失败时醒目报红并非零退出。
 *
 * 边界（写死在代码里，别在这里加东西）：
 * - **完全离线**：不 import AI SDK / provider / model，不加载 `.env`，不联网，
 *   不调用任何模型。
 * - **不 import 生产 `turn.ts` / `repo`**：工具名核对靠读取 `turn.ts` **源码文本**
 *   （`extractProductionToolNames`），不是 import 它。不调 critic、不写数据库、
 *   不发 Twilio / 企微 / 小红书。整条链路只是「读数据 → 校验 → 写报告」。
 * - 报告里不展示任何隐藏思维链，只展示填好的字段与校验结果。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findUnknownIntentCapabilityFlags } from "../lib/chat/coliving/evals/intent-capability-args";
import {
  CAPABILITY_REGISTRY_INDEX,
  INTENT_CONSTRAINT_LABEL,
  MATURITY_LABEL,
  MATURITY_STABILITY,
  extractProductionToolNames,
  validateCapabilityRegistry,
  validateIntentSample,
  type CapabilityModule,
  type CrossCuttingPolicy,
  type IntentCapabilitySample,
  type IntentContext,
  type IntentEnvelope,
  type IntentExpectation,
  type IntentValidation,
} from "../lib/chat/coliving/evals/intent-capability";
import { INTENT_CAPABILITY_SAMPLES } from "../lib/chat/coliving/evals/intent-capability-samples";

const REPORT_DIR = path.join(
  process.cwd(),
  "tests/coliving-eval/reports/intent-capability"
);

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const unknownFlags = findUnknownIntentCapabilityFlags(process.argv);
if (unknownFlags.length > 0) {
  console.error(
    `不支持的参数：${unknownFlags.join("、")}。只支持 --sample <id>（省略则生成全部样例）。`
  );
  process.exit(2);
}

// ── 1. registry 一致性（含工具名核对）──
const turnSrc = readFileSync("lib/chat/coliving/turn.ts", "utf8");
const productionToolNames = extractProductionToolNames(turnSrc);
const registryValidation = validateCapabilityRegistry(CAPABILITY_REGISTRY_INDEX, {
  productionToolNames,
});
if (!registryValidation.ok) {
  console.error("能力模块 registry 校验失败：");
  for (const v of registryValidation.violations) {
    console.error(
      `  - [${v.capabilityId ? `${v.capabilityId} · ` : ""}${v.code}] ${v.message}`
    );
  }
  process.exit(1);
}

const capabilityById = new Map(
  CAPABILITY_REGISTRY_INDEX.capabilities.map((c) => [c.id, c] as const)
);

// ── 2. 样例筛选 ──
const sampleId = argValue("sample");
const samples = sampleId
  ? INTENT_CAPABILITY_SAMPLES.filter((s) => s.id === sampleId)
  : INTENT_CAPABILITY_SAMPLES;
if (samples.length === 0) {
  console.error(
    `找不到样例 id「${sampleId}」。可用：${INTENT_CAPABILITY_SAMPLES.map((s) => s.id).join("、")}`
  );
  process.exit(2);
}

// ── 3. 报告结构 ──
type ResolvedIntent = {
  intentId: string;
  desiredOutcome: string;
  target: string;
  completionCriteria: string;
  authorizationEvidence: string | null;
  constraints: Array<{ kind: string; label: string; evidence: string }>;
  capabilityId: string;
  capabilityTitle: string;
  maturity: string;
  stability: string;
  maturityLabel: string;
  allowedTools: string[];
  requiredInputs: string[];
  successReceipts: string[];
  stopConditions: string[];
  sources: string[];
  playbooks: string[];
  policies: CrossCuttingPolicy[];
  executable: boolean;
  expectationReason: string;
};

type IntentReport = {
  sampleId: string;
  title: string;
  sampleSource: string;
  reportOrigin: string;
  checkedAt: string;
  context: IntentContext;
  envelope: IntentEnvelope;
  expectations: IntentExpectation[];
  resolved: ResolvedIntent[];
  registrySummary: {
    capabilities: number;
    policies: number;
    playbooks: number;
    productionTools: number;
  };
  registryValidation: typeof registryValidation;
  validation: IntentValidation;
};

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineList(items: readonly string[]): string {
  return items.length > 0
    ? items.map((x) => esc(x)).join("；")
    : '<span class="muted">—</span>';
}

function resolveIntent(
  sample: IntentCapabilitySample,
  intent: IntentCapabilitySample["envelope"]["intents"][number]
): ResolvedIntent {
  const module: CapabilityModule | undefined = capabilityById.get(intent.capabilityId);
  const expectation = sample.expectations.find((e) => e.intentId === intent.id);
  const maturity = module?.maturity ?? "blocked";
  return {
    intentId: intent.id,
    desiredOutcome: intent.desiredOutcome,
    target: intent.target,
    completionCriteria: intent.completionCriteria,
    authorizationEvidence: intent.authorizationEvidence,
    constraints: intent.constraints.map((c) => ({
      kind: c.kind,
      label: INTENT_CONSTRAINT_LABEL[c.kind],
      evidence: c.evidence,
    })),
    capabilityId: intent.capabilityId,
    capabilityTitle: module?.title ?? "（registry 里没有这个能力）",
    maturity,
    stability: MATURITY_STABILITY[maturity as keyof typeof MATURITY_STABILITY] ?? "unsupported",
    maturityLabel: MATURITY_LABEL[maturity as keyof typeof MATURITY_LABEL] ?? maturity,
    allowedTools: module?.allowedTools ?? [],
    requiredInputs: module?.requiredInputs ?? [],
    successReceipts: module?.successReceipts ?? [],
    stopConditions: module?.stopConditions ?? [],
    sources: module?.sources ?? [],
    playbooks: module?.playbooks ?? [],
    policies: CAPABILITY_REGISTRY_INDEX.policies.filter((p) =>
      p.appliesToCapabilities.includes(intent.capabilityId)
    ),
    executable: expectation?.executable ?? false,
    expectationReason: expectation?.reason ?? "（缺少开发者期望结论）",
  };
}

function buildReport(sample: IntentCapabilitySample, checkedAt: string): IntentReport {
  return {
    sampleId: sample.id,
    title: sample.title,
    sampleSource: sample.source,
    reportOrigin:
      "开发者手写的离线「意图 × 能力」期望映射（非模型生成、非老板核准）",
    checkedAt,
    context: sample.context,
    envelope: sample.envelope,
    expectations: sample.expectations,
    resolved: sample.envelope.intents.map((intent) => resolveIntent(sample, intent)),
    registrySummary: {
      capabilities: CAPABILITY_REGISTRY_INDEX.capabilities.length,
      policies: CAPABILITY_REGISTRY_INDEX.policies.length,
      playbooks: CAPABILITY_REGISTRY_INDEX.playbooks.length,
      productionTools: productionToolNames.length,
    },
    registryValidation,
    validation: validateIntentSample(sample, CAPABILITY_REGISTRY_INDEX),
  };
}

function renderIntentCard(r: ResolvedIntent): string {
  const zoneClass =
    r.maturity === "available"
      ? "m-available"
      : r.maturity === "partial"
        ? "m-partial"
        : "m-blocked";
  const execClass = r.executable ? "exe-yes" : "exe-no";
  const execLabel = r.executable ? "当前可执行" : "当前不得执行";
  const evidence = r.authorizationEvidence
    ? `<blockquote>${esc(r.authorizationEvidence)}</blockquote>`
    : '<span class="muted">（本轮未授权该动作：住户原话没有给出这项许可）</span>';
  const constraints =
    r.constraints.length > 0
      ? r.constraints
          .map(
            (c) =>
              `<div class="sub"><b>${esc(c.label)}</b>：原话「${esc(c.evidence)}」</div>`
          )
          .join("")
      : '<span class="muted">无</span>';
  return `<div class="card">
    <div class="card-head">
      <span class="cap">${esc(r.capabilityTitle)}</span>
      <span class="tag ${zoneClass}">${esc(r.maturityLabel)}</span>
      <span class="tag ${execClass}">${esc(execLabel)}</span>
    </div>
    <table>
      <tr><th>意图目标</th><td>${esc(r.desiredOutcome)}</td></tr>
      <tr><th>作用对象</th><td>${esc(r.target)}</td></tr>
      <tr><th>授权依据原话</th><td>${evidence}</td></tr>
      <tr><th>明确限制</th><td>${constraints}</td></tr>
      <tr><th>完成标准</th><td>${esc(r.completionCriteria)}</td></tr>
      <tr><th>选择的能力</th><td><code>${esc(r.capabilityId)}</code> ｜ 稳定性：<code>${esc(r.stability)}</code></td></tr>
      <tr><th>允许工具</th><td>${inlineList(r.allowedTools)}</td></tr>
      <tr><th>完成收据</th><td>${inlineList(r.successReceipts)}</td></tr>
      <tr><th>必要输入</th><td>${inlineList(r.requiredInputs)}</td></tr>
      <tr><th>边界原因 / 停止条件</th><td>${inlineList(r.stopConditions)}<div class="sub"><b>开发者结论：</b>${esc(r.expectationReason)}</div></td></tr>
      <tr><th>相关 Doctrine</th><td>${inlineList(r.sources)}</td></tr>
      <tr><th>相关 playbook</th><td>${inlineList(r.playbooks)}</td></tr>
      <tr><th>跨模块门禁</th><td>${inlineList(r.policies.map((p) => `${p.title}：${p.rule}`))}</td></tr>
    </table>
  </div>`;
}

function renderHtml(data: IntentReport): string {
  const v = data.validation;
  const badge = v.ok
    ? '<span class="badge ok">确定性校验通过</span>'
    : `<span class="badge bad">确定性校验失败（${v.violations.length}）</span>`;
  const violations = v.ok
    ? ""
    : `<div class="violations"><h2>校验失败项</h2><ul>${v.violations
        .map(
          (x) =>
            `<li>${x.intentId ? `<code>${esc(x.intentId)}</code> ` : ""}<code>${esc(x.code)}</code>：${esc(x.message)}</li>`
        )
        .join("")}</ul></div>`;
  const cards = data.resolved.map(renderIntentCard).join("");
  const registry = `<p class="meta">registry：能力 ${data.registrySummary.capabilities} ｜ 跨模块门禁 ${data.registrySummary.policies} ｜ 领域 playbook ${data.registrySummary.playbooks} ｜ 当前生产工具 ${data.registrySummary.productionTools}（工具名已逐个核对存在）</p>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>用户意图 × 能力模块（开发者草案，非模型生成、非老板核准） · ${esc(data.sampleId)}</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; margin: 24px; color: #1c1c1e; line-height: 1.6; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin: 18px 0 6px; color: #3a3a3c; }
  .meta { color: #6b6b70; font-size: 13px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 13px; color: #fff; }
  .badge.ok { background: #2e7d32; } .badge.bad { background: #c62828; }
  .violations { border: 1px solid #c62828; background: #fdf1f1; border-radius: 8px; padding: 12px 16px; margin-top: 8px; }
  table { border-collapse: collapse; width: 100%; margin-top: 4px; }
  th, td { border: 1px solid #ececf0; padding: 8px; vertical-align: top; text-align: left; }
  th { background: #f4f4f6; font-size: 13px; width: 130px; }
  td { font-size: 13px; }
  .muted { color: #9a9aa0; }
  .sub { margin-top: 4px; font-size: 12px; color: #3a3a3c; }
  code { background: #f0f0f3; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  blockquote { margin: 4px 0; padding: 6px 10px; background: #f4f4f6; border-left: 3px solid #b9b9c0; }
  .card { border: 1px solid #e2e2e8; border-radius: 10px; padding: 12px 16px; margin-top: 12px; }
  .card-head { margin-bottom: 6px; }
  .cap { font-weight: 700; font-size: 15px; margin-right: 8px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; color: #fff; white-space: nowrap; margin-right: 6px; }
  .m-available { background: #2e7d32; } .m-partial { background: #f0b429; color: #3a2a00; } .m-blocked { background: #c62828; }
  .exe-yes { background: #1f6feb; } .exe-no { background: #6b6b70; }
  .note { margin-top: 14px; padding: 6px 10px; background: #fff8e1; border-left: 3px solid #f0b429; font-size: 13px; }
</style>
</head>
<body>
<h1>用户意图 × 能力模块（开发者草案，非模型生成、非老板核准） · ${esc(data.sampleId)}</h1>
<p class="meta">样例标题：${esc(data.title)} ｜ 校验时间：${esc(data.checkedAt)} ｜ ${badge}</p>
<p class="meta">来源说明：${esc(data.sampleSource)}</p>
${registry}

<h2>本轮语境（来自样例，不让模型编）</h2>
<table>
  <tr><th>发信人</th><td>${esc(data.context.speaker)}</td></tr>
  <tr><th>名册</th><td>${data.context.roster.map((n) => esc(n)).join("、")}</td></tr>
  <tr><th>本轮原文</th><td><blockquote>${esc(data.context.rawMessage)}</blockquote></td></tr>
</table>

<h2>逐意图映射（原话证据 · 选中能力 · 成熟度 · 允许工具 · 完成收据 · 边界 · 依据）</h2>
${cards}

${violations}
<p class="note">这是结构实验：离线确定性检查<b>只证明结构一致性</b>（字段齐全、工具名存在、blocked 无可执行工具、原话证据是原文子串），<b>不证明模型能正确拆解意图</b>，也不证明它优于现有 context，更不构成「当前能可靠做到什么」的总括结论。样例由开发者手写，未经老板核准。<b>成熟度是开发者依据已有实现与真实事故记录形成的草案，不是线上效果验证</b>；<code>available</code> 仅指当前已实现的确定性执行构件与可核验回执，不代表模型路由、编排或线上效果稳定。</p>
</body>
</html>
`;
}

// ── 4. 生成 ──
const checkedAt = new Date().toISOString();
const stamp = checkedAt.replace(/[:.]/g, "-");
mkdirSync(REPORT_DIR, { recursive: true });

let failed = 0;
for (const sample of samples) {
  const report = buildReport(sample, checkedAt);
  const baseName = `${sample.id}-expected-${stamp}`;
  const jsonPath = path.join(REPORT_DIR, `${baseName}.json`);
  const htmlPath = path.join(REPORT_DIR, `${baseName}.html`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(htmlPath, renderHtml(report), "utf8");
  console.log(
    `意图×能力期望映射：${sample.id}（${sample.title}）\n` +
      `  意图数：${report.envelope.intents.length}，确定性校验：${
        report.validation.ok
          ? "通过"
          : `失败（${report.validation.violations.length} 项）`
      }\n  JSON：${jsonPath}\n  HTML：${htmlPath}`
  );
  if (!report.validation.ok) {
    failed += 1;
    for (const violation of report.validation.violations) {
      console.error(
        `  - [${violation.intentId ? `${violation.intentId} · ` : ""}${violation.code}] ${violation.message}`
      );
    }
  }
}

if (failed > 0) {
  process.exit(1);
}
