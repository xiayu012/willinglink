import { subscribeToChanges } from "@/lib/coordination-history/change-feed";
// 事件名从客户端那份拿：**协议名只准有一处字面量**，两边各写一份迟早漂移成
// 一个发 `change`、一个听 `changed`。那个模块不碰服务器专有的东西
// （`EventSource` 只在默认工厂里懒引用），引进来是安全的
import {
  LIVE_CHANGE_EVENT,
  LIVE_READY_EVENT,
} from "@/lib/coordination-history/live-updates";

/**
 * `/coordination-history` 的变更流（SSE）。页面挂一个 `EventSource`，库里一有
 * 动静就把那页重读一遍，不用等下一次轮询。
 *
 * 跟那一页一样**没有鉴权**（靠 URL 分享给合作方看）——`proxy.ts` 里
 * `/api/coordination-history/` 那条放行本来就盖到这里，没有新增放行。
 *
 * 推的是「有动静」，不是「什么动静」：事件体是常量 `1`，没有房号、没有人名、
 * 没有正文、没有电话号码。谁改了什么，前端自己去请求那一页，过滤照旧在服务端。
 *
 * 两种收摊必须分得开：
 *   · **轮换**：`ROTATE_MS` 到点主动关（Vercel 函数有最长执行时间，与其被平台
 *     从中间掐断，不如自己先关）。浏览器按 `retry: 1000` 立刻接上，新连接照例
 *     发 `ready`，客户端据此把断开那几十毫秒里漏掉的信号补回来。
 *   · **源坏了**：`LISTEN` 根本挂不上（地址是池化的、主机不通、没配直连）。这条
 *     **不发 `ready`**，只回 `retry: 30000` 然后关。
 *
 * 客户端只在**收到过 `ready`** 的连接上补刷，所以「源坏了」那条重试循环里一次都
 * 不会去重读页面——那就变回轮询了，正是这次要拆掉的东西。宁可让页面停在旧数据
 * 上，也不要偷偷用 30 秒的节奏假装实时。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const preferredRegion = "sfo1";

/** 正常轮换后的重连间隔。断开只有几十毫秒，重连要快 */
const RETRY_OK_MS = 1_000;
/** 订阅挂不上时的**重连**间隔（不是重读页面的间隔） */
const RETRY_DOWN_MS = 30_000;
/** 心跳。注释行，浏览器不派发给页面，只为让中间代理别掐掉空闲连接 */
const HEARTBEAT_MS = 15_000;
/** 主动轮换时刻。**必须明显小于 `maxDuration`**，留出收尾余量 */
const ROTATE_MS = 240_000;

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  let closed = false;
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
  let unsubscribe: (() => Promise<void>) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let rotate: ReturnType<typeof setTimeout> | null = null;

  /**
   * 只收一次。四条路都走到这：轮换到点、浏览器断开（`cancel`）、请求中止
   * （`abort`）、写流失败。幂等是必须的——一个人点两次关闭不能退订两次。
   */
  function teardown() {
    if (closed) {
      return;
    }
    closed = true;

    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (rotate) {
      clearTimeout(rotate);
    }
    heartbeat = null;
    rotate = null;

    request.signal.removeEventListener("abort", teardown);
    // 退订要等它落地才是真的把数据库那条连接关掉；这一条流已经无所谓了，
    // 所以不 await（阻塞收摊只会把响应拖住）
    void unsubscribe?.();
    unsubscribe = null;

    try {
      sink?.close();
    } catch {
      // 控制器可能已经关了
    }
  }

  function send(chunk: string) {
    if (closed || !sink) {
      return;
    }
    try {
      sink.enqueue(encoder.encode(chunk));
    } catch {
      // 写不进去 = 这条流已经废了（浏览器走了、控制器关了）。当场收摊，
      // 别留着订阅和定时器空转
      teardown();
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      sink = controller;

      // 还没开始就已经中止（浏览器在响应头回来之前就关了）
      if (request.signal.aborted) {
        teardown();
        return;
      }
      request.signal.addEventListener("abort", teardown);

      let off: (() => Promise<void>) | null = null;
      try {
        off = await subscribeToChanges(() => {
          send(`event: ${LIVE_CHANGE_EVENT}\ndata: 1\n\n`);
        });
      } catch (error) {
        console.error("[coordination-history] 变更流订阅失败，转重连", error);
        send(`retry: ${RETRY_DOWN_MS}\n\n`);
        teardown();
        return;
      }

      // 订阅是异步挂上的，这中间浏览器可能已经走了 / 已经被中止 / 已经轮换。
      // 那样 `teardown` 早就跑过了（当时 `unsubscribe` 还是 null，退订不掉），
      // 所以这里必须**当场退订并返回**，否则留下一个没有任何视图在听的订阅，
      // 它会把引用计数一直撑住
      if (closed) {
        void off();
        return;
      }
      unsubscribe = off;

      // 订阅成功之后才认这条流是活的：`ready` 是给客户端看的「现在开始，
      // 漏掉的信号要自己补」的信号
      send(`retry: ${RETRY_OK_MS}\n\n`);
      send(`event: ${LIVE_READY_EVENT}\ndata: 1\n\n`);

      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      rotate = setTimeout(teardown, ROTATE_MS);
    },
    cancel() {
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // 变更流不能缓存、不能压缩：压缩要攒缓冲区，攒着就等于不发
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
