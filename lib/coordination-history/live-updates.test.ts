/**
 * 变更流客户端（`live-updates.ts`）的**确定性反例**：纯 Node 单测，不起浏览器、
 * 不连库、不调模型、不发短信。流和调度器都是假的，所以「切后台五分钟再回来」
 * 「源坏了重连五次」在毫秒内跑完。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination-history/live-updates.test.ts`
 *
 * 每条都对着一个真会咬人的反例，不是把实现抄一遍：一批信号叠发好几次重读、
 * 重读没回来就再发、切后台还在刷、关掉的流还在派发事件、**源连不上时偷偷退回
 * 30 秒轮询**。
 *
 * 页面长什么样、真连上 Postgres 之后到底推不推得过来，这里证明不了——那要开
 * `/coordination-history` 用真的 `pg_notify` 试。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createLiveUpdates,
  LIVE_CHANGE_EVENT,
  LIVE_FEED_URL,
  LIVE_READY_EVENT,
} from "./live-updates";

/**
 * 假流。`emit` **不看 `closed`**：真的 `EventSource` 在 `close()` 之后仍可能把
 * 已经排进队列的事件派发出来，那正是要挡的情况。
 */
function createFakeStream() {
  const listeners = new Map<string, Array<() => void>>();
  let closed = false;

  return {
    addEventListener(type: string, fn: () => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    close() {
      closed = true;
    },
    get closed() {
      return closed;
    },
    emit(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) {
        fn();
      }
    },
    listenerCount: () =>
      [...listeners.values()].reduce((total, list) => total + list.length, 0),
  };
}

type FakeStream = ReturnType<typeof createFakeStream>;

/** 假调度器：排进去的回调只在 `drain()` 时跑，等于把 microtask 队列拿在手上 */
function createFakeWorld() {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => {
      queue.push(fn);
    },
    pending: () => queue.length,
    /** 排空（模拟这一批事件之后的 microtask 全部跑完） */
    drain() {
      let guard = 0;
      while (queue.length > 0) {
        guard += 1;
        assert.ok(guard < 100, "调度器没收敛：重读自己又排了一次");
        queue.shift()?.();
      }
    },
  };
}

function createHarness(initial: { visible: boolean; online: boolean }) {
  const world = createFakeWorld();
  /** 外面的世界。测试直接改它，模拟可见性 / `navigator.onLine` 在控件之外变化 */
  const signals = { ...initial };
  const state = { busy: false };
  const streams: FakeStream[] = [];
  let refreshes = 0;

  const controller = createLiveUpdates({
    url: LIVE_FEED_URL,
    refresh: () => {
      refreshes += 1;
    },
    isBusy: () => state.busy,
    readSignals: () => ({ ...signals }),
    openStream: () => {
      const stream = createFakeStream();
      streams.push(stream);
      return stream;
    },
    schedule: world.schedule,
  });

  return {
    controller,
    signals,
    world,
    /** 当前（最后开出来的）那条流 */
    get stream(): FakeStream {
      const last = streams[streams.length - 1];
      assert.ok(last, "还没开过流");
      return last;
    },
    openCount: () => streams.length,
    get refreshes() {
      return refreshes;
    },
    setVisible(visible: boolean) {
      signals.visible = visible;
      controller.sync();
    },
    setOnline(online: boolean) {
      signals.online = online;
      controller.sync();
    },
    setBusy(busy: boolean) {
      state.busy = busy;
    },
    /** 页面里 `isPending` 变假那一下 */
    settle() {
      controller.sync();
    },
    /** 一整轮：事件 → 排空 → 落地 */
    tick() {
      world.drain();
    },
  };
}

function main() {
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  // ── ① 挂载：连上，但不重读 ──────────────────────────────────────────────
  check("挂载就连一条流，但一个信号都没有时不重读", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.tick();

    assert.equal(h.openCount(), 1);
    assert.equal(h.refreshes, 0, "服务端刚渲染过，不该马上再读一遍");
  });

  // ── ② 连上就补刷（第一次也算：SSR 到订阅之间也可能有改动）──────────────
  check("收到 ready 就重读一次——第一次也算，中间隔着一次连接", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.tick();

    h.stream.emit(LIVE_READY_EVENT);
    h.tick();
    assert.equal(h.refreshes, 1);

    // 每 4 分钟的主动轮换：新连接又发一次 ready
    h.stream.emit(LIVE_READY_EVENT);
    h.tick();
    assert.equal(h.refreshes, 2, "轮换后要补上断开那几十毫秒里的信号");
  });

  // ── ③ 一批信号合并成一次重读 ────────────────────────────────────────────
  check("一批信号只换一次重读，不是每个信号一次", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.tick();

    h.stream.emit(LIVE_CHANGE_EVENT);
    h.stream.emit(LIVE_CHANGE_EVENT);
    h.stream.emit(LIVE_CHANGE_EVENT);
    assert.equal(h.refreshes, 0, "还没排到，一个都还没发出去");
    assert.equal(h.world.pending(), 1, "三个信号只排了一次");

    h.tick();
    assert.equal(h.refreshes, 1, "合并成一次");
  });

  // ── ④ 重读没回来时不叠发，落地后补一次 ──────────────────────────────────
  check("重读在路上时只记待办，落地后补一次（信号一个不丢）", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.tick();

    // 第一次重读发出去了，还在路上（isPending 为真）
    h.stream.emit(LIVE_CHANGE_EVENT);
    h.tick();
    assert.equal(h.refreshes, 1);
    h.setBusy(true);

    // 路上又来三个信号：**一次都不能叠发**
    h.stream.emit(LIVE_CHANGE_EVENT);
    h.stream.emit(LIVE_CHANGE_EVENT);
    h.tick();
    h.stream.emit(LIVE_CHANGE_EVENT);
    h.tick();
    assert.equal(h.refreshes, 1, "没回来就不该再发");

    // 落地：只补一次，不是三次
    h.setBusy(false);
    h.settle();
    h.tick();
    assert.equal(h.refreshes, 2, "补一次就够，攒了几个信号不重要");
  });

  // ── ⑤ 切后台：当场把连接停掉 ────────────────────────────────────────────
  check("切后台当场关掉连接，之后不再占用（后台标签页一分钱不花）", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.tick();

    h.setVisible(false);
    assert.equal(h.stream.closed, true, "后台就该关连接，不是留着收");
    assert.equal(h.openCount(), 1);

    h.tick();
    assert.equal(h.refreshes, 0);
  });

  // ── ⑥ 关掉的流再冒出来的事件不作数 ──────────────────────────────────────
  check("已经关掉的流仍可能派发事件——一律不认", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.tick();

    const stale = h.stream;
    h.setVisible(false);

    stale.emit(LIVE_CHANGE_EVENT);
    stale.emit(LIVE_READY_EVENT);
    h.tick();
    assert.equal(h.refreshes, 0, "关掉的流上的事件是陈的，不能拿它去重读");
  });

  // ── ⑦ 回前台：不叠流，并补上断开期间的改动 ──────────────────────────────
  check("反复的信号不叠出第二条流；回前台重连并补刷", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.tick();

    h.setVisible(false);
    h.setVisible(false);
    h.setVisible(false);
    assert.equal(h.openCount(), 1, "叠了的话这里就是 4 条并存的连接");

    h.setVisible(true);
    assert.equal(h.openCount(), 2);
    assert.equal(h.stream.closed, false);

    h.stream.emit(LIVE_READY_EVENT);
    h.tick();
    assert.equal(h.refreshes, 1, "断开那段的改动靠这次 ready 补回来");
  });

  // ── ⑧ 断网 = 停连接；恢复就重连并补刷 ───────────────────────────────────
  check("离线关连接；网络回来重连，ready 到了补一次", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.tick();

    h.setOnline(false);
    assert.equal(h.stream.closed, true, "断网了还挂着连接没有意义");

    h.setOnline(true);
    assert.equal(h.openCount(), 2);
    h.stream.emit(LIVE_READY_EVENT);
    h.tick();
    assert.equal(h.refreshes, 1);
  });

  // ── ⑨ 源坏了：一次都不能重读（这是「不许偷偷变回轮询」那条线）──────────
  check("源连不上时的重连循环里，一次都不重读页面", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.tick();
    assert.equal(h.refreshes, 0);

    // 服务器订阅不上：只回 `retry: 30000` 然后关，**从不发 ready**。
    // 每次切后台再回来 = 一次真实的重新连接
    for (let i = 0; i < 5; i += 1) {
      h.setVisible(false);
      h.setVisible(true);
      h.tick();
    }

    assert.equal(h.openCount(), 6, "确实重连了五次");
    assert.equal(
      h.refreshes,
      0,
      "没有 ready 就一次都不重读——否则 30 秒重连就等于 30 秒轮询"
    );
  });

  // ── ⑩ 信号现读：冻住的标签页错过 online 事件也能恢复 ────────────────────
  check("信号现读：冻结期间错过 online 事件，回前台照样连上", () => {
    const h = createHarness({ visible: false, online: false });
    h.controller.start();
    assert.equal(h.openCount(), 0, "一进来就在后台，不该连");

    // 标签页被浏览器冻住：外面网络其实已经恢复，但 online 事件没送达
    h.signals.online = true;
    h.tick();
    assert.equal(h.openCount(), 0, "还看不见，不连");

    h.setVisible(true);
    assert.equal(h.openCount(), 1, "读缓存的那份状态会以为自己一直离线");
  });

  // ── ⑪ 切后台那一刻欠着的重读不丢 ────────────────────────────────────────
  check("信号到了但还没排到就切后台：不刷，但欠的账回前台补上", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.tick();

    h.stream.emit(LIVE_CHANGE_EVENT);
    // 直接改状态，不调 sync：模拟「刚排上队、还没执行就切走了」
    h.signals.visible = false;
    h.tick();
    assert.equal(h.refreshes, 0, "已经切后台了就别刷");

    h.setVisible(true);
    h.tick();
    assert.equal(h.refreshes, 1, "欠的那次回到前台补上，不是丢掉");
  });

  // ── ⑫ stop 之后真的停了 ────────────────────────────────────────────────
  check("stop() 之后信号不再开新流、也不重读（组件卸载了就是真的停了）", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.tick();

    const stale = h.stream;
    h.controller.stop();
    assert.equal(stale.closed, true);

    stale.emit(LIVE_CHANGE_EVENT);
    h.setVisible(false);
    h.setVisible(true);
    h.tick();

    assert.equal(h.refreshes, 0);
    assert.equal(h.openCount(), 1, "卸载之后不该再开连接");
  });

  // ── ⑬ 接线哨兵：三个文件里那几处关键写法 ────────────────────────────────
  // 这些是**跨文件的约定**，单测跑不到它们，只能对着源码认。每一条都对应一个
  // 已经踩过或差点踩到的坑，不是格式检查。
  const read = (path: string) =>
    readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const flat = (path: string) => read(path).replace(/\s+/g, " ");

  check("页面接线：接上控制器、现读信号、挡叠发、落地补刷、卸载停连", () => {
    const src = read("app/coordination-history/history-canvas.tsx");

    assert.ok(src.includes("createLiveUpdates("), "页面没接上实时更新控制器");
    assert.ok(
      src.includes("url: LIVE_FEED_URL"),
      "地址要走常量，别在页面里手写一份路径"
    );
    assert.ok(
      src.includes("isBusy: () => refreshingRef.current"),
      "没有挡叠发：一次重读比信号间隔久时就会越叠越多"
    );
    assert.ok(
      src.includes("useTransition()"),
      "挡叠发靠 useTransition 的 isPending，没有它就等于没挡"
    );
    assert.ok(
      src.includes('document.addEventListener("visibilitychange", onSignal)'),
      "切前后台的信号要接上——不接就不是「只在看着的时候连」"
    );
    assert.ok(
      src.includes('window.addEventListener("offline", onSignal)'),
      "断网要接上，否则断着网还挂着连接"
    );
    assert.ok(
      src.includes("online: navigator.onLine"),
      "在线状态要现读 navigator.onLine——读缓存那份会漏掉冻结期间错过的事件"
    );
    assert.ok(
      src.includes("controller.stop()") && src.includes("liveRef.current = null"),
      "卸载要停连接；控制器别留在 ref 里"
    );
    assert.ok(
      /if \(!refreshing\) \{\s*\n\s*liveRef\.current\?\.sync\(\);/.test(src),
      "这一轮重读落地那一下要叫控制器看一眼，否则路上的信号会一直欠着"
    );
    assert.ok(
      src.includes("}, [refreshing]);"),
      "上面那个 effect 的依赖只能是 refreshing"
    );
  });

  check("路由：轮换必须明显早于 maxDuration，订阅要能中途退掉", () => {
    const src = read("app/api/coordination-history/events/route.ts");

    const number = (pattern: RegExp, label: string) => {
      const found = pattern.exec(src);
      assert.ok(found, `路由里找不到${label}`);
      return Number(found[1].replace(/_/g, ""));
    };
    const maxDuration = number(/maxDuration = ([\d_]+)/, "maxDuration");
    const rotateMs = number(/ROTATE_MS = ([\d_]+)/, "ROTATE_MS");

    assert.ok(
      rotateMs < maxDuration * 1000 - 30_000,
      "轮换要留出至少 30 秒余量，否则会被平台从中间掐断（掐断时客户端只能靠" +
        "重连，白丢一个连接）"
    );
    assert.ok(
      src.includes('send(": ping\\n\\n")'),
      "心跳要走 SSE 的注释行（冒号开头）；写成普通事件会被派发到页面上"
    );

    const flatSrc = flat("app/api/coordination-history/events/route.ts");
    assert.ok(
      flatSrc.includes("if (request.signal.aborted) { teardown(); return; }"),
      "响应还没写出去就可能已经被中止了，要先看一眼"
    );
    assert.ok(
      flatSrc.includes('request.signal.removeEventListener("abort", teardown)'),
      "收摊要把 abort 监听摘掉，否则请求对象会被一直引用着"
    );
    assert.ok(
      flatSrc.includes("if (closed) { void off(); return; }"),
      "订阅是异步挂上的：这中间浏览器走了的话要**当场退订并返回**，" +
        "否则留下一个没有视图在听的订阅，把引用计数永远撑住"
    );
    // 退订返回的是 promise，落地才等于那条数据库连接真的关了。收摊那条路
    // 不 await（会把响应拖住），但必须**发出去**——漏掉的话连接就永远不关
    assert.ok(
      flatSrc.includes("void unsubscribe?.();"),
      "收摊要把退订发出去：`unlisten` 只发 UNLISTEN，不关 TCP"
    );
  });

  check("迁移：删掉的那一行查不到了，必须看 OLD 自己的 is_test", () => {
    const sql = read("lib/db/migrations/manual/coliving-world-20.sql");
    const sqlFlat = sql.replace(/\s+/g, " ");

    assert.ok(
      sql.includes("v_visible := (old.is_test = false)"),
      "household 的 DELETE 分支拿 id 去查表会查空——一栋真房子被删掉会悄无声息"
    );
    // 判据是「OLD **或** NEW 可见」，不是「某个 `or` 出现在哪一行的哪个位置」：
    // 三个反查型触发器里，OLD 一律排在 `if` 后面（写成 `if <old> or <new> then`），
    // 所以拿 `or <old>` 去认，认的是一个**根本不存在的写法**
    for (const [helper, oldVar, newVar] of [
      ["is_visible_household", "v_old_household", "v_new_household"],
      ["person_is_visible", "v_old_person", "v_new_person"],
      ["dwelling_is_visible", "v_old_dwelling", "v_new_dwelling"],
    ]) {
      const called = (name: string) =>
        sqlFlat.includes(`coordination_history_${helper}(${name})`);
      assert.ok(
        called(oldVar) && called(newVar),
        `${helper} 要 OLD 和 NEW 都查一遍：只看一边的话，另一个方向的变化不发信号`
      );
      // 两边由 `or` 连起来（顺序不认死），才是「任一边可见就发」
      assert.ok(
        new RegExp(
          `coordination_history_${helper}\\(${oldVar}\\) or coliving\\.coordination_history_${helper}\\(${newVar}\\)` +
            `|coordination_history_${helper}\\(${newVar}\\) or coliving\\.coordination_history_${helper}\\(${oldVar}\\)`
        ).test(sqlFlat),
        `${helper} 的 OLD / NEW 之间必须是 \`or\`：写成 \`and\` 的话，` +
          "「改成测试房 / 变成不属于任何房子」这种消失不会发信号"
      );
    }
    // 通道名不 import 进来：`change-feed.ts` 带 `server-only`，在纯 Node 里
    // import 会直接抛。对着源码认，跟这两边谁都不跑在浏览器/服务器上无关
    const channel = /CHANGE_CHANNEL = "([^"]+)"/.exec(
      read("lib/coordination-history/change-feed.ts")
    )?.[1];
    assert.ok(channel, "change-feed.ts 里找不到通道名");
    assert.ok(
      sql.includes(`pg_notify('${channel}'`),
      "触发器发的通道名和 change-feed.ts 里的对不上，两边永远不会碰面"
    );
    assert.ok(
      sql.includes("exception when others then"),
      "生产写路径上的触发器必须自己吞掉异常，不能连累消息落库"
    );

    const triggers = sql.match(/^create trigger /gm) ?? [];
    assert.equal(
      triggers.length,
      7,
      "七个可见来源（message / conversation / communication / membership / " +
        "household / person / dwelling）各要一个触发器"
    );

    assert.ok(
      !/^drop function if exists/m.test(sql),
      "回滚 SQL 必须整段注释着：这份文件要能整份直接跑，那几行要是活的，" +
        "一执行就把自己拆了"
    );
    const commented = sql.match(/^-- drop function if exists/gm) ?? [];
    assert.equal(commented.length, 8, "回滚要卸干净：5 个触发器函数 + 3 个判据函数");
  });

  console.log(
    `\n协调历史实时更新：${passed} 项全过（零模型、零短信、零数据库、零迁移执行）`
  );
}

main();
