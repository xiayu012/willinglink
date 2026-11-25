# FretGone IDR reply Apps Script

This standalone Apps Script project sends the FretGone IDR auto-reply with a
dynamic sender display name. It is invoked by `workers/gmail/poller.mjs`
through the Apps Script API `scripts.run` method.

## Source

- `Code.gs` exposes `sendIdrReply(sourceMessageId, displayName, body)`. It calls
  `GmailApp.getMessageById(sourceMessageId).replyAll(body, { name: displayName })`
  and returns `{ accepted: true, threadId }` with the original thread ID.
  `GmailMessage.replyAll` returns the original message for chaining, so the
  script never reads its `getId()` and never reports a sent-message ID.
- `appsscript.json` uses the V8 runtime, the `https://mail.google.com/` scope
  required by built-in `GmailApp` methods, and API executable access `MYSELF`.
- `authorize()` exists only so the editor can prompt for Gmail authorization
  once before API execution.

The poller sends this request and treats any failure as an unknown outcome:

```json
{
  "function": "sendIdrReply",
  "parameters": ["<gmail message id>", "Daniel | FretGone", "test idr"],
  "devMode": false
}
```

## Setup (manual; not performed by this repository)

1. Create a **standalone** Apps Script project signed in as the account that
   owns `GOOGLE_GMAIL_REFRESH_TOKEN`.
2. Replace `Code.gs`. In Project Settings, enable "Show appsscript.json" and
   replace that manifest too.
3. Run `authorize` once in the Apps Script editor and grant the
   `https://mail.google.com/` scope. Built-in `GmailApp` methods require this
   restricted scope. This editor authorization grants the script itself
   access, but is **not** sufficient for API execution on its own: the OAuth
   token used to call `scripts.run` must also include this scope (step 7).
4. Enable the Apps Script API in the same Google Cloud project as the Gmail
   OAuth client.
5. Deploy > New deployment > type **API executable**; access **Only myself**.
6. Set `GOOGLE_APPS_SCRIPT_DEPLOYMENT_ID` to the **deployment ID** from
   Deploy > Manage deployments. The official `scripts.run` URL requires the API
   Executable deployment ID, not the script ID from Project Settings. Optionally
   set `GOOGLE_APPS_SCRIPT_FUNCTION` (default `sendIdrReply`).
7. The OAuth grant behind `GOOGLE_GMAIL_REFRESH_TOKEN` is used both for Gmail
   API reads and as the caller of `scripts.run`. Per the official documentation
   it must cover **every scope the Apps Script project uses** — for the current
   script that is `https://mail.google.com/` (for `GmailApp`) — in addition to
   the existing Gmail API scopes. Re-issue and update
   `GOOGLE_GMAIL_REFRESH_TOKEN` if the current grant lacks any of them.
   The existing `GOOGLE_GMAIL_CLIENT_ID` / `GOOGLE_GMAIL_CLIENT_SECRET` are
   reused unchanged.
8. Apply `lib/db/migrations/manual/fretgone-gmail-idr-sender-name.sql`. It is
   strictly additive and safe to re-run.

There is deliberately no nameless fallback. A missing deployment ID, invalid
function name, or missing `sender_name` column disables IDR auto-replies with a
warning but does not stop receipt ingestion. An Apps Script transport,
authorization, execution, or response failure marks the receipt `unknown` and
is never retried automatically. On acceptance the worker records
`status = 'sent'` with `sent_message_id = null`, because `replyAll` does not
expose a verified sent-message ID.

## Offline test

`node apps-script-source.test.mjs` loads `Code.gs` in a Node VM with a fake
`GmailApp`. It does not deploy, call Google APIs, or send mail.
