const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");
const { consumeExternalCallBudget, isProviderDisabledInLocalTest } = require("./externalApiControlService");

const GEMINI_VISION_TIMEOUT_MS = Math.max(10000, Number(config.GEMINI_VISION_TIMEOUT_MS || 45000));
const DEFAULT_GEMINI_LITE_MODEL = String(config.GEMINI_VISION_MODEL_LITE || "gemini-2.5-flash-lite");
const GEMINI_VISION_MAX_RETRIES = Math.max(0, Number(config.GEMINI_VISION_MAX_RETRIES || 2));
const GEMINI_VISION_RETRY_BASE_MS = Math.max(200, Number(config.GEMINI_VISION_RETRY_BASE_MS || 1200));

const hasGemini = () =>
  Boolean(config.GEMINI_API_KEY && config.GEMINI_VISION_ENABLED !== false)
  && !isProviderDisabledInLocalTest("gemini");
const getGeminiBaseUrl = () => String(config.GEMINI_BASE_URL || "").replace(/\/+$/, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const imageMimeByExtension = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const safeJsonParse = (raw, fallback = null) => {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const extractJsonPayload = (rawText = "") => {
  const text = String(rawText || "").trim();
  if (!text) return null;

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) return safeJsonParse(fencedMatch[1], null);

  const parsed = safeJsonParse(text, null);
  if (parsed) return parsed;

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return safeJsonParse(text.slice(firstBrace, lastBrace + 1), null);
  }

  return null;
};

const formatProviderError = (error) => {
  const message = String(error?.message || "").trim();
  const status = Number(error?.response?.status || 0);
  const statusText = String(error?.response?.statusText || "").trim();
  const providerMessage =
    error?.response?.data?.error?.message
    || error?.response?.data?.message
    || error?.response?.data?.error
    || "";
  const code = String(error?.code || "").trim();

  if (providerMessage) return String(providerMessage);
  if (message) return message;
  if (status > 0) return `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  if (code) return code;
  return "Erro desconhecido no Gemini.";
};

const isRetryableGeminiError = (error) => {
  const status = Number(error?.response?.status || 0);
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.response?.data?.error?.message || error?.message || "").toLowerCase();
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code)) return true;
  if (message.includes("high demand")) return true;
  if (message.includes("rate limit")) return true;
  if (message.includes("temporar")) return true;
  if (message.includes("timeout")) return true;
  return false;
};

const buildModelList = ({ model = "", fallbackModels = [] } = {}) => [
  String(model || "").trim(),
  ...(Array.isArray(fallbackModels) ? fallbackModels : []),
  ...(Array.isArray(config.GEMINI_VISION_FALLBACK_MODELS) ? config.GEMINI_VISION_FALLBACK_MODELS : []),
]
  .map((item) => String(item || "").trim())
  .filter(Boolean)
  .filter((item, index, list) => list.indexOf(item) === index);

const callGeminiGenerateContent = async ({
  model = "",
  parts = [],
  timeoutMs = GEMINI_VISION_TIMEOUT_MS,
  responseMimeType = "",
}) => {
  const payload = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.1,
    },
  };
  if (responseMimeType) payload.generationConfig.responseMimeType = responseMimeType;

  return axios.post(
    `${getGeminiBaseUrl()}/models/${encodeURIComponent(String(model || "").trim())}:generateContent`,
    payload,
    {
      params: { key: config.GEMINI_API_KEY },
      timeout: Math.max(10000, Number(timeoutMs || GEMINI_VISION_TIMEOUT_MS)),
    }
  );
};

const callGeminiWithFallback = async ({
  model = DEFAULT_GEMINI_LITE_MODEL,
  fallbackModels = [],
  parts = [],
  timeoutMs = GEMINI_VISION_TIMEOUT_MS,
  responseMimeType = "",
  maxRetries = GEMINI_VISION_MAX_RETRIES,
  retryBaseMs = GEMINI_VISION_RETRY_BASE_MS,
}) => {
  const models = buildModelList({ model, fallbackModels });
  let lastError = null;
  const retries = Math.max(0, Number(maxRetries || 0));
  const retryDelayBaseMs = Math.max(100, Number(retryBaseMs || GEMINI_VISION_RETRY_BASE_MS));

  for (const candidateModel of models) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await callGeminiGenerateContent({
          model: candidateModel,
          parts,
          timeoutMs,
          responseMimeType,
        });
        const rawText = (response.data?.candidates || [])
          .flatMap((candidate) => candidate?.content?.parts || [])
          .map((part) => part?.text || "")
          .join("\n")
          .trim();
        return { rawText, model: candidateModel, responseData: response.data };
      } catch (error) {
        lastError = error;
        const retryable = isRetryableGeminiError(error);
        if (!retryable || attempt >= retries) break;
        const delayMs = retryDelayBaseMs * (2 ** attempt);
        await sleep(delayMs);
      }
    }
  }

  throw lastError || new Error("Falha ao chamar Gemini.");
};

const imagePathToInlineData = (imagePath = "") => {
  const extension = path.extname(imagePath || "").toLowerCase();
  const mimeType = imageMimeByExtension[extension] || "image/jpeg";
  const fileBuffer = fs.readFileSync(imagePath);
  return {
    inline_data: {
      mime_type: mimeType,
      data: fileBuffer.toString("base64"),
    },
  };
};

const describeImagesWithGemini = async ({
  prompt = "",
  imagePaths = [],
  model = DEFAULT_GEMINI_LITE_MODEL,
  fallbackModels = [],
  timeoutMs = GEMINI_VISION_TIMEOUT_MS,
  maxRetries = GEMINI_VISION_MAX_RETRIES,
  retryBaseMs = GEMINI_VISION_RETRY_BASE_MS,
  videoId = "",
}) => {
  if (!hasGemini()) return null;
  if (!Array.isArray(imagePaths) || !imagePaths.length) return null;
  const budget = consumeExternalCallBudget({
    provider: "gemini",
    videoId,
    operation: "describe_images",
  });
  if (!budget.allowed) return null;

  const resolvedModel = String(model || DEFAULT_GEMINI_LITE_MODEL).trim();
  if (!resolvedModel) return null;

  try {
    const { rawText, model: modelUsed } = await callGeminiWithFallback({
      model: resolvedModel,
      fallbackModels,
      parts: [
        { text: String(prompt || "") },
        ...imagePaths.map((imagePath) => imagePathToInlineData(imagePath)),
      ],
      timeoutMs,
      responseMimeType: "application/json",
      maxRetries,
      retryBaseMs,
    });

    const payload = extractJsonPayload(rawText);
    if (!payload) {
      logger.warn("Gemini image description unavailable, using fallback", {
        message: "Resposta sem JSON válido.",
        model: modelUsed || resolvedModel,
      });
      return null;
    }

    return payload;
  } catch (error) {
    logger.warn("Gemini image description unavailable, using fallback", {
      message: formatProviderError(error),
      model: resolvedModel,
    });
    return null;
  }
};

const generateTextWithGemini = async ({
  prompt = "",
  model = DEFAULT_GEMINI_LITE_MODEL,
  fallbackModels = [],
  timeoutMs = GEMINI_VISION_TIMEOUT_MS,
  videoId = "",
}) => {
  if (!hasGemini()) return null;
  if (!String(prompt || "").trim()) return null;
  const budget = consumeExternalCallBudget({
    provider: "gemini",
    videoId,
    operation: "generate_text",
  });
  if (!budget.allowed) return null;

  const { rawText, model: modelUsed } = await callGeminiWithFallback({
    model,
    fallbackModels,
    parts: [{ text: String(prompt || "").trim() }],
    timeoutMs,
    responseMimeType: "",
  });

  return {
    text: String(rawText || "").trim(),
    model: modelUsed,
  };
};

const basicGeminiHealthcheck = async () => {
  if (isProviderDisabledInLocalTest("gemini")) {
    return { configured: true, ok: true, message: "Gemini desativado em LOCAL_TEST_MODE" };
  }
  if (!hasGemini()) {
    return { configured: false, ok: false, message: "GEMINI_API_KEY ausente" };
  }

  try {
    const budget = consumeExternalCallBudget({
      provider: "gemini",
      videoId: "",
      operation: "healthcheck",
    });
    if (!budget.allowed) {
      return { configured: true, ok: true, message: "Gemini bloqueado pelo circuit breaker" };
    }
    const response = await axios.get(`${getGeminiBaseUrl()}/models`, {
      headers: { "x-goog-api-key": config.GEMINI_API_KEY },
      timeout: 20000,
    });

    return {
      configured: true,
      ok: true,
      message: `Modelos encontrados: ${response.data?.models?.length || 0}`,
    };
  } catch (error) {
    return { configured: true, ok: false, message: formatProviderError(error) };
  }
};

module.exports = {
  hasGemini,
  describeImagesWithGemini,
  generateTextWithGemini,
  basicGeminiHealthcheck,
};
