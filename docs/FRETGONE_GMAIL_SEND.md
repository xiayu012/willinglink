# FretGone Gmail sending primitive

`lib/fretgone/gmail-send.ts` provides `sendGmailMessage` to server-side code. It uses the existing `GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET` and `GOOGLE_GMAIL_REFRESH_TOKEN` for the authorized Workspace mailbox. It accepts To, optional Cc, subject and plain-text body, and returns Gmail message and thread IDs on success. The function does not decide when to send and is not exposed as an HTTP endpoint.

The caller is responsible for authorization, storing the request and result, and deciding what to do if the result is uncertain. A network timeout, server error or unreadable success response can occur after Gmail accepted the message. `GmailSendError.outcome` is `unknown` in these cases: inspect Sent and reconcile before retrying; blindly retrying can send duplicates. A successful API response is acceptance by Gmail, not proof of delivery or reading. This primitive is not a durable queue or a complete automatic sending workflow.

For a reply, pass `reply.threadId`, the original RFC `Message-ID` as `reply.messageId`, and any prior RFC `References` as `reply.references`. Use the original subject and an explicitly selected recipient. The primitive supplies Gmail's thread ID and the reply headers described in Google's [sending guide](https://developers.google.com/workspace/gmail/api/guides/sending). A Gmail message ID is not an RFC Message-ID. This support does not start automatic replies: a future caller must retrieve the original headers, decide when and to whom to reply, and reconcile uncertain sends.

Offline check: `cross-env NODE_OPTIONS=--conditions=react-server tsx scripts/fretgone-gmail-send-selftest.ts`. It uses a mocked transport and does not send mail.

The Gmail polling worker also sends a temporary `test idr` reply for new inbound messages that mention IDR in the body and explicitly CC the watched mailbox. It records its send state in `fretgone.gmail_idr_auto_reply` before attempting to send; `sending` or `unknown` requires manual review because the outcome could be uncertain. It does not automatically reply to old mail scanned during history recovery. Messages without an identifiable sender, subject, RFC Message-ID, thread, or explicit CC are skipped. Deduplication is still per Gmail thread: the thread primary key prevents a second claim and therefore a second reply.

## IDR auto-reply worker

The worker sends through the Gmail API so the original sender and all visible
To/Cc participants (except the FretGone mailbox) appear in To, with no Cc
header. It supplies the original Gmail thread ID, In-Reply-To and References,
and uses the persisted sender name in the From header. The former Apps Script
replyAll path remains in the repository for reference but is not used.

A sender name is chosen once per Gmail thread and stored in
`fretgone.gmail_idr_auto_reply.sender_name`. Apply the additive migration
`lib/db/migrations/manual/fretgone-gmail-idr-sender-name.sql` before deployment.
The worker uses the existing Gmail OAuth credentials and Gmail send permission.
A failed or uncertain send is recorded as unknown and is never retried
automatically; reconcile it before any manual retry.

Run `pnpm --dir workers/gmail test` for offline checks.
