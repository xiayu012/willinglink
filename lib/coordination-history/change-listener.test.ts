/**
 * `change-listener.ts` 的**确定性反例**：纯 Node 单测，不连库、不起服务器。
 * 客户端是假的，所以「退订 → 再订阅」这种要等真实 TCP 收尾的事在毫秒内跑完。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination-history/change-listener.test.ts`
 *
 * 重点在**连接到底关没关**：postgres.js 的 `unlisten()` 只发一条 `UNLISTEN`，
 * 不关 TCP，所以「调过 unlisten」证明不了任何事。这里断言的是 `end()` 被调到了
 * **哪一个**实例上。
 */

import assert from "node:assert/strict";

import { createChangeListener, type ListenClient } from "./change-listener";

const CHANNEL = "test_channel";

type FakeClient = ListenClient & {
  id: number;
  listenCount: number;
  endCount: number;
  ended: boolean;
  /** 最后一次 `end()` 收到的参数，用来认「关连接带了超时」 */
  endOptions: { timeout?: number | undefined } | undefined;
  /** 模拟数据库那边有动静 */
  notify: () => void;
  /** 模拟断线后 postgres.js 自己重挂：再触发一次 onlisten */
  reListen: () => void;
};

/** 假客户端工厂：记下每次 listen / end 落在哪个实例上 */
function createFakeWorld() {
  let shouldFail = false;
  const created: FakeClient[] = [];

  function openClient(): ListenClient | null {
    // 显式标类型：光靠 `() => {}` 推出来的签名收不下带参数的 `onNotify`
    let notify: (payload: string) => void = () => {};
    let onListen: () => void = () => {};
    const client: FakeClient = {
      id: created.length + 1,
      listenCount: 0,
      endCount: 0,
      ended: false,
      endOptions: undefined,
      // 通道上跑的永远是那个常量载荷，假的也照常量发
      notify: () => notify("1"),
      reListen: () => onListen(),
      listen(_channel, onNotify, listener) {
        client.listenCount += 1;
        if (shouldFail) {
          return Promise.reject(new Error("订阅失败：连不上"));
        }
        notify = onNotify;
        onListen = listener;
        // postgres.js 挂上 LISTEN 之后会回调这一下
        onListen();
        return Promise.resolve({});
      },
      // 真客户端的签名是 `end(options?: { timeout?: number })`，假的照收
      end(options?: { timeout?: number | undefined }) {
        client.endCount += 1;
        client.endOptions = options;
        client.ended = true;
        return Promise.resolve({});
      },
    };
    created.push(client);
    return client;
  }

  return {
    openClient,
    created,
    latest: () => {
      const last = created[created.length - 1];
      assert.ok(last, "还没开过客户端");
      return last;
    },
    failNext: () => {
      shouldFail = true;
    },
    recover: () => {
      shouldFail = false;
    },
  };
}

async function main() {
  let passed = 0;
  const check = async (name: string, fn: () => Promise<void>) => {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  // ── ① 挂上：一条连接，一个回调 ──────────────────────────────────────────
  await check("一个视图订阅：只开一个客户端、只 listen 一次", async () => {
    const world = createFakeWorld();
    const listener = createChangeListener(CHANNEL, world.openClient);
    let hits = 0;

    const off = await listener.subscribe(() => {
      hits += 1;
    });

    assert.equal(world.created.length, 1);
    assert.equal(world.latest().listenCount, 1);
    assert.equal(world.latest().endCount, 0);

    world.latest().notify();
    assert.equal(hits, 1, "库里有动静要回调到订阅者");

    await off();
  });

  // ── ② 退订必须**真的把连接关掉** ────────────────────────────────────────
  await check("最后一个视图退订：end() 被调到，不是只发一条 UNLISTEN", async () => {
    const world = createFakeWorld();
    const listener = createChangeListener(CHANNEL, world.openClient);
    const off = await listener.subscribe(() => {});

    await off();

    assert.equal(
      world.latest().endCount,
      1,
      "只 unlisten 不关 TCP 的话这里是 0——一个人都不看了，数据库上还挂着空闲连接"
    );
    assert.equal(world.latest().ended, true);

    // 关连接**要带超时**：这一步是在串行队列里 await 的，库不可达时无上限地挂
    // 会把后面所有订阅一起堵死
    const timeout = world.latest().endOptions?.timeout;
    assert.equal(
      typeof timeout,
      "number",
      "end() 没带 timeout：库不可达时这条队列会永远卡在关连接上"
    );
    assert.ok(
      typeof timeout === "number" && timeout > 0 && timeout <= 10,
      `超时要是个像样的秒数，实际 ${String(timeout)}`
    );
  });

  // ── ③ 关掉之后再订阅：换新实例，不能复用已经 end 掉的 ───────────────────
  await check("退订后再订阅要开新客户端，不能捡回那个已经关掉的", async () => {
    const world = createFakeWorld();
    const listener = createChangeListener(CHANNEL, world.openClient);

    const off = await listener.subscribe(() => {});
    await off();

    const off2 = await listener.subscribe(() => {});
    assert.equal(
      world.created.length,
      2,
      "end() 是单向的，捡回旧实例的话之后再也收不到通知"
    );
    assert.equal(world.created[0].endCount, 1);
    assert.equal(world.created[1].endCount, 0, "新开的那个不能被误关");
    assert.equal(world.created[1].listenCount, 1);

    await off2();
    assert.equal(world.created[1].endCount, 1);
  });

  // ── ④ 引用计数：还有人在看就不关 ────────────────────────────────────────
  await check("两个视图共用一条连接；退掉一个不关，退掉最后一个才关", async () => {
    const world = createFakeWorld();
    const listener = createChangeListener(CHANNEL, world.openClient);
    let secondHits = 0;

    const off1 = await listener.subscribe(() => {});
    const off2 = await listener.subscribe(() => {
      secondHits += 1;
    });
    assert.equal(world.created.length, 1, "第二个视图不该再开一条连接");

    await off1();
    assert.equal(world.latest().endCount, 0, "还有人看着，关了就等于让他静音");
    world.latest().notify();
    assert.equal(secondHits, 1, "剩下那个订阅者照常收");

    await off2();
    assert.equal(world.latest().endCount, 1);
  });

  // ── ⑤ 退订排在队里时又有人来了：别关 ────────────────────────────────────
  await check("退订排队期间又有视图连上来 → 不关，同一个实例继续用", async () => {
    const world = createFakeWorld();
    const listener = createChangeListener(CHANNEL, world.openClient);

    const off1 = await listener.subscribe(() => {});
    const closing = off1();
    const subscribing = listener.subscribe(() => {});

    await Promise.all([closing, subscribing]);

    assert.equal(
      world.created.length,
      1,
      "中间空了那么一下不值得关掉再重连一次"
    );
    assert.equal(world.latest().endCount, 0, "还在用的实例不能被排队的退订关掉");
  });

  // ── ⑥ 首次订阅就失败：也要收干净，下次能重开 ────────────────────────────
  await check("初次就挂不上：把这次开的实例收掉，失败的回调摘掉，下次重开", async () => {
    const world = createFakeWorld();
    const listener = createChangeListener(CHANNEL, world.openClient);
    let failedHits = 0;
    let okHits = 0;

    world.failNext();
    await assert.rejects(
      () =>
        listener.subscribe(() => {
          failedHits += 1;
        }),
      /订阅失败/
    );
    assert.equal(world.created.length, 1);
    assert.equal(
      world.latest().endCount,
      1,
      "没挂上的那次也要收干净，别留一条半开的连接"
    );

    world.recover();
    const off = await listener.subscribe(() => {
      okHits += 1;
    });
    assert.equal(world.created.length, 2, "上一次的实例已经废了，必须重开");
    assert.equal(world.latest().endCount, 0);

    world.latest().notify();
    assert.equal(okHits, 1);
    assert.equal(failedHits, 0, "失败的那个回调要摘掉，不能留在集合里当僵尸");

    await off();
    assert.equal(world.latest().endCount, 1);
  });

  // ── ⑦ 没配地址：抛，不留状态；之后配上了就能挂 ──────────────────────────
  await check("没有直连地址时抛错且不建连接；地址来了照样能挂上", async () => {
    const world = createFakeWorld();
    let hasUrl = false;
    const listener = createChangeListener(CHANNEL, () =>
      hasUrl ? world.openClient() : null
    );

    await assert.rejects(
      () => listener.subscribe(() => {}),
      /没有可用的直连数据库地址/
    );
    assert.equal(world.created.length, 0, "没地址就不该建客户端");

    hasUrl = true;
    const off = await listener.subscribe(() => {});
    assert.equal(world.created.length, 1);
    assert.equal(world.latest().endCount, 0);

    await off();
    assert.equal(world.latest().endCount, 1);
  });

  // ── ⑧ 断线自动重挂：补一次；第一次挂上不补 ──────────────────────────────
  await check("断线后 postgres.js 自己重挂 → 补一次；第一次挂上不补", async () => {
    const world = createFakeWorld();
    const listener = createChangeListener(CHANNEL, world.openClient);
    let hits = 0;

    const off = await listener.subscribe(() => {
      hits += 1;
    });
    assert.equal(hits, 0, "第一次挂上不补：那一刻的视图刚由服务端渲染过");

    world.latest().reListen();
    assert.equal(hits, 1, "重挂意味着中间断过一段，那段的信号没人收");
    world.latest().reListen();
    assert.equal(hits, 2);

    await off();
  });

  // ── ⑨ 退订幂等 ──────────────────────────────────────────────────────────
  await check("退订调两次不会关两次、也不抛", async () => {
    const world = createFakeWorld();
    const listener = createChangeListener(CHANNEL, world.openClient);
    const off = await listener.subscribe(() => {});

    await off();
    await off();
    assert.equal(world.latest().endCount, 1);
  });

  console.log(
    `\n变更流连接生命周期：${passed} 项全过（零模型、零短信、零数据库、零迁移执行）`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
