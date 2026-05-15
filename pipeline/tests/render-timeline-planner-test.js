const assert = require("assert");
const path = require("path");
const { __test__ } = require("../src/services/renderService");

const buildWindow = (windowIndex, startSeconds, endSeconds, summary, tags = [], confidence = 0.8) => ({
  window_index: windowIndex,
  start_seconds: startSeconds,
  end_seconds: endSeconds,
  summary,
  tags,
  confidence,
});

const buildMockWindows = (sceneIndex, variation, query = "") => {
  if (sceneIndex === 1) {
    return [
      buildWindow(1, 0, 9, "lisbon rooftops and miradouro skyline", ["lisbon", "rooftops", "miradouro"]),
      buildWindow(2, 9, 18, "historic lisbon street with yellow tram", ["lisbon", "tram", "street"]),
      buildWindow(3, 18, 28, "panoramic lisbon city view over red roofs", ["lisbon", "panorama", "rooftops"]),
    ];
  }

  if (sceneIndex === 3) {
    return [
      buildWindow(1, 0, 10, "porto douro riverfront with bridge", ["porto", "douro", "bridge"]),
      buildWindow(2, 10, 20, "historic porto facades by the water", ["porto", "facades", "waterfront"]),
      buildWindow(3, 20, 32, "wide river view with metal bridge and boats", ["river", "bridge", "boats"]),
    ];
  }

  if (sceneIndex === 4) {
    return [
      buildWindow(1, 0, 10, "sintra palace on the hill with forest", ["sintra", "palace", "forest"]),
      buildWindow(2, 10, 20, "castle walls in mist above trees", ["castle", "mist", "trees"]),
      buildWindow(3, 20, 32, "cinematic palace facade and woodland road", ["palace", "woodland", "road"]),
    ];
  }

  if (sceneIndex === 5) {
    return [
      buildWindow(1, 0, 10, "portugal coastline with cliffs and ocean", ["coastline", "cliffs", "ocean"]),
      buildWindow(2, 10, 20, "beach aerial with waves and open sea", ["beach", "waves", "sea"]),
      buildWindow(3, 20, 32, "wide coastal panorama with rocky shore", ["coastal", "panorama", "shore"]),
    ];
  }

  if (sceneIndex === 6) {
    return [
      buildWindow(1, 0, 10, "food market with people walking", ["market", "food", "people"]),
      buildWindow(2, 10, 20, "close shots of portuguese dishes and stalls", ["dishes", "stalls", "food"]),
      buildWindow(3, 20, 32, "lifestyle market scene with tables and produce", ["lifestyle", "produce", "market"]),
    ];
  }

  return [
    buildWindow(1, 0, 10, `${query} travel footage`, query.split(/\s+/).filter(Boolean).slice(0, 3)),
    buildWindow(2, 10, 20, `${query} scenic travel shot`, query.split(/\s+/).filter(Boolean).slice(0, 3)),
    buildWindow(3, 20, 32, `${query} destination panorama`, query.split(/\s+/).filter(Boolean).slice(0, 3)),
  ];
};

const buildAsset = (sceneIndex, variation, query = "") => ({
  scene_index: sceneIndex,
  provider: "mock",
  asset_type: "video",
  type: "video",
  local_path: path.join("C:\\", "mock", `scene-${sceneIndex}-${variation}.mp4`),
  source_duration_seconds: 24 + variation * 4,
  query,
  semantic_text: query,
  analysis_summary: query,
  analysis_tags: query.split(/\s+/).filter(Boolean).slice(0, 4),
  analysis_windows: buildMockWindows(sceneIndex, variation, query),
  resolution: {
    width: 1920,
    height: 1080,
    label: "Full HD",
  },
});

const createScene = (sceneIndex, title, keywords) => ({
  scene_index: sceneIndex,
  title,
  narration_excerpt: `${title} com foco visual para travel video.`,
  target_duration_seconds: 6,
  keywords,
});

const visualPlan = [
  createScene(1, "Lisboa e os miradouros", ["lisbon skyline", "miradouro", "city panorama"]),
  createScene(2, "Eletricos, azulejos e ruas", ["lisbon tram", "historic street", "tiles facade"]),
  createScene(3, "Porto e margens do Douro", ["porto portugal", "river view", "bridge aerial"]),
  createScene(4, "Sintra e cenarios de filme", ["sintra palace", "castle view", "forest hill"]),
  createScene(5, "Litoral portugues", ["portugal coastline", "ocean cliffs", "beach aerial"]),
  createScene(6, "Mercados e gastronomia local", ["portugal market", "local food", "travel lifestyle"]),
];

const assets = visualPlan.flatMap((scene) =>
  scene.keywords.map((query, variationIndex) => buildAsset(scene.scene_index, variationIndex + 1, query))
);

const state = {
  topic: "Portugal travel",
  script_text: [
    "Portugal continua sendo um dos destinos mais fortes para videos faceless porque entrega variedade visual o tempo todo.",
    "Em Lisboa, a combinacao de miradouros, telhados, bondes amarelos e ruas estreitas cria um ritmo visual muito bom para a abertura do video.",
    "Depois disso, o Porto muda completamente a atmosfera com o Douro, as pontes metalicas e as fachadas antigas refletindo na agua.",
    "Sintra entra como bloco de fantasia, com palacios coloridos, neblina, mata e enquadramentos que parecem cinema de aventura.",
    "No litoral, o video ganha respiro com falesias, mar aberto, praias e cenas mais amplas que aumentam a sensacao de escala.",
    "Para fechar, mercados e pratos tipicos ajudam a humanizar o destino e dao textura de cotidiano ao roteiro.",
    "A ideia deste teste e avaliar se a edicao automatica consegue alternar bem entre cidade, paisagem, arquitetura e lifestyle sem parecer um loop.",
    "Tambem queremos verificar se o video final fica agradavel no YouTube mesmo sendo um MVP montado com FFmpeg local e bancos de imagem gratuitos.",
    "Se essa versao privada ficar boa, ela serve como prova pratica de que a pipeline ja consegue produzir um primeiro corte consistente para revisao humana.",
  ].join(" "),
  visual_plan: visualPlan,
  assets_json: {
    items: assets,
  },
};

const fallbackAsset = buildAsset(0, 1);

const run = async () => {
  const planV1 = await __test__.buildClipPlan({
    state,
    audioDuration: 88,
    draftVersion: 1,
    fallbackAsset,
  });

  const planV2 = await __test__.buildClipPlan({
    state,
    audioDuration: 88,
    draftVersion: 2,
    fallbackAsset,
  });

  assert(planV1.length >= 12, "planner deveria gerar cortes suficientes para um roteiro longo");
  assert(planV1.every((clip) => clip.clip_duration_seconds >= 3 && clip.clip_duration_seconds <= 10), "duracoes sairam da faixa valida");
  assert(planV1.every((clip) => clip.asset.asset_type === "video"), "planner deveria priorizar assets de video quando eles existem");
  assert(planV1.some((clip) => Number(clip.source_start_seconds || 0) > 0), "planner nao calculou offsets de corte nos videos");
  assert(new Set(planV1.map((clip) => Number(clip.source_start_seconds || 0))).size > 3, "offsets de corte ficaram pouco variados");

  const countsByScene = planV1.reduce((acc, clip) => {
    acc.set(clip.scene_index, (acc.get(clip.scene_index) || 0) + 1);
    return acc;
  }, new Map());

  assert(countsByScene.get(3) >= 2, "Porto deveria receber mais de um corte num roteiro longo");
  assert(countsByScene.get(4) >= 2, "Sintra deveria receber mais de um corte num roteiro longo");
  assert(state.visual_plan.every((scene) => countsByScene.has(scene.scene_index)), "todas as cenas principais deveriam aparecer ao menos uma vez");

  const firstOccurrenceOrder = state.visual_plan.map((scene) => planV1.findIndex((clip) => clip.scene_index === scene.scene_index));
  assert(firstOccurrenceOrder.every((index, position, list) => position === 0 || index > list[position - 1]), "a primeira aparicao das cenas deveria preservar a ordem narrativa");
  const sceneOrder = planV1.map((clip) => clip.scene_index);
  assert(sceneOrder.every((sceneIndex, position, list) => position === 0 || sceneIndex >= list[position - 1]), "uma cena nao deveria reaparecer depois que o audio ja avancou para outra")
  const totalDurationByScene = planV1.reduce((acc, clip) => {
    acc.set(clip.scene_index, Number(((acc.get(clip.scene_index) || 0) + Number(clip.clip_duration_seconds || 0)).toFixed(3)));
    return acc;
  }, new Map());
  assert(planV1.some((clip) => clip.scene_role === "intro"), "o planner deveria criar uma abertura neutra quando o roteiro comeca generico");
  assert(planV1.some((clip) => clip.scene_role === "outro"), "o planner deveria criar um fechamento neutro quando o roteiro termina em comentario geral");

  const sceneTimingHints = __test__.buildSceneScriptTimingHints({
    scenes: state.visual_plan,
    scriptText: state.script_text,
    audioDuration: 88,
  });
  const firstByScene = planV1.reduce((acc, clip) => {
    if (!acc.has(clip.scene_index)) {
      const currentElapsed = acc.get("__elapsed__") || 0;
      acc.set(clip.scene_index, Number(currentElapsed.toFixed(3)));
    }

    acc.set("__elapsed__", (acc.get("__elapsed__") || 0) + Number(clip.clip_duration_seconds || 0) - 0.45);
    return acc;
  }, new Map());

  for (const scene of state.visual_plan) {
    const hint = sceneTimingHints.get(scene.scene_index);
    const actualStart = firstByScene.get(scene.scene_index);
    assert(typeof actualStart === "number", `cena ${scene.scene_index} nao apareceu na timeline`);
    assert(actualStart >= Number(hint?.script_start_seconds || 0) - 2.5, `cena ${scene.scene_index} entrou cedo demais em relacao ao roteiro`);
    assert(actualStart <= Number(hint?.script_end_seconds || 88) + 1, `cena ${scene.scene_index} entrou tarde demais em relacao ao roteiro`);
  }

  assert(planV1.every((clip) => clip.clip_script_excerpt), "cada corte deveria carregar o trecho de roteiro correspondente");
  assert(planV1.every((clip) => typeof clip.semantic_match_score === "number"), "cada corte deveria expor um score de alinhamento semantico");
  assert(planV1.some((clip) => clip.asset_window_summary), "cada corte deveria expor a janela semantica escolhida");

  const lisbonClip = planV1.find((clip) => clip.scene_index === 1 && clip.scene_role === "body");
  assert(lisbonClip, "deveria existir ao menos um corte de lisboa");
  assert(/lisbon|miradouro|rooftops|tram/.test(String(lisbonClip.asset_window_summary || "").toLowerCase()), "lisboa deveria escolher uma janela alinhada ao conteudo visual esperado");
  assert(Number(lisbonClip.source_start_seconds || 0) >= Number(lisbonClip.asset_window_start_seconds || 0), "o corte de lisboa deveria iniciar dentro da janela escolhida");
  assert(Number(lisbonClip.source_end_seconds || 0) <= Number(lisbonClip.asset_window_end_seconds || 0) + 0.01, "o corte de lisboa deveria terminar dentro da janela escolhida");

  const portoClip = planV1.find((clip) => clip.scene_index === 3 && clip.scene_role === "body");
  assert(portoClip, "deveria existir ao menos um corte de porto");
  assert(/porto|douro|bridge|waterfront/.test(String(portoClip.asset_window_summary || "").toLowerCase()), "porto deveria escolher uma janela ligada ao douro ou a ponte");

  const signature = (plan) =>
    plan
      .map(
        (clip) =>
          `${clip.scene_index}:${path.basename(clip.asset.local_path)}:${clip.asset_window_start_seconds}:${Number(clip.source_start_seconds || 0).toFixed(2)}`
      )
      .join("|");
  assert(signature(planV2) !== signature(planV1), "draft v2 deveria variar a selecao do asset, da janela ou do offset");

  console.log("planner de timeline validado com sucesso");
  console.log(JSON.stringify({ total_clips: planV1.length, porto_clips: countsByScene.get(3), sintra_clips: countsByScene.get(4) }, null, 2));
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
