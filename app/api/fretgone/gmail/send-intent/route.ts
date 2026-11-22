import { recordSendIntent } from "@/lib/fretgone/gmail-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A short-lived, anonymous timestamp used to match a later CC by time. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const kind = body && typeof body === "object" ? (body as { kind?: unknown }).kind : null;
  if (kind !== "idr" && kind !== "adr") {
    return new Response("expected IDR or ADR", { status: 400 });
  }
  try {
    await recordSendIntent(kind);
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error(
      "[fretgone/send-intent] failed",
      error instanceof Error ? error.message : String(error)
    );
    // Draft opening remains useful even if the optional receipt tracker is temporarily unavailable.
    return new Response(null, { status: 204 });
  }
}
