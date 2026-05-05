const unique = (values = []) => [...new Set(values.filter(Boolean))];

const normalizeLabel = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const CATEGORY_PATTERNS = [
  { category: "food", pattern: /(food|meal|dish|plate|plating|seafood|fish|meat|bacalhau|codfish|dessert|sobremesa|menu|chef|kitchen)/i },
  { category: "local_food", pattern: /(local food|traditional food|portuguese food|comida local|comida portuguesa|petiscos|francesinha|bacalhau|seafood)/i },
  { category: "market", pattern: /(market|mercado|food hall|stall|banca|fresh fish|street market|people buying food|vegetables|feira)/i },
  { category: "wine", pattern: /(wine|vinho|wine tasting|vineyard|grapes|uvas|barrel|cellar|adega|wine glass|pouring wine)/i },
  { category: "pastry", pattern: /(pastry|pastel|nata|bakery|boulangerie|dessert|confeitaria|docaria|cake|sweet|sobremesa)/i },
  { category: "restaurant", pattern: /(restaurant|restaurante|dinner table|table service|menu|chef plating|people eating|fine dining)/i },
  { category: "cafe", pattern: /(cafe|coffee|espresso|coffee shop|cafeteria|barista)/i },
  { category: "street_food", pattern: /(street food|food truck|street stall|snack stand|food vendor)/i },
  { category: "people_eating", pattern: /(people eating|eating together|people drinking|table with plates|outdoor dining)/i },
  { category: "city_landmark", pattern: /(landmark|monument|castle|tower|cathedral|palace|historic center|historic district|alfama|belem|ribeira|pena palace)/i },
  { category: "historic_street", pattern: /(historic street|cobblestone|old town|rua historica|ruas estreitas|tram|tram 28|street life)/i },
  { category: "river", pattern: /(river|rio|waterfront|douro|tejo|tagus|boats|ribeira)/i },
  { category: "bridge", pattern: /(bridge|ponte|dom luis)/i },
  { category: "coast", pattern: /(coast|coastline|beach|praia|ocean|sea|waves|marina|cliffs|litoral)/i },
  { category: "aerial_city", pattern: /(aerial|drone|skyline|cityscape|panorama|rooftop|overview|bird.?s eye)/i },
  { category: "generic_street", pattern: /(street|city walk|walking downtown|pedestrians|urban lifestyle)/i },
  { category: "clouds", pattern: /(clouds|sky|sunset sky)/i },
  { category: "landscape", pattern: /(landscape|mountain|nature|panorama|vista geral)/i },
];

const INTENT_CONFIG = {
  gastronomy: {
    required_visual_evidence: ["food", "plate", "market", "restaurant", "people eating"],
    allowed_visual_categories: ["food", "local_food", "market", "wine", "pastry", "restaurant", "cafe", "street_food", "people_eating"],
    forbidden_visual_categories: ["skyline", "aerial_city", "bridge", "river", "clouds", "generic_street", "coast", "landscape"],
    generic_asset_allowed: false,
  },
  local_food: {
    required_visual_evidence: ["food", "plate", "local_food"],
    allowed_visual_categories: ["food", "local_food", "restaurant", "market", "people_eating"],
    forbidden_visual_categories: ["aerial_city", "bridge", "river", "coast", "clouds", "generic_street"],
    generic_asset_allowed: false,
  },
  market: {
    required_visual_evidence: ["market", "food", "people buying food"],
    allowed_visual_categories: ["market", "food", "local_food", "street_food", "people_eating"],
    forbidden_visual_categories: ["skyline", "aerial_city", "bridge", "river", "coast", "clouds", "generic_street"],
    generic_asset_allowed: false,
  },
  wine: {
    required_visual_evidence: ["wine", "glass", "cellar", "grapes"],
    allowed_visual_categories: ["wine", "restaurant", "cafe", "local_food"],
    forbidden_visual_categories: ["skyline", "aerial_city", "bridge", "river", "coast", "clouds", "generic_street"],
    generic_asset_allowed: false,
  },
  pastry: {
    required_visual_evidence: ["pastry", "dessert", "bakery", "cafe"],
    allowed_visual_categories: ["pastry", "cafe", "restaurant", "food", "people_eating"],
    forbidden_visual_categories: ["skyline", "aerial_city", "bridge", "river", "coast", "clouds", "generic_street"],
    generic_asset_allowed: false,
  },
  restaurant: {
    required_visual_evidence: ["restaurant", "food", "table", "people eating"],
    allowed_visual_categories: ["restaurant", "food", "local_food", "wine", "people_eating", "cafe"],
    forbidden_visual_categories: ["skyline", "aerial_city", "bridge", "river", "coast", "clouds", "generic_street"],
    generic_asset_allowed: false,
  },
  cafe: {
    required_visual_evidence: ["cafe", "coffee", "pastry", "people eating"],
    allowed_visual_categories: ["cafe", "pastry", "food", "people_eating", "restaurant"],
    forbidden_visual_categories: ["skyline", "aerial_city", "bridge", "river", "coast", "clouds", "generic_street"],
    generic_asset_allowed: false,
  },
  street_food: {
    required_visual_evidence: ["street food", "food", "people eating"],
    allowed_visual_categories: ["street_food", "food", "market", "people_eating", "local_food"],
    forbidden_visual_categories: ["skyline", "aerial_city", "bridge", "river", "coast", "clouds"],
    generic_asset_allowed: false,
  },
  city_landmark: {
    required_visual_evidence: ["city_landmark"],
    allowed_visual_categories: ["city_landmark", "historic_street", "aerial_city"],
    forbidden_visual_categories: ["coast"],
    generic_asset_allowed: true,
  },
  historic_street: {
    required_visual_evidence: ["historic_street"],
    allowed_visual_categories: ["historic_street", "city_landmark", "generic_street"],
    forbidden_visual_categories: ["coast"],
    generic_asset_allowed: true,
  },
  river: {
    required_visual_evidence: ["river"],
    allowed_visual_categories: ["river", "bridge", "city_landmark"],
    forbidden_visual_categories: ["coast"],
    generic_asset_allowed: true,
  },
  coast: {
    required_visual_evidence: ["coast"],
    allowed_visual_categories: ["coast", "landscape"],
    forbidden_visual_categories: [],
    generic_asset_allowed: true,
  },
  aerial_city: {
    required_visual_evidence: ["aerial_city"],
    allowed_visual_categories: ["aerial_city", "city_landmark", "river"],
    forbidden_visual_categories: ["coast"],
    generic_asset_allowed: true,
  },
  generic_travel: {
    required_visual_evidence: [],
    allowed_visual_categories: ["city_landmark", "historic_street", "aerial_city", "river", "coast", "generic_street"],
    forbidden_visual_categories: [],
    generic_asset_allowed: true,
  },
};

const INTENT_PATTERNS = [
  { intent: "market", pattern: /(market|mercado|food hall|stall|banca|feira|fresh fish)/i },
  { intent: "wine", pattern: /(wine|vinho|wine tasting|grapes|uvas|barrel|cellar|adega|vineyard)/i },
  { intent: "pastry", pattern: /(pastry|pastel|nata|bakery|confeitaria|docaria|dessert|sobremesa)/i },
  { intent: "cafe", pattern: /(cafe|coffee|espresso|barista|coffee shop)/i },
  { intent: "restaurant", pattern: /(restaurant|restaurante|table service|fine dining|people eating)/i },
  { intent: "street_food", pattern: /(street food|food truck|food vendor|snack stand)/i },
  { intent: "local_food", pattern: /(food|meal|dish|plate|chef|kitchen|seafood|bacalhau|francesinha|comida|gastronomia|sabores)/i },
  { intent: "city_landmark", pattern: /(landmark|monument|castle|tower|cathedral|palace|belem|alfama|ribeira|historic center)/i },
  { intent: "historic_street", pattern: /(historic street|old town|cobblestone|ruas estreitas|tram|street life)/i },
  { intent: "river", pattern: /(river|rio|waterfront|douro|tejo|tagus|boats)/i },
  { intent: "coast", pattern: /(coast|coastline|beach|praia|sea|ocean|waves|cliffs)/i },
  { intent: "aerial_city", pattern: /(aerial|drone|skyline|cityscape|panorama|overview)/i },
];

const GASTRONOMY_THEME_PATTERN = /(gastronom|food|meal|dish|restaurant|restaurante|cafe|coffee|bakery|pastry|market|mercado|wine|vinho|dessert|docaria|confeitaria|francesinha|bacalhau|seafood|people eating)/i;
const ESTABLISHING_ALLOWED_ROLES = new Set(["intro", "outro"]);
const SPECIFIC_GASTRONOMY_INTENTS = new Set(["market", "wine", "pastry", "cafe", "restaurant", "street_food", "local_food"]);

const detectVisualCategories = ({ text = "", tags = [], objects = [] } = {}) => {
  const combined = [text, ...(tags || []), ...(objects || [])].filter(Boolean).join(" ");
  return CATEGORY_PATTERNS.filter((entry) => entry.pattern.test(combined)).map((entry) => entry.category);
};

const inferVisualIntent = ({ scene = {}, block = {}, topic = "" } = {}) => {
  const role = String(scene.role || block.role || "body").toLowerCase();
  const combined = [
    scene.title,
    scene.narration_excerpt,
    ...(scene.keywords || []),
    block.label,
    block.topic,
    block.subtheme,
    block.subtheme_label,
    ...(block.block_keywords || []),
    topic,
  ].filter(Boolean).join(" ");

  const matchedIntents = INTENT_PATTERNS.filter((entry) => entry.pattern.test(combined)).map((entry) => entry.intent);
  let visualIntent = matchedIntents[0] || "generic_travel";

  const matchedSpecificGastronomyIntents = matchedIntents.filter((intent) => SPECIFIC_GASTRONOMY_INTENTS.has(intent));
  if (matchedSpecificGastronomyIntents.length >= 2) {
    visualIntent = "gastronomy";
  }

  if (visualIntent === "generic_travel" && GASTRONOMY_THEME_PATTERN.test(`${topic} ${combined}`)) {
    visualIntent = "gastronomy";
  }
  if (["local_food", "market", "wine", "pastry", "restaurant", "cafe", "street_food"].includes(visualIntent) && role === "intro") {
    visualIntent = "gastronomy";
  }

  const baseConfig = INTENT_CONFIG[visualIntent] || INTENT_CONFIG.generic_travel;
  const establishingAllowed = ESTABLISHING_ALLOWED_ROLES.has(role);
  const genericAssetAllowed = baseConfig.generic_asset_allowed || establishingAllowed;
  const forbiddenVisualCategories = genericAssetAllowed
    ? baseConfig.forbidden_visual_categories.filter((category) => !["aerial_city", "city_landmark", "historic_street"].includes(category))
    : baseConfig.forbidden_visual_categories;

  return {
    visual_intent: visualIntent === "local_food" ? "gastronomy" : visualIntent,
    visual_intent_source: visualIntent,
    required_visual_evidence: baseConfig.required_visual_evidence,
    allowed_visual_categories: baseConfig.allowed_visual_categories,
    forbidden_visual_categories: forbiddenVisualCategories,
    generic_asset_allowed: genericAssetAllowed,
    generic_asset_allowed_reason: genericAssetAllowed && !baseConfig.generic_asset_allowed ? "establishing_shot" : "",
    max_generic_establishing_seconds: genericAssetAllowed ? 3 : 0,
  };
};

const evaluateVisualEvidence = ({ scene = {}, window = {}, asset = {} } = {}) => {
  const tags = unique([...(window.tags || []), ...(asset.analysis_tags || []), ...(asset.provider_tags || [])]);
  const detectedObjects = unique(window.detected_objects || []);
  const detectedVisualCategories = unique([
    ...(window.detected_visual_categories || []),
    ...detectVisualCategories({
      text: `${window.summary || ""} ${window.description || ""} ${asset.semantic_text || ""} ${asset.query || ""}`,
      tags,
      objects: detectedObjects,
    }),
  ]);
  const requiredEvidence = unique(scene.required_visual_evidence || []);
  const allowedCategories = unique(scene.allowed_visual_categories || []);
  const forbiddenCategories = unique(scene.forbidden_visual_categories || []);

  const requiredEvidenceFound = requiredEvidence.filter((entry) => {
    const normalized = normalizeLabel(entry).replace(/\s+/g, "_");
    const raw = normalizeLabel(entry);
    return detectedVisualCategories.some((category) => normalizeLabel(category) === normalized || normalizeLabel(category) === raw)
      || tags.some((tag) => normalizeLabel(tag).includes(raw))
      || detectedObjects.some((objectName) => normalizeLabel(objectName).includes(raw));
  });
  const missingRequiredEvidence = requiredEvidence.filter((entry) => !requiredEvidenceFound.includes(entry));
  const matchedAllowedCategories = detectedVisualCategories.filter((category) => allowedCategories.includes(category));
  const matchedForbiddenCategories = detectedVisualCategories.filter((category) => forbiddenCategories.includes(category));
  const genericVisual = detectedVisualCategories.some((category) => ["aerial_city", "bridge", "river", "coast", "generic_street", "clouds", "landscape"].includes(category))
    && !matchedAllowedCategories.length;
  const visualIntentMatch = scene.generic_asset_allowed
    ? matchedForbiddenCategories.length === 0
    : requiredEvidence.length === 0
      ? matchedForbiddenCategories.length === 0
      : requiredEvidenceFound.length > 0 && matchedForbiddenCategories.length === 0;

  return {
    detected_visual_categories: detectedVisualCategories,
    detected_objects: detectedObjects,
    required_evidence_found: requiredEvidenceFound,
    missing_required_visual_evidence: missingRequiredEvidence,
    matched_allowed_categories: matchedAllowedCategories,
    matched_forbidden_categories: matchedForbiddenCategories,
    required_evidence_score: requiredEvidence.length ? requiredEvidenceFound.length / requiredEvidence.length : matchedAllowedCategories.length ? 1 : 0,
    allowed_category_score: allowedCategories.length ? matchedAllowedCategories.length / allowedCategories.length : 0,
    forbidden_category_penalty: forbiddenCategories.length ? matchedForbiddenCategories.length / forbiddenCategories.length : 0,
    visual_intent_match: visualIntentMatch,
    generic_visual: genericVisual,
  };
};

module.exports = {
  CATEGORY_PATTERNS,
  INTENT_CONFIG,
  detectVisualCategories,
  evaluateVisualEvidence,
  inferVisualIntent,
  normalizeLabel,
  __test__: {
    detectVisualCategories,
    evaluateVisualEvidence,
    inferVisualIntent,
  },
};