const assert = require("assert");
const { summarizeAssetReadiness } = require("../src/services/assetReadinessService");

const visualPlan = [
  {
    scene_index: 1,
    title: "Mercado e comida local",
    role: "body",
    visual_intent: "gastronomy",
    required_visual_evidence: ["food", "market"],
    generic_asset_allowed: false,
  },
];

const assets = [
  {
    scene_index: 1,
    provider: "mock",
    local_path: "C:/tmp/scene-01.mp4",
  },
];

const approvedItems = [...assets];
const approvedWindows = [
  {
    scene_index: 1,
    visual_truth_status: "regional",
    approved: true,
    approved_window_id: "scene01:w01",
    visual_observation: {
      detected_visual_categories: ["city_landmark", "bridge"],
    },
    editorial_inference: {
      matched_allowed_categories: ["city_landmark"],
      required_evidence_found: [],
    },
  },
];

const summary = summarizeAssetReadiness({
  visualPlan,
  assets,
  approvedItems,
  approvedWindows,
  sceneEditorialReadiness: [
    {
      scene_index: 1,
      critical_slots_missing: [],
    },
  ],
  mockMode: false,
});

assert.strictEqual(summary.missing_assets, true, "cena gastronomica sem prova temática deve falhar readiness");
assert(
  summary.scene_asset_readiness[0].blocking_reasons.includes("scene_missing_theme_visual_proof"),
  "readiness deve bloquear quando cena gastronômica não tem categorias visuais temáticas"
);
console.log("theme-coverage-required-gastronomy-scene-test ok");

