# Gmail send receipts

FretGone detects a completed IDR/ADR email when the copied message reaches
`contact@fretgone.com`. When a homeowner opens an email draft, the site records
an anonymous six-hour send window; a copied email arriving in that window is
matched to that click. This deliberately does **not** depend on the subject,
which the homeowner is free to change. It does not access the homeowner's
mailbox, send email, or store email bodies. A receipt is evidence that the
FretGone mailbox received the copied email; it is not a claim that every
recipient read it.

## One-time Google Cloud setup

1. Create or choose a Google Cloud project and enable **Gmail API** and
   **Cloud Pub/Sub API**.
2. Create topic `fretgone-gmail-receipts` (or choose another name). Grant
   `roles/pubsub.publisher` on that topic to
   `gmail-api-push@system.gserviceaccount.com`.
3. Create a dedicated service account such as `pubsub-push`. Create a **push**
   subscription on the topic with this HTTPS endpoint:
   `https://fretgone.com/api/fretgone/gmail/push`.
   Enable authentication, select that service account, and use the identical
   endpoint URL as its OIDC audience. Grant Pub/Sub's service agent the Token
   Creator permission if Google Cloud asks for it.
4. In Google Cloud Credentials, create a Web application OAuth client. Request
   only `https://www.googleapis.com/auth/gmail.metadata` for
   `contact@fretgone.com`; obtain an offline refresh token and put it in the
   Vercel environment. Do not put a token in source control.
5. Add the environment variables in `.env.example` to Vercel Production and
   Preview as appropriate. Run the SQL file in
   `lib/db/migrations/manual/fretgone-gmail-receipts.sql` against the production
   Neon database.
6. Deploy. Visit Vercel's cron logs after the next daily run; it calls Gmail
   `watch` again before the seven-day expiration.

## First controlled test

After the database migration, variables, Pub/Sub subscription, and deployment
are all in place, click **Open email draft**, send it to a mailbox you control,
and leave `contact@fretgone.com` copied. The Pub/Sub push endpoint should return
200, and a single metadata-only row should appear in
`fretgone.gmail_send_receipt` with `match_status = 'matched'`. Sending the same
message again must not create a second row for the same Gmail message ID.

## Operational limits

- Gmail can delay or occasionally drop a push notification; its history API and
  the daily renewed watch are the recovery mechanism.
- If Gmail says the stored history ID is too old, the listener sets a new
  baseline and deliberately does not import the old inbox as new receipts.
- If more than one draft is opened during the same six-hour window, the receipt
  is marked `ambiguous` rather than being guessed onto the wrong draft.
- Google may require OAuth consent-screen verification for wider deployment.
