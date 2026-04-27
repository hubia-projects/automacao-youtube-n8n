const fs = require("fs-extra");
const axios = require("axios");
const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
const { config } = require("../config/env");
const { ensureVideoStructure, updateState, loadState } = require("./stateService");
const { ttsWithOpenAI } = require("./openaiService");
const { logger } = require("../utils/logger");

ffmpeg.setFfmpegPath(ffmpegPath);

const hasElevenLabs = () => Boolean(config.ELEVENLABS_API_KEY);

const estimateDurationFromText = (text = "") => {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(30, Math.round(words / 2.4));
};

const getAudioDuration = async (audioPath, fallbackText = "") =>
  new Promise((resolve) => {
    ffmpeg.ffprobe(audioPath, (error, metadata) => {
      if (!error) {
        const duration = Number(metadata?.format?.duration || 0);
        if (duration > 0) return resolve(duration);
      }
      resolve(estimateDurationFromText(fallbackText));
    });
  });

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

const generateAudio = async ({ videoId, mockMode = false, provider = "elevenlabs" }) => {
  const state = await loadState(videoId);
  if (!state.script_text) {
    throw new Error("script_text não encontrado. Gere o roteiro antes do áudio.");
  }

  const paths = await ensureVideoStructure(videoId);
  const text = state.script_text.slice(0, 15000);

  let audioBuffer = null;
  let usedProvider = "mock";

  if (!mockMode && provider === "elevenlabs") {
    try {
      audioBuffer = await ttsWithElevenLabs({ text });
      usedProvider = "elevenlabs";
    } catch (error) {
      logger.warn("ElevenLabs falhou, tentando OpenAI TTS fallback", { message: error.message });
    }
  }

  if (!audioBuffer && !mockMode) {
    audioBuffer = await ttsWithOpenAI({ text });
    if (audioBuffer) usedProvider = "openai_tts_fallback";
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

  return {
    video_id: videoId,
    audio_path: nextState.audio_path,
    duration_seconds: nextState.duration_seconds,
    provider: usedProvider,
    state_path: nextState.state_path,
  };
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
  basicElevenLabsHealthcheck,
};