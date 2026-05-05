const { CITY_ALIASES } = require("./narrativeBlockPlanner");
const { normalizeLabel } = require("./visualIntentService");

const unique = (values = []) => [...new Set(values.filter(Boolean))];

const GASTRONOMY_TERMS = [
  "food",
  "meal",
  "dish",
  "restaurant",
  "cafe",
  "bakery",
  "pastry",
  "market",
  "wine",
  "glass",
  "kitchen",
  "chef",
  "eating",
  "seafood",
  "dessert",
  "coffee",
  "bar",
  "cellar",
  "grapes",
  "vineyard",
  "tasting",
  "pastel",
  "nata",
  "francesinha",
  "bacalhau",
];

const GENERIC_TRAVEL_PATTERN = /(skyline|aerial|drone|travel|city street|cityscape|aerial view|bridge|river|coast)/i;

const INTENT_QUERY_LIBRARY = {
  gastronomy: [
    "food market",
    "traditional restaurant",
    "pastel de nata cafe",
    "portuguese food",
    "seafood restaurant",
    "bakery pastry",
    "local market food",
    "people eating",
    "cafe street food",
  ],
  market: [
    "food market",
    "market food stalls",
    "fresh fish market",
    "people buying food market",
    "local market food",
    "street food market",
  ],
  wine: [
    "wine tasting",
    "wine cellar",
    "wine glass restaurant",
    "wine pouring close up",
    "wine barrel cellar",
    "grapes vineyard",
  ],
  pastry: [
    "pastel de nata cafe",
    "portuguese pastry shop",
    "bakery pastry",
    "traditional portuguese dessert",
    "people eating pastry",
    "coffee pastry cafe",
  ],
  restaurant: [
    "traditional restaurant",
    "portuguese restaurant",
    "seafood restaurant",
    "people eating restaurant",
    "restaurant food close up",
  ],
  cafe: [
    "cafe pastry",
    "coffee pastry cafe",
    "people drinking coffee",
    "people eating pastry",
    "traditional cafe",
  ],
  street_food: [
    "street food",
    "food vendor",
    "people eating street food",
    "food stall",
  ],
};

const buildReasonToken = (term = "") => normalizeLabel(term).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const getLocationEntry = (scene = {}) => {
  const city = scene.location?.city || scene.block_label || "";
  const normalizedCity = normalizeLabel(city);
  return CITY_ALIASES.find((entry) => normalizeLabel(entry.city) === normalizedCity || entry.aliases.some((alias) => normalizeLabel(alias) === normalizedCity)) || null;
};

const getCitySearchTerms = (scene = {}) => {
  const cityEntry = getLocationEntry(scene);
  if (!cityEntry) return [];

  const preferredAlias = cityEntry.aliases.find((alias) => normalizeLabel(alias) !== normalizeLabel(cityEntry.city)) || cityEntry.aliases[0] || cityEntry.city;
  return unique([preferredAlias, cityEntry.city].map((value) => normalizeLabel(value)).filter(Boolean));
};

const getCountrySearchTerms = (scene = {}, topic = "") => {
  const country = scene.location?.country || (/portugal/i.test(topic) ? "Portugal" : "");
  return unique([normalizeLabel(country)].filter(Boolean));
};

const containsGastronomyTerm = (value = "") => GASTRONOMY_TERMS.some((term) => normalizeLabel(value).includes(term));

const isFoodIntent = (visualIntent = "") => ["gastronomy", "market", "wine", "pastry", "restaurant", "cafe", "street_food"].includes(visualIntent);

const isValidQueryForScene = ({ query = "", scene = {} }) => {
  const normalizedQuery = normalizeLabel(query);
  if (!normalizedQuery || normalizedQuery.split(/\s+/).length < 2) return false;
  if (isFoodIntent(scene.visual_intent) && !containsGastronomyTerm(normalizedQuery)) return false;
  if (!scene.generic_asset_allowed && GENERIC_TRAVEL_PATTERN.test(normalizedQuery) && !containsGastronomyTerm(normalizedQuery)) return false;
  return true;
};

const pushQuery = ({ entries, seen, query, reason, scene }) => {
  const normalizedQuery = normalizeLabel(query);
  if (!isValidQueryForScene({ query: normalizedQuery, scene })) return;
  if (seen.has(normalizedQuery)) return;
  seen.add(normalizedQuery);
  entries.push({ query: normalizedQuery, reason });
};

const buildSceneQueryPlan = ({ scene = {}, topic = "" }) => {
  const entries = [];
  const seen = new Set();
  const cityTerms = getCitySearchTerms(scene);
  const countryTerms = getCountrySearchTerms(scene, topic);
  const intent = scene.visual_intent || "generic_travel";
  const role = String(scene.role || "body").toLowerCase();
  const intentTerms = INTENT_QUERY_LIBRARY[intent] || INTENT_QUERY_LIBRARY.gastronomy;
  const negativeKeywords = unique(scene.negative_keywords || []);

  if (isFoodIntent(intent)) {
    cityTerms.forEach((cityTerm) => {
      intentTerms.forEach((term) => {
        pushQuery({
          entries,
          seen,
          query: `${cityTerm} ${term}`,
          reason: `visual_intent_${intent} + city_${buildReasonToken(cityTerm)} + required_${buildReasonToken(term)}`,
          scene,
        });
      });
    });

    countryTerms.forEach((countryTerm) => {
      intentTerms.forEach((term) => {
        pushQuery({
          entries,
          seen,
          query: `${countryTerm} ${term}`,
          reason: `visual_intent_${intent} + country_${buildReasonToken(countryTerm)} + required_${buildReasonToken(term)}`,
          scene,
        });
      });
    });

    intentTerms.forEach((term) => {
      pushQuery({
        entries,
        seen,
        query: term,
        reason: `visual_intent_${intent} + fallback_specific_${buildReasonToken(term)}`,
        scene,
      });
    });

    if (role === "intro" || role === "outro") {
      cityTerms.forEach((cityTerm) => {
        pushQuery({
          entries,
          seen,
          query: `${cityTerm} food city overview`,
          reason: `visual_intent_${intent} + establishing_${buildReasonToken(cityTerm)}`,
          scene: { ...scene, generic_asset_allowed: true },
        });
      });
    }
  } else {
    cityTerms.forEach((cityTerm) => {
      pushQuery({
        entries,
        seen,
        query: `${cityTerm} ${scene.subtheme || "travel"}`,
        reason: `city_${buildReasonToken(cityTerm)} + subtheme_${buildReasonToken(scene.subtheme || "travel")}`,
        scene,
      });
    });
  }

  return {
    queries: entries.map((entry) => entry.query),
    queryDetails: entries,
    negativeKeywords,
    searchReason: isFoodIntent(intent)
      ? `visual_intent_${intent} + required_visual_evidence`
      : `visual_intent_${intent} + entity_keywords`,
    specificIntentRequired: isFoodIntent(intent) && !scene.generic_asset_allowed,
  };
};

module.exports = {
  GASTRONOMY_TERMS,
  INTENT_QUERY_LIBRARY,
  buildSceneQueryPlan,
  containsGastronomyTerm,
  isFoodIntent,
  __test__: {
    buildSceneQueryPlan,
    containsGastronomyTerm,
    isFoodIntent,
  },
};