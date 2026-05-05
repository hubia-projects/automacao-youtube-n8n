const assert = require("assert");
const { buildTimeline } = require("../src/services/timelinePlanner");

const buildAsset = ({ sceneIndex, city, summary, start = 0, end = 6, localPath }) => ({
  scene_index: sceneIndex,
  provider: "mock",
  asset_type: "video",
  type: "video",
  local_path: localPath,
  source_url: `https://example.com/${encodeURIComponent(localPath)}`,
  semantic_text: summary,
  query: summary,
  source_duration_seconds: 12,
  duration_estimate: 12,
  resolution: { width: 1920, height: 1080, label: "Full HD" },
  analysis_provider: "test",
  analysis_window_seconds: 6,
  analysis_windows: [
    {
      window_index: 1,
      start_seconds: start,
      end_seconds: end,
      summary,
      tags: [city.toLowerCase(), "market"],
      location: { city, country: "Portugal", confidence: 0.95 },
      landmarks: [],
      location_type: "market",
      confidence: 0.9,
      quality: { sharpness: 0.8, stability: 0.8, brightness: 0.8, usable: true },
    },
  ],
});

const state = {
  video_id: "timeline_dedup_test",
  topic: "Portugal gastronomia",
  script_text: "Lisboa abre com cafes e mercados. Porto segue com vinho e ribeira.",
  visual_plan: [
    { scene_index: 1, title: "Lisboa gastronomica", narration_excerpt: "Lisboa abre com cafes e mercados.", keywords: ["lisboa", "market", "cafe"], target_duration_seconds: 8 },
    { scene_index: 2, title: "Porto gastronomico", narration_excerpt: "Porto segue com vinho e ribeira.", keywords: ["porto", "wine", "market"], target_duration_seconds: 8 },
  ],
  assets_json: {
    items: [
      buildAsset({ sceneIndex: 1, city: "Lisboa", summary: "Lisboa market and cafe", localPath: "lisboa-a.mp4" }),
      buildAsset({ sceneIndex: 1, city: "Lisboa", summary: "Lisboa bakery and street food", localPath: "lisboa-b.mp4" }),
      buildAsset({ sceneIndex: 2, city: "Porto", summary: "Porto wine cellar and food market", localPath: "porto-a.mp4" }),
      buildAsset({ sceneIndex: 2, city: "Porto", summary: "Porto ribeira market and dishes", localPath: "porto-b.mp4" }),
    ],
  },
};

const fallbackAsset = buildAsset({ sceneIndex: 0, city: "", summary: "neutral travel map", localPath: "fallback.mp4" });

const run = async () => {
  const timeline = await buildTimeline({ state, audioDuration: 16, draftVersion: 1, fallbackAsset });
  assert(timeline.clips.length >= 3, "timeline deveria gerar multiplos clips");
  for (let i = 1; i < timeline.clips.length; i += 1) {
    assert(timeline.clips[i].asset_window_id !== timeline.clips[i - 1].asset_window_id, "nao deveria repetir a mesma janela em sequencia");
    assert(timeline.clips[i].visual_signature !== timeline.clips[i - 1].visual_signature || timeline.clips[i].asset_window_id !== timeline.clips[i - 1].asset_window_id, "nao deveria repetir assinatura visual em sequencia");
  }
  console.log("timeline deduplication validada com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
