import {
  gmailConfig,
  parsePubSubNotification,
  synchronizeReceiptMailbox,
  verifyPubSubOidc,
} from "@/lib/fretgone/gmail-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Google Cloud Pub/Sub delivers Gmail Inbox changes here. */
export async function POST(request: Request) {
  // Retired: the polling daemon owns ingestion; no AI assessments are run.
  return new Response("Gmail push is retired", { status: 410 });
  /*
  let config;
  try {
    config = gmailConfig();
  } catch (error) {
    console.error("[fretgone/gmail-push] configuration error", error);
    return new Response("listener not configured", { status: 503 });
  }
  if (!(await verifyPubSubOidc(request, config))) {
    return new Response("invalid Pub/Sub identity", { status: 401 });
  }
  try {
    const event = parsePubSubNotification(await request.json());
    if (event.emailAddress !== config.watchedAddress) {
      return new Response("unexpected watched mailbox", { status: 400 });
    }
    const result = await synchronizeReceiptMailbox(config, event.historyId);
    console.log("[fretgone/gmail-push]", JSON.stringify(result));
    return Response.json({ ok: true, ...result });
  } catch (error) {
    console.error(
      "[fretgone/gmail-push] failed",
      error instanceof Error ? error.message : String(error)
    );
    return new Response("temporary receipt processing failure", { status: 500 });
  }
  */
}
