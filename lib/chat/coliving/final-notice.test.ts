/**
 * 共同规则定案通知的离线测试。
 *
 * 运行：`pnpm.cmd exec tsx lib/chat/coliving/final-notice.test.ts`
 *
 * 纯离线：不调模型、不连数据库、不发短信、不 import 任何 server-only / DB 模块。
 *
 * 三层，**第二层跑的是真执行路径**（`dispatchPendingFinalNotices` 本身，只把它四个
 * 依赖——读台账 / 写文案 / 投递 / 致命判定——换成内存假实现，这正是运行时的接线方式）：
 *
 * - 第一层：`final-notice.ts` 的纯判定（定案口径、谁还算待发）；
 * - 第二层：派发编排。覆盖失败重试、无关出站不算收据、一条话都没写出来、
 *   重复抑制、有人反对、一条规则坏了不拖垮别的规则、`queued ≠ sent`、
 *   花钱上限、预算超限必须往上抛；
 * - 第三层：**源码级守门**。台账口径与「登记待办」都写在 `repo.ts` 的 SQL 里，
 *   离线跑不到那层；回复整合写在 `turn.ts` 里，离线也跑不到。就用文本断言钉住
 *   那几条关键谓词，防止以后被改回「按这一轮发过什么算」或「另发一条自我短信」。
 *
 * 每个用例都在 `main()` 里**逐个 await**——脚本按 CJS 转译，顶层 await 用不了；
 * 也不许把异步用例排进队列「先打成功再慢慢跑」，那样打印的成功数会早于真实结果。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isSettledRule,
  pendingFinalNoticeRecipients,
  planFinalNotices,
  type FinalNoticeCandidate,
  type FinalNoticeRecipient,
} from "./final-notice";
import {
  dispatchPendingFinalNotices,
  type FinalNoticeDelivery,
  type FinalNoticeDispatchDeps,
} from "./final-notice-dispatch";
import { isAbortError } from "./abort-error";

let checks = 0;
async function check(
  what: string,
  fn: () => void | Promise<void>
): Promise<void> {
  await fn();
  checks += 1;
  console.log(`ok ${checks} - ${what}`);
}

const HOUSE: FinalNoticeRecipient[] = [
  { personId: "p-richard", name: "Richard" },
  { personId: "p-ana", name: "Ana" },
  { personId: "p-bo", name: "Bo" },
];

/** 造一条候选规则，只填这一条用例关心的字段。 */
function candidate(
  over: Partial<FinalNoticeCandidate> = {}
): FinalNoticeCandidate {
  return {
    ruleId: "r-kitchen",
    statement: "做完饭把灶台前沿擦干净",
    consultedAt: new Date("2026-10-06T10:00:00Z"),
    objectedCount: 0,
    residents: HOUSE,
    acceptedPersonIds: [],
    inFlightPersonIds: [],
    ...over,
  };
}

// ── 第二层的假世界：内存版「发送链路 + 台账」 ────────────────────────────────

/**
 * 语义与运行时一致：
 * - 投递**成功入队**记 `queued`（还没拿到 provider 回执）；
 * - provider 回执（测试里手工调 `accept` / `fail`）把 `queued` 变 `sent` / `failed`；
 * - 台账按 (规则, 人) 算，`sent` / `queued` 都算「先别再发」，但只有 `sent`
 *   会被 `pendingFinalNoticeRecipients` 当成已通知。
 *
 * `unrelatedSends` 是**故意放进来、又故意不被任何依赖读**的那份数据：它代表
 * 「这一轮给谁发过别的消息」。台账不认识它——第一版就是错在拿它当收据。
 */
function fakeWorld(
  args: { failFor?: string[]; composeReturnsNull?: boolean } = {}
) {
  const status = new Map<string, "queued" | "sent" | "failed">();
  const key = (ruleId: string, personId: string) => `${ruleId}|${personId}`;
  const deliveries: Array<{ ruleId: string; personId: string; text: string }> =
    [];
  let composeCalls = 0;
  return {
    deliveries,
    status,
    /** 这一轮跟这条规则无关的发过谁——台账**不该**看它。 */
    unrelatedSends: new Set<string>(),
    get composeCalls() {
      return composeCalls;
    },
    /** provider 回执：把在途的那条判成真的发出去了。 */
    accept(ruleId: string, personId: string) {
      status.set(key(ruleId, personId), "sent");
    },
    /** provider 回执：发送失败 → 重新落回待发。 */
    fail(ruleId: string, personId: string) {
      status.set(key(ruleId, personId), "failed");
    },
    deps(rules: () => FinalNoticeCandidate[]): FinalNoticeDispatchDeps {
      return {
        loadPending: async () =>
          rules().map((rule) => ({
            ...rule,
            acceptedPersonIds: rule.residents
              .map((m) => m.personId)
              .filter(
                (id) =>
                  status.get(key(rule.ruleId, id)) === "sent" ||
                  rule.acceptedPersonIds.includes(id)
              ),
            inFlightPersonIds: rule.residents
              .map((m) => m.personId)
              .filter(
                (id) =>
                  status.get(key(rule.ruleId, id)) === "queued" ||
                  rule.inFlightPersonIds.includes(id)
              ),
          })),
        composeAnnouncement: async (statement: string) => {
          composeCalls += 1;
          if (args.composeReturnsNull) return null;
          return `${statement}——大家都同意了，从今天起照这个来。`;
        },
        deliver: async (call: {
          ruleId: string;
          recipient: FinalNoticeRecipient;
          text: string;
        }): Promise<FinalNoticeDelivery | null> => {
          if (args.failFor?.includes(call.recipient.personId)) {
            // 模拟发送链路在落库前抛错（可达性 / assertCanWrite / 网络）
            throw new Error("投递失败");
          }
          status.set(key(call.ruleId, call.recipient.personId), "queued");
          deliveries.push({
            ruleId: call.ruleId,
            personId: call.recipient.personId,
            text: call.text,
          });
          return {
            to: `${call.recipient.personId}@sms`,
            communicationId: `c-${call.ruleId}-${call.recipient.personId}`,
          };
        },
      };
    },
  };
}

// ── 第一层：纯判定 ──────────────────────────────────────────────────────────

async function pureChecks(): Promise<void> {
  await check("都表过态、没人反对 → 算定案", () => {
    assert.equal(
      isSettledRule({ consultedAt: new Date(), objectedCount: 0 }),
      true
    );
  });

  await check("有人反对 → 不算定案（哪怕所有人都表过态）", () => {
    assert.equal(
      isSettledRule({ consultedAt: new Date(), objectedCount: 1 }),
      false
    );
  });

  await check("还有人没回（consulted_at 为空）→ 不算定案：沉默不是同意", () => {
    assert.equal(isSettledRule({ consultedAt: null, objectedCount: 0 }), false);
  });

  await check("没有登记过的待办 → 不派发", () => {
    assert.deepEqual(planFinalNotices(null), {
      dispatch: false,
      reason: "not-settled",
    });
  });

  await check("有异议的规则 → objected，不派发", () => {
    assert.deepEqual(planFinalNotices(candidate({ objectedCount: 2 })), {
      dispatch: false,
      reason: "objected",
    });
  });

  await check("有人没回的规则 → not-settled，不派发", () => {
    assert.deepEqual(planFinalNotices(candidate({ consultedAt: null })), {
      dispatch: false,
      reason: "not-settled",
    });
  });

  await check("全员都拿到过 sent → everyone-reached，不派发", () => {
    assert.deepEqual(
      planFinalNotices(
        candidate({ acceptedPersonIds: ["p-richard", "p-ana", "p-bo"] })
      ),
      { dispatch: false, reason: "everyone-reached" }
    );
  });

  await check("最后说话的人**不会**被自动划掉：他这一轮的回复不是回执", () => {
    const pending = pendingFinalNoticeRecipients(candidate());
    assert.deepEqual(
      pending.map((r) => r.name),
      ["Richard", "Ana", "Bo"]
    );
  });

  await check("已经有 sent 的划掉；只有 queued（在途）的也先不重复发", () => {
    const pending = pendingFinalNoticeRecipients(
      candidate({ acceptedPersonIds: ["p-ana"], inFlightPersonIds: ["p-bo"] })
    );
    assert.deepEqual(
      pending.map((r) => r.name),
      ["Richard"]
    );
  });

  await check("单成员房子：唯一那位也拿一条正式通知（**不拿他的回复当回执**）", () => {
    // 「定案那一刻只剩他自己，所以不用发」曾经是第一版的写法，但它正是被打回的那条
    // 错误前提——「当前说话人的回复」不是终局通知的凭证（第一版就是拿它当凭证，
    // 结果另外两位一条都没收到）。这里保持一致：名册上每个人各一条，只是这一户
    // 恰好只有一个人。
    assert.deepEqual(
      planFinalNotices(
        candidate({ residents: [{ personId: "p-solo", name: "Solo" }] })
      ),
      { dispatch: true, recipients: [{ personId: "p-solo", name: "Solo" }] }
    );
  });

  await check("确定不住在这里的人不参与（名册由调用方按 resides is not false 取）", () => {
    const pending = pendingFinalNoticeRecipients(
      candidate({ residents: HOUSE.filter((r) => r.personId !== "p-bo") })
    );
    assert.deepEqual(
      pending.map((r) => r.name),
      ["Richard", "Ana"]
    );
  });
}

// ── 第二层：真执行路径（依赖注入，编排本身是真的） ──────────────────────────

async function dispatchChecks(): Promise<void> {
  await check(
    "全员同意 → 三位在住成员各收到一条（**包括最后说话的那位**）",
    async () => {
      const world = fakeWorld();
      const result = await dispatchPendingFinalNotices(
        world.deps(() => [candidate()])
      );
      assert.deepEqual(
        result.sent.map((s) => s.name),
        ["Richard", "Ana", "Bo"]
      );
      assert.deepEqual(result.outstanding, []);
      // 一条规则只写一次文案，三个人收到同一句。
      assert.equal(world.composeCalls, 1);
      assert.equal(new Set(result.sent.map((s) => s.text)).size, 1);
    }
  );

  await check(
    "**无关出站不算收据**：这一轮发过别的提醒，定案通知照发",
    async () => {
      const world = fakeWorld();
      // 编排的入参里根本没有「这一轮发过什么」——它只认 (规则, 人) 的台账。
      // 所以哪怕同一轮刚给 Ana 发过一条无关提醒，Ana 也还在待发名单里：
      // 拿「这一轮发过消息的人」去减，正是要把定案通知整个吞掉的那个写法。
      world.unrelatedSends.add("p-ana");
      world.unrelatedSends.add("p-bo");
      const result = await dispatchPendingFinalNotices(
        world.deps(() => [candidate()])
      );
      assert.deepEqual(
        result.sent.map((s) => s.personId),
        ["p-richard", "p-ana", "p-bo"]
      );
    }
  );

  await check(
    "重复抑制：已经 sent 的人不再发；只剩 queued 的人也先不重复发",
    async () => {
      const world = fakeWorld();
      world.accept("r-kitchen", "p-ana"); // 真的通知到了
      world.status.set("r-kitchen|p-bo", "queued"); // 在途，还没回执
      const result = await dispatchPendingFinalNotices(
        world.deps(() => [candidate()])
      );
      assert.deepEqual(
        result.sent.map((s) => s.personId),
        ["p-richard"]
      );
    }
  );

  await check(
    "`queued ≠ sent`：在途那条失败后**重新落回待发**，下一轮补发",
    async () => {
      const world = fakeWorld();
      const first = await dispatchPendingFinalNotices(
        world.deps(() => [candidate()])
      );
      assert.equal(first.sent.length, 3);
      // provider 回执：两条成功、一条失败。
      world.accept("r-kitchen", "p-richard");
      world.accept("r-kitchen", "p-ana");
      world.fail("r-kitchen", "p-bo");
      const second = await dispatchPendingFinalNotices(
        world.deps(() => [candidate()])
      );
      assert.deepEqual(
        second.sent.map((s) => s.personId),
        ["p-bo"]
      );
    }
  );

  await check(
    "失败补救：投递抛错的人留在 outstanding，其余照发；下一轮只补他",
    async () => {
      const world = fakeWorld({ failFor: ["p-bo"] });
      const first = await dispatchPendingFinalNotices(
        world.deps(() => [candidate()])
      );
      assert.deepEqual(
        first.sent.map((s) => s.personId),
        ["p-richard", "p-ana"]
      );
      assert.deepEqual(first.outstanding, [
        { ruleId: "r-kitchen", personId: "p-bo" },
      ]);
      // 下一轮（同一条规则、同一份台账）只补没发成的那位，不重复发已入队的两位。
      const healthy = fakeWorld();
      healthy.accept("r-kitchen", "p-richard");
      healthy.accept("r-kitchen", "p-ana");
      const second = await dispatchPendingFinalNotices(
        healthy.deps(() => [candidate()])
      );
      assert.deepEqual(
        second.sent.map((s) => s.personId),
        ["p-bo"]
      );
    }
  );

  await check(
    "零通知：文案一条都没写出来 → 一个人都不发，也不假称已通知",
    async () => {
      // 「写不出话」是**普通失败**：按依赖约定由 `composeAnnouncement` 自己吞掉并返回
      // null（`turn.ts` 那个闭包顺手把已花掉的用量记进本轮台账）。
      const world = fakeWorld({ composeReturnsNull: true });
      const result = await dispatchPendingFinalNotices(
        world.deps(() => [candidate()])
      );
      assert.deepEqual(result.sent, []);
      assert.deepEqual(
        result.outstanding.map((o) => o.personId),
        ["p-richard", "p-ana", "p-bo"]
      );
      assert.deepEqual(world.deliveries, []);
      assert.deepEqual(result.composed, [{ ruleId: "r-kitchen", text: null }]);
    }
  );

  await check("有人反对 → 一条通知都不发（哪怕 consulted_at 已经写上）", async () => {
    const world = fakeWorld();
    const result = await dispatchPendingFinalNotices(
      world.deps(() => [candidate({ objectedCount: 1 })])
    );
    assert.deepEqual(result.sent, []);
    assert.deepEqual(result.skipped, [
      { ruleId: "r-kitchen", reason: "objected" },
    ]);
    assert.equal(world.composeCalls, 0);
  });

  await check("有人还没回 → 一条通知都不发", async () => {
    const world = fakeWorld();
    const result = await dispatchPendingFinalNotices(
      world.deps(() => [candidate({ consultedAt: null })])
    );
    assert.deepEqual(result.sent, []);
    assert.deepEqual(result.skipped, [
      { ruleId: "r-kitchen", reason: "not-settled" },
    ]);
  });

  await check(
    "一条规则坏了不拖垮别的规则：A 写不出话，B 照发",
    async () => {
      const world = fakeWorld();
      const result = await dispatchPendingFinalNotices({
        ...world.deps(() => []),
        loadPending: async () => [
          candidate({ ruleId: "r-kitchen" }),
          candidate({
            ruleId: "r-trash",
            statement: "垃圾轮流倒",
            residents: [{ personId: "p-ana", name: "Ana" }],
          }),
        ],
        composeAnnouncement: async (statement: string) => {
          // 兜底路径：万一依赖没按约定吞掉普通失败、直接抛了出来，编排也不许
          // 因此丢掉别的规则——只有 `isFatal` 认得的错误才准往上抛。
          if (statement.includes("灶台")) throw new Error("这条规则写不出来");
          return `${statement}——大家都同意了。`;
        },
      });
      assert.deepEqual(
        result.sent.map((s) => s.ruleId),
        ["r-trash"]
      );
      assert.deepEqual(
        result.outstanding.map((o) => o.ruleId),
        ["r-kitchen", "r-kitchen", "r-kitchen"]
      );
      assert.deepEqual(
        result.composed.map((c) => ({ ruleId: c.ruleId, wrote: c.text !== null })),
        [
          { ruleId: "r-kitchen", wrote: false },
          { ruleId: "r-trash", wrote: true },
        ]
      );
    }
  );

  await check(
    "花钱上限：一轮最多为 maxRules 条规则写文案，剩下的 keep 待办",
    async () => {
      const world = fakeWorld();
      const result = await dispatchPendingFinalNotices({
        ...world.deps(() => [
          candidate({ ruleId: "r-1", statement: "规则一" }),
          candidate({ ruleId: "r-2", statement: "规则二" }),
          candidate({ ruleId: "r-3", statement: "规则三" }),
        ]),
        maxRules: 2,
      });
      assert.equal(world.composeCalls, 2);
      assert.deepEqual(result.deferred, ["r-3"]);
      assert.deepEqual(
        result.composed.map((c) => c.ruleId),
        ["r-1", "r-2"]
      );
      // 没轮到的那条一个人都没发——它不是发失败，是这一轮配额用完了。
      assert.deepEqual(
        result.outstanding.filter((o) => o.ruleId === "r-3"),
        []
      );
    }
  );

  await check("缺省配额是 2：不传 maxRules 也不会无上限地写", async () => {
    const world = fakeWorld();
    const result = await dispatchPendingFinalNotices(
      world.deps(() => [
        candidate({ ruleId: "r-1", statement: "规则一" }),
        candidate({ ruleId: "r-2", statement: "规则二" }),
        candidate({ ruleId: "r-3", statement: "规则三" }),
      ])
    );
    assert.equal(world.composeCalls, 2);
    assert.deepEqual(result.deferred, ["r-3"]);
  });

  await check(
    "预算超限 / 主动中止：写文案时抛出，必须原样往上抛，不许当普通失败吞掉",
    async () => {
      const world = fakeWorld();
      const fatal = new Error("EVAL_BUDGET_EXCEEDED");
      await assert.rejects(
        dispatchPendingFinalNotices({
          ...world.deps(() => [candidate()]),
          composeAnnouncement: async () => {
            throw fatal;
          },
          isFatal: (error) => error === fatal,
        }),
        (error: unknown) => error === fatal
      );
      assert.deepEqual(world.deliveries, []);
    }
  );

  await check("预算超限发生在投递那一步，同样往上抛", async () => {
    const world = fakeWorld();
    const fatal = new Error("EVAL_BUDGET_EXCEEDED");
    await assert.rejects(
      dispatchPendingFinalNotices({
        ...world.deps(() => [candidate()]),
        deliver: async () => {
          throw fatal;
        },
        isFatal: (error) => error === fatal,
      }),
      (error: unknown) => error === fatal
    );
  });

  await check("普通投递异常不被当成致命：留在 outstanding，别的收件人照发", async () => {
    const world = fakeWorld({ failFor: ["p-ana"] });
    const result = await dispatchPendingFinalNotices({
      ...world.deps(() => [candidate()]),
      isFatal: () => false,
    });
    assert.deepEqual(
      result.sent.map((s) => s.personId),
      ["p-richard", "p-bo"]
    );
    assert.deepEqual(result.outstanding, [
      { ruleId: "r-kitchen", personId: "p-ana" },
    ]);
  });
}

// ── 第二层之续：**每条规则每个人正好一条**（模型自己也发了的那条路） ──────────

/**
 * 2026-10-07 付费跑测 corpus-064 的真实事故：规则刚定案那一轮，模型自己用
 * `contactPerson` 给 Elena／Marcus 各写了一条定案通知，生成之后代码派发又按台账给
 * 两人各发了一条规范通知——**每人收到两条**。根因不是措辞，是**两条互不知情的出口**：
 * 模型那条没有 (规则, 人) 回执，派发看不见它。
 *
 * 修法是让两条出口共用**同一份领取台账**（运行时是
 * `repo.claimFinalNoticeDelivery`：同一把锁下先查后写，已经 sent／queued 就领不到）。
 * 这里把它放进内存，好让「模型先领了、派发就领不到」这件事在离线真的跑一遍。
 *
 * **这份台账里只有「定案通知」。** 同一轮的无关转达（Tessa 让带一句水槽的事给
 * Marcus）压根不碰它——所以它既不会占掉名额，也不会被当成本条规则的回执。
 */
function noticeLedger() {
  const status = new Map<string, "queued" | "sent" | "failed">();
  const claims: Array<{
    ruleId: string;
    personId: string;
    by: "model" | "dispatcher" | "reply";
  }> = [];
  const key = (ruleId: string, personId: string) => `${ruleId}|${personId}`;
  return {
    claims,
    statusOf(ruleId: string, personId: string) {
      return status.get(key(ruleId, personId));
    },
    /** 领取：(规则, 人) 已经 sent / queued 就领不到（null），投递方据此不发第二条。 */
    claim(
      ruleId: string,
      personId: string,
      by: "model" | "dispatcher" | "reply"
    ) {
      const k = key(ruleId, personId);
      const current = status.get(k);
      if (current === "sent" || current === "queued") return null;
      status.set(k, "queued");
      claims.push({ ruleId, personId, by });
      return { to: `${personId}@sms`, communicationId: `c-${k}` };
    },
    /** provider 回执。 */
    accept(ruleId: string, personId: string) {
      status.set(key(ruleId, personId), "sent");
    },
    /** 这个人**真的收到了几条**这条规则的通知（入队即算；没领到的不会进这份台账）。 */
    noticeCount(ruleId: string, personId: string) {
      return claims.filter(
        (c) => c.ruleId === ruleId && c.personId === personId
      ).length;
    },
  };
}

/** 派发接线（`loadPending` 从**同一份**领取台账算收件人）。 */
function ledgerDeps(
  ledger: ReturnType<typeof noticeLedger>,
  rules: () => FinalNoticeCandidate[]
): FinalNoticeDispatchDeps {
  const done = (ruleId: string, ids: string[], want: "sent" | "queued") =>
    ids.filter((id) => ledger.statusOf(ruleId, id) === want);
  return {
    loadPending: async () =>
      rules().map((rule) => {
        const ids = rule.residents.map((m) => m.personId);
        return {
          ...rule,
          acceptedPersonIds: [
            ...new Set([
              ...rule.acceptedPersonIds,
              ...done(rule.ruleId, ids, "sent"),
            ]),
          ],
          inFlightPersonIds: [
            ...new Set([
              ...rule.inFlightPersonIds,
              ...done(rule.ruleId, ids, "queued"),
            ]),
          ],
        };
      }),
    composeAnnouncement: async (statement) =>
      `${statement}——大家都同意了，从今天起照这个来。`,
    deliver: async ({ ruleId, recipient }) =>
      ledger.claim(ruleId, recipient.personId, "dispatcher"),
  };
}

async function singleNoticePerPersonChecks(): Promise<void> {
  const ELENA: FinalNoticeRecipient = { personId: "p-elena", name: "Elena" };
  const MARCUS: FinalNoticeRecipient = { personId: "p-marcus", name: "Marcus" };
  const TESSA: FinalNoticeRecipient = { personId: "p-tessa", name: "Tessa" };
  const RULE_ID = "r-stove";
  const stove = () =>
    candidate({
      ruleId: RULE_ID,
      residents: [ELENA, MARCUS, TESSA],
    });

  await check(
    "模型自己也发了（绑定了规则 id）→ 派发一条都不再发，每人正好一条",
    async () => {
      const ledger = noticeLedger();
      // 模型在 contactPerson 里带上 finalNoticeRuleId，走的正是这条领取路径。
      assert.ok(ledger.claim(RULE_ID, ELENA.personId, "model"));
      assert.ok(ledger.claim(RULE_ID, MARCUS.personId, "model"));
      // 最后说话的 Tessa 那份并进她这一轮的回复——同样是**一次领取**。
      assert.ok(ledger.claim(RULE_ID, TESSA.personId, "reply"));

      const result = await dispatchPendingFinalNotices(
        ledgerDeps(ledger, () => [stove()])
      );
      assert.deepEqual(result.sent, [], "三个人都已经有回执，派发不该再发");
      assert.deepEqual(result.skipped, [
        { ruleId: RULE_ID, reason: "everyone-reached" },
      ]);
      for (const m of [ELENA, MARCUS, TESSA]) {
        assert.equal(
          ledger.noticeCount(RULE_ID, m.personId),
          1,
          `${m.name} 收到 ${ledger.noticeCount(RULE_ID, m.personId)} 条定案通知`
        );
      }
    }
  );

  await check(
    "模型只发了一部分 → 派发只补剩下的，仍然每人正好一条",
    async () => {
      const ledger = noticeLedger();
      assert.ok(ledger.claim(RULE_ID, ELENA.personId, "model"));
      const result = await dispatchPendingFinalNotices(
        ledgerDeps(ledger, () => [stove()])
      );
      assert.deepEqual(
        result.sent.map((s) => s.personId),
        [MARCUS.personId, TESSA.personId],
        "只补没领到的那两位"
      );
      for (const m of [ELENA, MARCUS, TESSA]) {
        assert.equal(ledger.noticeCount(RULE_ID, m.personId), 1);
      }
    }
  );

  await check(
    "**同一轮的无关转达不算收据**：它不占通知名额，也不阻断任何人的定案通知",
    async () => {
      const ledger = noticeLedger();
      // 065 第 3 轮那件事：替 Nina 告诉 Paul「水槽还堆着、海绵用完了」。
      // 它**没有**绑定 finalNoticeRuleId，压根不碰这份台账。
      const unrelatedRelay = { to: MARCUS.personId, text: "sink is full" };
      const result = await dispatchPendingFinalNotices(
        ledgerDeps(ledger, () => [stove()])
      );
      assert.deepEqual(
        result.sent.map((s) => s.personId),
        [ELENA.personId, MARCUS.personId, TESSA.personId],
        "转达与他这条规则的通知是两条不同的消息，通知照发"
      );
      assert.equal(
        ledger.noticeCount(RULE_ID, MARCUS.personId),
        1,
        "Marcus 收到的是「转达 + 一条通知」，通知只有一条"
      );
      assert.equal(ledger.claims.length, 3, "台账里只有三条通知，转达不在里面");
      assert.equal(unrelatedRelay.text, "sink is full", "转达本身照旧发出去");
    }
  );

  await check(
    "跨轮幂等：已经 sent 的规则，后面几轮再扫到台账也不会重发",
    async () => {
      // 064 第 4 轮（换个话题又碰到房子的事）就是这条：定案通知不许被重新翻出来群发。
      const ledger = noticeLedger();
      const first = await dispatchPendingFinalNotices(
        ledgerDeps(ledger, () => [stove()])
      );
      assert.equal(first.sent.length, 3);
      for (const m of [ELENA, MARCUS, TESSA]) {
        ledger.accept(RULE_ID, m.personId); // provider 回执：真的发出去了
      }
      for (let round = 0; round < 3; round += 1) {
        const again = await dispatchPendingFinalNotices(
          ledgerDeps(ledger, () => [stove()])
        );
        assert.deepEqual(again.sent, [], `第 ${round + 2} 轮不该再发`);
      }
      for (const m of [ELENA, MARCUS, TESSA]) {
        assert.equal(ledger.noticeCount(RULE_ID, m.personId), 1);
      }
    }
  );

  await check(
    "落库失败 ＝ 这次领取整个不算数：台账里不留痕、这个人下一轮照旧补发",
    async () => {
      // 2026-10-07 修的静默丢件：从前是「先写下 queued 回执、再去取会话/写消息」，
      // 中间那两步一失败就只剩一条没有 provider 回执、也没有任何重试的 `queued`
      // ——台账把它当在途，这个人从此再也不会被算进待发名单。
      // 现在落库是一个原子领取：要么 decision ＋ communication ＋ 消息一起成功，
      // 要么整条回滚。这里钉住那个**契约**——投递抛错时台账里不能留下任何痕迹。
      const ledger = noticeLedger();
      const first = await dispatchPendingFinalNotices({
        ...ledgerDeps(ledger, () => [stove()]),
        deliver: async ({ ruleId, recipient }) => {
          if (recipient.personId === MARCUS.personId) {
            throw new Error("领取里写消息那一步失败"); // 事务回滚
          }
          return ledger.claim(ruleId, recipient.personId, "dispatcher");
        },
      });
      assert.deepEqual(
        first.sent.map((s) => s.personId),
        [ELENA.personId, TESSA.personId],
        "另外两位照发，坏的那位不拖垮别人"
      );
      assert.deepEqual(first.outstanding, [
        { ruleId: RULE_ID, personId: MARCUS.personId },
      ]);
      assert.equal(
        ledger.statusOf(RULE_ID, MARCUS.personId),
        undefined,
        "失败的那次不许留下 queued——留下就等于他永远收不到这条通知"
      );
      assert.equal(ledger.noticeCount(RULE_ID, MARCUS.personId), 0);

      // 下一轮：Marcus 照旧在待发名单里被补发，已经发成的两位不重复。
      const second = await dispatchPendingFinalNotices(
        ledgerDeps(ledger, () => [stove()])
      );
      assert.deepEqual(
        second.sent.map((s) => s.personId),
        [MARCUS.personId],
        "失败是**可重试**的，不是永久丢失"
      );
      for (const m of [ELENA, MARCUS, TESSA]) {
        assert.equal(ledger.noticeCount(RULE_ID, m.personId), 1);
      }
    }
  );
}

// ── 第三层：源码级守门（SQL 与回复整合离线跑不到，只能钉谓词） ───────────────

/**
 * 取一个函数的**函数体文本**（到下一个 `export` 或文档注释为止）。
 *
 * 不切到「下一个 `\n}\n`」：这些函数的 SQL 里有大量缩进的花括号行，切出来会截断。
 * 切到下一个顶层声明为止，既不截断、也不会把下一个函数的注释误算进来。
 */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到 ${signature}`);
  const rest = source.slice(start + signature.length);
  const stop = rest.search(/\n(?=export |\/\*\*)/);
  return stop >= 0 ? rest.slice(0, stop) : rest;
}

async function fatalChecks(): Promise<void> {
  await check("预算超限 → 致命（必须往上抛）", () => {
    const budget = new Error("预算超限");
    budget.name = "EvalBudgetExceededError";
    // 真实判定用 instanceof，这里造不出那个类；只钉「名字不是中止」这条不误判。
    assert.ok(!isAbortError(budget), "预算错误不是中止");
    assert.ok(!isAbortError(new Error("普通失败")), "普通失败不是致命");
    assert.ok(!isAbortError(null) && !isAbortError(undefined));
  });

  await check("上层 abort → 致命；**超时不算**（那只是这一步太慢）", () => {
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    assert.ok(isAbortError(aborted), "AbortError 是取消");

    const timedOut = new Error("timed out");
    timedOut.name = "TimeoutError";
    assert.ok(
      !isAbortError(timedOut),
      "超时该退回普通回复、下一轮再补，不该把整轮一起废掉"
    );
  });

  await check("中止错误被包在 cause 链里也认得出（FeatureCallError 那种包装）", () => {
    const inner = new Error("aborted");
    inner.name = "AbortError";
    const wrapped = new Error("stage=feature:compose", { cause: inner });
    const twice = new Error("outer", { cause: wrapped });
    assert.ok(isAbortError(wrapped), "沿 cause 找一层");
    assert.ok(isAbortError(twice), "再包一层也认得出");

    // DOMException 不是 Error 子类——按 name 判，不按 instanceof 判。
    const domLike = { name: "AbortError", message: "aborted" };
    assert.ok(
      isAbortError(domLike),
      "DOMException 那种不是 Error 的中止也要认得出"
    );
  });
}

async function sourceChecks(): Promise<void> {
  const repoSource = readFileSync(new URL("./repo.ts", import.meta.url), "utf8");
  const turnSource = readFileSync(new URL("./turn.ts", import.meta.url), "utf8");
  const smsSource = readFileSync(
    new URL("./sms-delivery.ts", import.meta.url),
    "utf8"
  );
  const dispatchSource = readFileSync(
    new URL("./final-notice-dispatch.ts", import.meta.url),
    "utf8"
  );

  await check("台账**只认登记过的待办**，不回溯历史规则（否则上线第一轮群发老规则）", () => {
    const body = bodyOf(repoSource, "export async function finalNoticeCandidates");
    assert.ok(
      body.includes("d.kind = 'contact_group'") &&
        body.includes("d.payload->>'finalNoticeRuleId' is not null") &&
        body.includes("d.payload->>'finalNoticePersonIds' is not null"),
      "候选必须由定案时登记的 contact_group 待办驱动，不能从 rule 表整表扫"
    );
    assert.ok(
      body.includes("from coliving.decision d"),
      "驱动表是 decision（登记过的待办），不是 rule"
    );
    assert.ok(
      !/^\s*from coliving\.rule r\s*$/m.test(body),
      "不许拿 rule 表当驱动表——那正是「历史规则全被翻出来群发」的写法"
    );
  });

  await check("共识证明是**显式的**：登记的每一位都必须真的在 agreed_by 里", () => {
    const body = bodyOf(repoSource, "export async function finalNoticeCandidates");
    assert.ok(
      body.includes("u.pid = any(r.agreed_by)") && body.includes("not exists"),
      "不能只用 consulted_at + 没有异议间接推断「大家都同意了」"
    );
    assert.ok(
      body.includes("r.status = 'active'"),
      "retired / proposed 的规则都不能发「这条规则已生效」"
    );
    assert.ok(
      body.includes("d.payload->>'finalNoticePersonIds'") &&
        body.includes("mb.resides is not false"),
      "收件人是定案那一刻**冻结的参与人**里现在仍住在这里的人"
    );
  });

  await check("回执按 (规则, 人) 算：sent 才算已通知，queued 只是在途", () => {
    const body = bodyOf(repoSource, "export async function finalNoticeCandidates");
    assert.ok(
      body.includes("rd.payload->>'finalNoticeRuleId' = r.id::text") &&
        body.includes("rd.payload->>'finalNoticePersonId' is not null"),
      "回执必须关联到「这条规则、这个人」"
    );
    assert.ok(
      body.includes(
        "c.to_person_id = (rd.payload->>'finalNoticePersonId')::uuid"
      ),
      "收件人也必须对上——本轮 decision 是整轮共用的，别的工具也挂在它下面，" +
        "只按 decision 认会把发给别人的无关消息当成这个人的收据"
    );
    assert.ok(body.includes("c.status = 'sent'"), "sent 才算已通知");
    assert.ok(body.includes("c.status = 'queued'"), "queued 是在途，要单独算");
  });

  await check("候选只在**筛掉已发完的**之后才取上限（否则老待办占满名额、新的饿死）", () => {
    const body = bodyOf(repoSource, "export async function finalNoticeCandidates");
    const filterAt = body.indexOf("c.status in ('sent', 'queued')", body.indexOf("and exists ("));
    const limitAt = body.indexOf("limit 10");
    assert.ok(filterAt >= 0, "必须有一条「还有人没拿到」的筛子（判据同回执那套）");
    assert.ok(limitAt > filterAt, "筛子要在 limit 之前生效");
    assert.ok(
      body.includes('order by t."consultedAt" nulls last'),
      "等得最久的先发，条数上限之外的下轮就是最老的"
    );
  });

  await check("登记待办与定案在**同一条 SQL** 里，且只在无异议时登记", () => {
    const body = bodyOf(
      repoSource,
      "export async function closeConsultationIfComplete"
    );
    assert.ok(
      body.includes("insert into coliving.decision") &&
        body.includes("'contact_group'") &&
        body.includes("'finalNoticeRuleId'") &&
        body.includes("'finalNoticePersonIds'"),
      "定案那一刻必须原子地写下待发通知的台账（规则 id ＋ 参与人）"
    );
    assert.ok(
      body.includes("where c.objected_count = 0 and e.ids is not null"),
      "有异议就不登记待办——有异议的规则没有「定案通知」可言"
    );
  });

  await check("有异议时 closeConsultationIfComplete 不再把规则置成 active", () => {
    const body = bodyOf(
      repoSource,
      "export async function closeConsultationIfComplete"
    );
    assert.ok(
      !/set consulted_at = now\(\),\s*status = 'active'/.test(body),
      "不能无条件置 active"
    );
    assert.ok(
      body.includes("coalesce(array_length(r.objected, 1), 0) = 0"),
      "只有没有异议才升 active"
    );
    assert.ok(body.includes("'retired'"), "升 active 时退休同 kind 的旧规则");
  });

  /**
   * **独立复审抓到的真实反例（2026-10-06）**，两条都出在同一段 SQL 的收口闸上：
   *
   * - `consulted_at is null` 曾经是**唯一的**收口闸。于是「全员都表过态、其中一条是
   *   异议 → 记 `consulted_at`、状态停在 `proposed`」之后，**同一个反对者对同一条
   *   没改过的草案改口同意**：`consulted_at` 已经非空，收口 SQL 从此不再执行——
   *   规则既不升 `active`，定案通知也**永远不会登记**（不是发晚了，是永远不发）。
   * - 同一段 SQL 也没有任何状态 / 有效期过滤，所以一个**陈旧的 `ruleId`** 能把一条
   *   已退休的规则重新置成 `active`，并群发一遍定案通知。
   *
   * 判据本来就是「现场算」（`not exists` 那条拿名册比 `agreed_by` / `objected`），
   * `consulted_at` 只做审计戳——这正是 `coliving-world-10.sql` 给那一列下的定义。
   * 这里只钉住那几条**谓词**，不钉措辞；幂等（已经收口过的 `active` 不重收）与
   * 旧行放行（`active` 且从没写过 `consulted_at`）都靠同一条谓词一起表达。
   */
  await check("收口现场算：异议撤回后能再收口；退休/过期行不能被陈旧 id 复活", () => {
    const body = bodyOf(
      repoSource,
      "export async function closeConsultationIfComplete"
    );
    assert.ok(
      !body.includes("and r.consulted_at is null"),
      "不能拿 consulted_at 当收口开关：全员表过态、有人反对时它已经被写上，" +
        "同一个反对者之后改口同意就再也收不了口（它只是审计戳）"
    );
    assert.ok(
      body.includes("(r.status = 'proposed' or r.consulted_at is null)"),
      "草案永远可以再收口（含异议撤回后的第二次）；从没收口过的旧行也照旧可以；" +
        "已经收口过的 active 规则仍然不会被重收（幂等，不重复登记待发台账）"
    );
    assert.ok(
      body.includes("r.status in ('proposed', 'active')") &&
        body.includes("r.valid_to is null or r.valid_to > now()"),
      "已退休 / 有效期已过的行不收口——否则一个陈旧 ruleId 能把退休规则重新置成" +
        " active、再群发一遍定案通知"
    );
  });

  await check("新记的规则是草案；草案只顶掉草案，不动在跑的规则", () => {
    const body = bodyOf(repoSource, "export async function saveRule");
    assert.ok(
      body.includes("'proposed'"),
      "saveRule 插入的必须是 proposed（草案不生效）"
    );
    assert.ok(
      !/values \([^)]*'active'/.test(body),
      "saveRule 不许把草案直接写成 active"
    );
    assert.ok(
      body.includes("and status = 'proposed'"),
      "retire 的谓词必须限定在草案上——退休在跑的规则属于「新规则真的定案了」"
    );
  });

  await check("(规则, 人) 的领取与落库在**同一个事务＋同一把锁**里", () => {
    const body = bodyOf(
      repoSource,
      "export async function claimFinalNoticeDelivery"
    );
    assert.ok(
      body.includes("pg_advisory_xact_lock") &&
        body.includes("final-notice:${args.ruleId}:${args.personId}"),
      "同一 (规则, 人) 的领取必须串行化，否则两个并发轮次各查到「还没通知过」"
    );
    assert.ok(
      body.includes("c.status in ('sent', 'queued')"),
      "已发（sent）或在途（queued）都算「这条已经有了」，不再重复领"
    );
    assert.ok(
      body.includes("insertDecision(tx") && body.includes("insertCommunication(tx"),
      "decision 与 communication 必须在同一个事务里写"
    );
    assert.ok(
      body.includes("insertConversation(tx") && body.includes("insertMessage(tx"),
      "会话与那条出站消息也要在**同一个事务**里写（2026-10-07 修的静默丢件）：" +
        "只领到 decision ＋ communication 而消息在另一次连接上写失败，留下的是永远不投递、" +
        "也不重试的 `queued`，下一位住户从此收不到这条通知"
    );
    assert.ok(
      body.includes("args.conversationId ??") &&
        body.includes("insertConversation(tx, {"),
      "并进本轮回复时用已经有的那条会话；单独发通知时才在事务里按 (人, 渠道) 取/建"
    );
    assert.ok(
      body.includes("'finalNoticeRuleId'") &&
        body.includes("'finalNoticePersonId'") &&
        !body.includes("JSON.stringify"),
      "两个 id 在**领取时**写进 payload（走 insertDecision 的 sql.json()）"
    );
    assert.ok(
      body.indexOf("assertCanWrite(") < body.indexOf("db().begin"),
      "发送硬闸必须在写之前跑：本地进程不许写真人住的房子"
    );
  });

  await check("回复那条回执由**专用 decision** 写上，不是回头给整轮 decision 补标记", () => {
    assert.ok(
      !repoSource.includes("tagDecisionFinalNotice") &&
        !turnSource.includes("tagDecisionFinalNotice"),
      "整轮共用的那条 decision 底下还挂着发给别人的消息，事后补标记会把无关消息算成回执"
    );
    assert.ok(
      turnSource.includes("deliverFinalNoticeReply({") &&
        turnSource.includes("ruleId: replyNotice.ruleId"),
      "并进回复要走那条会领取 (规则, 人) 的专用出口"
    );
  });

  await check("通知走**既有发送链路**：同一套表、同一道硬闸", () => {
    const noticeBody = bodyOf(smsSource, "async function claimAndAppend");
    assert.ok(
      noticeBody.includes("claimFinalNoticeDelivery"),
      "落库走那个会领取 (规则, 人) 的原子出口"
    );
    assert.ok(
      !noticeBody.includes("deps.appendMessage(") &&
        !noticeBody.includes("deps.getOrCreateConversation("),
      "这里**不许再自己写一遍消息**：领取本身已经把会话与消息写进同一个事务了，" +
        "分开写正是那条「领取成功、消息写失败 → 永远不投递的 queued」的来路"
    );
    assert.ok(
      noticeBody.includes("conversationId: args.conversationId"),
      "并进本轮回复时把已经有的那条会话传进领取里"
    );
    const noticeSmsBody = bodyOf(
      smsSource,
      "export async function deliverFinalNoticeSms"
    );
    assert.ok(
      noticeSmsBody.includes("smsRecipientNoAddressReply(args.recipient)"),
      "地址那一关照旧要过——真没地址就是联系不上"
    );
    assert.ok(
      !noticeSmsBody.includes("smsRecipientUnconfirmedNameReply"),
      "姓名确认那条闸不能用在定案通知上：名册导入的真名 nameConfirmed 是 false"
    );
    const replyBody = bodyOf(
      smsSource,
      "export async function deliverFinalNoticeReply"
    );
    assert.ok(
      !replyBody.includes("smsRecipientNoAddressReply"),
      "并进回复那条是回给刚发消息过来的人，再查一次地址会把回复弄丢"
    );
  });

  await check("编排不写「已通知」标志位，也不自己写文案", () => {
    assert.ok(
      !/status\s*=\s*'sent'|markNotified|notifiedPersonIds/.test(dispatchSource),
      "回执只认 communication.status，不许另立「已通知」标记"
    );
    assert.ok(
      dispatchSource.includes("deps.composeAnnouncement(rule.statement)"),
      "正文必须来自措辞层，按规则原文写"
    );
  });

  await check("turn.ts：派发用 (规则, 人) 领取那条出口，致命取消照旧往上抛", () => {
    assert.ok(
      turnSource.includes("await deliverFinalNoticeSms({") &&
        turnSource.includes("ruleId,"),
      "单独的定案通知走领取式投递，收件人还是台账算出来的那位"
    );
    assert.ok(
      turnSource.includes("isFatal: isFatalTurnError"),
      "预算超限 / 主动中止都必须往上抛，不能被派发的 catch 吞掉"
    );
    assert.ok(
      turnSource.includes("isEvalBudgetExceeded(error) || isAbortError(error)"),
      "致命判据得同时认预算超限和主动中止——只认预算就是漏掉取消"
    );
    assert.ok(
      turnSource.includes("if (isFatalTurnError(error)) throw error;"),
      "并进回复 / 派发那两处 catch 也要按同一条口径判致命"
    );
    assert.ok(
      !turnSource.includes("isEvalBudgetExceeded(error)) throw error"),
      "别留只认预算、漏掉中止的旧判据"
    );
  });

  await check("turn.ts：写文案的失败也要把用量记进本轮台账", () => {
    const start = turnSource.indexOf("const composeNotice = async");
    assert.ok(start >= 0, "找不到 composeNotice 闭包");
    const body = turnSource.slice(start, turnSource.indexOf("};", start));
    assert.ok(
      body.includes("addFeatureUsage(noticeUsage, composed.usage)"),
      "成功那次的用量要记"
    );
    assert.ok(
      body.includes("addFeatureUsage(noticeUsage, usageOfFeatureError(error))"),
      "失败那次已经花掉的用量也要记，不能凭空消失"
    );
    assert.ok(
      body.includes("isFatalTurnError(error)) throw error"),
      "致命取消照旧往上抛"
    );
  });

  await check("turn.ts：当前说话人的那份**追加**在回复后面，不替换、不另发一条自我短信", () => {
    assert.ok(
      !turnSource.includes("FINAL_NOTICE_REPLY_REPLACE_MAX_CHARS") &&
        turnSource.includes("text: `${reply}\\n\\n${notice}`"),
      "只追加：长度证明不了「这一轮只说了这一件事」，短的多话题回复不许被整条抹掉"
    );
    assert.ok(
      turnSource.includes("deliverFinalNoticeReply({") &&
        turnSource.includes("reply = replyNotice.text;"),
      "领到了才把通知并进回复正文；领不到就照原样发"
    );
    // 锚点必须唯一：文件里另有一处 `replyCommunicationId`（前门回复那条老路径），
    // 只按变量名找会命中前面那一处，顺序断言就变成永远成立的废话——取最后一次出现。
    const replyAt = turnSource.lastIndexOf(
      "let replyCommunicationId: string | null = null;"
    );
    assert.ok(replyAt >= 0, "找不到本轮回复落库那一段");
    /**
     * **把这一支整个切出来断言，不用「往后数 N 个字符」那种魔数窗口。**
     *
     * 2026-10-07 这里红过一次：窗口是 `slice(replyAt, replyAt + 600)`，原子领取那段
     * 注释写长了一行，`noticed` 就落到窗口外面去了——**红的是窗口，不是被断言的行为**。
     * 窗口贴合注释长度，断言就变成「注释别写太长」，而且真出事时也说不清是哪一处。
     *
     * 改成切到本轮出站闸那条语句为止：那正是「这一轮的回复怎么落库」这一支的结尾
     * （再往后就是定案通知的派发），边界是代码结构本身，不随注释长短漂。
     */
    const branchEnd = turnSource.indexOf(
      "const noticeOutbound: OutboundMessage[] = [];",
      replyAt
    );
    assert.ok(branchEnd > replyAt, "找不到本轮回复落库那一支的结尾");
    const replyBranch = turnSource.slice(replyAt, branchEnd);
    assert.ok(
      replyBranch.includes("const noticed = replyNotice") &&
        replyBranch.includes("deliverFinalNoticeReply({"),
      "最后一次出现的那处才是本轮回复落库——它得是走领取的那一支" +
        "（前门回复那条老路径在它前面，按第一次出现找会断言到别人身上）"
    );

    // **领到了就不再自己落一次库**：decision ＋ communication ＋ 那条出站消息都在
    // `deliverFinalNoticeReply` 的原子领取里写完了（见 repo 那边：分开写会留下一条
    // 永不投递的 `queued`）。所以 `appendMessage` / `queueCommunication` 只准出现在
    // **没领到**那一支里——两边都写就是这条回复发两遍。
    const claimedAt = replyBranch.indexOf("if (noticed && replyNotice) {");
    const elseAt = replyBranch.indexOf("} else {");
    assert.ok(
      claimedAt >= 0 && elseAt > claimedAt,
      "找不到「领到了 / 没领到」这两支"
    );
    const claimedArm = replyBranch.slice(claimedAt, elseAt);
    const fallbackArm = replyBranch.slice(elseAt);
    assert.ok(
      claimedArm.includes("reply = replyNotice.text;") &&
        claimedArm.includes("replyCommunicationId = noticed.communicationId;"),
      "领到了就把通知并进回复正文，回执用领取返回的那条 communication"
    );
    assert.ok(
      !claimedArm.includes("appendMessage") &&
        !claimedArm.includes("queueCommunication"),
      "领到了这一支**不许再落一次库**：再写一条会让这条回复发两遍"
    );
    assert.ok(
      fallbackArm.includes("repo.queueCommunication({") &&
        fallbackArm.includes("await repo.appendMessage({"),
      "没领到那一支照旧走普通落库（decision ＋ communication ＋ appendMessage），一个字都不改"
    );

    const mergeAt = turnSource.indexOf("text: `${reply}\\n\\n${notice}`");
    const dispatchAt = turnSource.indexOf("await dispatchPendingFinalNotices({");
    assert.ok(
      mergeAt >= 0 && mergeAt < replyAt,
      "回复内容是在落库之前就拼好的"
    );
    assert.ok(dispatchAt > branchEnd, "派发必须发生在回复落库之后");
  });

  await check(
    "turn.ts：contactPerson 的规则绑定走**同一条领取路径**，对不上就拒绝且零出站",
    () => {
      const start = turnSource.indexOf("if (finalNoticeRuleId) {");
      assert.ok(
        start >= 0,
        "contactPerson 必须认这个可选的绑定字段（064 那两条重复通知的修法）"
      );
      // 从这个分支的开头切到「真的领到了」那一刻为止——拒绝分支全在这段里。
      const addAt = turnSource.indexOf("contacted.add(target.personId);", start);
      assert.ok(addAt > start, "找不到绑定分支里那次 contacted.add");
      const refusePath = turnSource.slice(start, addAt);
      assert.ok(
        refusePath.includes("const pending = await loadPendingNotices()") &&
          refusePath.includes("rule.residents.some("),
        "先核对这条规则现在确实还有这个人的待发通知、且他真是定案参与人"
      );
      assert.ok(
        (refusePath.match(/ok: false/g) ?? []).length >= 3,
        "没定案 / 不是参与人 / 已经发过，三种情况都要如实拒绝"
      );
      assert.ok(
        !refusePath.includes("outbound.push(") && !refusePath.includes("contacted.add("),
        "拒绝分支一个字都不许发，也不许把没收到的说成已联系"
      );
      assert.ok(
        refusePath.includes("await deliverFinalNoticeSms({") &&
          refusePath.includes("ruleId: finalNoticeRuleId"),
        "领到了就走和代码派发完全同一条领取路径（同一份 (规则, 人) 回执）"
      );
      // 边界按**结构**取，不按固定字数：这个绑定分支后面紧跟的就是普通消息那条路
      // 的重复判断。固定字数在 CRLF 检出下每行多一个字符，会少盖住几行、把本来
      // 正确的记账代码误判成缺字段（同一份语义在 LF 下过、在 CRLF 下挂）。
      const afterAddEnd = turnSource.indexOf(
        "const duplicate = await repo.findRecentOpenCommunication",
        addAt
      );
      assert.ok(
        afterAddEnd > addAt,
        "找不到 contacted.add 之后紧跟的重复消息判断，无法确定记账段的边界"
      );
      const afterAdd = turnSource.slice(addAt, afterAddEnd);
      assert.ok(
        afterAdd.includes("sentTo: target.name") &&
          afterAdd.includes("communicationId: delivered.communicationId"),
        "只有真领到才记账，并照旧把那条 communication 的 id 带回去"
      );
      assert.ok(
        turnSource.includes("finalNoticeRuleId: z") &&
          turnSource.includes("**几乎不用填。**"),
        "这个绑定必须是**可选**的：不填就逐字走普通消息路径，正常转达不受影响"
      );
      // 这一轮刚定案的规则，待办是刚刚才写进去的——工具阶段读的旧快照里没有它，
      // 不作废缓存会让同一轮紧接着的补发被白拒一次。
      const settledAt = turnSource.indexOf("settledRuleThisTurn.ruleId = target;");
      assert.ok(settledAt >= 0, "找不到 recordStance 收口那一步");
      assert.ok(
        turnSource
          .slice(settledAt, settledAt + 700)
          .includes("pendingNoticesCache = null;"),
        "刚定案就把台账缓存作废：新写下的待办要让同一轮的 contactPerson 看得见"
      );
    }
  );

  await check(
    "turn.ts：工具回执明确告诉模型「定案通知由系统发、你回一两句就行」",
    () => {
      // 光靠结构拦不住模型自己去发：绑定字段是**可选**的，所以必须让它在
      // proposeRule / recordStance 的回执里就知道这件事不用它做（064 就是在这里翻车）。
      assert.ok(
        turnSource.includes("**定案通知由系统统一发**") &&
          turnSource.includes("不要再用 contactPerson 发一遍"),
        "成立那一刻的回执要说清通知归代码发"
      );
      assert.ok(
        turnSource.includes("**回一两句就行，不用把规则原文再念一遍**"),
        "回复不许把规则原文再念一遍——那正是 064 里回复里出现两遍规则的原因"
      );
      assert.ok(
        turnSource.includes("不要替还没发出去的通知打包票"),
        "也不许替还没发出的通知打包票"
      );
      assert.ok(
        turnSource.includes(
          "**成立的条件是每个人都明确同意，不是每个人都回过话**"
        ),
        "成立条件是「每个人都明确同意」，不是「每个人都回过话」（065 第 1 轮把这两件事说混了）"
      );
      assert.ok(
        turnSource.includes("**共同规则的定案通知一般不用你发**"),
        "contactPerson 自己的说明里也要说清：定案通知一般不该由它发"
      );
      /**
       * 这条原来钉的是一句**已过时的字面量**（`**你发出去的是他交办的事或他们商定的
       * 安排，`）。2026-10-06 按 065 第 1 轮的真实出站（`A proposal for the house:
       * each of us washes our own dishes`）把这段说明改成了转达口径，字面量随之作废，
       * 但**要守的边界没变、而且更细了**：不是"不许拟提案"，是"未商定的草案不许说成
       * 已经定下、派给对方的义务"，并且**不许把 AI 自己算进「我们 / 大家」**。
       *
       * 所以这里改钉**当前口径**本身，不钉旧句子，也不改成一份禁词表（判据是"商定没
       * 商定"，不是词表——「你的那份」在已经商定好的分工里是正当说法）。
       */
      assert.ok(
        turnSource.includes("**你是替住户转达，不是住在这里的人**") &&
          turnSource.includes(
            "**也不要把你自己算进「我们」「大家」「每个人」里**"
          ),
        "工具说明必须写明这是替住户转达、AI 不住在这里：不许把自己放在上位、也不许" +
          "把自己算进「我们 / 大家」（065 第 1 轮的 `each of us washes` 就是把自己" +
          "算成了同住的人）"
      );
      assert.ok(
        turnSource.includes("**拟提案本身没问题**") &&
          turnSource.includes("**已经商定好的分工照实转达**") &&
          turnSource.includes("这类如实说明照说"),
        "边界要说全三件**允许**的事：可以拟待商定的提案、可以照实转达已经商定好的" +
          "分工、可以照实说工具真的做过的动作——只禁「把未商定的草案说成已定下的义务」"
      );
    }
  );

  await check("turn.ts：只在相关轮次扫台账，且通知也过同一条出站闸", () => {
    const dispatchAt = turnSource.indexOf("await dispatchPendingFinalNotices({");
    const guardAt = turnSource.indexOf(
      "await enforceOutboundGate(noticeOutbound);"
    );
    assert.ok(dispatchAt >= 0 && guardAt > dispatchAt, "通知要过确定性出站闸");
    assert.ok(
      turnSource.includes("if (noticeOutbound.length > 0) {"),
      "没发通知时不该多跑一次闸"
    );
  });
}

async function main(): Promise<void> {
  await pureChecks();
  await fatalChecks();
  await dispatchChecks();
  await singleNoticePerPersonChecks();
  await sourceChecks();
  console.log(
    `\nfinal-notice：${checks} 项全过（零模型、零短信、零数据库、零 schema 改动）。`
  );
}

main().catch((error) => {
  console.error("\nFAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
