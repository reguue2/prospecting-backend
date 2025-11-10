import pg from "pg";
const { Pool } = pg;

let pool;

export function initDB() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Falta DATABASE_URL");
  }

  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  return pool;
}

export async function ensureSchema() {
  const p = initDB();
  // OJO: este esquema alinea con tu BD real pegada en el mensaje
  await p.query(`
    CREATE TABLE IF NOT EXISTS chats (
      phone TEXT PRIMARY KEY,
      name TEXT,
      last_timestamp BIGINT DEFAULT 0,
      last_preview TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      direction TEXT CHECK (direction IN ('in','out')) NOT NULL,
      type TEXT DEFAULT 'text',
      text TEXT,
      template_name TEXT,
      timestamp BIGINT NOT NULL,
      media_url TEXT,
      is_read BOOLEAN DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_phone_time ON messages(phone, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(phone, is_read) WHERE is_read = false;

    CREATE TABLE IF NOT EXISTS templates_cache (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      language TEXT,
      status TEXT,
      category TEXT,
      last_synced_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id BIGSERIAL PRIMARY KEY,
      received_at TIMESTAMPTZ DEFAULT NOW(),
      payload JSONB
    );
  `);
}

export async function upsertChat(client, { phone, preview, ts }) {
  await client.query(
    `
    INSERT INTO chats(phone, name, last_timestamp, last_preview)
    VALUES($1, NULL, $2, $3)
    ON CONFLICT (phone)
    DO UPDATE SET
      last_timestamp = EXCLUDED.last_timestamp,
      last_preview   = EXCLUDED.last_preview
    `,
    [phone, ts, preview ?? null]
  );
}

export async function insertMessage(msg) {
  const p = initDB();
  const client = await p.connect();
  try {
    await client.query(
      `
      INSERT INTO messages (phone, direction, type, text, template_name, timestamp, media_url, is_read)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        msg.phone,
        msg.direction,                    // 'in' | 'out'
        msg.type || 'text',               // 'text' | 'template' | 'image' | 'document' | 'video'...
        msg.text ?? null,
        msg.template_name ?? null,
        msg.timestamp,                    // en segundos
        msg.media_url ?? null,
        msg.is_read ?? false
      ]
    );

    // mantener chats
    const preview =
      msg.text ??
      (msg.template_name ? `Plantilla: ${msg.template_name}` : (msg.type || 'media'));
    await upsertChat(client, {
      phone: msg.phone,
      preview,
      ts: msg.timestamp,
    });
  } finally {
    client.release();
  }
}
