const assert = require("assert");
const { updateState, loadState } = require("../src/services/stateService");
const { generateScript } = require("../src/services/scriptService");
const { generateAudio } = require("../src/services/ttsService");
const { generateAssets } = require("../src/services/assetsService");
const { renderVideo } = require("../src/services/renderService");
const { validateRender } = require("../src/services/syncValidator");
const { uploadToYoutube } = require("../src/services/youtubeService");
const { probeMedia } = require("../src/utils/mediaUtils");

const QA_MODE = String(process.env.QA_MODE || 'strict').toLowerCase();
const MIN_VIDEO_DURATION_SECONDS = parseInt(process.env.MIN_VIDEO_DURATION_SECONDS || '480', 10);
const ENABLE_REAL_UPLOAD = process.env.ENABLE_REAL_UPLOAD_IN_TESTS === 'true';

const topic = "Portugal gastronómico: Lisboa, Porto, mercados e vinhos";
const angle = "documentario narrativo longo focado em comida local, mercados, cafes, vinhos, historia cultural e diferencas entre Lisboa e Porto";
const SCRIPT_TARGET_DURATION_ATTEMPTS = [540, 720, 900];
const MIN_SCRIPT_WORD_COUNT = 1200;

const NON_TECHNICAL_EDITORIAL_WARNING_CODES = new Set([
  "CRITICAL_SLOT_UNCERTAIN",
  "CRITICAL_SLOT_NOT_CONFIRMED",
  "TIMELINE_OUTSIDE_APPROVED_POOL",
  "GENERIC_OVERUSE",
  "WRONG_VISUAL_CATEGORY",
  "THEME_VISUAL_MISMATCH",
  "THEME_COVERAGE_MISSING",
  "RUNTIME_DEGRADATION_USED",
  "LOW_DIVERSITY_BLOCK",
  "NO_PROOF_FOR_PROMISE",
  "BLOCK_COVERAGE_INSUFFICIENT",
  "BLOCK_COVERAGE_PARTIAL",
  "COVERAGE_SEARCH_INSUFFICIENCY",
  "COVERAGE_SEMANTIC_AMBIGUITY",
  "COVERAGE_EDITORIAL_INSUFFICIENCY",
  "COVERAGE_PLANNER_PERMISSIVE",
  "CRITICAL_SLOT_ONLY_GENERIC",
  "DIVERSITY_BYPASS_ON_CRITICAL_SLOT",
  "NO_MICRO_PROOF_FOR_PROMISE",
]);

const HARD_TECHNICAL_QA_ISSUE_TYPES = new Set([
  "missing_timeline",
  "render_probe_failed",
  "render_file_state_mismatch",
  "overlay_apply_failed",
]);

const uniqueStrings = (values = []) => [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];

const getStrictBlockedCodes = (validation = {}) => uniqueStrings([
  ...(validation.editorial_failure_codes || []),
  ...(validation.publish_blocked_codes || []),
]);

const getHardTechnicalIssues = (validation = {}) => {
  const issues = Array.isArray(validation.issues) ? validation.issues : [];
  return uniqueStrings([
    ...issues
      .map((issue) => String(issue?.type || "").trim())
      .filter((type) => HARD_TECHNICAL_QA_ISSUE_TYPES.has(type)),
    validation.overlay_apply_status === "failed" ? "overlay_apply_failed" : "",
  ]);
};

const countWords = (value = "") => String(value || "").trim().split(/\s+/).filter(Boolean).length;
const clampText = (value = "", maxLength = 320) => {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3).trim()}...` : normalized;
};
const roundDuration = (value = 0) => Number(Number(value || 0).toFixed(2));
const rebalanceBlockDurations = (visualPlan = []) => {
  if (!Array.isArray(visualPlan) || visualPlan.length < 2) return visualPlan;

  const nextPlan = visualPlan.map((scene) => ({ ...scene }));
  const introScene = nextPlan[0];
  const lastScene = nextPlan[nextPlan.length - 1];
  const introDuration = Number(introScene.target_duration_seconds || 0);
  const maxIntroSeconds = 12;

  if (introDuration > maxIntroSeconds) {
    const transferredSeconds = roundDuration(introDuration - maxIntroSeconds);
    introScene.target_duration_seconds = maxIntroSeconds;
    lastScene.target_duration_seconds = roundDuration(Number(lastScene.target_duration_seconds || 0) + transferredSeconds);
  }

  return nextPlan;
};
const inferCityFromText = (value = "") => {
  const normalized = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const lisboaIndex = normalized.search(/\blisboa\b|\blisbon\b/);
  const portoIndex = normalized.search(/\bporto\b|\boporto\b/);
  if (lisboaIndex >= 0 && (portoIndex < 0 || lisboaIndex < portoIndex)) return "Lisboa";
  if (portoIndex >= 0 && (lisboaIndex < 0 || portoIndex < lisboaIndex)) return "Porto";
  return "";
};
const stripCityMentions = (value = "") => String(value || "")
  .replace(/\bLisboa\b|\bLisbon\b|\bPorto\b|\bOporto\b/gi, "")
  .replace(/\s{2,}/g, " ")
  .replace(/\s+([,:;.!?])/g, "$1")
  .trim();

const buildBlockLevelVisualPlan = ({ visualPlan = [], structuredBlocks = [], outlineSections = [] }) => {
  if (Array.isArray(structuredBlocks) && structuredBlocks.length > 0) {
    return structuredBlocks.map((block = {}, index) => {
      const outlineTitle = String(outlineSections[index]?.title || "").trim();
      const role = index === 0 ? "intro" : (index === structuredBlocks.length - 1 ? "outro" : "body");
      const rawTitle = String(outlineTitle || block.title || `Bloco ${index + 1}`).trim();
      const isSpecificBlock = String(block.visual_type || "").trim().toLowerCase() === "specific";
      const title = isSpecificBlock
        ? rawTitle
        : (stripCityMentions(rawTitle) || (role === "intro" ? "Introducao" : role === "outro" ? "Fechamento" : `Bloco ${index + 1}`));
      const sanitizedKeywords = isSpecificBlock
        ? uniqueStrings(block.keywords || []).slice(0, 12)
        : uniqueStrings((block.keywords || []).filter((keyword) => !inferCityFromText(keyword))).slice(0, 12);
      const sanitizedNarration = isSpecificBlock
        ? clampText(block.text || title, 420)
        : clampText(stripCityMentions(block.text || block.visual_description || title) || title, 420);
      const combinedLocationText = [title, block.visual_description, isSpecificBlock ? block.text : "", ...(isSpecificBlock ? sanitizedKeywords : [])].join(" ");
      const city = isSpecificBlock ? inferCityFromText(combinedLocationText) : "";
      const negativeKeywords = city === "Lisboa"
        ? ["Porto", "porto", "oporto"]
        : city === "Porto"
          ? ["Lisboa", "lisboa", "lisbon"]
          : [];
      const allowedVisualCategories = [
        "food",
        "local_food",
        "market",
        "wine",
        "pastry",
        "restaurant",
        "cafe",
        "street_food",
        "people_eating",
      ];
      const forbiddenVisualCategories = [
        "skyline",
        "bridge",
        "river",
        "clouds",
        "generic_street",
        "coast",
        "landscape",
      ];
      const genericIntroScene = !isSpecificBlock && role === "intro";
      const visualRequirements = genericIntroScene
        ? ["establishing_shot", "food_closeups"]
        : uniqueStrings([
          isSpecificBlock ? "location_specific" : "establishing_shot",
          "food_closeups",
          "market_life",
          "people_eating",
          ...(block.keywords || []).slice(0, 4),
        ]).slice(0, 12);
      const requiredVisualEvidence = genericIntroScene
        ? ["food"]
        : isSpecificBlock
          ? ["food", "plate", "market", "restaurant", "people eating"]
          : ["food", "plate", "restaurant"];

      return {
        scene_index: index + 1,
        scene_order: index + 1,
        block_id: String(block.block_id || `b${String(index + 1).padStart(2, "0")}`).trim(),
        block_index: index + 1,
        block_label: title,
        title,
        narration_excerpt: sanitizedNarration,
        keywords: sanitizedKeywords,
        target_duration_seconds: roundDuration(block.duration_estimate || 60),
        visual_description: clampText(block.visual_description || title, 320),
        visual_intent: "gastronomy",
        generic_asset_allowed: !isSpecificBlock,
        requires_visual_proof: isSpecificBlock,
        slot_criticality: isSpecificBlock ? "critical" : (genericIntroScene ? "medium" : (role === "outro" ? "high" : "medium")),
        role,
        hard_boundary: index === 0,
        chapter_card_required: false,
        transition_type: index === 0 ? "hard" : "cut",
        expected_location: city,
        location: {
          city,
          country: "Portugal",
          confidence: city ? 0.9 : 0,
          source: city ? "structured_block" : "unknown",
        },
        negative_keywords: negativeKeywords,
        visual_requirements: visualRequirements,
        required_visual_evidence: requiredVisualEvidence,
        allowed_visual_categories: allowedVisualCategories,
        forbidden_visual_categories: forbiddenVisualCategories,
        overlay_title: `${index + 1}. ${title}`,
      };
    });
  }

  const orderedGroups = [];
  const groups = new Map();

  (visualPlan || []).forEach((scene = {}) => {
    const blockId = String(scene.block_id || `scene_${Number(scene.scene_index || 0)}`).trim();
    if (!groups.has(blockId)) {
      const nextGroup = [];
      groups.set(blockId, nextGroup);
      orderedGroups.push([blockId, nextGroup]);
    }
    groups.get(blockId).push(scene);
  });

  return orderedGroups.map(([blockId, scenes], index) => {
    const firstScene = scenes[0] || {};
    const structuredBlock = structuredBlocks[Math.max(0, Number(firstScene.block_index || index + 1) - 1)] || {};
    const totalDurationSeconds = roundDuration(
      scenes.reduce((sum, scene) => sum + Number(scene.target_duration_seconds || 0), 0)
    );
    const blockTitle = String(
      structuredBlock.title
      || firstScene.block_label
      || firstScene.overlay_title
      || firstScene.title
      || `Bloco ${index + 1}`
    ).trim();
    const isSpecificBlock = String(structuredBlock.visual_type || "").trim().toLowerCase() === "specific";
    const mergedKeywords = uniqueStrings([
      ...(structuredBlock.keywords || []),
      ...scenes.flatMap((scene) => scene.keywords || []),
    ]).slice(0, 12);

    return {
      ...firstScene,
      scene_index: index + 1,
      scene_order: index + 1,
      block_id: blockId,
      block_index: index + 1,
      block_label: blockTitle,
      title: blockTitle,
      narration_excerpt: clampText(
        structuredBlock.text || scenes.map((scene) => scene.narration_excerpt || scene.title || "").join(" "),
        420
      ),
      keywords: mergedKeywords,
      target_duration_seconds: totalDurationSeconds,
      visual_description: clampText(
        structuredBlock.visual_description || firstScene.visual_description || blockTitle,
        320
      ),
      visual_intent: firstScene.visual_intent || "gastronomy",
      generic_asset_allowed: isSpecificBlock ? false : Boolean(firstScene.generic_asset_allowed),
      requires_visual_proof: isSpecificBlock || scenes.some((scene) => scene.requires_visual_proof === true),
      slot_criticality: isSpecificBlock ? "critical" : (firstScene.slot_criticality || "high"),
      role: index === 0 ? "intro" : (index === orderedGroups.length - 1 ? "outro" : (firstScene.role || "body")),
      hard_boundary: index === 0 ? true : Boolean(firstScene.hard_boundary),
      chapter_card_required: index === 0 ? true : Boolean(firstScene.chapter_card_required),
      transition_type: firstScene.transition_type || (index === 0 ? "hard" : "cut"),
      negative_keywords: uniqueStrings(scenes.flatMap((scene) => scene.negative_keywords || [])),
      visual_requirements: uniqueStrings(scenes.flatMap((scene) => scene.visual_requirements || [])).slice(0, 12),
      required_visual_evidence: uniqueStrings(scenes.flatMap((scene) => scene.required_visual_evidence || [])).slice(0, 10),
      allowed_visual_categories: uniqueStrings(scenes.flatMap((scene) => scene.allowed_visual_categories || [])).slice(0, 12),
      forbidden_visual_categories: uniqueStrings(scenes.flatMap((scene) => scene.forbidden_visual_categories || [])).slice(0, 12),
    };
  });
};

const run = async () => {
  const videoId = `security_test_${Date.now()}`;

  console.log("🍷 Iniciando teste completo: Portugal gastronomia");
  console.log(`[QA] Modo: ${QA_MODE} | minDuration: ${MIN_VIDEO_DURATION_SECONDS}s | upload: ${ENABLE_REAL_UPLOAD ? 'real/private' : 'mock'}`);

  // Configurar estado inicial
  await updateState(
    videoId,
    {
      topic,
      angle,
      selected_idea: { topic, angle },
      approved: false,
      error_message: "",
    },
    {
      currentStep: "idea_approved",
      status: "idea_approved",
    }
  );

  let stateAfterRawScript = null;
  let generatedScriptWordCount = 0;
  let rawGeneratedSceneCount = 0;
  let selectedScriptTargetSeconds = SCRIPT_TARGET_DURATION_ATTEMPTS[0];
  let blockLevelVisualPlan = [];

  for (const targetDurationSeconds of SCRIPT_TARGET_DURATION_ATTEMPTS) {
    selectedScriptTargetSeconds = targetDurationSeconds;
    console.log(`📝 Gerando roteiro real com alvo de ${targetDurationSeconds}s...`);
    await generateScript({
      videoId,
      mockMode: false,
      topic,
      targetDurationSeconds,
    });

    stateAfterRawScript = await loadState(videoId);
    generatedScriptWordCount = countWords(stateAfterRawScript.script_text || "");
    rawGeneratedSceneCount = Array.isArray(stateAfterRawScript.visual_plan) ? stateAfterRawScript.visual_plan.length : 0;
    blockLevelVisualPlan = rebalanceBlockDurations(buildBlockLevelVisualPlan({
      visualPlan: stateAfterRawScript.visual_plan || [],
      structuredBlocks: stateAfterRawScript.structured_blocks || [],
      outlineSections: stateAfterRawScript.outline_json?.sections || [],
    }));

    if (generatedScriptWordCount >= MIN_SCRIPT_WORD_COUNT) {
      break;
    }

    console.warn(
      `⚠️ Roteiro com ${generatedScriptWordCount} palavras ainda abaixo do minimo de ${MIN_SCRIPT_WORD_COUNT}; tentando novo alvo...`
    );
  }

  assert(
    generatedScriptWordCount >= MIN_SCRIPT_WORD_COUNT,
    `roteiro gerado precisa ter pelo menos ${MIN_SCRIPT_WORD_COUNT} palavras para sustentar video acima de 480s; atual: ${generatedScriptWordCount}`
  );

  assert(blockLevelVisualPlan.length >= 3, "o visual_plan consolidado deve manter blocos suficientes para cobrir o roteiro longo");

  await updateState(
    videoId,
    { visual_plan: blockLevelVisualPlan },
    { currentStep: "script_generated", status: "script_generated" }
  );

  const generatedSceneCount = blockLevelVisualPlan.length;
  console.log(
    `✅ Roteiro gerado: ${generatedScriptWordCount} palavras, ${rawGeneratedSceneCount} cenas brutas, ${generatedSceneCount} cenas consolidadas, alvo final ${selectedScriptTargetSeconds}s`
  );

  // Gerar áudio
  console.log("🎙️ Gerando áudio...");
  const audio = await generateAudio({ videoId, mockMode: false, provider: "multivozes" });
  console.log(`✅ Áudio gerado: ${audio.provider} - ${audio.voice}`);

  // Buscar assets
  console.log("🎬 Buscando assets de gastronomia e cidades...");
  const assets = await generateAssets({ 
    videoId, 
    mockMode: false, 
    maxAssets: 60,
    minVideoDuration: 8
  });
  
  const externalAssets = (assets.assets_json?.items || []).filter((item) => ["pexels", "pixabay"].includes(item.provider));
  const externalVideoAssets = externalAssets.filter((item) => item.asset_type === "video");
  
  console.log(`📊 Assets disponíveis: ${externalAssets.length} totais, ${externalVideoAssets.length} vídeos`);
  if (externalAssets.length < 20) {
    console.warn(`⚠️ [ASSETS] Pool pequeno (${externalAssets.length} assets para potencialmente 100+ clips). Considere aumentar maxAssets ou MAX_ASSET_USES_PER_VIDEO.`);
  }

  // Renderizar vídeo
  console.log("🎥 Renderizando vídeo com algoritmo aprimorado...");
  let renderInfo = null;
  let renderBlockedInProgressive = false;

  try {
    await renderVideo({ videoId, mockMode: false });
    const stateAfterRender = await loadState(videoId);
    if (stateAfterRender.render_path) {
      renderInfo = await probeMedia(stateAfterRender.render_path);
      assert(
        Number(renderInfo.duration || 0) > MIN_VIDEO_DURATION_SECONDS,
        `o video final deve ter mais de ${MIN_VIDEO_DURATION_SECONDS}s para passar o gate M8; duracao atual: ${renderInfo.duration || 0}s`
      );
    } else if (QA_MODE === 'progressive') {
      console.warn(`⚠️ [RENDER] render_path vazio em modo progressive — continuando com warnings`);
      renderBlockedInProgressive = true;
    } else {
      throw new Error('render_path vazio após renderVideo no modo strict');
    }
  } catch (renderErr) {
    if (QA_MODE === 'progressive') {
      const stateAfterError = await loadState(videoId);
      if (String(stateAfterError.status || '').includes('render_blocked')) {
        console.warn(`⚠️ [RENDER] Preflight bloqueou em modo progressive: ${stateAfterError.error_message || renderErr.message}`);
        renderBlockedInProgressive = true;
      } else {
        throw renderErr;
      }
    } else {
      throw renderErr;
    }
  }
  let outcome = "PASSED";
  let uploadSkippedReason = "";
  let upload = { youtube_url: "", youtube_video_id: "" };
  let validation = null;

  if (renderBlockedInProgressive) {
    outcome = "PASSED_WITH_WARNINGS";
    uploadSkippedReason = "upload skipped: render blocked by editorial preflight in progressive mode";
    console.warn(`⚠️ ${uploadSkippedReason}`);
    await updateState(
      videoId,
      { approved: false, error_message: uploadSkippedReason },
      { currentStep: "needs_revision", status: "needs_revision" }
    );
  } else {
    validation = await validateRender({ videoId, mockMode: false });

    assert(validation, "validacao de render deveria retornar payload");
    if (QA_MODE === 'strict') {
      assert.strictEqual(
        validation.qa_runtime_profile,
        "prod_strict",
        "validacao estrita deveria rodar em perfil prod_strict"
      );
    }

    const strictBlockedCodes = getStrictBlockedCodes(validation);
    const hardTechnicalIssues = getHardTechnicalIssues(validation);
    const progressiveWarnings = (validation.editorial_warnings || []);

    if (validation.is_publishable !== true) {
      if (QA_MODE === 'progressive' && progressiveWarnings.length > 0 && hardTechnicalIssues.length === 0) {
        outcome = "PASSED_WITH_WARNINGS";
        uploadSkippedReason = `upload skipped: editorial warnings in progressive mode (${progressiveWarnings.join(", ")})`;
        console.warn(`⚠️ ${uploadSkippedReason}`);
        await updateState(
          videoId,
          { approved: false, error_message: uploadSkippedReason },
          { currentStep: "needs_revision", status: "needs_revision" }
        );
      } else {
        assert.strictEqual(
          validation.publish_blocked,
          true,
          "quando o render nao eh publishable no perfil estrito, publish_blocked deve ser true"
        );
        assert(
          strictBlockedCodes.length > 0 || hardTechnicalIssues.length > 0,
          "perfil estrito deveria retornar falhas editoriais ou tecnicas quando reprova"
        );

        const editorialOnlyWarning = strictBlockedCodes.length > 0
          && hardTechnicalIssues.length === 0
          && strictBlockedCodes.every((code) => NON_TECHNICAL_EDITORIAL_WARNING_CODES.has(code));

        if (!editorialOnlyWarning) {
          const diagnostic = hardTechnicalIssues.length > 0
            ? `hard technical issues: ${hardTechnicalIssues.join(", ")}`
            : `blocked codes: ${strictBlockedCodes.join(", ")}`;
          throw new Error(`QA estrita falhou com erro tecnico ou bloqueio nao elegivel para warning (${diagnostic}).`);
        }

        outcome = "PASSED_WITH_WARNINGS";
        uploadSkippedReason = `upload skipped: editorial gates not met (${strictBlockedCodes.join(", ")})`;
        console.warn(`⚠️ ${uploadSkippedReason}`);

        await updateState(
          videoId,
          { approved: false, error_message: uploadSkippedReason },
          { currentStep: "needs_revision", status: "needs_revision" }
        );
      }
    }
  }

  if (renderInfo) {
    console.log(`✅ Render concluído: ${renderInfo.duration}s @ ${renderInfo.width}x${renderInfo.height}`);
  }
  if (validation) {
    console.log(`✅ Render validado: quality=${validation.quality_score} publishable=${validation.is_publishable} qa_mode=${validation.qa_mode || QA_MODE}`);
  }

  if (outcome === "PASSED") {
    await updateState(
      videoId,
      {
        approved: true,
        error_message: "",
      },
      {
        currentStep: "final_approved",
        status: "final_approved",
      }
    );

    console.log(`📤 ${ENABLE_REAL_UPLOAD ? 'Upload real (private)' : 'Upload mock'}...`);
    console.log(`[UPLOAD] Modo: ${ENABLE_REAL_UPLOAD ? 'real' : 'mock'} | MIN_DURATION: ${MIN_VIDEO_DURATION_SECONDS}s | visibility: private`);
    try {
      upload = await uploadToYoutube({
        videoId,
        mockMode: !ENABLE_REAL_UPLOAD,
        privacyStatus: "private",
      });
      if (upload.youtube_video_id) {
        console.log(`[UPLOAD] video_id: ${upload.youtube_video_id} | url: ${upload.youtube_url}`);
      }
    } catch (uploadErr) {
      if (ENABLE_REAL_UPLOAD) {
        console.warn(`⚠️ [UPLOAD] Falha no upload real: ${uploadErr.message}`);
        outcome = "PASSED_WITH_WARNINGS";
        uploadSkippedReason = `upload falhou: ${uploadErr.message}`;
        upload = { youtube_url: '', youtube_video_id: '' };
        await updateState(
          videoId,
          { approved: false, error_message: uploadSkippedReason },
          { currentStep: "needs_revision", status: "needs_revision" }
        );
      } else {
        throw uploadErr;
      }
    }
  }

  const finalState = await loadState(videoId);

  if (outcome === "PASSED") {
    assert.strictEqual(
      finalState.pre_upload_qa?.ok,
      true,
      `gate M8 deve passar no fluxo feliz; pre_upload_qa atual: ${JSON.stringify(finalState.pre_upload_qa || {})}`
    );
  }

  console.log(outcome === "PASSED" ? "🎉 FLUXO COMPLETO FINALIZADO!" : "🎉 FLUXO COMPLETO FINALIZADO COM AVISOS!");
  console.log("📊 Estatísticas Finais:");
  console.log(JSON.stringify({
    outcome,
    video_id: videoId,
    youtube_url: upload.youtube_url || finalState.youtube_url || "",
    youtube_video_id: upload.youtube_video_id || finalState.youtube_video_id || "",
    audio_provider: audio.provider,
    audio_voice: audio.voice,
    external_assets: externalAssets.length,
    external_video_assets: externalVideoAssets.length,
    total_clips: finalState.render_timeline?.total_clips,
    unique_asset_count: finalState.render_timeline?.unique_asset_count,
    output_resolution: finalState.render_timeline?.output_resolution,
    output_duration_seconds: finalState.render_timeline?.output_duration_seconds,
    semantic_alignment_score_average: finalState.render_timeline?.semantic_alignment_score_average,
    low_confidence_clip_count: finalState.render_timeline?.low_confidence_clip_count,
    render_quality_score: finalState.render_validation?.quality_score,
    script_word_count: generatedScriptWordCount,
    script_target_attempt_seconds: selectedScriptTargetSeconds,
    raw_visual_plan_scene_count: rawGeneratedSceneCount,
    visual_plan_scene_count: generatedSceneCount,
    final_current_step: finalState.current_step || finalState.status,
    final_status: finalState.status || "",
    pre_upload_qa_ok: finalState.pre_upload_qa?.ok === true,
    upload_skipped: outcome === "PASSED_WITH_WARNINGS",
    upload_skip_reason: uploadSkippedReason,
    strict_publish_blocked_codes: validation ? getStrictBlockedCodes(validation) : [],
    editorial_warnings: validation?.editorial_warnings || [],
    qa_mode: QA_MODE,
    variety_score: ((finalState.render_timeline?.unique_asset_count || 0) / (finalState.render_timeline?.total_clips || 1) * 100).toFixed(1) + "%",
  }, null, 2));

  console.log("\n🔍 Análise Final:");
  console.log(`- Outcome: ${outcome}`);
  console.log(`- Sync Score: ${finalState.render_timeline?.semantic_alignment_score_average || 'N/A'}`);
  console.log(`- Clips Low Confidence: ${finalState.render_timeline?.low_confidence_clip_count || 0}`);
  console.log(`- Variedade de Assets: ${finalState.render_timeline?.unique_asset_count || 0}/${finalState.render_timeline?.total_clips || 0}`);
  console.log(`- Duração: ${finalState.render_timeline?.output_duration_seconds || 0}s`);
  console.log(`- Gate M8: ${finalState.pre_upload_qa?.ok === true ? "pass" : "fail"}`);
  const timelineClips = Array.isArray(finalState.render_timeline?.clips) ? finalState.render_timeline.clips : [];
  const hardBlockedClips = timelineClips.filter((c) => Number(c.timeline_score ?? c.composite_score ?? 0) < -0.5);
  const hardBlockedRatio = timelineClips.length ? hardBlockedClips.length / timelineClips.length : 0;
  if (hardBlockedRatio > 0.5) {
    console.warn(`⚠️ [SCORE] ${(hardBlockedRatio * 100).toFixed(0)}% dos clips (${hardBlockedClips.length}/${timelineClips.length}) têm score < -0.5 (hard-blocked por escassez de assets).`);
  } else if (hardBlockedRatio > 0.2) {
    console.warn(`⚡ [SCORE] ${(hardBlockedRatio * 100).toFixed(0)}% dos clips (${hardBlockedClips.length}/${timelineClips.length}) hard-blocked — pool de assets no limite.`);
  }
  if (outcome === "PASSED_WITH_WARNINGS") {
    console.log(`- Upload: skipped (${uploadSkippedReason})`);
  } else {
    console.log(`- YouTube: ${upload.youtube_url}`);
  }
};

run().catch((error) => {
  console.error("❌ Falha no teste completo:", error.message);
  console.error(error.stack);
  process.exit(1);
});
