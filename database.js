import sqlite3 from "sqlite3";
import { open } from "sqlite";

let db;

export async function initDB() {
  db = await open({
    filename: "./messages.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS chats (
      phone TEXT PRIMARY KEY,
      name TEXT,
      last_timestamp INTEGER DEFAULT 0,
      last_preview TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      direction TEXT CHECK(direction IN ('in','out')) NOT NULL,
      type TEXT DEFAULT 'text',
      text TEXT,
      template_name TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY(phone) REFERENCES chats(phone)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_phone_time ON messages(phone, timestamp);
  `);

  return db;
}

export function getDB() {
  if (!db) throw new Error("DB not initialized");
  return db;
}
