import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { initDB, ensureSchema, upsertChat, insertMessage } from "./database.js";
import { sendWhatsAppMessage, listTemplates } from "./meta.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
const PANEL_TOKEN = process.env.PANEL_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WABA_PHONE_NUMBER_ID = process.env.WABA_PHONE_NUMBER_ID || "";
const WABA_ID = process.env.WABA_ID || ""; // necesario para /message_templates
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "verify_me";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

if (!PANEL_TOKEN) console.warn("⚠️ Falta PANEL_TOKEN");
if (!WHATSAPP_TOKEN) console.warn("⚠️ Falta WHATSAPP_TOKEN");
if (!WABA_PHONE_NUMBER_ID) console.warn("⚠️ Falta WABA_PHONE_NUMBER_ID");
if (!WABA_ID) console.warn("⚠️ Falta WABA_ID (requerido para /api/templates)");

app.use(cors({ origin: CORS_ORIGIN, credentials: false }));
app.use(express.json({ limit: "1mb" }));
// ------------------- Autenticación mínima -------------------
function requirePanelToken(req, res, next) {
  const t = req.header("x-api-key");
  if (!PANEL_TOKEN) return res.status(500).json({ error: "PANEL_TOKEN no configurado" });
  if (t !== PANEL_TOKEN) return res.status(401).json({ error: "No autorizado" });
  return next();
}

// ------------------- Inicialización BD -------------------
const pool = initDB();
ensureSchema().catch((e) => {
  console.error("❌ Error creando esquema", e);
  process.exit(1);
});

// util tiempo
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ------------------- RUTAS PROTEGIDAS -------------------

// Obtener lista de chats
app.get("/api/chats", requirePanelToken, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM chats ORDER BY last_timestamp DESC");
  res.json(rows);
});

// Obtener mensajes de un chat
app.get("/api/messages/:phone", requirePanelToken, async (req, res) => {
  const phone = req.params.phone;
  const { rows } = await pool.query(
    "SELECT * FROM messages WHERE phone = $1 ORDER BY timestamp ASC",
    [phone]
  );
  res.json(rows);
});

// Enviar mensaje (texto o plantilla)
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
        phone: to,
        direction: "out",
        type: type === "template" ? "template" : "text",
        text: type === "template" ? null : text,
        template_name: type === "template" ? template.name : null,
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

// Listar plantillas desde la WABA
app.get("/api/templates", requirePanelToken, async (req, res) => {
  try {
    const items = await listTemplates({ token: WHATSAPP_TOKEN, wabaId: WABA_ID });

    const client = await pool.connect();
    try {
      await client.query("DELETE FROM templates_cache");
      for (const t of items) {
        await client.query(
          "INSERT INTO templates_cache(name, language, status, category) VALUES ($1,$2,$3,$4)",
          [t.name, t.language, t.status, t.category]
        );
      }
    } finally {
      client.release();
    }

    res.json(items);
  } catch (e) {
    const details = e?.response?.data || e.message;
    console.error("❌ Fallo /api/templates", details);
    res.status(500).json({ error: "Fallo obteniendo plantillas", details });
  }
});

// ------------------- WEBHOOK -------------------

// Verificación inicial del webhook
// Verificación inicial
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recepción de mensajes entrantes
app.post("/webhook", async (req, res) => {
  console.log("📩 Webhook recibido:");
  console.dir(req.body, { depth: null });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id bigserial primary key,
        received_at timestamptz default now(),
        payload jsonb
      )
    `);
    await pool.query("INSERT INTO webhook_events(payload) VALUES ($1)", [req.body]);
  } catch (e) {
    console.error("⚠️ Error registrando webhook_events:", e.message);
  }

  const entries = req.body?.entry || [];
  for (const entry of entries) {
    const changes = entry?.changes || [];
    for (const change of changes) {
      const value = change?.value || {};
      const messages = value?.messages || [];
      const statuses = value?.statuses || [];

      // Mensajes entrantes
      for (const msg of messages) {
        const from = msg.from;
        const ts = parseInt(msg.timestamp, 10) || Math.floor(Date.now() / 1000);
        const type = msg.type || "text";

        const text =
          msg.text?.body ||
          msg.button?.text ||
          msg.interactive?.button_reply?.title ||
          msg.interactive?.list_reply?.title ||
          msg.interactive?.nfm_reply?.response_json ||
          "";

        const client = await pool.connect();
        try {
          await insertMessage(client, {
            phone: from,
            direction: "in",
            type,
            text,
            template_name: null,
            ts,
          });
          await upsertChat(client, { phone: from, preview: text, ts });
        } finally {
          client.release();
        }

        console.log(`✅ Mensaje recibido de ${from}: ${text}`);
        io.emit("message:new", { phone: from });
      }

      // Estados de mensaje (entregado, leído, etc.)
      for (const st of statuses) {
        console.log("ℹ️ Estado:", st.status, "para", st.recipient_id);
      }
    }
  }

  res.sendStatus(200);
});

// Endpoint de depuración para ver último payload
app.get("/api/debug/webhook/last", requirePanelToken, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, received_at, payload FROM webhook_events ORDER BY id DESC LIMIT 1"
  );
  res.json(rows[0] || null);
});

// ------------------- SOCKET.IO -------------------
io.on("connection", () => {});

// ------------------- INICIO SERVIDOR -------------------
server.listen(PORT, () => {
  console.log(`✅ Servidor iniciado en puerto ${PORT}`);
});
