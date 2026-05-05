const fs = require("fs-extra");
const axios = require("axios");
const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
const { config } = require("../config/env");
const { ensureVideoStructure, updateState, loadState } = require("./stateService");
const { ttsWithOpenAI } = require("./openaiService");
const { sendWorkflowStatus } = require("./telegramService");
const { logger } = require("../utils/logger");
const { probeMedia } = require("../utils/mediaUtils");

ffmpeg.setFfmpegPath(ffmpegPath);

const OPENAI_TTS_MAX_CHARS_PER_CHUNK = Number(process.env.OPENAI_TTS_MAX_CHARS_PER_CHUNK || 1200);

const MULTIVOZES_TEST_VOICES = [
  "pt-BR-FranciscaNeural",
  "pt-BR-AntonioNeural",
  "pt-BR-ThalitaNeural",
  "pt-BR-ThalitaMultilingualNeural",
];

const hasMultivozes = () => Boolean(config.MULTIVOZES_BR_ENGINE && config.MULTIVOZES_BR_BASE_URL);
const hasElevenLabs = () => Boolean(config.ELEVENLABS_API_KEY);

const getMultivozesBaseUrl = () => config.MULTIVOZES_BR_BASE_URL.replace(/\/+$/, "");

const pickRandomMultivozesVoice = () =>
  MULTIVOZES_TEST_VOICES[Math.floor(Math.random() * MULTIVOZES_TEST_VOICES.length)];

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

const splitTextForTts = (text = "", maxChars = OPENAI_TTS_MAX_CHARS_PER_CHUNK) => {
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

const synthesizeOpenAiInChunks = async ({ text, outputPath }) => {
  const chunks = splitTextForTts(text);
  if (!chunks.length) return null;

  const chunksDir = `${outputPath}.chunks`;
  const chunkPaths = [];
  await fs.emptyDir(chunksDir);

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkText = chunks[index];
      logger.info("OpenAI TTS chunked: sintetizando bloco", {
        chunk_index: index + 1,
        total_chunks: chunks.length,
        text_length: chunkText.length,
      });

      const chunkBuffer = await ttsWithOpenAI({ text: chunkText });
      if (!chunkBuffer) {
        logger.warn("OpenAI TTS chunked: falha ao sintetizar bloco", {
          chunk_index: index + 1,
          total_chunks: chunks.length,
        });
        return null;
      }

      const chunkPath = `${chunksDir}/chunk-${String(index + 1).padStart(3, "0")}.mp3`;
      await fs.writeFile(chunkPath, chunkBuffer);
      chunkPaths.push(chunkPath);
    }

    await concatenateAudioChunks({ chunkPaths, outputPath });
    return { chunks: chunkPaths.length };
  } finally {
    await fs.remove(chunksDir).catch(() => null);
  }
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

  const selectedVoice = voice || pickRandomMultivozesVoice();
  const response = await axios.post(
    `${getMultivozesBaseUrl()}/audio/speech`,
    {
      model: "tts-1",
      input: text,
      voice: selectedVoice,
      response_format: "mp3",
    },
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
    voice: selectedVoice,
  };
};

const generateAudio = async ({ videoId, mockMode = false, provider = "multivozes" }) => {
  const state = await loadState(videoId);
  if (!state.script_text) {
    throw new Error("script_text não encontrado. Gere o roteiro antes do áudio.");
  }

  const paths = await ensureVideoStructure(videoId);
  const text = state.script_text.slice(0, 15000);
  const shouldUseChunkedOpenAi = text.length > OPENAI_TTS_MAX_CHARS_PER_CHUNK;

  let audioBuffer = null;
  let audioWritten = false;
  let usedProvider = "mock";
  let usedVoice = "";

  if (!mockMode && provider === "multivozes") {
    try {
      const multivozesResponse = await ttsWithMultivozes({ text });
      audioBuffer = multivozesResponse?.buffer || null;
      usedVoice = multivozesResponse?.voice || "";
      if (audioBuffer) usedProvider = "multivozes";
    } catch (error) {
      logger.warn("Multivozes falhou, tentando OpenAI TTS fallback", { message: error.message });
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
      logger.warn("ElevenLabs falhou, tentando OpenAI TTS fallback", { message: error.message });
    }
  }

  if (!audioBuffer && !mockMode) {
    if (shouldUseChunkedOpenAi) {
      const chunkedResult = await synthesizeOpenAiInChunks({ text, outputPath: paths.audioPath });
      if (chunkedResult) {
        audioWritten = true;
        usedProvider = provider === "openai" ? "openai_chunked" : "openai_tts_chunked_fallback";
        usedVoice = "alloy";
      }
    }

    if (!audioWritten) {
      audioBuffer = await ttsWithOpenAI({ text });
      if (audioBuffer) {
        usedProvider = provider === "openai" ? "openai" : "openai_tts_fallback";
        usedVoice = "alloy";
      }
    }
  }

  if (audioBuffer) {
    await fs.writeFile(paths.audioPath, audioBuffer);
    audioWritten = true;
  }

  if (!audioWritten) {
    await createMockAudio(paths.audioPath);
    usedProvider = "mock";
  }

  const duration = await getAudioDuration(paths.audioPath, text);

  const nextState = await updateState(
    videoId,
    {
      audio_path: paths.audioPath,
      duration_seconds: Math.round(duration || 0),
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

  return {
    video_id: videoId,
    audio_path: nextState.audio_path,
    duration_seconds: nextState.duration_seconds,
    provider: usedProvider,
    voice: usedVoice || null,
    state_path: nextState.state_path,
  };
};

const basicMultivozesHealthcheck = async () => {
  if (!hasMultivozes()) {
    return { configured: false, ok: false, message: "MULTIVOZES_BR_ENGINE ausente" };
  }

  try {
    const response = await axios.get(`${getMultivozesBaseUrl()}/models`, {
      headers: { Authorization: `Bearer ${config.MULTIVOZES_BR_ENGINE}` },
      timeout: 20000,
    });

    return {
      configured: true,
      ok: true,
      message: `Modelos encontrados: ${response.data?.data?.length || 0}`,
    };
  } catch (error) {
    return { configured: true, ok: false, message: error.message };
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