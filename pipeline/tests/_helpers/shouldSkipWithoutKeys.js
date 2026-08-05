// Helper partilhado para tests E2E que rodam fora de mockMode e precisam de
// credenciais reais (TTS real, providers de vídeo, YouTube). Em CI sem keys,
// o teste imprime ⏭️ SKIP com motivo claro e termina silenciosamente sem
// explodir em generateAudio.uploadToYoutube.
//
// Uso:
//   const { maybeSkipWithoutKeys } = require("./_helpers/shouldSkipWithoutKeys.js");
//   const skipReason = maybeSkipWithoutKeys({ requireTTS: true });
//   if (skipReason) {
//     console.log(`⏭️ SKIP ${path.basename(__filename)}: ${skipReason}`);
//     return;
//   }
const fs = require("fs-extra");
const path = require("path");
const {
  config,
} = require(path.join(__dirname, "..", "..", "src", "config", "env"));
const {
  basicMultivozesHealthcheck,
  basicElevenLabsHealthcheck,
} = require(path.join(__dirname, "..", "..", "src", "services", "ttsService"));
const {
  basicPexelsHealthcheck,
  basicPixabayHealthcheck,
} = require(path.join(__dirname, "..", "..", "src", "services", "assetsService"));
const {
  basicYoutubeHealthcheck,
} = require(path.join(__dirname, "..", "..", "src", "services", "youtubeService"));

const safeCheck = async (fn) => {
  try {
    return await fn();
  } catch {
    return { configured: false, ok: false, message: "healthcheck_failed" };
  }
};

const maybeSkipWithoutKeys = async ({
  requireTTS = false,
  requireVideoProviders = false,
  requireYoutube = false,
  logIfSkip = false,
  hint = "Configure credenciais reais ou ajuste o teste para MOCK_MODE=true.",
} = {}) => {
  const reasons = [];

  if (requireTTS) {
    const hasRealTts = Boolean(
      config.MULTIVOZES_BR_ENGINE
      || config.MULTIVOZEZ_BR_ENGINE
      || config.ELEVENLABS_API_KEY
    );
    if (!hasRealTts) {
      reasons.push("nenhum TTS real (MULTIVOZES_BR_ENGINE/ELEVENLABS_API_KEY ausente)");
    } else {
      const [multivozesCheck, elevenLabsCheck] = await Promise.all([
        safeCheck(() => basicMultivozesHealthcheck()),
        safeCheck(() => basicElevenLabsHealthcheck()),
      ]);
      if (config.MULTIVOZES_BR_ENGINE && !multivozesCheck.configured) {
        reasons.push(`multivozes nao configurado (${multivozesCheck.message})`);
      }
      if (config.ELEVENLABS_API_KEY && !elevenLabsCheck.configured) {
        reasons.push(`elevenlabs nao configurado (${elevenLabsCheck.message})`);
      }
    }
  }

  if (requireVideoProviders) {
    const [pexelsCheck, pixabayCheck] = await Promise.all([
      safeCheck(() => basicPexelsHealthcheck()),
      safeCheck(() => basicPixabayHealthcheck()),
    ]);
    if (!pexelsCheck.configured) reasons.push(`pexels nao configurado (${pexelsCheck.message})`);
    if (!pixabayCheck.configured) reasons.push(`pixabay nao configurado (${pixabayCheck.message})`);
  }

  if (requireYoutube) {
    const youtubeCheck = await safeCheck(() => basicYoutubeHealthcheck());
    if (!youtubeCheck.configured) reasons.push(`youtube nao configurado (${youtubeCheck.message})`);
  }

  if (reasons.length === 0) return null;

  const aggregated = `${reasons.join(" | ")}. ${hint}`;
  if (logIfSkip) console.log(`⏭️ SKIP helper sinalizou skip: ${aggregated}`);
  return aggregated;
};

module.exports = { maybeSkipWithoutKeys };
