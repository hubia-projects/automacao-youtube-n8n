const axios = require("axios");
const { config } = require("../config/env");

const hasTelegram = () => Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);

const sendTelegramMessage = async ({ text, parseMode = "Markdown" }) => {
  if (!hasTelegram()) {
    return {
      configured: false,
      sent: false,
      message: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID ausentes",
    };
  }

  const response = await axios.post(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      chat_id: config.TELEGRAM_CHAT_ID,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }
  );

  return {
    configured: true,
    sent: true,
    telegram_message_id: response.data?.result?.message_id,
  };
};

const buildIdeasApprovalMessage = ({ videoId, ideas }) => {
  const lines = [
    "*🧠 Ideias da Semana (YouTube Faceless - Viagem)*",
    `video_id: \`${videoId}\``,
    "",
  ];

  ideas.forEach((idea, index) => {
    lines.push(
      `*${index + 1}) ${idea.topic}*`,
      `Ângulo: ${idea.angle}`,
      `Score total: ${idea.total_score}`,
      `Demanda:${idea.scores.search_demand} | Evergreen:${idea.scores.evergreen} | Retenção:${idea.scores.retention}`,
      ""
    );
  });

  lines.push("Responda com o número da ideia aprovada no n8n/endpoint /api/videos/ideas/approve.");

  return lines.join("\n");
};

const buildFinalReviewMessage = ({ videoId, title, renderPath, tags = [] }) => {
  return [
    "*🎬 Revisão Final Pronta*",
    `video_id: \`${videoId}\``,
    `Título: ${title || "(não definido)"}`,
    `Render: \`${renderPath || "não encontrado"}\``,
    `Tags: ${tags.slice(0, 8).join(", ")}`,
    "",
    "Aprove no endpoint /api/videos/final/approve antes do upload.",
  ].join("\n");
};

const basicTelegramHealthcheck = async () => {
  if (!hasTelegram()) {
    return { configured: false, ok: false, message: "Telegram não configurado" };
  }

  try {
    const result = await sendTelegramMessage({ text: "✅ Healthcheck Telegram: integração ativa." });
    return { configured: true, ok: true, message: "Mensagem enviada", details: result };
  } catch (error) {
    return { configured: true, ok: false, message: error.message };
  }
};

module.exports = {
  hasTelegram,
  sendTelegramMessage,
  buildIdeasApprovalMessage,
  buildFinalReviewMessage,
  basicTelegramHealthcheck,
};