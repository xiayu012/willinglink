/**
 * **逐动作协调计划 CLI 的参数判定（纯函数，评测专用）。**
 *
 * 为什么不写在 `scripts/coliving-action-plan.ts` 里：那个脚本顶层直接跑 `main()`，
 * import 它就会执行整个 CLI；把这段纯逻辑放这里，CLI 与
 * `scripts/coliving-quality-inspect.ts` 共用同一实现，测的就是真正在跑的函数。
 *
 * 关键在于字面量 `--`：标准用法
 * `pnpm coliving:action-plan -- --sample <id>` 里的 `--` 是 pnpm 透传下来的参数
 * 分隔符，**不是**未知参数，必须忽略；真正的未知 flag 仍要拦下并报错。
 */

/** 支持的 flag：`--sample <id>` 只生成指定样例，否则生成全部样例。 */
export const ACTION_PLAN_SUPPORTED_FLAGS = ["--sample"] as const;

/**
 * 从完整 `argv`（含 node 与脚本路径两个前导元素）里挑出**真正未知的** flag。
 * - `--` 是参数分隔符，不算未知；
 * - 已知 flag 不算未知；
 * - 其余以 `--` 开头的都算未知。
 */
export function findUnknownActionPlanFlags(argv: readonly string[]): string[] {
  const supported = new Set<string>(ACTION_PLAN_SUPPORTED_FLAGS);
  return argv
    .slice(2)
    .filter((arg) => arg.startsWith("--") && arg !== "--" && !supported.has(arg));
}
