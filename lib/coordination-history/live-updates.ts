/**
 * 「协调历史」页跟着库里的动静自己更新——**不是定时轮询**。
 *
 * 浏览器挂一条 `EventSource` 到 `LIVE_FEED_URL`，服务器用 Postgres 的
 * `LISTEN/NOTIFY` 盯着库（见 `change-feed.ts`），谁写消息就推一个纯信号过来；
 * 这里收到就把页面重读一遍（`router.refresh()`，不换路由、不丢选中的房子和
 * 筛选）。一条短信进来，对面几乎同时就能看见。
 *
 * 独立成模块是因为这套时序是纯逻辑：假流 + 假调度器就能在毫秒内跑完「切后台
 * 五分钟再回来」「源坏了反复重连」。这里不碰 DOM、不碰 React。
 *
 * 四条容易写错、这里专门守住的：
 *   · **一次信号只换一次重读**。`router.refresh()` 可能跑好几秒；同一批到达的
 *     信号先合并成一次，跑在路上的那些只记一个 `dirty`，等这一轮落地（页面在
 *     `isPending` 变假时调 `sync()`）再补一次。信号一个不丢，也不叠发。
 *   · **`ready` 就补刷**。收到 `ready` = 服务器那边 LISTEN 挂上了。这中间隔着
 *     一次连接（服务端渲染 → 建立订阅，或断开后的重连），中间发生的改动没人
 *     看见，所以**每次成功连上都重读一次**。
 *   · **源坏了不刷**。订阅挂不上时服务器不发 `ready`，所以「连不上 → 30 秒重试」
 *     那条循环里一次都不会去重读页面。宁可停在旧数据上，也不偷偷退回轮询。
 *   · **关掉的流不再算数**。每条流有自己的代号，`close()` 之后它再冒出来的回调
 *     一律不认——浏览器对已经 `close()` 的 EventSource 仍可能派发队列里的事件。
 */

/** SSE 事件名。**与 `app/api/coordination-history/events/route.ts` 是同一份**
 * （路由直接 import 这两个常量，不允许两边各写一份字面量） */
export const LIVE_CHANGE_EVENT = "change";
export const LIVE_READY_EVENT = "ready";

/** 变更流地址。页面用它，测试哨兵也拿它对源码 */
export const LIVE_FEED_URL = "/api/coordination-history/events";

/** 用得上的一小撮 `EventSource`。窄成这样是为了能在 Node 里塞个假的进来 */
export type LiveStream = {
  addEventListener: (type: string, listener: () => void) => void;
  close: () => void;
};

export type LiveSignals = {
  /** `document.visibilityState === "visible"` */
  visible: boolean;
  /** `navigator.onLine` */
  online: boolean;
};

export type LiveUpdatesOptions = {
  /** 变更流地址。页面里是 `LIVE_FEED_URL` */
  url: string;
  /** 真正发起一次重读。页面里是 `startTransition(() => router.refresh())` */
  refresh: () => void;
  /** 上一次重读还在路上吗。为真时只记 `dirty`，不叠发 */
  isBusy?: () => boolean;
  /** 读当前可见/在线状态。默认读真的 document / navigator；注入是为了测试 */
  readSignals?: () => LiveSignals;
  /** 造一条流。默认 `new EventSource(url)`；注入是为了测试 */
  openStream?: (url: string) => LiveStream;
  /** 把合并后的那一次重读排到当前这批事件之后。默认 `queueMicrotask` */
  schedule?: (fn: () => void) => void;
};

export type LiveUpdatesController = {
  /** 挂载时调一次。**重复调用不会开出第二条流**（严格模式会挂载→卸载→再挂载） */
  start: () => void;
  /** 卸载时调。之后信号再来也不开流、不刷新 */
  stop: () => void;
  /**
   * 重新看一眼世界：可见 + 在线就该有流，否则把流关掉；顺手把欠着的重读补上。
   * `visibilitychange` / `focus` / `online` / `offline`，以及页面里「这一轮
   * 重读落地了」那一下，走的都是这一个入口。
   */
  sync: () => void;
};

export function createLiveUpdates(
  options: LiveUpdatesOptions
): LiveUpdatesController {
  // 读不到 document / navigator（SSR、怪环境）时默认放行：当成「不可见/离线」
  // 的话，那种环境就永远不订阅了
  const read =
    options.readSignals ??
    (() => ({
      visible:
        typeof document === "undefined" ||
        document.visibilityState === "visible",
      online: typeof navigator === "undefined" || navigator.onLine,
    }));
  const busy = options.isBusy ?? (() => false);
  const openStream =
    options.openStream ?? ((url: string): LiveStream => new EventSource(url));
  const schedule = options.schedule ?? ((fn: () => void) => queueMicrotask(fn));

  let started = false;
  let stream: LiveStream | null = null;
  /** 流的代号。开一条、关一条都 +1，旧代号上的回调从此不作数 */
  let generation = 0;
  /** 欠着一次重读。落地后补，不丢 */
  let dirty = false;
  /** 已经排了一次合并重读，同一批里不重复排 */
  let scheduled = false;

  /** 欠着的重读，能发就发。**唯一**调 `options.refresh` 的地方 */
  function flush() {
    if (!(started && dirty) || busy()) {
      return;
    }
    // 现读一次：排队等这一小会儿里可能已经切后台 / 断网了，那就先别刷，
    // `dirty` 留着，等 `sync()` 回来再补
    const { visible, online } = read();
    if (!(visible && online)) {
      return;
    }
    dirty = false;
    options.refresh();
  }

  /** 把重读推到当前这批事件之后：一批信号只换一次重读 */
  function scheduleFlush() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    schedule(() => {
      scheduled = false;
      flush();
    });
  }

  function closeStream() {
    generation += 1;
    if (stream) {
      stream.close();
      stream = null;
    }
  }

  function openStreamIfNeeded() {
    if (stream) {
      return;
    }
    const mine = (generation += 1);
    const es = openStream(options.url);
    const onSignal = () => {
      // 已经关掉的那条流，浏览器仍可能把排队的事件派发出来——不作数
      if (!(started && mine === generation && stream === es)) {
        return;
      }
      dirty = true;
      scheduleFlush();
    };

    es.addEventListener(LIVE_READY_EVENT, onSignal);
    es.addEventListener(LIVE_CHANGE_EVENT, onSignal);
    // `error` 不处理：EventSource 自己会按服务器给的 retry 重连，这里插一脚
    // 只会把它的退避搅乱
    stream = es;
  }

  function sync() {
    if (!started) {
      return;
    }

    // 信号**每次现读**，不缓存：手机后台标签页会被冻住，冻结期间 online/offline
    // 事件可能压根没送达，醒过来时手上那份已经过期了
    const { visible, online } = read();
    if (visible && online) {
      openStreamIfNeeded();
    } else {
      // 后台/离线：连接都不留。留着的唯一作用是让服务器多一个订阅者，
      // 而人在看的那个页面根本没在看
      closeStream();
    }

    scheduleFlush();
  }

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      sync();
    },
    stop() {
      started = false;
      dirty = false;
      closeStream();
    },
    sync,
  };
}
