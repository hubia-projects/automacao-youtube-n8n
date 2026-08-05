/**
 * E2E smoke test para um vídeo curto (~5 minutos) focado em Lisboa.
 *
 * Como executar:
 *   cd pipeline
 *   node tests/e2e-5min-portugal-test.js
 *
 * Variáveis de ambiente relevantes (opcionais):
 *   PEXELS_API_KEY, PIXABAY_API_KEY, OPENAI_API_KEY, MULTIVOZES_BR_BASE_URL
 *   MIN_VIDEO_DURATION_SECONDS (default 240)
 *   MAX_VIDEO_DURATION_SECONDS (default 360)
 *   AUTO_APPROVE_FOR_TESTING=true
 *   DISABLE_GEMINI_GENERATION=true
 *
 * Se faltarem providers (apis de imagem/TTS), o test corre em modo mock para
 * validar a estrutura do pipeline. Em modo real, exige que o vídeo chegue aos
 * 240-360 segundos sem repetir clips nem desalinhar do áudio.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "info";
process.env.MIN_VIDEO_DURATION_SECONDS = process.env.MIN_VIDEO_DURATION_SECONDS || "240";
process.env.MAX_VIDEO_DURATION_SECONDS = process.env.MAX_VIDEO_DURATION_SECONDS || "360";
process.env.AUTO_APPROVE_FOR_TESTING = process.env.AUTO_APPROVE_FOR_TESTING || "true";
process.env.DISABLE_GEMINI_GENERATION = process.env.DISABLE_GEMINI_GENERATION || "true";
process.env.YOUTUBE_DEFAULT_PRIVACY = process.env.YOUTUBE_DEFAULT_PRIVACY || "private";
process.env.LOCAL_VIDEO_UNDERSTANDING_ENABLED = process.env.LOCAL_VIDEO_UNDERSTANDING_ENABLED || "false";
process.env.SEMANTIC_SYNC_MODE = process.env.SEMANTIC_SYNC_MODE || "cost-efficient";
process.env.USE_CLIP_LIBRARY = process.env.USE_CLIP_LIBRARY || "true";
process.env.USE_SCENE_INDEX = process.env.USE_SCENE_INDEX || "true";

const fs = require("fs-extra");
const path = require("path");
const { updateState, loadState } = require("../src/services/stateService");
const { generateAudio } = require("../src/services/ttsService");
const { generateAssets, basicPexelsHealthcheck, basicPixabayHealthcheck } = require("../src/services/assetsService");
const { renderVideo } = require("../src/services/renderService");
const { probeMedia } = require("../src/utils/mediaUtils");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const TOPIC = "3 ruas históricas de Lisboa em 5 minutos: Alfama, Bairro Alto e Chiado";
const ANGLE = "roteiro faceless curto com prova visual distinta por bairro e gastronomia local";
const MIN_SECONDS = Number(process.env.MIN_VIDEO_DURATION_SECONDS || 240);
const MAX_SECONDS = Number(process.env.MAX_VIDEO_DURATION_SECONDS || 360);

const SCRIPT_TEXT = [
  "Hoje atravessamos três bairros históricos de Lisboa para mostrar como cada rua conta uma Lisboa diferente em identidade visual, ritmo e detalhe.",
  "Começamos em Alfama, o bairro mais antigo, onde as ruas inclinadas, os azulejos, varandas de ferro e a proximidade do Tejo criam uma entrada cinematográfica da cidade.",
  "Aqui o áudio funciona melhor quando os planos descem do Castelo de São Jorge até à Sé, passando por escadinhas, pequenos miradouros e moradores que mantêm o bairro vivo.",
  "Depois caminhamos para o Bairro Alto, onde a noite muda completamente a leitura do mesmo roteiro, com elétricos vibrantes, fachadas pombalinas e uma energia jovem que se vê nas ruas.",
  "A melhor imagem do Bairro Alto vem quando juntamos o miradouro de São Pedro de Alcântara, a Praça Luís de Camões e os bares históricos com fachada tradicional, sempre a ouvir o elétrico a passar mesmo quando ainda não aparece no enquadramento.",
  "Por fim chegamos ao Chiado, onde os cafés clássicos, as livrarias centenárias e a arquitetura do século XIX dão um ritmo mais contido à narrativa.",
  "Aqui o ponto de prova são cafés como o Brasileira, fachadas do Teatro Nacional e a visão da estátua de Fernando Pessoa como corte de payoff cultural, sem pressa porque o bairro lê-se devagar.",
  "Para fechar, comparamos os três bairros em paralelo: Alfama pelo peso histórico, Bairro Alto pela vida noturna urbana, e Chiado pela leitura intelectual mais pausada, e percebemos porque os lisboetas trocam de bairro consoante a hora do dia.",
  "Esse é o eixo do vídeo: três ruas portuguesas, três identidades visuais diferentes e um único destino — Lisboa — contado por quem anda, não por quem voa sobre.",
  "Se este passeio te ajudou a decidir por onde começar o próximo roteiro por Lisboa, guarda o vídeo, partilha com quem vai viajar contigo e subscreve o canal para mais roteiros assim.",
].join(" ");

const VISUAL_PLAN = [
  {
    scene_index: 1,
    title: "Abertura: Lisboa em três ruas",
    visual_intent: "generic_travel",
    narration_excerpt:
      "Hoje atravessamos três bairros históricos de Lisboa para mostrar como cada rua conta uma Lisboa diferente em identidade visual, ritmo e detalhe.",
    keywords: ["lisbon aerial", "portugal skyline", "lisbon travel opener"],
    target_duration_seconds: 14,
    location: { city: "Lisboa", country: "Portugal", confidence: 0.95, source: "manual_e2e" },
  },
  {
    scene_index: 2,
    title: "Alfama: ruas inclinadas e Tejo",
    visual_intent: "city_landmark",
    narration_excerpt:
      "Começamos em Alfama, o bairro mais antigo, onde as ruas inclinadas, os azulejos, varandas de ferro e a proximidade do Tejo criam uma entrada cinematográfica.",
    keywords: ["alfama lisbon", "lisbon tram", "sao jorge castle lisbon", "lisbon old town"],
    target_duration_seconds: 95,
    location: { city: "Lisboa", country: "Portugal", confidence: 0.95, source: "manual_e2e" },
  },
  {
    scene_index: 3,
    title: "Bairro Alto: noite e elétricos",
    visual_intent: "city_landmark",
    narration_excerpt:
      "Depois caminhamos para o Bairro Alto, onde a noite muda completamente a leitura do mesmo roteiro, com elétricos vibrantes, fachadas pombalinas e uma energia jovem.",
    keywords: ["bairro alto lisbon", "lisbon tram 28", "lisbon nightlife", "sao pedro de alcantara viewpoint"],
    target_duration_seconds: 95,
    location: { city: "Lisboa", country: "Portugal", confidence: 0.95, source: "manual_e2e" },
  },
  {
    scene_index: 4,
    title: "Chiado: cafés e livrarias",
    visual_intent: "city_landmark",
    narration_excerpt:
      "Por fim chegamos ao Chiado, onde os cafés clássicos, as livrarias centenárias e a arquitetura do século XIX dão um ritmo mais contido à narrativa.",
    keywords: ["chiado lisbon", "brazilian cafe lisbon", "lisbon old bookshops", "pessoa statue lisbon"],
    target_duration_seconds: 90,
    location: { city: "Lisboa", country: "Portugal", confidence: 0.95, source: "manual_e2e" },
  },
  {
    scene_index: 5,
    title: "Fechamento comparativo das três ruas",
    visual_intent: "generic_travel",
    narration_excerpt:
      "Comparamos os três bairros em paralelo: Alfama pelo peso histórico, Bairro Alto pela vida noturna urbana, e Chiado pela leitura intelectual mais pausada.",
    keywords: ["lisbon travel outro", "lisbon summary", "portugal cinematic"],
    target_duration_seconds: 30,
    location: { city: "Lisboa", country: "Portugal", confidence: 0.8, source: "manual_e2e" },
  },
];

const detectMockMode = () => {
  const hasRealImageProvider = Boolean(process.env.PEXELS_API_KEY || process.env.PIXABAY_API_KEY);
  const hasRealTtsProvider = Boolean(
    process.env.MULTIVOZES_BR_BASE_URL
    || process.env.ELEVENLABS_API_KEY
    || process.env.OPENAI_API_KEY
  );
  const hasRealScriptLLM = Boolean(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
  return !(hasRealImageProvider && hasRealTtsProvider && hasRealScriptLLM);
};

const run = async () => {
  const mockMode = detectMockMode();
  const videoId = `e2e_5min_lisbon_${Date.now()}`;

  console.log(`[e2e-5min-portugal] mockMode=${mockMode} videoId=${videoId}`);
  console.log(`[e2e-5min-portugal] duration window: ${MIN_SECONDS}-${MAX_SECONDS}s`);
  console.log(`[e2e-5min-portugal] topic: ${TOPIC}`);

  await updateState(
    videoId,
    {
      topic: TOPIC,
      angle: ANGLE,
      selected_idea: { topic: TOPIC, angle: ANGLE },
      script_text: SCRIPT_TEXT,
      visual_plan: VISUAL_PLAN,
      youtube_title: "3 Ruas de Lisboa em 5 minutos: Alfama, Bairro Alto e Chiado (teste E2E 5min)",
      youtube_description:
        "Smoke test E2E privado de 5 minutos com Alfama, Bairro Alto e Chiado em Lisboa, validando pipeline, sincronia áudio↔visual, dedup visual e regras de hard boundary.",
      youtube_tags: ["lisboa", "alfama", "bairro alto", "chiado", "portugal", "faceless youtube", "test"],
      approved: false,
      error_message: "",
      target_duration_seconds: 300,
    },
    { currentStep: "script_generated", status: "script_generated" }
  );

  if (!mockMode) {
    try {
      const [pexelsHealth, pixabayHealth] = await Promise.all([
        basicPexelsHealthcheck(),
        basicPixabayHealthcheck(),
      ]);
      console.log(
        `[health] pexels=${pexelsHealth.ok ? "ok" : "down"} pixabay=${pixabayHealth.ok ? "ok" : "down"}`
      );
    } catch (error) {
      console.warn(`[health] skip: ${error.message}`);
    }
  }

  try {
    const audio = await generateAudio({ videoId, mockMode });
    console.log(
      `[audio] provider=${audio.provider} duration=${Math.round(audio.duration_seconds || 0)}s voice=${audio.voice || "unknown"}`
    );
  } catch (error) {
    console.warn(`[audio] step skipped ou falhou: ${error.message}`);
  }

  const assets = await generateAssets({ videoId, mockMode, maxAssets: 4 });
  const assetItems = assets.assets_json?.items || [];
  console.log(
    `[assets] total=${assetItems.length} videos=${assetItems.filter((a) => a.asset_type === "video").length}`
  );

  await renderVideo({ videoId, mockMode });
  const stateAfterRender = await loadState(videoId);
  const renderInfo = await probeMedia(stateAfterRender.render_path).catch(() => ({}));
  const ffprobeDuration = Number(renderInfo.duration || 0);
  const timeline = stateAfterRender.render_timeline || {};
  const clips = Array.isArray(timeline.clips) ? timeline.clips : [];
  const totalClips = Number(timeline.total_clips || clips.length);
  const uniqueAssets = Number(timeline.unique_asset_count || 0);
  const dedupRatio = totalClips > 0 ? uniqueAssets / totalClips : 0;
  const maxLag = Number(timeline.max_visual_lag_sec || 0);
  const hardBoundary = String(timeline.hard_boundary_status || "unknown");
  const placeholderFallbacks = clips.filter((clip) => clip.neutral_fallback || clip.clip_script_source === "scene_fallback").length;

  const report = {
    video_id: videoId,
    mock_mode: mockMode,
    render_path: stateAfterRender.render_path,
    ffprobe_duration: round3(ffprobeDuration),
    timeline_output_duration_seconds: round3(Number(timeline.output_duration_seconds || 0)),
    render_strategy: timeline.strategy || "unknown",
    output_resolution: timeline.output_resolution || "",
    total_clips: totalClips,
    unique_assets: uniqueAssets,
    dedup_ratio: round3(dedupRatio),
    max_visual_lag_sec: round3(maxLag),
    hard_boundary_status: hardBoundary,
    placeholder_fallback_clips: placeholderFallbacks,
  };

  console.log(JSON.stringify(report, null, 2));
  const reportPath = path.join(config.TEST_REPORTS_ROOT, `${videoId}-summary.json`);
  await fs.ensureDir(path.dirname(reportPath));
  await fs.writeJson(reportPath, report, { spaces: 2 });

  if (!mockMode) {
    assert(
      ffprobeDuration >= MIN_SECONDS && ffprobeDuration <= MAX_SECONDS,
      `Render fora do intervalo ${MIN_SECONDS}-${MAX_SECONDS}s: ffprobe=${ffprobeDuration}s timeline=${report.timeline_output_duration_seconds}s`
    );
    assert(dedupRatio >= 0.8, `Dedup ratio baixo: ${dedupRatio} (unique=${uniqueAssets} total=${totalClips})`);
    assert(maxLag <= 0.5, `max_visual_lag_sec > 0.5: ${maxLag}`);
    assert(hardBoundary === "pass", `hard_boundary_status diferente de 'pass': ${hardBoundary}`);
    console.log("✅ e2e-5min-portugal concluído em modo REAL com asserts OK.");
  } else {
    console.log("ℹ️ e2e-5min-portugal correu em MOCK_MODE. Para validar asserts strict, configure providers reais:");
    console.log("   PEXELS_API_KEY, PIXABAY_API_KEY, OPENAI_API_KEY, MULTIVOZES_BR_BASE_URL.");
    console.log("   Em modo mock, asserts strict (240-360s, dedup 0.8, lag 0.5) ficam desligados.");
  }
};

const round3 = (value) => Number(Number(value || 0).toFixed(3));

run().catch((error) => {
  console.error("❌ e2e-5min-portugal falhou:", error.stack || error.message);
  process.exit(1);
});
