const fs = require("fs");
const { basicGeminiHealthcheck } = require("./geminiService");
const { basicMultivozesHealthcheck, basicElevenLabsHealthcheck } = require("./ttsService");
const { basicPexelsHealthcheck, basicPixabayHealthcheck } = require("./assetsService");
const { basicTelegramHealthcheck } = require("./telegramService");
const { basicYoutubeHealthcheck } = require("./youtubeService");
const { config } = require("../config/env");
const { ffmpegBinaryPath, hasUsableBinaryPath } = require("../utils/mediaUtils");

const runIntegrationHealthchecks = async () => {
  const [gemini, multivozes, elevenlabs, pexels, pixabay, telegram, youtube] = await Promise.all([
    basicGeminiHealthcheck(),
    basicMultivozesHealthcheck(),
    basicElevenLabsHealthcheck(),
    basicPexelsHealthcheck(),
    basicPixabayHealthcheck(),
    basicTelegramHealthcheck({ sendMessage: false }),
    basicYoutubeHealthcheck(),
  ]);

  const ffmpeg = {
    configured: Boolean(ffmpegBinaryPath),
    ok: Boolean(ffmpegBinaryPath && (hasUsableBinaryPath(ffmpegBinaryPath) || ffmpegBinaryPath === "ffmpeg")),
    message: ffmpegBinaryPath || "ffmpeg não encontrado",
  };

  const checks = { gemini, multivozes, elevenlabs, pexels, pixabay, telegram, youtube, ffmpeg };

  const mandatoryProviders = [
    "gemini",
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
