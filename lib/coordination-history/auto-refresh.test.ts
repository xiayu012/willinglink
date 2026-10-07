/**
 * `auto-refresh.ts` 的**确定性反例**：纯 Node 单测（不起浏览器、不调模型、
 * 不连库、不发消息）。时钟和定时器都是假的，所以「切后台五分钟再回来」在这里
 * 是瞬时跑完的。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination-history/auto-refresh.test.ts`
 *
 * 每条都对着一个真会咬人的反例，不是把实现抄一遍：叠出第二个定时器、切后台还在
 * 刷、回前台干等下一轮、反复 focus 把倒计时拨到永远走不到、刷新没回来就叠发。
 *
 * 页面长什么样、30 秒这个数合不合适，这里证明不了——那要打开
 * `/coordination-history` 人工看。语气/措辞更与它无关：一个字都不发给住户。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AUTO_REFRESH_INTERVAL_MS, createAutoRefresh } from "./auto-refresh";

/**
 * 假世界：一只能被推进的钟 + 一堆能被数出来的定时器。
 *
 * `pending()` 是这套测试的关键——「有没有叠出第二个定时器」只能靠它证明，
 * 靠刷新次数证明不了（叠出来的那些要等下一个间隔才暴露）。
 */
function createFakeWorld() {
  let time = 0;
  let handle = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();

  return {
    now: () => time,
    setTimer: (fn: () => void, ms: number) => {
      handle += 1;
      timers.set(handle, { at: time + ms, fn });
      return handle;
    },
    clearTimer: (h: number) => {
      timers.delete(h);
    },
    /** 还挂着的定时器个数 */
    pending: () => timers.size,
    /** 时间往前走，到点的定时器逐个触发；中途新排的、也到点的接着走 */
    advance(ms: number) {
      const until = time + ms;
      for (;;) {
        let dueHandle: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [h, t] of timers) {
          if (t.at <= until && t.at < dueAt) {
            dueAt = t.at;
            dueHandle = h;
          }
        }
        if (dueHandle === null) {
          break;
        }
        const due = timers.get(dueHandle);
        timers.delete(dueHandle);
        if (!due) {
          break;
        }
        time = due.at;
        due.fn();
      }
      time = until;
    },
  };
}

function createHarness(initial: { visible: boolean; online: boolean }) {
  const world = createFakeWorld();
  /** 外面的世界。测试直接改它，模拟可见性 / `navigator.onLine` 在控件之外变化 */
  const signals = { ...initial };
  const state = { busy: false };
  let refreshes = 0;

  const controller = createAutoRefresh({
    refresh: () => {
      refreshes += 1;
    },
    readSignals: () => ({ ...signals }),
    isBusy: () => state.busy,
    now: world.now,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
  });

  return {
    controller,
    signals,
    world,
    get refreshes() {
      return refreshes;
    },
    /** 切前后台：改状态 + 走页面里那条信号通路 */
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
  };
}

function main() {
  let passed = 0;
  const check = (name: string, fn: () => void) => {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  // ── ① 前台 + 在线：到点刷，然后接着排下一次 ──────────────────────────────
  check("前台 + 在线：到点刷一次，并接着排下一次", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();

    assert.equal(h.world.pending(), 1, "该排一个定时器");
    assert.equal(h.refreshes, 0, "挂载那一下服务端刚渲染过，不该马上再刷");

    h.world.advance(AUTO_REFRESH_INTERVAL_MS - 1);
    assert.equal(h.refreshes, 0, "还没到点");

    h.world.advance(1);
    assert.equal(h.refreshes, 1);

    assert.equal(h.world.pending(), 1, "刷完要接着排下一次，不是停了");
    h.world.advance(AUTO_REFRESH_INTERVAL_MS);
    assert.equal(h.refreshes, 2);
  });

  // ── ② 重复 start 不叠定时器 ─────────────────────────────────────────────
  check("start() 调几次都只有一个定时器，一次到点只刷一次", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.controller.start();
    h.controller.start();

    assert.equal(h.world.pending(), 1, "叠了的话这里是 3");
    h.world.advance(AUTO_REFRESH_INTERVAL_MS);
    assert.equal(h.refreshes, 1, "叠了 n 个定时器这里就会是 n 次");
  });

  // ── ③ 切后台当场停表 ────────────────────────────────────────────────────
  check("切到后台当场停表，之后时间再走也不刷", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.world.advance(10_000);

    h.setVisible(false);
    assert.equal(h.world.pending(), 0, "隐藏就该把定时器清掉，不是留着到点再判断");

    h.world.advance(10 * 60_000);
    assert.equal(h.refreshes, 0, "后台标签页一分钱都不该花");
  });

  // ── ④ 回前台：过期就立刻补 ──────────────────────────────────────────────
  check("回到前台且数据已旧过一个间隔 → 立刻补一次，不是干等下一轮", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();

    h.setVisible(false);
    h.world.advance(5 * 60_000);
    h.setVisible(true);

    assert.equal(h.refreshes, 1, "隔了五分钟才回来，要马上看到新消息");
    assert.equal(h.world.pending(), 1, "补完还要接着排");
  });

  // ── ⑤ 回前台但数据还新鲜：不补刷，定时器不能丢 ──────────────────────────
  check("刚刷过就回前台 → 不补刷，但下一轮不能丢", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();

    h.world.advance(AUTO_REFRESH_INTERVAL_MS);
    assert.equal(h.refreshes, 1);

    h.setVisible(false);
    h.world.advance(1_000);
    h.setVisible(true);
    assert.equal(h.refreshes, 1, "数据才 1 秒旧，别再刷一次");

    assert.equal(h.world.pending(), 1, "这次没刷，但表不能白丢");
    h.world.advance(AUTO_REFRESH_INTERVAL_MS);
    assert.equal(h.refreshes, 2, "下一轮照常到点");
  });

  // ── ⑥ 离线 = 停表；恢复了就补 ───────────────────────────────────────────
  check("离线 = 停表；网络回来且数据过期 → 立刻补一次", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.world.advance(5_000);

    h.setOnline(false);
    assert.equal(h.world.pending(), 0, "断网就别排了");

    h.world.advance(5 * 60_000);
    assert.equal(h.refreshes, 0, "断网期间不该刷");

    h.setOnline(true);
    assert.equal(h.refreshes, 1, "网络回来要立刻补一次，不是再干等 30 秒");
  });

  // ── ⑦ focus 反复触发不饿死定时器 ────────────────────────────────────────
  check("反复 focus 不饿死定时器：倒计时不被一次次拨回原点", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();

    // 每 2 秒「回来一次」，一共 15 次，横跨整个间隔。
    // 每次信号都重排定时器的话，30 秒永远走不到，一次都不会刷。
    for (let t = 0; t < AUTO_REFRESH_INTERVAL_MS; t += 2_000) {
      h.world.advance(2_000);
      h.controller.sync();
    }

    assert.equal(h.refreshes, 1, "拨了 15 次倒计时，该到点的那一次不能丢");
    assert.equal(h.world.pending(), 1);
  });

  // ── ⑧ 上一次刷新还没回来就不叠发 ────────────────────────────────────────
  check("刷新还在路上时不发第二次，回来以后照常", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();

    h.world.advance(AUTO_REFRESH_INTERVAL_MS);
    assert.equal(h.refreshes, 1);

    // 这次刷新比一个间隔还久，还没落地
    h.setBusy(true);
    h.world.advance(AUTO_REFRESH_INTERVAL_MS);
    assert.equal(h.refreshes, 1, "还没回来就不该叠第二次");
    assert.equal(h.world.pending(), 1, "但下一轮要照常排上，不能因此停摆");

    h.world.advance(AUTO_REFRESH_INTERVAL_MS);
    assert.equal(h.refreshes, 1, "一直没回来就一直不叠");

    h.setBusy(false);
    h.world.advance(AUTO_REFRESH_INTERVAL_MS);
    assert.equal(h.refreshes, 2, "回来以后照常刷");
  });

  // ── ⑨ stop 之后真的停了 ────────────────────────────────────────────────
  check("stop() 之后信号再来也不刷（组件卸载了就真的停了）", () => {
    const h = createHarness({ visible: true, online: true });
    h.controller.start();
    h.controller.stop();
    assert.equal(h.world.pending(), 0);

    h.setVisible(false);
    h.setVisible(true);
    h.controller.sync();
    h.world.advance(10 * 60_000);

    assert.equal(h.refreshes, 0);
    assert.equal(h.world.pending(), 0);
  });

  // ── ⑩ 信号现读：冻住的标签页错过事件也能恢复 ────────────────────────────
  check("信号现读：冻结的标签页错过 online 事件，回前台照样恢复轮询", () => {
    const h = createHarness({ visible: false, online: false });
    h.controller.start();
    assert.equal(h.world.pending(), 0, "一进来就是在后台的标签页，不该开始轮询");

    // 标签页被浏览器冻住：外面网络其实已经恢复了，但 online 事件没送达
    h.signals.online = true;
    h.world.advance(60_000);
    assert.equal(h.refreshes, 0, "还看不见，不刷");

    // 回前台：这一次才现读，读到的是「可见 + 在线」
    h.setVisible(true);
    assert.equal(h.refreshes, 1, "读缓存的那份状态就会一直以为自己离线");
    assert.equal(h.world.pending(), 1);
  });

  // ── ⑪ 页面侧接线（源码哨兵）────────────────────────────────────────────
  check("页面接线：控制器只挂一次、信号现读、挡叠发、卸载停表", () => {
    const src = readFileSync(
      "app/coordination-history/history-canvas.tsx",
      "utf8"
    ).replace(/\r\n/g, "\n");

    assert.ok(src.includes("createAutoRefresh("), "页面没接上自动刷新控制器");
    assert.ok(
      src.includes("isBusy: () => refreshingRef.current"),
      "没有挡叠发：一次刷新比间隔久时就会越叠越多"
    );
    assert.ok(
      src.includes("useTransition()"),
      "挡叠发靠的是 useTransition 的 isPending，没有它就等于没挡"
    );
    assert.ok(
      src.includes('document.addEventListener("visibilitychange", onSignal)'),
      "切前后台的信号要接上——不接就不是「只在看着的时候刷」"
    );
    assert.ok(
      src.includes('window.addEventListener("offline", onSignal)'),
      "断网要接上，否则断着网还在一直刷"
    );
    assert.ok(
      src.includes("online: navigator.onLine"),
      "在线状态要现读 navigator.onLine——读缓存的那份会漏掉冻结期间错过的事件"
    );
    assert.ok(
      src.includes("controller.stop()") && src.includes("refreshRef.current"),
      "卸载要停表；router.refresh 要经 ref 取，别把 router 写进 effect 依赖"
    );
  });

  console.log(
    `\n协调历史自动刷新：${passed} 项全过（零模型、零短信、零数据库、零 schema 改动）`
  );
}

main();
