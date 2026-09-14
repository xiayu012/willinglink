import assert from "node:assert/strict";

import { EMPTY_FEATURE_USAGE, type FeatureLlm } from "./feature-llm";
import type { FeatureContext, FeatureDeps } from "./feature-types";
import { runApprovedFeature } from "./features";

// 离线断言脚本：模型调用全部走注入的 fake FeatureLlm，不触网 / 数据库 / 短信。
const ID = "ask-named-roommate-clean-shower-drain-hair";
const GOOD = "请叫阿川把地漏里的头发清掉";
const ROUTE_USAGE = { ...EMPTY_FEATURE_USAGE, steps: 1, inputTokens: 7 };

type Call = Parameters<FeatureLlm["generate"]>[0];

/** fake：路由恒返回 `blocked:<ID>`，并把每次调用记进 calls。 */
function makeDeps(calls: Call[]): FeatureDeps {
  const llm: FeatureLlm = {
    async generate(call) {
      calls.push(call);
      return { text: `blocked:${ID}`, usage: { ...ROUTE_USAGE } };
    },
  };
  return {
    llm,
    // 黑名单 / none 路径都不投递，delivery 不会触达。
    delivery: {} as FeatureDeps["delivery"],
  };
}

function makeCtx(text: string): FeatureContext {
  return {
    text,
    members: [],
    senderPersonId: "person-sender",
    householdId: "household-1",
    channel: "sms",
    senderIsTest: true,
  };
}

async function main(): Promise<void> {
  // 1. 精确授权 => 撤销黑名单拒绝、标准 none，路由仍调用一次、用量保留。
  {
    const calls: Call[] = [];
    const run = await runApprovedFeature(GOOD, makeCtx(GOOD), makeDeps(calls), {
      grantedFeatureIds: [ID],
    });
    assert.equal(run.mode, "none");
    assert.equal(run.featureId, null);
    assert.equal(run.blacklistedCapabilityId, null);
    assert.equal(calls.length, 1);
    assert.deepEqual(run.usage, ROUTE_USAGE);
  }

  // 2. 省略 options => 默认拒绝：blacklisted 且 handling 非空。
  {
    const calls: Call[] = [];
    const run = await runApprovedFeature(GOOD, makeCtx(GOOD), makeDeps(calls));
    assert.equal(run.mode, "blacklisted");
    assert.notEqual(run.handling, null);
    assert.equal(run.blacklistedCapabilityId, ID);
  }

  // 3. 只差一个后缀的邻近 id 不算精确授权 => 仍 blacklisted。
  {
    const calls: Call[] = [];
    const run = await runApprovedFeature(GOOD, makeCtx(GOOD), makeDeps(calls), {
      grantedFeatureIds: [`${ID}-adjacent`],
    });
    assert.equal(run.mode, "blacklisted");
  }

  // 4. 精确授权，但原话是浴室墙面头发 => qualifier 先失败，落回 none。
  {
    const calls: Call[] = [];
    const run = await runApprovedFeature(
      "请叫阿川把浴室墙面的头发清掉",
      makeCtx("请叫阿川把浴室墙面的头发清掉"),
      makeDeps(calls),
      { grantedFeatureIds: [ID] }
    );
    assert.equal(run.mode, "none");
    assert.equal(run.handling, null);
    assert.equal(run.blacklistedCapabilityId, null);
  }

  console.log("features grant tests: 4/4 passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
