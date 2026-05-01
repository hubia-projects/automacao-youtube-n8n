const { updateState, loadState } = require("../src/services/stateService");
const { generateAudio } = require("../src/services/ttsService");
const { generateAssets, basicPexelsHealthcheck, basicPixabayHealthcheck } = require("../src/services/assetsService");
const { renderVideo } = require("../src/services/renderService");
const { uploadToYoutube, basicYoutubeHealthcheck } = require("../src/services/youtubeService");
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

const visualPlan = [
  createScene(1, "Lisboa e os miradouros", ["lisbon skyline", "miradouro", "city panorama"]),
  createScene(2, "Elétricos, azulejos e ruas", ["lisbon tram", "historic street", "tiles facade"]),
  createScene(3, "Porto e margens do Douro", ["porto portugal", "river view", "bridge aerial"]),
  createScene(4, "Sintra e cenários de filme", ["sintra palace", "castle view", "forest hill"]),
  createScene(5, "Litoral português", ["portugal coastline", "ocean cliffs", "beach aerial"]),
  createScene(6, "Mercados e gastronomia local", ["portugal market", "local food", "travel lifestyle"]),
];

const scriptText = [
  "Portugal continua sendo um dos destinos mais fortes para vídeos faceless porque entrega variedade visual o tempo todo.",
  "Em Lisboa, a combinação de miradouros, telhados, bondes amarelos e ruas estreitas cria um ritmo visual muito bom para a abertura do vídeo.",
  "Depois disso, o Porto muda completamente a atmosfera com o Douro, as pontes metálicas e as fachadas antigas refletindo na água.",
  "Sintra entra como bloco de fantasia, com palácios coloridos, neblina, mata e enquadramentos que parecem cinema de aventura.",
  "No litoral, o vídeo ganha respiro com falésias, mar aberto, praias e cenas mais amplas que aumentam a sensação de escala.",
  "Para fechar, mercados e pratos típicos ajudam a humanizar o destino e dão textura de cotidiano ao roteiro.",
  "A ideia deste teste é avaliar se a edição automática consegue alternar bem entre cidade, paisagem, arquitetura e lifestyle sem parecer um loop.",
  "Também queremos verificar se o vídeo final fica agradável no YouTube mesmo sendo um MVP montado com FFmpeg local e bancos de imagem gratuitos.",
  "Se essa versão privada ficar boa, ela serve como prova prática de que a pipeline já consegue produzir um primeiro corte consistente para revisão humana.",
].join(" ");

const run = async () => {
  const videoId = `youtube_private_${Date.now()}`;
  const topic = "Portugal travel";
  const angle = "guia visual com cidades, litoral e gastronomia";

  const [youtubeHealth, pexelsHealth, pixabayHealth] = await Promise.all([
    basicYoutubeHealthcheck(),
    basicPexelsHealthcheck(),
    basicPixabayHealthcheck(),
  ]);

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
      youtube_title: "Portugal em 2026: cidades, costa e comida em um corte visual automático",
      youtube_description:
        "Teste privado do MVP visual da pipeline. Este vídeo usa assets reais de Pexels/Pixabay, montagem automática com FFmpeg local e upload privado para validação.",
      youtube_tags: ["portugal", "travel", "lisboa", "porto", "sintra", "faceless youtube"],
      approved: false,
      error_message: "",
    },
    {
      currentStep: "script_generated",
      status: "script_generated",
    }
  );

  const audio = await generateAudio({ videoId, mockMode: false, provider: "multivozes" });
  assert(audio.provider !== "mock", "Áudio caiu em mock; esperado um provider real para avaliação no YouTube");

  const assets = await generateAssets({ videoId, mockMode: false, maxAssets: 3 });
  const externalAssets = (assets.assets_json?.items || []).filter((item) => ["pexels", "pixabay"].includes(item.provider));
  const externalVideoAssets = externalAssets.filter((item) => item.asset_type === "video");
  assert(externalAssets.length >= 4, "Busca real trouxe poucos assets externos para o upload privado");
  assert(externalVideoAssets.length >= 6, "Busca real ainda trouxe poucos vídeos externos para o upload privado");

  await renderVideo({ videoId, mockMode: false });
  const stateAfterRender = await loadState(videoId);
  const renderInfo = await probeMedia(stateAfterRender.render_path);

  assert(renderInfo.duration >= 30, "Render final ficou curto demais para avaliação");
  assert(renderInfo.width >= 1280 && renderInfo.height >= 720, "Render final ficou abaixo de HD");

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

  const upload = await uploadToYoutube({
    videoId,
    mockMode: false,
    privacyStatus: "private",
  });

  const finalState = await loadState(videoId);

  console.log("✅ Upload privado real concluído");
  console.log(
    JSON.stringify(
      {
        video_id: videoId,
        youtube_url: upload.youtube_url,
        youtube_video_id: upload.youtube_video_id,
        youtube_privacy_status: upload.youtube_privacy_status,
        youtube_caption_status: upload.youtube_caption_status,
        audio_provider: audio.provider,
        audio_voice: audio.voice,
        external_assets: externalAssets.length,
        external_video_assets: externalVideoAssets.length,
        total_clips: finalState.render_timeline?.total_clips,
        unique_asset_count: finalState.render_timeline?.unique_asset_count,
        output_resolution: finalState.render_timeline?.output_resolution,
        output_duration_seconds: finalState.render_timeline?.output_duration_seconds,
      },
      null,
      2
    )
  );
};

run().catch((error) => {
  console.error("❌ Upload privado real falhou", error.message);
  process.exit(1);
});