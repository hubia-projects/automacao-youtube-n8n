const assert = require("assert");
const { summarizeAssetReadiness } = require("../src/services/assetReadinessService");

const visualPlan = [{
  scene_index: 1,
  title: "Mercado de Lisboa",
  role: "body",
  visual_intent: "gastronomy",
  required_visual_evidence: ["food", "market"],
  generic_asset_allowed: false,
  hard_boundary: false,
}];

const assets = [{
  scene_index: 1,
  provider: "mock",
  local_path: "C:/tmp/generic.mp4",
}];

const approvedItems = [...assets];
const approvedWindows = [{
  scene_index: 1,
  visual_truth_status: "generic",
  approved: true,
  approved_window_id: "generic:w01",
}];

const sceneEditorialReadiness = [{
  scene_index: 1,
  critical_slots_missing: ["first_clip_of_block"],
}];

const summary = summarizeAssetReadiness({
  visualPlan,
  assets,
  approvedItems,
  approvedWindows,
  sceneEditorialReadiness,
  mockMode: false,
});

assert.strictEqual(summary.missing_assets, true, "cena com apenas generic não deve ficar pronta editorialmente");
assert(summary.scene_asset_readiness[0].blocking_reasons.includes("scene_missing_exact_visual_proof"));
console.log("editorial-readiness-generic-only-fail-test ok");
