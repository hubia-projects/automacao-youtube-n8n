const assert = require("assert");
const { buildSceneQueryPlan } = require("../src/services/assetQueryPlanner");

const scene = {
  title: "Adegas e vinho no Porto",
  narration_excerpt: "A cena pede degustacao de vinhos, adegas tradicionais e uvas ligadas ao Douro.",
  role: "body",
  visual_intent: "wine",
  generic_asset_allowed: false,
  location: { city: "Porto", country: "Portugal" },
  keywords: ["wine cellar", "wine tasting", "grapes vineyard"],
  negative_keywords: ["lisbon", "sintra"],
};

const plan = buildSceneQueryPlan({ scene, topic: "Portugal enogastronomico: Porto, Douro e adegas" });

assert(plan.queries.includes("porto wine cellar"), "deveria gerar query de cidade especifica para wine cellar");
assert(plan.queries.includes("porto wine tasting"), "deveria gerar query de cidade especifica para wine tasting");
assert(plan.queries.includes("portugal vineyard tasting"), "deveria gerar fallback por pais para equivalente tematico");
assert(plan.queries.includes("wine tasting experience"), "deveria gerar fallback especifico equivalente sem localizacao");
assert(!plan.queries.includes("porto skyline"), "nao deveria gerar skyline generico para intent de vinho");
assert(plan.negativeKeywords.includes("lisbon"), "deveria preservar negative keywords existentes");
assert(plan.queryDetails.some((entry) => /equivalent_vineyard_tasting/.test(entry.reason)), "deveria explicar fallback equivalente no reason");

console.log("provider search fallback validado com sucesso");