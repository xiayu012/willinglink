-- Stable sender display name for each Gmail thread's IDR auto-reply.
-- Apply once in the Neon SQL Editor or with:
-- psql "$POSTGRES_URL" -f lib/db/migrations/manual/fretgone-gmail-idr-sender-name.sql
-- Strictly additive and safe to run again: the single ADD COLUMN IF NOT EXISTS
-- statement works in Neon's SQL tooling and never drops or rewrites existing
-- data. New auto-reply claims always write sender_name. Existing rows predate
-- this column and are never re-sent automatically, so they may remain null.
-- The worker validates the "Name | FretGone" format in code before sending.

alter table fretgone.gmail_idr_auto_reply
  add column if not exists sender_name text;
