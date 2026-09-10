/**
 * **人工标准隐私卡 CLI 的参数判定（纯函数，评测专用）。**
 *
 * 为什么不写在 `scripts/coliving-privacy-card.ts` 里：那个脚本顶层直接跑
 * `main()`，import 它就会执行整个 CLI，免费质量检查没法只测参数解析。把这段
 * 纯逻辑放这里，CLI 与 `scripts/coliving-quality-inspect.ts` 共用同一实现，
 * 测的就是真正在跑的那个函数。
 *
 * 关键在于字面量 `--`：标准用法
 * `pnpm coliving:privacy-card -- --scenario <id>` 里的 `--` 是 pnpm 透传下来的
 * 参数分隔符，**不是**未知参数，必须忽略；但 `--turn` / `--model` 这类真正
 * 未知的 flag 仍要拦下并报错。
 */

/** 首版唯一支持的 flag（标准卡从场景文件读取，不需要 --turn/--model）。 */
export const PRIVACY_CARD_SUPPORTED_FLAGS = ["--scenario"] as const;

/**
 * 从完整 `argv`（含 node 与脚本路径两个前导元素）里挑出**真正未知**的 flag。
 *
 * - `--` 是参数分隔符，不算未知；
 * - 已知 flag 不算未知；
 * - 其余以 `--` 开头的都算未知。
 *
 * 返回值保持原顺序，供 CLI 拼进同一条报错。
 */
export function findUnknownPrivacyCardFlags(
  argv: readonly string[]
): string[] {
  const supported = new Set<string>(PRIVACY_CARD_SUPPORTED_FLAGS);
  return argv
    .slice(2)
    .filter((arg) => arg.startsWith("--") && arg !== "--" && !supported.has(arg));
}
