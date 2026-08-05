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
const { generateVisualContract, refineWithAudioIntelligence } = require("./services/visualContractService");
const { approveVisualEvidence } = require("./services/visualEvidenceApprovalService");
const { generateAudio } = require("./services/ttsService");
const { generateCaptions } = require("./services/captionsService");
const { analyzeAudio } = require("./services/audioIntelligence");
const { generateAssets } = require("./services/assetsService");
const { renderVideo } = require("./services/renderService");
const { validateRender } = require("./services/syncValidator");
const { runEditorialQa } = require("./services/editorialQaService");
const { runMediaIntegrityQa } = require("./services/mediaIntegrityQaService");
const { uploadToYoutube } = require("./services/youtubeService");
const { loadState } = require("./services/stateService");
const { logger } = require("./utils/logger");
const { cleanupUnusedDraftAssets, rotateTestReports } = require("./utils/cleanup");

const RESUMABLE_STEPS = new Set([
  "script_generated",
  "visual_contract_generated",
  "audio_generated",
  "captions_generated",
  "audio_analyzed",
  "assets_generated",
  "visual_evidence_approved",
  "render_generated",
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
  if (currentStep !== "script_generated" && !["visual_contract_generated", "audio_generated", "captions_generated", "audio_analyzed", "assets_generated", "render_complete", "render_validated"].includes(currentStep)) {
    if (!topic && !state.topic) throw new Error("Forneça --topic ou --videoId de um vídeo existente");
    logger.info("[PIPELINE] 1/10 — Gerando roteiro");
    await generateScript({ videoId, topic: topic || state.topic, mockMode });
  } else {
    logger.info(`[PIPELINE] Retomando a partir de: ${currentStep} (videoId: ${videoId})`);
  }

  // 2. Visual Contract (NOVO — após script, antes de áudio)
  if (currentStep !== "visual_contract_generated" && !["audio_generated", "captions_generated", "audio_analyzed", "assets_generated", "render_complete", "render_validated"].includes(currentStep)) {
    logger.info("[PIPELINE] 2/10 — Gerando visual contract");
    await generateVisualContract({ videoId, topic: topic || state.topic });
  }

  // 3. Áudio
  if (currentStep !== "audio_generated" && !["captions_generated", "audio_analyzed", "assets_generated", "render_complete", "render_validated"].includes(currentStep)) {
    logger.info("[PIPELINE] 3/10 — Gerando áudio");
    await generateAudio({ videoId, mockMode });
  }

  // 4. Legendas
  if (currentStep !== "captions_generated" && !["audio_analyzed", "assets_generated", "render_complete", "render_validated"].includes(currentStep)) {
    logger.info("[PIPELINE] 4/10 — Gerando legendas");
    await generateCaptions({ videoId, mockMode });
  }

  // 5. Análise de áudio
  if (currentStep !== "audio_analyzed" && !["assets_generated", "render_complete", "render_validated"].includes(currentStep)) {
    logger.info("[PIPELINE] 5/10 — Analisando áudio");
    await analyzeAudio({ videoId }).catch((err) =>
      logger.warn("[PIPELINE] Análise de áudio falhou (não crítico)", { message: err.message })
    );
  }

  // Refinar visual contract com audio_intelligence (se disponível)
  await refineWithAudioIntelligence(videoId).catch(() => null);

  // 6. Assets
  if (currentStep !== "assets_generated" && !["render_complete", "render_validated"].includes(currentStep)) {
    logger.info("[PIPELINE] 6/10 — Buscando assets");
    await generateAssets({ videoId, mockMode });
  }

  // 7. Aprovação de evidência visual (NOVO)
  if (currentStep !== "visual_evidence_approved" && !["render_complete", "render_validated"].includes(currentStep)) {
    logger.info("[PIPELINE] 7/10 — Aprovando evidência visual");
    const evidenceResult = await approveVisualEvidence({ videoId });
    if (evidenceResult.visual_contract_not_covered) {
      logger.error("[PIPELINE] VISUAL_CONTRACT_NOT_COVERED — precisa revisão manual", {
        missing_moments: evidenceResult.needs_manual_review.length,
      });
      return { success: false, videoId, reason: "VISUAL_CONTRACT_NOT_COVERED", needs_manual_review: evidenceResult.needs_manual_review };
    }
  }

  // 8. Render
  if (currentStep !== "render_complete" && currentStep !== "render_validated") {
    logger.info("[PIPELINE] 8/10 — Renderizando vídeo");
    await renderVideo({ videoId, mockMode });
    if (process.env.CLEANUP_UNUSED_DRAFT_ASSETS === "true" && !mockMode) {
      await cleanupUnusedDraftAssets({ videoId, enabled: true });
    }
  }

  // 9. Validação técnica
  logger.info("[PIPELINE] 9/10 — Validando render + QA editorial + QA integridade");
  const validation = await validateRender({ videoId, mockMode });

  if (!validation.is_publishable) {
    logger.error("[PIPELINE] Falhou validação técnica", {
      issues: validation.issues,
      duration: validation.ffprobe_duration,
    });
    return { success: false, videoId, reason: validation.issues.map((i) => i.type).join(", "), validation };
  }

  logger.info("[PIPELINE] Validação OK");

  // 10. Editorial QA + Media Integrity QA (NOVO)
  const editorialQa = await runEditorialQa({ videoId }).catch((err) => {
    logger.error("[PIPELINE] Editorial QA falhou", { message: err.message });
    return { passed: false, failures: [{ rule: "qa_execution_error", detail: err.message }] };
  });
  const mediaQa = await runMediaIntegrityQa({ videoId }).catch((err) => {
    logger.error("[PIPELINE] Media Integrity QA falhou", { message: err.message });
    return { passed: false, failures: [{ stage: "execution_error", error: err.message }] };
  });

  if (!editorialQa.passed) {
    logger.error("[PIPELINE] QA editorial reprovado — upload bloqueado", {
      failures: editorialQa.failures?.length,
    });
    return { success: false, videoId, reason: "EDITORIAL_QA_FAILED", editorial_qa: editorialQa };
  }

  if (!mediaQa.passed) {
    logger.error("[PIPELINE] QA de integridade reprovado — upload bloqueado", {
      failures: mediaQa.failures?.length,
    });
    return { success: false, videoId, reason: "MEDIA_INTEGRITY_QA_FAILED", media_integrity_qa: mediaQa };
  }

  logger.info("[PIPELINE] Todos os QA passaram");

  // 11. Upload
  if (process.env.AUTO_UPLOAD === "true") {
    logger.info("[PIPELINE] 10/10 — Fazendo upload para YouTube");
    await uploadToYoutube({ videoId }).catch((err) =>
      logger.warn("[PIPELINE] Upload falhou", { message: err.message })
    );
  }

  if (process.env.CLEANUP_TEST_REPORTS === "true") {
    await rotateTestReports({
      keepLast: Number(process.env.TEST_REPORTS_KEEP_LAST || 10),
    }).catch((error) =>
      logger.warn("[PIPELINE] rotação de test_reports falhou", { message: error.message })
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
