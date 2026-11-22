-- FretGone Gmail send receipts. Apply once in Neon SQL Editor or with:
-- psql "$POSTGRES_URL" -f lib/db/migrations/manual/fretgone-gmail-receipts.sql
-- Safe to run again. No email body is ever stored.

create schema if not exists fretgone;

create table if not exists fretgone.gmail_watch_state (
  mailbox text primary key,
  history_id text not null,
  watch_expiration timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists fretgone.gmail_send_receipt (
  gmail_message_id text primary key,
  gmail_thread_id text,
  history_id text not null,
  received_at timestamptz,
  sender text,
  recipients text[] not null default '{}',
  subject text not null,
  intent_id text,
  kind text check (kind in ('idr', 'adr')),
  match_status text not null default 'unmatched'
    check (match_status in ('matched', 'unmatched', 'ambiguous')),
  created_at timestamptz not null default now()
);

create index if not exists gmail_send_receipt_received_at_idx
  on fretgone.gmail_send_receipt (received_at desc);

create table if not exists fretgone.gmail_send_intent (
  id text primary key,
  kind text not null check (kind in ('idr', 'adr')),
  initiated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'matched')),
  matched_message_id text unique,
  matched_at timestamptz
);

create index if not exists gmail_send_intent_pending_idx
  on fretgone.gmail_send_intent (initiated_at desc)
  where status = 'pending';
