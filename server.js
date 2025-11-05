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

app.use(express.json());
app.use(cors());

// Iniciar base de datos
await initDB();
const db = getDB();

// Guardar y emitir mensaje nuevo
async function saveAndEmitMessage(chat_id, from_me, text) {
  const timestamp = Date.now();
  await db.run(
    "INSERT INTO messages (chat_id, from_me, text, timestamp) VALUES (?, ?, ?, ?)",
    [chat_id, from_me ? 1 : 0, text, timestamp]
  );
  io.emit("newMessage", { chat_id, from_me, text, timestamp });
}

// ========= 1️⃣ Enviar mensaje normal =========
app.post("/send-message", async (req, res) => {
  const { to, text } = req.body;
  try {
    const resp = await axios.post(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      { headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` } }
    );
    await saveAndEmitMessage(to, true, text);
    res.json({ success: true, response: resp.data });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Error sending message" });
  }
});

// ========= 2️⃣ Enviar plantilla =========
app.post("/send-template", async (req, res) => {
  const { to, templateName, lang = "es" } = req.body;
  try {
    const resp = await axios.post(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name: templateName, language: { code: lang } },
      },
      { headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` } }
    );
    await saveAndEmitMessage(to, true, `[Plantilla: ${templateName}]`);
    res.json({ success: true, response: resp.data });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Error sending template" });
  }
});

// ========= 3️⃣ Webhook verificación =========
app.get("/webhook", (req, res) => {
  const verify_token = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === verify_token) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ========= 4️⃣ Webhook mensajes entrantes =========
app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];

  if (message) {
    const from = message.from;
    const text = message.text?.body || "(mensaje no de texto)";
    await saveAndEmitMessage(from, false, text);
  }

  res.sendStatus(200);
});

// ========= 5️⃣ Obtener todos los mensajes =========
app.get("/chats", async (req, res) => {
  const rows = await db.all("SELECT * FROM messages ORDER BY timestamp ASC");
  res.json(rows);
});

// ========= Socket.IO =========
io.on("connection", (socket) => {
  console.log("Cliente conectado");
});

server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
