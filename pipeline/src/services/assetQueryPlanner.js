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


const CITY_QUERY_PRESETS = {
  lisboa: ["lisbon portugal tram","lisbon alfama street","lisbon belem tower","lisbon miradouro","lisbon portugal city view","lisbon azulejo street"],
  porto: ["porto portugal ribeira","porto douro river","porto dom luis bridge","porto wine cellar","porto historic center","porto cathedral portugal"],
  faro: ["faro portugal old town","faro marina","ria formosa portugal","faro algarve old town","faro portugal beach islands","algarve lagoon boats"],
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
const RETRIEVAL_BUDGET_DEFAULTS = {
  food: { maxQueries: 18, maxDownloads: 6 },
  nonFood: { maxQueries: 12, maxDownloads: 6 },
};

const inferRelatedIntents = ({ scene = {}, topic = "" }) => {
  const combined = [scene.title, scene.narration_excerpt, ...(scene.keywords || []), topic]
    .filter(Boolean)
    .join(" ");

  return unique(
    INTENT_INFERENCE_PATTERNS.filter((entry) => entry.pattern.test(combined)).map((entry) => entry.intent)
  );
};

const buildSceneKeywordTerms = ({ scene = {} }) =>
  unique(
    (scene.keywords || [])
      .map((keyword) => normalizeLabel(keyword).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim())
      .filter((keyword) => keyword && keyword.split(/\s+/).length <= 5)
  );

const buildPrioritizedTermEntries = ({ scene = {}, topic = "", intent = "generic_travel" }) => {
  const relatedIntents = unique([intent, ...inferRelatedIntents({ scene, topic })]);
  const termEntries = [];
  const seenTerms = new Set();

  const pushTermEntry = (term, reasonToken) => {
    const normalizedTerm = normalizeLabel(term);
    if (!normalizedTerm || seenTerms.has(normalizedTerm)) return;
    seenTerms.add(normalizedTerm);
    termEntries.push({ term: normalizedTerm, reasonToken });
  };

  buildSceneKeywordTerms({ scene }).forEach((term) => {
    pushTermEntry(term, `scene_keyword_${buildReasonToken(term)}`);
  });

  relatedIntents.forEach((relatedIntent) => {
    (INTENT_QUERY_LIBRARY[relatedIntent] || []).forEach((term) => {
      pushTermEntry(term, `required_${buildReasonToken(term)}${relatedIntent !== intent ? `_via_${buildReasonToken(relatedIntent)}` : ""}`);
    });
  });

  relatedIntents.forEach((relatedIntent) => {
    (INTENT_EQUIVALENT_QUERY_LIBRARY[relatedIntent] || []).forEach((term) => {
      pushTermEntry(term, `equivalent_${buildReasonToken(term)}${relatedIntent !== intent ? `_via_${buildReasonToken(relatedIntent)}` : ""}`);
    });
  });

  return termEntries;
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

const inferRoleTargets = ({ scene = {}, repairHints = {} }) =>
  unique([
    ...(repairHints.target_narrative_roles || []),
    scene.probable_shot_role || "",
    scene.narrative_function ? `${scene.narrative_function}_role` : "",
  ]).filter(Boolean);

const resolveRetrievalBudget = ({ scene = {}, intent = "", roleTargets = [], forceExactRequired = false }) => {
  const isFood = isFoodIntent(intent);
  const defaults = isFood ? RETRIEVAL_BUDGET_DEFAULTS.food : RETRIEVAL_BUDGET_DEFAULTS.nonFood;
  const role = String(scene.role || "body").toLowerCase();
  const roleBonus = role === "intro" || role === "outro" || scene.hard_boundary ? 2 : 0;
  const roleTargetBonus = roleTargets.some((roleItem) => ["hook_exact", "proof_exact", "closing_payoff", "opening_establishing"].includes(roleItem)) ? 2 : 0;
  const exactBonus = forceExactRequired ? 2 : 0;
  const maxQueries = Math.max(
    6,
    Math.min(24, Number(defaults.maxQueries + roleBonus + roleTargetBonus + exactBonus))
  );
  return {
    max_queries: maxQueries,
    max_downloads: Number(defaults.maxDownloads),
    roles_targeted: roleTargets,
  };
};

const getReasonPriority = (reason = "") => {
  const normalizedReason = String(reason || "");
  if (/hard_boundary|repair_bias/.test(normalizedReason)) return 10;
  if (/city_preset/.test(normalizedReason)) return 9;
  if (/visual_intent_.*\+ city_/.test(normalizedReason)) return 8;
  if (/visual_intent_.*\+ country_/.test(normalizedReason)) return 7;
  if (/fallback_specific|emergency/.test(normalizedReason)) return 6;
  return 5;
};

const applyRetrievalBudget = ({ entries = [], retrievalBudget = {} }) => {
  const maxQueries = Math.max(1, Number(retrievalBudget.max_queries || RETRIEVAL_BUDGET_DEFAULTS.nonFood.maxQueries));
  const ranked = [...entries]
    .map((entry, index) => ({
      ...entry,
      _priority: getReasonPriority(entry.reason),
      _index: index,
    }))
    .sort((left, right) => right._priority - left._priority || left._index - right._index)
    .slice(0, maxQueries)
    .sort((left, right) => left._index - right._index)
    .map(({ _priority, _index, ...entry }) => entry);
  return {
    entries: ranked,
    trimmed: ranked.length < entries.length,
    maxQueries,
  };
};

const buildSceneQueryPlan = ({ scene = {}, topic = "", repairHints = {} }) => {
  const entries = [];
  const seen = new Set();
  const cityTerms = getCitySearchTerms(scene);
  const countryTerms = getCountrySearchTerms(scene, topic);
  const intent = scene.visual_intent || "generic_travel";
  const role = String(scene.role || "body").toLowerCase();
  const isHardBoundaryScene = Boolean(scene.hard_boundary && (scene.transition_type === "hard" || scene.chapter_card_required));
  const expectedLocation = normalizeLabel(scene.expected_location || scene.location?.city || scene.block_label || "");
  const prioritizedTermEntries = buildPrioritizedTermEntries({ scene, topic, intent });
  const negativeKeywords = unique([
    ...(scene.negative_keywords || []),
    ...(scene.forbidden_locations || []),
    ...(repairHints.extra_negative_keywords || []),
  ]);
  const targetNarrativeRoles = inferRoleTargets({ scene, repairHints });
  const retrievalBudget = resolveRetrievalBudget({
    scene,
    intent,
    roleTargets: targetNarrativeRoles,
    forceExactRequired: Boolean(repairHints.force_exact_required),
  });

  const cityPreset = CITY_QUERY_PRESETS[expectedLocation] || [];
  cityPreset.forEach((query, index) => {
    pushQuery({
      entries,
      seen,
      query,
      reason: `city_preset_${expectedLocation}_${index + 1}`,
      scene,
    });
  });

  if (isHardBoundaryScene && expectedLocation) {
    pushQuery({
      entries,
      seen,
      query: `${expectedLocation} city intro establishing shot`,
      reason: `hard_boundary_block_intro_asset_${buildReasonToken(expectedLocation)}`,
      scene,
    });
    pushQuery({
      entries,
      seen,
      query: `${expectedLocation} chapter transition card`,
      reason: `hard_boundary_chapter_card_clip_${buildReasonToken(expectedLocation)}`,
      scene: { ...scene, generic_asset_allowed: true },
    });
  }

  if (isFoodIntent(intent)) {
    const prioritizedCityTerms = prioritizedTermEntries.slice(0, 8);
    const prioritizedCountryTerms = prioritizedTermEntries.slice(0, 6);
    const prioritizedFallbackTerms = prioritizedTermEntries.slice(0, 4);
    cityTerms.forEach((cityTerm) => {
      prioritizedCityTerms.forEach(({ term, reasonToken }) => {
        pushQuery({
          entries,
          seen,
          query: `${cityTerm} ${term}`,
          reason: `visual_intent_${intent} + city_${buildReasonToken(cityTerm)} + ${reasonToken}`,
          scene,
        });
      });
    });

    countryTerms.forEach((countryTerm) => {
      prioritizedCountryTerms.forEach(({ term, reasonToken }) => {
        pushQuery({
          entries,
          seen,
          query: `${countryTerm} ${term}`,
          reason: `visual_intent_${intent} + country_${buildReasonToken(countryTerm)} + ${reasonToken}`,
          scene,
        });
      });
    });

    prioritizedFallbackTerms.forEach(({ term, reasonToken }) => {
      pushQuery({
        entries,
        seen,
        query: term,
        reason: `visual_intent_${intent} + fallback_specific_${reasonToken}`,
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
  }

  const repairBiasQueries = [];
  if (targetNarrativeRoles.includes("proof_exact") && expectedLocation) {
    repairBiasQueries.push(`${expectedLocation} real close up authentic scene`);
  }
  if (targetNarrativeRoles.includes("hook_exact") && expectedLocation) {
    repairBiasQueries.push(`${expectedLocation} iconic exact location cinematic`);
  }
  repairBiasQueries.forEach((query, index) => {
    pushQuery({
      entries,
      seen,
      query,
      reason: `repair_bias_${index + 1}`,
      scene,
    });
  });

  if (!entries.length) {
    const emergencyTokens = unique([
      expectedLocation,
      normalizeLabel(scene.block_label || ""),
      ...buildSceneKeywordTerms({ scene }).slice(0, 2),
      isFoodIntent(intent) ? "food market" : "authentic local scene",
    ]).filter(Boolean);
    const emergencyQuery = emergencyTokens.slice(0, 4).join(" ").trim();
    if (emergencyQuery) {
      pushQuery({
        entries,
        seen,
        query: emergencyQuery,
        reason: `emergency_fallback_${buildReasonToken(intent || "generic_travel")}`,
        scene: isFoodIntent(intent) ? scene : { ...scene, generic_asset_allowed: true },
      });
    }
  }

  const budgeted = applyRetrievalBudget({ entries, retrievalBudget });
  let finalEntries = budgeted.entries;

  if (isFoodIntent(intent) && countryTerms.includes("portugal")) {
    const mandatoryCountryFallback = "portugal portuguese food";
    const hasMandatory = finalEntries.some((entry) => entry.query === mandatoryCountryFallback);
    if (!hasMandatory && isValidQueryForScene({ query: mandatoryCountryFallback, scene })) {
      finalEntries = [...finalEntries, {
        query: mandatoryCountryFallback,
        reason: `visual_intent_${intent} + country_portugal + required_portuguese_food`,
      }];
      if (finalEntries.length > Number(retrievalBudget.max_queries || 0)) {
        finalEntries = [...finalEntries.slice(0, -1).slice(0, Math.max(0, Number(retrievalBudget.max_queries || 1) - 1)), finalEntries[finalEntries.length - 1]];
      }
    }
  }

  return {
    queries: finalEntries.map((entry) => entry.query),
    queryDetails: finalEntries,
    negativeKeywords,
    preferredProviders: unique(repairHints.preferred_providers || []),
    targetNarrativeRoles,
    forceExactRequired: Boolean(repairHints.force_exact_required),
    retrievalBudget: {
      ...retrievalBudget,
      trimmed: budgeted.trimmed,
    },
    hardBoundaryScene: isHardBoundaryScene,
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
