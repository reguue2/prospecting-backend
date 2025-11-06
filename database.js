import pg from "pg";
import { createProxy } from "pg-ipv6-proxy";

const { Pool } = pg;

let pool;

export async function initDB() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Falta DATABASE_URL");

  // Creamos proxy que traduce IPv4 -> IPv6
  const proxy = await createProxy({
    remoteHost: "db.kjgbttacpirkaydjjsp.supabase.co",
    remotePort: 5432,
  });

  pool = new Pool({
    connectionString,
    host: "127.0.0.1", // usamos el proxy local
    port: proxy.localPort,
    ssl: { rejectUnauthorized: false },
  });

  console.log("✅ Base de datos conectada (a través de proxy IPv6)");
  return pool;
}

export async function ensureSchema() {
  const p = await initDB();
  await p.query(`
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
  `);
}

export async function upsertChat(client, { phone, preview, ts }) {
  await client.query(
    `
    insert into chats(phone, name, last_timestamp, last_preview)
    values($1, null, $2, $3)
    on conflict (phone) do update set
      last_timestamp = excluded.last_timestamp,
      last_preview   = excluded.last_preview
    `,
    [phone, ts, preview ?? null]
  );
}

export async function insertMessage(client, { phone, direction, type, text, template_name, ts }) {
  await client.query(
    `
    insert into messages(phone, direction, type, text, template_name, timestamp)
    values($1,$2,$3,$4,$5,$6)
    `,
    [phone, direction, type || "text", text ?? null, template_name ?? null, ts]
  );
}
