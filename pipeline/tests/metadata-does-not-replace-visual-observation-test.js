const assert = require("assert");
const { evaluateVisualEvidence } = require("../src/services/visualIntentService");

const scene = {
  visual_intent: "gastronomy",
  generic_asset_allowed: false,
  required_visual_evidence: ["food", "market"],
  allowed_visual_categories: ["food", "market", "restaurant"],
  forbidden_visual_categories: ["aerial_city", "bridge", "river"],
};

const evidence = evaluateVisualEvidence({
  scene,
  window: {
    summary: "city aerial skyline and bridge",
    tags: ["city", "skyline", "bridge"],
    detected_visual_categories: ["aerial_city", "bridge", "river"],
  },
  asset: {
    provider_tags: ["food", "market", "restaurant"],
    provider_title: "Best food market of Lisbon",
  },
});

assert.strictEqual(evidence.visual_intent_match, false, "metadata do provider nao substitui observacao visual");
assert(evidence.matched_forbidden_categories.includes("aerial_city") || evidence.matched_forbidden_categories.includes("bridge"));
console.log("metadata-does-not-replace-visual-observation-test ok");
