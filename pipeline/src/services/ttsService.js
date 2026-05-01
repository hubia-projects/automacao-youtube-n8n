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

  let audioBuffer = null;
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
    audioBuffer = await ttsWithOpenAI({ text });
    if (audioBuffer) {
      usedProvider = provider === "openai" ? "openai" : "openai_tts_fallback";
      usedVoice = "alloy";
    }
  }

  if (audioBuffer) {
    await fs.writeFile(paths.audioPath, audioBuffer);
  } else {
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