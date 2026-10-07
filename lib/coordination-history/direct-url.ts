/**
 * 变更流（`LISTEN`）该连哪个地址：**必须是直连，不能是池化地址**。
 *
 * `LISTEN` 是会话级的，挂在一条长连接上。Neon 的池化地址后面是 PgBouncer
 * （transaction 模式），它把同一条客户端连接轮流借给不同会话——`LISTEN` 要么
 * 直接报错，要么注册在一个随时会被换掉的会话上，之后再也收不到通知。
 *
 * 优先级：`POSTGRES_URL_NON_POOLING` → `DATABASE_URL_UNPOOLED` → 从
 * `POSTGRES_URL` 去掉主机名里的 `-pooler` 推出来（Neon 文档写明的命名规则）。
 * 仓库里当前没有前两个键，实际走第三条；哪天注入了，会自动接管。
 *
 * 只做字符串推导：不连库、不读 `process.env`（env 由调用方传）、不 import
 * postgres，所以能拿假数据在 Node 里直接跑（见 `direct-url.test.ts`）。
 */

export type FeedEnv = {
  POSTGRES_URL_NON_POOLING?: string | undefined;
  DATABASE_URL_UNPOOLED?: string | undefined;
  POSTGRES_URL?: string | undefined;
};

/** 解析成 URL 并确认是 postgres 协议；不是就返回 null */
function parsePostgresUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return null;
  }
  return parsed;
}

/**
 * 池化地址 → 直连地址。**只动主机名**：用户名、密码、库名、`sslmode` 之类的
 * 查询参数全部原样带走（池化与直连共用同一套凭据）。
 *
 * 只在 **Neon 主机**（`*.neon.tech`）上做这个替换。别的主机名里出现 `-pooler`
 * 只当巧合——猜错主机名会得到一个连不上的地址，而原样返回至少还连得上、
 * 只是订阅会失败并如实报错。自带 PgBouncer 的地址必须显式配前两个键。
 *
 * 返回 `null` = 不是个能用的 postgres URL，调用方按「没有地址」处理。
 */
export function toDirectUrl(url: string): string | null {
  const parsed = parsePostgresUrl(url);
  if (!parsed) {
    return null;
  }

  const host = parsed.hostname;
  if (!(host.endsWith(".neon.tech") && host.includes("-pooler."))) {
    return url;
  }

  parsed.hostname = host.replace("-pooler.", ".");
  return parsed.toString();
}

/** 按优先级挑一个直连地址；挑不出来返回 `null` */
export function resolveDirectUrl(env: FeedEnv): string | null {
  const explicit = [env.POSTGRES_URL_NON_POOLING, env.DATABASE_URL_UNPOOLED];
  for (const candidate of explicit) {
    if (candidate && parsePostgresUrl(candidate)) {
      return candidate;
    }
  }
  return env.POSTGRES_URL ? toDirectUrl(env.POSTGRES_URL) : null;
}
