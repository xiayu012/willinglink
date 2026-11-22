import { gmailConfig, renewWatch } from "@/lib/fretgone/gmail-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Renew daily: Gmail watch registrations expire within seven days. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  if (!secret && process.env.NODE_ENV === "production") {
    return new Response("CRON_SECRET is required", { status: 503 });
  }
  try {
    const state = await renewWatch(gmailConfig());
    return Response.json({ ok: true, historyId: state.historyId, expiration: state.expiration });
  } catch (error) {
    console.error(
      "[fretgone/gmail-watch] renewal failed",
      error instanceof Error ? error.message : String(error)
    );
    return new Response("watch renewal failed", { status: 500 });
  }
}
