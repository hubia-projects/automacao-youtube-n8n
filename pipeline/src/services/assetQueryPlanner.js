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
  "vendor",
  "stall",
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

const BLOCK_RETRIEVAL_BUDGET_DEFAULTS = {
  raw_candidates_per_block: 60,
  cheap_shortlist_per_block: 20,
  vision_finalists_per_block: 8,
  max_repair_rounds_per_block: 1,
};

const getCitySearchTermsFromBlock = (block = {}) =>
  unique([
    normalizeLabel(block.expected_location || ""),
    normalizeLabel(block.location?.city || ""),
    normalizeLabel(block.block_label || ""),
  ]).filter(Boolean);

const getCountrySearchTermsFromBlock = (block = {}, topic = "") =>
  unique([
    normalizeLabel(block.location?.country || (/portugal/i.test(topic) ? "Portugal" : "")),
  ]).filter(Boolean);

const getBlockSceneKeywords = (block = {}) =>
  unique(
    (block.keywords || [])
      .map((keyword) => normalizeLabel(keyword).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim())
      .filter((keyword) => keyword && keyword.split(/\s+/).length <= 5)
  );

const applyBlockBudgetToQueries = ({ entries = [], budgetProfile = {} }) => {
  const maxQueries = Math.max(8, Math.min(36, Number(budgetProfile.max_queries || 24)));
  const ranked = [...entries]
    .map((entry, index) => ({ ...entry, _priority: Number(entry.priority || 1), _index: index }))
    .sort((left, right) => right._priority - left._priority || left._index - right._index)
    .slice(0, maxQueries)
    .sort((left, right) => left._index - right._index)
    .map(({ _priority, _index, ...entry }) => entry);
  return {
    entries: ranked,
    trimmed: ranked.length < entries.length,
  };
};

const buildBlockQueryPlan = ({
  block = {},
  slots = [],
  topic = "",
  repairHints = {},
  budgetProfile = {},
}) => {
  const entries = [];
  const seen = new Set();
  const boundaryExpectedLocation = normalizeLabel(repairHints.boundary_expected_location || "");
  const cityTerms = unique([
    boundaryExpectedLocation,
    ...getCitySearchTermsFromBlock(block),
  ]).filter(Boolean);
  const countryTerms = getCountrySearchTermsFromBlock(block, topic);
  const blockKeywords = getBlockSceneKeywords(block);
  const intent = block.visual_intent || block.intent || "generic_travel";
  const negativeKeywords = unique([
    ...(block.negative_keywords || []),
    ...(block.forbidden_locations || []),
    ...(repairHints.extra_negative_keywords || []),
    ...((repairHints.avoid_visual_families || []).map((family) => String(family || "").split("|")[0]).filter(Boolean)),
  ]);
  const mergedBudget = {
    ...BLOCK_RETRIEVAL_BUDGET_DEFAULTS,
    ...(budgetProfile || {}),
  };
  const pushSlotQuery = ({ query, reason, slot, priorityDelta = 0 }) => {
    const before = entries.length;
    pushQuery({
      entries,
      seen,
      query,
      reason,
      scene: {
        visual_intent: intent,
        generic_asset_allowed: slot.generic_tolerance !== "low",
      },
    });
    if (entries.length <= before) return;
    const index = entries.length - 1;
    entries[index] = {
      ...entries[index],
      slot_id: slot.slot_id,
      slot_type: slot.slot_type,
      priority: Number(slot.priority || 1) + Number(priorityDelta || 0),
      content_need: slot.slot_type,
      requires_visual_proof: slot.requires_visual_proof === true,
    };
  };

  (slots || [])
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0))
    .forEach((slot) => {
      const slotHints = unique([
        ...(slot.query_hints || []),
        ...blockKeywords.slice(0, 3),
        ...(INTENT_QUERY_LIBRARY[intent] || []).slice(0, 4),
      ]).slice(0, 6);

      cityTerms.forEach((cityTerm) => {
        slotHints.forEach((hint, index) => {
          pushSlotQuery({
            query: `${cityTerm} ${hint}`,
            reason: `slot_${slot.slot_type}_${slot.slot_id}_city_${index + 1}`,
            slot,
            priorityDelta: 0,
          });
        });
      });

      countryTerms.forEach((countryTerm) => {
        slotHints.slice(0, 4).forEach((hint, index) => {
          pushSlotQuery({
            query: `${countryTerm} ${hint}`,
            reason: `slot_${slot.slot_type}_${slot.slot_id}_country_${index + 1}`,
            slot,
            priorityDelta: -0.5,
          });
        });
      });
    });

  const repairMicroNeeds = unique((repairHints.target_micro_needs || []).map((need) => normalizeLabel(need))).filter(Boolean);
  const repairMicroQueries = unique((repairHints.micro_repair_queries || []).map((query) => normalizeLabel(query))).filter(Boolean);
  const diversityRepairQueries = unique((repairHints.diversity_repair_queries || []).map((query) => normalizeLabel(query))).filter(Boolean);
  const slotByType = new Map((slots || []).map((slot) => [String(slot.slot_type || "").toLowerCase(), slot]));
  repairMicroNeeds.forEach((need) => {
    const matchingSlot = slotByType.get(need) || slotByType.get("proof_exact") || (slots || [])[0] || {};
    const baseNeedQuery = String(need || "").replace(/_/g, " ").trim();
    cityTerms.forEach((cityTerm) => {
      pushSlotQuery({
        query: `${cityTerm} ${baseNeedQuery} authentic real action`,
        reason: `repair_micro_need_${need}_city_${buildReasonToken(cityTerm)}`,
        slot: {
          ...matchingSlot,
          slot_id: matchingSlot.slot_id || `repair_micro_${need}`,
          slot_type: matchingSlot.slot_type || need,
          priority: Number(matchingSlot.priority || 1) + 3,
          generic_tolerance: "low",
          requires_visual_proof: true,
        },
        priorityDelta: 2,
      });
    });
    countryTerms.forEach((countryTerm) => {
      pushSlotQuery({
        query: `${countryTerm} ${baseNeedQuery} authentic real action`,
        reason: `repair_micro_need_${need}_country_${buildReasonToken(countryTerm)}`,
        slot: {
          ...matchingSlot,
          slot_id: matchingSlot.slot_id || `repair_micro_${need}`,
          slot_type: matchingSlot.slot_type || need,
          priority: Number(matchingSlot.priority || 1) + 2,
          generic_tolerance: "low",
          requires_visual_proof: true,
        },
        priorityDelta: 1,
      });
    });
  });
  repairMicroQueries.forEach((query, index) => {
    const matchingSlot = (slots || [])[0] || {};
    pushSlotQuery({
      query,
      reason: `repair_micro_query_${index + 1}`,
      slot: {
        ...matchingSlot,
        slot_id: matchingSlot.slot_id || `repair_micro_query_${index + 1}`,
        slot_type: matchingSlot.slot_type || "proof_exact",
        priority: Number(matchingSlot.priority || 1) + 2,
        generic_tolerance: "low",
        requires_visual_proof: true,
      },
      priorityDelta: 2,
    });
  });
  diversityRepairQueries.forEach((query, index) => {
    const matchingSlot = (slots || []).find((slot) => slot.requires_visual_proof === true) || (slots || [])[0] || {};
    pushSlotQuery({
      query,
      reason: `repair_diversity_query_${index + 1}`,
      slot: {
        ...matchingSlot,
        slot_id: matchingSlot.slot_id || `repair_diversity_query_${index + 1}`,
        slot_type: matchingSlot.slot_type || "proof_exact",
        priority: Number(matchingSlot.priority || 1) + 2,
        generic_tolerance: "low",
        requires_visual_proof: true,
      },
      priorityDelta: 2,
    });
    cityTerms.forEach((cityTerm) => {
      pushSlotQuery({
        query: `${cityTerm} ${query}`,
        reason: `repair_diversity_query_${index + 1}_city_${buildReasonToken(cityTerm)}`,
        slot: {
          ...matchingSlot,
          slot_id: matchingSlot.slot_id || `repair_diversity_query_${index + 1}`,
          slot_type: matchingSlot.slot_type || "proof_exact",
          priority: Number(matchingSlot.priority || 1) + 3,
          generic_tolerance: "low",
          requires_visual_proof: true,
        },
        priorityDelta: 2,
      });
    });
  });

  if (repairHints.require_location_match === true && boundaryExpectedLocation) {
    const boundarySlot = (slots || []).find((slot) => slot.required === true && slot.requires_visual_proof === true)
      || (slots || [])[0]
      || {};
    const boundaryQueries = [
      `${boundaryExpectedLocation} street level authentic local people`,
      `${boundaryExpectedLocation} local market real footage`,
      `${boundaryExpectedLocation} food district walking people`,
    ];
    boundaryQueries.forEach((query, index) => {
      pushSlotQuery({
        query,
        reason: `repair_boundary_location_${index + 1}`,
        slot: {
          ...boundarySlot,
          slot_id: boundarySlot.slot_id || `repair_boundary_location_${index + 1}`,
          slot_type: boundarySlot.slot_type || "context_regional",
          priority: Number(boundarySlot.priority || 1) + 4,
          generic_tolerance: "low",
          requires_visual_proof: true,
        },
        priorityDelta: 3,
      });
    });
  }

  if (!entries.length) {
    const emergency = unique([
      cityTerms[0],
      countryTerms[0],
      ...blockKeywords.slice(0, 2),
      isFoodIntent(intent) ? "food market" : "authentic local scene",
    ]).filter(Boolean).join(" ");

    const before = entries.length;
    pushQuery({
      entries,
      seen,
      query: emergency,
      reason: "block_emergency_fallback",
      scene: {
        visual_intent: intent,
        generic_asset_allowed: true,
      },
    });
    if (entries.length > before) {
      entries[entries.length - 1] = {
        ...entries[entries.length - 1],
        slot_id: "fallback_safe",
        slot_type: "fallback_safe",
        priority: 1,
        content_need: "fallback_safe",
        requires_visual_proof: false,
      };
    }
  }

  const budgeted = applyBlockBudgetToQueries({
    entries,
    budgetProfile: {
      ...mergedBudget,
      max_queries: Math.max(10, Math.min(36, Number((slots || []).length * 4 || 16))),
    },
  });
  const maxQueries = Math.max(10, Math.min(36, Number((slots || []).length * 4 || 16)));
  const bestBySlot = new Map();
  [...entries]
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0))
    .forEach((entry) => {
      if (!entry.slot_id) return;
      if (bestBySlot.has(entry.slot_id)) return;
      bestBySlot.set(entry.slot_id, entry);
    });
  const mergedByCoverage = [];
  const seenMerged = new Set();
  [...bestBySlot.values(), ...budgeted.entries].forEach((entry) => {
    const key = `${entry.slot_id || ""}::${entry.query}`;
    if (seenMerged.has(key)) return;
    seenMerged.add(key);
    mergedByCoverage.push(entry);
  });
  const finalEntries = mergedByCoverage.slice(0, maxQueries);

  return {
    queries: finalEntries.map((entry) => entry.query),
    queryDetails: finalEntries.map((entry) => ({
      query: entry.query,
      reason: entry.reason,
      slot_id: entry.slot_id,
      slot_type: entry.slot_type,
      priority: Number(entry.priority || 1),
      content_need: entry.content_need || entry.slot_type || "",
      requires_visual_proof: entry.requires_visual_proof === true,
    })),
    negativeKeywords,
    retrievalBudget: {
      ...mergedBudget,
      max_queries: Math.max(10, Math.min(36, Number((slots || []).length * 4 || 16))),
      trimmed: budgeted.trimmed,
    },
    searchReason: `block_content_package_${normalizeLabel(intent || "generic_travel")}`,
  };
};

module.exports = {
  GASTRONOMY_TERMS,
  INTENT_QUERY_LIBRARY,
  BLOCK_RETRIEVAL_BUDGET_DEFAULTS,
  buildSceneQueryPlan,
  buildBlockQueryPlan,
  containsGastronomyTerm,
  isFoodIntent,
  __test__: {
    buildBlockQueryPlan,
    buildSceneQueryPlan,
    containsGastronomyTerm,
    isFoodIntent,
  },
};
