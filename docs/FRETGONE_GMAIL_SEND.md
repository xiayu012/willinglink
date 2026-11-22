# FretGone Gmail sending primitive

`lib/fretgone/gmail-send.ts` provides `sendGmailMessage` to server-side code. It uses the existing `GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET` and `GOOGLE_GMAIL_REFRESH_TOKEN` for the authorized Workspace mailbox. It accepts To, optional Cc, subject and plain-text body, and returns Gmail message and thread IDs on success. The function does not decide when to send and is not exposed as an HTTP endpoint.

The caller is responsible for authorization, storing the request and result, and deciding what to do if the result is uncertain. A network timeout, server error or unreadable success response can occur after Gmail accepted the message. `GmailSendError.outcome` is `unknown` in these cases: inspect Sent and reconcile before retrying; blindly retrying can send duplicates. A successful API response is acceptance by Gmail, not proof of delivery or reading. This primitive is not a durable queue or a complete automatic sending workflow.

Before implementing replies in an existing Gmail conversation, add thread-aware behavior including RFC Message-ID headers as described in Google's [sending guide](https://developers.google.com/workspace/gmail/api/guides/sending). The current primitive starts a new message.

Offline check: `cross-env NODE_OPTIONS=--conditions=react-server tsx scripts/fretgone-gmail-send-selftest.ts`. It uses a mocked transport and does not send mail.
