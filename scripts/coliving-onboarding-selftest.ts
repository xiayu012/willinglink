/**
 * **首次接触 / 陌生号码入门的确定性自检——零模型、零短信、只写测试屋。**
 *
 *   pnpm coliving:onboarding-selftest
 *
 * 老板 2026-10-01 的口径：任何号码正常进入对话，第一条固定自我介绍，第二条正常回复。
 * 这里面有几条**必须由代码保证**的性质（模型测不出来，也不该靠模型自觉）：
 *
 *   1. 介绍那条**只发一次**（同一个人并发两条首消息也只发一条），失败后**能重试**；
 *   2. 陌生的合法号码**建得起自己的上下文**（role other / resides unknown，同号码幂等）；
 *   3. **不按 Unit 合并房子**：两栋房子写同一个房号，也是两栋各说各话的房子，
 *      谁也看不到谁的记录；
 *   4. 资料齐全之后，运行时上下文**不再提那两件缺失的事**（"不重复问"的输入侧）；
 *   5. **真人的房子进不来**：显式测试参数指向非测试屋时直接抛错；
 *   6. **本地进程走生产路径时不建任何东西**：陌生号码 + 没给测试屋 = 给这个号码
 *      新建真房子，本地进程必须在**第一次写入之前**就被拦下（预审第一条：
 *      事后再拦撤销不了已经落库的真实数据）；
 *   7. **并发的第二条要等第一条介绍真的 `sent`** 才往下走（按投递结果，不按创建先后）；
 *      等待是**只读**的——到点只报 timeout、由调用方终止本轮，绝不去改别轮在途的那条；
 *      发送方中断留下的死行由**陈旧窗口**（`claimFirstIntroduction`，10 分钟）兜底。
 *   8. **资料齐全的新联系人照样先介绍**：Unit / 名册齐不齐是"要不要装配入门准则"的
 *      信号，跟"要不要介绍"是两件事。
 *   9. **首条介绍没送到时，终止发生在模型调用与入站落库之前**——这一条只有走真正的
 *      `runColivingTurn` 才证明得了（前面那些自检都直接调 `repo`，证明不了外层次序）：
 *      失败后会话线上一条消息都不许留，重试仍要重新占位、重新投递。
 *  10. **覆盖陈旧窗口的参数只给测试屋**（`staleAfterMinutesForTest`）：真人的房子拿到
 *      它直接抛错，而且是**在开事务之前**拒绝——不给生产留一个"超时可调"的口子。
 *
 * 契约文案那半（介绍逐字来自单点 `coordinator-self-description.md`、按语言选）也在
 * 这里一并钉住——它是"别复制第二份文案"的回归。
 *
 * 这里**不调用任何模型**（所以不花钱、也不需要 key），**不发任何短信**；
 * 写入只发生在自己新建的测试屋（`is_test = true`）里，真人住的房子一个字都动不到。
 * 语音质量仍然证明不了——那要靠 `pnpm coliving-eval` 的入门场景，见
 * `lib/chat/coliving/evals/scenarios/corpus-050-open-onboarding-*.json`。
 */
import assert from "node:assert/strict";
import { config } from "dotenv";

config({ path: ".env.local" });

// 本地进程写库的显式开关（见 guard.ts）。这份自检写的全是自己新建的测试屋，
// 与 coliving-eval 同一口径：显式声明"我知道我在写库"，不靠默认值。
process.env.COLIVING_LOCAL_WRITE = "1";

const checks: Array<[string, () => void | Promise<void>]> = [];
const check = (name: string, fn: () => void | Promise<void>) =>
  checks.push([name, fn]);

// ── 一、纯函数：介绍文案与"要不要介绍"的判定（不碰库）─────────────────────
check("介绍逐字来自单点文案，按语言选，且不是那句兜底拒绝", async () => {
  const { coordinatorCopyText } = await import("../lib/chat/coliving/coordinator-copy");
  const { introductionIn, needsIntroduction } = await import(
    "../lib/chat/coliving/onboarding"
  );
  const { UNKNOWN_REPLY, UNKNOWN_REPLY_EN } = await import(
    "../lib/chat/coliving/turn"
  );

  assert.equal(introductionIn("zh"), coordinatorCopyText("identity", "zh"));
  assert.equal(introductionIn("en"), coordinatorCopyText("identity", "en"));
  assert.notEqual(introductionIn("zh"), introductionIn("en"), "两种语言不能是同一段");
  assert.ok(introductionIn("zh").includes("AI") && introductionIn("en").includes("AI"));
  // 陌生号码不再收到那句"我这边没有记录"——它现在只留给"号码根本解析不出来"
  assert.notEqual(introductionIn("zh"), UNKNOWN_REPLY);
  assert.notEqual(introductionIn("en"), UNKNOWN_REPLY_EN);

  // 会话里出现过一条 AI 说的话 → 永远不再介绍（"已完成首轮的用户不每轮重介绍"）
  assert.equal(needsIntroduction([]), true, "全新的会话要介绍");
  assert.equal(needsIntroduction([{ role: "user" }]), true, "他刚开口、我们还没说话");
  assert.equal(needsIntroduction([{ role: "assistant" }]), false, "说过了就不再介绍");
  assert.equal(
    needsIntroduction([{ role: "user" }, { role: "assistant" }, { role: "user" }]),
    false,
    "聊过一轮之后不再介绍"
  );
});

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.log("✗ .env.local 里没有 POSTGRES_URL，跳过需要数据库的那部分");
    process.exit(1);
  }
  const repo = await import("../lib/chat/coliving/repo");
  const { INTRODUCTION_INTENT, INTRODUCTION_PURPOSE, introductionIn } = await import(
    "../lib/chat/coliving/onboarding"
  );

  /** 本脚本自己的号码段：唯一，不会撞上任何已有联系人。 */
  const stamp = Date.now().toString().slice(-7);
  let seq = 0;
  const freshPhone = (tag: string) => `+1999${stamp}${(seq += 1)}${tag.length % 10}`;

  const houseA = (await repo.createTestHousehold(`selftest-onboarding-A-${stamp}`))
    .householdId;
  const houseB = (await repo.createTestHousehold(`selftest-onboarding-B-${stamp}`))
    .householdId;

  // ── 二、陌生号码建得起上下文，且同号码幂等 ──────────────────────────────
  check("陌生号码第一次进来就建好自己的上下文（role other / resides unknown），同号码幂等", async () => {
    const phone = freshPhone("A");
    const first = await repo.enrollUnknownSender({
      phone,
      channel: "sms",
      intoTestHouseholdId: houseA,
    });
    assert.ok(first, "合法号码必须建得出上下文");
    assert.equal(first.role, "other", "号码不说明身份，不能猜成租客");
    assert.equal(first.unit, null, "还没人说过房号");

    const [member] = (await repo.getMembers(houseA)).filter(
      (m) => m.personId === first.personId
    );
    assert.equal(member.resides, null, "号码不说明住不住这儿，不能按住着算");

    const again = await repo.enrollUnknownSender({
      phone,
      channel: "sms",
      intoTestHouseholdId: houseA,
    });
    assert.equal(again?.personId, first.personId, "同号码幂等：还是同一个人");
    const same = (await repo.getMembers(houseA)).filter(
      (m) => m.personId === first.personId
    );
    assert.equal(same.length, 1, "同号码不会建出第二个人");
  });

  check("并发两条首消息（同一个号）只建一个人", async () => {
    const phone = freshPhone("C");
    const before = (await repo.getMembers(houseA)).length;
    const [a, b] = await Promise.all([
      repo.enrollUnknownSender({ phone, channel: "sms", intoTestHouseholdId: houseA }),
      repo.enrollUnknownSender({ phone, channel: "sms", intoTestHouseholdId: houseA }),
    ]);
    assert.ok(a && b);
    assert.equal(a.personId, b.personId, "并发首消息必须落在同一个人身上");
    assert.equal(
      (await repo.getMembers(houseA)).length,
      before + 1,
      "并发只该多出一个人"
    );
  });

  // ── 三、介绍只发一次，失败后能重试，并发只赢一个 ────────────────────────
  const introHouse = houseA;
  const introPerson = (
    await repo.enrollUnknownSender({
      phone: freshPhone("I"),
      channel: "sms",
      intoTestHouseholdId: introHouse,
    })
  )!;

  check("固定介绍只占位一次；发失败后允许重试；发出去了就不再发", async () => {
    const claim = () =>
      repo.claimFirstIntroduction({
        householdId: introHouse,
        personId: introPerson.personId,
        channel: "sms",
        body: introductionIn("zh"),
        purpose: INTRODUCTION_PURPOSE,
        intent: INTRODUCTION_INTENT,
      });

    const first = await claim();
    assert.ok(first, "第一次必须占到位");
    assert.equal(await claim(), null, "还没发出去（queued）也不能再占一次");

    await repo.markCommunication({ communicationId: first.communicationId, status: "failed" });
    const retry = await claim();
    assert.ok(retry, "上一条发失败了，下一轮要能再试一次（模型失败时第一条仍可到达）");

    await repo.markCommunication({ communicationId: retry!.communicationId, status: "sent" });
    assert.equal(await claim(), null, "已经发成功了，永远不再介绍第二次");
  });

  check("并发两条首消息不会各发一条介绍（同一时刻只允许一个占位成功）", async () => {
    const person = (
      await repo.enrollUnknownSender({
        phone: freshPhone("J"),
        channel: "sms",
        intoTestHouseholdId: houseA,
      })
    )!;
    const claim = () =>
      repo.claimFirstIntroduction({
        householdId: houseA,
        personId: person.personId,
        channel: "sms",
        body: introductionIn("en"),
        purpose: INTRODUCTION_PURPOSE,
        intent: INTRODUCTION_INTENT,
      });
    const results = await Promise.all([claim(), claim(), claim()]);
    assert.equal(
      results.filter(Boolean).length,
      1,
      "三个并发只该有一个拿到占位，否则住户会收到多条一模一样的自我介绍"
    );
  });

  // ── 三·五、投递顺序：第二条等第一条真的落地（不是看谁先创建）──────────────
  check("并发首消息：等到第一条介绍真的 sent 才放行（按投递结果，不按创建先后）", async () => {
    const person = (
      await repo.enrollUnknownSender({
        phone: freshPhone("K"),
        channel: "sms",
        intoTestHouseholdId: houseA,
      })
    )!;
    // 模拟"并发的另一个 webhook"：它占住了介绍，但还没发出去（仍是 queued）
    const held = await repo.claimFirstIntroduction({
      householdId: houseA,
      personId: person.personId,
      channel: "sms",
      body: introductionIn("zh"),
      purpose: INTRODUCTION_PURPOSE,
      intent: INTRODUCTION_INTENT,
    });
    assert.ok(held, "并发里的赢家必须占到位");

    const started = Date.now();
    // 300ms 之后赢家才真的发出去
    const settle = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await repo.markCommunication({
        communicationId: held.communicationId,
        status: "sent",
      });
    })();
    const cleared = await repo.awaitFirstIntroductionDelivered({
      personId: person.personId,
      channel: "sms",
      purpose: INTRODUCTION_PURPOSE,
    });
    await settle;
    assert.equal(cleared, "sent", "在途介绍真的发出去之后才该放行");
    assert.ok(
      Date.now() - started >= 250,
      "必须真的等到那条介绍落地——否则这一轮的回复会抢在自我介绍前面到达"
    );
  });

  check("等介绍只读、到点就放弃：没在途立刻返回，卡住的到点报 timeout 且不动别轮状态", async () => {
    const person = (
      await repo.enrollUnknownSender({
        phone: freshPhone("L"),
        channel: "sms",
        intoTestHouseholdId: houseA,
      })
    )!;
    // ① 根本没有在途介绍 → 第一次查询就返回（当没送到处理，由调用方终止本轮）
    const quickStart = Date.now();
    assert.equal(
      await repo.awaitFirstIntroductionDelivered({
        personId: person.personId,
        channel: "sms",
        purpose: INTRODUCTION_PURPOSE,
      }),
      "failed",
      "没有任何介绍可等时，不许当成已送达继续往下生成"
    );
    assert.ok(Date.now() - quickStart < 500, "没有在途介绍就不该有等待");

    // ② 有一条一直卡在 queued 的介绍（发送方可能还活着）→ 到点只报 timeout，
    //    **不许**把它改成 failed：那会放第三轮重新 claim，正在发的介绍被双发。
    const stuck = await repo.claimFirstIntroduction({
      householdId: houseA,
      personId: person.personId,
      channel: "sms",
      body: introductionIn("zh"),
      purpose: INTRODUCTION_PURPOSE,
      intent: INTRODUCTION_INTENT,
    });
    assert.ok(stuck, "占位应当成功");
    const stuckStart = Date.now();
    assert.equal(
      await repo.awaitFirstIntroductionDelivered({
        personId: person.personId,
        channel: "sms",
        purpose: INTRODUCTION_PURPOSE,
        timeoutMs: 300,
      }),
      "timeout",
      "卡在 queued 的介绍到点就是 timeout（这一轮不再回第二条）"
    );
    assert.ok(Date.now() - stuckStart < 3000, "放弃要快，不能把这一轮挂住");
    const afterWait = await repo.claimFirstIntroduction({
      householdId: houseA,
      personId: person.personId,
      channel: "sms",
      body: introductionIn("zh"),
      purpose: INTRODUCTION_PURPOSE,
      intent: INTRODUCTION_INTENT,
    });
    assert.equal(
      afterWait,
      null,
      "等在途介绍的那一轮必须只读：不许把它判死、让下一轮再发一遍"
    );
  });

  check("发送方中断留下的陈旧 queued：只在陈旧窗口之后才允许重新占位，不靠等几秒", async () => {
    const person = (
      await repo.enrollUnknownSender({
        phone: freshPhone("N"),
        channel: "sms",
        intoTestHouseholdId: houseA,
      })
    )!;
    const stuck = await repo.claimFirstIntroduction({
      householdId: houseA,
      personId: person.personId,
      channel: "sms",
      body: introductionIn("zh"),
      purpose: INTRODUCTION_PURPOSE,
      intent: INTRODUCTION_INTENT,
    });
    assert.ok(stuck, "占位应当成功");
    // 刚写下的那条（不陈旧）→ 不许被抢
    assert.equal(
      await repo.claimFirstIntroduction({
        householdId: houseA,
        personId: person.personId,
        channel: "sms",
        body: introductionIn("zh"),
        purpose: INTRODUCTION_PURPOSE,
        intent: INTRODUCTION_INTENT,
      }),
      null,
      "刚发出去、还在途的介绍不许被重新占位"
    );
    // 把它当成"发送方中断留下的死行"（陈旧窗口已过）→ 应当可以重新占位
    const reclaimed = await repo.claimFirstIntroduction({
      householdId: houseA,
      personId: person.personId,
      channel: "sms",
      body: introductionIn("zh"),
      purpose: INTRODUCTION_PURPOSE,
      intent: INTRODUCTION_INTENT,
      staleAfterMinutesForTest: 0,
    });
    assert.ok(
      reclaimed,
      "陈旧窗口之后的死行应当被作废，让这个人重新拿到一次介绍"
    );
  });

  check("资料齐全的新联系人照样先介绍：Unit 与名册齐不齐都不参与介绍资格", async () => {
    // 造一栋"资料齐全"的测试屋：房号已知、要住几个人也已声明。
    const house = (
      await repo.createTestHousehold(`selftest-onboarding-full-${stamp}`)
    ).householdId;
    await repo.setHouseholdUnit({ householdId: house, unit: "A208" });
    await repo.setDeclaredSize(house, 1);
    const person = (
      await repo.enrollUnknownSender({
        phone: freshPhone("Q"),
        channel: "sms",
        intoTestHouseholdId: house,
      })
    )!;
    const roster = await repo.rosterStatus(house);
    assert.equal(
      roster.complete,
      true,
      "这个夹具必须是「房号已知 + 名册齐全」，否则这条检查测不到东西"
    );
    // 资料齐全 ≠ 介绍过：他第一次开口还是得先收到那条固定介绍。
    const claim = await repo.claimFirstIntroduction({
      householdId: house,
      personId: person.personId,
      channel: "sms",
      body: introductionIn("en"),
      purpose: INTRODUCTION_PURPOSE,
      intent: INTRODUCTION_INTENT,
    });
    assert.ok(
      claim,
      "预置名册里的室友 / 房东给了号码的人资料是齐的，第一次跟 AI 说话照样要先被介绍"
    );
  });

  // ── 三点六、本地进程的生产路径：第一次写入之前就拦下 ──────────────────────
  check("陌生号码走生产路径（新建真房子）：本地进程在第一次写入之前就被拦下，库里不留痕迹", async () => {
    const { runColivingTurn } = await import("../lib/chat/coliving/turn");
    const phone = freshPhone("P");
    // 这份自检跑在本地进程里（`COLIVING_LOCAL_WRITE=1` 见文件开头）。为了确证
    // "拦下它的是那道闸，不是碰巧被当成服务器运行时放行"，这里显式清掉那两个
    // 让 guard 认为是生产运行时的变量，跑完还原。
    const savedRuntime = process.env.NEXT_RUNTIME;
    const savedVercel = process.env.VERCEL;
    delete process.env.NEXT_RUNTIME;
    delete process.env.VERCEL;
    try {
      await assert.rejects(
        () => runColivingTurn({ channel: "sms", from: phone, text: "hi" }),
        /本地进程不许写真实数据/,
        "不带测试屋参数的陌生号码＝给这个号码新建真房子，本地进程必须在建之前就拦下"
      );
    } finally {
      if (savedRuntime === undefined) delete process.env.NEXT_RUNTIME;
      else process.env.NEXT_RUNTIME = savedRuntime;
      if (savedVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = savedVercel;
    }
    // 拦下 = 什么都没建。事后再拦是不够的：`is_test` 为假的那栋房子已经落库了，
    // 撤不回来（预审第一条的原话）。
    assert.equal(
      await repo.resolveSender("sms", phone),
      null,
      "被拦下的那一轮不许留下任何痕迹（人 / household / 联系方式都不许建出来）"
    );
  });

  // ── 三点七、介绍没送到：**外层入口**的次序（模型与第二条都在它之后）────────
  //
  // 上面那十几项都是直接调 `repo`：它们证明得了"占位/记账/等待"那几条性质，
  // **证明不了 `runColivingTurn` 这个外层入口的次序**——首条没送到时，它到底有没有
  // 在调用模型、把入站消息落库**之前**就停下来。这一项补的就是那一段：
  // 走真正的入口，投递方如实回答"没送到"，然后按库里的真实痕迹验次序。
  check("介绍没送到：本轮在模型与入站落库之前终止；重试仍会重新占位（零模型、零短信）", async () => {
    const { runColivingTurn } = await import("../lib/chat/coliving/turn");
    const { IntroductionNotDelivered } = await import(
      "../lib/chat/coliving/onboarding"
    );
    // 单独一栋测试屋 + 一个自己的号码：这一项要的是"从零开始的一条会话线"，
    // 跟前面几项写过的房子混在一起就分不清是谁留下的痕迹了。
    const house = (
      await repo.createTestHousehold(`selftest-onboarding-intro-fail-${stamp}`)
    ).householdId;
    const phone = freshPhone("V");
    let deliveries = 0;
    // 投递方**如实回答没送到**（不是抛错、也不是不回答——那两种同按未送达算，
    // 这里取最直白的一种）。它被调用几次，就是"这一轮真的去投了几次"。
    const onIntroduction = async () => {
      deliveries += 1;
      return { delivered: false, error: "selftest 故意让首条介绍送不到" };
    };
    const turn = () =>
      runColivingTurn({
        channel: "sms",
        from: phone,
        text: "hi",
        onboardingTestHouseholdId: house,
        onIntroduction,
      });

    // **第一次失败 + 第二次仍失败**（不是失败一次再成功）：两次都必须走到
    // "重新占位 → 重新投递"，才证明得了重试那条路本身是通的。
    for (const attempt of [1, 2]) {
      await assert.rejects(
        turn,
        // 认类也认名字：动态 import 与 `turn.ts` 里的静态 import 各拿一份模块对象
        // 时 `instanceof` 会失手，类名是它自己设的、不会。
        (error: unknown) =>
          error instanceof IntroductionNotDelivered ||
          (error as { name?: string } | null)?.name === "IntroductionNotDelivered",
        `第 ${attempt} 次：首条介绍没送到，这一轮必须终止，不许接着发第二条`
      );
    }
    assert.equal(
      deliveries,
      2,
      "两次入站都要重新占位、重新投递——上一条记 failed 之后不算占位，下一条入站还能再试一次"
    );

    // **外层次序**，按库里的真实痕迹判，不看返回值：
    // ① 会话线上一！条！消息都没有——既没有他的入站（入站是在模型跑完之后才落库的），
    //    也没有 AI 的回复，更不会留下"已经聊过"的假历史（那会让下一轮不再重试）；
    // ② 这栋房子一条出站都没有（含被拦下的尝试）。
    const sender = (await repo.resolveSender("sms", phone))!;
    assert.ok(sender, "陌生号码这一轮该建出上下文（终止 ≠ 不建档）");
    const conversationId = await repo.getOrCreateConversation({
      personId: sender.personId,
      householdId: house,
      channel: "sms",
    });
    const history = await repo.getRecentTurns(conversationId);
    assert.equal(
      history.length,
      0,
      `终止那一轮不许在会话线上留下任何消息（模型没被调用、入站也还没落库），实际留下：${
        history.map((h) => `${h.role}:${h.content.slice(0, 20)}`).join("、") || "无"
      }`
    );
    assert.equal(
      (await repo.recentOutbound(house)).length,
      0,
      "一条出站都不许有——介绍自己那条没送出去，第二条更不该存在"
    );
  });

  // ── 三点八、陈旧窗口的覆盖参数只给测试屋 ────────────────────────────────
  check("覆盖陈旧窗口的参数用在非测试屋上直接抛错（不给真人的房子开口子）", async () => {
    // 这一项不需要真的有一栋真房子：目标 household 不存在时 `is_test` 就不是 true，
    // 闸要先于事务拒绝。**先查后开事务**是关键——拒绝时一个字都不许写进去。
    await assert.rejects(
      () =>
        repo.claimFirstIntroduction({
          householdId: "00000000-0000-0000-0000-000000000000",
          personId: introPerson.personId,
          channel: "sms",
          body: introductionIn("zh"),
          purpose: INTRODUCTION_PURPOSE,
          intent: INTRODUCTION_INTENT,
          staleAfterMinutesForTest: 0,
        }),
      /只许用在测试屋上/,
      "覆盖陈旧窗口是测试专用：目标房子自己过不了 is_test 就必须拒绝"
    );
    // 同一个参数、同一栋测试屋 → 照常可用（第 7 项就是靠它造死行的）。
    // 用一个**全新的人**：`introPerson` 的名册上已经有一条 `sent` 的介绍，
    // 拿他试会把"参数可用"和"这个号早被介绍过"两件事混在一起。
    const person = (
      await repo.enrollUnknownSender({
        phone: freshPhone("W"),
        channel: "sms",
        intoTestHouseholdId: introHouse,
      })
    )!;
    assert.ok(
      await repo.claimFirstIntroduction({
        householdId: introHouse,
        personId: person.personId,
        channel: "sms",
        body: introductionIn("zh"),
        purpose: INTRODUCTION_PURPOSE,
        intent: INTRODUCTION_INTENT,
        staleAfterMinutesForTest: 0,
      }),
      "测试屋上这个参数必须照常可用，否则第 7 项那种死行就造不出来"
    );
  });

  // ── 四、不按 Unit 合并房子：同一个房号也是两栋 ──────────────────────────
  check("同一个房号写进两栋房子，不会合并、也不会互相看到记录", async () => {
    const phoneA = freshPhone("UA");
    const phoneB = freshPhone("UB");
    const a = (await repo.enrollUnknownSender({
      phone: phoneA,
      channel: "sms",
      intoTestHouseholdId: houseA,
    }))!;
    const b = (await repo.enrollUnknownSender({
      phone: phoneB,
      channel: "sms",
      intoTestHouseholdId: houseB,
    }))!;
    assert.notEqual(a.householdId, b.householdId, "两个陌生号各是各的房子");

    await repo.setHouseholdUnit({ householdId: houseA, unit: "A208" });
    await repo.setHouseholdUnit({ householdId: houseB, unit: "A208" });

    const aAfter = (await repo.resolveSender("sms", phoneA))!;
    const bAfter = (await repo.resolveSender("sms", phoneB))!;
    assert.equal(aAfter.unit, "A208");
    assert.equal(bAfter.unit, "A208");
    assert.notEqual(
      aAfter.householdId,
      bAfter.householdId,
      "写着同一个房号，也还是两栋房子（我们没有证据说它们是同一套）"
    );

    // 名单不串：各自只看得见自己那栋的人
    const membersA = await repo.getMembers(houseA);
    const membersB = await repo.getMembers(houseB);
    assert.ok(!membersA.some((m) => m.personId === b.personId), "A 看不到 B 的人");
    assert.ok(!membersB.some((m) => m.personId === a.personId), "B 看不到 A 的人");
    assert.ok(membersA.some((m) => m.personId === a.personId), "A 看得见自己那栋的人");
    assert.ok(membersB.some((m) => m.personId === b.personId), "B 看得见自己那栋的人");
  });

  // ── 五、资料齐全之后，运行时上下文不再提那两件缺失的事 ──────────────────
  check("资料齐全后上下文不再提缺的房号和室友，缺的时候两件都在", async () => {
    const { buildContext } = await import("../lib/chat/coliving/context");
    // 单独开一栋：这一项要的是"从什么都没有"到"齐全"的对照，
    // 跟上面几项写过的房子混在一起就看不出是哪儿变了。
    const house = (await repo.createTestHousehold(`selftest-onboarding-C-${stamp}`))
      .householdId;
    const phone = freshPhone("F");
    const sender = (await repo.enrollUnknownSender({
      phone,
      channel: "sms",
      intoTestHouseholdId: house,
    }))!;

    const before = await buildContext(sender, "sms", { justJoined: true });
    assert.ok(before.text.includes("还没有的两件事实"), "开门见山就该提示缺哪两件");
    assert.ok(before.text.includes("Unit"), "缺房号要说出来");

    // 人齐了 + 房号知道了 = 资料齐全
    await repo.setDeclaredSize(house, 1);
    await repo.setHouseholdUnit({ householdId: house, unit: "B301" });
    const after = await buildContext(
      (await repo.resolveSender("sms", phone))!,
      "sms",
      { justJoined: true }
    );
    assert.ok(
      !after.text.includes("还没有的两件事实"),
      "资料齐全之后不许再提那两件事（不重复问的输入侧）"
    );
    assert.ok(after.text.includes("Unit B301"), "知道了的房号要一直带着");
  });

  // ── 六、真人的房子进不来 ────────────────────────────────────────────────
  check("显式测试参数指向非测试屋时直接抛错（真人的房子一个字都写不进）", async () => {
    await assert.rejects(
      () =>
        repo.enrollUnknownSender({
          phone: freshPhone("R"),
          channel: "sms",
          intoTestHouseholdId: "00000000-0000-0000-0000-000000000000",
        }),
      /测试屋/,
      "不是测试屋就必须拒绝，不能只看调用方自觉"
    );
  });

  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`✗ ${name}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(
    failed === 0
      ? `\n首次接触自检：${checks.length} 项全过（零模型、零短信；只写了测试屋）`
      : `\n首次接触自检：${failed}/${checks.length} 项失败`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("自检本身失败了：", e instanceof Error ? e.message : e);
  process.exit(1);
});
