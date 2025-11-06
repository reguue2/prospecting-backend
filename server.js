import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import axios from "axios";
import http from "http";
import { Server } from "socket.io";
import { initDB, getDB } from "./database.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 10000;

const PANEL_TOKEN = process.env.PANEL_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WABA_PHONE_NUMBER_ID = process.env.WABA_PHONE_NUMBER_ID || "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "verify_me";

app.use(cors());
app.use(express.json());

function requirePanelToken(req, res, next) {
  const t = req.header("x-api-key");
  if (!PANEL_TOKEN) return res.status(500).json({ error: "PANEL_TOKEN no configurado" });
  if (t !== PANEL_TOKEN) return res.status(401).json({ error: "No autorizado" });
  return next();
}

let db;
initDB().then((d) => { db = d; }).catch((e) => {
  console.error("Error iniciando DB", e);
  process.exit(1);
});

async function touchChat(phone, preview, ts) {
  await db.run(
    `INSERT INTO chats(phone, name, last_timestamp, last_preview)
     VALUES(?,?,?,?)
     ON CONFLICT(phone) DO UPDATE SET last_timestamp = excluded.last_timestamp, last_preview = excluded.last_preview`,
    [phone, null, ts, preview ?? null]
  );
}

// API protegida
app.get("/api/chats", requirePanelToken, async (req, res) => {
  const rows = await db.all("SELECT * FROM chats ORDER BY last_timestamp DESC");
  res.json(rows);
});

app.get("/api/messages/:phone", requirePanelToken, async (req, res) => {
  const { phone } = req.params;
  const rows = await db.all(
    "SELECT * FROM messages WHERE phone = ? ORDER BY timestamp ASC",
    [phone]
  );
  res.json(rows);
});

app.post("/api/messages/send", requirePanelToken, async (req, res) => {
  try {
    const { to, type = "text", text, template } = req.body;
    if (!to) return res.status(400).json({ error: "Campo 'to' requerido" });

    let payload;
    if (type === "template") {
      if (!template?.name) return res.status(400).json({ error: "template.name requerido" });
      payload = {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language || "es" },
          components: template.components || []
        }
      };
    } else {
      if (!text) return res.status(400).json({ error: "Campo 'text' requerido" });
      payload = {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text }
      };
    }

    const url = `https://graph.facebook.com/v21.0/${WABA_PHONE_NUMBER_ID}/messages`;
    const r = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });

    const ts = Math.floor(Date.now() / 1000);
    await db.run(
      "INSERT INTO messages(phone, direction, type, text, template_name, timestamp) VALUES (?,?,?,?,?,?)",
      [to, "out", payload.type, text ?? null, template?.name ?? null, ts]
    );
    await touchChat(to, text ?? `plantilla: ${template?.name}`, ts);

    io.emit("message:new", { phone: to });

    res.json({ ok: true, id: r.data?.messages?.[0]?.id });
  } catch (e) {
    console.error("Error enviando", e?.response?.data || e.message);
    res.status(500).json({ error: "Fallo enviando mensaje", details: e?.response?.data || e.message });
  }
});

// compat endpoints con tu frontend anterior
app.post("/send-message", requirePanelToken, async (req, res) => {
  const { to, text } = req.body;
  req.body = { to, type: "text", text };
  return app._router.handle(req, res, () => {}, "post", "/api/messages/send");
});
app.post("/send-template", requirePanelToken, async (req, res) => {
  const { to, templateName, lang } = req.body;
  req.body = { to, type: "template", template: { name: templateName, language: lang || "es" } };
  return app._router.handle(req, res, () => {}, "post", "/api/messages/send");
});

// webhook verificacion
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// webhook recepcion
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];

    if (msg) {
      const from = msg.from;
      const ts = parseInt(msg.timestamp, 10) || Math.floor(Date.now() / 1000);
      const text = msg.text?.body || msg.button?.text || msg.interactive?.nfm_reply?.response_json || "";
      await db.run(
        "INSERT INTO messages(phone, direction, type, text, timestamp) VALUES (?,?,?,?,?)",
        [from, "in", msg.type || "text", text, ts]
      );
      await touchChat(from, text, ts);
      io.emit("message:new", { phone: from });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("Error webhook", e);
    res.sendStatus(200);
  }
});

io.on("connection", () => {});

server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
