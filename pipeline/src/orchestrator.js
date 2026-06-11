#!/usr/bin/env node
/**
 * Orquestrador do pipeline. Substitui os 3 workflows n8n.
 *
 * Uso:
 *   node src/orchestrator.js --topic "As 3 cidades mais bonitas de Portugal"
 *   node src/orchestrator.js --videoId abc123   (retoma do estado salvo)
 *   node src/orchestrator.js --topic "..." --mock  (modo mock/teste)
 */

const { v4: uuidv4 } = require("uuid");
const { generateScript } = require("./services/scriptService");
const { generateAudio } = require("./services/ttsService");
const { generateCaptions } = require("./services/captionsService");
const { analyzeAudio } = require("./services/audioIntelligence");
const { generateAssets } = require("./services/assetsService");
const { renderVideo } = require("./services/renderService");
const { validateRender } = require("./services/syncValidator");
const { uploadToYoutube } = require("./services/youtubeService");
const { loadState } = require("./services/stateService");
const { logger } = require("./utils/logger");

const RESUMABLE_STEPS = new Set([
  "script_generated",
  "audio_generated",
  "captions_generated",
  "audio_analyzed",
  "audio_intelligence_ready",
  "assets_generated",
  "assets_searched",
  "render_complete",
  "render_validated",
]);

const parseArgs = () => {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      result[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
      if (result[key] !== true) i++;
    }
  }
  return result;
};

const runPipeline = async ({ topic, videoId: existingVideoId, mockMode = false } = {}) => {
  const videoId = existingVideoId || uuidv4();
  logger.info("[PIPELINE] Iniciando", { videoId, topic: topic || "(retomando)" });

  const state = await loadState(videoId).catch(() => ({}));
  const currentStep = state.current_step || "";

  // 1. Script
  if (!RESUMABLE_STEPS.has(currentStep)) {
    if (!topic && !state.topic) throw new Error("Forneça --topic ou --videoId de um vídeo existente");
    logger.info("[PIPELINE] 1/7 — Gerando roteiro");
    await generateScript({ videoId, topic: topic || state.topic, mockMode });
  } else {
    logger.info(`[PIPELINE] Retomando a partir de: ${currentStep} (videoId: ${videoId})`);
  }

  const AFTER_AUDIO    = ["audio_generated", "captions_generated", "audio_analyzed", "audio_intelligence_ready", "assets_generated", "assets_searched", "render_complete", "render_validated"];
  const AFTER_CAPTIONS = ["captions_generated", "audio_analyzed", "audio_intelligence_ready", "assets_generated", "assets_searched", "render_complete", "render_validated"];
  const AFTER_ANALYSIS = ["audio_analyzed", "audio_intelligence_ready", "assets_generated", "assets_searched", "render_complete", "render_validated"];
  const AFTER_ASSETS   = ["assets_generated", "assets_searched", "render_complete", "render_validated"];

  // 2. Áudio
  if (!AFTER_AUDIO.includes(currentStep)) {
    logger.info("[PIPELINE] 2/7 — Gerando áudio");
    await generateAudio({ videoId, mockMode });
  }

  // 3. Legendas
  if (!AFTER_CAPTIONS.includes(currentStep)) {
    logger.info("[PIPELINE] 3/7 — Gerando legendas");
    await generateCaptions({ videoId, mockMode });
  }

  // 4. Análise de áudio
  if (!AFTER_ANALYSIS.includes(currentStep)) {
    logger.info("[PIPELINE] 4/7 — Analisando áudio");
    await analyzeAudio({ videoId }).catch((err) =>
      logger.warn("[PIPELINE] Análise de áudio falhou (não crítico)", { message: err.message })
    );
  }

  // 5. Assets (biblioteca local → Pexels/Pixabay)
  if (!AFTER_ASSETS.includes(currentStep)) {
    logger.info("[PIPELINE] 5/7 — Buscando assets");
    await generateAssets({ videoId, mockMode });
  }

  // 6. Render
  if (!["render_complete", "render_validated"].includes(currentStep)) {
    logger.info("[PIPELINE] 6/7 — Renderizando vídeo");
    await renderVideo({ videoId, mockMode });
  }

  // 7. Validação técnica (3 gates: tamanho, duração, áudio)
  logger.info("[PIPELINE] 7/7 — Validando render");
  const validation = await validateRender({ videoId, mockMode });

  if (!validation.is_publishable) {
    logger.error("[PIPELINE] Falhou validação técnica", {
      issues: validation.issues,
      duration: validation.ffprobe_duration,
    });
    return { success: false, videoId, reason: validation.issues.map((i) => i.type).join(", "), validation };
  }

  logger.info("[PIPELINE] Validação OK", { duration: validation.ffprobe_duration });

  // 8. Upload (controlado por env AUTO_UPLOAD=true)
  if (process.env.AUTO_UPLOAD === "true") {
    logger.info("[PIPELINE] Fazendo upload para YouTube");
    await uploadToYoutube({ videoId }).catch((err) =>
      logger.warn("[PIPELINE] Upload falhou", { message: err.message })
    );
  }

  return { success: true, videoId, validation };
};

if (require.main === module) {
  const args = parseArgs();
  const topic = typeof args.topic === "string" ? args.topic : "";
  const videoId = typeof args.videoId === "string" ? args.videoId : undefined;
  const mockMode = args.mock === true || args.mock === "true";

  runPipeline({ topic, videoId, mockMode })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error("[PIPELINE] Erro fatal:", err.message);
      console.error(err.stack);
      process.exit(1);
    });
}

module.exports = { runPipeline };
