const { evaluateVisualEvidence, normalizeLabel } = require("./visualIntentService");
const { isSameLocation } = require("./narrativeBlockPlanner");
const { config } = require("../config/env");
const {
  FOOD_VISUAL_INTENTS,
  getThemeRequiredCategoriesForIntent,
  resolveNichePolicy,
} = require("../config/editorialPolicy");

const VISUAL_TRUTH_STATUSES = ["exact", "regional", "generic", "wrong", "uncertain"];
const EDITORIAL_BINS = [
  "hook_exact",
  "opening_establishing",
  "proof_exact",
  "context_regional",
  "detail_cutaway",
  "bridge_neutral_short",
  "closing_payoff",
];

const PREMIUM_PROVIDERS = new Set(["shutterstock", "artgrid", "storyblocks", "getty", "adobestock"]);
const CURATED_PROVIDERS = new Set(["pond5", "envato", "istock", "local_curated", "library"]);
const GENERATED_PROVIDERS = new Set(["local_fallback", "render_fallback", "ai_generated_placeholder"]);
const WEAK_VISUAL_SOURCES = new Set([
  "metadata_fallback",
  "weak_fallback",
  "local_video_understanding_fallback",
  "local_video_understanding_stub",
  "disabled",
  "script_missing",
]);

const GENERIC_CATEGORY_SET = new Set([
  "aerial_city",
  "bridge",
  "river",
  "coast",
  "generic_street",
  "clouds",
  "landscape",
]);

const unique = (values = []) => [...new Set(values.filter(Boolean))];
const round3 = (value) => Number(Number(value || 0).toFixed(3));
const normalize = (value = "") => String(value || "").toLowerCase().trim();
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value || 0)));
const SLOT_HINT_SYNONYMS = {
  landmark: ["landmark", "monument", "palace", "palacio", "castle", "castelo", "cathedral", "fortress", "historic center"],
  street_level: ["street", "rua", "avenue", "alley", "city street", "pedestrian", "urban"],
  people_walking: ["people", "walking", "pedestrian", "crowd", "street life"],
  wide_establishing: ["wide", "establishing", "panorama", "overview", "aerial"],
  river: ["river", "rio", "waterfront", "douro", "tagus", "tejo"],
};

const MICRO_NEED_RULES = [
  { need: "market_stall", tokens: ["market", "mercado", "banca", "stall", "feira"] },
  { need: "vendor_interaction", tokens: ["vendor", "vendedor", "serving", "servindo", "atendente"] },
  { need: "people_eating", tokens: ["eating", "comendo", "degustando", "tasting"] },
  { need: "pastry_closeup", tokens: ["pastry", "pastel", "dessert", "doces", "bakery"] },
  { need: "food_closeup", tokens: ["food", "comida", "dish", "prato", "ingrediente"] },
  { need: "wine_pouring", tokens: ["wine", "vinho", "pouring", "taça", "glass"] },
  { need: "restaurant_table", tokens: ["restaurant", "restaurante", "table", "mesa", "cafe"] },
  { need: "street_level", tokens: ["street", "rua", "bairro", "walking"] },
  { need: "landmark", tokens: ["landmark", "ponte", "bridge", "tower", "torre", "river", "rio"] },
];
const ACTION_TOKENS = ["serving", "servindo", "comendo", "eating", "buying", "comprando", "cozinhando", "cooking", "pouring", "provar", "tasting"];

const inferSourceTier = (asset = {}) => {
  if (asset.source_tier) return normalizeLabel(asset.source_tier);
  const provider = normalizeLabel(asset.provider);
  if (asset.is_fallback || GENERATED_PROVIDERS.has(provider) || String(asset.source_url || "") === "generated-local") {
    return "generated";
  }
  if (PREMIUM_PROVIDERS.has(provider)) return "premium";
  if (CURATED_PROVIDERS.has(provider)) return "curated";
  return "free";
};

const getAssetId = (asset = {}, index = 0) =>
  asset.asset_id
  || asset.local_path
  || asset.source_url
  || `asset_${index + 1}`;

const getWindowDuration = (window = {}) =>
  Math.max(
    0.25,
    Number(
      window.duration_seconds
      || Math.max(0, Number(window.end_seconds || 0) - Number(window.start_seconds || 0))
      || 0.25
    )
  );

const getExpectedLocation = (scene = {}) =>
  scene.expected_location || scene.location?.city || (scene.topic_type === "city" ? scene.macro_topic : "");

const hasWrongLocation = ({ scene = {}, window = {} }) => {
  const expectedLocation = getExpectedLocation(scene);
  const detectedCity = window.location?.city || "";
  const detectedConfidence = Number(window.location?.confidence || 0);
  if (!expectedLocation || !detectedCity) return false;
  // Avoid false negatives from weak/uncertain city guesses.
  if (detectedConfidence > 0 && detectedConfidence < 0.65) return false;
  return !isSameLocation(detectedCity, expectedLocation);
};

const classifyVisualTruthStatus = ({
  scene = {},
  window = {},
  evidence = {},
  weakVisualSource = false,
}) => {
  if (hasWrongLocation({ scene, window })) return "wrong";
  if ((evidence.matched_forbidden_categories || []).length) return "wrong";

  const requiredCount = Number((scene.required_visual_evidence || []).length);
  const requiredFoundCount = Number((evidence.required_evidence_found || []).length);
  const hasRequiredEvidence = requiredFoundCount > 0;
  const genericVisual = Boolean(evidence.generic_visual);
  const requiredMatchRatio = requiredCount > 0 ? (requiredFoundCount / requiredCount) : 0;
  const semanticRelevanceScore = clamp01(
    evidence.semantic_relevance_score
    ?? evidence.editorial_inference?.semantic_relevance_score
    ?? window.semantic_relevance_score
    ?? window.confidence
    ?? 0
  );
  const editorialEvidenceScore = clamp01(
    evidence.editorial_evidence_score
    ?? evidence.editorial_inference?.editorial_evidence_score
    ?? window.editorial_evidence_score
    ?? evidence.required_evidence_score
    ?? 0
  );
  const semanticRiskScore = clamp01(
    evidence.semantic_risk_score
    ?? evidence.editorial_inference?.semantic_risk_score
    ?? window.semantic_risk_score
    ?? 0
  );
  const maxCriticalRisk = Number(config.CRITICAL_SLOT_MAX_SEMANTIC_RISK || 0.55);
  const normalizedIntent = String(scene.visual_intent || "").toLowerCase();
  const isFoodIntent = ["gastronomy", "market", "wine", "pastry", "restaurant", "cafe", "street_food"].includes(normalizedIntent);
  const themeRequiredCategories = getThemeRequiredCategoriesForIntent(normalizedIntent).map((item) => String(item || "").toLowerCase());
  const detectedCategories = unique([
    ...(evidence.detected_visual_categories || []),
    ...(evidence.required_evidence_found || []),
    ...(evidence.matched_allowed_categories || []),
  ].map((item) => String(item || "").toLowerCase()));
  const foodThemeHits = themeRequiredCategories.filter((category) => detectedCategories.includes(category)).length;
  const observedObjectsOrActions = unique([
    ...(window.detected_objects || []),
    ...(window.detected_visual_categories || []),
    ...(evidence.detected_objects || []),
    ...(evidence.detected_visual_categories || []),
    ...(evidence.required_evidence_found || []),
  ]).length;

  if (requiredCount > 0) {
    if (!observedObjectsOrActions) return "uncertain";
    if (semanticRiskScore > maxCriticalRisk && editorialEvidenceScore < 0.7) return "uncertain";
    if (weakVisualSource) {
      if (!hasRequiredEvidence || genericVisual) return "uncertain";
      return requiredMatchRatio >= 0.7 && !genericVisual ? "regional" : "uncertain";
    }
    if (isFoodIntent && !genericVisual && !weakVisualSource) {
      if (foodThemeHits >= 2) return "exact";
      if (foodThemeHits >= 1) return "regional";
    }
    const minExactHits = isFoodIntent ? Math.min(2, requiredCount) : 1;
    if (
      (requiredFoundCount >= minExactHits || requiredMatchRatio >= 0.5)
      && semanticRelevanceScore >= 0.45
      && editorialEvidenceScore >= 0.55
      && !genericVisual
      && !weakVisualSource
    ) return "exact";
    if (hasRequiredEvidence && !genericVisual) return "regional";
    if (genericVisual) return "generic";
    return "uncertain";
  }

  if (weakVisualSource) return "uncertain";
  if (isFoodIntent && !genericVisual) {
    if (foodThemeHits >= 2) return "exact";
    if (foodThemeHits >= 1) return "regional";
  }
  const allowedMatches = Number((evidence.matched_allowed_categories || []).length);
  if (allowedMatches > 0 && semanticRelevanceScore >= 0.45 && editorialEvidenceScore >= 0.5 && !genericVisual && !weakVisualSource) return "exact";
  if (allowedMatches > 0 && !genericVisual) return "regional";
  if (genericVisual) return "generic";
  return weakVisualSource ? "uncertain" : "regional";
};

const buildNarrativeRolesSupported = ({
  status,
  scene = {},
  window = {},
  evidence = {},
  weakVisualSource = false,
}) => {
  const roles = [];
  const duration = getWindowDuration(window);
  const sceneRole = String(scene.role || "body").toLowerCase();

  if (status === "exact") {
    roles.push("proof_exact", "detail_cutaway", "closing_payoff");
    if (sceneRole === "intro") roles.push("hook_exact", "opening_establishing");
    if (sceneRole === "outro") roles.push("closing_payoff");
  } else if (status === "regional") {
    roles.push("context_regional", "detail_cutaway");
    if (sceneRole === "intro") roles.push("opening_establishing");
    if (sceneRole === "outro") roles.push("closing_payoff");
  } else if (status === "generic") {
    if (duration <= Number(scene.max_generic_establishing_seconds || 3.5)) {
      roles.push("bridge_neutral_short", "detail_cutaway");
      if (sceneRole === "intro" && scene.generic_asset_allowed === true) roles.push("opening_establishing");
    }
  }

  if (weakVisualSource && status !== "exact") {
    return roles.filter((role) => role !== "hook_exact" && role !== "proof_exact" && role !== "closing_payoff");
  }

  if ((evidence.detected_visual_categories || []).some((category) => GENERIC_CATEGORY_SET.has(category)) && scene.visual_intent === "gastronomy") {
    if (status === "generic") {
      return roles.filter((role) => role === "bridge_neutral_short" || role === "detail_cutaway");
    }
    if (status === "regional") {
      return roles.filter((role) => role !== "hook_exact" && role !== "proof_exact" && role !== "closing_payoff");
    }
  }

  return unique(roles);
};

const computeEditorialConfidence = ({ status, evidence = {}, weakVisualSource = false, scene = {} }) => {
  const requiredEvidenceScore = Number(evidence.required_evidence_score || 0);
  const allowedCategoryScore = Number(evidence.allowed_category_score || 0);
  const forbiddenPenalty = Number(evidence.forbidden_category_penalty || 0);
  const semanticRelevanceScore = Number(
    evidence.semantic_relevance_score
    ?? evidence.editorial_inference?.semantic_relevance_score
    ?? 0
  );
  const editorialEvidenceScore = Number(
    evidence.editorial_evidence_score
    ?? evidence.editorial_inference?.editorial_evidence_score
    ?? requiredEvidenceScore
  );
  const semanticRiskScore = Number(
    evidence.semantic_risk_score
    ?? evidence.editorial_inference?.semantic_risk_score
    ?? 0
  );
  const strongSourcePenalty = weakVisualSource ? 0.3 : 0;
  const rolePenalty = scene.generic_asset_allowed === false && status === "generic" ? 0.2 : 0;
  const requiredMatchBonus = Number(evidence.required_evidence_score || 0) >= 0.5 ? 0.08 : 0;
  const base = (
    (status === "exact" ? 0.85 : status === "regional" ? 0.68 : status === "generic" ? 0.46 : status === "wrong" ? 0.05 : 0.2)
    + requiredEvidenceScore * 0.2
    + semanticRelevanceScore * 0.08
    + editorialEvidenceScore * 0.12
    + allowedCategoryScore * 0.1
    + requiredMatchBonus
    - semanticRiskScore * 0.2
    - forbiddenPenalty * 0.35
    - strongSourcePenalty
    - rolePenalty
  );
  return round3(Math.max(0, Math.min(1, base)));
};

const buildReasonCodes = ({ status, evidence = {}, weakVisualSource = false, scene = {}, window = {} }) => {
  const codes = [];
  if (hasWrongLocation({ scene, window })) codes.push("wrong_location");
  if ((evidence.matched_forbidden_categories || []).length) codes.push("forbidden_visual_category");
  if ((evidence.missing_required_visual_evidence || []).length) codes.push("missing_required_visual_evidence");
  if (Boolean(evidence.generic_visual)) codes.push("generic_visual");
  if (weakVisualSource) codes.push("weak_visual_source");
  if (status === "exact") codes.push("strong_visual_proof");
  if (status === "regional") codes.push("regional_context_match");
  if (status === "uncertain") codes.push("insufficient_visual_evidence");
  if (Number(evidence.semantic_risk_score || evidence.editorial_inference?.semantic_risk_score || 0) >= 0.5) {
    codes.push("semantic_risk_high");
  }
  return unique(codes);
};

const inferMicroNeedsFromText = (text = "") => {
  const normalizedText = normalize(text);
  return MICRO_NEED_RULES
    .filter((rule) => rule.tokens.some((token) => normalizedText.includes(token)))
    .map((rule) => rule.need);
};

const inferActionTokens = (text = "", objects = [], categories = []) => {
  const normalizedText = normalize(`${text} ${(objects || []).join(" ")} ${(categories || []).join(" ")}`);
  return unique(ACTION_TOKENS.filter((token) => normalizedText.includes(token)));
};

const deriveShotScale = (window = {}) => {
  const shotType = normalize(window.visual_features?.shot_type || window.shot_type || "");
  if (!shotType) return "unknown";
  if (shotType.includes("close")) return "closeup";
  if (shotType.includes("wide") || shotType.includes("aerial") || shotType.includes("establish")) return "wide";
  if (shotType.includes("medium")) return "medium";
  return shotType;
};

const deriveLandmarkId = (window = {}) => {
  const first = (window.landmarks || [])[0];
  const name = normalize(first?.name || first || "");
  const city = normalize(first?.city || window.location?.city || "");
  const key = `${name}|${city}`.replace(/\|+$/, "").trim();
  return key || "";
};

const deriveSceneFunction = ({ narrativeRolesSupported = [], microNeedsSupported = [] } = {}) => {
  const needs = new Set((microNeedsSupported || []).map((item) => normalize(item)));
  if (needs.has("people_eating") || needs.has("vendor_interaction")) return "human_action";
  if (needs.has("food_closeup") || needs.has("pastry_closeup") || needs.has("wine_pouring") || needs.has("wine_tasting")) return "proof";
  const roles = new Set((narrativeRolesSupported || []).map((item) => normalize(item)));
  if (roles.has("proof_exact")) return "proof";
  if (roles.has("detail_cutaway")) return "detail";
  if (roles.has("bridge_neutral_short")) return "transition";
  if (roles.has("closing_payoff")) return "payoff";
  return "context";
};

const deriveVisualFamily = ({ window = {}, microNeedsSupported = [], sceneFunction = "context" } = {}) => {
  const needs = (microNeedsSupported || []).map((item) => normalize(item)).filter(Boolean);
  const primaryNeed = needs[0] || "";
  const primaryCategory = normalize((window.detected_visual_categories || [])[0] || window.location_type || "");
  const primaryObject = normalize((window.detected_objects || [])[0] || "");
  const anchor = primaryNeed || primaryCategory || primaryObject || "unknown";
  return `${anchor}|${deriveShotScale(window)}|${sceneFunction}`;
};

const getContractText = (contract = {}) =>
  normalize([
    contract.window?.summary || "",
    ...(contract.window?.tags || []),
    ...(contract.visual_observation?.detected_visual_categories || []),
    ...(contract.visual_observation?.detected_objects || []),
  ].join(" "));

const scoreWindowForMicroNeed = ({ contract = {}, micro = {} }) => {
  const text = getContractText(contract);
  const need = normalize(micro.visual_need || "");
  const supportedNeeds = (contract.micro_needs_supported || []).map((item) => normalize(item));
  const actionTokens = (contract.action_tokens_detected || []).map((item) => normalize(item));
  const microActions = (micro.action_tokens || []).map((item) => normalize(item));
  const status = normalize(contract.visual_truth_status || "uncertain");
  const proofRequired = micro.needs_visual_proof === true;
  const exactLike = status === "exact" || status === "regional";
  const needMatch = need && (supportedNeeds.includes(need) || text.includes(need.replace(/_/g, " "))) ? 1 : 0;
  const actionOverlap = microActions.length
    ? microActions.filter((token) => actionTokens.includes(token) || text.includes(token)).length / microActions.length
    : 0.5;
  const confidence = Number(contract.editorial_confidence || 0);
  const proofPenalty = proofRequired && !exactLike ? 0.55 : 0;
  return round3((needMatch * 0.55) + (actionOverlap * 0.25) + (confidence * 0.2) - proofPenalty);
};

const buildEditorialWindowContract = ({
  scene = {},
  asset = {},
  assetIndex = 0,
  window = {},
  windowIndex = 0,
  blockPackage = null,
}) => {
  const evidenceSource = normalizeLabel(
    window.visual_evidence_source
    || window.method
    || asset.analysis_provider
    || "metadata_fallback"
  );
  const observationOrigin = String(
    window.visual_observation_origin
    || (WEAK_VISUAL_SOURCES.has(evidenceSource) ? "weak_fallback" : "real_vision")
  ).toLowerCase();
  const weakVisualSource = observationOrigin === "weak_fallback" || WEAK_VISUAL_SOURCES.has(evidenceSource);
  const evidence = evaluateVisualEvidence({ scene, window, asset });
  const visualTruthStatus = classifyVisualTruthStatus({
    scene,
    window,
    evidence,
    weakVisualSource,
  });
  const narrativeRolesSupported = buildNarrativeRolesSupported({
    status: visualTruthStatus,
    scene,
    window,
    evidence,
    weakVisualSource,
  });
  const editorialConfidence = computeEditorialConfidence({
    status: visualTruthStatus,
    evidence,
    weakVisualSource,
    scene,
  });
  const reasonCodes = buildReasonCodes({
    status: visualTruthStatus,
    evidence,
    weakVisualSource,
    scene,
    window,
  });
  const maxSafeDuration = visualTruthStatus === "generic"
    ? Math.min(getWindowDuration(window), Number(scene.max_generic_establishing_seconds || 3.5))
    : visualTruthStatus === "uncertain" || visualTruthStatus === "wrong"
      ? 0
      : getWindowDuration(window);
  const semanticRelevanceScore = clamp01(
    evidence.semantic_relevance_score
    ?? evidence.editorial_inference?.semantic_relevance_score
    ?? window.semantic_relevance_score
    ?? window.confidence
    ?? 0
  );
  const editorialEvidenceScore = clamp01(
    evidence.editorial_evidence_score
    ?? evidence.editorial_inference?.editorial_evidence_score
    ?? window.editorial_evidence_score
    ?? evidence.required_evidence_score
    ?? 0
  );
  const semanticRiskScore = clamp01(
    evidence.semantic_risk_score
    ?? evidence.editorial_inference?.semantic_risk_score
    ?? window.semantic_risk_score
    ?? 0
  );
  const criticalSemanticMin = Number(config.CRITICAL_SLOT_MIN_SEMANTIC_RELEVANCE || 0.45);
  const criticalEditorialMin = Number(config.CRITICAL_SLOT_MIN_EDITORIAL_EVIDENCE || 0.58);
  const criticalRiskMax = Number(config.CRITICAL_SLOT_MAX_SEMANTIC_RISK || 0.55);
  const criticalSlotAllowed = visualTruthStatus === "exact"
    || (
      visualTruthStatus === "regional"
      && editorialConfidence >= (scene.visual_intent === "gastronomy" ? 0.7 : 0.64)
      && semanticRelevanceScore >= criticalSemanticMin
      && editorialEvidenceScore >= criticalEditorialMin
      && semanticRiskScore <= criticalRiskMax
    );

  const approved = visualTruthStatus !== "wrong" && visualTruthStatus !== "uncertain";
  const rejected = !approved;

  const assetId = getAssetId(asset, assetIndex);
  const approvedWindowId = `${assetId}:w${String(window.window_index || windowIndex + 1).padStart(2, "0")}`;
  const summaryText = window.summary || window.description || "";
  const tagsText = (window.tags || []).join(" ");
  const objectText = (window.detected_objects || []).join(" ");
  const categoryText = (window.detected_visual_categories || []).join(" ");
  const microNeedsSupported = unique(inferMicroNeedsFromText(`${summaryText} ${tagsText} ${objectText} ${categoryText}`));
  const actionTokensDetected = inferActionTokens(summaryText, window.detected_objects || [], window.detected_visual_categories || []);
  const temporalMatchHints = {
    dominant_action_tokens: actionTokensDetected.slice(0, 4),
    dominant_categories: unique((window.detected_visual_categories || []).slice(0, 4)),
    duration_seconds: round3(getWindowDuration(window)),
  };
  const sceneFunction = deriveSceneFunction({ narrativeRolesSupported, microNeedsSupported });
  const shotScale = deriveShotScale(window);
  const landmarkId = deriveLandmarkId(window);
  const visualFamily = deriveVisualFamily({
    window,
    microNeedsSupported,
    sceneFunction,
  });
  const providerSignature = `${normalize(asset.provider || "unknown")}|${asset.source_url || asset.local_path || assetId}`;

  return {
    id: approvedWindowId,
    approved_window_id: approvedWindowId,
    asset_id: assetId,
    scene_index: Number(asset.scene_index || 0),
    block_id: String(scene.block_id || `scene_${Number(scene.scene_index || 0)}`),
    source_tier: inferSourceTier(asset),
    visual_evidence_source: evidenceSource,
    visual_observation_origin: observationOrigin,
    visual_truth_status: visualTruthStatus,
    editorial_confidence: editorialConfidence,
    semantic_relevance_score: semanticRelevanceScore,
    editorial_evidence_score: editorialEvidenceScore,
    semantic_risk_score: semanticRiskScore,
    narrative_roles_supported: narrativeRolesSupported,
    opening_allowed: narrativeRolesSupported.includes("opening_establishing") || narrativeRolesSupported.includes("hook_exact"),
    closing_allowed: narrativeRolesSupported.includes("closing_payoff"),
    critical_slot_allowed: criticalSlotAllowed,
    max_safe_duration: round3(maxSafeDuration),
    reason_codes: reasonCodes,
    approved,
    rejected,
    rejection_reasons: rejected ? reasonCodes : [],
    search_hypothesis: {
      query: asset.query || "",
      query_used: asset.query_used || asset.query || "",
      search_reason: asset.search_reason || "",
    },
    provider_metadata: {
      provider: asset.provider || "",
      provider_title: asset.provider_title || "",
      provider_tags: asset.provider_tags || [],
      semantic_text: asset.semantic_text || "",
    },
    scene_visual_intent: scene.visual_intent || "",
    visual_observation: evidence.visual_observation || {
      summary: window.summary || window.description || "",
      tags: unique(window.tags || []),
      location: window.location || { city: "", country: "", confidence: 0 },
      landmarks: unique((window.landmarks || []).map((item) => item?.name || item).filter(Boolean)),
      detected_visual_categories: unique(window.detected_visual_categories || []),
      detected_objects: unique(window.detected_objects || []),
      quality: window.quality || {},
      visual_observation_origin: observationOrigin,
    },
    editorial_inference: evidence.editorial_inference || {
      visual_intent_match: Boolean(evidence.visual_intent_match),
      required_evidence_found: unique(evidence.required_evidence_found || []),
      missing_required_visual_evidence: unique(evidence.missing_required_visual_evidence || []),
      matched_allowed_categories: unique(evidence.matched_allowed_categories || []),
      matched_forbidden_categories: unique(evidence.matched_forbidden_categories || []),
      generic_visual: Boolean(evidence.generic_visual),
      required_evidence_score: Number(evidence.required_evidence_score || 0),
      allowed_category_score: Number(evidence.allowed_category_score || 0),
      forbidden_category_penalty: Number(evidence.forbidden_category_penalty || 0),
      semantic_relevance_score: semanticRelevanceScore,
      editorial_evidence_score: editorialEvidenceScore,
      semantic_risk_score: semanticRiskScore,
    },
    window: {
      window_index: Number(window.window_index || windowIndex + 1),
      start_seconds: Number(window.start_seconds || window.start_sec || 0),
      end_seconds: Number(window.end_seconds || window.end_sec || 0),
      duration_seconds: round3(getWindowDuration(window)),
      summary: window.summary || window.description || "",
      tags: unique(window.tags || []),
      location: window.location || { city: "", country: "", confidence: 0 },
      landmarks: window.landmarks || [],
      visual_observation_origin: observationOrigin,
    },
    content_slot_type: "",
    content_slot_id: "",
    slot_match_score: 0,
    slot_coverage_contribution: 0,
    content_slots_supported: [],
    micro_need_match_score: 0,
    micro_need_match_scores: {},
    micro_needs_supported: microNeedsSupported,
    action_tokens_detected: actionTokensDetected,
    temporal_match_hints: temporalMatchHints,
    visual_family: visualFamily,
    landmark_id: landmarkId,
    shot_scale: shotScale,
    human_presence: Boolean(window.visual_features?.has_people),
    provider_signature: providerSignature,
    scene_function: sceneFunction,
  };
};

const extractSlotMatchText = (contract = {}) =>
  normalize([
    contract.window?.summary,
    contract.visual_observation?.summary,
    ...(contract.window?.tags || []),
    ...(contract.visual_observation?.tags || []),
    ...(contract.visual_observation?.detected_visual_categories || []),
  ].filter(Boolean).join(" "));

const scoreContractAgainstSlot = ({ contract = {}, slot = {} }) => {
  const matchText = extractSlotMatchText(contract);
  const slotType = normalize(slot.slot_type || "");
  const slotSynonyms = SLOT_HINT_SYNONYMS[slotType] || [];
  const hints = unique([
    slot.slot_type,
    ...slotSynonyms,
    ...(slot.query_hints || []),
    ...(slot.target_roles || []),
  ]).map(normalize);
  const hits = hints.filter((hint) => hint && matchText.includes(hint)).length;
  const roleHit = (contract.narrative_roles_supported || []).some((role) => (slot.target_roles || []).includes(role)) ? 1 : 0;
  const status = String(contract.visual_truth_status || "").toLowerCase();
  const proofEligible = status === "exact" || status === "regional";
  const proofBonus = slot.requires_visual_proof ? (proofEligible ? 1 : -1) : 0.3;
  const confidence = Number(contract.editorial_confidence || 0);
  const semanticRelevanceScore = Number(contract.semantic_relevance_score || contract.editorial_inference?.semantic_relevance_score || 0);
  const editorialEvidenceScore = Number(contract.editorial_evidence_score || contract.editorial_inference?.editorial_evidence_score || 0);
  return round3((hits * 0.35) + (roleHit * 0.35) + proofBonus + (confidence * 0.2) + (semanticRelevanceScore * 0.1) + (editorialEvidenceScore * 0.2));
};

const annotateContractSlotCoverage = ({ contract = {}, blockPackage = null }) => {
  if (!blockPackage || !Array.isArray(blockPackage.slots) || !blockPackage.slots.length) return contract;
  const ranked = blockPackage.slots
    .map((slot) => ({
      slot,
      score: scoreContractAgainstSlot({ contract, slot }),
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best || Number(best.score || 0) <= 0.4) return contract;
  const status = String(contract.visual_truth_status || "").toLowerCase();
  const proofEligible = status === "exact" || status === "regional";
  const slotCoverageContribution = best.slot.requires_visual_proof
    ? (proofEligible ? 1 : 0)
    : (status === "wrong" || status === "uncertain" ? 0 : 1);

  return {
    ...contract,
    content_slot_type: best.slot.slot_type,
    content_slot_id: best.slot.slot_id,
    slot_match_score: Number(best.score || 0),
    slot_coverage_contribution: Number(slotCoverageContribution || 0),
    content_slots_supported: ranked
      .filter((entry) => Number(entry.score || 0) >= 0.5)
      .slice(0, 3)
      .map((entry) => entry.slot.slot_type),
  };
};

const getContractDetectedCategories = (contract = {}) =>
  unique([
    ...(contract.visual_observation?.detected_visual_categories || []),
    ...(contract.editorial_inference?.matched_allowed_categories || []),
    ...(contract.editorial_inference?.required_evidence_found || []),
  ]);

const sceneHasThemeEvidence = ({ scene = {}, contract = {} }) => {
  const requiredThemeCategories = getThemeRequiredCategoriesForIntent(scene.visual_intent);
  if (!requiredThemeCategories.length) return true;
  const detectedCategories = getContractDetectedCategories(contract);
  return detectedCategories.some((category) => requiredThemeCategories.includes(String(category || "").toLowerCase()));
};

const createEmptyBins = () => EDITORIAL_BINS.reduce((acc, bin) => ({ ...acc, [bin]: [] }), {});

const getSceneByIndexMap = (visualPlan = []) =>
  new Map((visualPlan || []).map((scene) => [Number(scene.scene_index || 0), scene]));

const getCriticalSlotDefinitions = (scene = {}) => {
  const role = String(scene.role || "body").toLowerCase();
  const visualIntent = String(scene.visual_intent || "").toLowerCase();
  const isGenericIntro = role === "intro" && ["generic_travel", "travel", "overview"].includes(visualIntent);
  const defs = [];
  if (!isGenericIntro) {
    defs.push({ slot: "first_clip_of_block", requiredBins: ["proof_exact", "context_regional"] });
  }
  if (scene.hard_boundary) defs.push({ slot: "hard_boundary_first_clip", requiredBins: ["hook_exact", "proof_exact", "opening_establishing"] });
  if (scene.chapter_card_required) defs.push({ slot: "chapter_opening", requiredBins: ["hook_exact", "opening_establishing", "proof_exact"] });
  if (role === "intro" && !isGenericIntro) defs.push({ slot: "intro", requiredBins: ["hook_exact", "opening_establishing"] });
  if (role === "outro") defs.push({ slot: "closing", requiredBins: ["closing_payoff"] });
  if (role === "intro" && !isGenericIntro) defs.push({ slot: "hook", requiredBins: ["hook_exact"] });
  return defs;
};

const evaluateCriticalCoverage = ({ bins = {}, scene = {} }) => {
  const criticalDefs = getCriticalSlotDefinitions(scene);
  const missing = [];
  criticalDefs.forEach((entry) => {
    const covered = entry.requiredBins.some((bin) => (bins[bin] || []).some((candidate) => candidate.critical_slot_allowed));
    if (!covered) missing.push(entry.slot);
  });
  return {
    critical_slots_required: criticalDefs.map((entry) => entry.slot),
    critical_slots_missing: missing,
    critical_slots_covered: criticalDefs.length - missing.length,
    critical_slots_total: criticalDefs.length,
  };
};

const approveAssetsForVisualPlan = ({ visualPlan = [], assets = [], blockPackages = [], microVisualPlan = [] }) => {
  const sceneByIndex = getSceneByIndexMap(visualPlan);
  const blockPackageById = new Map((blockPackages || []).map((pkg) => [String(pkg.block_id || ""), pkg]));
  const blockPackageBySceneIndex = new Map();
  (blockPackages || []).forEach((pkg) => {
    (pkg.scene_indexes || []).forEach((sceneIndex) => {
      blockPackageBySceneIndex.set(Number(sceneIndex || 0), pkg);
    });
  });
  const contracts = [];
  const approvedWindows = [];
  const rejectedWindows = [];
  const approvedAssetIds = new Set();
  const binsByScene = {};

  (assets || []).forEach((asset, assetIndex) => {
    const sceneIndex = Number(asset.scene_index || 0);
    const scene = sceneByIndex.get(sceneIndex);
    if (!scene) return;

    const windows = Array.isArray(asset.analysis_windows) && asset.analysis_windows.length
      ? asset.analysis_windows
      : [{
          window_index: 1,
          start_seconds: 0,
          end_seconds: Number(asset.duration_estimate || 6),
          summary: asset.analysis_summary || asset.semantic_text || "",
          tags: unique([...(asset.analysis_tags || []), ...(asset.provider_tags || [])]),
          location: { city: "", country: "", confidence: 0 },
          landmarks: [],
          detected_visual_categories: [],
          detected_objects: [],
          visual_evidence_source: asset.analysis_provider || "metadata_fallback",
        }];

    windows.forEach((window, windowIndex) => {
      const contract = buildEditorialWindowContract({
        scene,
        asset,
        assetIndex,
        window,
        windowIndex,
        blockPackage: blockPackageBySceneIndex.get(sceneIndex) || blockPackageById.get(String(scene.block_id || "")) || null,
      });
      const enrichedContract = annotateContractSlotCoverage({
        contract,
        blockPackage: blockPackageBySceneIndex.get(sceneIndex) || blockPackageById.get(String(scene.block_id || "")) || null,
      });
      contracts.push(enrichedContract);

      binsByScene[sceneIndex] = binsByScene[sceneIndex] || createEmptyBins();
      enrichedContract.narrative_roles_supported.forEach((roleBin) => {
        if (!binsByScene[sceneIndex][roleBin]) binsByScene[sceneIndex][roleBin] = [];
        binsByScene[sceneIndex][roleBin].push(enrichedContract);
      });

      if (enrichedContract.approved) {
        approvedWindows.push(enrichedContract);
        approvedAssetIds.add(enrichedContract.asset_id);
      } else {
        rejectedWindows.push(enrichedContract);
      }
    });
  });

  const slotCoverageByBlock = (blockPackages || []).map((pkg) => {
    const pkgWindows = approvedWindows.filter((window) => (pkg.scene_indexes || []).includes(Number(window.scene_index || 0)));
    const slots = Array.isArray(pkg.slots) ? pkg.slots : [];
    const slotCoverage = slots.map((slot) => {
      const slotWindows = pkgWindows.filter((window) => window.content_slot_id === slot.slot_id);
      const slotProofWindows = slot.requires_visual_proof
        ? slotWindows.filter((window) => ["exact", "regional"].includes(String(window.visual_truth_status || "").toLowerCase()))
        : slotWindows.filter((window) => !["wrong", "uncertain"].includes(String(window.visual_truth_status || "").toLowerCase()));
      const semanticScores = slotProofWindows.map((window) => Number(window.semantic_relevance_score || window.editorial_inference?.semantic_relevance_score || 0));
      const editorialScores = slotProofWindows.map((window) => Number(window.editorial_evidence_score || window.editorial_inference?.editorial_evidence_score || 0));
      const count = Math.min(Number(slot.max_count || 1), slotProofWindows.length);
      const ok = slot.required ? count >= Number(slot.min_count || 1) : true;
      return {
        slot_id: slot.slot_id,
        slot_type: slot.slot_type,
        criticality: slot.criticality || "",
        requires_visual_proof: slot.requires_visual_proof === true,
        required: slot.required === true,
        min_count: Number(slot.min_count || 0),
        max_count: Number(slot.max_count || 0),
        selected_count: slotWindows.length,
        eligible_count: slotProofWindows.length,
        coverage_count: count,
        covered: ok,
        avg_semantic_relevance_score: round3(
          semanticScores.reduce((acc, score) => acc + Number(score || 0), 0) / Math.max(1, semanticScores.length)
        ),
        avg_editorial_evidence_score: round3(
          editorialScores.reduce((acc, score) => acc + Number(score || 0), 0) / Math.max(1, editorialScores.length)
        ),
      };
    });
    const requiredSlots = slotCoverage.filter((slot) => slot.required);
    const requiredCovered = requiredSlots.filter((slot) => slot.covered).length;
    const missingRequiredSlots = requiredSlots.filter((slot) => !slot.covered).map((slot) => slot.slot_type);
    return {
      block_id: pkg.block_id,
      package_id: pkg.package_id,
      intent: pkg.intent || "",
      scene_indexes: pkg.scene_indexes || [],
      slot_coverage: slotCoverage,
      required_slots_total: requiredSlots.length,
      required_slots_covered: requiredCovered,
      coverage_ratio: round3(requiredCovered / Math.max(1, requiredSlots.length)),
      ready: missingRequiredSlots.length === 0,
      missing_required_slots: missingRequiredSlots,
    };
  });
  const missingSlotsBySceneIndex = new Map();
  slotCoverageByBlock.forEach((entry) => {
    if (!entry.missing_required_slots.length) return;
    (entry.scene_indexes || []).forEach((sceneIndex) => {
      const existing = missingSlotsBySceneIndex.get(Number(sceneIndex || 0)) || [];
      missingSlotsBySceneIndex.set(Number(sceneIndex || 0), unique([...existing, ...entry.missing_required_slots]));
    });
  });

  const approvedItems = (assets || []).filter((asset, index) => approvedAssetIds.has(getAssetId(asset, index)));
  const windowsByScene = approvedWindows.reduce((acc, window) => {
    const key = Number(window.scene_index || 0);
    const bucket = acc.get(key) || [];
    bucket.push(window);
    acc.set(key, bucket);
    return acc;
  }, new Map());
  const microCoverageRows = [];
  const microCoverageBySceneMap = new Map();
  (microVisualPlan || []).forEach((micro) => {
    const sceneIndex = Number(micro.scene_index || 0);
    const candidates = windowsByScene.get(sceneIndex) || [];
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        score: scoreWindowForMicroNeed({ contract: candidate, micro }),
      }))
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
    const best = ranked[0] || null;
    const bestStatus = normalize(best?.candidate?.visual_truth_status || "uncertain");
    const proofRequired = micro.needs_visual_proof === true;
    const covered = Boolean(
      best
      && Number(best.score || 0) >= (proofRequired ? 0.62 : 0.46)
      && (!proofRequired || ["exact", "regional"].includes(bestStatus))
    );
    if (best?.candidate) {
      best.candidate.micro_need_match_score = Number(best.score || 0);
      best.candidate.micro_need_match_scores = {
        ...(best.candidate.micro_need_match_scores || {}),
        [String(micro.visual_need || "unknown_need")]: Number(best.score || 0),
      };
    }
    const row = {
      micro_id: micro.micro_id,
      scene_index: sceneIndex,
      block_id: micro.block_id || "",
      visual_need: micro.visual_need || "",
      needs_visual_proof: proofRequired,
      criticality: micro.criticality || "medium",
      covered,
      best_score: Number(best?.score || 0),
      approved_window_id: best?.candidate?.approved_window_id || "",
      visual_truth_status: best?.candidate?.visual_truth_status || "uncertain",
      decision: covered ? "covered" : (proofRequired ? "repair_required" : "degraded"),
    };
    microCoverageRows.push(row);
    const bucket = microCoverageBySceneMap.get(sceneIndex) || [];
    bucket.push(row);
    microCoverageBySceneMap.set(sceneIndex, bucket);
  });
  const microCoverageByScene = [...microCoverageBySceneMap.entries()].map(([sceneIndex, rows]) => {
    const criticalRows = rows.filter((row) => row.criticality === "high" || row.needs_visual_proof === true);
    const coveredCritical = criticalRows.filter((row) => row.covered);
    return {
      scene_index: Number(sceneIndex || 0),
      total_micro_moments: rows.length,
      covered_micro_moments: rows.filter((row) => row.covered).length,
      coverage_ratio: round3(rows.filter((row) => row.covered).length / Math.max(1, rows.length)),
      critical_micro_moments: criticalRows.length,
      covered_critical_micro_moments: coveredCritical.length,
      critical_coverage_ratio: round3(coveredCritical.length / Math.max(1, criticalRows.length)),
    };
  });
  const microCoverageGaps = microCoverageRows
    .filter((row) => !row.covered)
    .map((row) => ({
      micro_id: row.micro_id,
      scene_index: row.scene_index,
      block_id: row.block_id,
      visual_need: row.visual_need,
      criticality: row.criticality,
      reason: row.needs_visual_proof ? "NO_MICRO_PROOF_FOR_PROMISE" : "MICRO_NEED_WEAK_MATCH",
      decision: row.needs_visual_proof ? "repair_required" : "degraded",
    }));
  const totalApproved = Math.max(1, approvedWindows.length);
  const countByStatus = VISUAL_TRUTH_STATUSES.reduce((acc, status) => {
    acc[status] = approvedWindows.filter((item) => item.visual_truth_status === status).length;
    return acc;
  }, {});
  const perSceneReadiness = (visualPlan || []).map((scene) => {
    const sceneIndex = Number(scene.scene_index || 0);
    const nichePolicy = resolveNichePolicy(scene);
    const sceneMicroRows = microCoverageBySceneMap.get(sceneIndex) || [];
    const sceneApprovedWindows = approvedWindows.filter((item) => Number(item.scene_index || 0) === sceneIndex);
    const bins = binsByScene[sceneIndex] || createEmptyBins();
    const coverage = evaluateCriticalCoverage({ bins, scene });
    const exactCount = sceneApprovedWindows.filter((item) => item.visual_truth_status === "exact").length;
    const regionalCount = sceneApprovedWindows.filter((item) => item.visual_truth_status === "regional").length;
    const genericCount = sceneApprovedWindows.filter((item) => item.visual_truth_status === "generic").length;
    const uncertainCount = contracts.filter((item) => Number(item.scene_index || 0) === sceneIndex && item.visual_truth_status === "uncertain").length;
    const requiredThemeCategories = getThemeRequiredCategoriesForIntent(scene.visual_intent);
    const themeMatchedWindows = sceneApprovedWindows.filter((item) => sceneHasThemeEvidence({ scene, contract: item })).length;
    const blockingReasons = [];
    if ((exactCount + regionalCount) === 0 && Number((scene.required_visual_evidence || []).length) > 0) {
      blockingReasons.push("missing_exact_for_required_proof");
    }
    if (coverage.critical_slots_missing.length) {
      blockingReasons.push("critical_slots_uncovered");
    }
    const maxGenericByPolicy = Math.max(1, Math.round(sceneApprovedWindows.length * Number(nichePolicy.maxGenericRatioPerScene || 0.5)));
    if (genericCount > 0 && genericCount > maxGenericByPolicy) {
      blockingReasons.push("generic_exposure_too_high");
    }
    if (Number(nichePolicy.minExactOrRegionalForProof || 0) > 0 && (exactCount + regionalCount) < Number(nichePolicy.minExactOrRegionalForProof || 0)) {
      blockingReasons.push("no_proof_for_promise");
    }
    if (requiredThemeCategories.length && FOOD_VISUAL_INTENTS.has(String(scene.visual_intent || "").toLowerCase()) && themeMatchedWindows <= 0) {
      blockingReasons.push("missing_theme_visual_proof");
    }
    const missingRequiredSlots = missingSlotsBySceneIndex.get(sceneIndex) || [];
    const strictSlotCoverageIntent = FOOD_VISUAL_INTENTS.has(String(scene.visual_intent || "").toLowerCase())
      || scene.requires_visual_proof === true;
    if (missingRequiredSlots.length && strictSlotCoverageIntent) {
      blockingReasons.push("missing_required_content_slots");
    }
    const criticalMicroMissing = sceneMicroRows.filter((row) =>
      !row.covered && (row.criticality === "high" || row.needs_visual_proof === true)
    ).length;
    if (criticalMicroMissing > 0 && scene.requires_visual_proof === true) {
      blockingReasons.push("missing_micro_visual_proof");
    }

    return {
      scene_index: sceneIndex,
      visual_intent: scene.visual_intent || "",
      editorial_niche: nichePolicy.name || "lifestyle",
      total_approved_windows: sceneApprovedWindows.length,
      exact_windows: exactCount,
      regional_windows: regionalCount,
      generic_windows: genericCount,
      uncertain_windows: uncertainCount,
      theme_required_categories: requiredThemeCategories,
      theme_matched_windows: themeMatchedWindows,
      critical_slots_required: coverage.critical_slots_required,
      critical_slots_missing: coverage.critical_slots_missing,
      critical_slots_covered: coverage.critical_slots_covered,
      critical_slots_total: coverage.critical_slots_total,
      micro_total: sceneMicroRows.length,
      micro_covered: sceneMicroRows.filter((row) => row.covered).length,
      micro_coverage_ratio: round3(sceneMicroRows.filter((row) => row.covered).length / Math.max(1, sceneMicroRows.length)),
      micro_critical_missing: criticalMicroMissing,
      max_generic_windows_by_policy: maxGenericByPolicy,
      ready: blockingReasons.length === 0 && sceneApprovedWindows.length > 0,
      blocking: blockingReasons.length > 0 || sceneApprovedWindows.length === 0,
      blocking_reasons: blockingReasons.length ? blockingReasons : sceneApprovedWindows.length ? [] : ["no_approved_windows"],
      block_slot_coverage_missing: missingRequiredSlots,
    };
  });

  const missingCriticalCoverage = perSceneReadiness.filter((item) => item.critical_slots_missing.length > 0).length;
  const scenesWithThemeCoverage = perSceneReadiness.filter((item) => {
    if (!Array.isArray(item.theme_required_categories) || !item.theme_required_categories.length) return true;
    return Number(item.theme_matched_windows || 0) > 0;
  }).length;
  const falsePositiveRisk = rejectedWindows
    .filter((item) => item.reason_codes?.includes("forbidden_visual_category"))
    .reduce((acc, item) => {
      const key = item.visual_truth_status || "unknown";
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {});
  const editorialMetrics = {
    approved_window_count: approvedWindows.length,
    rejected_window_count: rejectedWindows.length,
    exact_ratio: round3(countByStatus.exact / totalApproved),
    regional_ratio: round3(countByStatus.regional / totalApproved),
    generic_ratio: round3(countByStatus.generic / totalApproved),
    uncertain_ratio: round3(countByStatus.uncertain / totalApproved),
    wrong_ratio: round3(countByStatus.wrong / totalApproved),
    critical_slots_covered_scenes: perSceneReadiness.length - missingCriticalCoverage,
    critical_slots_total_scenes: perSceneReadiness.length,
    critical_slots_coverage_ratio: round3((perSceneReadiness.length - missingCriticalCoverage) / Math.max(1, perSceneReadiness.length)),
    scene_theme_coverage_ratio: round3(scenesWithThemeCoverage / Math.max(1, perSceneReadiness.length)),
    micro_coverage_ratio: round3(
      microCoverageRows.filter((row) => row.covered).length / Math.max(1, microCoverageRows.length)
    ),
    micro_critical_coverage_ratio: round3(
      microCoverageRows
        .filter((row) => row.needs_visual_proof === true || row.criticality === "high")
        .filter((row) => row.covered).length
      / Math.max(1, microCoverageRows.filter((row) => row.needs_visual_proof === true || row.criticality === "high").length)
    ),
    timeline_uses_approved_pool_only: true,
    false_positive_risk_categories: falsePositiveRisk,
    generic_exposure_by_scene: perSceneReadiness.map((item) => ({
      scene_index: item.scene_index,
      generic_ratio: round3(item.generic_windows / Math.max(1, item.total_approved_windows)),
      editorial_niche: item.editorial_niche,
    })),
    slot_coverage_by_block_ratio: round3(
      slotCoverageByBlock.filter((item) => item.ready).length / Math.max(1, slotCoverageByBlock.length)
    ),
  };

  return {
    contracts,
    approved_items: approvedItems,
    approved_windows: approvedWindows,
    rejected_windows: rejectedWindows,
    editorial_bins_by_scene: binsByScene,
    slot_coverage_by_block: slotCoverageByBlock,
    micro_coverage_by_scene: microCoverageByScene,
    micro_coverage_gaps: microCoverageGaps,
    scene_editorial_readiness: perSceneReadiness,
    editorial_metrics: editorialMetrics,
  };
};

module.exports = {
  EDITORIAL_BINS,
  VISUAL_TRUTH_STATUSES,
  approveAssetsForVisualPlan,
  __test__: {
    classifyVisualTruthStatus,
    buildNarrativeRolesSupported,
    inferSourceTier,
    computeEditorialConfidence,
    buildReasonCodes,
    evaluateCriticalCoverage,
  },
};
