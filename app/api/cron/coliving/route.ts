import { runOutreach } from "@/lib/chat/coliving/outreach";
import { markCommunication, sendSmsOrSkip } from "@/lib/chat/coliving/deliver";

/**
 * 合租房管理员的主动发起。**严格口径（2026-09-12）起已停用出站。**
 *
 * 原本做四件事：回访冷掉的事 · 问全共同规则 · 接触新住户 · 到期提醒，
 * 每一件都由模型自由写一条短信发给住户。严格口径要求收回所有自由文本的
 * 第三方出站，只保留 `personal-item-reminder.ts` 那一个程序化受约束的
 * 功能，因此 `runOutreach()` 现在直接返回空数组，下方投递循环空转。
 *
 * **保留这条路由与投递结构**：投递写的仍是已授权排队消息的既有链路
 * （Twilio 短信，合租房唯一实时渠道），本次不改。要重新开放主动发起，改 outreach.ts。
 *
 * 认证：Vercel Cron 会带 `Authorization: Bearer $CRON_SECRET`。
 * 没设 CRON_SECRET 时只允许本机调用，避免裸奔。
 */
export const maxDuration = 300;
export const preferredRegion = "sfo1";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    // 没配密钥就只让本地跑，别在公网上裸奔
    return process.env.NODE_ENV !== "production";
  }
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return new Response("unauthorized", { status: 401 });
  }
  if (process.env.COLIVING_OUTREACH_OFF === "1") {
    return Response.json({ ok: true, skipped: "COLIVING_OUTREACH_OFF=1" });
  }

  try {
    const results = await runOutreach();

    let sent = 0;
    for (const r of results) {
      for (const m of r.messages) {
        const outcome = await sendSmsOrSkip(m.to, m.text);
        await markCommunication({
          communicationId: m.communicationId,
          status: outcome.ok ? "sent" : "failed",
          externalMessageId: outcome.ok ? outcome.externalMessageId : null,
          error: outcome.ok ? null : outcome.error,
        });
        if (outcome.ok) {
          sent++;
        }
      }
    }

    console.log(
      "[cron/coliving]",
      JSON.stringify({
        households: results.length,
        sent,
        jobs: results.flatMap((r) => r.jobs),
      })
    );
    return Response.json({ ok: true, sent, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("[cron/coliving] failed", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
