const SOURCE_TIER_PRIORITY = ["premium", "curated", "free", "generated"];
const FOOD_VISUAL_INTENTS = new Set(["gastronomy", "market", "wine", "pastry", "restaurant", "cafe", "street_food"]);

const THEME_REQUIRED_CATEGORIES_BY_INTENT = {
  gastronomy: ["food", "local_food", "market", "restaurant", "cafe", "people_eating", "street_food", "pastry", "wine"],
  market: ["market", "street_food", "food", "local_food", "people_eating"],
  wine: ["wine"],
  pastry: ["pastry", "food", "cafe"],
  restaurant: ["restaurant", "food", "people_eating", "local_food"],
  cafe: ["cafe", "pastry", "people_eating", "food"],
  street_food: ["street_food", "market", "food", "people_eating"],
};

const NICHE_POLICY_BY_INTENT = {
  gastronomy: {
    name: "gastronomy",
    maxGenericRatioPerScene: 0.35,
    minExactOrRegionalForProof: 1,
    maxFreeCriticalSlotsPerBlock: 1,
  },
  market: {
    name: "gastronomy",
    maxGenericRatioPerScene: 0.35,
    minExactOrRegionalForProof: 1,
    maxFreeCriticalSlotsPerBlock: 1,
  },
  wine: {
    name: "gastronomy",
    maxGenericRatioPerScene: 0.35,
    minExactOrRegionalForProof: 1,
    maxFreeCriticalSlotsPerBlock: 1,
  },
  pastry: {
    name: "gastronomy",
    maxGenericRatioPerScene: 0.35,
    minExactOrRegionalForProof: 1,
    maxFreeCriticalSlotsPerBlock: 1,
  },
  restaurant: {
    name: "gastronomy",
    maxGenericRatioPerScene: 0.35,
    minExactOrRegionalForProof: 1,
    maxFreeCriticalSlotsPerBlock: 1,
  },
  cafe: {
    name: "gastronomy",
    maxGenericRatioPerScene: 0.35,
    minExactOrRegionalForProof: 1,
    maxFreeCriticalSlotsPerBlock: 1,
  },
  street_food: {
    name: "gastronomy",
    maxGenericRatioPerScene: 0.35,
    minExactOrRegionalForProof: 1,
    maxFreeCriticalSlotsPerBlock: 1,
  },
  generic_travel: {
    name: "tourism",
    maxGenericRatioPerScene: 0.55,
    minExactOrRegionalForProof: 0,
    maxFreeCriticalSlotsPerBlock: 2,
  },
  city_landmark: {
    name: "tourism",
    maxGenericRatioPerScene: 0.5,
    minExactOrRegionalForProof: 0,
    maxFreeCriticalSlotsPerBlock: 2,
  },
};

const DEFAULT_NICHE_POLICY = {
  name: "lifestyle",
  maxGenericRatioPerScene: 0.6,
  minExactOrRegionalForProof: 0,
  maxFreeCriticalSlotsPerBlock: 2,
};

const resolveNichePolicy = (scene = {}) =>
  NICHE_POLICY_BY_INTENT[scene.visual_intent] || DEFAULT_NICHE_POLICY;

const getThemeRequiredCategoriesForIntent = (intent = "") =>
  THEME_REQUIRED_CATEGORIES_BY_INTENT[String(intent || "").toLowerCase()] || [];

module.exports = {
  FOOD_VISUAL_INTENTS,
  SOURCE_TIER_PRIORITY,
  THEME_REQUIRED_CATEGORIES_BY_INTENT,
  getThemeRequiredCategoriesForIntent,
  resolveNichePolicy,
  DEFAULT_NICHE_POLICY,
};
