import { after } from "next/server";
import { sendSmsOrSkip } from "@/lib/chat/coliving/deliver";
import { kickoffLandlord } from "@/lib/chat/coliving/outreach";
import { enrollLandlord, markCommunication } from "@/lib/chat/coliving/repo";

/**
 * 房东入库 —— **整个系统的起点**。
 *
 * 用户先认识房东、先拿到房东的手机号，写进本地那个 csv；
 * `pnpm coliving:watch` 监听文件保存，把号码 POST 到这里。
 * 这里建房子 + 建房东。**不再主动发第一条消息**——严格口径（2026-09-12）
 * 收回了自由文本的第三方出站，`kickoffLandlord` 现在返回空，这条路由里
 * 的投递循环因此空转（见 outreach.ts 开头）。房东有事自己来问。
 *
 * 其余住户的号码由 AI 在跟房东的对话里问出来，用 addResident 加进去。
 * **没有加入码、没有表格、没有注册。**
 *
 * 鉴权：`Authorization: Bearer $CRON_SECRET`。没配就只允许本机。
 */
export const maxDuration = 120;
export const preferredRegion = "sfo1";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return process.env.NODE_ENV !== "production";
  }
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { phones?: unknown; label?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "expect json" }, { status: 400 });
  }

  const phones = Array.isArray(body.phones)
    ? body.phones.filter((p): p is string => typeof p === "string")
    : [];
  if (phones.length === 0) {
    return Response.json({ ok: false, error: "no phones" }, { status: 400 });
  }

  const results: Array<{ phone: string; created: boolean; error?: string }> = [];
  for (const phone of phones) {
    try {
      const r = await enrollLandlord({
        phone,
        label: typeof body.label === "string" ? body.label : null,
      });
      results.push({ phone, created: r.created });

      // 新建的才走开张流程；已经在库里的不要重复处理。
      // kickoffLandlord 现在返回空，这个循环不会投递任何东西——保留结构，
      // 是为了让「重新开放主动发起」时改动只落在 outreach.ts 一个文件里。
      if (r.created) {
        after(async () => {
          const messages = await kickoffLandlord({
            householdId: r.householdId,
            personId: r.personId,
          });
          // kickoffLandlord 只落库成 queued，**投递是调用方的事**——
          // 漏了这一步的表现是消息永远停在 queued，人什么都收不到。
          for (const m of messages) {
            const sent = await sendSmsOrSkip(m.to, m.text);
            await markCommunication({
              communicationId: m.communicationId,
              status: sent.ok ? "sent" : "failed",
              error: sent.ok ? null : sent.error,
            });
            if (!sent.ok) {
              console.log("[coliving/enroll] 发送失败：", sent.error);
            }
          }
        });
      }
    } catch (error) {
      results.push({
        phone,
        created: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log("[coliving/enroll]", JSON.stringify(results));
  return Response.json({ ok: true, results });
}
