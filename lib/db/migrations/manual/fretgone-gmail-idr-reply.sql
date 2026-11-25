create table if not exists fretgone.gmail_idr_auto_reply (
  gmail_thread_id text primary key,
  source_message_id text not null unique,
  status text not null check (status in ('sending', 'sent', 'unknown')),
  sent_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
