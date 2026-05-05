const { updateState, loadState } = require("../src/services/stateService");
const { generateScript } = require("../src/services/scriptService");
const { generateAudio } = require("../src/services/ttsService");
const { generateAssets } = require("../src/services/assetsService");
const { renderVideo } = require("../src/services/renderService");
const { uploadToYoutube } = require("../src/services/youtubeService");
const { probeMedia } = require("../src/utils/mediaUtils");

const assert = (condition, message) => {
  if (condition) throw new Error(message);
};

const topic = "Portugal gastronómico: Lisboa, Porto, mercados e vinhos";
const angle = "guia narrativo focado em comida local, mercados, cafes e vinhos";

const visualPlan = [
  {
    scene_index: 1,
    title: "Portugal em sabores",
    narration_excerpt: "Portugal abre o roteiro com uma promessa simples: viajar pelo país através dos mercados, cafés, pratos e vinhos.",
    keywords: ["portugal food travel", "portugal market", "travel overview", "portugal cafe", "food journey"],
    target_duration_seconds: 8,
  },
  {
    scene_index: 2,
    title: "Lisboa gastronómica",
    narration_excerpt: "Em Lisboa, confeitarias, cafés históricos e mercados dão o tom da primeira grande parada do vídeo.",
    keywords: ["lisbon food market", "lisbon pastry", "lisbon cafe", "portugal bakery", "lisbon street food"],
    target_duration_seconds: 8,
  },
  {
    scene_index: 3,
    title: "Porto gastronómico",
    narration_excerpt: "No Porto, a narrativa muda para caves, vinho do Porto, restaurantes junto ao Douro e comida mais densa.",
    keywords: ["porto wine cellar", "porto food market", "porto restaurant", "douro food", "porto gastronomy"],
    target_duration_seconds: 8,
  },
  {
    scene_index: 4,
    title: "Mercados e comida local",
    narration_excerpt: "Mercados, bancas, pratos servidos na hora e cenas de rua humanizam a montagem e trazem textura ao roteiro.",
    keywords: ["portugal food market", "street market food", "local dishes", "food hall portugal", "market people"],
    target_duration_seconds: 8,
  },
  {
    scene_index: 5,
    title: "Vinhos e doçaria",
    narration_excerpt: "Vinho, pastelaria, sobremesas e cafés fecham a viagem com um bloco visual mais específico e memorável.",
    keywords: ["portugal wine tasting", "portugal pastry", "bakery dessert", "cafe dessert", "sweet food portugal"],
    target_duration_seconds: 8,
  },
  {
    scene_index: 6,
    title: "Fechamento",
    narration_excerpt: "No final, o vídeo resume por que Portugal funciona tão bem quando a narrativa segue o ritmo dos sabores e das cidades.",
    keywords: ["portugal travel closing", "food montage", "city food summary", "portugal cafe closing", "travel lifestyle"],
    target_duration_seconds: 8,
  },
];

const scriptText = [
  "Portugal é um país que funciona muito bem quando o roteiro segue comida, cidade e atmosfera no tempo certo da narração.",
  "A abertura precisa vender essa promessa com imagens que pareçam uma viagem de sabores, não uma sequência aleatória de paisagens.",
  "Lisboa entra primeiro com cafés históricos, vitrines de pastelaria, mercados e cenas de rua onde a comida aparece como parte da cidade.",
  "Depois o Porto muda a energia com caves, vinho do Porto, restaurantes perto do Douro e planos mais densos de gastronomia local.",
  "No meio do vídeo, os mercados e os pratos servidos na hora ajudam a humanizar a narrativa e aproximam o espectador do cotidiano.",
  "Mais à frente, vinho, sobremesas, cafés e doçaria criam um bloco visual mais específico e memorável.",
  "A ideia deste teste é validar se a timeline acompanha exatamente o áudio e evita repetir costa, skyline ou cenas genéricas quando o texto fala de comida.",
  "Se a edição respeitar o tempo da fala e a ordem dos blocos, o resultado final deve parecer muito mais humano."
].join(" ");

const run = async () => {
  const videoId = `security_test_${Date.now()}`;

  console.log("🍷 Iniciando teste completo: Portugal gastronomia");

  // Configurar estado inicial
  await updateState(
    videoId,
    {
      topic,
      angle,
      selected_idea: { topic, angle },
      script_text: scriptText,
      visual_plan: visualPlan,
      youtube_title: "Portugal gastronómico: Lisboa, Porto, mercados e vinhos",
      youtube_description: "Uma viagem guiada por comida local, mercados, cafés históricos e vinhos em Portugal.",
      youtube_tags: ["portugal gastronomia", "lisboa comida", "porto vinho", "mercados portugal", "travel food"],
      approved: false,
      error_message: "",
    },
    {
      currentStep: "script_generated",
      status: "script_generated",
    }
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
    maxAssets: 5,
    minVideoDuration: 8
  });
  
  const externalAssets = (assets.assets_json?.items || []).filter((item) => ["pexels", "pixabay"].includes(item.provider));
  const externalVideoAssets = externalAssets.filter((item) => item.asset_type === "video");
  
  console.log(`📊 Assets disponíveis: ${externalAssets.length} totais, ${externalVideoAssets.length} vídeos`);

  // Renderizar vídeo
  console.log("🎥 Renderizando vídeo com algoritmo aprimorado...");
  await renderVideo({ videoId, mockMode: false });
  
  const stateAfterRender = await loadState(videoId);
  const renderInfo = await probeMedia(stateAfterRender.render_path);
  
  console.log(`✅ Render concluído: ${renderInfo.duration}s @ ${renderInfo.width}x${renderInfo.height}`);

  // Aprovar para upload
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

  // Upload para YouTube
  console.log("📤 Fazendo upload para YouTube...");
  const upload = await uploadToYoutube({
    videoId,
    mockMode: false,
    privacyStatus: "private",
  });

  const finalState = await loadState(videoId);

  console.log("🎉 FLUXO COMPLETO FINALIZADO!");
  console.log("📊 Estatísticas Finais:");
  console.log(JSON.stringify({
    video_id: videoId,
    youtube_url: upload.youtube_url,
    youtube_video_id: upload.youtube_video_id,
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
    variety_score: ((finalState.render_timeline?.unique_asset_count || 0) / (finalState.render_timeline?.total_clips || 1) * 100).toFixed(1) + "%",
  }, null, 2));

  console.log("\n🔍 Análise Final:");
  console.log(`- Sync Score: ${finalState.render_timeline?.semantic_alignment_score_average || 'N/A'}`);
  console.log(`- Clips Low Confidence: ${finalState.render_timeline?.low_confidence_clip_count || 0}`);
  console.log(`- Variedade de Assets: ${finalState.render_timeline?.unique_asset_count || 0}/${finalState.render_timeline?.total_clips || 0}`);
  console.log(`- Duração: ${finalState.render_timeline?.output_duration_seconds || 0}s`);
  console.log(`- YouTube: ${upload.youtube_url}`);
};

run().catch((error) => {
  console.error("❌ Falha no teste completo:", error.message);
  console.error(error.stack);
  process.exit(1);
});
