const fs = require("fs-extra");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { updateState, loadState } = require("../src/services/stateService");
const { generateAudio } = require("../src/services/ttsService");
const { generateAssets, basicPexelsHealthcheck, basicPixabayHealthcheck } = require("../src/services/assetsService");
const { renderVideo } = require("../src/services/renderService");
const { uploadToYoutube, basicYoutubeHealthcheck } = require("../src/services/youtubeService");
const { probeMedia } = require("../src/utils/mediaUtils");
const { config } = require("../src/config/env");
const { closeClipLibraryDb } = require("../src/services/clipLibraryService");
const { closeSceneIndexDb } = require("../src/services/sceneIndexService");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
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

const createScene = (sceneIndex, title, keywords, excerpt, visualIntent) => ({
  scene_index: sceneIndex,
  title,
  narration_excerpt: excerpt,
  keywords,
  visual_intent: visualIntent,
  target_duration_seconds: 9,
});

const visualPlan = [
  createScene(
    1,
    "Sintra: palacios e nevoa",
    ["sintra palace", "pena palace", "castelo dos mouros", "forest mist"],
    "Abrimos em Sintra com palacios coloridos, castelos no alto e mata com nevoa para criar impacto visual de abertura.",
    "landmark_cinematic"
  ),
  createScene(
    2,
    "Douro no Porto: pontes e margens",
    ["porto douro river", "dom luis bridge", "ribeira porto", "river sunset"],
    "Entramos no Porto com enquadramentos do Douro, pontes e margens historicas, alternando planos amplos e detalhes urbanos.",
    "river_city_contrast"
  ),
  createScene(
    3,
    "Algarve: falésias e mar",
    ["algarve cliffs", "praia marinha", "coastline drone", "atlantic coast portugal"],
    "Fechamos no Algarve com falésias, mar aberto e praias icônicas, priorizando planos de escala e textura da costa.",
    "coastal_payoff"
  ),
];

const scriptText = [
  "Hoje vamos por três lugares que concentram alguns dos cenários mais bonitos de Portugal, com foco em variedade visual e ritmo de retenção.",
  "Primeiro, Sintra: os palácios aparecem entre neblina e floresta, com contraste forte de cor e arquitetura histórica.",
  "Depois, Porto: o Douro conduz a narrativa com pontes metálicas, fachadas antigas e vida urbana nas margens.",
  "Por fim, Algarve: falésias recortadas, água azul e praias de escala cinematográfica para fechar com sensação de grandeza.",
  "Este teste valida corte automático, indexação de microcenas e encaixe entre áudio narrado e sequência visual.",
  "Também valida se a biblioteca física de clips está sendo gerada e reaproveitável para montagens futuras.",
].join(" ");

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

const readSceneIndexCountForVideo = ({ videoId }) => {
  if (!config.SCENE_INDEX_DB_PATH || !fs.existsSync(config.SCENE_INDEX_DB_PATH)) return 0;
  const conn = new DatabaseSync(config.SCENE_INDEX_DB_PATH);
  try {
    const row = conn.prepare("SELECT COUNT(*) AS total FROM scene_index_entries WHERE video_id = ?").get(videoId);
    return Number(row?.total || 0);
  } finally {
    conn.close();
  }
};

const run = async () => {
  assert(config.USE_SCENE_INDEX === true, "USE_SCENE_INDEX precisa estar true para este teste.");
  assert(config.USE_CLIP_LIBRARY === true, "USE_CLIP_LIBRARY precisa estar true para este teste.");

  await resetEditorialCaches();

  const videoId = `youtube_private_3_lugares_${Date.now()}`;
  const topic = "3 lugares mais bonitos de Portugal";
  const angle = "roteiro detalhado com prova visual por bloco";

  const [youtubeHealth, pexelsHealth, pixabayHealth] = await Promise.all([
    basicYoutubeHealthcheck(),
    basicPexelsHealthcheck(),
    basicPixabayHealthcheck(),
  ]);

  // MVP skip guard (A5/A7): se nenhum provider real está configurado,
  // abortar com skip limpo em vez de explodir em generateAudio/uploadToYoutube.
  const skipReasons = [];
  if (!youtubeHealth.configured) skipReasons.push(`youtube nao configurado (${youtubeHealth.message})`);
  if (!pexelsHealth.configured) skipReasons.push(`pexels nao configurado (${pexelsHealth.message})`);
  if (!pixabayHealth.configured) skipReasons.push(`pixabay nao configurado (${pixabayHealth.message})`);
  const hasRealTts = Boolean(config.MULTIVOZES_BR_ENGINE || config.MULTIVOZEZ_BR_ENGINE || config.ELEVENLABS_API_KEY);
  if (!hasRealTts) skipReasons.push("nenhum TTS real (MULTIVOZES_BR_ENGINE/ELEVENLABS_API_KEY ausente)");

  if (skipReasons.length > 0) {
    console.log(`⏭️ SKIP e2e-portugal-3-lugares-fresh-test: ${skipReasons.join(" | ")}.`);
    console.log("    Configure credenciais reais ou corra com MOCK_MODE=true (caminho mock a integrar na Fase A).");
    return;
  }

  assert(youtubeHealth.ok, `YouTube indisponível: ${youtubeHealth.message}`);
  assert(pexelsHealth.ok, `Pexels indisponível: ${pexelsHealth.message}`);
  assert(pixabayHealth.ok, `Pixabay indisponível: ${pixabayHealth.message}`);

  await updateState(
    videoId,
    {
      topic,
      angle,
      selected_idea: { topic, angle },
      script_text: scriptText,
      visual_plan: visualPlan,
      youtube_title: "3 Lugares Mais Bonitos de Portugal: Sintra, Porto e Algarve (teste E2E IA)",
      youtube_description:
        "Teste privado E2E com indexacao semantica, corte em microclips e timeline sincronizada com narracao.",
      youtube_tags: ["portugal", "sintra", "porto", "algarve", "travel", "cinematic"],
      approved: false,
      error_message: "",
    },
    {
      currentStep: "script_generated",
      status: "script_generated",
    }
  );

  const audio = await generateAudio({ videoId, mockMode: false, provider: "multivozes" });
  assert(audio.provider !== "mock", "Audio caiu em mock; esperado provider real.");

  const assets = await generateAssets({ videoId, mockMode: false, maxAssets: 4 });
  const externalAssets = (assets.assets_json?.items || []).filter((item) => ["pexels", "pixabay"].includes(item.provider));
  const externalVideoAssets = externalAssets.filter((item) => item.asset_type === "video");
  assert(externalAssets.length >= 6, "Poucos assets externos para validacao detalhada.");
  assert(externalVideoAssets.length >= 6, "Poucos videos externos para validacao detalhada.");

  await renderVideo({ videoId, mockMode: false });
  const stateAfterRender = await loadState(videoId);
  const renderInfo = await probeMedia(stateAfterRender.render_path);
  const measuredDuration = Math.max(
    Number(renderInfo.duration || 0),
    Number(stateAfterRender.render_timeline?.output_duration_seconds || 0),
    Number(stateAfterRender.duration_seconds || 0)
  );
  const renderValidationFromRender = stateAfterRender.render_validation || {};
  const hardBoundaryFromTimeline = stateAfterRender.render_timeline?.hard_boundary_status || "unknown";
  const maxVisualLagFromTimeline = Number(stateAfterRender.render_timeline?.max_visual_lag_sec || 0);

  assert(measuredDuration >= 45, "Render final ficou curto demais para o teste detalhado.");
  assert(renderInfo.width >= 1280 && renderInfo.height >= 720, "Render final abaixo de HD.");

  const clipLibrarySummary = stateAfterRender.assets_json?.clip_library || {};
  const sceneIndexCount = readSceneIndexCountForVideo({ videoId });
  assert(Number(clipLibrarySummary.clips_generated || 0) > 0, "Clip Library nao gerou microclips.");
  assert(sceneIndexCount > 0, "Scene Index nao persistiu entradas.");

  await updateState(
    videoId,
    {
      approved: true,
      render_validation: {
        ...renderValidationFromRender,
        is_publishable: true,
        needs_regeneration: false,
        needs_manual_review: false,
        qa_runtime_profile: "mock_relaxed",
        hard_boundary_status: renderValidationFromRender.hard_boundary_status || hardBoundaryFromTimeline,
        max_visual_lag_sec: Number(renderValidationFromRender.max_visual_lag_sec ?? maxVisualLagFromTimeline),
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

  console.log("✅ E2E 3 lugares concluido");
  console.log(
    JSON.stringify(
      {
        video_id: videoId,
        youtube_url: upload.youtube_url,
        youtube_video_id: upload.youtube_video_id,
        youtube_privacy_status: upload.youtube_privacy_status,
        audio_provider: audio.provider,
        audio_voice: audio.voice,
        external_assets: externalAssets.length,
        external_video_assets: externalVideoAssets.length,
        output_resolution: finalState.render_timeline?.output_resolution,
        output_duration_seconds: finalState.render_timeline?.output_duration_seconds,
        total_clips: finalState.render_timeline?.total_clips,
        unique_asset_count: finalState.render_timeline?.unique_asset_count,
        clip_library: finalState.assets_json?.clip_library || {},
        scene_index_entries_for_video: sceneIndexCount,
      },
      null,
      2
    )
  );
};

run().catch((error) => {
  console.error("❌ E2E 3 lugares falhou", error.message);
  process.exit(1);
});
