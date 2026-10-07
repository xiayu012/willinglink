/**
 * 一条 `LISTEN` 的订阅生命周期：谁在听、什么时候挂上、什么时候关掉。
 *
 * 纯逻辑——客户端由外面给（`openClient`），所以这套「引用计数 + 串行 + 换代」
 * 能拿假客户端在 Node 里逐条验（见 `change-listener.test.ts`），不用真连库。
 *
 * 两条容易写错、这里专门守住的：
 *
 * · **退订要真的把连接关掉**。postgres.js 的 `ListenMeta.unlisten()` 只发一条
 *   `UNLISTEN`，**它不关 TCP**：那条连接是 `listen()` 内部另开的专用实例
 *   （源码里 `listen.sql`，`idle_timeout: null, max_lifetime: null`，本来就是
 *   打算长活的）。只 unlisten 的话，一个人都不看的时候数据库上还挂着一个空闲
 *   连接，永远不走。真要关，得对**当初调 `listen()` 的那一个实例**调 `end()`
 *   ——`end()` 里有一句 `listen.sql ? listen.sql.end(...) : []`，会把那条专用
 *   连接一起收掉。
 *
 * · **关掉之后那个实例就废了**。`end()` 是单向的（`ending` 一旦置上，之后的
 *   查询全部 reject），`listen.sql` 也不会被清空。所以关掉之后必须**丢掉**它，
 *   下一次订阅重新开一个——而「取客户端」这个动作必须在**串行队列里面**做，
 *   否则「退订（排着队）→ 新视图订阅」会抢在退订前面，拿到的正是那个马上要被
 *   关掉的实例。
 */

/** 用得上的一小撮 postgres 客户端。窄成这样是为了能在 Node 里塞个假的进来 */
export type ListenClient = {
  listen: (
    channel: string,
    onNotify: (payload: string) => void,
    onListen: () => void
  ) => Promise<unknown>;
  /** 参数签名照抄 postgres.js 的 `sql.end`（`{ timeout }` 单位是**秒**） */
  end: (options?: { timeout?: number | undefined }) => Promise<unknown>;
};

/**
 * 关连接最多等这么久（秒）。postgres.js 的 `end({ timeout })` 是**强制**的：
 * 到点直接掐掉 socket，不等服务端回话。
 *
 * 不设上限的话，库不可达时（连接断了但 socket 没收到 FIN、主机黑洞）`end()`
 * 会一直挂着——而它是在**串行队列里**被 await 的，挂住就等于之后所有订阅都排
 * 在后面不动了。宁可 3 秒后强关。
 */
const CLOSE_TIMEOUT_S = 3;

export type ChangeListener = {
  /** 登记一个回调，返回退订函数。**退订返回的 promise 落地时，连接已经关了** */
  subscribe: (onChange: () => void) => Promise<() => Promise<void>>;
};

export function createChangeListener(
  channel: string,
  openClient: () => ListenClient | null
): ChangeListener {
  /** 所有 listen / end 串成一条链，顺序不允许颠倒 */
  let ops: Promise<unknown> = Promise.resolve();
  let active: { client: ListenClient; ready: Promise<void> } | null = null;
  const listeners = new Set<() => void>();
  /** 挂上过至少一次了吗。第一次是随某个视图的连接发生的，那次由它的 `ready` 覆盖 */
  let listenedBefore = false;

  function fanout() {
    for (const listener of listeners) {
      // 一个订阅者抛错不能带走其它订阅者，也不能把 postgres.js 的 onnotify 弄炸
      try {
        listener();
      } catch (error) {
        console.error("[coordination-history] 变更回调失败", error);
      }
    }
  }

  /**
   * `listen()` 的第三个回调：挂上之后（**包括断线后 postgres.js 自己重挂**）
   * 触发。重挂意味着中间断过一段，那段的信号没人收，补一次 fanout。第一次不补
   * ——那一刻的视图刚由服务端渲染过。
   */
  function catchUp() {
    if (!listenedBefore) {
      listenedBefore = true;
      return;
    }
    fanout();
  }

  function serial<T>(op: () => Promise<T>): Promise<T> {
    const next = ops.then(op, op);
    ops = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async function closeClient(client: ListenClient) {
    try {
      // `end()` 自己幂等（内部 `if (ending) return ending`），重复调也无所谓；
      // 但**必须带 timeout**——它是在串行队列里 await 的，库不可达时无上限地挂
      // 会把后面所有订阅一起堵死
      await client.end({ timeout: CLOSE_TIMEOUT_S });
    } catch {
      // 已经关了，或者本来就没连上。没有需要善后的状态
    }
  }

  function acquire(): Promise<void> {
    if (active) {
      return active.ready;
    }

    // **在队列里面取客户端**：排队等这一条的时候，前一个实例可能刚被 end 掉
    const client = openClient();
    if (!client) {
      return Promise.reject(new Error("没有可用的直连数据库地址，变更流无法订阅"));
    }

    const entry: { client: ListenClient; ready: Promise<void> } = {
      client,
      ready: Promise.resolve(),
    };

    entry.ready = (async () => {
      try {
        await client.listen(channel, fanout, catchUp);
      } catch (error) {
        // 没挂上：这次开出来的实例也一并收掉（可能是半开的连接，留着下次也不会
        // 变好）。只有当这一条仍是最新的尝试时才清——迟到的失败不许把后来者
        // 建立的订阅状态抹掉
        if (active === entry) {
          active = null;
          await closeClient(client);
        }
        throw error;
      }
    })();

    active = entry;
    return entry.ready;
  }

  async function release(): Promise<void> {
    const entry = active;
    if (!entry) {
      return;
    }
    // 排队等这一条的时候可能又有视图连上来了，那就别关
    if (listeners.size > 0) {
      return;
    }

    // 先让位：新视图可以立刻开始 acquire，它排在这一条后面，顺序仍然是对的
    active = null;
    listenedBefore = false;
    await entry.ready.catch(() => undefined);
    await closeClient(entry.client);
  }

  return {
    async subscribe(onChange: () => void) {
      listeners.add(onChange);

      try {
        await serial(acquire);
      } catch (error) {
        listeners.delete(onChange);
        throw error;
      }

      let released = false;
      return () => {
        if (released) {
          return Promise.resolve();
        }
        released = true;
        listeners.delete(onChange);
        if (listeners.size > 0) {
          return Promise.resolve();
        }
        return serial(release).catch(() => undefined);
      };
    },
  };
}
