create table if not exists chats (
  phone text primary key,
  name text,
  last_timestamp bigint default 0,
  last_preview text
);

create table if not exists messages (
  id bigserial primary key,
  phone text not null,
  direction text check (direction in ('in','out')) not null,
  type text default 'text',
  text text,
  template_name text,
  timestamp bigint not null
);

create index if not exists idx_messages_phone_time on messages(phone, timestamp);

create table if not exists templates_cache (
  id bigserial primary key,
  name text not null,
  language text,
  status text,
  category text,
  last_synced_at timestamptz default now()
);
