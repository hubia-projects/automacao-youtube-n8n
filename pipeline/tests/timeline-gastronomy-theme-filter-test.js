const assert = require("assert");
const { __test__: timelinePlannerTest } = require("../src/services/timelinePlanner");

const block = {
  scene_index: 1,
  topic_type: "city",
  macro_topic: "Lisboa",
  expected_location: "Lisboa",
  hard_boundary: false,
  visual_intent: "gastronomy",
};

const genericCityCandidate = {
  id: "generic-city",
  scene_index: 1,
  quality: { usable: true },
  location: { city: "Lisboa", country: "Portugal", confidence: 0.8 },
  landmarks: [],
  critical_slot_allowed: true,
  narrative_roles_supported: ["proof_exact", "detail_cutaway"],
  opening_allowed: true,
  editorial_approved: true,
  visual_truth_status: "regional",
  detected_visual_categories: ["city_landmark", "bridge"],
  required_evidence_found: [],
};

const themedCandidate = {
  id: "food-proof",
  scene_index: 1,
  quality: { usable: true },
  location: { city: "Lisboa", country: "Portugal", confidence: 0.8 },
  landmarks: [],
  critical_slot_allowed: true,
  narrative_roles_supported: ["proof_exact", "detail_cutaway"],
  opening_allowed: true,
  editorial_approved: true,
  visual_truth_status: "exact",
  detected_visual_categories: ["food", "market", "people_eating"],
  required_evidence_found: ["food", "market"],
};

const filtered = timelinePlannerTest.filterCandidatesByHardRules({
  block,
  assetWindows: [genericCityCandidate, themedCandidate],
  previousMacroTopic: "",
  fallbackAsset: null,
  allowPlaceholderFallback: false,
  isBoundaryFirstSlot: false,
  criticalSlot: true,
  slotRole: "proof_exact",
  hardBoundaryPolicy: {
    enabled: true,
    forbid_neutral_first_clip: true,
    require_location_on_hard_boundary: true,
    fail_on_missing_boundary_candidate: true,
  },
});

assert.strictEqual(filtered.length, 1, "slot crítico gastronômico deve filtrar para prova temática");
assert.strictEqual(filtered[0].id, "food-proof");
console.log("timeline-gastronomy-theme-filter-test ok");

