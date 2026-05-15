const assert = require("assert");
const { __test__: timelinePlannerTest } = require("../src/services/timelinePlanner");

const block = {
  scene_index: 1,
  topic_type: "city",
  macro_topic: "Lisboa",
  expected_location: "Lisboa",
  hard_boundary: false,
};

const genericCandidate = {
  id: "generic",
  scene_index: 1,
  quality: { usable: true },
  location: { city: "Lisboa", country: "Portugal", confidence: 0.65 },
  landmarks: [],
  critical_slot_allowed: false,
  narrative_roles_supported: ["bridge_neutral_short", "detail_cutaway"],
  opening_allowed: false,
  editorial_approved: true,
  visual_truth_status: "generic",
};

const exactCandidate = {
  id: "exact",
  scene_index: 1,
  quality: { usable: true },
  location: { city: "Lisboa", country: "Portugal", confidence: 0.95 },
  landmarks: [],
  critical_slot_allowed: true,
  narrative_roles_supported: ["proof_exact", "detail_cutaway"],
  opening_allowed: true,
  editorial_approved: true,
  visual_truth_status: "exact",
};

const filtered = timelinePlannerTest.filterCandidatesByHardRules({
  block,
  assetWindows: [genericCandidate, exactCandidate],
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

assert.strictEqual(filtered.length, 1, "slot de prova não pode ser dominado por generic");
assert.strictEqual(filtered[0].id, "exact");
console.log("generic-does-not-replace-exact-proof-test ok");
