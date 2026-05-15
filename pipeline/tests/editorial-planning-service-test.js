const assert = require("assert");
const {
  classifyEditorialCandidate,
  evaluateTimelineEditorialCoverage,
  getNarrativeRole,
} = require("../src/services/editorialPlanningService");

(() => {
  assert.strictEqual(getNarrativeRole({ sceneRole: "intro", sceneOrder: 1, totalScenes: 6 }), "hook");
  assert.strictEqual(getNarrativeRole({ sceneRole: "body", sceneOrder: 3, totalScenes: 6, hardBoundary: true }), "bridge");
  assert.strictEqual(getNarrativeRole({ sceneRole: "outro", sceneOrder: 6, totalScenes: 6 }), "closing");

  const exact = classifyEditorialCandidate({
    scene: {
      role: "intro",
      scene_order: 1,
      total_scenes: 6,
      visual_intent: "gastronomy",
      expected_location: "Porto",
      generic_asset_allowed: false,
      required_visual_evidence: ["food", "market"],
      allowed_visual_categories: ["food", "market", "people_eating"],
      forbidden_visual_categories: ["aerial_city", "bridge", "river"],
    },
    candidate: {
      description: "Porto market with food plates and people eating",
      semantic_text: "Porto market with food plates and people eating",
      tags: ["food", "market", "people eating"],
      detected_visual_categories: ["food", "market", "people_eating"],
      location: { city: "Porto", country: "Portugal" },
      confidence: 0.92,
      visual_evidence_source: "openai_vision",
      asset: { provider: "pexels" },
    },
  });

  assert.strictEqual(exact.status, "exact");

  const generic = classifyEditorialCandidate({
    scene: {
      role: "intro",
      scene_order: 1,
      total_scenes: 6,
      visual_intent: "gastronomy",
      expected_location: "Lisboa",
      generic_asset_allowed: false,
      required_visual_evidence: ["food"],
      allowed_visual_categories: ["food", "restaurant"],
      forbidden_visual_categories: ["aerial_city", "bridge", "river"],
    },
    candidate: {
      description: "Lisbon skyline aerial over the river",
      semantic_text: "Lisbon skyline aerial over the river",
      tags: ["aerial", "skyline", "river"],
      detected_visual_categories: ["aerial_city", "river"],
      location: { city: "Lisboa", country: "Portugal" },
      confidence: 0.81,
      visual_evidence_source: "openai_vision",
      asset: { provider: "pexels" },
    },
  });

  assert.strictEqual(generic.status, "generic");

  const coverage = evaluateTimelineEditorialCoverage({
    state: {
      topic: "Portugal gastronomico: Lisboa, Porto, mercados e vinhos",
      visual_plan: [
        { scene_index: 1, visual_intent: "gastronomy" },
        { scene_index: 2, visual_intent: "market" },
        { scene_index: 3, visual_intent: "wine" },
      ],
    },
    timeline: {
      clips: [
        {
          clip_index: 1,
          scene_index: 1,
          scene_order: 1,
          scene_role: "intro",
          visual_intent: "gastronomy",
          hard_boundary: false,
          expected_location: "Lisboa",
          required_visual_evidence: ["food"],
          allowed_visual_categories: ["food", "market"],
          forbidden_visual_categories: ["aerial_city", "bridge", "river"],
          detected_visual_categories: ["aerial_city", "river"],
          semantic_match_terms: [],
          detected_objects: [],
          detected_location: { city: "Lisboa", country: "Portugal" },
          asset_semantic_text: "Lisbon skyline aerial",
          asset_window_summary: "Lisbon skyline aerial",
          asset_analysis_provider: "openai_vision",
          provider: "pexels",
        },
        {
          clip_index: 2,
          scene_index: 2,
          scene_order: 2,
          scene_role: "body",
          visual_intent: "market",
          hard_boundary: true,
          expected_location: "Porto",
          required_visual_evidence: ["market"],
          allowed_visual_categories: ["market", "food"],
          forbidden_visual_categories: ["aerial_city", "bridge", "river"],
          detected_visual_categories: ["market", "food"],
          semantic_match_terms: [],
          detected_objects: [],
          detected_location: { city: "Porto", country: "Portugal" },
          asset_semantic_text: "Porto food market",
          asset_window_summary: "Porto food market",
          asset_analysis_provider: "openai_vision",
          provider: "pexels",
        },
      ],
    },
  });

  assert(coverage.issues.some((issue) => issue.type === "critical_slot_editorial_failure"));
  assert(coverage.issues.some((issue) => issue.type === "coverage_gap"));

  console.log("editorial planning service test passed");
})();