const SOURCE_TIER_PRIORITY = ["premium", "curated", "free", "generated"];

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

module.exports = {
  SOURCE_TIER_PRIORITY,
  resolveNichePolicy,
  DEFAULT_NICHE_POLICY,
};

