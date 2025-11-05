import sqlite3 from "sqlite3";
import { open } from "sqlite";

let db;

export async function initDB() {
  db = await open({
    filename: "./messages.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      from_me INTEGER,
      text TEXT,
      timestamp INTEGER
    )
  `);
  return db;
}

export function getDB() {
  return db;
}
