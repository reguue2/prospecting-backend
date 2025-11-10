// database.js
import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/postgres";

export const pool = new Pool({
  connectionString,
  ssl:
    process.env.PGSSL === "require"
      ? { rejectUnauthorized: false }
      : undefined,
});

// Inicializacion opcional
export async function initDB() {
  const client = await pool.connect();
  try {
    // Aqui no alteramos esquema, asumimos que ya creaste las tablas y campos segun tu JSON
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

// Asegura que exista un chat y actualiza last_preview/last_timestamp
export async function upsertChat({ phone, name, last_preview, last_timestamp }) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO chats (phone, name, last_timestamp, last_preview)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (phone)
      DO UPDATE SET
        name = COALESCE(EXCLUDED.name, chats.name),
        last_timestamp = GREATEST(COALESCE(EXCLUDED.last_timestamp, 0), COALESCE(chats.last_timestamp, 0)),
        last_preview = EXCLUDED.last_preview
      `,
      [phone, name || null, last_timestamp || 0, last_preview || null]
    );
  } finally {
    client.release();
  }
}

// Inserta un mensaje
export async function insertMessage(msg) {
  const {
    phone,
    direction, // 'in' o 'out'
    type = "text",
    text = null,
    template_name = null,
    timestamp,
    media_url = null,
    is_read = false, // por defecto false
  } = msg;

  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO messages (phone, direction, type, text, template_name, timestamp, media_url, is_read)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [phone, direction, type, text, template_name, timestamp, media_url, is_read]
    );
  } finally {
    client.release();
  }
}

// Devuelve mensajes por chat (si lo necesitas en otras rutas)
export async function getMessagesByPhone(phone) {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `
      SELECT id, phone, direction, type, text, template_name, timestamp, media_url, is_read
      FROM messages
      WHERE phone = $1
      ORDER BY timestamp ASC
      `,
      [phone]
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// Lista de chats con flag has_unread derivado de messages.direction='in' AND is_read=false
export async function getChatsWithUnread() {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `
      SELECT
        c.phone,
        c.name,
        c.last_timestamp,
        c.last_preview,
        EXISTS (
          SELECT 1
          FROM messages m
          WHERE m.phone = c.phone
            AND m.direction = 'in'
            AND m.is_read = FALSE
        ) AS has_unread
      FROM chats c
      ORDER BY c.last_timestamp DESC NULLS LAST
      `
    );
    return r.rows;
  } finally {
    client.release();
  }
}

// Marca como leidos los entrantes de un chat
export async function markChatRead(phone) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      UPDATE messages
      SET is_read = TRUE
      WHERE phone = $1
        AND direction = 'in'
        AND is_read = FALSE
      `,
      [phone]
    );
  } finally {
    client.release();
  }
}
