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

create table if not exists fretgone.gmail_inbound_email (
  gmail_message_id text primary key,
  gmail_thread_id text,
  history_id text not null,
  received_at timestamptz,
  sender text,
  recipients text[] not null default '{}',
  subject text not null,
  body text not null,
  body_truncated boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists gmail_inbound_email_received_at_idx
  on fretgone.gmail_inbound_email (received_at desc);

create table if not exists fretgone.gmail_case_assessment (
  id bigserial primary key,
  gmail_message_id text not null references fretgone.gmail_inbound_email(gmail_message_id),
  model_id text not null,
  prompt_version text not null,
  input_subject text not null,
  input_body text not null,
  raw_model_output text not null,
  is_case boolean not null,
  reason text not null,
  error text,
  assessed_at timestamptz not null default now()
);

create table if not exists fretgone.case (
  case_number bigserial primary key,
  source_gmail_message_id text not null unique references fretgone.gmail_inbound_email(gmail_message_id),
  source_assessment_id bigint not null references fretgone.gmail_case_assessment(id),
  created_at timestamptz not null default now()
);
