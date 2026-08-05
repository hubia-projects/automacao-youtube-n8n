#!/usr/bin/env node
/**
 * CLI do pipeline MVP — gera vídeos curtos (3 min) ou longos (10–15 min).
 *
 * Flags:
 *   --topic="..."        Tópico do vídeo (obrigatório se não passar --video-id)
 *   --duration=180       Override de TARGET_VIDEO_DURATION_SECONDS (e aplica short mode)
 *   --short              Ativa SHORT_VIDEO_MODE + TARGET_VIDEO_DURATION_SECONDS=180 (default)
 *   --video-id=ID        Retoma um vídeo já iniciado (state.json existente)
 *   --mock               Força mockMode=true em todos os passos
 *   --no-upload          Não faz upload YouTube mesmo se QA passar
 *   --tts=provider       multivozes|elevenlabs|openai_tts|auto (default multivozes)
 *   --angle="..."        Ângulo narrativo (default: derivado do tópico)
 *   --skip-review        Pula Drive/Sheets publishing
 *   --deep-validate      Executa full syncValidator+editorial+media-integrity QA
 *
 * Short mode (--short ou --duration<=210):
 *   - Ativa config.SHORT_VIDEO_MODE e respetivas word limits
 *   - Override TARGET_VIDEO_DURATION_SECONDS quando --duration é passada
 *   - Word count alvo: TARGET_SCRIPT_WORDS_MIN..MAX (default 380..520)
 *
 * Exemplo:
 *   node pipeline/scripts/run-pipeline.js \
 *     --topic "3 comidas típicas do Porto que turistas precisam conhecer" \
 *     --short --no-upload
 */

const path = require("path");
const { v4: uuidv4 } = require("uuid");

const { updateState, loadState } = require("../src/services/stateService");
const { config } = require("../src/config/env");
const { generateScript } = require("../src/services/scriptService");
const { generateVisualContract, refineWithAudioIntelligence } = require("../src/services/visualContractService");
const { generateAudio } = require("../src/services/ttsService");
const { generateCaptions } = require("../src/services/captionsService");
const { analyzeAudio } = require("../src/services/audioIntelligence");
const { generateAssets } = require("../src/services/assetsService");
const { approveVisualEvidence } = require("../src/services/visualEvidenceApprovalService");
const { runInternetGapFill } = require("../src/services/internetAssetFallbackService");
const { renderVideo } = require("../src/services/renderService");
const { validateRender } = require("../src/services/syncValidator");
const { runEditorialQa } = require("../src/services/editorialQaService");
const { runMediaIntegrityQa } = require("../src/services/mediaIntegrityQaService");
const { uploadToYoutube } = require("../src/services/youtubeService");
const { publishReviewDraft: publishReviewLink } = require("../src/services/reviewPublishingService");

const SHORT_MODE_DEFAULT_DURATION = 180;

const parseArgs = (argv) => {
  const result = { remaining: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] || "");
    if (!raw.startsWith("--")) {
      result.remaining.push(raw);
      continue;
    }
    const stripped = raw.slice(2);
    const eqIdx = stripped.indexOf("=");
    let key;
    let value;
    if (eqIdx >= 0) {
      key = stripped.slice(0, eqIdx);
      value = stripped.slice(eqIdx + 1);
    } else {
      key = stripped;
      value = argv[i + 1] && !String(argv[i + 1]).startsWith("--") ? argv[++i] : true;
    }
    result[key] = value;
  }
  return result;
};

const log = (msg, icon = "🔧") => console.log(`[${new Date().toISOString()}] ${icon} ${msg}`);

const countWords = (text = "") => String(text || "").trim().split(/\s+/).filter(Boolean).length;

const detectRuntimeMode = ({ args }) => {
  const shortFlag = Boolean(args.short);
  const durationFlag = Number(args.duration || 0) > 0 ? Number(args.duration) : 0;
  const durationInShortWindow = durationFlag > 0 && durationFlag <= 240;
  const shortMode = shortFlag || durationInShortWindow || config.SHORT_VIDEO_MODE === true;
  const effectiveDuration = shortMode
    ? (durationFlag || SHORT_MODE_DEFAULT_DURATION || Number(config.TARGET_VIDEO_DURATION_SECONDS || 180))
    : (durationFlag || 0);
  const mockMode = Boolean(args.mock) || config.MOCK_MODE === true;
  const noUpload = Boolean(args["no-upload"]);
  return {
    shortMode,
    durationFlag,
    effectiveDuration,
    mockMode,
    noUpload,
    ttsProvider: String(args.tts || "multivozes"),
    topic: typeof args.topic === "string" ? args.topic : "",
    angle: typeof args.angle === "string" ? args.angle : "",
    videoId: typeof args["video-id"] === "string" ? args["video-id"] : "",
    skipReview: Boolean(args["skip-review"]),
    deepValidate: Boolean(args["deep-validate"]),
  };
};

const toWordRange = (mode) => {
  if (!mode.shortMode) return { min: 0, max: 0 };
  return {
    min: Number(config.TARGET_SCRIPT_WORDS_MIN || 380),
    max: Number(config.TARGET_SCRIPT_WORDS_MAX || 520),
  };
};

const formatIssue = (issue) => `${issue.type}(${issue.severity || "info"})`;

const summarizeValidation = (validation) => ({
  is_publishable: validation?.is_publishable === true,
  hard_boundary_status: validation?.hard_boundary_status || "unknown",
  max_visual_lag_sec: Number(validation?.max_visual_lag_sec || 0),
  issues: (validation?.issues || []).map(formatIssue),
});

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  const mode = detectRuntimeMode({ args });

  if (mode.shortMode) {
    process.env.SHORT_VIDEO_MODE = "true";
    if (mode.effectiveDuration) process.env.TARGET_VIDEO_DURATION_SECONDS = String(mode.effectiveDuration);
  }

  const videoId = mode.videoId || `cli_${Date.now()}_${uuidv4().slice(0, 6)}`;
  const topic = mode.topic || (mode.videoId ? (await loadState(mode.videoId).catch(() => ({}))).topic : "");
  const angle = mode.angle || "roteiro curto em 3 minutos com foco visual direto";

  if (!topic) {
    throw new Error("CLI abort: --topic é obrigatório (ou --video-id para retomar).");
  }

  const wordRange = toWordRange(mode);

  log("🚀 CLI pipeline iniciado", "🎬");
  log(`mode=${mode.shortMode ? "SHORT" : "LONG"} duration=${mode.effectiveDuration || "auto"}s mock=${mode.mockMode} noUpload=${mode.noUpload}`, "🎯");
  log(`videoId=${videoId}`, "🆔");
  log(`topic="${topic}"`, "📌");
  if (mode.shortMode) {
    log(`word range alvo: ${wordRange.min}-${wordRange.max}`, "📝");
  }

  await updateState(
    videoId,
    {
      topic,
      angle,
      selected_idea: { topic, angle, idea_id: uuidv4() },
      ideas: [{ topic, angle, idea_id: uuidv4(), scores: {}, notes: "", total_score: 80 }],
      status: "idea_approved",
      current_step: "idea_approved",
      approved: false,
      error_message: "",
      short_mode: mode.shortMode,
      target_duration_seconds: mode.effectiveDuration,
      duration_seconds: mode.effectiveDuration,
    },
    { status: "idea_approved", currentStep: "idea_approved" }
  );

  log("1/9 — Gerando roteiro", "📝");
  const scriptResult = await generateScript({
    videoId,
    mockMode: mode.mockMode,
    topic,
    angle,
    targetDurationSeconds: mode.effectiveDuration || 0,
  });
  const afterScript = await loadState(videoId);
  log(`roteiro gerado: ${countWords(afterScript.script_text || "")} palavras`, "✅");

  log("1.5/11 — Gerando visual contract", "📜");
  await generateVisualContract({ videoId, mockMode: mode.mockMode, topic, angle }).catch((err) =>
    log(`visual contract falhou — render downstream pode bloquear: ${err.message}`, "❌")
  );

  log(`2/11 — Gerando áudio (${mode.ttsProvider})`, "🎙️");
  const audio = await generateAudio({
    videoId,
    mockMode: mode.mockMode,
    provider: mode.ttsProvider,
  }).catch((err) => {
    log(`áudio falhou (mock=${mode.mockMode}): ${err.message}`, "❌");
    if (!mode.mockMode) throw err;
    return null;
  });
  if (audio) log(`áudio gerado: ${audio.provider} ${Math.round(audio.duration_seconds || 0)}s audio_real=${audio.audio_real === true}`, "✅");

  log("3/9 — Gerando legendas", "💬");
  await generateCaptions({ videoId, mockMode: mode.mockMode }).catch((err) => log(`legendas aviso: ${err.message}`, "⚠️"));
  const afterCaptions = await loadState(videoId);
  log(`legendas: srt=${afterCaptions.caption_path_srt || "n/a"} vtt=${afterCaptions.caption_path_vtt || "n/a"}`, "✅");

  log("4/11 — Analisando áudio (Whisper/visual timestamp)", "🧠");
  await analyzeAudio({ videoId }).catch((err) => log(`análise de áudio falhou (não bloqueante): ${err.message}`, "⚠️"));

  log("4.5/11 — Refinando visual contract com audio intelligence", "🔁");
  await refineWithAudioIntelligence(videoId).catch((err) =>
    log(`audio refine aviso: ${err.message}`, "⚠️")
  );

  log("5/11 — Buscando assets visuais por cena", "🎬");
  const assets = await generateAssets({ videoId, mockMode: mode.mockMode }).catch((err) => {
    log(`assets aviso: ${err.message}`, "⚠️");
    return { assets_json: { items: [] } };
  });
  const items = assets?.assets_json?.items || [];
  const videoCount = items.filter((i) => i.asset_type === "video").length;
  log(`assets: ${items.length} itens, ${videoCount} vídeos`, "✅");

  log("5.5/11 — Aprovando evidência visual", "✅");
  const initialApproval = await approveVisualEvidence({ videoId, mockMode: mode.mockMode }).catch((err) => {
    log(`evidence approval falhou — render downstream pode bloquear: ${err.message}`, "❌");
    return { contract_covered: false, needs_manual_review: [], visual_contract_not_covered: true };
  });

  // Passos 5.55 → 5.6/11 — fallback internet (Wikimedia Commons) quando visual contract não coberto
  const INITIAL_COVERAGE_GAP = !initialApproval.contract_covered
    && (initialApproval.needs_manual_review || []).length > 0
    && !mode.mockMode
    && process.env.ENABLE_INTERNET_GAP_FILL !== "false";
  if (INITIAL_COVERAGE_GAP) {
    const gapCount = initialApproval.needs_manual_review.length;
    log(`Visual contract com gap: ${gapCount} moment(s) sem cobertura. Acionando fallback Wikimedia...`, "🌐");
    const gapFill = await runInternetGapFill({ videoId, maxMoments: 6, maxPerMoment: 2 }).catch((err) => {
      log(`internet gap fill falhou (nao bloqueante): ${err.message}`, "⚠️");
      return { addedAssets: 0, downloads: [] };
    });
    log(`Gap fill adicionou ${gapFill.addedAssets} asset(s) via Wikimedia Commons.`, gapFill.addedAssets > 0 ? "🌐" : "ℹ️");
    if (gapFill.addedAssets > 0) {
      log("5.6/11 — Re-aprovando evidencia visual apos gap fill", "✅");
      await approveVisualEvidence({ videoId, mockMode: mode.mockMode }).catch((err) => {
        log(`re-approval apos gap fill falhou (nao bloqueante): ${err.message}`, "⚠️");
      });
    }
  } else if (initialApproval.contract_covered) {
    log("Visual contract totalmente coberto — sem gap fill necessario.", "✅");
  }

  log("6/11 — Renderizando vídeo final", "🎞️");
  const render = await renderVideo({ videoId, mockMode: mode.mockMode }).catch((err) => {
    log(`render falhou: ${err.message}`, "❌");
    if (!mode.mockMode) throw err;
    return null;
  });
  const afterRender = await loadState(videoId);
  log(`render: ${afterRender.render_path || "n/a"}`, "✅");

  log("7/11 — QA técnico (validateRender)", "🔍");
  const validation = await validateRender({ videoId, mockMode: mode.mockMode, shortVideoModeOverride: mode.shortMode }).catch((err) => ({
    is_publishable: false,
    issues: [{ type: "validate_render_error", severity: "critical", message: err.message }],
  }));
  log(`validateRender: publishable=${validation.is_publishable} issues=${(validation.issues || []).length}`, "🔎");

  let editorialQa = { passed: true, failures: [] };
  let mediaQa = { passed: true, failures: [] };
  if (mode.deepValidate || mode.shortMode) {
    log("8/11 — QA editorial + QA integridade mídia", "🔬");
    editorialQa = await runEditorialQa({ videoId }).catch((err) => ({
      passed: false,
      failures: [{ rule: "qa_execution_error", detail: err.message }],
    }));
    mediaQa = await runMediaIntegrityQa({ videoId }).catch((err) => ({
      passed: false,
      failures: [{ stage: "execution_error", error: err.message }],
    }));
    log(`editorial_qa.passed=${editorialQa.passed} media_qa.passed=${mediaQa.passed}`, "🧪");
  } else {
    log("8/9 — QA editorial + integridade pulados (sem --deep-validate)", "⏭️");
  }

  let reviewLink = null;
  if (!mode.skipReview && !mode.noUpload) {
    log("9/11 — Publicando revisão online (Drive/Sheets)", "📎");
    reviewLink = await publishReviewLink({ videoId, mode: mode.mockMode ? "mock" : "live" }).catch((err) => {
      log(`review publishing falhou (não bloqueante): ${err.message}`, "⚠️");
      return null;
    });
    log(reviewLink ? `review: ${reviewLink.url || reviewLink.drive_url || JSON.stringify(reviewLink)}` : "review pulado", "📎");
  } else {
    log("9/9 — Review publishing pulado", "⏭️");
  }

  const editorialQaBypassed = (mode.deepValidate || mode.shortMode)
    && process.env.SKIP_EDITORIAL_QA === "true"
    && !editorialQa.passed;
  if (editorialQaBypassed) {
    log("SKIP_EDITORIAL_QA ATIVO — QA editorial Bypassed por env var. NAO USAR EM PRODUCAO.", "🚨");
  }
  const qaPassed =
    validation.is_publishable === true
    && (mode.deepValidate || mode.shortMode
      ? (process.env.SKIP_EDITORIAL_QA === "true" ? true : editorialQa.passed)
        && mediaQa.passed
      : true);

  let uploadSummary = null;
  if (qaPassed && !mode.noUpload) {
    log("📤 Fazendo upload para YouTube", "📺");
    await updateState(videoId, { approved: true }, {});
    try {
      const upload = await uploadToYoutube({ videoId, mockMode: mode.mockMode });
      uploadSummary = {
        mocked: upload.mocked === true,
        youtube_url: upload.youtube_url || "",
        youtube_video_id: upload.youtube_video_id || "",
        caption_status: upload.youtube_caption_status || "",
      };
      log(`upload concluído: ${uploadSummary.youtube_url || uploadSummary.youtube_video_id}`, "📺");
    } catch (err) {
      uploadSummary = { error: err.message };
      log(`upload falhou: ${err.message}`, "❌");
    }
  } else {
    log("📤 Upload pulado (qaPassed=false ou --no-upload)", "⏭️");
    const issues = (validation.issues || []).map(formatIssue).join(", ");
    if (issues) log(`   issues: ${issues}`, "ℹ️");
  }

  const finalState = await loadState(videoId);
  const summary = {
    videoId,
    topic,
    mode: mode.shortMode ? "short" : "long",
    target_duration_seconds: mode.effectiveDuration || 0,
    mock_mode: mode.mockMode,
    script_words: countWords(finalState.script_text || ""),
    audio_provider: finalState.audio_provider || "",
    audio_real: finalState.audio_real === true,
    audio_intelligence_provider: finalState.audio_intelligence_provider || "",
    audio_intelligence_timing_estimated: finalState.audio_intelligence_timing_estimated === true,
    caption_paths: {
      srt: finalState.caption_path_srt || "",
      vtt: finalState.caption_path_vtt || "",
    },
    caption_quality: finalState.caption_quality || "unknown",
    caption_provider: finalState.caption_provider || "",
    caption_lines_count: Number(finalState.caption_lines_count || 0),
    render_path: finalState.render_path || "",
    needs_manual_review: finalState.needs_manual_review === true,
    qa_published_reason: finalState.render_validation?.publish_blocked_codes || [],
    qa: {
      technical: summarizeValidation(validation),
      editorial: { passed: editorialQa.passed, failure_count: (editorialQa.failures || []).length },
      media_integrity: { passed: mediaQa.passed, failure_count: (mediaQa.failures || []).length },
      qa_passed: qaPassed,
    },
    review_link: reviewLink ? (reviewLink.url || reviewLink.drive_url || null) : null,
    upload: uploadSummary,
    final_decision: qaPassed ? (mode.noUpload ? "publishable_no_upload" : (uploadSummary && !uploadSummary.error ? "published" : "publishable_upload_blocked")) : "blocked_needs_review",
  };

  log("🏁 Pipeline concluído", "🏁");
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));

  return summary;
};

if (require.main === module) {
  run().catch((err) => {
    console.error("[CLI-PIPELINE] Erro fatal:", err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, detectRuntimeMode };
