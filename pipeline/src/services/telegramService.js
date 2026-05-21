const axios = require("axios");
const { config } = require("../config/env");
const { loadState, updateState } = require("./stateService");

const hasTelegram = () => Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);

const toTelegramPlainText = (text = "") =>
  String(text)
    .replace(/[`*]/g, "")
    .replace(/\n{3,}/g, "\n\n");

const isTelegramParseError = (error) => {
  const description = error?.response?.data?.description || "";
  return error?.response?.status === 400 && /parse entities/i.test(description);
};

const postTelegramMessage = async ({ text, parseMode, chatId = config.TELEGRAM_CHAT_ID, replyToMessageId }) => {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
  }

  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  return axios.post(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, payload);
};

const sendTelegramMessage = async ({
  text,
  parseMode = "Markdown",
  chatId = config.TELEGRAM_CHAT_ID,
  replyToMessageId,
}) => {
  if (!hasTelegram()) {
    return {
      configured: false,
      sent: false,
      message: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID ausentes",
    };
  }

  try {
    const response = await postTelegramMessage({
      text,
      parseMode,
      chatId,
      replyToMessageId,
    });

    return {
      configured: true,
      sent: true,
      chat_id: chatId,
      telegram_message_id: response.data?.result?.message_id,
    };
  } catch (error) {
    if (!parseMode || !isTelegramParseError(error)) {
      throw error;
    }

    const fallbackText = toTelegramPlainText(text);
    const response = await postTelegramMessage({
      text: fallbackText,
      chatId,
      replyToMessageId,
    });

    return {
      configured: true,
      sent: true,
      chat_id: chatId,
      telegram_message_id: response.data?.result?.message_id,
      used_plain_text_fallback: true,
    };
  }
};

const buildWorkflowStatusMessage = ({ icon = "ℹ️", title, videoId, lines = [] }) => {
  return [`${icon} ${title}`, `video_id: ${videoId}`, ...lines.filter(Boolean)].join("\n");
};

const sendWorkflowStatus = async ({ videoId, title, lines = [], icon = "ℹ️", stageKey = "" }) => {
  if (!hasTelegram() || !config.TELEGRAM_VERBOSE_STATUS) {
    return {
      configured: hasTelegram(),
      sent: false,
      skipped: true,
      reason: !hasTelegram() ? "telegram_not_configured" : "telegram_verbose_status_disabled",
    };
  }

  const key = stageKey || `status:${title}`;
  const state = videoId ? await loadState(videoId).catch(() => null) : null;
  const sentStatusKeys = Array.isArray(state?.telegram?.sent_status_keys)
    ? state.telegram.sent_status_keys
    : [];

  if (key && sentStatusKeys.includes(key)) {
    return {
      configured: true,
      sent: false,
      skipped: true,
      reason: "duplicate_status_key",
    };
  }

  const result = await sendTelegramMessage({
    text: buildWorkflowStatusMessage({ icon, title, videoId, lines }),
    parseMode: null,
  }).catch((error) => ({ configured: true, sent: false, error: error.message }));

  if (result.sent && state && key) {
    await updateState(videoId, {
      telegram: {
        sent_status_keys: [...new Set([...(sentStatusKeys || []), key])],
      },
    }).catch(() => null);
  }

  return result;
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

  lines.push("Responda a esta mensagem com 1, 2 ou 3 para continuar o fluxo automaticamente.");

  return lines.join("\n");
};

const buildFinalReviewMessage = ({
  videoId,
  title,
  renderPath,
  tags = [],
  reviewVersion = 1,
  reviewUrl = "",
  sheetUrl = "",
}) => {
  return [
    "🎬 Revisão Final Pronta",
    `video_id: ${videoId}`,
    `Versão: v${reviewVersion}`,
    `Título: ${title || "(não definido)"}`,
    reviewUrl ? `Revisão online: ${reviewUrl}` : null,
    sheetUrl ? `Planilha de revisão: ${sheetUrl}` : null,
    `Render local: ${renderPath || "não encontrado"}`,
    `Tags: ${tags.slice(0, 8).join(", ")}`,
    "",
    "Responda a esta mensagem com SIM para publicar ou NAO para revisão.",
  ]
    .filter(Boolean)
    .join("\n");
};

const basicTelegramHealthcheck = async ({ sendMessage = false } = {}) => {
  if (!hasTelegram()) {
    return { configured: false, ok: false, message: "Telegram não configurado" };
  }

  try {
    if (sendMessage) {
      const result = await sendTelegramMessage({ text: "✅ Healthcheck Telegram: integração ativa." });
      return { configured: true, ok: true, message: "Mensagem enviada", details: result };
    }

    const response = await axios.get(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getChat`, {
      params: { chat_id: config.TELEGRAM_CHAT_ID },
      timeout: 20000,
    });
    const chatId = response?.data?.result?.id;
    return {
      configured: true,
      ok: true,
      message: `Chat validado (${chatId || config.TELEGRAM_CHAT_ID})`,
    };
  } catch (error) {
    return { configured: true, ok: false, message: error.message };
  }
};

module.exports = {
  hasTelegram,
  sendTelegramMessage,
  sendWorkflowStatus,
  buildIdeasApprovalMessage,
  buildFinalReviewMessage,
  basicTelegramHealthcheck,
};
