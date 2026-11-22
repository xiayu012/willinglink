# Gmail send receipts

FretGone treats `contact@fretgone.com` as an internal case intake mailbox.
Every newly received email is read by the case classifier; when the model judges
that it starts or materially concerns an HOA dispute, FretGone creates an
internal case number. This does not require a website click or a particular
subject line. The system stores the email text supplied to the model, the raw
model output, decision, model version, and any error so every judgment can be
debugged later.

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
   only `https://www.googleapis.com/auth/gmail.readonly` for
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
are all in place, send a controlled HOA-dispute email to or copied to
`contact@fretgone.com`. The Pub/Sub endpoint should return 200. Its mail record,
model assessment, and—if classified as a case—numeric case number should appear
in `fretgone.gmail_inbound_email`, `fretgone.gmail_case_assessment`, and
`fretgone.case`.

## Operational limits

- Gmail can delay or occasionally drop a push notification; its history API and
  the daily renewed watch are the recovery mechanism.
- If Gmail says the stored history ID is too old, the listener sets a new
  baseline and deliberately does not import the old inbox as new receipts.
- Attachments are not read or classified in this first version; only inline text
  is retained and assessed.
- Google may require OAuth consent-screen verification for wider deployment.
