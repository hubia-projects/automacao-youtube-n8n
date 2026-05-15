const { evaluateVisualEvidence, normalizeLabel } = require("./visualIntentService");
const { isSameLocation } = require("./narrativeBlockPlanner");
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
const CURATED_PROVIDERS = new Set(["pond5", "envato", "istock"]);
const GENERATED_PROVIDERS = new Set(["local_fallback", "render_fallback"]);
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

const inferSourceTier = (asset = {}) => {
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
  if (!expectedLocation || !detectedCity) return false;
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
  const normalizedIntent = String(scene.visual_intent || "").toLowerCase();
  const isFoodIntent = ["gastronomy", "market", "wine", "pastry", "restaurant", "cafe", "street_food"].includes(normalizedIntent);
  const themeRequiredCategories = getThemeRequiredCategoriesForIntent(normalizedIntent).map((item) => String(item || "").toLowerCase());
  const detectedCategories = unique([
    ...(evidence.detected_visual_categories || []),
    ...(evidence.required_evidence_found || []),
    ...(evidence.matched_allowed_categories || []),
  ].map((item) => String(item || "").toLowerCase()));
  const foodThemeHits = themeRequiredCategories.filter((category) => detectedCategories.includes(category)).length;

  if (requiredCount > 0) {
    if (weakVisualSource) {
      if (!hasRequiredEvidence || genericVisual) return "uncertain";
      return requiredMatchRatio >= 0.7 && !genericVisual ? "regional" : "uncertain";
    }
    if (isFoodIntent && !genericVisual && !weakVisualSource) {
      if (foodThemeHits >= 2) return "exact";
      if (foodThemeHits >= 1) return "regional";
    }
    const minExactHits = isFoodIntent ? Math.min(2, requiredCount) : 1;
    if ((requiredFoundCount >= minExactHits || requiredMatchRatio >= 0.5) && !genericVisual && !weakVisualSource) return "exact";
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
  if (allowedMatches > 0 && !genericVisual && !weakVisualSource) return "exact";
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
  const strongSourcePenalty = weakVisualSource ? 0.3 : 0;
  const rolePenalty = scene.generic_asset_allowed === false && status === "generic" ? 0.2 : 0;
  const requiredMatchBonus = Number(evidence.required_evidence_score || 0) >= 0.5 ? 0.08 : 0;
  const base = (
    (status === "exact" ? 0.85 : status === "regional" ? 0.68 : status === "generic" ? 0.46 : status === "wrong" ? 0.05 : 0.2)
    + requiredEvidenceScore * 0.2
    + allowedCategoryScore * 0.1
    + requiredMatchBonus
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
  return unique(codes);
};

const buildEditorialWindowContract = ({
  scene = {},
  asset = {},
  assetIndex = 0,
  window = {},
  windowIndex = 0,
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
  const criticalSlotAllowed = visualTruthStatus === "exact"
    || (visualTruthStatus === "regional" && editorialConfidence >= (scene.visual_intent === "gastronomy" ? 0.7 : 0.64));

  const approved = visualTruthStatus !== "wrong" && visualTruthStatus !== "uncertain";
  const rejected = !approved;

  const assetId = getAssetId(asset, assetIndex);
  const approvedWindowId = `${assetId}:w${String(window.window_index || windowIndex + 1).padStart(2, "0")}`;

  return {
    id: approvedWindowId,
    approved_window_id: approvedWindowId,
    asset_id: assetId,
    scene_index: Number(asset.scene_index || 0),
    source_tier: inferSourceTier(asset),
    visual_evidence_source: evidenceSource,
    visual_observation_origin: observationOrigin,
    visual_truth_status: visualTruthStatus,
    editorial_confidence: editorialConfidence,
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
  const defs = [
    { slot: "first_clip_of_block", requiredBins: ["proof_exact", "context_regional"] },
  ];
  if (scene.hard_boundary) defs.push({ slot: "hard_boundary_first_clip", requiredBins: ["hook_exact", "proof_exact", "opening_establishing"] });
  if (scene.chapter_card_required) defs.push({ slot: "chapter_opening", requiredBins: ["hook_exact", "opening_establishing", "proof_exact"] });
  if (role === "intro") defs.push({ slot: "intro", requiredBins: ["hook_exact", "opening_establishing"] });
  if (role === "outro") defs.push({ slot: "closing", requiredBins: ["closing_payoff"] });
  if (role === "intro") defs.push({ slot: "hook", requiredBins: ["hook_exact"] });
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

const approveAssetsForVisualPlan = ({ visualPlan = [], assets = [] }) => {
  const sceneByIndex = getSceneByIndexMap(visualPlan);
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
      });
      contracts.push(contract);

      binsByScene[sceneIndex] = binsByScene[sceneIndex] || createEmptyBins();
      contract.narrative_roles_supported.forEach((roleBin) => {
        if (!binsByScene[sceneIndex][roleBin]) binsByScene[sceneIndex][roleBin] = [];
        binsByScene[sceneIndex][roleBin].push(contract);
      });

      if (contract.approved) {
        approvedWindows.push(contract);
        approvedAssetIds.add(contract.asset_id);
      } else {
        rejectedWindows.push(contract);
      }
    });
  });

  const approvedItems = (assets || []).filter((asset, index) => approvedAssetIds.has(getAssetId(asset, index)));
  const totalApproved = Math.max(1, approvedWindows.length);
  const countByStatus = VISUAL_TRUTH_STATUSES.reduce((acc, status) => {
    acc[status] = approvedWindows.filter((item) => item.visual_truth_status === status).length;
    return acc;
  }, {});
  const perSceneReadiness = (visualPlan || []).map((scene) => {
    const sceneIndex = Number(scene.scene_index || 0);
    const nichePolicy = resolveNichePolicy(scene);
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
      max_generic_windows_by_policy: maxGenericByPolicy,
      ready: blockingReasons.length === 0 && sceneApprovedWindows.length > 0,
      blocking: blockingReasons.length > 0 || sceneApprovedWindows.length === 0,
      blocking_reasons: blockingReasons.length ? blockingReasons : sceneApprovedWindows.length ? [] : ["no_approved_windows"],
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
    timeline_uses_approved_pool_only: true,
    false_positive_risk_categories: falsePositiveRisk,
    generic_exposure_by_scene: perSceneReadiness.map((item) => ({
      scene_index: item.scene_index,
      generic_ratio: round3(item.generic_windows / Math.max(1, item.total_approved_windows)),
      editorial_niche: item.editorial_niche,
    })),
  };

  return {
    contracts,
    approved_items: approvedItems,
    approved_windows: approvedWindows,
    rejected_windows: rejectedWindows,
    editorial_bins_by_scene: binsByScene,
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
