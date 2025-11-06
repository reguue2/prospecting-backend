import axios from "axios";

const GRAPH = "https://graph.facebook.com";
const API_VER = process.env.GRAPH_VERSION || "v24.0";

/**
 * Envía un mensaje de texto o plantilla a través de WhatsApp Cloud API
 */
export async function sendWhatsAppMessage({ to, type, text, template }, { token, phoneNumberId }) {
  const url = `${GRAPH}/${API_VER}/${phoneNumberId}/messages`;

  const normTemplate =
    template && type === "template"
      ? {
          name: String(template.name || "").trim().toLowerCase(),
          language: { code: String(template.language || "es_ES").replace("-", "_") },
          components: template.components || []
        }
      : null;

  const payload =
    type === "template"
      ? {
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: normTemplate
        }
      : {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text }
        };

  console.log("📤 Enviando mensaje a Meta:", JSON.stringify(payload, null, 2));

  const r = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return r.data;
}

/**
 * Lista todas las plantillas disponibles en tu WABA
 */
export async function listTemplates({ token, wabaId }) {
  const url = `${GRAPH}/${API_VER}/${wabaId}/message_templates`;
  let out = [];
  let next = url;

  while (next) {
    const r = await axios.get(next, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = r.data?.data || [];
    out = out.concat(
      data.map((t) => ({
        name: t.name,
        language: t.language,
        status: t.status,
        category: t.category,
      }))
    );
    next = r.data?.paging?.next || null;
  }

  return out;
}
