import type { Metadata } from "next";

import { readCoordinationHistory } from "@/lib/coordination-history/read";
import { HistoryCanvas } from "./history-canvas";

/**
 * 公开只读的协调历史页。URL 直接发给别人就能打开：
 *   https://www.willinglink.com/coordination-history
 *   https://www.willinglink.com/coordination-history?h=<房子 id>
 *
 * 不挂首页任何入口 —— 它不是一个产品功能，是给合作方看数据用的窗口。
 */
export const metadata: Metadata = {
  title: "Coordination history · WillingLink",
  description: "Read-only view of coordination threads across households.",
  // 公开可访问，但不进搜索引擎：这个链接是发给特定的人看的
  robots: { index: false, follow: false },
};

// 每次打开都重新读库。静态化会把这页冻在构建那一刻的数据上，
// 演示时看到的就是过期记录。
export const dynamic = "force-dynamic";

export default async function CoordinationHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ h?: string }>;
}) {
  const [data, params] = await Promise.all([
    readCoordinationHistory(),
    searchParams,
  ]);

  return (
    <HistoryCanvas
      households={data.households}
      emptyHouseholdCount={data.emptyHouseholdCount}
      initialHouseholdId={params.h ?? null}
    />
  );
}
