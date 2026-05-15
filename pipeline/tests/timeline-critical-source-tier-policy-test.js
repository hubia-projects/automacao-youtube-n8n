const assert = require("assert");
const { __test__: timelinePlannerTest } = require("../src/services/timelinePlanner");

const baseBlock = {
  scene_index: 1,
  topic_type: "city",
  macro_topic: "Lisboa",
  expected_location: "Lisboa",
  hard_boundary: false,
  visual_intent: "generic_travel",
};

const makeCandidate = ({
  id,
  sourceTier = "free",
  status = "exact",
  confidence = 0.9,
}) => ({
  id,
  scene_index: 1,
  quality: { usable: true },
  location: { city: "Lisboa", country: "Portugal", confidence: 0.9 },
  landmarks: [],
  critical_slot_allowed: true,
  narrative_roles_supported: ["proof_exact", "detail_cutaway"],
  opening_allowed: true,
  closing_allowed: true,
  editorial_approved: true,
  source_tier: sourceTier,
  visual_truth_status: status,
  editorial_confidence: confidence,
  detected_visual_categories: ["city_landmark"],
});

{
  const filtered = timelinePlannerTest.filterCandidatesByHardRules({
    block: baseBlock,
    assetWindows: [
      makeCandidate({ id: "free-strong", sourceTier: "free", status: "exact", confidence: 0.95 }),
      makeCandidate({ id: "curated", sourceTier: "curated", status: "regional", confidence: 0.8 }),
      makeCandidate({ id: "generated", sourceTier: "generated", status: "exact", confidence: 0.95 }),
    ],
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

  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].id, "curated", "slot crítico deve priorizar curated/premium");
}

{
  const filtered = timelinePlannerTest.filterCandidatesByHardRules({
    block: baseBlock,
    assetWindows: [
      makeCandidate({ id: "free-strong", sourceTier: "free", status: "exact", confidence: 0.95 }),
      makeCandidate({ id: "generated", sourceTier: "generated", status: "exact", confidence: 0.95 }),
      makeCandidate({ id: "free-weak", sourceTier: "free", status: "generic", confidence: 0.6 }),
    ],
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

  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].id, "free-strong", "sem curated/premium, só free forte deve sobreviver");
}

console.log("timeline-critical-source-tier-policy-test ok");
