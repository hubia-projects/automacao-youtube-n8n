const assert = require("assert");
const { shouldRejectAssetForScene } = require("../src/services/assetRejectionService");
const { enrichVisualPlan } = require("../src/services/narrativeBlockPlanner");

const scene = enrichVisualPlan({
  topic: "Portugal gastronomico: Lisboa, Porto, mercados e vinhos",
  visualPlan: [{
    scene_index: 1,
    title: "Lisboa gastronomica",
    narration_excerpt: "Mercados, pratos, cafes e vinho dominam esta parte do video.",
    keywords: ["lisbon", "food market", "wine", "restaurant"],
    role: "body",
    target_duration_seconds: 8,
  }],
  audioDuration: 8,
}).visualPlan[0];

const skylineWindow = {
  summary: "Lisbon skyline aerial view over bridge and river",
  tags: ["skyline", "aerial", "bridge", "river"],
  detected_visual_categories: ["aerial_city", "bridge", "river"],
  start_seconds: 0,
  end_seconds: 6,
};
const skylineResult = shouldRejectAssetForScene({ asset: { query: "lisbon skyline" }, scene, window: skylineWindow });
assert.strictEqual(skylineResult.reject, true, "skyline generico deveria ser rejeitado em cena gastronomica");

const marketWindow = {
  summary: "People eating at Lisbon food market with plates, pastry and wine glasses",
  tags: ["food", "market", "restaurant", "wine"],
  detected_visual_categories: ["food", "market", "restaurant", "wine", "people_eating"],
  detected_objects: ["plate", "glass", "food"],
  start_seconds: 0,
  end_seconds: 6,
};
const marketResult = shouldRejectAssetForScene({ asset: { query: "lisbon food market" }, scene, window: marketWindow });
assert.strictEqual(marketResult.reject, false, "food market deveria ser aceito em cena gastronomica");

console.log("generic asset rejection validado com sucesso");