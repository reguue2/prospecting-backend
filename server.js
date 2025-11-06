import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { initDB, ensureSchema, upsertChat, insertMessage } from "./db.js";
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

if (!PANEL_TOKEN) console.warn("Aviso: falta PANEL_TOKEN");
if (!WHATSAPP_TOKEN) console.warn("Aviso: falta WHATSAPP_TOKEN");
if (!WABA_PHONE_NUMBER_ID) console.warn("Aviso: falta WABA_PHONE_NUMBER_ID");
if (!WABA_ID) console.warn("Aviso: falta WABA_ID (requerido para /api/templates)");

app.use(cors({ origin: CORS_ORIGIN, credentials: false }));
app.use(express.json({ limit: "1mb" }));

// auth minima
function requirePanelToken(req, res, next) {
  const t = req.header("x-api-key");
  if (!PANEL_TOKEN) return res.status(500).json({ error: "PANEL_TOKEN no configurado" });
  if (t !== PANEL_TOKEN) return res.status(401).json({ error: "No autorizado" });
  return next();
}

const pool = initDB();
ensureSchema().catch((e) => {
  console.error("Error creando esquema", e);
  process.exit(1);
});

// util tiempo
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// RUTAS PROTEGIDAS
app.get("/api/chats", requirePanelToken, async (req, res) => {
  const { rows } = await pool.query("select * from chats order by last_timestamp desc");
  res.json(rows);
});

app.get("/api/messages/:phone", requirePanelToken, async (req, res) => {
  const phone = req.params.phone;
  const { rows } = await pool.query(
    "select * from messages where phone = $1 order by timestamp asc",
    [phone]
  );
  res.json(rows);
});

app.post("/api/messages/send", requirePanelToken, async (req, res) => {
  try {
    const { to, type = "text", text, template } = req.body;
    if (!to) return res.status(400).json({ error: "Campo 'to' requerido" });

    if (type === "template") {
      if (!template?.name) return res.status(400).json({ error: "template.name requerido" });
    } else {
      if (!text) return res.status(400).json({ error: "Campo 'text' requerido" });
    }

    // Enviar a Meta
    const apiResp = await sendWhatsAppMessage(
      { to, type, text, template },
      { token: WHATSAPP_TOKEN, phoneNumberId: WABA_PHONE_NUMBER_ID }
    );

    // Guardar en BD
    const client = await pool.connect();
    try {
      const ts = nowSeconds();
      await insertMessage(client, {
        phone: to,
        direction: "out",
        type: type === "template" ? "template" : "text",
        text: type === "template" ? null : text,
        template_name: type === "template" ? template.name : null,
        ts
      });
      await upsertChat(client, {
        phone: to,
        preview: type === "template" ? `plantilla: ${template.name}` : text,
        ts
      });
    } finally {
      client.release();
    }

    io.emit("message:new", { phone: to });
    res.json({ ok: true, api: apiResp });
  } catch (e) {
    const details = e?.response?.data || e.message;
    console.error("Fallo /api/messages/send", details);
    res.status(500).json({ error: "Fallo enviando mensaje", details });
  }
});

// Lista plantillas desde tu WABA, con cache sencilla
app.get("/api/templates", requirePanelToken, async (req, res) => {
  try {
    // siempre refrescamos remoto; si quieres cache agresiva, ajusta
    const items = await listTemplates({ token: WHATSAPP_TOKEN, wabaId: WABA_ID });

    // opcional: cachear
    const client = await pool.connect();
    try {
      await client.query("delete from templates_cache");
      for (const t of items) {
        await client.query(
          "insert into templates_cache(name, language, status, category) values ($1,$2,$3,$4)",
          [t.name, t.language, t.status, t.category]
        );
      }
    } finally {
      client.release();
    }

    res.json(items);
  } catch (e) {
    const details = e?.response?.data || e.message;
    console.error("Fallo /api/templates", details);
    res.status(500).json({ error: "Fallo obteniendo plantillas", details });
  }
});

// WEBHOOK GET (verificacion)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// WEBHOOK POST (mensajes entrantes)
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msgs = value?.messages || [];

    if (msgs.length > 0) {
      const msg = msgs[0];
      const from = msg.from; // numero del contacto
      const ts = parseInt(msg.timestamp, 10) || nowSeconds();

      const text =
        msg.text?.body ||
        msg.button?.text ||
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        msg.interactive?.nfm_reply?.response_json ||
        "";

      const type = msg.type || "text";

      const client = await pool.connect();
      try {
        await insertMessage(client, {
          phone: from,
          direction: "in",
          type,
          text,
          template_name: null,
          ts
        });
        await upsertChat(client, {
          phone: from,
          preview: text,
          ts
        });
      } finally {
        client.release();
      }

      io.emit("message:new", { phone: from });
    }

    // status updates de mensajes salientes (opcionalmente podrias guardarlos)
    // const statuses = value?.statuses;

    res.sendStatus(200);
  } catch (e) {
    console.error("Error en webhook", e);
    res.sendStatus(200);
  }
});

// socket
io.on("connection", () => {});

server.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
});
