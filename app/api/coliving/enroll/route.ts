import { after } from "next/server";
import { sendSmsOrSkip } from "@/lib/chat/coliving/deliver";
import { kickoffFirstContact } from "@/lib/chat/coliving/outreach";
import { enrollFirstContact, markCommunication } from "@/lib/chat/coliving/repo";

/**
 * 第一个号码入库 —— **整个系统的起点**。
 *
 * 用户先把拿到的号码写进本地那个 csv；`pnpm coliving:watch` 监听文件保存，
 * 把号码 POST 到这里。这里建房子 + 建一个**还不知道是谁的联系人**——
 * **号码本身不说明他是谁，也不说明他住不住这儿**（房东、租客、宿管、物业、
 * 中介都可能先给号码）。角色与居住留空，等对话里听出来再补。
 *
 * **这条路由不投递任何消息**：严格口径（2026-09-12）收回了自由文本的第三方
 * 出站，`kickoffFirstContact` 现在返回空，下面的投递循环因此空转——结构保留，
 * 是为了让「重新开放主动发起」时改动只落在 outreach.ts 一个文件里。
 *
 * 其余号码由 AI 在对话里问出来，用 addResident 加进去。
 * **没有加入码、没有表格、没有注册，也不要求任何人先声明身份。**
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
      const r = await enrollFirstContact({
        phone,
        label: typeof body.label === "string" ? body.label : null,
      });
      results.push({ phone, created: r.created });

      // 新建的才走开张流程；已经在库里的不要重复处理。
      // kickoffFirstContact 现在返回空，这个循环不会投递任何东西——保留结构，
      // 是为了让「重新开放主动发起」时改动只落在 outreach.ts 一个文件里。
      if (r.created) {
        after(async () => {
          const messages = await kickoffFirstContact({
            householdId: r.householdId,
            personId: r.personId,
          });
          // kickoffFirstContact 只落库成 queued，**投递是调用方的事**——
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
