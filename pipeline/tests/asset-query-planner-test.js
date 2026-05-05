const assert = require("assert");
const { buildSceneQueryPlan } = require("../src/services/assetQueryPlanner");

const scene = {
  title: "Lisboa gastronomica",
  narration_excerpt: "Mercados, pasteis de nata, cafes e restaurantes tradicionais definem a cena.",
  role: "body",
  visual_intent: "gastronomy",
  generic_asset_allowed: false,
  location: { city: "Lisboa", country: "Portugal" },
  negative_keywords: ["porto", "sintra"],
};

const plan = buildSceneQueryPlan({ scene, topic: "Portugal gastronomico: Lisboa, Porto, mercados e vinhos" });

assert(plan.queries.includes("lisbon food market"), "deveria gerar lisbon food market");
assert(plan.queries.includes("lisbon traditional restaurant"), "deveria gerar lisbon traditional restaurant");
assert(plan.queries.includes("lisbon pastel de nata cafe"), "deveria gerar lisbon pastel de nata cafe");
assert(plan.queries.includes("portugal portuguese food"), "deveria gerar fallback por pais com comida");
assert(!plan.queries.includes("lisbon skyline"), "nao deveria gerar skyline generico");
assert(!plan.queries.includes("lisbon aerial"), "nao deveria gerar aerial generico");
assert(!plan.queries.includes("portugal travel"), "nao deveria gerar travel generico");
assert(plan.queryDetails.every((entry) => /visual_intent_gastronomy/.test(entry.reason)), "deveria explicar o motivo das queries");

console.log("asset query planner validado com sucesso");