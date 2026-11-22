-- Additive Gmail polling state and separately stored To / Cc headers.
create schema if not exists fretgone;
create table if not exists fretgone.gmail_poll_state (
  mailbox text primary key,
  history_id text not null,
  updated_at timestamptz not null default now()
);
alter table fretgone.gmail_inbound_email add column if not exists to_header text;
alter table fretgone.gmail_inbound_email add column if not exists cc_header text;
create index if not exists gmail_inbound_email_thread_idx on fretgone.gmail_inbound_email (gmail_thread_id);
