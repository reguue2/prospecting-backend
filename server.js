import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import axios from "axios";
import {
  initDB,
  ensureSchema,
  upsertChat,
  insertMessage,
} from "./database.js";
import { sendWhatsAppMessage, listTemplates } from "./meta.js";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
const PANEL_TOKEN = process.env.PANEL_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WABA_PHONE_NUMBER_ID = process.env.WABA_PHONE_NUMBER_ID || "";
const WABA_ID = process.env.WABA_ID || "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "verify_me";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

if (!PANEL_TOKEN) console.warn("⚠️ Falta PANEL_TOKEN");
if (!WHATSAPP_TOKEN) console.warn("⚠️ Falta WHATSAPP_TOKEN");
if (!WABA_PHONE_NUMBER_ID) console.warn("⚠️ Falta WABA_PHONE_NUMBER_ID");
if (!WABA_ID) console.warn("⚠️ Falta WABA_ID");

app.use(cors({ origin: CORS_ORIGIN, credentials: false }));

app.use(express.json({ limit: "1mb" }));

function requirePanelToken(req, res, next) {
  const t = req.header("x-api-key");
  if (!PANEL_TOKEN)
    return res.status(500).json({ error: "PANEL_TOKEN no configurado" });
  if (t !== PANEL_TOKEN)
    return res.status(401).json({ error: "No autorizado" });
  return next();
}

const pool = initDB();
ensureSchema().catch((e) => {
  console.error("❌ Error creando esquema", e);
  process.exit(1);
});

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ------------------- RUTAS -------------------

app.get("/api/chats", requirePanelToken, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM chats ORDER BY last_timestamp DESC"
  );
  res.json(rows);
});

app.get("/api/messages/:phone", requirePanelToken, async (req, res) => {
  const phone = req.params.phone;
  const { rows } = await pool.query(
    "SELECT * FROM messages WHERE phone = $1 ORDER BY timestamp ASC",
    [phone]
  );
  res.json(rows);
});

app.post("/api/messages/send", requirePanelToken, async (req, res) => {
  try {
    const { to, type = "text", text, template } = req.body;
    if (!to) return res.status(400).json({ error: "Campo 'to' requerido" });

    if (type === "template") {
      if (!template?.name)
        return res.status(400).json({ error: "template.name requerido" });
      const tplName = String(template.name).trim().toLowerCase();

      let lang = null;
      try {
        const { rows } = await pool.query(
          "SELECT language FROM templates_cache WHERE name = $1 LIMIT 1",
          [tplName]
        );
        if (rows.length > 0) lang = rows[0].language;
      } catch {}

      template.name = tplName;
      template.language = lang || String(template.language || "es_ES");
    } else {
      if (!text) return res.status(400).json({ error: "Campo 'text' requerido" });
    }

    const apiResp = await sendWhatsAppMessage(
      { to, type, text, template },
      { token: WHATSAPP_TOKEN, phoneNumberId: WABA_PHONE_NUMBER_ID }
    );

    const client = await pool.connect();
    try {
      const ts = nowSeconds();
      await insertMessage(client, {
        phone: from,
        direction: "in",
        type,
        text,
        media_url,
        template_name: null,
        ts,
      });
      await upsertChat(client, {
        phone: to,
        preview: type === "template" ? `plantilla: ${template.name}` : text,
        ts,
      });
    } finally {
      client.release();
    }

    io.emit("message:new", { phone: to });
    res.json({ ok: true, api: apiResp });
  } catch (e) {
    const details = e?.response?.data || e.message;
    console.error("❌ Fallo /api/messages/send", details);
    res.status(500).json({ error: "Fallo enviando mensaje", details });
  }
});

// ------------------- AUDIO + WEBHOOK -------------------

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
  console.log("📩 Webhook recibido =========================");
  console.log(JSON.stringify(req.body, null, 2));

  const entries = req.body?.entry || [];
  for (const entry of entries) {
    const changes = entry?.changes || [];
    for (const change of changes) {
      const value = change?.value || {};
      const messages = value?.messages || [];

      for (const msg of messages) {
        const from = msg.from;
        const ts = parseInt(msg.timestamp, 10) || nowSeconds();
        const type = msg.type || "text";

        let text = "";
        let media_url = null;

        if (type === "text") {
          text = msg.text?.body || "";
        } else if (type === "audio" && msg.audio?.id) {
          // Recuperar URL del audio con el token
          try {
            const mediaId = msg.audio.id;
            const mediaResp = await axios.get(
              `https://graph.facebook.com/v20.0/${mediaId}`,
              {
                headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
              }
            );
            media_url = `/api/media/${msg.audio.id}`;
          } catch (err) {
            console.error("⚠️ Error obteniendo URL del audio:", err.message);
          }
        }

        const client = await pool.connect();
        try {
          await insertMessage(client, {
            phone: from,
            direction: "in",
            type,
            text,
            media_url,
            template_name: null,
            ts,
          });
          await upsertChat(client, {
            phone: from,
            preview: text || "[Audio recibido]",
            ts,
          });
        } finally {
          client.release();
        }

        io.emit("message:new", { phone: from });
        console.log(`✅ Mensaje recibido de ${from}: ${text || "[AUDIO]"}`);
      }
    }
  }

  res.sendStatus(200);
});

const TEMP_DIR = "/tmp/audios";
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

app.get("/api/media/:id", async (req, res) => {
  const mediaId = req.params.id;
  if (!mediaId) return res.status(400).send("Falta ID");

  try {
    // Obtener URL de descarga directa
    const metaResp = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });

    const fileUrl = metaResp.data.url;
    if (!fileUrl) return res.status(404).send("URL no encontrada");

    // Descargar el binario del audio
    const audioResp = await axios.get(fileUrl, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: "arraybuffer",
    });

    res.set("Content-Type", "audio/ogg");
    res.send(audioResp.data);
  } catch (err) {
    console.error("❌ Error al servir audio:", err.message);
    res.status(500).send("Error descargando el audio");
  }
});

// ------------------- SOCKET.IO -------------------

io.on("connection", () => {});

// ------------------- INICIO -------------------

server.listen(PORT, () => {
  console.log(`✅ Servidor iniciado en puerto ${PORT}`);
});
