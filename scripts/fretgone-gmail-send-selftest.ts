import assert from "node:assert/strict";
import { composeGmailMessage, GmailSendError, sendGmailMessage } from "../lib/fretgone/gmail-send";

async function main() {
  const message = { to: ["test@example.com"], cc: ["board@example.com"], subject: "测试 HOA", text: "First line\n第二行" };
  const raw = composeGmailMessage(message);
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(mime, /To: test@example\.com\r\nCc: board@example\.com/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  assert.equal(Buffer.from(mime.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString(), "First line\r\n第二行");
  assert.throws(() => composeGmailMessage({ ...message, subject: "hello\r\nBcc: bad@example.com" }));
  assert.throws(() => composeGmailMessage({ ...message, to: ["test@example.com\r\nBcc: bad@example.com"] }));
  let calls = 0;
  const deps = { accessToken: async () => "test-token", request: (async (_url, init) => {
    calls++;
    assert.equal(init?.method, "POST");
    assert.equal(JSON.parse(String(init?.body)).raw, raw);
    return Response.json({ id: "message-id", threadId: "thread-id" });
  }) as typeof fetch };
  assert.deepEqual(await sendGmailMessage(message, deps), { gmailMessageId: "message-id", gmailThreadId: "thread-id" });
  assert.equal(calls, 1);
  await assert.rejects(sendGmailMessage(message, { ...deps, request: async () => { throw new Error("timeout"); } }), (error: unknown) => error instanceof GmailSendError && error.outcome === "unknown");
  await assert.rejects(sendGmailMessage(message, { ...deps, request: async () => new Response(null, { status: 403 }) }), (error: unknown) => error instanceof GmailSendError && error.outcome === "rejected" && error.status === 403);
  await assert.rejects(sendGmailMessage(message, { ...deps, request: async () => new Response(null, { status: 503 }) }), (error: unknown) => error instanceof GmailSendError && error.outcome === "unknown");
  console.log("Gmail send self-test passed; no email was sent.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
