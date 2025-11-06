import axios from "axios";

const GRAPH = "https://graph.facebook.com";
const API_VER = process.env.GRAPH_VERSION || "v21.0";

export async function sendWhatsAppMessage({ to, type, text, template }, { token, phoneNumberId }) {
  const url = `${GRAPH}/${API_VER}/${phoneNumberId}/messages`;
  const payload =
    type === "template"
      ? {
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: template.name,
            language: { code: template.language || "es" },
            components: template.components || []
          }
        }
      : {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text }
        };

  const r = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.data;
}

// Nota: las plantillas se listan a nivel de WABA (waba_id), no phone_number_id
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
      data.map(t => ({
        name: t.name,
        language: t.language,
        status: t.status,
        category: t.category
      }))
    );
    next = r.data?.paging?.next || null;
  }
  return out;
}
