const assert = require("assert");
const { rankCandidates } = require("../src/services/timelineScoringService");

const block = {
  block_id: "lisboa_gastronomia",
  visual_intent: "gastronomy",
  required_visual_evidence: ["food", "market", "restaurant"],
  allowed_visual_categories: ["food", "market", "wine", "restaurant", "cafe", "pastry", "people_eating"],
  forbidden_visual_categories: ["aerial_city", "bridge", "river", "coast", "generic_street", "clouds"],
  generic_asset_allowed: false,
  location: { city: "Lisboa", country: "Portugal" },
  topic_type: "city",
  macro_topic: "Lisboa",
  narration_excerpt: "Agora a narracao fala de comida local, mercado e pessoas comendo.",
  keywords: ["lisboa", "food market", "restaurant"],
};

const skylineCandidate = {
  asset_id: "skyline",
  id: "skyline_w01",
  asset: { asset_type: "video", provider: "pexels", source_url: "https://example.com/skyline.mp4" },
  description: "Lisbon skyline aerial view with bridge and river",
  semantic_text: "Lisbon skyline aerial bridge river",
  tags: ["lisbon", "skyline", "aerial", "bridge", "river"],
  location: { city: "Lisboa", country: "Portugal", confidence: 0.9 },
  landmarks: [],
  location_type: "cityscape",
  visual_features: { camera_motion: "drone", shot_type: "wide" },
  quality: { resolution_score: 1, brightness: 0.8, usable: true },
  confidence: 0.8,
  start_sec: 0,
  end_sec: 6,
  duration_sec: 6,
  detected_visual_categories: ["aerial_city", "bridge", "river"],
  detected_objects: [],
};

const foodCandidate = {
  asset_id: "food",
  id: "food_w01",
  asset: { asset_type: "video", provider: "pexels", source_url: "https://example.com/food.mp4" },
  description: "People eating at outdoor food market with plates and wine glasses",
  semantic_text: "food market people eating plates wine glasses",
  tags: ["food", "market", "people eating", "wine", "restaurant"],
  location: { city: "", country: "", confidence: 0 },
  landmarks: [],
  location_type: "market",
  visual_features: { camera_motion: "tracking", shot_type: "medium" },
  quality: { resolution_score: 1, brightness: 0.8, usable: true },
  confidence: 0.8,
  start_sec: 0,
  end_sec: 6,
  duration_sec: 6,
  detected_visual_categories: ["food", "market", "restaurant", "wine", "people_eating"],
  detected_objects: ["plate", "glass", "food"],
};

const run = async () => {
  const ranked = await rankCandidates({
    block,
    narrationText: "mercado local, comida portuguesa e pessoas comendo",
    candidates: [skylineCandidate, foodCandidate],
    previousMacroTopic: "",
    usage: {
      usedSourceUrls: new Map(),
      usedAssetIds: new Map(),
      usedLocalPaths: new Map(),
      usedWindowIds: new Map(),
      usedProviders: new Map(),
      usedBlockAssetIds: new Map(),
      usedVisualSignatures: new Map(),
      lastClipByAssetId: new Map(),
    },
    videoId: "timeline_scoring_gastronomy_test",
    clipIndex: 1,
  });

  assert.strictEqual(ranked[0].candidate.id, "food_w01", "narração sobre comida deveria escolher mercado/comida em vez de skyline");
  assert(ranked[0].features.visualIntentMatchScore > ranked[1].features.visualIntentMatchScore, "candidato de comida deveria ganhar no visual intent");
  assert(ranked[1].features.genericAssetPenalty > 0, "skyline deveria receber penalidade generica");

  console.log("timeline scoring gastronomico validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});