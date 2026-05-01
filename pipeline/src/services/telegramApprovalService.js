const path = require("path");
const axios = require("axios");
const { config } = require("../config/env");
const { listStates, updateState } = require("./stateService");
const { approveIdea } = require("./ideasService");
const { generateScript } = require("./scriptService");
const { generateAudio } = require("./ttsService");
const { generateCaptions } = require("./captionsService");
const { generateAssets } = require("./assetsService");
const { renderVideo } = require("./renderService");
const { generateMetadata } = require("./metadataService");
const { uploadToYoutube } = require("./youtubeService");
const { hasTelegram, sendTelegramMessage } = require("./telegramService");
const { requestReviewRegeneration } = require("./reviewRevisionService");
const { readJsonSafe, writeJsonAtomic } = require("../utils/fileUtils");
const { logger } = require("../utils/logger");

const POLLER_STATE_PATH = path.join(config.OUTPUT_ROOT, "system", "telegram-poller.json");

let pollerStarted = false;
let stopRequested = false;
let nextPollTimer = null;

const telegramApiUrl = (method) =>
  `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`;

const toEpochMs = (value) => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeText = (value = "") => String(value).trim();

const normalizeDecision = (value = "") =>
  normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const parseIdeaChoice = (text = "") => {
  const normalized = normalizeText(text);
  if (!/^[1-3]$/.test(normalized)) return null;
  return Number(normalized);
};

const parseFinalApproval = (text = "") => {
  const normalized = normalizeDecision(text);

  if (["sim", "s", "aprovar", "aprovado", "ok", "publicar"].includes(normalized)) {
    return { approved: true, note: text };
  }

  if (["nao", "n", "revisar", "reprovado", "recusar"].includes(normalized)) {
    return { approved: false, note: text };
  }

  return null;
};

const sortNewestFirst = (left, right) => toEpochMs(right.updated_at) - toEpochMs(left.updated_at);

const loadPollerState = async () => readJsonSafe(POLLER_STATE_PATH, { last_update_id: 0 });

const savePollerState = async (state) => writeJsonAtomic(POLLER_STATE_PATH, state);

const postToN8nWebhook = async ({ pathName, payload }) => {
  return axios.post(`${config.N8N_BASE_URL}/webhook/${pathName}`, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 45000,
  });
};

const shouldUseDirectFallback = (error) => {
  const status = error?.response?.status;
  return status === 404 || error?.code === "ECONNREFUSED" || error?.code === "ENOTFOUND";
};

const runDirectIdeaApprovalFlow = async ({ videoId, ideaNumber }) => {
  await approveIdea({ videoId, ideaNumber });
  await generateScript({ videoId, mockMode: config.MOCK_MODE });
  await generateAudio({ videoId, mockMode: config.MOCK_MODE, provider: "multivozes" });
  await generateCaptions({ videoId, mockMode: config.MOCK_MODE });
  await generateAssets({ videoId, mockMode: config.MOCK_MODE });
  await renderVideo({ videoId, mockMode: config.MOCK_MODE });
  await generateMetadata({ videoId, mockMode: config.MOCK_MODE });
};

const runDirectFinalApprovalFlow = async ({ videoId, approved }) => {
  if (approved) {
    await updateState(
      videoId,
      {
        approved,
        error_message: "",
      },
      {
        currentStep: "final_approved",
        status: "final_approved",
      }
    );

    await uploadToYoutube({ videoId, mockMode: config.MOCK_MODE });
    return;
  }

  await requestReviewRegeneration({
    videoId,
    note: "Reprovado via resposta final no Telegram",
    mockMode: config.MOCK_MODE,
  });
};

const resolveIdeaApprovalState = ({ states, message }) => {
  const replyToMessageId = message.reply_to_message?.message_id;
  const messageDateMs = Number(message.date || 0) * 1000;

  if (replyToMessageId) {
    const exact = states.find(
      (state) =>
        state.current_step === "ideas_generated" &&
        Number(state.telegram?.ideas_message_id) === Number(replyToMessageId)
    );

    if (exact) return exact;
  }

  return (
    states
      .filter((state) => {
        if (state.current_step !== "ideas_generated") return false;
        const sentAtMs = toEpochMs(state.telegram?.ideas_message_sent_at || state.updated_at);
        return sentAtMs <= messageDateMs;
      })
      .sort(sortNewestFirst)[0] || null
  );
};

const resolveFinalApprovalState = ({ states, message }) => {
  const replyToMessageId = message.reply_to_message?.message_id;
  const messageDateMs = Number(message.date || 0) * 1000;

  if (replyToMessageId) {
    const exact = states.find(
      (state) =>
        state.status === "awaiting_final_approval" &&
        Number(state.telegram?.final_review_message_id) === Number(replyToMessageId)
    );

    if (exact) return exact;
  }

  return (
    states
      .filter((state) => {
        if (state.status !== "awaiting_final_approval") return false;
        const sentAtMs = toEpochMs(state.telegram?.final_review_message_sent_at || state.updated_at);
        return sentAtMs <= messageDateMs;
      })
      .sort(sortNewestFirst)[0] || null
  );
};

const rememberInboundTelegramMessage = async ({ videoId, message }) => {
  await updateState(videoId, {
    telegram: {
      last_inbound_message_id: message.message_id || null,
      last_inbound_text: normalizeText(message.text || ""),
      last_inbound_at: message.date
        ? new Date(Number(message.date) * 1000).toISOString()
        : new Date().toISOString(),
    },
  });
};

const isDuplicateInboundTelegramMessage = ({ state, message }) => {
  return Number(state?.telegram?.last_inbound_message_id || 0) === Number(message?.message_id || 0);
};

const handleIdeaApprovalMessage = async ({ states, message, ideaNumber }) => {
  const state = resolveIdeaApprovalState({ states, message });
  if (!state) {
    return { handled: false, reason: "no_pending_idea_approval" };
  }

  if (isDuplicateInboundTelegramMessage({ state, message })) {
    logger.info("Ignoring duplicate Telegram idea approval message", {
      video_id: state.video_id,
      message_id: message.message_id,
    });
    return { handled: true, kind: "idea_approval_duplicate", video_id: state.video_id };
  }

  let mode = "n8n_webhook";

  try {
    await postToN8nWebhook({
      pathName: config.N8N_IDEA_APPROVAL_WEBHOOK_PATH,
      payload: {
        video_id: state.video_id,
        idea_number: ideaNumber,
      },
    });
  } catch (error) {
    if (!shouldUseDirectFallback(error)) {
      throw error;
    }

    mode = "direct_fallback";
    logger.warn("n8n idea approval webhook unavailable, using direct backend flow", {
      video_id: state.video_id,
      message: error.message,
    });
    await runDirectIdeaApprovalFlow({ videoId: state.video_id, ideaNumber });
  }

  await rememberInboundTelegramMessage({ videoId: state.video_id, message });

  await sendTelegramMessage({
    text: `Escolha ${ideaNumber} recebida para o video ${state.video_id}. Continuando o fluxo no n8n.`,
    parseMode: null,
    replyToMessageId: message.message_id,
  }).catch(() => null);

  logger.info("Telegram idea approval forwarded to n8n", {
    video_id: state.video_id,
    idea_number: ideaNumber,
    mode,
  });

  return { handled: true, kind: "idea_approval", video_id: state.video_id, mode };
};

const handleFinalApprovalMessage = async ({ states, message, decision }) => {
  const state = resolveFinalApprovalState({ states, message });
  if (!state) {
    return { handled: false, reason: "no_pending_final_approval" };
  }

  if (isDuplicateInboundTelegramMessage({ state, message })) {
    logger.info("Ignoring duplicate Telegram final approval message", {
      video_id: state.video_id,
      message_id: message.message_id,
    });
    return { handled: true, kind: "final_approval_duplicate", video_id: state.video_id };
  }

  let mode = "n8n_webhook";

  try {
    await postToN8nWebhook({
      pathName: config.N8N_FINAL_APPROVAL_WEBHOOK_PATH,
      payload: {
        video_id: state.video_id,
        approved: decision.approved,
        note: normalizeText(decision.note || ""),
      },
    });
  } catch (error) {
    if (!shouldUseDirectFallback(error)) {
      throw error;
    }

    mode = "direct_fallback";
    logger.warn("n8n final approval webhook unavailable, using direct backend flow", {
      video_id: state.video_id,
      message: error.message,
    });
    await runDirectFinalApprovalFlow({ videoId: state.video_id, approved: decision.approved });
  }

  await rememberInboundTelegramMessage({ videoId: state.video_id, message });

  await sendTelegramMessage({
    text: decision.approved
      ? `Aprovacao final recebida para o video ${state.video_id}. Seguindo para upload.`
      : `Pedido de revisao recebido para o video ${state.video_id}. Gerando uma nova versao para revisao.`,
    parseMode: null,
    replyToMessageId: message.message_id,
  }).catch(() => null);

  logger.info("Telegram final approval forwarded to n8n", {
    video_id: state.video_id,
    approved: decision.approved,
    mode,
  });

  return { handled: true, kind: "final_approval", video_id: state.video_id, mode };
};

const processTelegramUpdate = async (update) => {
  const message = update?.message;
  if (!message?.text) {
    return { handled: false, reason: "no_text_message" };
  }

  if (String(message.chat?.id || "") !== String(config.TELEGRAM_CHAT_ID)) {
    return { handled: false, reason: "unexpected_chat" };
  }

  const text = normalizeText(message.text);
  const states = await listStates();

  const ideaNumber = parseIdeaChoice(text);
  if (ideaNumber) {
    return handleIdeaApprovalMessage({ states, message, ideaNumber });
  }

  const finalDecision = parseFinalApproval(text);
  if (finalDecision) {
    return handleFinalApprovalMessage({ states, message, decision: finalDecision });
  }

  return { handled: false, reason: "unsupported_message" };
};

const pollTelegramOnce = async () => {
  const currentState = await loadPollerState();
  const response = await axios.get(telegramApiUrl("getUpdates"), {
    params: {
      offset: Number(currentState.last_update_id || 0) + 1,
      timeout: 10,
    },
    timeout: 20000,
  });

  const updates = Array.isArray(response.data?.result) ? response.data.result : [];
  let lastUpdateId = Number(currentState.last_update_id || 0);

  for (const update of updates) {
    lastUpdateId = Math.max(lastUpdateId, Number(update.update_id || 0));

    try {
      await processTelegramUpdate(update);
    } catch (error) {
      logger.warn("Failed to process Telegram update", {
        update_id: update.update_id,
        message: error.message,
      });
    }
  }

  if (lastUpdateId !== Number(currentState.last_update_id || 0)) {
    await savePollerState({
      last_update_id: lastUpdateId,
      updated_at: new Date().toISOString(),
    });
  }
};

const scheduleNextPoll = (delayMs = 0) => {
  nextPollTimer = setTimeout(async () => {
    if (stopRequested) return;

    try {
      await pollTelegramOnce();
    } catch (error) {
      logger.warn("Telegram polling iteration failed", { message: error.message });
    }

    if (!stopRequested) {
      scheduleNextPoll(config.TELEGRAM_POLL_INTERVAL_MS);
    }
  }, delayMs);
};

const startTelegramApprovalPolling = () => {
  if (pollerStarted) return;
  if (!hasTelegram()) {
    logger.info("Telegram approval polling disabled because Telegram is not configured");
    return;
  }

  stopRequested = false;
  pollerStarted = true;
  logger.info("Telegram approval polling started", {
    interval_ms: config.TELEGRAM_POLL_INTERVAL_MS,
    n8n_base_url: config.N8N_BASE_URL,
  });
  scheduleNextPoll(0);
};

const stopTelegramApprovalPolling = () => {
  stopRequested = true;
  if (nextPollTimer) {
    clearTimeout(nextPollTimer);
    nextPollTimer = null;
  }
};

module.exports = {
  startTelegramApprovalPolling,
  stopTelegramApprovalPolling,
  processTelegramUpdate,
};