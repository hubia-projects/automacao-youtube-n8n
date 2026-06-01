const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { google } = require("googleapis");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");
const { consumeExternalCallBudget, isProviderDisabledInLocalTest } = require("./externalApiControlService");

const GEMINI_VISION_TIMEOUT_MS = Math.max(10000, Number(config.GEMINI_VISION_TIMEOUT_MS || 45000));
const DEFAULT_GEMINI_LITE_MODEL = String(config.GEMINI_VISION_MODEL_LITE || "gemini-2.5-flash-lite");
const DEFAULT_GEMINI_TEXT_MODEL = String(process.env.GEMINI_TEXT_MODEL || config.GEMINI_VISION_MODEL_LITE || "gemini-2.5-flash-lite");
const DEFAULT_GEMINI_TEXT_FALLBACK_MODELS = String(process.env.GEMINI_TEXT_FALLBACK_MODELS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const DEFAULT_GEMINI_TRANSCRIBE_MODEL = String(process.env.GEMINI_TRANSCRIBE_MODEL || config.GEMINI_VISION_MODEL_FULL || "gemini-2.5-flash");
const DEFAULT_GEMINI_IMAGE_MODEL = String(process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image").trim();
const DEFAULT_GEMINI_VIDEO_MODEL = String(process.env.GEMINI_VIDEO_MODEL || "veo-3.0-fast-generate-001").trim();
const DEFAULT_GEMINI_VIDEO_API_VERSION = String(process.env.GEMINI_VIDEO_API_VERSION || "v1beta1").trim() || "v1beta1";
const DEFAULT_GEMINI_OPERATION_POLL_API_VERSIONS = [...new Set(
  [
    String(process.env.GEMINI_OPERATION_POLL_API_VERSIONS || "").split(",").map((item) => item.trim()).filter(Boolean),
    DEFAULT_GEMINI_VIDEO_API_VERSION,
    "v1beta1",
    "v1",
  ].flat().filter(Boolean)
)];
const DEFAULT_GEMINI_OPERATION_POLL_INTERVAL_MS = Math.max(1500, Number(process.env.GEMINI_OPERATION_POLL_INTERVAL_MS || 8000));
const GEMINI_MAX_INLINE_AUDIO_BYTES = Math.max(1024 * 1024, Number(process.env.GEMINI_MAX_INLINE_AUDIO_BYTES || (18 * 1024 * 1024)));
const GEMINI_VISION_MAX_RETRIES = Math.max(0, Number(config.GEMINI_VISION_MAX_RETRIES || 2));
const GEMINI_VISION_RETRY_BASE_MS = Math.max(200, Number(config.GEMINI_VISION_RETRY_BASE_MS || 1200));
const GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const hasVertexGemini = () =>
  Boolean(
    config.GEMINI_VERTEX_ENABLED
    && config.GOOGLE_CLOUD_PROJECT
    && config.GOOGLE_CLOUD_LOCATION
    && config.GOOGLE_APPLICATION_CREDENTIALS
    && fs.existsSync(config.GOOGLE_APPLICATION_CREDENTIALS)
    && config.GEMINI_VISION_ENABLED !== false
  )
  && !isProviderDisabledInLocalTest("gemini");

const hasGemini = () =>
  Boolean((hasVertexGemini() || config.GEMINI_API_KEY) && config.GEMINI_VISION_ENABLED !== false)
  && !isProviderDisabledInLocalTest("gemini");
const getGeminiBaseUrl = () => String(config.GEMINI_BASE_URL || "").replace(/\/+$/, "");
const getVertexBaseUrl = (apiVersion = "v1") => `https://${config.GOOGLE_CLOUD_LOCATION}-aiplatform.googleapis.com/${String(apiVersion || "v1").trim() || "v1"}`;
const getVertexPublisherModelPath = (model = "") => `projects/${config.GOOGLE_CLOUD_PROJECT}/locations/${config.GOOGLE_CLOUD_LOCATION}/publishers/google/models/${String(model || "").trim()}`;
const getVertexPublisherModelUrl = (model = "", apiVersion = "v1") => `${getVertexBaseUrl(apiVersion)}/${getVertexPublisherModelPath(model)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const callWithGeminiRetry = async ({
  operation = async () => null,
  maxRetries = GEMINI_VISION_MAX_RETRIES,
  retryBaseMs = GEMINI_VISION_RETRY_BASE_MS,
} = {}) => {
  const retries = Math.max(0, Number(maxRetries || 0));
  const retryDelayBaseMs = Math.max(100, Number(retryBaseMs || GEMINI_VISION_RETRY_BASE_MS));
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableGeminiError(error) || attempt >= retries) break;
      const delayMs = retryDelayBaseMs * (2 ** attempt);
      await sleep(delayMs);
    }
  }

  throw lastError || new Error("Falha ao chamar Gemini/Vertex.");
};
let vertexAuthClientPromise = null;

const normalizeOperationName = (value = "") => String(value || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
const uniqueStrings = (values = []) => [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];

const normalizeInlineBlob = (blob = {}, useVertex = false) => {
  const mimeType = String(blob.mimeType || blob.mime_type || "").trim();
  const data = String(blob.data || "");
  if (useVertex) {
    return {
      mimeType,
      data,
    };
  }

  return {
    mime_type: mimeType,
    data,
  };
};

const normalizePartForProvider = (part = {}, useVertex = false) => {
  if (part === null || part === undefined) return part;
  if (typeof part !== "object") return part;
  if (part.text) return { text: part.text };

  const inlineBlob = part.inlineData || part.inline_data;
  if (inlineBlob) {
    return useVertex
      ? { inlineData: normalizeInlineBlob(inlineBlob, true) }
      : { inline_data: normalizeInlineBlob(inlineBlob, false) };
  }

  const fileBlob = part.fileData || part.file_data;
  if (fileBlob) {
    const mimeType = String(fileBlob.mimeType || fileBlob.mime_type || "").trim();
    const fileUri = String(fileBlob.fileUri || fileBlob.file_uri || "").trim();
    return useVertex
      ? { fileData: { mimeType, fileUri } }
      : { file_data: { mime_type: mimeType, file_uri: fileUri } };
  }

  return part;
};

const extractCandidateParts = (responseData = {}) =>
  (responseData?.candidates || []).flatMap((candidate) => candidate?.content?.parts || []);

const getVertexAuthClient = async () => {
  if (!hasVertexGemini()) return null;

  if (!vertexAuthClientPromise) {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: [GOOGLE_CLOUD_SCOPE],
    });
    vertexAuthClientPromise = auth.getClient();
  }

  return vertexAuthClientPromise;
};

const getVertexAccessToken = async () => {
  const client = await getVertexAuthClient();
  if (!client) return "";

  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;
  return String(token || "").trim();
};

const getVertexAuthHeaders = async () => {
  const accessToken = await getVertexAccessToken();
  if (!accessToken) {
    throw new Error("Nao foi possivel obter access token do Vertex AI.");
  }
  return {
    Authorization: `Bearer ${accessToken}`,
  };
};

const callVertexPredict = async ({
  model = "",
  instances = [],
  parameters = {},
  timeoutMs = GEMINI_VISION_TIMEOUT_MS,
  apiVersion = "v1",
}) => {
  const headers = await getVertexAuthHeaders();
  return callWithGeminiRetry({
    operation: () => axios.post(
      `${getVertexPublisherModelUrl(model, apiVersion)}:predict`,
      {
        instances,
        parameters,
      },
      {
        headers,
        timeout: Math.max(10000, Number(timeoutMs || GEMINI_VISION_TIMEOUT_MS)),
      }
    ),
  });
};

const callVertexVideoPredict = async ({
  model = DEFAULT_GEMINI_VIDEO_MODEL,
  instances = [],
  parameters = {},
  timeoutMs = Math.max(GEMINI_VISION_TIMEOUT_MS, 120000),
  apiVersion = DEFAULT_GEMINI_VIDEO_API_VERSION,
}) => {
  const headers = await getVertexAuthHeaders();
  const payload = { instances, parameters };
  const resolvedApiVersion = String(apiVersion || DEFAULT_GEMINI_VIDEO_API_VERSION).trim() || DEFAULT_GEMINI_VIDEO_API_VERSION;
  const url = `${getVertexPublisherModelUrl(model, resolvedApiVersion)}:predictLongRunning`;

  return callWithGeminiRetry({
    operation: async () => {
      try {
        return await axios.post(url, payload, {
          headers,
          timeout: Math.max(10000, Number(timeoutMs || 120000)),
        });
      } catch (error) {
        const status = Number(error?.response?.status || 0);
        if (![404, 405, 501].includes(status)) throw error;
        return axios.post(`${getVertexPublisherModelUrl(model, resolvedApiVersion)}:predict`, payload, {
          headers,
          timeout: Math.max(10000, Number(timeoutMs || 120000)),
        });
      }
    },
  });
};

const parseVertexOperationName = (operationName = "") => {
  const normalized = normalizeOperationName(operationName);
  const match = normalized.match(/^projects\/([^/]+)\/locations\/([^/]+)\/(.+)\/operations\/([^/]+)$/i);
  if (!match) return null;

  return {
    project: String(match[1] || "").trim(),
    location: String(match[2] || "").trim(),
    resourcePath: String(match[3] || "").trim(),
    operationId: String(match[4] || "").trim(),
    name: normalized,
  };
};

const buildVertexOperationLookupCandidates = ({ operationName = "", projectNumber = "" } = {}) => {
  const normalized = normalizeOperationName(operationName);
  const parsed = parseVertexOperationName(normalized);
  if (!normalized || !parsed?.location) return [];

  const apiVersions = DEFAULT_GEMINI_OPERATION_POLL_API_VERSIONS;
  const projectCandidates = uniqueStrings([
    projectNumber,
    config.GOOGLE_CLOUD_PROJECT_NUMBER,
    parsed.project,
    config.GOOGLE_CLOUD_PROJECT,
  ]);
  const lookupCandidates = [];

  apiVersions.forEach((apiVersion) => {
    lookupCandidates.push({
      apiVersion,
      strategy: "direct_name",
      url: `${getVertexBaseUrl(apiVersion)}/${normalized}`,
    });
    lookupCandidates.push({
      apiVersion,
      strategy: "direct_name_encoded",
      url: `${getVertexBaseUrl(apiVersion)}/${encodeURIComponent(normalized)}`,
    });
    lookupCandidates.push({
      apiVersion,
      strategy: "global_operation_id",
      url: `${getVertexBaseUrl(apiVersion)}/operations/${encodeURIComponent(parsed.operationId)}`,
    });
  });

  projectCandidates.forEach((projectCandidate) => {
    apiVersions.forEach((apiVersion) => {
      lookupCandidates.push({
        apiVersion,
        strategy: "projects_locations_operations",
        url: `${getVertexBaseUrl(apiVersion)}/projects/${encodeURIComponent(projectCandidate)}/locations/${encodeURIComponent(parsed.location)}/operations/${encodeURIComponent(parsed.operationId)}`,
      });
    });
  });

  return lookupCandidates.filter((candidate, index, list) =>
    candidate.url && list.findIndex((entry) => entry.url === candidate.url) === index
  );
};

const isUnsupportedVertexOperationLookupError = (error) => {
  const status = Number(error?.response?.status || 0);
  const providerMessage = String(error?.response?.data?.error?.message || error?.message || "");
  if (status === 404) return true;
  if (status === 400 && /Operation ID must be a Long/i.test(providerMessage)) return true;
  if (status === 400 && /Invalid resource field value/i.test(providerMessage)) return true;
  return false;
};

const extractVideoPredictionArtifact = (responseData = {}) => {
  const prediction = Array.isArray(responseData?.predictions) ? responseData.predictions[0] : null;
  if (!prediction) return null;

  const bytesBase64 = String(
    prediction.bytesBase64Encoded
    || prediction.bytesBase64encoded
    || prediction.video?.bytesBase64Encoded
    || prediction.video?.bytesBase64encoded
    || ""
  ).trim();
  const mimeType = String(
    prediction.mimeType
    || prediction.video?.mimeType
    || "video/mp4"
  ).trim() || "video/mp4";
  const uri = String(
    prediction.gcsUri
    || prediction.fileUri
    || prediction.outputUri
    || prediction.storageUri
    || prediction.video?.gcsUri
    || prediction.video?.uri
    || ""
  ).trim();

  return {
    prediction,
    bytesBase64,
    mimeType,
    uri,
  };
};

const writeBase64ArtifactToPath = ({ base64Data = "", outputPath = "" } = {}) => {
  if (!String(base64Data || "").trim() || !String(outputPath || "").trim()) return "";
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(base64Data, "base64"));
  return outputPath;
};

const buildVertexMediaStudioUrl = ({ project = config.GOOGLE_CLOUD_PROJECT, location = config.GOOGLE_CLOUD_LOCATION } = {}) =>
  `https://console.cloud.google.com/vertex-ai/studio/media/video?project=${encodeURIComponent(String(project || "").trim())}&location=${encodeURIComponent(String(location || "").trim())}`;

const getVertexOperationStatus = async ({ operationName = "", projectNumber = "", timeoutMs = 20000 } = {}) => {
  const normalized = normalizeOperationName(operationName);
  const parsed = parseVertexOperationName(normalized);
  if (!normalized || !parsed) {
    return {
      ok: false,
      supported: false,
      message: "Nome de operacao Veo invalido.",
      attempts: [],
    };
  }

  const headers = await getVertexAuthHeaders();
  const attempts = [];
  let lastError = null;

  for (const candidate of buildVertexOperationLookupCandidates({ operationName: normalized, projectNumber })) {
    try {
      const response = await axios.get(candidate.url, {
        headers,
        timeout: Math.max(5000, Number(timeoutMs || 20000)),
      });
      return {
        ok: true,
        supported: true,
        operation: response.data,
        attempt: candidate,
        attempts,
      };
    } catch (error) {
      lastError = error;
      attempts.push({
        ...candidate,
        status: Number(error?.response?.status || 0),
        message: formatProviderError(error),
      });
    }
  }

  const supported = attempts.some((attempt) => ![400, 404].includes(Number(attempt.status || 0)));
  const unsupportedByApi = attempts.length > 0 && attempts.every((attempt) => {
    const errorLike = {
      response: {
        status: attempt.status,
        data: { error: { message: attempt.message } },
      },
      message: attempt.message,
    };
    return isUnsupportedVertexOperationLookupError(errorLike);
  });

  return {
    ok: false,
    supported: supported && !unsupportedByApi,
    unsupported_by_api: unsupportedByApi,
    message: unsupportedByApi
      ? "A operacao Veo foi criada, mas a API nao expoe um endpoint REST legivel de polling para esse nome nesta conta/regiao."
      : formatProviderError(lastError),
    attempts,
  };
};

const waitForVertexOperation = async ({
  operationName = "",
  projectNumber = "",
  timeoutMs = 15 * 60 * 1000,
  pollIntervalMs = DEFAULT_GEMINI_OPERATION_POLL_INTERVAL_MS,
} = {}) => {
  const deadline = Date.now() + Math.max(5000, Number(timeoutMs || 0));
  let lastResult = null;

  while (Date.now() <= deadline) {
    lastResult = await getVertexOperationStatus({
      operationName,
      projectNumber,
      timeoutMs: Math.min(Math.max(5000, Number(pollIntervalMs || DEFAULT_GEMINI_OPERATION_POLL_INTERVAL_MS)), 30000),
    });

    if (!lastResult.supported || !lastResult.ok) {
      return {
        ...lastResult,
        done: false,
      };
    }

    if (lastResult.operation?.done === true) {
      return {
        ...lastResult,
        done: true,
      };
    }

    if (Date.now() + pollIntervalMs > deadline) break;
    await sleep(Math.max(1000, Number(pollIntervalMs || DEFAULT_GEMINI_OPERATION_POLL_INTERVAL_MS)));
  }

  return {
    ...(lastResult || {}),
    ok: Boolean(lastResult?.ok),
    supported: Boolean(lastResult?.supported),
    done: Boolean(lastResult?.operation?.done),
    timed_out: true,
    message: lastResult?.message || "Timeout aguardando operacao Vertex.",
  };
};

const imageMimeByExtension = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const audioMimeByExtension = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
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
  generationConfig = {},
}) => {
  const useVertex = hasVertexGemini();
  const payload = {
    contents: [{ role: "user", parts: parts.map((part) => normalizePartForProvider(part, useVertex)) }],
    generationConfig: {
      temperature: 0.1,
      ...generationConfig,
    },
  };
  if (responseMimeType) payload.generationConfig.responseMimeType = responseMimeType;

  if (useVertex) {
    const headers = await getVertexAuthHeaders();
    return axios.post(
      `${getVertexPublisherModelUrl(model)}:generateContent`,
      payload,
      {
        headers,
        timeout: Math.max(10000, Number(timeoutMs || GEMINI_VISION_TIMEOUT_MS)),
      }
    );
  }

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
  generationConfig = {},
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
          generationConfig,
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

const audioPathToInlineData = (audioPath = "") => {
  const extension = path.extname(audioPath || "").toLowerCase();
  const mimeType = audioMimeByExtension[extension] || "audio/mpeg";
  const fileBuffer = fs.readFileSync(audioPath);
  return {
    inline_data: {
      mime_type: mimeType,
      data: fileBuffer.toString("base64"),
    },
  };
};

const buildScriptDurationHint = (targetDurationSeconds = 0) => {
  const numericTarget = Number(targetDurationSeconds || 0);
  if (!(numericTarget > 0)) {
    return {
      scriptRequirement: "roteiro completo para 10-15 minutos",
      durationInstruction: "",
    };
  }

  const minutes = numericTarget % 60 === 0
    ? String(Math.round(numericTarget / 60))
    : (numericTarget / 60).toFixed(1);
  const targetWords = Math.max(180, Math.round(numericTarget * 2.3));
  const minWords = Math.max(160, targetWords - 40);
  const maxWords = targetWords + 40;

  return {
    scriptRequirement: `roteiro completo para aproximadamente ${minutes} minutos (${minWords} a ${maxWords} palavras de narracao)`,
    durationInstruction: `Duracao alvo: aproximadamente ${minutes} minutos. O campo script_text deve ter entre ${minWords} e ${maxWords} palavras de narracao corrida. Nunca entregue menos de ${minWords} palavras no script_text. Se precisar, expanda exemplos concretos, transicoes e detalhes visuais para atingir essa faixa sem enrolacao.`,
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
  model = DEFAULT_GEMINI_TEXT_MODEL,
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

const generateIdeasWithGemini = async ({ count = 5, videoId = "" }) => {
  if (!hasGemini()) return null;
  const budget = consumeExternalCallBudget({
    provider: "gemini",
    videoId,
    operation: "generate_ideas",
  });
  if (!budget.allowed) return null;

  const prompt = `Voce e um estrategista de YouTube para conteudo faceless de viagem. Gere ${count} ideias com alta retencao e risco factual baixo. Responda SOMENTE JSON valido no formato {"ideas":[{"idea_id":"string","topic":"string","angle":"string","scores":{"search_demand":0,"evergreen":0,"retention":0,"monetization":0,"visual_assets":0,"factual_risk":0},"notes":"string"}]}.`;

  try {
    const { rawText } = await callGeminiWithFallback({
      model: DEFAULT_GEMINI_TEXT_MODEL,
      fallbackModels: DEFAULT_GEMINI_TEXT_FALLBACK_MODELS,
      parts: [{ text: prompt }],
      timeoutMs: GEMINI_VISION_TIMEOUT_MS,
      responseMimeType: "application/json",
    });
    const payload = extractJsonPayload(rawText);
    return Array.isArray(payload?.ideas) ? payload.ideas : null;
  } catch (error) {
    logger.warn("Gemini ideas generation unavailable, using fallback", {
      message: formatProviderError(error),
    });
    return null;
  }
};

const generateScriptPackageWithGemini = async ({
  topic,
  angle,
  targetDurationSeconds = 0,
  videoId = "",
}) => {
  if (!hasGemini()) return null;
  const budget = consumeExternalCallBudget({
    provider: "gemini",
    videoId,
    operation: "generate_script_package",
  });
  if (!budget.allowed) return null;

  const durationHint = buildScriptDurationHint(targetDurationSeconds);
  const prompt = `Voce e roteirista especialista em videos faceless para YouTube. Escreva em portugues do Brasil com alta retencao. Tema: ${topic}. Angulo: ${angle || "educativo/documental"}. ${durationHint.durationInstruction || ""} O array structured_blocks deve cobrir toda a narracao em blocos sequenciais de 30-60s. visual_type deve ser "specific" quando a cena precisa de exatidao, ou "generic" para b-roll generico. Retorne SOMENTE JSON valido com: {"video_objective":"","intro_hook":"","research_json":{"facts":[""],"risks":[""],"sources":[""]},"outline_json":{"sections":[{"title":"","objective":""}]},"script_text":"${durationHint.scriptRequirement}","visual_suggestions":[{"section":"","shots":[""]}],"factual_notes":[""],"seo_keywords":[""],"youtube_title_options":[""],"youtube_description":"","tags":[""],"chapters":["00:00 Introducao"],"structured_blocks":[{"block_id":"b01","text":"","duration_estimate":45,"visual_type":"generic","visual_description":"","keywords":[""]}]}.`;

  try {
    const { rawText } = await callGeminiWithFallback({
      model: DEFAULT_GEMINI_TEXT_MODEL,
      fallbackModels: DEFAULT_GEMINI_TEXT_FALLBACK_MODELS,
      parts: [{ text: prompt }],
      timeoutMs: GEMINI_VISION_TIMEOUT_MS,
      responseMimeType: "application/json",
    });
    const payload = extractJsonPayload(rawText);
    if (payload) {
      const { validateScriptPackage } = require("./openaiService");
      const valid = validateScriptPackage(payload);
      if (!valid) logger.warn("[Gemini] Script package invalido, continuando com fallback local");
    }
    return payload;
  } catch (error) {
    logger.warn("Gemini script generation unavailable, using fallback", {
      message: formatProviderError(error),
    });
    return null;
  }
};

const generateMetadataWithGemini = async ({ topic, scriptText, videoId = "" }) => {
  if (!hasGemini()) return null;
  const budget = consumeExternalCallBudget({
    provider: "gemini",
    videoId,
    operation: "generate_metadata",
  });
  if (!budget.allowed) return null;

  const prompt = `Voce e especialista em SEO para YouTube no nicho de viagem. Responda SOMENTE JSON valido. Tema: ${topic}. Roteiro: ${(scriptText || "").slice(0, 7000)}. Retorne {"title":"","description":"","tags":[],"chapters":[],"thumbnail_prompt":""}.`;

  try {
    const { rawText } = await callGeminiWithFallback({
      model: DEFAULT_GEMINI_TEXT_MODEL,
      fallbackModels: DEFAULT_GEMINI_TEXT_FALLBACK_MODELS,
      parts: [{ text: prompt }],
      timeoutMs: GEMINI_VISION_TIMEOUT_MS,
      responseMimeType: "application/json",
    });
    return extractJsonPayload(rawText);
  } catch (error) {
    logger.warn("Gemini metadata generation unavailable, using fallback", {
      message: formatProviderError(error),
    });
    return null;
  }
};

const transcribeWithGemini = async ({ audioPath, format = "text", videoId = "" }) => {
  if (!hasGemini()) return null;
  if (!audioPath || !fs.existsSync(audioPath)) return null;

  const stats = fs.statSync(audioPath);
  if (Number(stats.size || 0) > GEMINI_MAX_INLINE_AUDIO_BYTES) {
    logger.warn("Gemini transcription skipped: audio too large for inline upload", {
      bytes: Number(stats.size || 0),
      max_bytes: GEMINI_MAX_INLINE_AUDIO_BYTES,
    });
    return null;
  }

  const budget = consumeExternalCallBudget({
    provider: "gemini",
    videoId,
    operation: "transcribe_audio",
  });
  if (!budget.allowed) return null;

  const prompt = format === "srt"
    ? "Transcreva este audio em portugues do Brasil e retorne SOMENTE legendas no formato SRT valido."
    : "Transcreva este audio em portugues do Brasil e retorne SOMENTE o texto corrido da narracao, sem comentarios extras.";

  try {
    const { rawText } = await callGeminiWithFallback({
      model: DEFAULT_GEMINI_TRANSCRIBE_MODEL,
      fallbackModels: DEFAULT_GEMINI_TEXT_FALLBACK_MODELS,
      parts: [{ text: prompt }, audioPathToInlineData(audioPath)],
      timeoutMs: Math.max(GEMINI_VISION_TIMEOUT_MS, 120000),
      responseMimeType: "",
    });
    return String(rawText || "").trim() || null;
  } catch (error) {
    logger.warn("Gemini transcription unavailable, using fallback", {
      message: formatProviderError(error),
    });
    return null;
  }
};

const generateImageWithGemini = async ({ prompt, videoId = "", outputPath = "" }) => {
  if (!hasGemini()) return null;
  if (!String(prompt || "").trim()) return null;
  if (!DEFAULT_GEMINI_IMAGE_MODEL) {
    logger.info("Gemini image generation skipped: GEMINI_IMAGE_MODEL não configurado", {
      videoId,
      outputPath,
    });
    return null;
  }

  const budget = consumeExternalCallBudget({
    provider: "gemini",
    videoId,
    operation: "generate_image",
  });
  if (!budget.allowed) return null;

  if (!hasVertexGemini()) {
    logger.warn("Gemini image generation requires Vertex AI credentials; skipping legacy AI Studio path", {
      videoId,
      model: DEFAULT_GEMINI_IMAGE_MODEL,
      outputPath,
    });
    return null;
  }

  try {
    let imageBytes = "";
    let mimeType = "image/png";

    if (/^gemini-/i.test(DEFAULT_GEMINI_IMAGE_MODEL)) {
      const { responseData, model: modelUsed } = await callGeminiWithFallback({
        model: DEFAULT_GEMINI_IMAGE_MODEL,
        parts: [{ text: String(prompt || "").trim() }],
        timeoutMs: Math.max(GEMINI_VISION_TIMEOUT_MS, 120000),
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
        },
      });
      const inlinePart = extractCandidateParts(responseData)
        .find((part) => part?.inlineData?.data || part?.inline_data?.data);

      imageBytes = String(inlinePart?.inlineData?.data || inlinePart?.inline_data?.data || "").trim();
      mimeType = String(
        inlinePart?.inlineData?.mimeType
        || inlinePart?.inline_data?.mime_type
        || "image/png"
      ).trim() || "image/png";

      if (!imageBytes) {
        logger.warn("Gemini image generation returned no inline image", {
          model: modelUsed || DEFAULT_GEMINI_IMAGE_MODEL,
          videoId,
        });
        return null;
      }
    } else {
      const response = await callVertexPredict({
        model: DEFAULT_GEMINI_IMAGE_MODEL,
        instances: [{ prompt: String(prompt || "").trim() }],
        parameters: {
          sampleCount: 1,
          aspectRatio: "16:9",
        },
        timeoutMs: Math.max(GEMINI_VISION_TIMEOUT_MS, 120000),
      });

      const prediction = Array.isArray(response.data?.predictions) ? response.data.predictions[0] : null;
      imageBytes = String(prediction?.bytesBase64Encoded || prediction?.bytesBase64encoded || "").trim();
      mimeType = String(prediction?.mimeType || "image/png").trim() || "image/png";
      if (!imageBytes) {
        logger.warn("Gemini image generation returned no bytes", {
          model: DEFAULT_GEMINI_IMAGE_MODEL,
          videoId,
        });
        return null;
      }
    }

    const targetPath = String(outputPath || "").trim()
      || path.join(config.OUTPUT_ROOT, "draft", `${videoId || "gemini-image"}-${Date.now()}.png`);

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, Buffer.from(imageBytes, "base64"));
    return {
      provider: "vertex_ai",
      model: DEFAULT_GEMINI_IMAGE_MODEL,
      path: targetPath,
      mime_type: mimeType,
    };
  } catch (error) {
    logger.warn("Gemini image generation unavailable, using fallback", {
      message: formatProviderError(error),
      model: DEFAULT_GEMINI_IMAGE_MODEL,
    });
    return null;
  }

};

const generateVideoWithGemini = async ({ prompt, videoId = "", outputPath = "", aspectRatio = "16:9", durationSeconds = 8 }) => {
  if (!hasGemini()) return null;
  if (!hasVertexGemini()) return null;
  if (!String(prompt || "").trim()) return null;

  const budget = consumeExternalCallBudget({
    provider: "gemini",
    videoId,
    operation: "generate_video",
  });
  if (!budget.allowed) return null;

  const response = await callVertexVideoPredict({
    model: DEFAULT_GEMINI_VIDEO_MODEL,
    instances: [{ prompt: String(prompt || "").trim() }],
    parameters: {
      aspectRatio,
      durationSeconds,
      sampleCount: 1,
    },
    apiVersion: DEFAULT_GEMINI_VIDEO_API_VERSION,
  });

  const operationName = normalizeOperationName(response.data?.name || "");
  const artifact = extractVideoPredictionArtifact(response.data);

  if (artifact?.bytesBase64) {
    const targetPath = String(outputPath || "").trim()
      || path.join(config.OUTPUT_ROOT, "draft", `${videoId || "gemini-video"}-${Date.now()}.mp4`);
    writeBase64ArtifactToPath({ base64Data: artifact.bytesBase64, outputPath: targetPath });
    return {
      provider: "vertex_ai",
      model: DEFAULT_GEMINI_VIDEO_MODEL,
      path: targetPath,
      mime_type: artifact.mimeType || "video/mp4",
      response: response.data,
    };
  }

  return {
    provider: "vertex_ai",
    model: DEFAULT_GEMINI_VIDEO_MODEL,
    operation_name: operationName,
    console_url: buildVertexMediaStudioUrl(),
    polling_hint: operationName
      ? `node scripts/vertex-veo-operation.js wait --operation "${operationName}"`
      : "",
    response: response.data,
  };
};

const basicGeminiHealthcheck = async () => {
  if (isProviderDisabledInLocalTest("gemini")) {
    return { configured: true, ok: true, message: "Gemini desativado em LOCAL_TEST_MODE" };
  }
  if (!hasGemini()) {
    return { configured: false, ok: false, message: "Nem Vertex AI nem GEMINI_API_KEY estao configurados" };
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
    if (hasVertexGemini()) {
      const { rawText, model } = await callGeminiWithFallback({
        model: DEFAULT_GEMINI_TEXT_MODEL,
        parts: [{ text: "Responda apenas com ok" }],
        timeoutMs: 20000,
        generationConfig: { maxOutputTokens: 8 },
        maxRetries: 0,
      });

      return {
        configured: true,
        ok: Boolean(String(rawText || "").trim()),
        message: `Vertex text ok com ${model || DEFAULT_GEMINI_TEXT_MODEL}`,
      };
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
  generateIdeasWithGemini,
  generateScriptPackageWithGemini,
  generateMetadataWithGemini,
  transcribeWithGemini,
  generateImageWithGemini,
  generateVideoWithGemini,
  getVertexOperationStatus,
  waitForVertexOperation,
  buildVertexMediaStudioUrl,
  basicGeminiHealthcheck,
};
