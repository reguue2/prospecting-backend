import pg from "pg";
import dns from "dns";
const { Pool } = pg;

let pool;
/**
 * Inicializa la conexión al pool de PostgreSQL (Supabase)
 */
export function initDB() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Falta DATABASE_URL");
  }

  // Forzar IPv4 para Supabase
  dns.setDefaultResultOrder("ipv4first");

  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }, // requerido por Supabase
  });

  console.log("✅ Base de datos conectada correctamente (IPv4 preferido)");
  return pool;
}

/**
 * Crea las tablas necesarias si no existen
 */
export async function ensureSchema() {
  const p = initDB();
  console.log("🛠️ Verificando esquema de base de datos...");
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
      last_synced_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id BIGSERIAL PRIMARY KEY,
      received_at TIMESTAMPTZ DEFAULT now(),
      payload JSONB
    );
  `);
  console.log("✅ Esquema verificado correctamente");
}

/**
 * Inserta o actualiza un chat
 */
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

/**
 * Inserta un mensaje (entrante o saliente)
 */
export async function insertMessage(client, { phone, direction, type, text, template_name, ts }) {
  await client.query(
    `
    INSERT INTO messages(phone, direction, type, text, template_name, timestamp)
    VALUES($1, $2, $3, $4, $5, $6)
    `,
    [phone, direction, type || "text", text ?? null, template_name ?? null, ts]
  );
}
