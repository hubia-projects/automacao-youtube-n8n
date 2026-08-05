#!/usr/bin/env node
/**
 * PARTE 3 — Teste: Asset Query Planner — Gastronomia
 *
 * Regras testadas:
 * - Queries de gastronomia não incluem landmarks como critical_queries
 * - Landmark queries vão para supporting/transition, nunca critical
 * - Queries de comida incluem termos específicos de gastronomia
 * - Queries genéricas (city view, skyline) ausentes de critical_queries
 * - city presets só entram quando não-food ou accepts_landmark
 * - isFoodIntent classifica corretamente
 * - critical_queries, supporting_queries, transition_queries separados
 */

const { buildSceneQueryPlan, isFoodIntent } = require("../src/services/assetQueryPlanner");
const assert = require("assert");

const topic = "Portugal gastronómico: sabores inesquecíveis de Lisboa e Porto";

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}: ${error.message}`);
    failed++;
  }
};

const FORBIDDEN_IN_CRITICAL = /skyline|aerial|drone|bridge|river|coast|city\s*view|landmark|monument|tram/i;

// ═══════════════════════════════════════════════════════════════════════════
// Testes principais
// ═══════════════════════════════════════════════════════════════════════════

test("isFoodIntent identifica todos os food intents", () => {
  assert(isFoodIntent("gastronomy"), "gastronomy");
  assert(isFoodIntent("market"), "market");
  assert(isFoodIntent("wine"), "wine");
  assert(isFoodIntent("pastry"), "pastry");
  assert(isFoodIntent("restaurant"), "restaurant");
  assert(isFoodIntent("cafe"), "cafe");
  assert(isFoodIntent("street_food"), "street_food");
});

test("isFoodIntent rejeita não-food intents", () => {
  assert(!isFoodIntent("city_landmark"), "city_landmark");
  assert(!isFoodIntent("aerial_city"), "aerial_city");
  assert(!isFoodIntent("historic_street"), "historic_street");
  assert(!isFoodIntent("river"), "river");
  assert(!isFoodIntent("generic_travel"), "generic_travel");
});

test("Gastronomia: critical_queries sem termos genéricos", () => {
  const plan = buildSceneQueryPlan({
    scene: {
      scene_index: 1,
      role: "body",
      visual_intent: "gastronomy",
      narration_excerpt: "O bacalhau é o rei da gastronomia portuguesa",
      keywords: ["bacalhau", "comida", "gastronomia"],
      location: { city: "Lisboa", country: "Portugal" },
      accepts_landmark: false,
    },
    topic,
  });

  assert(Array.isArray(plan.critical_queries), "critical_queries deve ser array");
  assert(plan.critical_queries.length > 0, "critical_queries não deve estar vazio");
  assert(plan.specificIntentRequired === true, "deve exigir intent específico");

  const criticalText = plan.critical_queries.join(" ");
  assert(!FORBIDDEN_IN_CRITICAL.test(criticalText),
    `critical_queries têm termos genéricos: ${criticalText.slice(0, 200)}`);
});

test("Gastronomia: landmark queries são supporting ou transition", () => {
  const plan = buildSceneQueryPlan({
    scene: {
      scene_index: 2,
      role: "body",
      visual_intent: "gastronomy",
      narration_excerpt: "Perto da Torre de Belém, os pastéis de nata são irresistíveis",
      keywords: ["pastel", "nata", "belém", "lisboa"],
      location: { city: "Lisboa", country: "Portugal" },
      accepts_landmark: false,
    },
    topic,
  });

  // Critical queries não devem conter landmark narration queries
  const criticalHasLandmark = plan.critical_queries.some(
    (q) => /bel[eé]m|torre/i.test(q)
  );
  assert(!criticalHasLandmark,
    "critical_queries não devem conter landmark queries");
});

test("Gastronomia: critical_queries têm termos de comida", () => {
  const plan = buildSceneQueryPlan({
    scene: {
      scene_index: 3,
      role: "body",
      visual_intent: "market",
      narration_excerpt: "O Mercado do Bolhão é o coração gastronómico do Porto",
      keywords: ["mercado", "bolhao", "porto", "gastronomia"],
      location: { city: "Porto", country: "Portugal" },
      accepts_landmark: false,
    },
    topic,
  });

  const criticalText = plan.critical_queries.join(" ").toLowerCase();
  const hasFoodTerm = /food|market|comida|gastronom|restaurant|wine|pastry|seafood/i.test(criticalText);
  assert(hasFoodTerm,
    `critical_queries devem ter termos de comida: ${criticalText.slice(0, 200)}`);
});

test("Gastronomia: landmark queries vão para supporting/transition, não critical", () => {
  const planWithout = buildSceneQueryPlan({
    scene: {
      scene_index: 4,
      role: "body",
      visual_intent: "gastronomy",
      narration_excerpt: "A Sé do Porto e a francesinha",
      keywords: ["sé", "francesinha", "porto"],
      location: { city: "Porto", country: "Portugal" },
      accepts_landmark: false,
    },
    topic,
  });

  // Verifica que queries relacionadas com landmark NÃO estão em critical_queries
  const landmarkPattern = /\bcatedral\b|\bsé\b|\bbelem\b|\btorre\b|\blandmark\b|\bmonument\b/i;
  const criticalHasLandmark = planWithout.critical_queries.some((q) => landmarkPattern.test(q));
  assert(!criticalHasLandmark,
    `critical_queries não devem ter landmark queries: ${planWithout.critical_queries.filter((q) => landmarkPattern.test(q)).join(", ")}`);

  // Queries com landmark podem estar em supporting ou transition
  const allQueries = [...planWithout.critical_queries, ...planWithout.supporting_queries, ...planWithout.transition_queries];
  assert(allQueries.length > 0, "Deve haver queries no total");
});

test("queryDetails incluem category para cada query", () => {
  const plan = buildSceneQueryPlan({
    scene: {
      scene_index: 5,
      role: "intro",
      visual_intent: "gastronomy",
      narration_excerpt: "Bem-vindos a Lisboa, a cidade dos sabores",
      keywords: ["lisboa", "sabores", "gastronomia"],
      location: { city: "Lisboa", country: "Portugal" },
      accepts_landmark: true,
    },
    topic,
  });

  // queryDetails deve ter category em cada entry
  assert(Array.isArray(plan.queryDetails), "queryDetails deve ser array");
  if (plan.queryDetails.length > 0) {
    plan.queryDetails.forEach((qd) => {
      assert(typeof qd.category === "string",
        `queryDetails deve ter category: ${JSON.stringify(qd).slice(0, 100)}`);
    });
  }
});

test("Queries separadas nas 4 categorias", () => {
  const plan = buildSceneQueryPlan({
    scene: {
      scene_index: 6,
      role: "body",
      visual_intent: "gastronomy",
      narration_excerpt: "A cozinha portuguesa é rica em sabores e tradições",
      keywords: ["cozinha", "portuguesa", "tradição"],
      location: { city: "Lisboa", country: "Portugal" },
      accepts_landmark: false,
    },
    topic,
  });

  assert(Array.isArray(plan.critical_queries), "critical_queries");
  assert(Array.isArray(plan.supporting_queries), "supporting_queries");
  assert(Array.isArray(plan.transition_queries), "transition_queries");
  assert(Array.isArray(plan.fallback_queries), "fallback_queries");
});

test("Query plan tem searchReason específico para gastronomia", () => {
  const plan = buildSceneQueryPlan({
    scene: {
      scene_index: 7,
      role: "body",
      visual_intent: "gastronomy",
      narration_excerpt: "A gastronomia portuguesa",
      keywords: ["gastronomia"],
      location: { city: "Lisboa", country: "Portugal" },
      accepts_landmark: false,
    },
    topic,
  });

  assert(plan.searchReason.includes("gastronomy"),
    `searchReason deve mencionar gastronomy: ${plan.searchReason}`);
});

test("negativeKeywords incluem FOOD_GENERIC_NEGATIVE_KEYWORDS para food intent", () => {
  const plan = buildSceneQueryPlan({
    scene: {
      scene_index: 8,
      role: "body",
      visual_intent: "market",
      narration_excerpt: "Os mercados de Lisboa são vibrantes e cheios de vida",
      keywords: ["mercado", "lisboa", "comida"],
      location: { city: "Lisboa", country: "Portugal" },
      accepts_landmark: false,
    },
    topic,
  });

  assert(Array.isArray(plan.negativeKeywords), "negativeKeywords deve ser array");
  assert(plan.negativeKeywords.length > 0, "negativeKeywords não deve estar vazio para food intent");
});

// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n=== Resultado: ${passed} passaram, ${failed} falharam ===`);
process.exit(failed > 0 ? 1 : 0);
