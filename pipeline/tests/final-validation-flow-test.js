const fs = require("fs");
const path = require("path");
const { updateState, loadState } = require("../src/services/stateService");
const { generateScript } = require("../src/services/scriptService");
const { generateAudio } = require("../src/services/ttsService");
const { generateCaptions } = require("../src/services/captionsService");
const { generateAssets } = require("../src/services/assetsService");
const { renderVideo } = require("../src/services/renderService");
const { validateRender } = require("../src/services/syncValidator");
const { probeMedia } = require("../src/utils/mediaUtils");

const topic = "3 cidades mais bonitas de Portugal: Lisboa, Porto e Faro";
const angle = [
  "roteiro serio de estilo documental para video faceless com 5 blocos obrigatorios: Intro, Lisboa, Porto, Faro e Fechamento",
  "na narracao de cada cidade, separar claramente: 1) identidade da cidade e pontos mais bonitos, 2) experiencia local e gastronomia, 3) proposta visual cinematografica",
  "usar transicoes explicitas: 'Numero 1 Lisboa', 'Numero 2 Porto', 'Numero 3 Faro'",
  "incluir pontos fortes por cidade: Lisboa (Alfama, Belem, miradouros), Porto (Ribeira, Ponte Dom Luis I, caves de vinho), Faro (Cidade Velha, Ria Formosa, ilhas do Algarve)",
  "incluir gastronomia local de forma natural em cada cidade: Lisboa (pastel de nata, bacalhau a bras), Porto (francesinha, vinho do Porto), Faro (cataplana, ameijoas, peixe fresco)",
  "escrever em portugues do brasil com tom confiavel, informativo e pronto para publicacao real",
].join("; ");

const cityTerms = {
  lisboa: ["lisboa", "pastel de nata", "bacalhau a bras", "sardinha assada"],
  porto: ["porto", "francesinha", "tripas", "vinho do porto"],
  faro: ["faro", "cataplana", "ameijoas", "algarve"],
};

const MOCK_SCRIPT_SIGNATURES = [
  "se você quer viajar melhor e gastar menos",
  "panorama prático",
  "top pontos imperdíveis",
  "obrigado por assistir. comente qual destino você quer ver no próximo vídeo",
];

const normalize = (value = "") => String(value || "").trim().toLowerCase();
const sameCity = (left = "", right = "") => normalize(left) === normalize(right);

const splitSentences = (text = "") =>
  String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

const pickSentences = ({ sentences = [], terms = [], limit = 3 }) => {
  const matched = [];

  for (const sentence of sentences) {
    const normalized = normalize(sentence);
    if (terms.some((term) => normalized.includes(normalize(term)))) {
      matched.push(sentence);
      if (matched.length >= limit) break;
    }
  }

  return matched;
};

const uniq = (values = []) => [...new Set(values.filter(Boolean))];

const isMockScript = (scriptText = "") => {
  const normalized = normalize(scriptText);
  return MOCK_SCRIPT_SIGNATURES.some((signature) => normalized.includes(signature));
};

const sanitizeOpenAiHook = (text = "") =>
  String(text || "")
    .replace(/\[.*?\]/g, "")
    .replace(/^\s*\d{2}:\d{2}\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

const buildValidationScript = (openAiScript = "") => {
  const openAiHookRaw = splitSentences(openAiScript)[0] || "Portugal pode te surpreender em cada esquina, do Tejo ao Algarve.";
  const openAiHook = sanitizeOpenAiHook(openAiHookRaw) || "Portugal pode te surpreender em cada esquina, do Tejo ao Algarve.";

  return [
    `${openAiHook} Neste roteiro, voce vai conhecer tres cidades que representam o melhor do pais em historia, paisagem e experiencia local.`,
    "Numero 1 Lisboa.",
    "Lisboa mistura tradicao e energia contemporanea como poucas capitais europeias. Comece pela Alfama, caminhe pelas ruas de pedra e suba aos miradouros para ver o Tejo iluminando a cidade.",
    "No eixo de Belem, o roteiro ganha imponencia com a Torre de Belem e o Mosteiro dos Jeronimos. Visualmente, a cidade funciona em camadas: bondes amarelos, fachadas de azulejo, pracas abertas e fim de tarde dourado.",
    "Na gastronomia, Lisboa entrega identidade: pastel de nata saindo do forno, bacalhau a bras e sardinha assada em ambientes cheios de vida local.",
    "Numero 2 Porto.",
    "Porto e intensidade arquitetonica e cultural. A Ribeira, de frente para o Douro, oferece um dos cenarios urbanos mais fotogenicos de Portugal, com casarios coloridos, barcos tradicionais e pontes historicas.",
    "A Ponte Dom Luis I e as margens de Vila Nova de Gaia criam o momento visual mais emblematico da cidade, especialmente no por do sol. No ritmo da visita, entram livrarias historicas, igrejas revestidas de azulejo e ruas elegantes.",
    "No prato, Porto e memoravel: francesinha bem servida, restaurantes de cozinha regional e degustacoes nas caves de vinho do Porto.",
    "Numero 3 Faro.",
    "Faro abre um Portugal mais luminoso e natural, com o centro historico cercado por muralhas e uma atmosfera calma, ideal para quem busca beleza com autenticidade.",
    "Pela Cidade Velha, voce encontra o Arco da Vila, pracas intimistas e arquitetura tradicional. Na sequencia, a Ria Formosa assume o protagonismo com passeios de barco, ilhas de areia clara e agua em tons de azul que mudam ao longo do dia.",
    "A experiencia gastronomica de Faro e marcada por frutos do mar frescos: cataplana, ameijoas e peixe grelhado, sempre com foco em ingredientes locais.",
    "No fechamento, a comparacao e simples: cada cidade tem ritmo proprio e complementa as outras em uma viagem completa por Portugal.",
    "Com esse recorte, o roteiro fica equilibrado entre historia, paisagem, cultura local e experiencia de viagem real.",
  ].join(" ");
};

const buildForcedVisualPlan = () => [
  {
    scene_index: 1,
    title: "Intro",
    role: "intro",
    narration_excerpt: "Abertura cinematografica de viagem com proposta visual da jornada.",
    keywords: ["travel cinematic opening", "europe travel montage", "documentary intro scene"],
    target_duration_seconds: 10,
  },
  {
    scene_index: 2,
    title: "Lisboa",
    role: "body",
    narration_excerpt: "Numero 1 Lisboa com Alfama, Belem, miradouros e atmosfera urbana historica.",
    keywords: ["lisbon alfama old town", "belem tower lisbon", "lisbon viewpoint sunset", "lisbon tram historic street"],
    target_duration_seconds: 14,
  },
  {
    scene_index: 3,
    title: "Porto",
    role: "body",
    narration_excerpt: "Numero 2 Porto com Ribeira, Ponte Dom Luis I, Douro e arquitetura marcante.",
    keywords: ["porto ribeira waterfront", "dom luis bridge porto", "douro river porto", "porto historic center streets"],
    target_duration_seconds: 14,
  },
  {
    scene_index: 4,
    title: "Faro",
    role: "body",
    narration_excerpt: "Numero 3 Faro com Cidade Velha, Ria Formosa e ilhas do Algarve em luz natural.",
    keywords: ["faro old town", "ria formosa boat", "algarve islands aerial", "faro city walls arch"],
    target_duration_seconds: 14,
  },
  {
    scene_index: 5,
    title: "Fechamento",
    role: "outro",
    narration_excerpt: "Fechamento comparativo com recomendacao final por perfil de viagem.",
    keywords: ["travel summary ending", "destination comparison outro", "documentary closing scene"],
    target_duration_seconds: 10,
  },
];

const run = async () => {
  const videoId = `final_validation_${Date.now()}`;
  let openAiAttempts = 0;
  let openAiScriptSource = "openai";
  let openAiRawScriptText = "";

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
      currentStep: "script_generated",
      status: "script_generated",
    }
  );

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    openAiAttempts = attempt;
    await generateScript({
      videoId,
      topic,
      mockMode: false,
    });

    const scriptStateAttempt = await loadState(videoId);
    const candidateScript = scriptStateAttempt.script_text || "";
    if (candidateScript && !isMockScript(candidateScript)) {
      openAiRawScriptText = candidateScript;
      openAiScriptSource = "openai";
      break;
    }

    openAiRawScriptText = candidateScript;
    openAiScriptSource = "fallback";
  }

  const validationScript = buildValidationScript(openAiRawScriptText || "");

  await updateState(
    videoId,
    {
      script_text: validationScript,
      visual_plan: buildForcedVisualPlan(),
      script_generation_source: openAiScriptSource,
      script_generation_attempts: openAiAttempts,
      error_message: "",
    },
    {
      currentStep: "script_generated",
      status: "script_generated",
    }
  );

  const audio = await generateAudio({ videoId, mockMode: false, provider: "multivozes" });
  await generateCaptions({ videoId, mockMode: false });
  await generateAssets({ videoId, mockMode: false, maxAssets: 5, minVideoDuration: 8 });
  await renderVideo({ videoId, mockMode: false });
  const validation = await validateRender({ videoId, mockMode: false });
  const state = await loadState(videoId);
  const renderInfo = await probeMedia(state.render_path).catch(() => ({}));

  const clips = Array.isArray(state.render_timeline?.clips) ? state.render_timeline.clips : [];
  const overlays = Array.isArray(state.overlays) ? state.overlays : [];
  const blocks = Array.isArray(state.render_timeline?.narrative_blocks) ? state.render_timeline.narrative_blocks : [];
  const hardBoundaryReport = validation?.hard_boundary_report || state?.render_validation?.hard_boundary_report || { boundaries: [] };
  const boundaries = Array.isArray(hardBoundaryReport.boundaries) ? hardBoundaryReport.boundaries : [];

  const boundaryTable = boundaries.map((boundary, index) => {
    const boundarySec = Number(boundary.boundary_sec || 0);
    const firstClipStart = Number(boundary.first_clip_start_sec || boundarySec);
    const expectedTopic = String(boundary.expected_topic || "");
    const currentBlock = blocks[index + 1] || {};
    const previousBlock = blocks[index] || {};
    const previousTopic = previousBlock.topic || "";

    let previousExposure = 0;
    clips.forEach((clip) => {
      const start = Number(clip.timeline_start_sec || 0);
      const end = Number(clip.timeline_end_sec || 0);
      const overlapStart = Math.max(start, boundarySec);
      const overlapEnd = Math.min(end, Math.max(firstClipStart, boundarySec));
      if (overlapEnd <= overlapStart) return;
      const detectedCity = clip.detected_location?.city || "";
      if (previousTopic && detectedCity && sameCity(detectedCity, previousTopic)) {
        previousExposure += overlapEnd - overlapStart;
      }
    });

    const delay = Number(boundary.lag_sec || 0);
    const status = delay <= 0.5 && previousExposure <= 0.3 && String(boundary.status || "") === "pass" ? "PASS" : "FAIL";

    return {
      boundary_id: boundary.boundary_id || currentBlock.boundary_id || `boundary_${index + 1}`,
      boundary_label: `${previousTopic || "bloco_anterior"} -> ${expectedTopic || currentBlock.topic || "bloco_atual"}`,
      boundary_sec: Number(boundarySec.toFixed(3)),
      expected: expectedTopic || currentBlock.topic || "",
      first_correct_visual: boundary.first_clip_city || "",
      first_correct_visual_delay_sec: Number(delay.toFixed(3)),
      previous_block_exposure_after_boundary_sec: Number(previousExposure.toFixed(3)),
      status,
      first_clip_index: boundary.first_clip_index,
      first_clip_neutral: Boolean(boundary.first_clip_neutral),
      violations: boundary.violations || [],
    };
  });

  const overlayTable = blocks.map((block, index) => {
    const blockStart = Number(block.start_seconds ?? block.start_sec ?? 0);
    const matched = overlays.find((overlay) => {
      if (overlay.block_id && block.block_id && overlay.block_id === block.block_id) return true;
      if (overlay.block_id && block.id && overlay.block_id === block.id) return true;
      return Math.abs(Number(overlay.start_seconds || 0) - blockStart) <= 0.4;
    });

    return {
      block_index: index + 1,
      block: block.topic || block.label || `Bloco ${index + 1}`,
      expected_start_seconds: Number(blockStart.toFixed(3)),
      overlay_text: matched?.text || "",
      overlay_start_seconds: Number(Number(matched?.start_seconds || 0).toFixed(3)),
      overlay_type: matched?.type || "",
      status: matched ? "PASS" : "FAIL",
    };
  });

  const readiness = Array.isArray(state.assets_json?.scene_asset_readiness) ? state.assets_json.scene_asset_readiness : [];
  const readyScenes = readiness.filter((scene) => scene.ready === true).length;
  const missingScenes = readiness.filter((scene) => scene.ready === false).length;

  const summary = {
    video_id: videoId,
    mode: "real_hibrido",
    topic,
    angle,
    audio_provider: audio.provider,
    audio_voice: audio.voice,
    openai_script_source: openAiScriptSource,
    openai_attempts: openAiAttempts,
    openai_script_chars: Number((openAiRawScriptText || "").length),
    script_length_chars: Number((state.script_text || "").length),
    script_preview: (state.script_text || "").slice(0, 1200),
    render_path: state.render_path,
    state_path: state.state_path,
    output_duration_seconds: Number(state.render_timeline?.output_duration_seconds || renderInfo.duration || 0),
    output_resolution: `${renderInfo.width || 0}x${renderInfo.height || 0}`,
    render_validation: {
      is_publishable: Boolean(validation?.is_publishable),
      hard_boundary_status: validation?.hard_boundary_status || "unknown",
      max_visual_lag_sec: Number(validation?.max_visual_lag_sec || 0),
      needs_regeneration: Boolean(validation?.needs_regeneration),
      needs_manual_review: Boolean(validation?.needs_manual_review),
      issues: validation?.issues || [],
    },
    boundary_transition_validation: boundaryTable,
    overlays: overlayTable,
    clips_count: clips.length,
    missing_assets: Boolean(state.assets_json?.missing_assets),
    needs_manual_review_state: Boolean(state.needs_manual_review),
    needs_manual_review_validation: Boolean(state.render_validation?.needs_manual_review),
    scene_readiness: {
      total_scenes: readiness.length,
      ready_scenes: readyScenes,
      missing_scenes: missingScenes,
      blocking_scene_indexes: state.assets_json?.blocking_scene_indexes || [],
    },
    first_city_checks: {
      lisboa_first_clip_city: (clips.find((clip) => Number(clip.scene_index || 0) === 2) || {}).detected_location?.city || "",
      porto_first_clip_city: (clips.find((clip) => Number(clip.scene_index || 0) === 3) || {}).detected_location?.city || "",
      faro_first_clip_city: (clips.find((clip) => Number(clip.scene_index || 0) === 4) || {}).detected_location?.city || "",
    },
  };

  const reportDir = path.join(process.cwd(), "test_reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${videoId}-summary.json`);
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2), "utf8");

  console.log(JSON.stringify({ ok: true, video_id: videoId, report_path: reportPath, summary }, null, 2));
};

run().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
