# FretGone Gmail sending primitive

`lib/fretgone/gmail-send.ts` provides `sendGmailMessage` to server-side code. It uses the existing `GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET` and `GOOGLE_GMAIL_REFRESH_TOKEN` for the authorized Workspace mailbox. It accepts To, optional Cc, subject and plain-text body, and returns Gmail message and thread IDs on success. The function does not decide when to send and is not exposed as an HTTP endpoint.

The caller is responsible for authorization, storing the request and result, and deciding what to do if the result is uncertain. A network timeout, server error or unreadable success response can occur after Gmail accepted the message. `GmailSendError.outcome` is `unknown` in these cases: inspect Sent and reconcile before retrying; blindly retrying can send duplicates. A successful API response is acceptance by Gmail, not proof of delivery or reading. This primitive is not a durable queue or a complete automatic sending workflow.

For a reply, pass `reply.threadId`, the original RFC `Message-ID` as `reply.messageId`, and any prior RFC `References` as `reply.references`. Use the original subject and an explicitly selected recipient. The primitive supplies Gmail's thread ID and the reply headers described in Google's [sending guide](https://developers.google.com/workspace/gmail/api/guides/sending). A Gmail message ID is not an RFC Message-ID. This support does not start automatic replies: a future caller must retrieve the original headers, decide when and to whom to reply, and reconcile uncertain sends.

Offline check: `cross-env NODE_OPTIONS=--conditions=react-server tsx scripts/fretgone-gmail-send-selftest.ts`. It uses a mocked transport and does not send mail.

The Gmail polling worker also sends a temporary `test idr` reply for new inbound messages that mention IDR in the body and explicitly CC the watched mailbox. It records its send state in `fretgone.gmail_idr_auto_reply` before attempting to send; `sending` or `unknown` requires manual review because the outcome could be uncertain. It does not automatically reply to old mail scanned during history recovery. Messages without an identifiable sender, subject, RFC Message-ID, thread, or explicit CC are skipped. Deduplication is still per Gmail thread: the thread primary key prevents a second claim and therefore a second reply.

## IDR auto-reply worker

`workers/gmail/poller.mjs` sends the reply through the Apps Script project in
`workers/gmail/apps-script/`, invoked with the Apps Script API `scripts.run`
method. The official `scripts.run` URL takes the API Executable **deployment
ID**, not the script ID from Project Settings:

`https://script.googleapis.com/v1/scripts/{deploymentId}:run`

The script calls
`GmailApp.getMessageById(sourceMessageId).replyAll(body, { name: displayName })`,
which preserves the original thread and reply-all recipient set (original
sender plus original To/Cc recipients). The worker never falls back to a
nameless Gmail API send.

`GmailMessage.replyAll` returns **the original GmailMessage for chaining**, not
the message it sent. Its `getId()` is therefore the source message ID and must
never be recorded as a sent-message ID. The script returns only
`{ accepted: true, threadId }` using the original thread ID, and the worker
records `status = 'sent'` with `sent_message_id = null`. A separately verified
sent ID may be recorded later, but nothing in this path claims one.

The sender display name is chosen once per Gmail thread and persisted in
`fretgone.gmail_idr_auto_reply.sender_name` when the first claim is inserted.
Names come from a fixed list of familiar first names and use the format
`Name | FretGone`, including `Daniel | FretGone`, `Michael | FretGone`, and
`David | FretGone`. Every later message in the same thread keeps the persisted
name. Apply
`lib/db/migrations/manual/fretgone-gmail-idr-sender-name.sql` before enabling
auto-replies; it is strictly additive (no `DROP`) and safe to re-run.

Configuration:

- `GOOGLE_APPS_SCRIPT_DEPLOYMENT_ID` (optional): the **deployment ID** of the
  API Executable deployment. If it is unset or invalid, IDR auto-replies are
  disabled with a warning and receipt ingestion continues.
- `GOOGLE_APPS_SCRIPT_FUNCTION` (optional, default `sendIdrReply`): the
  function name to execute.
- The existing `GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET`, and
  `GOOGLE_GMAIL_REFRESH_TOKEN` are reused unchanged, but the **grant** behind
  `GOOGLE_GMAIL_REFRESH_TOKEN` is used both for Gmail API reads and as the
  caller of `scripts.run`. Per the official documentation, that grant must
  cover **every scope the Apps Script project uses**; for the current script
  that is `https://mail.google.com/` (for built-in `GmailApp`), in addition to
  the existing Gmail API scopes. Re-issue the refresh token if the current
  grant lacks any of them.
  The Apps Script project must be deployed as an API executable with access
  `MYSELF`.
- The Apps Script manifest declares the restricted `https://mail.google.com/`
  scope used by built-in `GmailApp`, and the script owner must run `authorize`
  once in the Apps Script editor. That editor authorization grants the script
  itself access, but it does **not** replace the caller scopes above: the
  OAuth grant behind `GOOGLE_GMAIL_REFRESH_TOKEN` must contain the same scopes.
  See `workers/gmail/apps-script/README.md` for the manual setup.

If the Apps Script deployment ID is missing, the function name is invalid, or
the additive `sender_name` migration cannot be verified as present, the worker
logs a warning and disables IDR auto-replies. It still ingests receipts; it
never sends an unnamed fallback. If `scripts.run` times out, returns an HTTP
error, reports an execution error, or returns an incomplete or mismatched
thread result, the receipt is marked `unknown` and is not retried
automatically.

Offline checks (mocked Gmail and Apps Script; no mail is sent):

```bash
pnpm fretgone:gmail-worker-test
# or: cd workers/gmail && npm test
```
