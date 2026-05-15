const assert = require("assert");
const { evaluateVisualEvidence } = require("../src/services/visualIntentService");

const scene = {
  visual_intent: "gastronomy",
  generic_asset_allowed: false,
  required_visual_evidence: ["food", "market", "people eating"],
  allowed_visual_categories: ["food", "market", "restaurant", "people_eating"],
  forbidden_visual_categories: ["aerial_city", "bridge", "river", "coast"],
};

const evidence = evaluateVisualEvidence({
  scene,
  window: {
    summary: "wide skyline over a bridge and river",
    tags: ["skyline", "bridge", "river"],
    detected_visual_categories: ["aerial_city", "bridge", "river"],
  },
  asset: {
    query: "lisbon food market people eating",
    query_used: "lisbon food market people eating",
    semantic_text: "restaurant and food",
    provider_tags: ["food", "market"],
  },
});

assert.strictEqual(evidence.visual_intent_match, false, "query e metadata nao podem virar prova visual");
assert(evidence.missing_required_visual_evidence.length > 0, "deveria manter evidencias obrigatorias como ausentes");
console.log("query-not-visual-evidence-test ok");
