const fs = require("fs");
const ffmpegPath = require("ffmpeg-static");
const { basicOpenAIHealthcheck } = require("./openaiService");
const { basicGeminiHealthcheck } = require("./geminiService");
const { basicMultivozesHealthcheck, basicElevenLabsHealthcheck } = require("./ttsService");
const { basicPexelsHealthcheck, basicPixabayHealthcheck } = require("./assetsService");
const { basicTelegramHealthcheck } = require("./telegramService");
const { basicYoutubeHealthcheck } = require("./youtubeService");
const { config } = require("../config/env");

const runIntegrationHealthchecks = async () => {
  const [openai, gemini, multivozes, elevenlabs, pexels, pixabay, telegram, youtube] = await Promise.all([
    basicOpenAIHealthcheck(),
    basicGeminiHealthcheck(),
    basicMultivozesHealthcheck(),
    basicElevenLabsHealthcheck(),
    basicPexelsHealthcheck(),
    basicPixabayHealthcheck(),
    basicTelegramHealthcheck({ sendMessage: false }),
    basicYoutubeHealthcheck(),
  ]);

  const ffmpeg = {
    configured: Boolean(ffmpegPath),
    ok: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
    message: ffmpegPath || "ffmpeg-static não encontrado",
  };

  const checks = { openai, gemini, multivozes, elevenlabs, pexels, pixabay, telegram, youtube, ffmpeg };

  const mandatoryProviders = [
    "openai",
    "telegram",
    "ffmpeg",
  ];

  if (multivozes.configured) {
    mandatoryProviders.push("multivozes");
  }

  if (gemini.configured) {
    mandatoryProviders.push("gemini");
  }

  const strictOk = mandatoryProviders.every((provider) => checks[provider]?.ok);

  const configuredCount = Object.values(checks).filter((check) => check.configured).length;
  const okCount = Object.values(checks).filter((check) => check.ok).length;

  return {
    mock_mode: config.MOCK_MODE,
    strict_ok: strictOk,
    configured_count: configuredCount,
    ok_count: okCount,
    checks,
  };
};

module.exports = {
  runIntegrationHealthchecks,
};
