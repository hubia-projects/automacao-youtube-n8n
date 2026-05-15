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

const FOOD_GENERIC_NEGATIVE_KEYWORDS = [
  "skyline",
  "aerial",
  "drone",
  "bridge",
  "river",
  "coast",
  "cityscape",
  "landmark",
  "monument",
  "tram",
  "viewpoint",
];
const GENERIC_TRAVEL_PATTERN = /(skyline|aerial|drone|travel|city street|cityscape|aerial view|bridge|river|coast)/i;

const CITY_QUERY_PRESETS = {
  lisboa: ["lisbon portugal tram", "lisbon alfama street", "lisbon belem tower", "lisbon miradouro", "lisbon portugal city view", "lisbon azulejo street"],
  porto: ["porto portugal ribeira", "porto douro river", "porto dom luis bridge", "porto wine cellar", "porto historic center", "porto cathedral portugal"],
  faro: ["faro portugal old town", "faro marina", "ria formosa portugal", "faro algarve old town", "faro portugal beach islands", "algarve lagoon boats"],
};

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

const INTENT_EQUIVALENT_QUERY_LIBRARY = {
  gastronomy: [
    "local cuisine",
    "traditional dishes",
    "food experience",
    "people eating local food",
  ],
  market: [
    "traditional food market",
    "market stalls food",
    "fresh produce market",
    "local market food",
  ],
  wine: [
    "vineyard tasting",
    "wine tasting experience",
    "vineyard tour wine",
    "cellar wine tasting",
  ],
  pastry: [
    "traditional pastry shop",
    "dessert bakery",
    "bakery dessert close up",
    "pastry coffee table",
  ],
  restaurant: [
    "restaurant table food",
    "traditional restaurant interior",
    "chef plating restaurant",
    "dinner table local food",
  ],
  cafe: [
    "traditional cafe",
    "coffee and pastry cafe",
    "barista coffee shop",
    "coffee table pastry",
  ],
  street_food: [
    "street food vendor",
    "street food market",
    "food stall people eating",
    "street snack stand",
  ],
};

const INTENT_INFERENCE_PATTERNS = [
  { intent: "market", pattern: /(market|mercado|food hall|stall|banca|feira|fresh fish|produce)/i },
  { intent: "wine", pattern: /(wine|vinho|wine tasting|vineyard|grapes|uvas|barrel|cellar|adega)/i },
  { intent: "pastry", pattern: /(pastry|pastel|nata|bakery|dessert|docaria|confeitaria|cake|sweet)/i },
  { intent: "restaurant", pattern: /(restaurant|restaurante|menu|chef plating|table service|fine dining|people eating)/i },
  { intent: "cafe", pattern: /(cafe|coffee|espresso|barista|coffee shop)/i },
  { intent: "street_food", pattern: /(street food|food truck|food vendor|food stall|snack stand)/i },
  { intent: "gastronomy", pattern: /(food|meal|dish|local food|traditional food|seafood|bacalhau|francesinha|gastronom)/i },
];

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

const inferRelatedIntents = ({ scene = {}, topic = "" }) => {
  const combined = [scene.title, scene.narration_excerpt, ...(scene.keywords || []), topic]
    .filter(Boolean)
    .join(" ");

  return unique(INTENT_INFERENCE_PATTERNS.filter((entry) => entry.pattern.test(combined)).map((entry) => entry.intent));
};

const buildSceneKeywordTerms = ({ scene = {} }) =>
  unique(
    (scene.keywords || [])
      .map((keyword) => normalizeLabel(keyword).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim())
      .filter((keyword) => keyword && keyword.split(/\s+/).length <= 5)
  );

const pushTermEntry = ({ entries, seen, term, reasonToken }) => {
  const normalizedTerm = normalizeLabel(term);
  if (!normalizedTerm || seen.has(normalizedTerm)) return;
  seen.add(normalizedTerm);
  entries.push({ term: normalizedTerm, reasonToken });
};

const buildTermEntries = ({ scene = {}, topic = "", intent = "generic_travel" }) => {
  const relatedIntents = unique([intent, ...inferRelatedIntents({ scene, topic })]);
  const exactEntries = [];
  const equivalentEntries = [];
  const seenExact = new Set();
  const seenEquivalent = new Set();

  buildSceneKeywordTerms({ scene }).forEach((term) => {
    pushTermEntry({ entries: exactEntries, seen: seenExact, term, reasonToken: `scene_keyword_${buildReasonToken(term)}` });
  });

  relatedIntents.forEach((relatedIntent) => {
    (INTENT_QUERY_LIBRARY[relatedIntent] || []).forEach((term) => {
      pushTermEntry({
        entries: exactEntries,
        seen: seenExact,
        term,
        reasonToken: `required_${buildReasonToken(term)}${relatedIntent !== intent ? `_via_${buildReasonToken(relatedIntent)}` : ""}`,
      });
    });
  });

  relatedIntents.forEach((relatedIntent) => {
    (INTENT_EQUIVALENT_QUERY_LIBRARY[relatedIntent] || []).forEach((term) => {
      pushTermEntry({
        entries: equivalentEntries,
        seen: seenEquivalent,
        term,
        reasonToken: `equivalent_${buildReasonToken(term)}${relatedIntent !== intent ? `_via_${buildReasonToken(relatedIntent)}` : ""}`,
      });
    });
  });

  return { exactEntries, equivalentEntries };
};

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

const shouldUseCityPresets = ({ scene = {}, intent = "generic_travel" }) =>
  !isFoodIntent(intent) || Boolean(scene.generic_asset_allowed) || ["intro", "outro"].includes(String(scene.role || "body").toLowerCase());

const buildFoodQueries = ({ entries, seen, cityTerms, countryTerms, exactEntries, equivalentEntries, intent, scene }) => {
  cityTerms.forEach((cityTerm) => {
    exactEntries.forEach(({ term, reasonToken }) => {
      pushQuery({
        entries,
        seen,
        query: `${cityTerm} ${term}`,
        reason: `exact_city_${buildReasonToken(cityTerm)}_${reasonToken}`,
        scene,
      });
    });
  });

  countryTerms.forEach((countryTerm) => {
    exactEntries.forEach(({ term, reasonToken }) => {
      pushQuery({
        entries,
        seen,
        query: `${countryTerm} ${term}`,
        reason: `regional_country_${buildReasonToken(countryTerm)}_${reasonToken}`,
        scene,
      });
    });
  });

  exactEntries.forEach(({ term, reasonToken }) => {
    pushQuery({
      entries,
      seen,
      query: term,
      reason: `fallback_exact_${intent}_${reasonToken}`,
      scene,
    });
  });

  countryTerms.forEach((countryTerm) => {
    equivalentEntries.forEach(({ term, reasonToken }) => {
      pushQuery({
        entries,
        seen,
        query: `${countryTerm} ${term}`,
        reason: `regional_equivalent_${buildReasonToken(countryTerm)}_${reasonToken}`,
        scene,
      });
    });
  });

  equivalentEntries.forEach(({ term, reasonToken }) => {
    pushQuery({
      entries,
      seen,
      query: term,
      reason: `fallback_equivalent_${intent}_${reasonToken}`,
      scene,
    });
  });
};

const buildGeneralQueries = ({ entries, seen, cityTerms, countryTerms, scene, intent }) => {
  const generalTerms = unique([
    scene.subtheme || "travel",
    ...buildSceneKeywordTerms({ scene }).slice(0, 4),
  ]);

  cityTerms.forEach((cityTerm) => {
    generalTerms.forEach((term) => {
      pushQuery({
        entries,
        seen,
        query: `${cityTerm} ${term}`,
        reason: `visual_intent_${intent} + city_${buildReasonToken(cityTerm)} + subtheme_${buildReasonToken(term)}`,
        scene,
      });
    });
  });

  countryTerms.forEach((countryTerm) => {
    generalTerms.forEach((term) => {
      pushQuery({
        entries,
        seen,
        query: `${countryTerm} ${term}`,
        reason: `visual_intent_${intent} + country_${buildReasonToken(countryTerm)} + subtheme_${buildReasonToken(term)}`,
        scene,
      });
    });
  });
};

const buildSceneQueryPlan = ({ scene = {}, topic = "" }) => {
  const entries = [];
  const seen = new Set();
  const cityTerms = getCitySearchTerms(scene);
  const countryTerms = getCountrySearchTerms(scene, topic);
  const intent = scene.visual_intent || "generic_travel";
  const role = String(scene.role || "body").toLowerCase();
  const isHardBoundaryScene = Boolean(scene.hard_boundary && (scene.transition_type === "hard" || scene.chapter_card_required));
  const expectedLocation = normalizeLabel(scene.expected_location || scene.location?.city || scene.block_label || "");
  const { exactEntries, equivalentEntries } = buildTermEntries({ scene, topic, intent });
  const negativeKeywords = unique([
    ...(scene.negative_keywords || []),
    ...(scene.forbidden_locations || []),
    ...(isFoodIntent(intent) ? FOOD_GENERIC_NEGATIVE_KEYWORDS : []),
  ]);

  if (isHardBoundaryScene && expectedLocation) {
    pushQuery({
      entries,
      seen,
      query: `${expectedLocation} city intro establishing shot`,
      reason: `hard_boundary_block_intro_asset_${buildReasonToken(expectedLocation)}`,
      scene: { ...scene, generic_asset_allowed: true },
    });
  }

  if (isFoodIntent(intent)) {
    buildFoodQueries({ entries, seen, cityTerms, countryTerms, exactEntries, equivalentEntries, intent, scene });

    if (isHardBoundaryScene && expectedLocation) {
      pushQuery({
        entries,
        seen,
        query: `${expectedLocation} chapter transition card`,
        reason: `hard_boundary_chapter_card_clip_${buildReasonToken(expectedLocation)}`,
        scene: { ...scene, generic_asset_allowed: true },
      });
    }

    if (["intro", "outro"].includes(role)) {
      cityTerms.forEach((cityTerm) => {
        pushQuery({
          entries,
          seen,
          query: `${cityTerm} food city overview`,
          reason: `editorial_bridge_${buildReasonToken(cityTerm)}_${intent}`,
          scene: { ...scene, generic_asset_allowed: true },
        });
      });
    }
  } else {
    buildGeneralQueries({ entries, seen, cityTerms, countryTerms, scene, intent });
  }

  if (shouldUseCityPresets({ scene, intent })) {
    (CITY_QUERY_PRESETS[expectedLocation] || []).forEach((query, index) => {
      pushQuery({
        entries,
        seen,
        query,
        reason: `city_preset_${expectedLocation}_${index + 1}`,
        scene,
      });
    });
  }

  return {
    queries: entries.map((entry) => entry.query),
    queryDetails: entries,
    negativeKeywords,
    hardBoundaryScene: isHardBoundaryScene,
    searchReason: isFoodIntent(intent)
      ? `visual_intent_${intent} + exact_then_regional_then_equivalent`
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