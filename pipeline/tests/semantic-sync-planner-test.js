const assert = require("assert");
const { buildTimeline, __test__ } = require("../src/services/timelinePlanner");

const buildAsset = ({ sceneIndex, query, summary, tags, city, start = 0, end = 8 }) => ({
  scene_index: sceneIndex,
  provider: "mock",
  asset_type: "video",
  type: "video",
  query,
  semantic_text: summary,
  source_duration_seconds: 12,
  duration_estimate: 12,
  resolution: { width: 1920, height: 1080, label: "Full HD" },
  analysis_summary: summary,
  analysis_tags: tags,
  analysis_windows: [
    {
      window_index: 1,
      start_seconds: start,
      end_seconds: end,
      summary,
      tags,
      location: { city, country: "Portugal", confidence: 0.95 },
      landmarks: [],
      location_type: "cityscape",
      confidence: 0.9,
    },
  ],
});

const state = {
  video_id: "semantic_sync_planner_test",
  topic: "Lisboa e Porto",
  script_text: [
    "Lisboa abre o roteiro com miradouros e ruas historicas.",
    "Agora seguimos para o Porto, com o Douro e a Ponte Dom Luis.",
  ].join(" "),
  visual_plan: [
    {
      scene_index: 1,
      title: "Lisboa miradouros",
      narration_excerpt: "Lisboa abre o roteiro com miradouros e ruas historicas.",
      keywords: ["lisboa", "miradouro", "historic street"],
      target_duration_seconds: 10,
    },
    {
      scene_index: 2,
      title: "Porto Douro",
      narration_excerpt: "Agora seguimos para o Porto, com o Douro e a Ponte Dom Luis.",
      keywords: ["porto", "douro", "dom luis bridge"],
      target_duration_seconds: 10,
    },
  ],
  assets_json: {
    items: [
      buildAsset({
        sceneIndex: 1,
        query: "lisboa miradouro travel footage",
        summary: "Lisboa skyline from a miradouro over red rooftops",
        tags: ["lisboa", "miradouro", "skyline"],
        city: "Lisboa",
      }),
      buildAsset({
        sceneIndex: 2,
        query: "porto douro bridge travel footage",
        summary: "Porto Douro riverfront and Ponte Dom Luis bridge",
        tags: ["porto", "douro", "bridge"],
        city: "Porto",
      }),
    ],
  },
};

const run = async () => {
  const timeline = await buildTimeline({
    state,
    audioDuration: 20,
    draftVersion: 1,
    fallbackAsset: {
      provider: "fallback",
      asset_type: "image",
      semantic_text: "neutral travel map",
      duration_estimate: 4,
      resolution: { width: 1920, height: 1080, label: "Full HD" },
    },
  });

  assert.strictEqual(timeline.renderStrategy, "concat", "hard-boundary planner deve renderizar sem xfade global");
  assert(timeline.narrativeBlocks.length >= 2, "deveria criar macroblocos separados");
  assert(timeline.timelineSyncMetrics.p95_topic_lag_sec <= 1, "lag p95 deveria respeitar 1s");
  assert.strictEqual(timeline.timelineSyncMetrics.wrong_topic_exposure_sec, 0, "nao deveria haver exposicao do topico errado");

  const clipsAfterPortoBoundary = timeline.clips.filter((clip) => Number(clip.timeline_start_sec || 0) >= 10);
  assert(clipsAfterPortoBoundary.length > 0, "deveria haver clips depois do inicio do bloco Porto");
  assert(
    clipsAfterPortoBoundary.every((clip) => !__test__.belongsToTopic(clip.detected_location?.city || "", "Lisboa")),
    "clips de Lisboa nao podem continuar depois da boundary Porto"
  );
  assert(
    clipsAfterPortoBoundary[0].detected_location?.city === "Porto" || clipsAfterPortoBoundary[0].neutral_fallback,
    "primeiro clip apos boundary deve ser Porto ou fallback neutro"
  );

  const portoBlock = timeline.microBlocks.find((block) => block.macro_topic === "Porto");
  const assetWindows = __test__.flattenAssetWindows(state.assets_json.items);
  const filtered = __test__.filterCandidatesByHardRules({
    block: portoBlock,
    assetWindows,
    previousMacroTopic: "Lisboa",
    fallbackAsset: state.assets_json.items[1],
  });

  assert(
    filtered.every((candidate) => !__test__.belongsToTopic(candidate.location?.city || "", "Lisboa")),
    "hard rules devem rejeitar candidatos do topico anterior"
  );

  console.log("semantic sync planner validado com sucesso");
  console.log(JSON.stringify({
    total_clips: timeline.totalClipCount,
    p95_topic_lag_sec: timeline.timelineSyncMetrics.p95_topic_lag_sec,
    wrong_topic_exposure_sec: timeline.timelineSyncMetrics.wrong_topic_exposure_sec,
  }, null, 2));
};

run().catch((error) => {
  console.error("semantic sync planner falhou", error.message);
  process.exit(1);
});
