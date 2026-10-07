/**
 * 「协调历史」页的后台自动刷新：什么时候该刷、什么时候该停。
 *
 * 拆出来是因为这套时序是纯逻辑——假时钟就能在毫秒内跑完「切后台五分钟再回来」
 * 「断网又恢复」，不用真等 30 秒，也不用去切浏览器标签页试。这里不碰 DOM、
 * 不碰 React：浏览器状态由 `readSignals` 读进来，时钟和定时器可以注入。
 *
 * 两条已知限制，不假装解决：
 *   · `router.refresh()` 返回 void，**拿不到成败**，所以记的是「最后一次发起」，
 *     不是「最后一次成功」——库挂了就是每 30 秒问一次，没有退避；
 *   · 上一次刷新还在路上时不发第二次（`isBusy`）。某次刷新要是永远不返回，
 *     就再也不补刷了：那时页面本来就已经停在旧数据上，叠加请求只会更糟。
 */

/**
 * 间隔。一次刷新 = 服务端把整页重读一遍（三条查询，消息那条要对全表开窗），
 * 比调一个接口贵；但这一页是有人盯着的窗口，太慢就白做了。切走的标签页不花钱。
 */
export const AUTO_REFRESH_INTERVAL_MS = 30_000;

/** 定时器句柄。浏览器里 `setTimeout` 返回的就是 number */
export type AutoRefreshTimerHandle = number;

/**
 * `online` 只是浏览器自己的说法（`navigator.onLine`），是**省流量的提示**，
 * 不是网络真的通；它只用来「少刷」，不参与任何正确性判断。
 */
export type AutoRefreshSignals = {
  /** `document.visibilityState === "visible"` */
  visible: boolean;
  /** `navigator.onLine` */
  online: boolean;
};

export type AutoRefreshOptions = {
  /** 真正发起一次刷新。页面里是 `startTransition(() => router.refresh())` */
  refresh: () => void;
  /** 读当前可见/在线状态。默认读真的 document / navigator；注入是为了测试 */
  readSignals?: () => AutoRefreshSignals;
  /** 上一次刷新还在路上吗。为真就不发第二次 */
  isBusy?: () => boolean;
  /** 现在几点。默认 `Date.now` */
  now?: () => number;
  /** 排一个定时器。默认 `window.setTimeout` */
  setTimer?: (fn: () => void, ms: number) => AutoRefreshTimerHandle;
  /** 清一个定时器。默认 `window.clearTimeout` */
  clearTimer?: (handle: AutoRefreshTimerHandle) => void;
  /** 间隔。默认 `AUTO_REFRESH_INTERVAL_MS` */
  intervalMs?: number;
};

export type AutoRefreshController = {
  /** 挂载时调一次。**重复调用不会叠出第二个定时器**（React 严格模式会挂载→卸载→再挂载） */
  start: () => void;
  /** 卸载时调。之后信号再来也不刷 */
  stop: () => void;
  /**
   * 可见性 / 在线状态可能变了：重新读一遍信号，该补刷就补刷，该停表就停表。
   * `visibilitychange` / `focus` / `online` / `offline` 四个事件全接这一个入口。
   */
  sync: () => void;
};

export function createAutoRefresh(
  options: AutoRefreshOptions
): AutoRefreshController {
  // 读不到 document / navigator（SSR、怪环境）时**默认放行**：当成「不可见 /
  // 离线」的话，那种环境就永远不刷新了
  const read =
    options.readSignals ??
    (() => ({
      visible:
        typeof document === "undefined" ||
        document.visibilityState === "visible",
      online: typeof navigator === "undefined" || navigator.onLine,
    }));
  const busy = options.isBusy ?? (() => false);
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: number) => window.clearTimeout(handle));
  const intervalMs = options.intervalMs ?? AUTO_REFRESH_INTERVAL_MS;

  let started = false;
  /** 最后一次**发起**刷新的时刻。`null` = 还没刷过 */
  let lastRefreshAt: number | null = null;
  /** 手上活着的定时器；`null` = 没有 */
  let timer: AutoRefreshTimerHandle | null = null;

  function clear() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  /** 挂载、到点、切前后台、聚焦、断网、恢复——六件事走的都是这一条 */
  function sync() {
    if (!started) {
      return;
    }

    // **信号每次现读**，不缓存挂载时那份：手机后台标签页会被冻住，冻结期间
    // online/offline 事件可能压根没送达，醒过来时手上那份状态已经过期了
    const { visible, online } = read();
    if (!(visible && online)) {
      clear();
      return;
    }

    // 数据旧过一个完整间隔就立刻补一次：刚回前台、刚恢复网络时，不该让人干等
    // 下一轮。刷新还在路上（busy）就不叠第二次
    const stale = lastRefreshAt === null || now() - lastRefreshAt >= intervalMs;
    if (stale && !busy()) {
      lastRefreshAt = now();
      options.refresh();
      clear();
    }

    // 重排的判据是「手上有没有活着的定时器」，不是「刚才刷没刷」。**每次信号都
    // 无脑重排的话，倒计时会被一次次拨回原点**：focus 比间隔密就永远走不到，
    // 自动刷新会静悄悄地不工作
    if (timer === null) {
      // 回调里先把句柄交还再走同一条判断：到点和来信号走同一条路，不会对不上
      timer = setTimer(() => {
        timer = null;
        sync();
      }, intervalMs);
    }
  }

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      // 挂载这一刻服务端刚渲染过，数据是新的：记下这个时刻，别一进来又刷一次
      lastRefreshAt = now();
      sync();
    },
    stop() {
      started = false;
      clear();
    },
    sync,
  };
}
