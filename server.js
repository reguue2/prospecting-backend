import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import axios from "axios";
import { initDB, ensureSchema, insertMessage } from "./database.js";

dotenv.config();

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const PANEL_TOKEN = process.env.PANEL_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WABA_PHONE_NUMBER_ID = process.env.WABA_PHONE_NUMBER_ID || "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "verify_me";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const GRAPH = "https://graph.facebook.com";
const API_VER = process.env.GRAPH_VERSION || "v24.0";

// ---------- APP ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "2mb" }));

// ---------- DB ----------
initDB();
ensureSchema().catch((e) => {
  console.error("Error ensureSchema:", e);
  process.exit(1);
});

// ---------- MIDDLEWARE AUTH API ----------
function authApi(req, res, next) {
  if (req.path.startsWith("/webhook")) return next();
  if (req.path === "/health") return next();

  const key = req.header("x-api-key") || "";
  if (!PANEL_TOKEN || key !== PANEL_TOKEN) {
    return res.status(401).json({ error: "no auth" });
  }
  next();
}
app.use("/api", authApi);

// ---------- API: CHATS ----------
app.get("/api/chats", async (req, res) => {
  const p = initDB();
  const { rows } = await p.query(`
      SELECT
    c.phone,
    c.name,
    c.last_timestamp,
    c.last_preview,
    c.pinned,
    EXISTS (
      SELECT 1 FROM messages m
      WHERE m.phone = c.phone AND m.direction = 'in' AND m.is_read = false
    ) AS has_unread
  FROM chats c
  ORDER BY c.pinned DESC, c.last_timestamp DESC NULLS LAST
  `);
  res.json(rows);
});

app.patch("/api/chats/:phone/read", async (req, res) => {
  const p = initDB();
  const { phone } = req.params;
  await p.query(
    `UPDATE messages SET is_read = true WHERE phone = $1 AND direction = 'in' AND is_read = false`,
    [phone]
  );
  res.json({ ok: true });
});

// ---------- API: MESSAGES ----------
app.get("/api/messages/:phone", async (req, res) => {
  const p = initDB();
  const { phone } = req.params;
  const { rows } = await p.query(
    `SELECT id, phone, direction, type, text, template_name, timestamp, media_url, is_read
     FROM messages
     WHERE phone = $1
     ORDER BY timestamp ASC, id ASC`,
    [phone]
  );
  res.json(rows);
});

async function sendWhatsAppText({ to, text }) {
  const url = `${GRAPH}/${API_VER}/${WABA_PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

async function sendWhatsAppTemplate({ to, name, language = "es", components = [] }) {
  const lang = "es";
  const url = `${GRAPH}/${API_VER}/${WABA_PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: String(name).trim().toLowerCase(),
        language: { code: lang.replace("-", "_") },
        components,
      },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

app.post("/api/messages/send", async (req, res) => {
  const { to, type, text, template } = req.body;
  if (!to) return res.status(400).json({ error: "to requerido" });

  const nowSec = Math.floor(Date.now() / 1000);

  if (type === "template") {
    await sendWhatsAppTemplate({
      to,
      name: template?.name,
      language: template?.language || "es",
      components: template?.components || [],
    });
    await insertMessage({
      phone: to,
      direction: "out",
      type: "template",
      text: null,
      template_name: template?.name || null,
      timestamp: nowSec,
      media_url: null,
      is_read: true,
    });
  } else {
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: "text requerido" });
    }
    await sendWhatsAppText({ to, text });
    await insertMessage({
      phone: to,
      direction: "out",
      type: "text",
      text,
      template_name: null,
      timestamp: nowSec,
      media_url: null,
      is_read: true,
    });
  }

  io.emit("message:new", { phone: to });
  res.json({ ok: true });
});

// ---------- API: CHATS PIN ----------
app.patch("/api/chats/:phone/pin", async (req, res) => {
  const p = initDB();
  const { phone } = req.params;
  const { pinned } = req.body; // true o false
  await p.query(`UPDATE chats SET pinned = $1 WHERE phone = $2`, [pinned, phone]);
  res.json({ ok: true });
});

// ---------- API: TEMPLATES (cache sencillo) ----------
app.get("/api/templates", async (req, res) => {
  const p = initDB();
  try {
    console.log("Sincronizando plantillas desde Meta...");

    const WABA_ID = process.env.WABA_ID;
    if (!WABA_ID) {
      return res
        .status(500)
        .json({ error: "Falta WABA_ID en las variables de entorno" });
    }

    // ✅ endpoint correcto: business_id/message_templates
    const url = `${GRAPH}/${API_VER}/${WABA_ID}/message_templates`;

    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });

    const templates = resp.data?.data || [];

    // Vaciar cache anterior y guardar nuevas
    await p.query(`DELETE FROM templates_cache;`);
    for (const t of templates) {
      await p.query(
        `INSERT INTO templates_cache (name, language, status, category, last_synced_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [t.name, t.language || null, t.status || null, t.category || null]
      );
    }

    console.log(`Plantillas actualizadas (${templates.length} total).`);
    res.json(templates);
  } catch (err) {
    console.error("Error al sincronizar plantillas:", err.response?.data || err.message);
    res.status(500).json({
      error: "No se pudieron cargar las plantillas desde Meta",
      details: err.response?.data || err.message,
    });
  }
});
// ---------- API: MEDIA PROXY ----------
app.get("/api/media/:id", async (req, res) => {
  const mediaId = req.params.id;
  try {
    // 1) obtener URL temporal
    const meta = await axios.get(`${GRAPH}/${API_VER}/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const url = meta.data?.url;
    if (!url) return res.status(404).json({ error: "media sin url" });

    // 2) descargar y retransmitir
    const file = await axios.get(url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: "stream",
    });
    res.setHeader("Content-Type", file.headers["content-type"] || "application/octet-stream");
    file.data.pipe(res);
  } catch (e) {
    console.error("media proxy error:", e?.response?.data || e.message);
    res.status(500).json({ error: "media proxy error" });
  }
});

// ---------- WEBHOOK (GET verify + POST recibir) ----------
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
  try {
    const p = initDB();
    await p.query(`INSERT INTO webhook_events(payload) VALUES ($1)`, [body]);

    const entries = body?.entry || [];
    for (const entry of entries) {
      const changes = entry?.changes || [];
      for (const ch of changes) {
        const val = ch?.value || {};
        const msgs = val.messages || [];
        const wabaId = val.metadata?.phone_number_id; // id del número WABA que recibe

        for (const m of msgs) {
          const from = m.from;
          const to = m.to;
          const tsSec = Number(m.timestamp || Math.floor(Date.now() / 1000));
          const type = m.type;

          // === FILTRO: solo guardar mensajes dirigidos al número WABA configurado ===
          // si el mensaje no fue enviado al número principal, lo ignoramos
          if (to !== WABA_PHONE_NUMBER_ID && wabaId !== WABA_PHONE_NUMBER_ID) {
            console.log("Ignorado mensaje no dirigido al WABA principal:", { from, to, wabaId });
            continue;
          }

          // --- TEXTO ---
          if (type === "text" && m.text?.body) {
            await insertMessage({
              phone: from,
              direction: "in",
              type: "text",
              text: m.text.body,
              template_name: null,
              timestamp: tsSec,
              media_url: null,
              is_read: false,
            });
            io.emit("message:new", { phone: from });
          }
          // --- IMAGEN ---
          else if (type === "image" && m.image?.id) {
            await insertMessage({
              phone: from,
              direction: "in",
              type: "image",
              text: m.image?.caption || null,
              template_name: null,
              timestamp: tsSec,
              media_url: `/api/media/${m.image.id}`,
              is_read: false,
            });
            io.emit("message:new", { phone: from });
          }
          // --- DOCUMENTO ---
          else if (type === "document" && m.document?.id) {
            await insertMessage({
              phone: from,
              direction: "in",
              type: "document",
              text: m.document?.caption || null,
              template_name: null,
              timestamp: tsSec,
              media_url: `/api/media/${m.document.id}`,
              is_read: false,
            });
            io.emit("message:new", { phone: from });
          }
          // --- VIDEO ---
          else if (type === "video" && m.video?.id) {
            await insertMessage({
              phone: from,
              direction: "in",
              type: "video",
              text: m.video?.caption || null,
              template_name: null,
              timestamp: tsSec,
              media_url: `/api/media/${m.video.id}`,
              is_read: false,
            });
            io.emit("message:new", { phone: from });
          }
          // --- AUDIO ---
          else if (type === "audio" && m.audio?.id) {
            await insertMessage({
              phone: from,
              direction: "in",
              type: "audio",
              text: null,
              template_name: null,
              timestamp: tsSec,
              media_url: `/api/media/${m.audio.id}`,
              is_read: false,
            });
            io.emit("message:new", { phone: from });
          }
          // --- BOTONES / LISTAS (RESPUESTAS INTERACTIVAS) ---
          else if (
            type === "interactive" ||
            m.interactive ||
            m.button ||
            m.list_reply
          ) {
            const it = m.interactive || {};
            let text = null;

            if (it.type === "button_reply" && it.button_reply) {
              text = it.button_reply.title || it.button_reply.id;
            } else if (it.type === "list_reply" && it.list_reply) {
              text = it.list_reply.title || it.list_reply.id;
            } else if (m.button?.text) {
              text = m.button.text;
            } else if (m.list_reply?.title) {
              text = m.list_reply.title;
            } else {
              text = "Respuesta interactiva";
            }

            await insertMessage({
              phone: from,
              direction: "in",
              type: "interactive",
              text,
              template_name: null,
              timestamp: tsSec,
              media_url: null,
              is_read: false,
            });
            io.emit("message:new", { phone: from });
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("webhook error:", e?.response?.data || e.message);
    res.sendStatus(200);
  }
});


// ---------- HEALTH ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- SOCKET.IO ----------
io.on("connection", () => {});

// ---------- START ----------
server.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
});
