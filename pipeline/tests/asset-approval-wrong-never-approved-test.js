const assert = require("assert");
const { approveAssetsForVisualPlan } = require("../src/services/assetApprovalService");

const visualPlan = [{
  scene_index: 1,
  title: "Porto proof",
  role: "body",
  visual_intent: "city_landmark",
  required_visual_evidence: ["city_landmark"],
  allowed_visual_categories: ["city_landmark", "historic_street", "aerial_city"],
  forbidden_visual_categories: ["coast"],
  generic_asset_allowed: false,
  expected_location: "Porto",
  location: { city: "Porto", country: "Portugal" },
}];

const assets = [{
  scene_index: 1,
  provider: "mock",
  local_path: "C:/tmp/wrong-city.mp4",
  analysis_windows: [{
    window_index: 1,
    start_seconds: 0,
    end_seconds: 6,
    summary: "Lisbon old town and belem tower",
    tags: ["lisbon", "belem", "historic center"],
    detected_visual_categories: ["city_landmark", "historic_street"],
    location: { city: "Lisboa", country: "Portugal", confidence: 0.92 },
  }],
}];

const result = approveAssetsForVisualPlan({ visualPlan, assets });
assert.strictEqual(result.approved_windows.length, 0, "asset wrong nunca pode entrar no pool aprovado");
assert(result.rejected_windows.some((entry) => entry.visual_truth_status === "wrong"), "deveria classificar explicitamente como wrong");
console.log("asset-approval-wrong-never-approved-test ok");
