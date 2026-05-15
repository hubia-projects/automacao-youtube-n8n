const assert = require("assert");
const { approveAssetsForVisualPlan } = require("../src/services/assetApprovalService");

const visualPlan = [
  {
    scene_index: 1,
    title: "Intro Lisboa",
    role: "intro",
    visual_intent: "city_landmark",
    required_visual_evidence: ["city_landmark"],
    allowed_visual_categories: ["city_landmark", "historic_street", "aerial_city"],
    forbidden_visual_categories: ["coast"],
    generic_asset_allowed: true,
    expected_location: "Lisboa",
    location: { city: "Lisboa", country: "Portugal" },
  },
  {
    scene_index: 2,
    title: "Fechamento",
    role: "outro",
    visual_intent: "city_landmark",
    required_visual_evidence: ["city_landmark"],
    allowed_visual_categories: ["city_landmark", "historic_street", "aerial_city"],
    forbidden_visual_categories: ["coast"],
    generic_asset_allowed: false,
    expected_location: "Lisboa",
    location: { city: "Lisboa", country: "Portugal" },
  },
];

const assets = [
  {
    scene_index: 1,
    provider: "mock",
    local_path: "C:/tmp/intro.mp4",
    analysis_windows: [{
      window_index: 1,
      start_seconds: 0,
      end_seconds: 5,
      summary: "historic district and landmark in lisboa",
      tags: ["historic district", "landmark", "lisboa"],
      detected_visual_categories: ["city_landmark", "historic_street"],
      location: { city: "Lisboa", country: "Portugal", confidence: 0.9 },
      visual_evidence_source: "openai_vision",
    }],
  },
  {
    scene_index: 2,
    provider: "mock",
    local_path: "C:/tmp/outro.mp4",
    analysis_windows: [{
      window_index: 1,
      start_seconds: 0,
      end_seconds: 6,
      summary: "lisboa landmark with final city reveal",
      tags: ["landmark", "city"],
      detected_visual_categories: ["city_landmark"],
      location: { city: "Lisboa", country: "Portugal", confidence: 0.9 },
      visual_evidence_source: "openai_vision",
    }],
  },
];

const result = approveAssetsForVisualPlan({ visualPlan, assets });
const introWindow = result.approved_windows.find((item) => item.scene_index === 1);
const outroWindow = result.approved_windows.find((item) => item.scene_index === 2);

assert(introWindow.narrative_roles_supported.includes("hook_exact") || introWindow.narrative_roles_supported.includes("opening_establishing"));
assert.strictEqual(introWindow.opening_allowed, true);
assert(outroWindow.narrative_roles_supported.includes("closing_payoff"), "fechamento precisa papel próprio");
assert.strictEqual(outroWindow.closing_allowed, true);
console.log("intro-hook-closing-contract-test ok");
