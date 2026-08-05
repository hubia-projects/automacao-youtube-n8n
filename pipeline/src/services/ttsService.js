const fs = require("fs-extra");
const axios = require("axios");
const ffmpeg = require("fluent-ffmpeg");
const { config } = require("../config/env");
const { ensureVideoStructure, updateState, loadState } = require("./stateService");
const { sendWorkflowStatus } = require("./telegramService");
const { logger } = require("../utils/logger");
const { probeMedia, ffmpegBinaryPath } = require("../utils/mediaUtils");
const {
  ensureMultivozesStarted,
  shouldAttemptMultivozesAutoStart,
  waitForMultivozesReady,
} = require("./multivozesRuntimeService");
const { appendPipelineEvent } = require("./pipelineEventLogService");

ffmpeg.setFfmpegPath(ffmpegBinaryPath);

const MULTIVOZES_CHUNK_MAX_CHARS = Number(process.env.MULTIVOZES_CHUNK_MAX_CHARS || 420);
const MULTIVOZES_CHUNK_RETRIES = Math.max(1, Number(process.env.MULTIVOZES_CHUNK_RETRIES || 3));

const MULTIVOZES_TEST_VOICES = ["alloy", "pt-BR-FranciscaNeural", "pt-BR-AntonioNeural"];
let cachedMultivozesVoices = null;

const hasMultivozes = () => Boolean(config.MULTIVOZES_BR_ENGINE && config.MULTIVOZES_BR_BASE_URL);
const hasElevenLabs = () => Boolean(config.ELEVENLABS_API_KEY);

const getMultivozesBaseUrl = () => config.MULTIVOZES_BR_BASE_URL.replace(/\/+$/, "");
const isDockerRuntime = () => process.platform !== "win32" && fs.existsSync("/.dockerenv");
const isLocalhostMultivozesBaseUrl = () => /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(getMultivozesBaseUrl());

const pickRandomMultivozesVoice = () =>
  MULTIVOZES_TEST_VOICES[Math.floor(Math.random() * MULTIVOZES_TEST_VOICES.length)];

const listMultivozesVoices = async () => {
  if (cachedMultivozesVoices) return cachedMultivozesVoices;
  const response = await axios.get(`${getMultivozesBaseUrl()}/voices`, {
    headers: { Authorization: `Bearer ${config.MULTIVOZES_BR_ENGINE}` },
    timeout: 20000,
  });
  const aliases = Array.isArray(response.data?.data)
    ? response.data.data.map((entry) => String(entry?.alias || "").trim()).filter(Boolean)
    : [];
  const voices = Array.isArray(response.data?.data)
    ? response.data.data.map((entry) => String(entry?.voice || "").trim()).filter(Boolean)
    : [];
  cachedMultivozesVoices = {
    aliases,
    voices,
  };
  return cachedMultivozesVoices;
};

const pickPreferredMultivozesVoice = async () => {
  const configuredVoice = String(config.MULTIVOZES_DEFAULT_VOICE || "").trim();
  if (configuredVoice) return configuredVoice;
  try {
    const catalog = await listMultivozesVoices();
    const ptAlias = (catalog.aliases || []).find((alias) => /alloy|br|pt/i.test(alias));
    if (ptAlias) return ptAlias;
    const ptVoice = (catalog.voices || []).find((voice) => /^pt-BR-/i.test(voice));
    if (ptVoice) return ptVoice;
  } catch {
    // ignore and fallback to static list
  }
  return pickRandomMultivozesVoice();
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

  if (message) return message;
  if (providerMessage) return String(providerMessage);
  if (status > 0) return `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  if (code) return code;
  return "Erro desconhecido no provider.";
};

const estimateDurationFromText = (text = "") => {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(30, Math.round(words / 2.4));
};

const getAudioDuration = async (audioPath, fallbackText = "") => {
  const mediaInfo = await probeMedia(audioPath).catch(() => null);
  const duration = Number(mediaInfo?.duration || 0);
  if (duration > 0) {
    return duration;
  }

  return estimateDurationFromText(fallbackText);
};

const createMockAudio = async (audioPath, seconds = 95) => {
  const sampleRate = 44100;
  const channels = 2;
  const bytesPerSample = 2;
  const totalSamples = Math.max(1, Math.floor(seconds * sampleRate * channels));
  const rawBuffer = Buffer.alloc(totalSamples * bytesPerSample, 0);
  const rawPath = `${audioPath}.raw`;

  await fs.writeFile(rawPath, rawBuffer);

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(rawPath)
      .inputFormat("s16le")
      .inputOptions(["-ar 44100", "-ac 2"])
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .save(audioPath)
      .on("end", resolve)
      .on("error", reject);
  });

  await fs.remove(rawPath);
};

const splitTextForTts = (text = "", maxChars = 1200) => {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized];
  const chunks = [];
  let current = "";

  const flushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;

    if (trimmedSentence.length > maxChars) {
      flushCurrent();
      const words = trimmedSentence.split(/\s+/).filter(Boolean);
      let longChunk = "";
      for (const word of words) {
        const candidate = longChunk ? `${longChunk} ${word}` : word;
        if (candidate.length > maxChars) {
          if (longChunk) chunks.push(longChunk.trim());
          longChunk = word;
        } else {
          longChunk = candidate;
        }
      }
      if (longChunk.trim()) chunks.push(longChunk.trim());
      continue;
    }

    const candidate = current ? `${current} ${trimmedSentence}` : trimmedSentence;
    if (candidate.length > maxChars) {
      flushCurrent();
      current = trimmedSentence;
    } else {
      current = candidate;
    }
  }

  flushCurrent();
  return chunks;
};

const concatenateAudioChunks = async ({ chunkPaths = [], outputPath }) => {
  const listPath = `${outputPath}.concat.txt`;
  const fileList = chunkPaths
    .map((chunkPath) => `file '${chunkPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");

  await fs.writeFile(listPath, fileList, "utf8");

  try {
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(["-f concat", "-safe 0"])
        .audioCodec("libmp3lame")
        .audioBitrate("128k")
        .save(outputPath)
        .on("end", resolve)
        .on("error", reject);
    });
  } finally {
    await fs.remove(listPath).catch(() => null);
  }
};

// Stub consciente: a implementação completa do OpenAI TTS em chunks está
// planeada para a Fase B/A6. Enquanto não existir, qualquer chamada sinaliza
// falha explícita em vez de devolver null silenciosamente (que o código antigo
// fazia e mascarava a falha atrás do catch do multivozes).
const synthesizeOpenAiInChunks = async () => {
  throw new Error(
    "synthesizeOpenAiInChunks not implemented yet (Fase B/A6). Configure provider='multivozes' ou 'elevenlabs'."
  );
};

const ttsWithElevenLabs = async ({ text }) => {
  if (!hasElevenLabs()) return null;

  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.ELEVENLABS_VOICE_ID}`,
    {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75,
      },
    },
    {
      headers: {
        "xi-api-key": config.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      responseType: "arraybuffer",
      timeout: 120000,
    }
  );

  return Buffer.from(response.data);
};

const ttsWithMultivozes = async ({ text, voice }) => {
  if (!hasMultivozes()) return null;

  const selectedVoice = String(voice || "").trim();
  const payload = {
    model: "tts-1",
    input: text,
    response_format: "mp3",
  };
  if (selectedVoice) payload.voice = selectedVoice;
  const response = await axios.post(
    `${getMultivozesBaseUrl()}/audio/speech`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${config.MULTIVOZES_BR_ENGINE}`,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      responseType: "arraybuffer",
      timeout: 120000,
    }
  );

  return {
    buffer: Buffer.from(response.data),
    voice: selectedVoice || String(config.MULTIVOZES_DEFAULT_VOICE || "").trim() || "default",
  };
};

const buildMultivozesMisconfigurationHint = () => {
  if (!isDockerRuntime() || !isLocalhostMultivozesBaseUrl()) return "";
  return " Em ambiente Docker, localhost aponta para o próprio container; use host.docker.internal ou o nome do serviço do Multivozes.";
};

const probeMultivozesModels = async () => {
  const response = await axios.get(`${getMultivozesBaseUrl()}/models`, {
    headers: { Authorization: `Bearer ${config.MULTIVOZES_BR_ENGINE}` },
    timeout: 20000,
  });

  return {
    configured: true,
    ok: true,
    message: `Modelos encontrados: ${response.data?.data?.length || 0}`,
  };
};

const buildMultivozesHealthFailure = (error, suffix = "") => {
  const baseMessage = `${formatProviderError(error)}${buildMultivozesMisconfigurationHint()}`.trim();
  return {
    configured: true,
    ok: false,
    message: suffix ? `${baseMessage} ${suffix}`.trim() : baseMessage,
  };
};

const isTransientMultivozesError = (error) => {
  const status = Number(error?.response?.status || 0);
  const code = String(error?.code || "").toUpperCase();
  return status >= 500 || ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code);
};

const synthesizeWithMultivozesWithAutoStart = async ({ text, voiceOverride = "" }) => {
  const preferredVoice = String(voiceOverride || "").trim() || await pickPreferredMultivozesVoice().catch(() => "");
  try {
    return await ttsWithMultivozes({ text, voice: preferredVoice });
  } catch (error) {
    if (isTransientMultivozesError(error)) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        return await ttsWithMultivozes({ text, voice: preferredVoice });
      } catch {
        return ttsWithMultivozes({ text });
      }
    }

    if (!shouldAttemptMultivozesAutoStart(error)) {
      throw error;
    }

    const startResult = await ensureMultivozesStarted();
    if (!startResult.ok) {
      throw new Error(`Multivozes offline e auto-start falhou: ${startResult.message}`);
    }

    await waitForMultivozesReady(async () => probeMultivozesModels());
    return ttsWithMultivozes({ text, voice: preferredVoice });
  }
};

const synthesizeMultivozesChunkWithRetries = async ({ text, voice = "" }) => {
  let lastError = null;
  for (let attempt = 0; attempt < MULTIVOZES_CHUNK_RETRIES; attempt += 1) {
    try {
      return await synthesizeWithMultivozesWithAutoStart({
        text,
        voiceOverride: attempt === 0 ? voice : "",
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 800 + (attempt * 600)));
    }
  }
  throw lastError || new Error("Falha ao sintetizar chunk no Multivozes.");
};

const synthesizeMultivozesInChunks = async ({ text, outputPath }) => {
  const chunks = splitTextForTts(text, MULTIVOZES_CHUNK_MAX_CHARS);
  if (!chunks.length) return null;

  const preferredVoice = await pickPreferredMultivozesVoice().catch(() => "");
  const chunksDir = `${outputPath}.multivozes.chunks`;
  const chunkPaths = [];
  await fs.emptyDir(chunksDir);

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkText = chunks[index];
      logger.info("Multivozes chunked: sintetizando bloco", {
        chunk_index: index + 1,
        total_chunks: chunks.length,
        text_length: chunkText.length,
      });
      const chunkResponse = await synthesizeMultivozesChunkWithRetries({
        text: chunkText,
        voice: preferredVoice,
      });
      if (!chunkResponse?.buffer) {
        throw new Error(`Chunk ${index + 1} sem áudio no Multivozes.`);
      }
      const chunkPath = `${chunksDir}/chunk-${String(index + 1).padStart(3, "0")}.mp3`;
      await fs.writeFile(chunkPath, chunkResponse.buffer);
      chunkPaths.push(chunkPath);
    }
    await concatenateAudioChunks({ chunkPaths, outputPath });
    return {
      chunks: chunkPaths.length,
      voice: preferredVoice || "default",
    };
  } finally {
    await fs.remove(chunksDir).catch(() => null);
  }
};

const generateAudio = async ({ videoId, mockMode = false, provider = "multivozes" }) => {
  const stageStartedAt = Date.now();
  await appendPipelineEvent({
    videoId,
    stage: "audio",
    event: "start",
    status: "running",
    payload: {
      provider: String(provider || "multivozes"),
      mock_mode: Boolean(mockMode),
    },
  }).catch(() => null);
  const state = await loadState(videoId);
  if (!state.script_text) {
    throw new Error("script_text não encontrado. Gere o roteiro antes do áudio.");
  }

  const paths = await ensureVideoStructure(videoId);
  const text = state.script_text.slice(0, 15000);
  let audioBuffer = null;
  let audioWritten = false;
  let usedProvider = "mock";
  let usedVoice = "";
  let ttsErrorClass = "";

  if (!mockMode && provider === "multivozes") {
    try {
      const shouldUseChunkedMultivozes = text.length > MULTIVOZES_CHUNK_MAX_CHARS;
      if (shouldUseChunkedMultivozes) {
        const chunkedResult = await synthesizeMultivozesInChunks({ text, outputPath: paths.audioPath });
        if (chunkedResult) {
          audioWritten = true;
          usedProvider = "multivozes_chunked";
          usedVoice = chunkedResult.voice || "default";
        }
      }
      if (!audioWritten) {
        const multivozesResponse = await synthesizeWithMultivozesWithAutoStart({ text });
        audioBuffer = multivozesResponse?.buffer || null;
        usedVoice = multivozesResponse?.voice || "";
        if (audioBuffer) usedProvider = "multivozes";
      }
    } catch (error) {
      ttsErrorClass = String(error?.code || error?.response?.status || "multivozes_runtime_error");
      await appendPipelineEvent({
        videoId,
        stage: "audio",
        event: "multivozes_failure",
        status: "warning",
        payload: {
          error_class: ttsErrorClass,
          message: formatProviderError(error),
        },
      }).catch(() => null);
      logger.warn("Multivozes falhou, seguindo para fallback local disponivel", { message: formatProviderError(error) });
    }
  }

  if (!mockMode && provider === "elevenlabs" && !audioBuffer) {
    try {
      audioBuffer = await ttsWithElevenLabs({ text });
      if (audioBuffer) {
        usedProvider = "elevenlabs";
        usedVoice = config.ELEVENLABS_VOICE_ID;
      }
    } catch (error) {
      logger.warn("ElevenLabs falhou, seguindo para fallback local disponivel", { message: error.message });
    }
  }

  if (!audioBuffer && !audioWritten && !mockMode) {
    logger.warn("Nenhum provider TTS ativo conseguiu sintetizar audio; usando mock", {
      requested_provider: provider,
    });
  }

  if (audioBuffer) {
    await fs.writeFile(paths.audioPath, audioBuffer);
    audioWritten = true;
  }

  const isRealTtsProvider = (effectiveProvider = "") => {
    const key = String(effectiveProvider || "").toLowerCase();
    return key.startsWith("multivozes") || key.startsWith("elevenlabs") || key.startsWith("openai_tts");
  };

  const audioReal = audioWritten && isRealTtsProvider(usedProvider);

  if (!audioWritten && mockMode) {
    await createMockAudio(paths.audioPath);
    usedProvider = "mock";
  }

  if (!audioWritten && !mockMode) {
    const failureReason = String(ttsErrorClass || "no_real_provider_audio_generated");
    const failureMessage = `TTS production failure: nenhum provider real produziu áudio (requested=${provider || "multivozes"}, class=${failureReason}).`;

    logger.error(failureMessage);

    try {
      await updateState(
        videoId,
        {
          audio_path: paths.audioPath || "",
          audio_provider: "failed",
          audio_real: false,
          audio_generation_failed_reason: failureReason,
          duration_seconds: 0,
          tts_primary_provider: String(provider || "multivozes"),
          tts_effective_provider: "failed",
          tts_fallback_used: true,
          tts_error_class: String(ttsErrorClass || ""),
          error_message: failureMessage,
        },
        {
          currentStep: "audio_failed",
          status: "audio_failed",
        }
      );
    } catch (stateError) {
      logger.warn(`Falha ao persistir estado em audio_failed`, { message: stateError.message });
    }

    await appendPipelineEvent({
      videoId,
      stage: "audio",
      event: "production_failure",
      status: "error",
      payload: {
        requested_provider: String(provider || "multivozes"),
        reason: failureReason,
        message: failureMessage,
      },
    }).catch(() => null);

    throw new Error(failureMessage);
  }

  const duration = await getAudioDuration(paths.audioPath, text);
  const fallbackUsed = provider === "multivozes" && !String(usedProvider || "").toLowerCase().startsWith("multivozes");

  const nextState = await updateState(
    videoId,
    {
      audio_path: paths.audioPath,
      audio_provider: String(usedProvider || ""),
      audio_real: audioReal,
      audio_generation_failed_reason: "",
      duration_seconds: Math.round(duration || 0),
      tts_primary_provider: String(provider || "multivozes"),
      tts_effective_provider: String(usedProvider || ""),
      tts_fallback_used: fallbackUsed,
      tts_error_class: String(ttsErrorClass || ""),
      error_message: "",
    },
    {
      currentStep: "audio_generated",
      status: "audio_generated",
    }
  );

  await sendWorkflowStatus({
    videoId,
    title: "Áudio gerado",
    icon: "🎙️",
    lines: [`Provider usado: ${usedProvider}${usedVoice ? ` (${usedVoice})` : ""}.`],
  }).catch(() => null);
  await appendPipelineEvent({
    videoId,
    stage: "audio",
    event: "end",
    status: audioReal || mockMode ? "ok" : "warning",
    payload: {
      duration_ms: Date.now() - stageStartedAt,
      tts_primary_provider: String(provider || "multivozes"),
      tts_effective_provider: String(usedProvider || ""),
      tts_fallback_used: fallbackUsed,
      tts_error_class: String(ttsErrorClass || ""),
      audio_real: audioReal,
      mock_mode: Boolean(mockMode),
    },
  }).catch(() => null);

  return {
    video_id: videoId,
    audio_path: nextState.audio_path,
    duration_seconds: nextState.duration_seconds,
    provider: usedProvider,
    voice: usedVoice || null,
    audio_real: audioReal,
    audio_generation_failed_reason: "",
    tts_primary_provider: String(provider || "multivozes"),
    tts_effective_provider: String(usedProvider || ""),
    tts_fallback_used: fallbackUsed,
    tts_error_class: String(ttsErrorClass || ""),
    state_path: nextState.state_path,
  };
};

const basicMultivozesHealthcheck = async () => {
  if (!hasMultivozes()) {
    return { configured: false, ok: false, message: "MULTIVOZES_BR_ENGINE ausente" };
  }

  try {
    return await probeMultivozesModels();
  } catch (error) {
    if (!shouldAttemptMultivozesAutoStart(error)) {
      return buildMultivozesHealthFailure(error);
    }

    const startResult = await ensureMultivozesStarted();
    if (!startResult.ok) {
      return buildMultivozesHealthFailure(error, `Auto-start do Multivozes falhou: ${startResult.message}`);
    }

    try {
      const result = await waitForMultivozesReady(probeMultivozesModels);
      return {
        ...result,
        message: `${result.message} (auto-start via docker compose)`,
      };
    } catch (retryError) {
      return buildMultivozesHealthFailure(
        retryError,
        `Auto-start executado, mas o serviço não ficou pronto: ${startResult.message}`
      );
    }
  }
};

const basicElevenLabsHealthcheck = async () => {
  if (!hasElevenLabs()) {
    return { configured: false, ok: false, message: "ELEVENLABS_API_KEY ausente" };
  }

  try {
    const response = await axios.get("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": config.ELEVENLABS_API_KEY },
      timeout: 20000,
    });

    return {
      configured: true,
      ok: true,
      message: `Vozes encontradas: ${response.data?.voices?.length || 0}`,
    };
  } catch (error) {
    return { configured: true, ok: false, message: error.message };
  }
};

module.exports = {
  generateAudio,
  basicMultivozesHealthcheck,
  basicElevenLabsHealthcheck,
  pickRandomMultivozesVoice,
};
