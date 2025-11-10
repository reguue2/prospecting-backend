import pg from "pg";
const { Pool } = pg;

let pool;

export function initDB() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("❌ Falta DATABASE_URL en variables de entorno");
  }

  pool = new Pool({
    connectionString,
    ssl: {
      rejectUnauthorized: false, // Render requiere SSL
    },
  });

  console.log("✅ Base de datos conectada correctamente (Render PostgreSQL)");
  return pool;
}

export async function ensureSchema() {
  const p = initDB();
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
      timestamp BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_phone_time ON messages(phone, timestamp);

    CREATE TABLE IF NOT EXISTS templates_cache (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      language TEXT,
      status TEXT,
      category TEXT,
      last_synced_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("🛠️ Esquema verificado correctamente");
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
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO messages (chat_phone, sender, text, timestamp, is_read)
       VALUES ($1, $2, $3, $4, $5)`,
      [msg.chat_phone, msg.sender, msg.text, msg.timestamp, msg.is_read ?? false]
    );
  } finally {
    client.release();
  }
}


