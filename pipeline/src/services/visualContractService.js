const { config } = require("../config/env");
const path = require("path");
const fs = require("fs-extra");
const { normalizeLabel } = require("./visualIntentService");
const { loadState, updateState, ensureVideoStructure } = require("./stateService");
const { writeJsonAtomic } = require("../utils/fileUtils");
const { logger } = require("../utils/logger");

const unique = (values = []) => [...new Set(values.filter(Boolean))];
const round3 = (value) => Number(Number(value || 0).toFixed(3));

// ─── Constantes de tema dominante ───────────────────────────────────────────

const GASTRONOMY_THEME_PATTERN = /(gastronom|comida|food|culinaria|sabores|prato|restaurant|restaurante|cafe|mercado|market|vinho|wine|pastel|bacalhau|francesinha|marisco|seafood|doce|docaria|confeitaria|cozinha|chef)/i;

const CITY_MAP_BY_NORMALIZED = {
  lisboa: { city: "Lisboa", country: "Portugal" },
  lisbon: { city: "Lisboa", country: "Portugal" },
  porto: { city: "Porto", country: "Portugal" },
  oporto: { city: "Porto", country: "Portugal" },
  faro: { city: "Faro", country: "Portugal" },
  sintra: { city: "Sintra", country: "Portugal" },
  coimbra: { city: "Coimbra", country: "Portugal" },
  algarve: { city: "Algarve", country: "Portugal" },
};

// ─── Cobertura global para gastronomia ──────────────────────────────────────

const GASTRONOMY_GLOBAL_COVERAGE = {
  required: {
    // food/market/restaurant/wine/pastry/cafe/people_eating >= 70%
    min_food_coverage_ratio: 0.70,
    // Pelo menos 2 momentos de evidência forte de comida para Lisboa
    min_lisboa_food_evidence_moments: 2,
    // Pelo menos 2 momentos de evidência forte de comida para Porto
    min_porto_food_evidence_moments: 2,
    // Pelo menos 1 wine/cellar/tasting se Porto ou vinho é mencionado
    min_wine_moments_if_porto_or_vinho: 1,
    // Pelo menos 1 pastry/cafe se pastel/nata/café é mencionado
    min_pastry_moments_if_mentioned: 1,
    // Pelo menos 1 restaurant/table/people_eating
    min_restaurant_moments: 1,
  },
  max: {
    max_city_landmark_ratio: 0.15,
    max_aerial_city_ratio: 0.10,
    max_bridge_river_monument_combined_ratio: 0.15,
    max_generic_travel_ratio: 0.10,
    max_same_visual_family_ratio: 0.12,
    max_same_asset_uses: 1,
    max_same_landmark_appearances: 2,
  },
};

const NON_FOOD_VISUAL_INTENTS = new Set([
  "city_landmark",
  "aerial_city",
  "bridge",
  "river",
  "coast",
  "historic_street",
  "generic_travel",
  "generic_street",
  "landscape",
  "clouds",
]);

const FOOD_VISUAL_INTENTS = new Set([
  "gastronomy",
  "market",
  "wine",
  "pastry",
  "restaurant",
  "cafe",
  "street_food",
  "local_food",
]);

const FOOD_VISUAL_CATEGORIES = new Set([
  "food",
  "local_food",
  "market",
  "restaurant",
  "wine",
  "pastry",
  "cafe",
  "street_food",
  "people_eating",
]);

const ESTABLISHING_SLOT_TYPES = new Set([
  "establishing_context",
  "chapter_transition",
  "outro_context",
]);

const CONTENT_SLOT_TYPES = {
  gastronomy: [
    "food_closeup",
    "market_stall",
    "wine_pouring",
    "wine_tasting",
    "pastry_closeup",
    "restaurant_table",
    "people_eating",
    "vendor_interaction",
  ],
  market: ["market_stall", "vendor_interaction", "food_closeup"],
  wine: ["wine_pouring", "wine_tasting", "restaurant_table"],
  pastry: ["pastry_closeup", "restaurant_table", "people_eating"],
  restaurant: ["restaurant_table", "people_eating", "food_closeup"],
  cafe: ["people_eating", "pastry_closeup", "restaurant_table"],
};

// ─── Detecção de entidades ──────────────────────────────────────────────────

const FOOD_DISH_ENTITIES = [
  "bacalhau", "bacalhau a bras", "sardinha", "sardinhas", "marisco", "mariscos",
  "polvo", "lula", "lulas", "camarao", "camaroes", "cataplana", "francesinha",
  "francesinhas", "pastel de nata", "pasteis de nata", "nata", "vinho do porto",
  "vinho verde", "azeite", "queijo", "queijo da serra", "pao", "broa", "alheira",
  "alheiras", "cozido", "cozido a portuguesa", "grelhado", "grelhados",
  "doce", "doces", "docaria", "confeitaria", "tasca", "tascas", "taberna",
  "feira", "feiras", "degustacao", "atum", "salmao", "dourada",
];

const detectFoodDishes = (text = "") => {
  const normalized = normalizeLabel(text);
  return FOOD_DISH_ENTITIES.filter((dish) => normalized.includes(normalizeLabel(dish)));
};

const detectCities = (text = "") => {
  const normalized = normalizeLabel(text);
  const cities = [];
  Object.entries(CITY_MAP_BY_NORMALIZED).forEach(([key, info]) => {
    if (normalized.includes(key)) cities.push(info.city);
  });
  return unique(cities);
};

const detectSearchEntities = (text = "", scene = {}) => {
  const dishes = detectFoodDishes(text);
  const cities = detectCities(text);
  const keywords = (scene.keywords || []).slice(0, 10);
  return unique([...dishes, ...cities, ...keywords]);
};

const detectLocationEntities = (text = "", scene = {}) => {
  const cities = detectCities(text);
  const expectedLocation = scene.location?.city || scene.block_label || "";
  if (expectedLocation && !cities.includes(expectedLocation)) {
    cities.unshift(expectedLocation);
  }
  return cities;
};

// ─── Inferência de intenção visual por micro_moment ─────────────────────────

const VISUAL_INTENT_PATTERNS = [
  { intent: "market", pattern: /(market|mercado|food hall|stall|banca|feira|fresh fish|produce|bolhao)/i },
  { intent: "wine", pattern: /(wine|vinho|wine tasting|vineyard|grapes|uvas|barrel|cellar|adega|degustacao)/i },
  { intent: "pastry", pattern: /(pastry|pastel|nata|bakery|confeitaria|docaria|dessert|sobremesa|doce|doces)/i },
  { intent: "restaurant", pattern: /(restaurant|restaurante|menu|chef plating|table service|fine dining|people eating|tasca)/i },
  { intent: "cafe", pattern: /(cafe|coffee|espresso|barista|coffee shop|cafeteria)/i },
  { intent: "street_food", pattern: /(street food|food truck|food vendor|food stall|snack stand)/i },
  { intent: "gastronomy", pattern: /(food|meal|dish|plate|seafood|bacalhau|codfish|francesinha|gastronom|comida|prato|sabores|culinaria)/i },
];

const inferVisualIntentForText = (text = "", topic = "") => {
  const combined = `${text} ${topic}`;
  const matchedIntents = VISUAL_INTENT_PATTERNS
    .filter((entry) => entry.pattern.test(combined))
    .map((entry) => entry.intent);

  if (matchedIntents.length >= 2 && matchedIntents.some((i) => FOOD_VISUAL_INTENTS.has(i))) {
    return "gastronomy";
  }

  if (matchedIntents[0] && FOOD_VISUAL_INTENTS.has(matchedIntents[0])) {
    return matchedIntents[0];
  }

  const isGastronomyTopic = GASTRONOMY_THEME_PATTERN.test(topic);
  if (isGastronomyTopic && /(food|meal|dish|plate|seafood|comida|prato)/i.test(combined)) {
    return "gastronomy";
  }

  return matchedIntents[0] || "gastronomy";
};

const inferTopicType = (text = "", visualIntent = "") => {
  if (FOOD_VISUAL_INTENTS.has(visualIntent)) return "food";
  if (/(landmark|monument|castle|tower|cathedral|palace)/i.test(text)) return "landmark";
  if (/(street|bairro|neighborhood|alfama|ribeira)/i.test(text)) return "street";
  if (/(bridge|river|ponte|rio)/i.test(text)) return "bridge_river";
  if (/(aerial|drone|skyline|panorama)/i.test(text)) return "aerial";
  return "general";
};

// ─── Construção de micro_moments ────────────────────────────────────────────

const buildMicroMoment = ({
  id,
  startSec,
  endSec,
  narrationExcerpt = "",
  scene = {},
  topic = "",
  dominantTheme = "",
}) => {
  const visualIntent = scene.visual_intent || inferVisualIntentForText(narrationExcerpt, topic);
  const isFoodTheme = dominantTheme === "gastronomy" || GASTRONOMY_THEME_PATTERN.test(topic);
  const topicType = inferTopicType(narrationExcerpt, visualIntent);
  const isEstablishing = ESTABLISHING_SLOT_TYPES.has(scene.content_slot_type || "");

  const city = scene.location?.city || scene.expected_location || detectCities(narrationExcerpt)[0] || "";
  const country = scene.location?.country || "Portugal";
  const dishes = detectFoodDishes(narrationExcerpt);
  const searchEntities = detectSearchEntities(narrationExcerpt, scene);
  const locationEntities = detectLocationEntities(narrationExcerpt, scene);

  // Determinar allowed/forbidden categories baseado no tema dominante
  let allowedVisualCategories = [];
  let forbiddenVisualCategories = [];
  let requiredVisualEvidence = [];
  let acceptsLandmark = false;

  if (isFoodTheme && !isEstablishing) {
    allowedVisualCategories = [...FOOD_VISUAL_CATEGORIES];
    forbiddenVisualCategories = ["city_landmark", "aerial_city", "bridge", "river", "coast", "generic_street", "clouds", "landscape"];
    requiredVisualEvidence = dishes.length >= 2
      ? ["food", "local_food", "people_eating"]
      : ["food", "local_food"];
    acceptsLandmark = false;
    if (dishes.length > 0) {
      allowedVisualCategories.push("food");
    }
  } else if (isEstablishing) {
    allowedVisualCategories = [...FOOD_VISUAL_CATEGORIES, "city_landmark", "historic_street", "aerial_city"];
    forbiddenVisualCategories = ["bridge", "river", "coast", "clouds", "generic_street"];
    requiredVisualEvidence = ["city_landmark", "historic_street"];
    acceptsLandmark = true;
  } else {
    allowedVisualCategories = ["city_landmark", "historic_street", "aerial_city", "river", "coast", "food", "local_food", "restaurant"];
    forbiddenVisualCategories = ["clouds", "generic_street"];
    requiredVisualEvidence = ["city_landmark"];
    acceptsLandmark = true;
  }

  const contentSlotType = scene.content_slot_type
    || (CONTENT_SLOT_TYPES[visualIntent] || [visualIntent])[0];

  const criticality = (isFoodTheme && !isEstablishing && dishes.length > 0)
    ? "critical"
    : isEstablishing
    ? "low"
    : "medium";

  return {
    id: id || `mm_${Math.round(startSec)}_${Math.round(endSec)}`,
    start_sec: round3(startSec),
    end_sec: round3(endSec),
    narration_excerpt: narrationExcerpt.slice(0, 200),
    city,
    country,
    topic_type: topicType,
    visual_intent: visualIntent,
    required_visual_evidence: requiredVisualEvidence,
    allowed_visual_categories: allowedVisualCategories,
    forbidden_visual_categories: forbiddenVisualCategories,
    content_slot_type: contentSlotType,
    criticality,
    max_generic_seconds: isFoodTheme && criticality === "critical" ? 0 : 3,
    accepts_establishing_shot: isEstablishing,
    accepts_landmark: acceptsLandmark,
    search_entities: searchEntities,
    dish_entities: dishes,
    location_entities: locationEntities,
    minimum_confidence: criticality === "critical" ? 0.85 : 0.60,
  };
};

// ─── Geração do visual_contract ─────────────────────────────────────────────

const generateVisualContract = async ({ videoId, topic = "", niche = "" }) => {
  const state = await loadState(videoId);
  const scriptText = state.script_text || topic || "";
  const visualPlan = Array.isArray(state.visual_plan) && state.visual_plan.length
    ? state.visual_plan
    : [];
  
  // Carregar audio_intelligence do path se disponível
  let audioIntelligence = null;
  if (state.audio_intelligence_path) {
    try {
      const { getCachedAudioIntelligence } = require("./audioIntelligence");
      audioIntelligence = await getCachedAudioIntelligence({ videoId }).catch(() => null);
    } catch {
      audioIntelligence = null;
    }
  }
  // Fallback: usar audio_intelligence direto do state se disponível
  if (!audioIntelligence) {
    audioIntelligence = state.audio_intelligence || null;
  }

  const isGastronomy = GASTRONOMY_THEME_PATTERN.test(`${topic} ${niche} ${scriptText}`);
  const dominantTheme = isGastronomy ? "gastronomy" : "general_travel";
  const cities = detectCities(`${topic} ${scriptText}`);

  // Construir micro_moments a partir do visual_plan ou do script
  let microMoments = [];

  if (visualPlan.length > 0 && audioIntelligence?.words?.length > 0) {
    // Usar audio_intelligence para timestamps reais
    const words = audioIntelligence.words;
    const totalDuration = audioIntelligence.speaking_rate?.total_duration_seconds
      || Number(state.duration_seconds || 0);

    visualPlan.forEach((scene, index) => {
      const sceneStart = Number(scene.script_start_seconds || 0);
      const sceneEnd = Number(scene.script_end_seconds || totalDuration);
      const sceneWords = words.filter(
        (w) => Number(w.start || 0) < sceneEnd && Number(w.end || 0) > sceneStart
      );
      const narrationExcerpt = sceneWords
        .map((w) => w.word)
        .filter(Boolean)
        .join(" ");

      const momentsPerScene = Math.max(1, Math.ceil((sceneEnd - sceneStart) / 8));
      const momentDuration = (sceneEnd - sceneStart) / momentsPerScene;

      for (let i = 0; i < momentsPerScene; i++) {
        const startSec = sceneStart + i * momentDuration;
        const endSec = Math.min(sceneEnd, startSec + momentDuration);
        const momentWords = words.filter(
          (w) => Number(w.start || 0) < endSec && Number(w.end || 0) > startSec
        );
        const momentExcerpt = momentWords.map((w) => w.word).filter(Boolean).join(" ");

        microMoments.push(buildMicroMoment({
          id: `mm_${scene.scene_index || index + 1}_${i + 1}`,
          startSec,
          endSec,
          narrationExcerpt: momentExcerpt || narrationExcerpt,
          scene,
          topic,
          dominantTheme,
        }));
      }
    });
  } else {
    // Fallback: estimativa por texto sem timestamps reais
    const paragraphs = scriptText.split(/\n{2,}/).filter((p) => p.trim().length > 20);
    const totalParagraphs = Math.max(1, paragraphs.length);
    const estimatedDuration = Number(state.duration_seconds || 600);
    const secPerParagraph = estimatedDuration / totalParagraphs;

    paragraphs.forEach((paragraph, index) => {
      const startSec = index * secPerParagraph;
      const endSec = (index + 1) * secPerParagraph;

      // Dividir parágrafos longos em múltiplos micro_moments
      const sentences = paragraph.split(/[.!?]+/).filter((s) => s.trim().length > 10);
      if (sentences.length <= 2) {
        microMoments.push(buildMicroMoment({
          id: `mm_p${index + 1}_1`,
          startSec,
          endSec,
          narrationExcerpt: paragraph,
          scene: visualPlan[index] || {},
          topic,
          dominantTheme,
        }));
      } else {
        const secPerSentence = secPerParagraph / sentences.length;
        sentences.forEach((sentence, sIndex) => {
          microMoments.push(buildMicroMoment({
            id: `mm_p${index + 1}_${sIndex + 1}`,
            startSec: startSec + sIndex * secPerSentence,
            endSec: Math.min(endSec, startSec + (sIndex + 1) * secPerSentence),
            narrationExcerpt: sentence,
            scene: visualPlan[index] || {},
            topic,
            dominantTheme,
          }));
        });
      }
    });
  }

  // Calcular cobertura global
  const foodMoments = microMoments.filter((m) =>
    FOOD_VISUAL_INTENTS.has(m.visual_intent)
  );
  const landmarkMoments = microMoments.filter((m) =>
    m.visual_intent === "city_landmark"
  );
  const aerialMoments = microMoments.filter((m) =>
    m.visual_intent === "aerial_city"
  );
  const bridgeRiverMoments = microMoments.filter((m) =>
    ["bridge", "river"].includes(m.visual_intent)
  );
  const genericTravelMoments = microMoments.filter((m) =>
    m.visual_intent === "generic_travel"
  );

  const totalMoments = Math.max(1, microMoments.length);
  const foodRatio = foodMoments.length / totalMoments;
  const landmarkRatio = landmarkMoments.length / totalMoments;
  const aerialRatio = aerialMoments.length / totalMoments;
  const bridgeRiverRatio = bridgeRiverMoments.length / totalMoments;
  const genericRatio = genericTravelMoments.length / totalMoments;

  const lisboaFoodMoments = foodMoments.filter((m) =>
    normalizeLabel(m.city).includes("lisboa")
  );
  const portoFoodMoments = foodMoments.filter((m) =>
    normalizeLabel(m.city).includes("porto")
  );
  const wineMoments = foodMoments.filter((m) =>
    m.visual_intent === "wine" || m.dish_entities.some((d) => /vinho|wine/i.test(d))
  );
  const pastryMoments = foodMoments.filter((m) =>
    m.visual_intent === "pastry" || m.dish_entities.some((d) => /pastel|nata|cafe|doce|docaria/i.test(d))
  );
  const restaurantMoments = foodMoments.filter((m) =>
    m.visual_intent === "restaurant" || m.dish_entities.some((d) => /restaurant|restaurante|tasca|mesa/i.test(d))
  );

  const coverageStatus = {
    food_ratio: round3(foodRatio),
    landmark_ratio: round3(landmarkRatio),
    aerial_ratio: round3(aerialRatio),
    bridge_river_ratio: round3(bridgeRiverRatio),
    generic_ratio: round3(genericRatio),
    lisboa_food_moments: lisboaFoodMoments.length,
    porto_food_moments: portoFoodMoments.length,
    wine_moments: wineMoments.length,
    pastry_moments: pastryMoments.length,
    restaurant_moments: restaurantMoments.length,
  };

  const coverageWarnings = [];
  if (isGastronomy) {
    if (foodRatio < GASTRONOMY_GLOBAL_COVERAGE.required.min_food_coverage_ratio) {
      coverageWarnings.push(`food_coverage ${round3(foodRatio * 100)}% < ${round3(GASTRONOMY_GLOBAL_COVERAGE.required.min_food_coverage_ratio * 100)}% required`);
    }
    if (landmarkRatio > GASTRONOMY_GLOBAL_COVERAGE.max.max_city_landmark_ratio) {
      coverageWarnings.push(`landmark_coverage ${round3(landmarkRatio * 100)}% > ${round3(GASTRONOMY_GLOBAL_COVERAGE.max.max_city_landmark_ratio * 100)}% max`);
    }
    if (cities.includes("Lisboa") && lisboaFoodMoments.length < GASTRONOMY_GLOBAL_COVERAGE.required.min_lisboa_food_evidence_moments) {
      coverageWarnings.push(`Lisboa food evidence: ${lisboaFoodMoments.length} < ${GASTRONOMY_GLOBAL_COVERAGE.required.min_lisboa_food_evidence_moments} required`);
    }
    if (cities.includes("Porto") && portoFoodMoments.length < GASTRONOMY_GLOBAL_COVERAGE.required.min_porto_food_evidence_moments) {
      coverageWarnings.push(`Porto food evidence: ${portoFoodMoments.length} < ${GASTRONOMY_GLOBAL_COVERAGE.required.min_porto_food_evidence_moments} required`);
    }
  }

  const visualContract = {
    video_topic: topic,
    niche: niche || dominantTheme,
    dominant_theme: dominantTheme,
    required_global_coverage: isGastronomy ? GASTRONOMY_GLOBAL_COVERAGE.required : {},
    max_global_coverage: isGastronomy ? GASTRONOMY_GLOBAL_COVERAGE.max : {},
    cities,
    total_micro_moments: microMoments.length,
    food_moments_count: foodMoments.length,
    non_food_moments_count: microMoments.length - foodMoments.length,
    coverage_status: coverageStatus,
    coverage_warnings: coverageWarnings,
    micro_moments: microMoments,
  };

  const paths = await ensureVideoStructure(videoId);
  const reportsDir = path.join(paths.base, "reports");
  const contractPath = path.join(reportsDir, "visual_contract.json");
  
  // Escrever JSON do contrato em disco
  await fs.ensureDir(reportsDir);
  await writeJsonAtomic(contractPath, visualContract);

  const updated = await updateState(videoId, {
    visual_contract: visualContract,
    visual_contract_path: contractPath,
    visual_contract_summary: `${dominantTheme} | ${microMoments.length} micro-moments | ${foodMoments.length} food | ${coverageWarnings.length} warnings`,
  });

  logger.info("visualContractService: contrato gerado", {
    videoId,
    dominant_theme: dominantTheme,
    micro_moments: microMoments.length,
    food_ratio: round3(foodRatio),
    warnings: coverageWarnings.length,
  });

  return {
    video_id: videoId,
    visual_contract: visualContract,
    state_path: updated.state_path,
  };
};

const getVisualContract = async (videoId) => {
  const state = await loadState(videoId);
  return state.visual_contract || null;
};

const refineWithAudioIntelligence = async (videoId) => {
  const state = await loadState(videoId);
  if (!state.visual_contract) {
    logger.warn("visualContractService: sem contrato para refinar", { videoId });
    return null;
  }

  const audioIntelligence = state.audio_intelligence || null;
  if (!audioIntelligence?.words?.length) {
    return state.visual_contract;
  }

  // Refinar timestamps dos micro_moments com base nos pause_markers reais
  const pauseMarkers = audioIntelligence.pause_markers || [];
  const refinedMoments = state.visual_contract.micro_moments.map((moment) => {
    const nearbyPauses = pauseMarkers
      .filter((p) => Math.abs(Number(p.start || 0) - moment.end_sec) < 2)
      .sort((a, b) => Math.abs(Number(a.start || 0) - moment.end_sec) - Math.abs(Number(b.start || 0) - moment.end_sec));

    if (nearbyPauses.length > 0 && nearbyPauses[0].duration >= 0.35) {
      return {
        ...moment,
        end_sec: round3(Number(nearbyPauses[0].start || moment.end_sec)),
      };
    }
    return moment;
  });

  const updated = await updateState(videoId, {
    visual_contract: {
      ...state.visual_contract,
      micro_moments: refinedMoments,
      refined_with_audio: true,
    },
  });

  logger.info("visualContractService: contrato refinado com audio_intelligence", {
    videoId,
    micro_moments: refinedMoments.length,
  });

  return updated.visual_contract;
};

module.exports = {
  generateVisualContract,
  getVisualContract,
  refineWithAudioIntelligence,
  GASTRONOMY_GLOBAL_COVERAGE,
  FOOD_VISUAL_INTENTS,
  NON_FOOD_VISUAL_INTENTS,
  FOOD_VISUAL_CATEGORIES,
  detectCities,
  detectFoodDishes,
  __test__: {
    buildMicroMoment,
    inferVisualIntentForText,
    GASTRONOMY_THEME_PATTERN,
  },
};
