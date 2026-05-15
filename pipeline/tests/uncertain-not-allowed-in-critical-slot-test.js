const assert = require("assert");
const { __test__: timelinePlannerTest } = require("../src/services/timelinePlanner");

const block = {
  scene_index: 1,
  topic_type: "city",
  macro_topic: "Lisboa",
  expected_location: "Lisboa",
  hard_boundary: true,
};

const uncertainCandidate = {
  id: "uncertain",
  scene_index: 1,
  quality: { usable: true },
  location: { city: "Lisboa", country: "Portugal", confidence: 0.6 },
  landmarks: [],
  critical_slot_allowed: false,
  narrative_roles_supported: ["context_regional"],
  opening_allowed: false,
  closing_allowed: false,
  editorial_approved: true,
};

const exactCandidate = {
  id: "exact",
  scene_index: 1,
  quality: { usable: true },
  location: { city: "Lisboa", country: "Portugal", confidence: 0.92 },
  landmarks: [],
  critical_slot_allowed: true,
  narrative_roles_supported: ["proof_exact", "opening_establishing"],
  opening_allowed: true,
  closing_allowed: true,
  editorial_approved: true,
};

const filtered = timelinePlannerTest.filterCandidatesByHardRules({
  block,
  assetWindows: [uncertainCandidate, exactCandidate],
  previousMacroTopic: "",
  fallbackAsset: null,
  allowPlaceholderFallback: false,
  isBoundaryFirstSlot: true,
  criticalSlot: true,
  slotRole: "proof_exact",
  hardBoundaryPolicy: {
    enabled: true,
    forbid_neutral_first_clip: true,
    require_location_on_hard_boundary: true,
    fail_on_missing_boundary_candidate: true,
  },
});

assert.strictEqual(filtered.length, 1, "slot crítico deve remover candidato incerto");
assert.strictEqual(filtered[0].id, "exact");
console.log("uncertain-not-allowed-in-critical-slot-test ok");
