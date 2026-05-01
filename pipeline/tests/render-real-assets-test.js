const fs = require("fs-extra");
const { updateState, loadState } = require("../src/services/stateService");
const { generateAudio } = require("../src/services/ttsService");
const { generateAssets, basicPexelsHealthcheck, basicPixabayHealthcheck } = require("../src/services/assetsService");
const { renderVideo } = require("../src/services/renderService");
const { probeMedia } = require("../src/utils/mediaUtils");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const createScene = (sceneIndex, title, keywords) => ({
  scene_index: sceneIndex,
  title,
  narration_excerpt: `${title} com foco visual para travel video.`,
  keywords,
  target_duration_seconds: 6,
});

const createCuratedVisualPlan = () => [
  createScene(1, "Abertura em Lisboa", ["lisbon skyline", "aerial view", "city panorama"]),
  createScene(2, "Elétricos e ruas históricas", ["lisbon tram", "historic district", "street life"]),
  createScene(3, "Porto e rio Douro", ["porto portugal", "river view", "bridge aerial"]),
  createScene(4, "Sintra e palácios", ["sintra palace", "castle view", "scenic mountain"]),
  createScene(5, "Costa portuguesa", ["portugal coastline", "ocean cliffs", "beach aerial"]),
  createScene(6, "Mercados e gastronomia", ["portugal market", "local food", "travel lifestyle"]),
];

const createScriptText = () =>
  [
    "Portugal segue como um dos roteiros mais fortes para vídeos faceless de viagem por combinar cidade, história, paisagem e cenas de rua.",
    "Neste teste vamos cobrir Lisboa, Porto, Sintra, litoral e momentos de cotidiano para forçar múltiplas buscas visuais úteis.",
    "A ideia é validar um render automático com vários cortes, usando assets reais em alta resolução e sem cair no loop de um único vídeo.",
    "Também queremos garantir que o pipeline consegue misturar imagens e vídeos mantendo duração próxima de noventa e cinco segundos.",
    "Se a busca real funcionar bem, a timeline final deve mostrar diversidade visual, mais de um asset externo e resolução HD ou Full HD em todos os clips.",
  ].join(" ");

const assertHdResolution = (resolution, label) => {
  assert(resolution?.width >= 1280, `${label} sem largura HD mínima`);
  assert(resolution?.height >= 720, `${label} sem altura HD mínima`);
  assert(resolution?.width >= resolution?.height, `${label} não está em landscape`);
};

const countBy = (items, keyFn) =>
  items.reduce((accumulator, item) => {
    const key = keyFn(item);
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});

const run = async () => {
  const videoId = `real_assets_render_${Date.now()}`;
  const visualPlan = createCuratedVisualPlan();
  const topic = "Portugal travel";
  const angle = "guia visual com cidades, costa e cenas urbanas";

  const [pexelsHealth, pixabayHealth] = await Promise.all([
    basicPexelsHealthcheck(),
    basicPixabayHealthcheck(),
  ]);

  assert(pexelsHealth.ok, `Pexels indisponível: ${pexelsHealth.message}`);
  assert(pixabayHealth.ok, `Pixabay indisponível: ${pixabayHealth.message}`);

  await updateState(
    videoId,
    {
      topic,
      angle,
      selected_idea: { topic, angle },
      script_text: createScriptText(),
      visual_plan: visualPlan,
      approved: false,
      error_message: "",
    },
    {
      currentStep: "script_generated",
      status: "script_generated",
    }
  );

  await generateAudio({ videoId, mockMode: true, provider: "multivozes" });
  await generateAssets({ videoId, mockMode: false, maxAssets: 3 });
  await renderVideo({ videoId, mockMode: true });

  const state = await loadState(videoId);
  const assets = state.assets_json?.items || [];
  const clips = state.render_timeline?.clips || [];
  const externalAssets = assets.filter((item) => ["pexels", "pixabay"].includes(item.provider) && !item.is_fallback);
  const externalVideoAssets = externalAssets.filter((item) => item.asset_type === "video");
  const externalClips = clips.filter((clip) => ["pexels", "pixabay"].includes(clip.provider));
  const externalVideoClips = externalClips.filter((clip) => clip.asset_type === "video");
  const uniqueClipAssets = new Set(clips.map((clip) => clip.local_path).filter(Boolean));
  const renderInfo = await probeMedia(state.render_path);

  assert(Array.isArray(state.visual_plan) && state.visual_plan.length === visualPlan.length, "visual_plan curado não foi preservado no state");
  assert(assets.length >= visualPlan.length, "assets por cena insuficientes para o plano visual");
  assets.forEach((asset, index) => assertHdResolution(asset.resolution, `asset ${index + 1}`));
  assert(externalAssets.length >= 3, "busca real trouxe poucos assets externos; esperado pelo menos 3");
  assert(externalVideoAssets.length >= visualPlan.length, "busca real ainda trouxe poucos vídeos externos por cena");

  assert(Array.isArray(clips) && clips.length >= 12, "timeline final não gerou cortes suficientes para ~95s");
  assert(uniqueClipAssets.size > 1, "timeline ainda parece um loop único de asset");
  assert(externalClips.length >= 2, "timeline final não aproveitou assets externos suficientes");
  assert(externalVideoClips.length >= 10, "timeline final ainda não priorizou clipes de vídeo suficientes");
  assert(
    clips.every((clip) => Number(clip.clip_duration_seconds || 0) >= 3 && Number(clip.clip_duration_seconds || 0) <= 10),
    "timeline gerou clips fora da janela de 3 a 10 segundos"
  );
  assert(externalClips.every((clip) => clip.asset_type === "video"), "timeline ainda está usando imagem externa em vez de vídeo");
  clips.forEach((clip) => assertHdResolution(clip.resolution, `clip ${clip.clip_index}`));

  assert(state.render_path && (await fs.pathExists(state.render_path)), "final.mp4 não foi criado");
  assert(renderInfo.duration >= 90, "render final ficou abaixo de 90 segundos");
  assert(renderInfo.width >= 1280 && renderInfo.height >= 720, "render final ficou abaixo de HD");

  console.log("✅ Teste real de assets + render passou");
  console.log(
    JSON.stringify(
      {
        video_id: videoId,
        external_assets: externalAssets.length,
        external_video_assets: externalVideoAssets.length,
        fallback_assets: assets.filter((item) => item.is_fallback).length,
        providers: countBy(assets, (asset) => asset.provider),
        render_strategy: state.render_timeline?.strategy,
        output_duration_seconds: state.render_timeline?.output_duration_seconds,
        total_clips: state.render_timeline?.total_clips,
        external_clips: externalClips.length,
        external_video_clips: externalVideoClips.length,
        unique_clip_assets: uniqueClipAssets.size,
        output_resolution: state.render_timeline?.output_resolution,
      },
      null,
      2
    )
  );
};

run().catch((error) => {
  console.error("❌ Teste real de assets + render falhou", error.message);
  process.exit(1);
});