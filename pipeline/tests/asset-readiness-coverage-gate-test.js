const assert = require("assert");
const { summarizeAssetReadiness } = require("../src/services/assetReadinessService");

const visualPlan = [
  {
    scene_index: 1,
    visual_intent: "gastronomy",
    role: "body",
    required_visual_evidence: ["food", "market"],
  },
];

const assets = [
  {
    scene_index: 1,
    provider: "pexels",
    source_url: "https://example.com/a.mp4",
    local_path: "/tmp/a.mp4",
  },
];

const approvedItems = [...assets];
const approvedWindows = [
  {
    scene_index: 1,
    visual_truth_status: "exact",
    visual_observation: { detected_visual_categories: ["food"] },
    editorial_inference: { matched_allowed_categories: ["food"], required_evidence_found: ["food"] },
  },
];

const sceneEditorialReadiness = [
  {
    scene_index: 1,
    coverage_status: "partial",
    coverage_can_advance: false,
    coverage_needs_repair: true,
    coverage_missing_slots: ["people_eating"],
    coverage_weak_only_slots: ["people_eating"],
    blocking_reasons: ["block_coverage_partial"],
    critical_slots_missing: [],
    block_slot_coverage_missing: [],
  },
];

const summary = summarizeAssetReadiness({
  visualPlan,
  assets,
  approvedItems,
  approvedWindows,
  sceneEditorialReadiness,
  editorialMetrics: {},
  mockMode: false,
});

assert.strictEqual(summary.missing_assets, true, "partial block coverage deveria bloquear readiness");
assert.strictEqual(summary.blocking_scene_indexes.includes(1), true, "scene 1 deveria bloquear");
assert(
  summary.scene_asset_readiness[0].blocking_reasons.includes("scene_block_coverage_partial"),
  "deveria propagar motivo de cobertura parcial"
);

console.log("asset readiness coverage gate validado com sucesso");

