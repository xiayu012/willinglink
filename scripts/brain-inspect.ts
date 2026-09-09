/**
 * 大脑组装与路由的检查工具。
 *
 *   pnpm brain:inspect "楼上那个人天天半夜两三点还在弄出声音"
 *   pnpm brain:inspect --full "房租可能要晚几天"     # 打印完整 system prompt
 *   pnpm brain:inspect --probes                      # 跑一遍路由探针
 *
 * 用来验证：这一轮命中了哪些情境模块、为什么命中、上下文多大。
 */

import { assembleSystemPrompt, getBrain, listBrains } from "../lib/ai/brains";

const BRAIN_ID = "coliving";

const PROBES: Array<{
  text: string;
  expect: string[];
  /** 断言不走「简单事实询问」的独占短路 */
  forbidExclusive?: boolean;
  /** 断言某模块不被加载 */
  expectNot?: string[];
}> = [
  {
    text: "楼上那个人天天半夜两三点还在弄出声音，我第二天六点就要起来上班",
    expect: ["conflict"],
  },
  { text: "这个月工时被砍了，房租可能要晚几天", expect: ["money"] },
  {
    text: "新搬来那个人天天做饭，整个屋子都是那个味，我们几个都受不了",
    expect: ["conflict"],
  },
  { text: "3号房那个欠了两个月了，明天把他门锁换了", expect: ["records"] },
  { text: "厨房水槽下面在漏水，越来越大了", expect: ["records"] },
  // 资源争抢：conflict（通用调解）+ 对应细资源模块（scheduling/cleanliness）同时加载
  {
    text: "厨房太脏了，他一直占着灶台不让人用",
    expect: ["conflict", "scheduling", "cleanliness"],
  },
  // 报修：只进 records，不把资源处置细模块拉进来
  {
    text: "厨房水槽下面在漏水",
    expect: ["records"],
    expectNot: ["scheduling", "noise", "cleanliness", "storage", "guests"],
  },
  { text: "楼上半夜还在外放看视频", expect: ["conflict", "noise"] },
  { text: "厨房垃圾都臭了也没人倒", expect: ["conflict", "cleanliness"] },
  { text: "冰箱里的东西被人吃了", expect: ["conflict", "storage"] },
  { text: "他女朋友三天两头来住", expect: ["conflict", "guests"] },
  { text: "我最近老想干脆一了百了", expect: ["complaint-risk"] },
  { text: "他上次还说要收拾我，我看他厨房那把刀", expect: ["complaint-risk"] },
  { text: "垃圾是周几倒？", expect: ["house-rules"] },
  { text: "安静时段是几点到几点？", expect: ["house-rules"] },
  // 短句金钱询问：独占短路到金钱边界，不把房屋规则整份拉进来
  { text: "房租多少钱？", expect: ["money"], expectNot: ["house-rules"] },
  // 违反房屋规则：入住/退租/违规与执行（tenancy）+ 房屋规则（house-rules）同时加载
  { text: "他违反了安静时段", expect: ["tenancy", "house-rules"], expectNot: ["scheduling"] },
  // 短问句但涉及具体某人：不该走独占短路（隐私/冲突信号，常驻层的不披露规则要生效）
  { text: "他昨天半夜几点回来的？", expect: [], forbidExclusive: true },
  { text: "你到底是房东那边的还是我们租客这边的？", expect: [] },
];

/**
 * 结构信号探针：路由规则里 `when` 条件在外部传入 signals 时才生效。
 * 既有的文本探针不带 signals，正好用来确认信号规则不误伤纯文本路由。
 */
const SIGNAL_PROBES: Array<{
  text: string;
  signals: Record<string, unknown>;
  expect: string[];
  expectNot?: string[];
}> = [
  {
    text: "你好",
    signals: { mentionsOther: true },
    expect: ["conflict"],
  },
  {
    text: "垃圾是周几倒？",
    signals: {},
    expect: ["house-rules"],
    expectNot: ["conflict"],
  },
];

function inspect(text: string, full: boolean) {
  const result = assembleSystemPrompt({ brainId: BRAIN_ID, routeOn: text });

  console.log(`\n输入：${text}`);
  console.log(`加载：${result.loadedModuleIds.join(", ") || "（无）"}`);
  for (const t of result.routing.trace) {
    console.log(`  · ${t.moduleId}${t.forced ? " [强制]" : ""} — ${t.reason}`);
  }
  console.log(`上下文：${result.chars} 字符`);

  if (full) {
    console.log("\n──────── system prompt ────────\n");
    console.log(result.system);
  }
}

function runProbes() {
  const brain = getBrain(BRAIN_ID);
  const fmt = (m: { id: string; layer: string }) => `${m.id}[${m.layer}]`;
  console.log(`大脑：${brain.title}（${brain.id}）`);
  console.log(
    `常驻 ${brain.always.length} 份（${brain.always.map(fmt).join(" → ")}，顺序即优先级）`
  );
  console.log(
    `情境 ${brain.situational.length} 份（${brain.situational.map(fmt).join("、")}），单轮上限 ${brain.maxSituational ?? 2} 份\n`
  );

  const run = (probe: {
    text: string;
    expect: string[];
    signals?: Record<string, unknown>;
    forbidExclusive?: boolean;
    expectNot?: string[];
  }): boolean => {
    const { loadedModuleIds, chars, routing } = assembleSystemPrompt({
      brainId: BRAIN_ID,
      routeOn: probe.text,
      ...(probe.signals ? { signals: probe.signals } : {}),
    });
    const wentExclusive = routing.trace.some((t) => t.reason.includes("独占"));
    const ok =
      probe.expect.every((id) => loadedModuleIds.includes(id)) &&
      !(probe.forbidExclusive && wentExclusive) &&
      !(probe.expectNot ?? []).some((id) => loadedModuleIds.includes(id));
    const mark = ok ? "✓" : "✗";
    const want = probe.forbidExclusive
      ? "（不得短路）"
      : probe.expect.length
        ? probe.expect.join("+")
        : "（任意）";
    const forbid = probe.expectNot?.length ? ` 且不含${probe.expectNot.join("+")}` : "";
    console.log(
      `${mark} ${(want + forbid).padEnd(22)} 实得 ${loadedModuleIds.join("+").padEnd(28)} ${chars} 字符  ${probe.text.slice(0, 24)}`
    );
    return ok;
  };

  let pass = 0;
  let total = 0;
  for (const probe of PROBES) {
    if (run(probe)) pass++;
    total++;
  }
  for (const probe of SIGNAL_PROBES) {
    if (run(probe)) pass++;
    total++;
  }
  console.log(`\n${pass}/${total} 通过`);
}

const args = process.argv.slice(2);

if (args.includes("--brains")) {
  for (const b of listBrains()) {
    console.log(`${b.id}\t${b.title}\t${b.description}`);
  }
} else if (args.includes("--probes") || args.length === 0) {
  runProbes();
} else {
  const full = args.includes("--full");
  const text = args.filter((a) => !a.startsWith("--")).join(" ");
  inspect(text, full);
}
