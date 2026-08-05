#!/usr/bin/env node
/**
 * PARTE 2 — Teste: Visual Intent — food→landmark NÃO degradado
 *
 * Cenário: vídeos de gastronomia portuguesa NUNCA devem ter cenas de comida
 * convertidas para city_landmark/historic_street.
 *
 * Regras testadas:
 * - Cena com bacalhau → mantém gastronomy (não vira landmark)
 * - Cena com pastel de nata → mantém pastry (não vira landmark)
 * - Cena com francesinha → mantém gastronomy
 * - Cena com vinho do Porto → mantém wine
 * - Landmark só quando narração pede explicitamente + accepts_landmark=true
 * - establishing_context/intro permite landmark mesmo em gastronomia
 */

const { inferVisualIntent } = require("../src/services/visualIntentService");
const assert = require("assert");

const topic = "Portugal gastronómico: sabores inesquecíveis de Lisboa e Porto";

const FOOD_INTENTS = new Set(["gastronomy", "market", "wine", "pastry", "restaurant", "cafe", "street_food", "local_food"]);
const LANDMARK_INTENTS = new Set(["city_landmark", "aerial_city"]);

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

// ═══════════════════════════════════════════════════════════════════════════
// Testes principais: comida NUNCA deve virar landmark
// ═══════════════════════════════════════════════════════════════════════════

test("Bacalhau mantém intent de gastronomia", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 1,
      role: "body",
      visual_intent: "gastronomy",
      narration_excerpt: "O bacalhau é o rei da gastronomia portuguesa, preparado com azeite e alho",
      keywords: ["bacalhau", "azeite", "comida portuguesa"],
      location: { city: "Lisboa", country: "Portugal" },
    },
    block: { role: "body" },
    topic,
  });
  assert(result.visual_intent !== "city_landmark",
    `Bacalhau foi degradado para "${result.visual_intent}"`);
  assert(FOOD_INTENTS.has(result.visual_intent),
    `Bacalhau deveria ser food intent, mas foi "${result.visual_intent}"`);
});

test("Pastel de nata mantém intent de pastry/gastronomy", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 2,
      role: "body",
      visual_intent: "pastry",
      narration_excerpt: "Os pastéis de nata são a maior tentação de Lisboa",
      keywords: ["pastel de nata", "nata", "doce", "Lisboa"],
      location: { city: "Lisboa", country: "Portugal" },
    },
    block: { role: "body" },
    topic,
  });
  assert(!LANDMARK_INTENTS.has(result.visual_intent),
    `Pastel de nata foi degradado para "${result.visual_intent}"`);
});

test("Francesinha do Porto mantém gastronomy", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 3,
      role: "body",
      visual_intent: "gastronomy",
      narration_excerpt: "A francesinha do Porto é um ícone gastronómico, servida com molho e batata frita",
      keywords: ["francesinha", "porto", "molho"],
      location: { city: "Porto", country: "Portugal" },
    },
    block: { role: "body" },
    topic,
  });
  assert(!LANDMARK_INTENTS.has(result.visual_intent),
    `Francesinha foi degradada para "${result.visual_intent}"`);
});

test("Vinho do Porto mantém wine", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 4,
      role: "body",
      visual_intent: "wine",
      narration_excerpt: "O vinho do Porto envelhece nas caves de Vila Nova de Gaia",
      keywords: ["vinho do porto", "caves", "envelhecimento"],
      location: { city: "Vila Nova de Gaia", country: "Portugal" },
    },
    block: { role: "body" },
    topic,
  });
  assert(!LANDMARK_INTENTS.has(result.visual_intent),
    `Vinho do Porto foi degradado para "${result.visual_intent}"`);
});

test("Sardinhas mantêm food intent", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 5,
      role: "body",
      visual_intent: "gastronomy",
      narration_excerpt: "As sardinhas grelhadas são um clássico dos bairros de Lisboa",
      keywords: ["sardinhas", "grelhadas", "Lisboa"],
      location: { city: "Lisboa", country: "Portugal" },
    },
    block: { role: "body" },
    topic,
  });
  assert(!LANDMARK_INTENTS.has(result.visual_intent),
    `Sardinhas foram degradadas para "${result.visual_intent}"`);
});

test("Marisco mantém food intent", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 6,
      role: "body",
      visual_intent: "gastronomy",
      narration_excerpt: "O marisco fresco chega diariamente aos mercados portugueses",
      keywords: ["marisco", "fresco", "mercado"],
      location: { city: "Lisboa", country: "Portugal" },
    },
    block: { role: "body" },
    topic,
  });
  assert(!LANDMARK_INTENTS.has(result.visual_intent),
    `Marisco foi degradado para "${result.visual_intent}"`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Testes: Landmark só quando explícito e permitido
// ═══════════════════════════════════════════════════════════════════════════

test("Landmark permitido quando narração pede monumento + accepts_landmark=true", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 7,
      role: "body",
      visual_intent: "city_landmark",
      narration_excerpt: "A Torre de Belém é um dos monumentos mais emblemáticos de Lisboa",
      keywords: ["torre de belém", "monumento", "Lisboa"],
      location: { city: "Lisboa", country: "Portugal" },
      accepts_landmark: true,
    },
    block: { role: "body" },
    topic,
  });
  // Com accepts_landmark=true + landmark reference explícito, deve ser permitido
  assert(result.visual_intent === "city_landmark" || LANDMARK_INTENTS.has(result.visual_intent),
    `Landmark permitido deveria ser city_landmark/historic_street, mas foi "${result.visual_intent}"`);
});

test("Landmark permitido para establishing_context", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 8,
      role: "intro",
      visual_intent: "city_landmark",
      narration_excerpt: "Lisboa, cidade das sete colinas, banhada pelo rio Tejo",
      keywords: ["lisboa", "cidade", "panorama"],
      location: { city: "Lisboa", country: "Portugal" },
      content_slot_type: "establishing_context",
      accepts_landmark: true,
    },
    block: { role: "intro" },
    topic,
  });
  // Intro + establishing_context deve permitir landmark
  assert(result.visual_intent === "city_landmark" || LANDMARK_INTENTS.has(result.visual_intent),
    `Intro establishing deveria ser landmark, mas foi "${result.visual_intent}"`);
});

test("Landmark BLOQUEADO quando cena de comida não tem accepts_landmark", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 9,
      role: "body",
      visual_intent: "gastronomy",
      narration_excerpt: "Os sabores de Lisboa vão muito além dos monumentos",
      keywords: ["sabores", "comida", "Lisboa"],
      location: { city: "Lisboa", country: "Portugal" },
      accepts_landmark: false,
    },
    block: { role: "body" },
    topic,
  });
  // Mesmo em Lisboa, se a cena é de gastronomia sem accepts_landmark, não deve virar landmark
  assert(!LANDMARK_INTENTS.has(result.visual_intent),
    `Comida sem accepts_landmark foi convertida para "${result.visual_intent}"`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Testes: Sinais fortes de comida em texto
// ═══════════════════════════════════════════════════════════════════════════

test("'Sabores' + 'mercado' mantém food intent", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 10,
      role: "body",
      visual_intent: "market",
      narration_excerpt: "No mercado do Bolhão, os sabores são intensos e autênticos",
      keywords: ["mercado", "bolhao", "sabores", "porto"],
      location: { city: "Porto", country: "Portugal" },
    },
    block: { role: "body" },
    topic,
  });
  assert(!LANDMARK_INTENTS.has(result.visual_intent),
    `Mercado/sabores foi degradado para "${result.visual_intent}"`);
});

test("'Restaurante' + 'tasca' mantém food intent", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 11,
      role: "body",
      visual_intent: "restaurant",
      narration_excerpt: "Numa tasca típica de Lisboa, o bacalhau é servido com muito azeite",
      keywords: ["tasca", "bacalhau", "restaurante", "lisboa"],
      location: { city: "Lisboa", country: "Portugal" },
    },
    block: { role: "body" },
    topic,
  });
  assert(!LANDMARK_INTENTS.has(result.visual_intent),
    `Restaurante/tasca foi degradado para "${result.visual_intent}"`);
});

test("'Café' + 'pastelaria' mantém cafe/pastry", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 12,
      role: "body",
      visual_intent: "pastry",
      narration_excerpt: "Num café em Belém, a pastelaria portuguesa brilha com os pastéis de nata",
      keywords: ["café", "pastelaria", "nata", "belem"],
      location: { city: "Lisboa", country: "Portugal" },
    },
    block: { role: "body" },
    topic,
  });
  assert(!LANDMARK_INTENTS.has(result.visual_intent),
    `Café/pastelaria foi degradado para "${result.visual_intent}"`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Testes: Generic intent + tópico gastronomia — NÃO deve virar landmark
// ═══════════════════════════════════════════════════════════════════════════

test("Cena genérica em tópico gastronómico não vira city_landmark", () => {
  const result = inferVisualIntent({
    scene: {
      scene_index: 13,
      role: "body",
      narration_excerpt: "Uma viagem pelos sabores autênticos de Portugal",
      keywords: ["viagem", "sabores", "portugal"],
      location: { city: "Lisboa", country: "Portugal" },
    },
    block: { role: "body" },
    topic,
  });
  // Em tópico gastronómico, cena genérica NÃO deve virar city_landmark
  assert(!LANDMARK_INTENTS.has(result.visual_intent),
    `Genérico em gastronomia não deveria ser landmark, mas foi "${result.visual_intent}"`);
});

// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n=== Resultado: ${passed} passaram, ${failed} falharam ===`);
process.exit(failed > 0 ? 1 : 0);
