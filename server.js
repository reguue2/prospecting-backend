import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import axios from "axios";
import fs from "fs";
import path from "path";
import {
  initDB,
  ensureSchema,
  upsertChat,
  insertMessage,
} from "./database.js";
import { sendWhatsAppMessage, listTemplates } from "./meta.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: "10mb" }));

// ---------- ENV ----------
const PORT = process.env.PORT || 3001;
const PANEL_TOKEN = process.env.PANEL_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WABA_PHONE_NUMBER_ID = process.env.WABA_PHONE_NUMBER_ID || "";
const WABA_ID = process.env.WABA_ID || "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "verify_me";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const GRAPH = "https://graph.facebook.com";
const API_VER = process.env.GRAPH_VERSION || "v24.0";

if (!PANEL_TOKEN) console.warn("Falta PANEL_TOKEN");
if (!WHATSAPP_TOKEN) console.warn("Falta WHATSAPP_TOKEN");
if (!WABA_PHONE_NUMBER_ID) console.warn("Falta WABA_PHONE_NUMBER_ID");
if (!WABA_ID) console.warn("Falta WABA_ID");

app.use(cors({ origin: CORS_ORIGIN, credentials: false }));

// ---------- DB ----------
const pool = initDB();
await ensureSchema(pool);

// ---------- Auth por header ----------
app.use((req, res, next) => {
  if (req.path.startsWith("/webhook")) return next();
  const key = req.headers["x-api-key"];
  if (!key || key !== PANEL_TOKEN) return res.status(401).json({ error: "no auth" });
  next();
});

// ---------- APIs panel ----------
app.get("/api/chats", async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        c.*,
        EXISTS (
          SELECT 1 FROM messages m
          WHERE m.phone = c.phone
            AND m.direction = 'in'
            AND m.is_read = FALSE
        ) AS has_unread
      FROM chats c
      ORDER BY c.last_timestamp DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error al obtener chats:", err);
    res.status(500).json({ error: "Error interno" });
  } finally {
    client.release();
  }
});


app.get("/api/messages/:phone", async (req, res) => {
  const phone = req.params.phone;
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT id, phone, direction, type, text, template_name, media_url, timestamp
       FROM messages
       WHERE phone = $1
       ORDER BY timestamp ASC`,
      [phone]
    );
    res.json(r.rows);
  } finally {
    client.release();
  }
});

// ---------- Enviar mensaje ----------
app.post("/api/messages/send", async (req, res) => {
  const { to, type, text, template } = req.body || {};
  try {
    const r = await sendWhatsAppMessage(
      { to, type, text, template },
      { token: WHATSAPP_TOKEN, phoneNumberId: WABA_PHONE_NUMBER_ID }
    );

    // Guardar mensaje saliente en BD
    const client = await pool.connect();
    try {
      const ts = Math.floor(Date.now() / 1000);
      await upsertChat(client, {
        phone: to,
        ts,
        preview: text || "[Plantilla]",
      });
      await insertMessage(client, {
        phone: to,
        direction: "out",
        type: type || "text",
        text: text || null,
        template_name: template?.name || null,
        media_url: null,
        ts,
      });
    } finally {
      client.release();
    }

    res.json({ ok: true, result: r.data });
  } catch (err) {
    console.error("Error enviando mensaje:", err.response?.data || err.message);
    res.status(500).json({ error: "no enviado" });
  }
});

app.get("/api/templates", async (req, res) => {
  try {
    const list = await listTemplates({ token: WHATSAPP_TOKEN, wabaId: WABA_ID });
    res.json(list);
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: "no templates" });
  }
});

// ---------- Webhook WhatsApp ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body?.entry) {
    console.log("Webhook recibido:", JSON.stringify(body, null, 2));
  }

  try {
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages || [];

    if (!messages.length) return res.sendStatus(200);

    const client = await pool.connect();
    try {
      for (const m of messages) {
        const from = m.from;
        const ts = Number(m.timestamp || Math.floor(Date.now() / 1000));
        const type = m.type;

        let preview = "";
        let direction = "in";
        let saveType = "text";
        let text = null;
        let template_name = null;
        let media_url = null;

        if (type === "text") {
          text = m.text?.body || "";
          preview = text.slice(0, 60);
          saveType = "text";
        } else if (m.audio || m.voice || type === "audio" || type === "voice") {
          const mediaId = m.audio?.id || m.voice?.id;
          preview = "[AUDIO]";
          saveType = "audio";
          media_url = mediaId ? `/api/media/${mediaId}` : null;
          console.log("Audio detectado:", mediaId);
        } else if (type === "image") {
          const mediaId = m.image?.id;
          preview = "[IMAGEN]";
          saveType = "image";
          media_url = `/api/media/${mediaId}`;
        } else if (type === "document") {
          const mediaId = m.document?.id;
          preview = m.document?.filename || "[DOCUMENTO]";
          saveType = "document";
          media_url = `/api/media/${mediaId}`;
        } else {
          preview = `[${type.toUpperCase()}]`;
          saveType = "text";
        }

        // seguridad extra: si es audio pero no tiene media_url
        if (saveType === "audio" && !media_url && (m.audio?.id || m.voice?.id)) {
          const mediaId = m.audio?.id || m.voice?.id;
          media_url = `/api/media/${mediaId}`;
        }

        await upsertChat(client, { phone: from, ts, preview });
        await insertMessage(client, {
          phone: from,
          direction,
          type: saveType,
          text,
          template_name,
          media_url,
          ts,
        });
      }
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("Error parseando webhook:", e.message, e.stack);
  }

  res.sendStatus(200);
});

// ---------- Proxy de media ----------
app.get("/api/media/:id", async (req, res) => {
  const mediaId = req.params.id;
  if (!mediaId) return res.status(400).send("Falta ID");

  try {
    const meta = await axios.get(`${GRAPH}/${API_VER}/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      params: { fields: "url,mime_type,sha256,file_size" },
    });

    const url = meta.data?.url;
    const mime = meta.data?.mime_type || "application/octet-stream";
    if (!url) return res.status(404).send("No url");

    const r = await axios.get(url, {
      responseType: "stream",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });

    if (r.headers["content-length"]) {
      res.setHeader("Content-Length", r.headers["content-length"]);
    }
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "private, max-age=31536000");

    r.data.pipe(res);
    r.data.on("error", (err) => {
      console.error("Error piping media:", err.message);
      if (!res.headersSent) res.status(500).end("media error");
      else res.end();
    });
  } catch (err) {
    console.error("Error al servir media:", err.response?.data || err.message);
    res.status(500).send("error media");
  }
});

app.patch("/api/chats/:phone/read", async (req, res) => {
  const { phone } = req.params;
  const client = await pool.connect();

  try {
    const update = await client.query(
      `
      UPDATE messages
      SET is_read = TRUE
      WHERE phone = $1
        AND direction = 'in'
        AND is_read = FALSE
      `,
      [phone]
    );

    console.log(`Mensajes marcados como leídos para ${phone}:`, update.rowCount);

    client.release();
    return res.json({ success: true, updated: update.rowCount });
  } catch (err) {
    client.release();
    console.error("Error al marcar como leídos:", err);
    return res.status(500).json({ error: "Error interno al marcar como leídos" });
  }
});


// ---------- Socket.IO ----------
io.on("connection", () => {});

// ---------- Inicio ----------
server.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
});
