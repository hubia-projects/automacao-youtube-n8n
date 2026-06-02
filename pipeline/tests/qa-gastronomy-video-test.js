const assert = require("assert");
const { __test__: syncValidatorTest } = require("../src/services/syncValidator");

const weakCoverage = syncValidatorTest.evaluateVisualIntentCoverage({
  state: {
    topic: "Gastronomia de Lisboa",
  },
  timeline: {
    clips: [
      {
        clip_index: 1,
        scene_index: 1,
        visual_intent: "gastronomy",
        visual_intent_match: false,
        detected_visual_categories: ["aerial_city", "bridge", "river"],
      },
      {
        clip_index: 2,
        scene_index: 2,
        visual_intent: "market",
        visual_intent_match: false,
        detected_visual_categories: ["generic_street"],
      },
      {
        clip_index: 3,
        scene_index: 3,
        visual_intent: "restaurant",
        visual_intent_match: false,
        detected_visual_categories: ["landscape"],
      },
      {
        clip_index: 4,
        scene_index: 4,
        visual_intent: "gastronomy",
        visual_intent_match: false,
        detected_visual_categories: ["aerial_city", "coast"],
      },
    ],
  },
});

assert.strictEqual(weakCoverage.applicable, true, "tema gastronómico deveria ativar quotas especificas");
assert(weakCoverage.issues.some((issue) => issue.type === "theme_visual_mismatch"), "deveria bloquear video gastronómico dominado por cidade/paisagem");
assert(weakCoverage.issues.some((issue) => issue.type === "generic_asset_overuse"), "deveria detectar excesso de cidade genérica");
assert(weakCoverage.scene_indexes_to_refresh.length >= 3, "deveria marcar cenas erradas para refresh seletivo");

const strongCoverage = syncValidatorTest.evaluateVisualIntentCoverage({
  state: {
    topic: "Gastronomia do Porto",
  },
  timeline: {
    clips: [
      {
        clip_index: 1,
        scene_index: 1,
        visual_intent: "gastronomy",
        visual_intent_match: true,
        detected_visual_categories: ["food", "restaurant"],
      },
      {
        clip_index: 2,
        scene_index: 2,
        visual_intent: "market",
        visual_intent_match: true,
        detected_visual_categories: ["market", "food"],
      },
      {
        clip_index: 3,
        scene_index: 3,
        visual_intent: "wine",
        visual_intent_match: true,
        detected_visual_categories: ["wine", "restaurant"],
      },
      {
        clip_index: 4,
        scene_index: 4,
        visual_intent: "restaurant",
        visual_intent_match: true,
        detected_visual_categories: ["restaurant", "people_eating"],
      },
      {
        clip_index: 5,
        scene_index: 5,
        visual_intent: "pastry",
        visual_intent_match: true,
        detected_visual_categories: ["pastry", "food"],
      },
      {
        clip_index: 6,
        scene_index: 6,
        visual_intent: "gastronomy",
        visual_intent_match: true,
        detected_visual_categories: ["food", "cafe"],
      },
      {
        clip_index: 7,
        scene_index: 7,
        visual_intent: "market",
        visual_intent_match: true,
        detected_visual_categories: ["market", "street_food"],
      },
      {
        clip_index: 8,
        scene_index: 8,
        visual_intent: "wine",
        visual_intent_match: true,
        detected_visual_categories: ["wine", "restaurant"],
      },
    ],
  },
});

assert.strictEqual(strongCoverage.issues.length, 0, "mix visual forte de gastronomia nao deveria gerar issues");

const scoreFeaturesFallbackCoverage = syncValidatorTest.evaluateVisualIntentCoverage({
  state: {
    topic: "Gastronomia do Porto",
  },
  timeline: {
    clips: [
      {
        clip_index: 1,
        scene_index: 1,
        visual_intent: "gastronomy",
        visual_intent_match: true,
        detected_visual_categories: [],
        score_features: { detectedVisualCategories: ["food", "restaurant"] },
      },
      {
        clip_index: 2,
        scene_index: 2,
        visual_intent: "market",
        visual_intent_match: true,
        detected_visual_categories: [],
        score_features: { detectedVisualCategories: ["market", "street_food"] },
      },
      {
        clip_index: 3,
        scene_index: 3,
        visual_intent: "wine",
        visual_intent_match: true,
        detected_visual_categories: [],
        score_features: { detectedVisualCategories: ["wine", "restaurant"] },
      },
      {
        clip_index: 4,
        scene_index: 4,
        visual_intent: "cafe",
        visual_intent_match: true,
        detected_visual_categories: [],
        score_features: { detectedVisualCategories: ["cafe", "people_eating"] },
      },
    ],
  },
});

assert.strictEqual(scoreFeaturesFallbackCoverage.issues.length, 0, "QA deveria aceitar categorias vindas de score_features quando o clip persistido ainda nao foi enriquecido");

const mixedFoodStreetCoverage = syncValidatorTest.evaluateVisualIntentCoverage({
  state: {
    topic: "Gastronomia de Lisboa",
  },
  timeline: {
    clips: [
      {
        clip_index: 1,
        scene_index: 1,
        visual_intent: "gastronomy",
        visual_intent_match: true,
        detected_visual_categories: ["food", "market", "historic_street"],
      },
      {
        clip_index: 2,
        scene_index: 2,
        visual_intent: "market",
        visual_intent_match: true,
        detected_visual_categories: ["market", "street_food", "historic_street"],
      },
      {
        clip_index: 3,
        scene_index: 3,
        visual_intent: "wine",
        visual_intent_match: true,
        detected_visual_categories: ["wine", "restaurant", "river"],
      },
      {
        clip_index: 4,
        scene_index: 4,
        visual_intent: "cafe",
        visual_intent_match: true,
        detected_visual_categories: ["cafe", "people_eating", "historic_street"],
      },
    ],
  },
});

assert(!mixedFoodStreetCoverage.issues.some((issue) => issue.type === "generic_asset_overuse"), "cena de comida forte com rua historica nao deveria inflar generic_asset_overuse por si so");

const mixedTravelCoverage = syncValidatorTest.evaluateVisualIntentCoverage({
  state: {
    topic: "5 melhores paises da Europa para visitar no verao",
  },
  timeline: {
    clips: [
      {
        clip_index: 1,
        scene_index: 1,
        visual_intent: "coast",
        visual_intent_match: true,
        detected_visual_categories: ["coast"],
      },
      {
        clip_index: 2,
        scene_index: 2,
        visual_intent: "generic_travel",
        visual_intent_match: true,
        detected_visual_categories: ["city_landmark"],
      },
      {
        clip_index: 3,
        scene_index: 3,
        visual_intent: "gastronomy",
        visual_intent_match: true,
        detected_visual_categories: ["food", "restaurant"],
      },
      {
        clip_index: 4,
        scene_index: 4,
        visual_intent: "coast",
        visual_intent_match: true,
        detected_visual_categories: ["coast"],
      },
      {
        clip_index: 5,
        scene_index: 5,
        visual_intent: "generic_travel",
        visual_intent_match: true,
        detected_visual_categories: ["historic_street"],
      },
      {
        clip_index: 6,
        scene_index: 6,
        visual_intent: "river",
        visual_intent_match: true,
        detected_visual_categories: ["river"],
      },
    ],
  },
});

assert.strictEqual(mixedTravelCoverage.applicable, false, "video de viagem com uma unica cena de comida nao deveria ativar quotas gastronomicas");
assert.strictEqual(mixedTravelCoverage.issues.length, 0, "video de viagem misto nao deveria herdar bloqueios de gastronomia");

console.log("qa gastronomy video validado com sucesso");