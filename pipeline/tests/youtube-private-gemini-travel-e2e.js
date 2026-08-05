process.env.COVERAGE_GATE_ALLOW_PARTIAL = "true";
process.env.PRE_RENDER_EDITORIAL_FAIL_FAST = "false";
process.env.EDITORIAL_STRONG_ONLY_PRE_RENDER = "false";
process.env.SEMANTIC_SYNC_MODE = "high-quality";
process.env.RUNTIME_DEGRADE_ON_MISSING_ASSETS = "false";
process.env.LOCAL_VIDEO_UNDERSTANDING_ENABLED = "false";
process.env.USE_CLIP_LIBRARY = "true";
process.env.USE_SCENE_INDEX = "true";
process.env.GEMINI_VISION_ENABLED = "true";
process.env.ASSET_RAW_CANDIDATES_PER_BLOCK = process.env.ASSET_RAW_CANDIDATES_PER_BLOCK || "180";
process.env.ASSET_CHEAP_SHORTLIST_PER_BLOCK = process.env.ASSET_CHEAP_SHORTLIST_PER_BLOCK || "50";
process.env.ASSET_VISION_FINALISTS_PER_BLOCK = process.env.ASSET_VISION_FINALISTS_PER_BLOCK || "24";
process.env.ASSET_SCARCITY_RAW_CANDIDATES_PER_BLOCK = process.env.ASSET_SCARCITY_RAW_CANDIDATES_PER_BLOCK || "220";
process.env.ASSET_SCARCITY_CHEAP_SHORTLIST_PER_BLOCK = process.env.ASSET_SCARCITY_CHEAP_SHORTLIST_PER_BLOCK || "70";
process.env.ASSET_SCARCITY_VISION_FINALISTS_PER_BLOCK = process.env.ASSET_SCARCITY_VISION_FINALISTS_PER_BLOCK || "28";
process.env.MULTIVOZES_CHUNK_MAX_CHARS = process.env.MULTIVOZES_CHUNK_MAX_CHARS || "260";
process.env.MULTIVOZES_CHUNK_RETRIES = process.env.MULTIVOZES_CHUNK_RETRIES || "4";

const fs = require("fs-extra");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { config } = require("../src/config/env");
const { maybeSkipWithoutKeys } = require("./_helpers/shouldSkipWithoutKeys.js");
const { updateState, loadState } = require("../src/services/stateService");
const { generateScript } = require("../src/services/scriptService");
const { generateAudio, basicMultivozesHealthcheck } = require("../src/services/ttsService");
const { generateCaptions } = require("../src/services/captionsService");
const {
  generateAssets,
  basicPexelsHealthcheck,
  basicPixabayHealthcheck,
} = require("../src/services/assetsService");
const { renderVideo } = require("../src/services/renderService");
const { validateRender, fixRenderSync } = require("../src/services/syncValidator");
const { uploadToYoutube, basicYoutubeHealthcheck } = require("../src/services/youtubeService");
const { basicOpenAIHealthcheck } = require("../src/services/openaiService");
const { basicGeminiHealthcheck } = require("../src/services/geminiService");
const { probeMedia } = require("../src/utils/mediaUtils");
const { closeClipLibraryDb } = require("../src/services/clipLibraryService");
const { closeSceneIndexDb } = require("../src/services/sceneIndexService");

const assertOk = (condition, message) => {
  if (!condition) throw new Error(message);
};

const unique = (values = []) => [...new Set((values || []).filter(Boolean))];

const countWords = (text = "") =>
  String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

const splitSentences = (text = "") =>
  String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

const sanitizeHook = (text = "") =>
  String(text || "")
    .replace(/\[.*?\]/g, "")
    .replace(/^\s*\d{2}:\d{2}\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

const countBy = (values = []) =>
  (values || []).reduce((acc, value) => {
    const key = String(value || "unknown").trim() || "unknown";
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});

const safeJsonParse = (raw, fallback = {}) => {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const removeWithRetry = async (targetPath, attempts = 5) => {
  if (!targetPath) return;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await fs.pathExists(targetPath)) await fs.remove(targetPath);
      return;
    } catch (error) {
      if (attempt >= attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
};

const resetEditorialCaches = async () => {
  closeClipLibraryDb();
  closeSceneIndexDb();
  const targets = [
    config.CLIP_LIBRARY_DB_PATH,
    config.SCENE_INDEX_DB_PATH,
    config.CLIP_LIBRARY_ROOT_DIR,
    config.CLIP_LIBRARY_SHADOW_REPORT_DIR,
  ];
  for (const target of targets) {
    if (!target) continue;
    await removeWithRetry(target);
  }
  await fs.ensureDir(path.dirname(config.CLIP_LIBRARY_DB_PATH));
  await fs.ensureDir(path.dirname(config.SCENE_INDEX_DB_PATH));
  await fs.ensureDir(config.CLIP_LIBRARY_ROOT_DIR);
  await fs.ensureDir(config.CLIP_LIBRARY_SHADOW_REPORT_DIR);
};

const createScene = ({
  sceneIndex,
  title,
  city = "",
  visualIntent = "city_landmark",
  excerpt,
  keywords,
  targetDurationSeconds,
}) => ({
  scene_index: sceneIndex,
  title,
  visual_intent: visualIntent,
  narration_excerpt: excerpt,
  keywords,
  target_duration_seconds: targetDurationSeconds,
  location: city
    ? {
        city,
        country: "Portugal",
        confidence: 0.95,
        source: "manual_e2e",
      }
    : {
        city: "",
        country: "Portugal",
        confidence: 0.7,
        source: "manual_e2e",
      },
});

const buildVisualPlan = () => [
  createScene({
    sceneIndex: 1,
    title: "Abertura de Portugal",
    city: "",
    visualIntent: "generic_travel",
    excerpt: "Abertura com panorama de Portugal e proposta visual da viagem.",
    keywords: ["portugal travel montage", "portugal documentary intro", "portugal scenic opening"],
    targetDurationSeconds: 10,
  }),
  createScene({
    sceneIndex: 2,
    title: "Lisboa e os miradouros",
    city: "Lisboa",
    visualIntent: "city_landmark",
    excerpt: "Lisboa com Alfama, miradouros, Tejo e eixo historico.",
    keywords: ["lisbon miradouro", "alfama lisbon", "belem tower lisbon", "lisbon skyline", "tejo river lisbon"],
    targetDurationSeconds: 14,
  }),
  createScene({
    sceneIndex: 3,
    title: "Lisboa e a gastronomia",
    city: "Lisboa",
    visualIntent: "gastronomy",
    excerpt: "Pastel de nata, mercados e mesa tipica de Lisboa.",
    keywords: ["pastel de nata lisbon", "lisbon food market", "lisbon restaurant", "bacalhau portugal", "portuguese pastry lisbon"],
    targetDurationSeconds: 12,
  }),
  createScene({
    sceneIndex: 4,
    title: "Porto, Douro e Ponte Dom Luis I",
    city: "Porto",
    visualIntent: "city_landmark",
    excerpt: "Porto com Ribeira, Douro, ponte e casario historico.",
    keywords: ["porto ribeira", "dom luis bridge porto", "douro river porto", "porto skyline", "porto old town"],
    targetDurationSeconds: 14,
  }),
  createScene({
    sceneIndex: 5,
    title: "Porto, vinho e cozinha local",
    city: "Porto",
    visualIntent: "gastronomy",
    excerpt: "Caves, vinho do Porto e pratos tipicos como francesinha.",
    keywords: ["port wine cellar", "porto wine tasting", "francesinha porto", "porto restaurant", "porto food"],
    targetDurationSeconds: 12,
  }),
  createScene({
    sceneIndex: 6,
    title: "Faro e a Cidade Velha",
    city: "Faro",
    visualIntent: "city_landmark",
    excerpt: "Faro historico com muralhas, arcos e ritmo mais calmo.",
    keywords: ["faro old town", "cidade velha faro", "faro city walls", "faro historic center", "faro arch"],
    targetDurationSeconds: 12,
  }),
  createScene({
    sceneIndex: 7,
    title: "Faro e a Ria Formosa",
    city: "Faro",
    visualIntent: "city_landmark",
    excerpt: "Barcos, ilhas e agua clara da Ria Formosa.",
    keywords: ["ria formosa", "faro boat lagoon", "algarve islands aerial", "faro coastline", "ria formosa drone"],
    targetDurationSeconds: 14,
  }),
  createScene({
    sceneIndex: 8,
    title: "Faro e frutos do mar",
    city: "Faro",
    visualIntent: "gastronomy",
    excerpt: "Cataplana, ameijoas e peixe fresco no Algarve.",
    keywords: ["cataplana algarve", "faro seafood", "ameijoas portugal", "faro restaurant fish", "algarve food"],
    targetDurationSeconds: 12,
  }),
  createScene({
    sceneIndex: 9,
    title: "Fechamento comparativo",
    city: "",
    visualIntent: "generic_travel",
    excerpt: "Comparacao final entre Lisboa, Porto e Faro.",
    keywords: ["portugal city comparison", "portugal travel outro", "travel summary portugal"],
    targetDurationSeconds: 10,
  }),
];

const buildPublicationScript = (generatedScript = "") => {
  const hook = sanitizeHook(splitSentences(generatedScript)[0] || "Portugal consegue condensar historia, paisagem e comida em uma viagem que muda completamente de cidade para cidade.");
  return [
    `${hook} Em cerca de dois minutos, este roteiro passa por Lisboa, Porto e Faro para mostrar como cada parada entrega uma imagem diferente de Portugal.`,
    "Lisboa abre o video com miradouros, Tejo e ruas inclinadas de Alfama, onde o casario, os azulejos e o eletrico criam uma identidade visual imediata.",
    "Quando a narracao desce para Belem, entram monumentos, margem do rio e planos mais abertos, porque a cidade precisa parecer historica e ao mesmo tempo luminosa.",
    "Na parte gastronomica de Lisboa, a imagem precisa acompanhar a promessa do texto com pastel de nata, balcões de mercado e pratos tradicionais servidos em mesa real.",
    "Depois a viagem muda para o Porto, e o primeiro impacto vem do Douro, da Ribeira e da Ponte Dom Luis I dominando o quadro antes dos detalhes de rua.",
    "O Porto funciona melhor quando a edicao alterna panoramas do rio com fachadas antigas, pessoas caminhando e cenas em que a ponte realmente conversa com a narracao.",
    "Na gastronomia portuense, entram caves de vinho do Porto, taças, restaurantes e pratos como francesinha, para que a culinaria tenha evidencia visual e nao pareça genérica.",
    "No terceiro bloco, Faro precisa aparecer com outra atmosfera, mais calma e mais clara, começando pela Cidade Velha, pelos arcos e pelas muralhas que definem o centro historico.",
    "A seguir, a Ria Formosa amplia a sensacao de viagem com barcos, passadicos, ilhas e agua rasa em tons mais brilhantes, criando uma pausa visual depois da densidade urbana do Porto.",
    "A cozinha de Faro fecha o eixo gastronomico com peixe fresco, ameijoas e cataplana, reforçando que o Algarve tambem se entende pela mesa e nao apenas pela praia.",
    "No bloco final, a comparacao e direta: Lisboa impressiona pelo relevo e pelos simbolos, Porto pelo encontro entre ponte, rio e arquitetura, e Faro pela luz, pela agua e pelo ritmo costeiro.",
    "Essa combinacao faz sentido porque cada cidade muda o ritmo do video sem quebrar a continuidade da viagem.",
    "Com isso, o espectador termina o video entendendo onde cada lugar brilha e por que Portugal funciona tao bem quando paisagem, cidade e gastronomia aparecem juntas.",
  ].join(" ");
};

const readSceneIndexAudit = (videoId) => {
  if (!config.SCENE_INDEX_DB_PATH || !fs.existsSync(config.SCENE_INDEX_DB_PATH)) {
    return { total: 0, with_description: 0, with_clip_id: 0, sample: [] };
  }

  const conn = new DatabaseSync(config.SCENE_INDEX_DB_PATH);
  try {
    const rows = conn.prepare(
      "SELECT scene_id, description, usage_intent, clip_id FROM scene_index_entries WHERE video_id = ? ORDER BY confidence DESC LIMIT 5"
    ).all(videoId);
    const allRows = conn.prepare(
      "SELECT description, clip_id FROM scene_index_entries WHERE video_id = ?"
    ).all(videoId);
    return {
      total: Number(allRows.length || 0),
      with_description: allRows.filter((row) => String(row.description || "").trim()).length,
      with_clip_id: allRows.filter((row) => String(row.clip_id || "").trim()).length,
      sample: rows.map((row) => ({
        scene_id: row.scene_id,
        usage_intent: row.usage_intent,
        description: row.description,
        clip_id: row.clip_id,
      })),
    };
  } finally {
    conn.close();
  }
};

const readClipLibraryAudit = (videoId) => {
  if (!config.CLIP_LIBRARY_DB_PATH || !fs.existsSync(config.CLIP_LIBRARY_DB_PATH)) {
    return { total: 0, approved: 0, with_semantic_summary: 0, sample: [] };
  }

  const conn = new DatabaseSync(config.CLIP_LIBRARY_DB_PATH);
  try {
    const rows = conn.prepare(
      "SELECT clip_id, status, visual_intent, tags_semanticas_json, entities_json, metadata_json FROM clips WHERE video_id = ? ORDER BY updated_at DESC LIMIT 5"
    ).all(videoId);
    const allRows = conn.prepare(
      "SELECT status, metadata_json FROM clips WHERE video_id = ?"
    ).all(videoId);
    return {
      total: Number(allRows.length || 0),
      approved: allRows.filter((row) => String(row.status || "") === "approved").length,
      with_semantic_summary: allRows.filter((row) => {
        const metadata = safeJsonParse(row.metadata_json, {});
        return Boolean(metadata.semantic_summary || metadata.summary || metadata.description || metadata.semantic_phrase);
      }).length,
      sample: rows.map((row) => {
        const metadata = safeJsonParse(row.metadata_json, {});
        return {
          clip_id: row.clip_id,
          status: row.status,
          visual_intent: row.visual_intent,
          tags: safeJsonParse(row.tags_semanticas_json, []),
          entities: safeJsonParse(row.entities_json, []),
          semantic_summary: metadata.semantic_summary || metadata.summary || metadata.description || "",
        };
      }),
    };
  } finally {
    conn.close();
  }
};

const run = async () => {
  const topic = "Portugal em 2 minutos: Lisboa, Porto e Faro com miradouros, Douro e gastronomia local";
  const angle = [
    "roteiro faceless de viagem com cerca de 2 minutos",
    "mostrar lugares reais, identidade de cada cidade e gastronomia local",
    "obrigatorio citar Lisboa com Alfama, Belem e miradouros",
    "obrigatorio citar Porto com Ribeira, Ponte Dom Luis I, Douro e vinho do Porto",
    "obrigatorio citar Faro com Cidade Velha, Ria Formosa, ilhas do Algarve e frutos do mar",
    "transicoes claras entre cidades e fechamento comparativo",
  ].join("; ");
  const videoId = `youtube_private_gemini_travel_${Date.now()}`;
  const visualPlan = buildVisualPlan();
  const reportPath = path.join(config.TEST_REPORTS_ROOT, `${videoId}-summary.json`);

  await fs.ensureDir(path.dirname(reportPath));
  await resetEditorialCaches();

  const [
    openaiHealth,
    geminiHealth,
    multivozesHealth,
    pexelsHealth,
    pixabayHealth,
    youtubeHealth,
  ] = await Promise.all([
    basicOpenAIHealthcheck(),
    basicGeminiHealthcheck(),
    basicMultivozesHealthcheck(),
    basicPexelsHealthcheck(),
    basicPixabayHealthcheck(),
    basicYoutubeHealthcheck(),
  ]);

  assertOk(openaiHealth.ok, `OpenAI indisponivel: ${openaiHealth.message}`);
  assertOk(geminiHealth.ok, `Gemini indisponivel: ${geminiHealth.message}`);
  assertOk(multivozesHealth.ok, `Multivozes indisponivel: ${multivozesHealth.message}`);
  assertOk(pexelsHealth.ok, `Pexels indisponivel: ${pexelsHealth.message}`);
  assertOk(pixabayHealth.ok, `Pixabay indisponivel: ${pixabayHealth.message}`);
  assertOk(youtubeHealth.ok, `YouTube indisponivel: ${youtubeHealth.message}`);

  // Helper skip (A5/A7): saltar limpo se providers reais não estão configurados.
  const skipReason = await maybeSkipWithoutKeys({
    requireTTS: false, // já garantido pelos asserts acima
    requireVideoProviders: false,
    requireYoutube: false,
  });
  if (skipReason) {
    console.log(`⏭️ SKIP ${path.basename(__filename)}: ${skipReason}`);
    return;
  }

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

  await generateScript({
    videoId,
    topic,
    mockMode: false,
    targetDurationSeconds: 120,
  });

  const generatedState = await loadState(videoId);
  const generatedScript = String(generatedState.script_text || "");
  const normalizedScript = buildPublicationScript(generatedScript);
  const generatedScriptWords = countWords(generatedScript);
  const normalizedScriptWords = countWords(normalizedScript);

  await updateState(
    videoId,
    {
      script_text: normalizedScript,
      visual_plan: visualPlan,
      youtube_title: "Portugal em 2 minutos: Lisboa, Porto e Faro entre miradouros, Douro e gastronomia",
      youtube_description: "Fluxo privado E2E com roteiro, Gemini vision, Scene Index, Clip Library, render e upload no YouTube.",
      youtube_tags: ["portugal", "lisboa", "porto", "faro", "travel", "gastronomia", "faceless youtube"],
      script_generation_source: generatedScript ? "openai_seed_plus_editorial_normalization" : "editorial_only",
      generated_script_word_count: generatedScriptWords,
      normalized_script_word_count: normalizedScriptWords,
      approved: false,
      error_message: "",
    },
    {
      currentStep: "script_generated",
      status: "script_generated",
    }
  );

  const audio = await generateAudio({ videoId, mockMode: false, provider: "multivozes" });
  assertOk(audio.provider !== "mock", "Audio caiu em mock; esperado provider real.");

  const captions = await generateCaptions({ videoId, mockMode: false });
  const assets = await generateAssets({ videoId, mockMode: false, maxAssets: 10, minVideoDuration: 8 });
  const stateAfterAssets = await loadState(videoId);
  const approvedItems = Array.isArray(stateAfterAssets.assets_json?.approved_items)
    ? stateAfterAssets.assets_json.approved_items
    : [];
  const approvedWindows = Array.isArray(stateAfterAssets.assets_json?.approved_windows)
    ? stateAfterAssets.assets_json.approved_windows
    : [];
  const externalAssets = (assets.assets_json?.items || []).filter((item) => ["pexels", "pixabay"].includes(item.provider));
  const externalVideos = externalAssets.filter((item) => item.asset_type === "video");
  const analysisProviderCounts = countBy(approvedItems.map((item) => item.analysis_provider || "unknown"));
  const windowEvidenceSourceCounts = countBy(
    approvedWindows.map((window) => window.visual_evidence_source || window.analysis_provider || "unknown")
  );
  const geminiUsed = unique([
    ...Object.keys(analysisProviderCounts),
    ...Object.keys(windowEvidenceSourceCounts),
  ]).some((key) => String(key || "").toLowerCase().includes("gemini"));

  assertOk(geminiUsed, "Gemini nao apareceu como provider de analise visual neste run.");
  assertOk(externalVideos.length >= 6, "Fluxo trouxe poucos videos externos para um video detalhado.");
  assertOk(Number(stateAfterAssets.clip_library_summary?.clips_generated || 0) > 0, "Clip Library nao gerou microclips neste run.");
  const clipLibraryAuditAfterAssets = readClipLibraryAudit(videoId);
  assertOk(
    Number(clipLibraryAuditAfterAssets.with_semantic_summary || 0) > 0,
    "Clip Library nao persistiu semantic_summary nos microclips deste run."
  );

  await renderVideo({ videoId, mockMode: false });
  let actualValidation = await validateRender({ videoId, mockMode: false });
  if (actualValidation?.is_publishable !== true) {
    actualValidation = await fixRenderSync({ videoId, mockMode: false });
  }
  const stateAfterRender = await loadState(videoId);
  const renderInfo = await probeMedia(stateAfterRender.render_path).catch(() => ({}));
  const renderValidationFromRender = stateAfterRender.render_validation || actualValidation || {};
  const hardBoundaryFromTimeline = stateAfterRender.render_timeline?.hard_boundary_status || "unknown";
  const maxVisualLagFromTimeline = Number(stateAfterRender.render_timeline?.max_visual_lag_sec || 0);
  const finalHardBoundaryStatus = renderValidationFromRender.final_hard_boundary_status || renderValidationFromRender.hard_boundary_status || hardBoundaryFromTimeline;
  const publishableByRules = renderValidationFromRender.is_publishable === true
    && renderValidationFromRender.needs_regeneration !== true
    && renderValidationFromRender.needs_manual_review !== true
    && finalHardBoundaryStatus === "pass";
  const timelineClips = Array.isArray(stateAfterRender.render_timeline?.clips)
    ? stateAfterRender.render_timeline.clips
    : [];
  const timelineClipLibraryCount = timelineClips.filter((clip) => clip.from_clip_library === true).length;

  assertOk(Number(renderInfo.duration || 0) >= 90, "Render final ficou curto para o video detalhado.");
  assertOk(timelineClipLibraryCount > 0, "Timeline final nao consumiu clips da Clip Library.");
  assertOk(
    publishableByRules,
    `Render final reprovado pelo gate real: is_publishable=${renderValidationFromRender.is_publishable === true}, needs_regeneration=${renderValidationFromRender.needs_regeneration === true}, needs_manual_review=${renderValidationFromRender.needs_manual_review === true}, final_hard_boundary_status=${finalHardBoundaryStatus}`
  );

  await updateState(
    videoId,
    {
      approved: true,
      render_validation: {
        ...renderValidationFromRender,
        hard_boundary_status: renderValidationFromRender.hard_boundary_status || hardBoundaryFromTimeline,
        max_visual_lag_sec: Number(renderValidationFromRender.max_visual_lag_sec ?? maxVisualLagFromTimeline),
        actual_is_publishable: renderValidationFromRender.is_publishable === true,
        actual_hard_boundary_status: finalHardBoundaryStatus,
        actual_needs_regeneration: renderValidationFromRender.needs_regeneration === true,
        actual_needs_manual_review: renderValidationFromRender.needs_manual_review === true,
      },
      error_message: "",
    },
    {
      currentStep: "final_approved",
      status: "final_approved",
    }
  );

  const upload = await uploadToYoutube({
    videoId,
    mockMode: false,
    privacyStatus: "private",
  });

  const finalState = await loadState(videoId);
  const sceneIndexAudit = readSceneIndexAudit(videoId);
  const clipLibraryAudit = readClipLibraryAudit(videoId);
  const finalTimelineClips = Array.isArray(finalState.render_timeline?.clips) ? finalState.render_timeline.clips : [];
  const finalReport = {
    video_id: videoId,
    youtube_url: upload.youtube_url,
    youtube_video_id: upload.youtube_video_id,
    youtube_privacy_status: upload.youtube_privacy_status,
    youtube_caption_status: finalState.youtube_caption_status || upload.youtube_caption_status,
    topic,
    angle,
    generated_script_word_count: generatedScriptWords,
    normalized_script_word_count: normalizedScriptWords,
    script_generation_source: finalState.script_generation_source || "unknown",
    audio_provider: audio.provider,
    audio_voice: audio.voice,
    captions_provider: captions.provider,
    external_assets: externalAssets.length,
    external_videos: externalVideos.length,
    analysis_provider_counts: analysisProviderCounts,
    window_evidence_source_counts: windowEvidenceSourceCounts,
    gemini_used_in_asset_analysis: geminiUsed,
    scene_index_audit: sceneIndexAudit,
    clip_library_summary: finalState.clip_library_summary || finalState.assets_json?.clip_library || {},
    clip_library_audit: clipLibraryAudit,
    render_resolution: finalState.render_timeline?.output_resolution,
    render_duration_seconds: finalState.render_timeline?.output_duration_seconds,
    total_timeline_clips: finalTimelineClips.length,
    timeline_clip_library_clips: finalTimelineClips.filter((clip) => clip.from_clip_library === true).length,
    unique_timeline_assets: finalState.render_timeline?.unique_asset_count,
    actual_render_validation: renderValidationFromRender,
    publish_override_profile: finalState.render_validation?.qa_runtime_profile || "unknown",
    report_path: reportPath,
  };

  await fs.writeJson(reportPath, finalReport, { spaces: 2 });
  console.log(JSON.stringify(finalReport, null, 2));
};

run().catch((error) => {
  console.error("youtube-private-gemini-travel-e2e-failed", error.stack || error.message);
  process.exit(1);
});
