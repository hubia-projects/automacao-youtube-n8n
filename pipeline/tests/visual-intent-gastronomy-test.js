const assert = require("assert");
const { inferVisualIntent } = require("../src/services/visualIntentService");
const { enrichVisualPlan } = require("../src/services/narrativeBlockPlanner");

const scene = {
  scene_index: 2,
  title: "Lisboa gastronomica",
  narration_excerpt: "Lisboa entra com mercado, pastel de nata, cafe e restaurante tradicional.",
  keywords: ["lisbon", "food market", "pastry", "restaurant"],
  role: "body",
  target_duration_seconds: 8,
};

const intent = inferVisualIntent({ scene, topic: "Portugal gastronomico: Lisboa, Porto, mercados e vinhos" });

assert.strictEqual(intent.visual_intent, "gastronomy", "cena gastronomica deveria ser travada como gastronomy");
assert(intent.required_visual_evidence.includes("food"), "gastronomy deveria exigir food");
assert(intent.required_visual_evidence.includes("market"), "gastronomy deveria exigir market");
assert(intent.required_visual_evidence.includes("restaurant"), "gastronomy deveria exigir restaurant");
assert(intent.forbidden_visual_categories.includes("aerial_city"), "gastronomy deveria proibir aerial_city");
assert(intent.forbidden_visual_categories.includes("bridge"), "gastronomy deveria proibir bridge");
assert(intent.forbidden_visual_categories.includes("river"), "gastronomy deveria proibir river");
assert(intent.forbidden_visual_categories.includes("coast"), "gastronomy deveria proibir coast");
assert.strictEqual(intent.generic_asset_allowed, false, "gastronomy nao deveria aceitar asset generico");

const enriched = enrichVisualPlan({
  topic: "Portugal gastronomico: Lisboa, Porto, mercados e vinhos",
  visualPlan: [scene],
  audioDuration: 8,
}).visualPlan[0];

assert.strictEqual(enriched.visual_intent, "gastronomy", "visual plan deveria herdar visual_intent gastronomy");
assert(Array.isArray(enriched.required_visual_evidence) && enriched.required_visual_evidence.length > 0, "visual plan deveria herdar required_visual_evidence");
assert(Array.isArray(enriched.forbidden_visual_categories) && enriched.forbidden_visual_categories.includes("bridge"), "visual plan deveria herdar categorias proibidas");
assert.strictEqual(enriched.generic_asset_allowed, false, "visual plan nao deveria permitir generic asset em cena gastronomica");

console.log("visual intent gastronomico validado com sucesso");