import "server-only";

import postgres from "postgres";

import { createChangeListener } from "./change-listener";
import { resolveDirectUrl } from "./direct-url";

/**
 * 「协调历史」的变更源：一条 `LISTEN`，谁想听谁登记一个回调。生命周期（引用
 * 计数、串行、关连接）在 `change-listener.ts`，这里只负责「用真的 postgres
 * 客户端连哪儿」。
 *
 * 为什么不是进程内 pubsub：页面同时活在好几个 Vercel 实例上，写库的（收短信的
 * Twilio 回调）还可能是另一个实例，内存里的 EventEmitter 只通知得到自己那一个。
 * 所以信号必须从**数据库**发出来。
 *
 * 通道上跑的是纯信号（触发器 `pg_notify(通道, '1')`）：没有房号、人名、正文。
 *
 * **不缓存客户端**：`listen()` 内部会另开一条专用连接（`listen.sql`），而关掉它
 * 的唯一办法是对调过 `listen()` 的那个实例调 `end()`——`end()` 是单向的，关过
 * 之后那个实例的查询全部 reject。所以每个订阅会话现开一个：postgres.js 的实例
 * 不连库（连接是懒的），真正的连接在 `listen()` 时才建，这里不花额外代价。
 */

/** 通道名。**改这里必须同时改 `coliving-world-20.sql` 里的 `pg_notify`** */
export const CHANGE_CHANNEL = "coordination_history_change";

const listener = createChangeListener(CHANGE_CHANNEL, () => {
  // 逐个点名要用的键，不整个 `process.env` 传进去：`ProcessEnv` 是一堆可选
  // 索引签名，跟 `FeedEnv` 没有共同属性，整体传在类型上就是「这俩不是一回事」
  const url = resolveDirectUrl({
    POSTGRES_URL_NON_POOLING: process.env.POSTGRES_URL_NON_POOLING,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    POSTGRES_URL: process.env.POSTGRES_URL,
  });
  if (!url) {
    return null;
  }
  return postgres(url, { max: 1, connect_timeout: 10 });
});

/**
 * 登记一个「库里有动静」的回调，返回退订函数。
 *
 * **第一次调用才会真的连库**，所以导入这个模块不产生连接。连不上（没地址、主机
 * 不通、池化地址被拒）时**抛**，调用方据此走降级：不发 `ready`，让浏览器慢慢
 * 重试，而不是假装订阅成功。
 */
export function subscribeToChanges(
  onChange: () => void
): Promise<() => Promise<void>> {
  return listener.subscribe(onChange);
}
