const { config } = require("../config/env");
const {
  FOOD_VISUAL_INTENTS,
  SOURCE_TIER_PRIORITY,
  getThemeRequiredCategoriesForIntent,
  resolveNichePolicy,
} = require("../config/editorialPolicy");
const { getCachedAudioIntelligence } = require("./audioIntelligence");
const {
  buildNarrativeBlocks,
  detectLocation,
  detectLandmarks,
  detectSubtheme,
  isSameLocation,
  belongsToTopic,
  buildSemanticTerms,
} = require("./narrativeBlockPlanner");
const { isPublishableAsset } = require("./assetReadinessService");
const { rankCandidates, registerClipUsage, buildVisualSignature } = require("./timelineScoringService");

const OUTPUT_WIDTH = Number(config.OUTPUT_WIDTH || 1920);
const OUTPUT_HEIGHT = Number(config.OUTPUT_HEIGHT || 1080);
const PREFERRED_OUTPUT = { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT };

const SYNC_POLICIES = {
  "cost-efficient": {
    mode: "cost-efficient",
    max_topic_switch_latency_sec: Number(config.HARD_BOUNDARY_MAX_LAG_SEC || config.SEMANTIC_SYNC_MAX_LATENCY_SEC || 0.5),
    min_clip_duration_sec: 2.8,
    max_clip_duration_sec: 6.5,
    preferred_clip_duration_sec: 4.5,
    min_candidate_score: -2,
  },
  "high-quality": {
    mode: "high-quality",
    max_topic_switch_latency_sec: Number(config.HARD_BOUNDARY_MAX_LAG_SEC || config.SEMANTIC_SYNC_MAX_LATENCY_SEC || 0.5),
    min_clip_duration_sec: 2.5,
    max_clip_duration_sec: 7,
    preferred_clip_duration_sec: 4.2,
    min_candidate_score: -2,
  },
};

const round3 = (value) => Number(Number(value || 0).toFixed(3));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const unique = (values = []) => [...new Set(values.filter(Boolean))];
const getSourceTierRank = (tier = "") => {
  const normalizedTier = String(tier || "free").toLowerCase();
  const index = SOURCE_TIER_PRIORITY.indexOf(normalizedTier);
  return index === -1 ? SOURCE_TIER_PRIORITY.length + 1 : index;
};
const isStrongFreeCriticalCandidate = (candidate = {}) => {
  const tier = String(candidate.source_tier || "free").toLowerCase();
  const status = String(candidate.visual_truth_status || "uncertain").toLowerCase();
  const confidence = Number(candidate.editorial_confidence || candidate.confidence || 0);
  if (tier !== "free") return false;
  if (status === "exact") return true;
  return status === "regional" && confidence >= Number(config.CRITICAL_SLOT_FREE_CONFIDENCE_MIN || 0.82);
};

const getCandidateDetectedCategories = (candidate = {}) =>
  unique([
    ...(candidate.detected_visual_categories || []),
    ...(candidate.required_evidence_found || []),
  ].map((item) => String(item || "").toLowerCase()));

const candidateHasThemeEvidence = ({ block = {}, candidate = {} } = {}) => {
  const intent = String(block.visual_intent || "").toLowerCase();
  const requiredCategories = getThemeRequiredCategoriesForIntent(intent);
  if (!requiredCategories.length) return true;
  const detectedCategories = getCandidateDetectedCategories(candidate);
  return requiredCategories.some((category) => detectedCategories.includes(String(category || "").toLowerCase()));
};

const isVideoFile = (filePath = "") => /\.(mp4|mov|webm|mkv|avi)$/i.test(filePath);
const isVideoAsset = (asset = {}) => (asset.asset_type || asset.type || "") === "video" || isVideoFile(asset.local_path || "");
const getAssetDuration = (asset = {}) => Number(asset.source_duration_seconds || asset.duration_estimate || 0);
const getAssetResolution = (asset = {}) => ({ width: Number(asset.resolution?.width || 0), height: Number(asset.resolution?.height || 0) });
const getAssetIdentity = (asset = {}, index = 0) => asset.asset_id || asset.local_path || asset.source_url || `asset_${index + 1}`;

const getSyncPolicy = () => {
  const mode = String(config.SEMANTIC_SYNC_MODE || "cost-efficient").toLowerCase();
  return SYNC_POLICIES[mode] || SYNC_POLICIES["cost-efficient"];
};

const getHardBoundaryPolicy = () => ({
  enabled: config.HARD_BOUNDARY_ENABLED !== false,
  max_topic_switch_latency_sec: Number(config.HARD_BOUNDARY_MAX_LAG_SEC || config.SEMANTIC_SYNC_MAX_LATENCY_SEC || 0.5),
  forbid_neutral_first_clip: Boolean(config.HARD_BOUNDARY_FORBID_NEUTRAL_FIRST_CLIP),
  require_location_on_hard_boundary: Boolean(config.HARD_BOUNDARY_REQUIRE_LOCATION),
  require_chapter_overlay: Boolean(config.HARD_BOUNDARY_REQUIRE_CHAPTER_OVERLAY),
  fail_on_missing_boundary_candidate: Boolean(config.HARD_BOUNDARY_FAIL_ON_MISS),
});

const normalizeAssetAnalysisWindows = (asset = {}) => {
  const assetDuration = round3(getAssetDuration(asset));
  const fallbackEndSeconds = assetDuration || Number(asset.analysis_window_seconds || 6) || 6;
  const rawWindows = Array.isArray(asset.analysis_windows) && asset.analysis_windows.length
    ? asset.analysis_windows
    : [{
        window_index: 1,
        start_seconds: 0,
        end_seconds: fallbackEndSeconds,
        summary: asset.analysis_summary || asset.semantic_text || asset.query || "travel footage",
        tags: unique([...(asset.analysis_tags || []), ...(asset.provider_tags || [])]),
        confidence: asset.is_fallback ? 0.35 : 0.45,
        method: asset.analysis_provider || "metadata_fallback",
        visual_evidence_source: asset.analysis_provider || "metadata_fallback",
      }];

  return rawWindows.map((window, index) => {
    const startSeconds = round3(Math.max(0, Number(window.start_seconds ?? window.start_sec ?? 0)));
    const endSeconds = round3(Math.max(startSeconds + 0.5, Math.min(fallbackEndSeconds || startSeconds + 6, Number(window.end_seconds ?? window.end_sec ?? fallbackEndSeconds))));
    const description = window.description || window.summary || window.semantic_text || asset.analysis_summary || asset.semantic_text || asset.query || "travel footage";
    const tags = unique([...(window.tags || []), ...(asset.analysis_tags || []), ...(asset.provider_tags || [])]).slice(0, 16);
    const visualText = `${description} ${tags.join(" ")} ${asset.query || ""} ${asset.semantic_text || ""}`;
    const location = detectLocation(visualText, window.location);
    const landmarks = detectLandmarks(visualText, window.landmarks);
    const visualEvidenceSource = window.visual_evidence_source || window.method || asset.analysis_provider || "metadata_fallback";
    const visualObservationOrigin = window.visual_observation_origin
      || (String(visualEvidenceSource).toLowerCase().includes("fallback") ? "weak_fallback" : "real_vision");
    const rawConfidence = clamp(Number(window.confidence || window.visual_confidence || 0.45), 0, 1);
    const confidence = visualEvidenceSource === "metadata_fallback" ? Math.min(rawConfidence, 0.35) : rawConfidence;
    const brightness = Number(window.quality?.brightness || 0.7);

    return {
      window_index: Number(window.window_index || index + 1),
      start_seconds: startSeconds,
      end_seconds: endSeconds,
      duration_seconds: round3(endSeconds - startSeconds),
      summary: description,
      description,
      tags,
      location,
      landmarks,
      location_type: window.location_type || detectSubtheme(visualText).subtheme,
      visual_features: {
        shot_type: window.visual_features?.shot_type || window.shot_type || "unknown",
        camera_motion: window.visual_features?.camera_motion || window.camera_motion || "unknown",
        dominant_colors: window.visual_features?.dominant_colors || [],
        has_people: Boolean(window.visual_features?.has_people),
        has_water: Boolean(window.visual_features?.has_water || /rio|river|water|sea|mar|ocean|beach|praia/i.test(visualText)),
        has_architecture: Boolean(window.visual_features?.has_architecture || /building|architecture|fachada|palace|castle|ponte|bridge/i.test(visualText)),
      },
      quality: {
        sharpness: Number(window.quality?.sharpness || 0.7),
        stability: Number(window.quality?.stability || 0.7),
        brightness,
        usable: window.quality?.usable !== false,
        resolution_score: 0.5,
      },
      detected_visual_categories: unique(window.detected_visual_categories || []),
      detected_objects: unique(window.detected_objects || []),
      visual_intent_match: window.visual_intent_match === true,
      generic_visual: Boolean(window.generic_visual),
      required_evidence_found: unique(window.required_evidence_found || []),
      missing_required_visual_evidence: unique(window.missing_required_visual_evidence || []),
      confidence,
      neutral: Boolean(window.neutral) || (!location.city && /travel|road|map|airplane|landscape|generic|overview/i.test(visualText)),
      analysis_provider: window.method || asset.analysis_provider || "metadata_fallback",
      visual_evidence_source: visualEvidenceSource,
      visual_observation_origin: visualObservationOrigin,
    };
  });
};

const flattenAssetWindows = (assets = []) => {
  const windows = [];

  assets.forEach((asset, assetIndex) => {
    const assetIdentity = getAssetIdentity(asset, assetIndex);
    normalizeAssetAnalysisWindows(asset).forEach((window, windowIndex) => {
      const semanticText = `${window.description || ""} ${(window.tags || []).join(" ")} ${asset.query || ""} ${asset.semantic_text || ""}`.trim();
      const { width, height } = getAssetResolution(asset);
      const resolutionScore = width >= OUTPUT_WIDTH && height >= OUTPUT_HEIGHT ? 1 : width >= 1280 && height >= 720 ? 0.75 : 0.35;

      windows.push({
        id: `${Buffer.from(String(assetIdentity)).toString("base64").replace(/=+$/g, "").slice(0, 18)}_w${String(window.window_index || windowIndex + 1).padStart(2, "0")}`,
        asset_id: assetIdentity,
        asset_index: assetIndex,
        asset,
        source: asset.provider || "unknown",
        scene_index: Number(asset.scene_index || 0),
        start_sec: window.start_seconds,
        end_sec: window.end_seconds,
        duration_sec: window.duration_seconds,
        description: window.description,
        summary: window.summary,
        tags: window.tags,
        location: window.location,
        landmarks: window.landmarks,
        location_type: window.location_type,
        visual_features: window.visual_features,
        quality: {
          ...window.quality,
          resolution_score: resolutionScore,
        },
        detected_visual_categories: window.detected_visual_categories,
        detected_objects: window.detected_objects,
        visual_intent_match: window.visual_intent_match,
        generic_visual: window.generic_visual,
        required_evidence_found: window.required_evidence_found,
        missing_required_visual_evidence: window.missing_required_visual_evidence,
        confidence: window.confidence,
        neutral: window.neutral,
        visual_evidence_source: window.visual_evidence_source,
        visual_observation_origin: window.visual_observation_origin || "real_vision",
        semantic_text: semanticText,
        window_index: window.window_index,
        analysis_provider: window.analysis_provider,
        visual_truth_status: window.visual_truth_status || "regional",
        editorial_confidence: Number(window.editorial_confidence || window.confidence || 0),
        narrative_roles_supported: window.narrative_roles_supported || [],
        opening_allowed: window.opening_allowed !== false,
        closing_allowed: window.closing_allowed !== false,
        critical_slot_allowed: window.critical_slot_allowed !== false,
        editorial_approved: window.editorial_approved !== false,
        approved_window_id: window.approved_window_id || "",
        source_tier: window.source_tier || "free",
      });
    });
  });

  return windows;
};

const buildApprovedWindowCandidates = ({ approvedWindows = [], assets = [] }) => {
  const assetsById = new Map();
  (assets || []).forEach((asset, index) => {
    const assetId = getAssetIdentity(asset, index);
    assetsById.set(assetId, asset);
  });

  return (approvedWindows || []).map((contract, index) => {
    const asset = assetsById.get(contract.asset_id) || null;
    const quality = contract.visual_observation?.quality || {};
    const resolution = getAssetResolution(asset || {});
    const resolutionScore = resolution.width >= OUTPUT_WIDTH && resolution.height >= OUTPUT_HEIGHT ? 1 : resolution.width >= 1280 && resolution.height >= 720 ? 0.75 : 0.35;
    const summary = contract.window?.summary || contract.visual_observation?.summary || "";
    const tags = contract.window?.tags || contract.visual_observation?.tags || [];

    return {
      id: contract.id || contract.approved_window_id || `approved_window_${index + 1}`,
      asset_id: contract.asset_id || `asset_${index + 1}`,
      asset,
      source: asset?.provider || contract.provider_metadata?.provider || "unknown",
      scene_index: Number(contract.scene_index || 0),
      start_sec: Number(contract.window?.start_seconds || 0),
      end_sec: Number(contract.window?.end_seconds || 0),
      duration_sec: Number(contract.window?.duration_seconds || Math.max(0.25, Number(contract.window?.end_seconds || 0) - Number(contract.window?.start_seconds || 0))),
      description: summary,
      summary,
      tags,
      location: contract.window?.location || contract.visual_observation?.location || { city: "", country: "", confidence: 0 },
      landmarks: contract.window?.landmarks || contract.visual_observation?.landmarks || [],
      location_type: contract.visual_observation?.location_type || "",
      visual_features: contract.visual_observation?.visual_features || {},
      quality: {
        ...quality,
        usable: quality.usable !== false,
        resolution_score: resolutionScore,
      },
      detected_visual_categories: contract.visual_observation?.detected_visual_categories || [],
      detected_objects: contract.visual_observation?.detected_objects || [],
      visual_intent_match: Boolean(contract.editorial_inference?.visual_intent_match),
      generic_visual: Boolean(contract.editorial_inference?.generic_visual),
      required_evidence_found: contract.editorial_inference?.required_evidence_found || [],
      missing_required_visual_evidence: contract.editorial_inference?.missing_required_visual_evidence || [],
      confidence: Number(contract.editorial_confidence || 0),
      neutral: contract.visual_truth_status === "generic",
      visual_evidence_source: contract.visual_evidence_source || "metadata_fallback",
      visual_observation_origin: contract.visual_observation_origin || contract.visual_observation?.visual_observation_origin || "real_vision",
      semantic_text: `${summary} ${(tags || []).join(" ")}`.trim(),
      window_index: Number(contract.window?.window_index || 1),
      analysis_provider: asset?.analysis_provider || contract.visual_evidence_source || "metadata_fallback",
      visual_truth_status: contract.visual_truth_status || "regional",
      editorial_confidence: Number(contract.editorial_confidence || 0),
      narrative_roles_supported: contract.narrative_roles_supported || [],
      opening_allowed: contract.opening_allowed !== false,
      closing_allowed: contract.closing_allowed !== false,
      critical_slot_allowed: contract.critical_slot_allowed !== false,
      editorial_approved: contract.approved === true,
      approved_window_id: contract.approved_window_id || contract.id || "",
      source_tier: contract.source_tier || "free",
      rejection_reasons: contract.rejection_reasons || [],
      reason_codes: contract.reason_codes || [],
    };
  });
};

const buildFallbackCandidate = (fallbackAsset) => ({
  ...flattenAssetWindows([fallbackAsset])[0],
  neutral: true,
  confidence: 0.25,
  semantic_text: fallbackAsset.semantic_text || fallbackAsset.query || "neutral travel fallback",
});

const buildChapterCardCandidate = ({ block, fallbackAsset }) => {
  if (!fallbackAsset) return null;
  const base = buildFallbackCandidate(fallbackAsset);
  const expectedLocation = block.expected_location || block.location?.city || block.macro_topic || "";

  return {
    ...base,
    neutral: false,
    chapter_card_clip: true,
    semantic_text: `${expectedLocation} chapter transition card`.trim(),
    description: `${expectedLocation} chapter transition card`.trim(),
    location: {
      city: expectedLocation,
      country: block.location?.country || "",
      confidence: 1,
      source: "chapter_card",
    },
    visual_evidence_source: "chapter_card",
    analysis_provider: "chapter_card",
  };
};

const isCandidateAllowedByHardRules = ({ block, candidate, previousMacroTopic }) => {
  if (candidate.quality?.usable === false) return false;

  const candidateCity = candidate.location?.city || "";
  const candidateLandmarks = candidate.landmarks || [];
  const expectedCity = block.location?.city || (block.topic_type === "city" ? block.macro_topic : "");

  if (previousMacroTopic && block.hard_boundary) {
    if (candidateCity && belongsToTopic(candidateCity, previousMacroTopic)) return false;
    if (candidateLandmarks.some((landmark) => belongsToTopic(landmark.name, previousMacroTopic) || belongsToTopic(landmark.city, previousMacroTopic))) {
      return false;
    }
  }

  if (expectedCity) {
    if (candidateCity && !isSameLocation(candidateCity, expectedCity)) return false;
    const wrongLandmark = candidateLandmarks.some((landmark) => landmark.city && !isSameLocation(landmark.city, expectedCity));
    if (wrongLandmark) return false;
  }

  return true;
};

const filterCandidatesByHardRules = ({
  block,
  assetWindows,
  previousMacroTopic,
  fallbackAsset,
  allowPlaceholderFallback = true,
  isBoundaryFirstSlot = false,
  criticalSlot = false,
  slotRole = "",
  hardBoundaryPolicy = getHardBoundaryPolicy(),
}) => {
  const expectedLocation = block.expected_location || block.location?.city || (block.topic_type === "city" ? block.macro_topic : "");
  const foodIntent = FOOD_VISUAL_INTENTS.has(String(block.visual_intent || "").toLowerCase());
  let strict = assetWindows.filter((candidate) => isCandidateAllowedByHardRules({ block, candidate, previousMacroTopic }));

  if (isBoundaryFirstSlot && hardBoundaryPolicy.forbid_neutral_first_clip) {
    strict = strict.filter((candidate) => !candidate.neutral);
  }

  if (isBoundaryFirstSlot && hardBoundaryPolicy.require_location_on_hard_boundary && expectedLocation) {
    strict = strict.filter((candidate) => {
      const candidateCity = candidate.location?.city || "";
      return candidateCity && isSameLocation(candidateCity, expectedLocation);
    });
  }

  if (slotRole) {
    const roleFiltered = strict.filter((candidate) => {
      const roles = candidate.narrative_roles_supported || [];
      return !roles.length || roles.includes(slotRole);
    });
    if (roleFiltered.length) strict = roleFiltered;
  }

  if (slotRole === "opening_establishing") {
    const openingFiltered = strict.filter((candidate) => candidate.opening_allowed !== false);
    if (openingFiltered.length) strict = openingFiltered;
  }

  if (slotRole === "closing_payoff") {
    const closingFiltered = strict.filter((candidate) => candidate.closing_allowed !== false);
    if (closingFiltered.length) strict = closingFiltered;
  }

  if (criticalSlot) {
    const criticalFiltered = strict.filter((candidate) => candidate.critical_slot_allowed !== false);
    if (criticalFiltered.length) strict = criticalFiltered;
  }

  if (criticalSlot && strict.length) {
    // Hard source-tier policy for critical slots:
    // prefer premium/curated, then only strong free evidence.
    const premiumOrCurated = strict.filter((candidate) => {
      const tier = String(candidate.source_tier || "free").toLowerCase();
      return tier === "premium" || tier === "curated";
    });
    if (premiumOrCurated.length) {
      strict = premiumOrCurated;
    } else {
      const freeStrong = strict.filter((candidate) => isStrongFreeCriticalCandidate(candidate));
      if (freeStrong.length) {
        strict = freeStrong;
      } else {
        const avoidGenerated = strict.filter((candidate) => String(candidate.source_tier || "free").toLowerCase() !== "generated");
        if (avoidGenerated.length) strict = avoidGenerated;
      }
    }
  }

  if (foodIntent && strict.length) {
    const requiresThemeProof = criticalSlot || ["hook_exact", "proof_exact", "closing_payoff"].includes(slotRole);
    const themeMatches = strict.filter((candidate) => candidateHasThemeEvidence({ block, candidate }));
    if (themeMatches.length && (requiresThemeProof || themeMatches.length < strict.length)) {
      strict = themeMatches;
    }
  }

  if (strict.length) return strict;

  const neutral = assetWindows.filter((candidate) => candidate.neutral && candidate.scene_index === block.scene_index);
  if (neutral.length) return neutral;

  const generalNeutral = assetWindows.filter((candidate) => candidate.neutral);
  if (generalNeutral.length) return generalNeutral;

  let crossSceneFallback = assetWindows.filter((candidate) => candidate.editorial_approved === true);
  if (foodIntent && crossSceneFallback.length) {
    const themedCrossSceneFallback = crossSceneFallback.filter((candidate) => candidateHasThemeEvidence({ block, candidate }));
    if (themedCrossSceneFallback.length) crossSceneFallback = themedCrossSceneFallback;
  }
  if (crossSceneFallback.length) {
    return crossSceneFallback
      .sort((left, right) => Number(right.editorial_confidence || right.confidence || 0) - Number(left.editorial_confidence || left.confidence || 0))
      .slice(0, 12);
  }

  if (isBoundaryFirstSlot && block.chapter_card_required && allowPlaceholderFallback) {
    const chapterCardCandidate = buildChapterCardCandidate({ block, fallbackAsset });
    if (chapterCardCandidate) return [chapterCardCandidate];
  }

  return allowPlaceholderFallback ? [buildFallbackCandidate(fallbackAsset)] : [];
};

const getNarrationTextBetween = ({ words = [], startSeconds = 0, endSeconds = 0, fallback = "" }) => {
  const matchedWords = words
    .filter((word) => Number(word.start || 0) < endSeconds && Number(word.end || 0) > startSeconds)
    .map((word) => word.word)
    .filter(Boolean);
  return matchedWords.length ? matchedWords.join(" ") : fallback;
};

const inferNarrativeSlotRole = ({ block = {}, slotIndex = 0, totalSlots = 1 }) => {
  const role = String(block.role || "body").toLowerCase();
  if (role === "intro") {
    if (slotIndex === 0) return "hook_exact";
    if (slotIndex === totalSlots - 1) return "opening_establishing";
    return "proof_exact";
  }
  if (role === "outro") {
    if (slotIndex === 0) return "proof_exact";
    if (slotIndex === totalSlots - 1) return "closing_payoff";
    return "detail_cutaway";
  }
  if (slotIndex === 0) return "proof_exact";
  if (slotIndex === totalSlots - 1) return "bridge_neutral_short";
  if (slotIndex === 1) return "context_regional";
  return "detail_cutaway";
};

const isCriticalSlotForBlock = ({ block = {}, slotIndex = 0, totalSlots = 1 }) => {
  const role = String(block.role || "body").toLowerCase();
  if (slotIndex === 0) return true;
  if (role === "intro" && slotIndex === 0) return true;
  if (role === "outro" && slotIndex === totalSlots - 1) return true;
  if (block.hard_boundary && slotIndex === 0) return true;
  if (block.chapter_card_required && slotIndex === 0) return true;
  return false;
};

const selectBySourceTierPolicy = ({
  ranked = [],
  slotRole = "",
  criticalSlot = false,
  block = {},
  freeCriticalUsageByBlock = new Map(),
}) => {
  if (!Array.isArray(ranked) || !ranked.length) return null;
  const available = ranked.filter((item) => !item.hard_blocked);
  if (!available.length) return ranked[0] || null;

  const requiresStrictSourcePolicy = criticalSlot || ["hook_exact", "opening_establishing", "proof_exact", "closing_payoff"].includes(slotRole);
  if (!requiresStrictSourcePolicy) return available[0];

  const premiumOrCurated = available.filter((item) => {
    const tier = String(item.candidate?.source_tier || "free").toLowerCase();
    return tier === "premium" || tier === "curated";
  });
  if (premiumOrCurated.length) {
    return premiumOrCurated.sort((left, right) =>
      getSourceTierRank(left.candidate?.source_tier) - getSourceTierRank(right.candidate?.source_tier)
      || Number(right.score || 0) - Number(left.score || 0)
    )[0];
  }

  const freeStrong = available.filter((item) => isStrongFreeCriticalCandidate(item.candidate));
  if (freeStrong.length) {
    const blockKey = String(block.block_id || block.id || block.scene_index || "unknown_block");
    const nichePolicy = resolveNichePolicy(block);
    const maxFreeCriticalByBlock = Number(nichePolicy.maxFreeCriticalSlotsPerBlock || config.CRITICAL_SLOT_FREE_SOURCE_BUDGET_PER_BLOCK || 1);
    const usedFreeCriticalCount = Number(freeCriticalUsageByBlock.get(blockKey) || 0);

    if (usedFreeCriticalCount < maxFreeCriticalByBlock) {
      return freeStrong.sort((left, right) => Number(right.score || 0) - Number(left.score || 0))[0];
    }
  }

  return available.sort((left, right) =>
    getSourceTierRank(left.candidate?.source_tier) - getSourceTierRank(right.candidate?.source_tier)
    || Number(right.score || 0) - Number(left.score || 0)
  )[0];
};

const buildBlockLandmarkKey = (candidate = {}) => {
  const firstLandmark = (candidate.landmarks || [])[0];
  const landmarkName = firstLandmark?.name || firstLandmark || "";
  const landmarkCity = firstLandmark?.city || candidate.location?.city || "";
  const normalized = `${String(landmarkName || "").toLowerCase().trim()}|${String(landmarkCity || "").toLowerCase().trim()}`;
  return normalized.replace(/\s+/g, " ").trim();
};

const candidateRespectsDiversityQuotas = ({
  candidate = {},
  block = {},
  usage = {},
  criticalSlot = false,
}) => {
  const blockId = String(block.block_id || block.id || block.scene_index || "");
  if (!blockId) return true;
  const signature = buildVisualSignature(candidate);
  const provider = String(candidate.source || candidate.asset?.provider || "unknown").toLowerCase();
  const landmarkKey = buildBlockLandmarkKey(candidate);
  const signatureCount = Number(usage.usedBlockVisualSignatures?.get(`${blockId}:${signature}`) || 0);
  const providerCount = Number(usage.usedBlockProviders?.get(`${blockId}:${provider}`) || 0);
  const landmarkCount = landmarkKey ? Number(usage.usedBlockLandmarks?.get(`${blockId}:${landmarkKey}`) || 0) : 0;
  const maxProviderCount = criticalSlot ? 1 : 2;

  if (signatureCount >= 1) return false;
  if (providerCount >= maxProviderCount) return false;
  if (landmarkCount >= 1) return false;
  return true;
};

const selectWithDiversityQuota = ({
  ranked = [],
  preselected = null,
  block = {},
  usage = {},
  criticalSlot = false,
}) => {
  const available = ranked.filter((item) => !item.hard_blocked);
  if (!available.length) {
    return { selected: preselected, forced: false };
  }

  if (preselected?.candidate && candidateRespectsDiversityQuotas({ candidate: preselected.candidate, block, usage, criticalSlot })) {
    return { selected: preselected, forced: false };
  }

  const quotaRespecting = available.find((item) =>
    candidateRespectsDiversityQuotas({ candidate: item.candidate, block, usage, criticalSlot })
  );
  if (quotaRespecting) {
    return { selected: quotaRespecting, forced: true };
  }

  return { selected: preselected || available[0], forced: false };
};

const splitBlockIntoTimelineSlots = ({ block, policy, pauseMarkers = [] }) => {
  const slots = [];
  let cursor = Number(block.start_sec || 0);
  const end = Number(block.end_sec || cursor);

  while (cursor < end - 0.05) {
    const remaining = round3(end - cursor);
    if (remaining <= policy.max_clip_duration_sec) {
      slots.push({ start: round3(cursor), end: round3(end), duration: remaining, cutReason: block.hard_boundary && slots.length === 0 ? "block_transition" : "duration_limit" });
      break;
    }

    const idealCount = Math.max(2, Math.ceil(remaining / policy.preferred_clip_duration_sec));
    const evenDuration = round3(remaining / idealCount);
    if (evenDuration >= policy.min_clip_duration_sec && evenDuration <= policy.max_clip_duration_sec) {
      const nextEnd = round3(Math.min(end, cursor + evenDuration));
      slots.push({
        start: round3(cursor),
        end: nextEnd,
        duration: round3(nextEnd - cursor),
        cutReason: block.hard_boundary && slots.length === 0 ? "block_transition" : "semantic_shift",
      });
      cursor = nextEnd;
      continue;
    }

    const minEnd = cursor + policy.min_clip_duration_sec;
    const maxEnd = Math.min(end, cursor + policy.max_clip_duration_sec);
    const preferredEnd = Math.min(end, cursor + policy.preferred_clip_duration_sec);
    const marker = pauseMarkers
      .filter((pause) => Number(pause.start || 0) >= minEnd && Number(pause.start || 0) <= maxEnd)
      .sort((left, right) => Math.abs(Number(left.start || 0) - preferredEnd) - Math.abs(Number(right.start || 0) - preferredEnd))[0];

    if (marker) {
      slots.push({
        start: round3(cursor),
        end: round3(marker.start),
        duration: round3(Number(marker.start || 0) - cursor),
        cutReason: block.hard_boundary && slots.length === 0 ? "block_transition" : "pause_marker",
      });
      cursor = Number(marker.start || cursor);
      continue;
    }

    const nextEnd = clamp(preferredEnd, minEnd, maxEnd);
    slots.push({
      start: round3(cursor),
      end: round3(nextEnd),
      duration: round3(nextEnd - cursor),
      cutReason: block.hard_boundary && slots.length === 0 ? "block_transition" : "duration_limit",
    });
    cursor = nextEnd;
  }

  if (slots.length > 1) {
    const last = slots[slots.length - 1];
    if (last.duration < policy.min_clip_duration_sec * 0.6) {
      const previous = slots[slots.length - 2];
      previous.end = last.end;
      previous.duration = round3(previous.end - previous.start);
      previous.cutReason = previous.cutReason === "pause_marker" ? "semantic_shift" : previous.cutReason;
      slots.pop();
    }
  }

  return slots.map((slot, slotIndex) => ({
    ...slot,
    slot_role: inferNarrativeSlotRole({ block, slotIndex, totalSlots: slots.length }),
    critical_slot: isCriticalSlotForBlock({ block, slotIndex, totalSlots: slots.length }),
  }));
};

const buildVideoSourceWindow = ({ asset, clipDuration, preferredWindow = null, assetReuseIndex = 0, clipIndex = 1, draftVersion = 1 }) => {
  const assetDuration = getAssetDuration(asset);
  const safeClipDuration = round3(Number(clipDuration || 0));

  if (!isVideoAsset(asset) || !assetDuration || assetDuration <= safeClipDuration + 0.25) {
    return { source_start_seconds: 0, source_end_seconds: safeClipDuration, asset_duration_seconds: round3(assetDuration) };
  }

  if (preferredWindow) {
    const windowStart = Number(preferredWindow.start_sec ?? preferredWindow.start_seconds ?? 0);
    const windowEnd = Number(preferredWindow.end_sec ?? preferredWindow.end_seconds ?? assetDuration);
    const windowDuration = Math.max(0.25, windowEnd - windowStart);

    if (windowDuration >= safeClipDuration) {
      const extraTime = Math.max(0, windowDuration - safeClipDuration);
      const variation = ((assetReuseIndex * 0.29) + ((clipIndex - 1) * 0.13) + (draftVersion * 0.17)) % 1;
      const start = round3(clamp(windowStart + extraTime * variation, 0, Math.max(0, assetDuration - safeClipDuration)));
      return {
        source_start_seconds: start,
        source_end_seconds: round3(Math.min(assetDuration, start + safeClipDuration)),
        asset_duration_seconds: round3(assetDuration),
      };
    }
  }

  const edgePadding = Math.min(0.9, Math.max(0.25, assetDuration * 0.04));
  const availableTravel = Math.max(0, assetDuration - safeClipDuration - edgePadding * 2);
  const variation = ((assetReuseIndex * 0.31) + ((clipIndex - 1) * 0.11) + (draftVersion * 0.17)) % 1;
  const start = round3(edgePadding + availableTravel * variation);
  return {
    source_start_seconds: start,
    source_end_seconds: round3(start + safeClipDuration),
    asset_duration_seconds: round3(assetDuration),
  };
};

const chooseOutputResolution = () => PREFERRED_OUTPUT;

const summarizeRejectedReasons = (ranked = []) => {
  const counts = new Map();
  ranked.slice(1).forEach((item) => {
    (item.rejected_reasons || []).forEach((reason) => counts.set(reason, (counts.get(reason) || 0) + 1));
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason]) => reason);
};

const evaluateHardBoundaryDeterministic = ({ clips = [], microBlocks = [], hardBoundaryPolicy = getHardBoundaryPolicy() }) => {
  const hardBoundaries = microBlocks.filter((block) => block.hard_boundary);
  if (!hardBoundaries.length || !hardBoundaryPolicy.enabled) {
    return {
      status: "pass",
      max_visual_lag_sec: 0,
      avg_visual_lag_sec: 0,
      boundaries: [],
      violations: [],
    };
  }

  const reports = [];
  const violations = [];
  const lagValues = [];

  hardBoundaries.forEach((block) => {
    const boundarySec = Number(block.expected_visual_start_sec ?? block.start_sec ?? 0);
    const expectedLocation = block.expected_location || block.location?.city || (block.topic_type === "city" ? block.macro_topic : "");
    const boundaryId = block.boundary_id || block.id;
    const crossingClip = clips.find((clip) => {
      const start = Number(clip.timeline_start_sec || 0);
      const end = Number(clip.timeline_end_sec || 0);
      return start < boundarySec - 0.001 && end > boundarySec + 0.001;
    });
    const firstClip = clips.find((clip) => Number(clip.timeline_start_sec || 0) >= boundarySec - 0.001);
    const detectedCity = firstClip?.detected_location?.city || "";
    const lagSec = firstClip
      ? Math.max(0, Number(firstClip.timeline_start_sec || boundarySec) - boundarySec)
      : hardBoundaryPolicy.max_topic_switch_latency_sec + 1;

    lagValues.push(round3(lagSec));

    const boundaryViolations = [];
    if (crossingClip) boundaryViolations.push("boundary_crossing");
    if (!firstClip) boundaryViolations.push("missing_first_clip");
    if (hardBoundaryPolicy.forbid_neutral_first_clip && firstClip?.neutral_fallback) boundaryViolations.push("neutral_first_clip_forbidden");
    if (hardBoundaryPolicy.require_location_on_hard_boundary && expectedLocation && !detectedCity) boundaryViolations.push("missing_location_on_first_clip");
    if (expectedLocation && detectedCity && !isSameLocation(detectedCity, expectedLocation)) boundaryViolations.push("wrong_boundary_city");
    if (lagSec > hardBoundaryPolicy.max_topic_switch_latency_sec) boundaryViolations.push("max_visual_lag_exceeded");

    const report = {
      boundary_id: boundaryId,
      boundary_sec: round3(boundarySec),
      expected_location: expectedLocation,
      transition_type: block.transition_type || "hard",
      first_clip_index: firstClip?.clip_index || null,
      first_clip_start_sec: round3(firstClip?.timeline_start_sec || 0),
      first_clip_end_sec: round3(firstClip?.timeline_end_sec || 0),
      first_clip_city: detectedCity,
      first_clip_neutral: Boolean(firstClip?.neutral_fallback),
      lag_sec: round3(lagSec),
      crossing_detected: Boolean(crossingClip),
      chapter_card_required: Boolean(block.chapter_card_required),
      chapter_trigger: block.chapter_trigger || null,
      status: boundaryViolations.length ? "fail" : "pass",
      violations: boundaryViolations,
    };

    reports.push(report);
    if (boundaryViolations.length) {
      violations.push(report);
    }
  });

  return {
    status: violations.length ? "fail" : "pass",
    max_visual_lag_sec: round3(Math.max(0, ...lagValues, 0)),
    avg_visual_lag_sec: round3(lagValues.reduce((acc, lag) => acc + lag, 0) / Math.max(1, lagValues.length)),
    boundaries: reports,
    violations,
  };
};

const computeTimelineSyncMetrics = ({ clips, macroBlocks, policy }) => {
  const lags = [];
  let wrongTopicExposureSec = 0;
  const issues = [];

  macroBlocks.forEach((macro, index) => {
    if (index === 0) return;
    const boundary = Number(macro.start_sec || 0);
    const previousTopic = macroBlocks[index - 1]?.topic || "";
    const crossingClip = clips.find((clip) => Number(clip.timeline_start_sec || 0) < boundary - 0.001 && Number(clip.timeline_end_sec || 0) > boundary + 0.001);
    if (crossingClip) {
      issues.push({
        type: "boundary_crossing",
        boundary_sec: round3(boundary),
        previous_topic: previousTopic,
        expected_topic: macro.topic,
        clip_index: crossingClip.clip_index,
      });
    }

    const firstAfterBoundary = clips.find((clip) => Number(clip.timeline_start_sec || 0) >= boundary - 0.001);
    const isWrong = firstAfterBoundary?.detected_location?.city && belongsToTopic(firstAfterBoundary.detected_location.city, previousTopic);
    const lag = isWrong ? Math.max(0, Number(firstAfterBoundary.timeline_start_sec || boundary) - boundary) : 0;
    lags.push(round3(lag));

    if (lag > policy.max_topic_switch_latency_sec) {
      issues.push({
        type: "topic_switch_lag",
        boundary_sec: round3(boundary),
        previous_topic: previousTopic,
        expected_topic: macro.topic,
        lag_sec: round3(lag),
      });
    }

    if (macro.topic_type === "city" && firstAfterBoundary?.detected_location?.city && !isSameLocation(firstAfterBoundary.detected_location.city, macro.topic)) {
      issues.push({
        type: "wrong_boundary_city",
        boundary_sec: round3(boundary),
        expected_topic: macro.topic,
        detected_city: firstAfterBoundary.detected_location.city,
        clip_index: firstAfterBoundary.clip_index,
      });
    }
  });

  clips.forEach((clip) => {
    const expected = clip.macro_topic;
    const detectedCity = clip.detected_location?.city || "";
    if (expected && detectedCity && !isSameLocation(expected, detectedCity) && clip.topic_type === "city") {
      wrongTopicExposureSec += Number(clip.clip_duration_seconds || 0);
    }
  });

  const sortedLags = [...lags].sort((a, b) => a - b);
  const p95Index = sortedLags.length ? Math.min(sortedLags.length - 1, Math.ceil(sortedLags.length * 0.95) - 1) : 0;
  const semanticScores = clips.map((clip) => Number(clip.timeline_score || 0));

  return {
    avg_topic_lag_sec: round3(lags.reduce((acc, item) => acc + item, 0) / Math.max(1, lags.length)),
    p95_topic_lag_sec: round3(sortedLags[p95Index] || 0),
    max_visual_lag_sec: round3(sortedLags.length ? sortedLags[sortedLags.length - 1] : 0),
    wrong_topic_exposure_sec: round3(wrongTopicExposureSec),
    semantic_alignment_score: round3(semanticScores.reduce((acc, item) => acc + item, 0) / Math.max(1, semanticScores.length)),
    hard_boundary_count: Math.max(0, macroBlocks.length - 1),
    issues,
  };
};

const buildTimeline = async ({ state, audioDuration, draftVersion, fallbackAsset, allowPlaceholderFallback = config.ALLOW_PLACEHOLDER_ASSETS }) => {
  const videoId = state.video_id || "unknown";
  const policy = getSyncPolicy();
  const hardBoundaryPolicy = getHardBoundaryPolicy();
  const audioIntelligence = await getCachedAudioIntelligence({ videoId }).catch(() => null);
  const { macroBlocks, microBlocks } = buildNarrativeBlocks({ state, audioIntelligence, audioDuration });
  const rawAssets = Array.isArray(state.assets_json?.raw_items)
    ? state.assets_json.raw_items
    : (Array.isArray(state.assets_json?.items) ? state.assets_json.items : []);
  const approvedAssets = Array.isArray(state.assets_json?.approved_items)
    ? state.assets_json.approved_items
    : (Array.isArray(state.assets_json?.items) ? state.assets_json.items : []);
  const approvedWindowsContracts = Array.isArray(state.assets_json?.approved_windows)
    ? state.assets_json.approved_windows
    : [];
  const sceneAssetReadiness = Array.isArray(state.assets_json?.scene_asset_readiness)
    ? state.assets_json.scene_asset_readiness
    : [];
  const blockingSceneIndexes = !allowPlaceholderFallback
    ? sceneAssetReadiness
      .filter((entry) => Number(entry.approved_publishable_assets || 0) <= 0 && Number(entry.publishable_assets || 0) <= 0)
      .map((entry) => Number(entry.scene_index || 0))
    : [];

  if (!allowPlaceholderFallback && blockingSceneIndexes.length) {
    throw new Error(`Timeline blocked: missing publishable assets for scene(s) ${blockingSceneIndexes.join(", ")}.`);
  }

  const eligibleApprovedAssets = allowPlaceholderFallback
    ? approvedAssets
    : approvedAssets.filter((asset) => isPublishableAsset(asset, { mockMode: false }));
  const approvedWindowCandidates = approvedWindowsContracts.length
    ? buildApprovedWindowCandidates({ approvedWindows: approvedWindowsContracts, assets: rawAssets })
    : flattenAssetWindows(eligibleApprovedAssets.length ? eligibleApprovedAssets : allowPlaceholderFallback ? [fallbackAsset] : []).map((candidate) => ({
      ...candidate,
      editorial_approved: true,
      approved_window_id: candidate.id,
      narrative_roles_supported: candidate.narrative_roles_supported || [],
      opening_allowed: candidate.opening_allowed !== false,
      closing_allowed: candidate.closing_allowed !== false,
      critical_slot_allowed: candidate.critical_slot_allowed !== false,
      source_tier: candidate.source_tier || "free",
      visual_truth_status: candidate.visual_truth_status || "regional",
    }));
  const assetWindows = approvedWindowCandidates.filter((candidate) => candidate.editorial_approved === true);
  const fallbackCandidate = allowPlaceholderFallback ? buildFallbackCandidate(fallbackAsset) : null;
  const providerReliability = state.assets_json?.provider_reliability || state.render_validation?.provider_reliability || {};

  if (!allowPlaceholderFallback && !assetWindows.length) {
    throw new Error("Timeline blocked: no publishable assets available for render.");
  }
  const usage = {
    usedSourceUrls: new Map(),
    usedAssetIds: new Map(),
    usedLocalPaths: new Map(),
    usedWindowIds: new Map(),
    usedProviders: new Map(),
    usedBlockAssetIds: new Map(),
    usedVisualSignatures: new Map(),
    usedBlockVisualSignatures: new Map(),
    usedBlockProviders: new Map(),
    usedBlockLandmarks: new Map(),
    lastClipByAssetId: new Map(),
  };
  const clips = [];
  const freeCriticalUsageByBlock = new Map();
  const pauseMarkers = Array.isArray(audioIntelligence?.pause_markers) ? audioIntelligence.pause_markers : [];

  for (let blockIndex = 0; blockIndex < microBlocks.length; blockIndex += 1) {
    const block = microBlocks[blockIndex];
    const previousBlock = microBlocks[blockIndex - 1] || null;
    const previousMacroTopic = block.hard_boundary ? previousBlock?.macro_topic || "" : "";
    const slots = splitBlockIntoTimelineSlots({ block, policy, pauseMarkers });

    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const slot = slots[slotIndex];
      const isBoundaryFirstSlot = Boolean(block.hard_boundary && slotIndex === 0);
      const slotRole = slot.slot_role || inferNarrativeSlotRole({ block, slotIndex, totalSlots: slots.length });
      const criticalSlot = slot.critical_slot === true || isBoundaryFirstSlot;
      const sceneFallbackNarration = `${block.topic || ""} ${block.narration_excerpt || ""} ${(block.keywords || []).join(" ")}`.trim();
      const narrationText = getNarrationTextBetween({
        words: audioIntelligence?.words || [],
        startSeconds: slot.start,
        endSeconds: slot.end,
        fallback: sceneFallbackNarration,
      });
      const candidates = filterCandidatesByHardRules({
        block,
        assetWindows,
        previousMacroTopic,
        fallbackAsset,
        allowPlaceholderFallback,
        isBoundaryFirstSlot,
        criticalSlot,
        slotRole,
        hardBoundaryPolicy,
      });
      const ranked = await rankCandidates({
        block: {
          ...block,
          is_boundary_first_slot: isBoundaryFirstSlot,
        },
        narrationText,
        candidates,
        previousMacroTopic,
        usage,
        videoId,
        clipIndex: clips.length + 1,
        hardBoundaryPolicy,
        isBoundaryFirstSlot,
        slotRole,
        criticalSlot,
        providerReliability,
      });
      const approvedDegradeCandidate = assetWindows.find((item) => item.editorial_approved === true)
        ? {
            candidate: assetWindows.find((item) => item.editorial_approved === true),
            score: -8,
            features: {},
            selection_reason: "approved_pool_degrade",
          }
        : null;
      const selectedFromPolicy = selectBySourceTierPolicy({
        ranked,
        slotRole,
        criticalSlot,
        block,
        freeCriticalUsageByBlock,
      });
      const policySelected = selectedFromPolicy
        || ranked.find((item) => !item.hard_blocked)
        || ranked[0]
        || approvedDegradeCandidate
        || (fallbackCandidate
          ? { candidate: fallbackCandidate, score: -10, features: {}, selection_reason: "fallback" }
          : null);
      const diversitySelection = selectWithDiversityQuota({
        ranked,
        preselected: policySelected,
        block,
        usage,
        criticalSlot,
      });
      const selected = diversitySelection.selected;

      if (!selected?.candidate) {
        throw new Error(`Timeline blocked: no publishable candidate available for scene ${block.scene_index}.`);
      }

      let candidate = selected.candidate || fallbackCandidate;
      if (criticalSlot) {
        const criticalUnsafe = !candidate
          || candidate.critical_slot_allowed === false
          || (slotRole === "closing_payoff" && candidate.closing_allowed === false)
          || String(candidate.visual_truth_status || "").toLowerCase() === "uncertain"
          || String(candidate.visual_truth_status || "").toLowerCase() === "wrong";
        if (criticalUnsafe) {
          const saferCriticalCandidates = assetWindows
            .filter((item) =>
              Number(item.scene_index || 0) === Number(block.scene_index || 0)
              && item.editorial_approved === true
              && item.critical_slot_allowed !== false
              && ["exact", "regional"].includes(String(item.visual_truth_status || "").toLowerCase())
              && (slotRole !== "opening_establishing" || item.opening_allowed !== false)
              && (slotRole !== "closing_payoff" || item.closing_allowed !== false)
            )
            .sort((left, right) => Number(right.editorial_confidence || right.confidence || 0) - Number(left.editorial_confidence || left.confidence || 0));
          if (saferCriticalCandidates.length) {
            candidate = saferCriticalCandidates[0];
          } else if (slotRole === "closing_payoff") {
            const crossSceneClosingCandidates = assetWindows
              .filter((item) =>
                item.editorial_approved === true
                && item.critical_slot_allowed !== false
                && item.closing_allowed !== false
                && ["exact", "regional"].includes(String(item.visual_truth_status || "").toLowerCase())
              )
              .sort((left, right) => Number(right.editorial_confidence || right.confidence || 0) - Number(left.editorial_confidence || left.confidence || 0));
            if (crossSceneClosingCandidates.length) {
              candidate = crossSceneClosingCandidates[0];
            }
          }
        }
      }
      const themeEvidenceMatched = candidateHasThemeEvidence({ block, candidate });
      const boundaryForcedViolationCodes = [];
      const expectedLocation = block.expected_location || block.location?.city || (block.topic_type === "city" ? block.macro_topic : "");
      if (
        isBoundaryFirstSlot
        && hardBoundaryPolicy.forbid_neutral_first_clip
        && candidate.neutral
      ) {
        boundaryForcedViolationCodes.push("neutral_first_clip_forbidden");
      }
      if (
        isBoundaryFirstSlot
        && hardBoundaryPolicy.require_location_on_hard_boundary
        && expectedLocation
        && !candidate.location?.city
      ) {
        boundaryForcedViolationCodes.push("missing_location_on_first_clip");
      }
      const assetReuseIndex = usage.usedAssetIds.get(candidate.asset_id) || 0;
      const sourceWindow = buildVideoSourceWindow({
        asset: candidate.asset,
        clipDuration: slot.duration,
        preferredWindow: candidate,
        assetReuseIndex,
        clipIndex: clips.length + 1,
        draftVersion,
      });
      const detectedVisualCategories = unique([
        ...(candidate.detected_visual_categories || []),
        ...((selected.features?.detectedVisualCategories) || []),
      ]);
      registerClipUsage({ usage, block, candidate, clipIndex: clips.length + 1 });
      if (criticalSlot && ["free", "generated"].includes(String(candidate.source_tier || "free").toLowerCase())) {
        const blockKey = String(block.block_id || block.id || block.scene_index || "unknown_block");
        freeCriticalUsageByBlock.set(blockKey, Number(freeCriticalUsageByBlock.get(blockKey) || 0) + 1);
      }

      clips.push({
        clip_index: clips.length + 1,
        scene_index: block.scene_index,
        scene_role: block.role || "body",
        scene_order: block.scene_order,
        title: block.topic,
        narration_excerpt: block.narration_excerpt,
        clip_script_excerpt: narrationText.slice(0, 240),
        clip_script_source: (audioIntelligence?.words || []).length ? "audio_word_timestamps" : "scene_fallback",
        clip_duration_seconds: slot.duration,
        timeline_start_sec: round3(slot.start),
        timeline_end_sec: round3(slot.end),
        clip_start_narrated_at: round3(slot.start),
        clip_end_narrated_at: round3(slot.end),
        cut_reason: slot.cutReason,
        source_start_seconds: sourceWindow.source_start_seconds,
        source_end_seconds: sourceWindow.source_end_seconds,
        asset_duration_seconds: sourceWindow.asset_duration_seconds,
        semantic_match_score: round3(selected.features?.semanticScore || 0),
        block_match_score: round3(selected.features?.blockMatchScore || 0),
        entity_match_score: round3(selected.features?.entityMatchScore || 0),
        visual_specificity_score: round3(selected.features?.visualSpecificityScore || 0),
        reuse_penalty: round3(selected.features?.reusePenalty || 0),
        timeline_score: round3(selected.score || 0),
        composite_score: round3(selected.score || 0),
        semantic_match_method: selected.method || "keyword_fallback",
        semantic_match_terms: buildSemanticTerms([narrationText, candidate.semantic_text]).filter((term) => buildSemanticTerms([narrationText]).includes(term)).slice(0, 12),
        selection_reason: selected.selection_reason || "best_candidate",
        rejected_candidates_count: Math.max(0, ranked.length - 1),
        candidate_debug: {
          top_rejected_reasons: summarizeRejectedReasons(ranked),
        },
        score_features: selected.features || {},
        visual_intent: block.visual_intent,
        required_visual_evidence: block.required_visual_evidence || [],
        allowed_visual_categories: block.allowed_visual_categories || [],
        forbidden_visual_categories: block.forbidden_visual_categories || [],
        asset_semantic_text: candidate.description || candidate.semantic_text || candidate.asset?.semantic_text || candidate.asset?.query || "",
        asset_window_id: candidate.id,
        asset_window_key: `${candidate.asset_id}:${candidate.start_sec}:${candidate.end_sec}`,
        asset_window_summary: candidate.description || candidate.summary || "",
        asset_window_start_seconds: Number(candidate.start_sec || 0),
        asset_window_end_seconds: Number(candidate.end_sec || 0),
        asset_analysis_provider: candidate.analysis_provider,
        detected_visual_categories: detectedVisualCategories,
        detected_objects: candidate.detected_objects || [],
        visual_intent_match: candidate.visual_intent_match === true || Number(selected.features?.visualIntentMatchScore || 0) > 0,
        macro_block_id: block.parent_id,
        micro_block_id: block.id,
        block_id: block.block_id,
        macro_topic: block.macro_topic,
        micro_topic: block.topic,
        subtheme: block.subtheme,
        topic_type: block.topic_type,
        hard_boundary: Boolean(block.hard_boundary),
        hard_boundary_first_clip: isBoundaryFirstSlot,
        transition_type: block.transition_type || (block.hard_boundary ? "hard" : "soft"),
        boundary_id: block.boundary_id || "",
        expected_location: block.expected_location || "",
        expected_visual_start_sec: Number(block.expected_visual_start_sec || block.start_sec || 0),
        chapter_trigger: block.chapter_trigger || null,
        chapter_card_required: Boolean(block.chapter_card_required),
        block_intro_asset: block.block_intro_asset || null,
        chapter_card_clip: Boolean(candidate.chapter_card_clip),
        transition: isBoundaryFirstSlot ? (block.hard_boundary ? "hard_cut" : "soft_cut") : "none",
        detected_location: candidate.location,
        detected_landmarks: candidate.landmarks,
        neutral_fallback: Boolean(candidate.neutral),
        visual_signature: buildVisualSignature(candidate),
        query_used: candidate.asset?.query_used || candidate.asset?.query || "",
        visual_truth_status: candidate.visual_truth_status || "regional",
        visual_observation_origin: candidate.visual_observation_origin || "real_vision",
        narrative_role_selected: slotRole,
        critical_slot: criticalSlot,
        editorial_slot_ok: candidate.editorial_approved === true
          && (!criticalSlot || candidate.critical_slot_allowed !== false)
          && (slotRole !== "opening_establishing" || candidate.opening_allowed !== false)
          && (slotRole !== "closing_payoff" || candidate.closing_allowed !== false),
        editorial_slot_violation_codes: unique([
          ...(criticalSlot && candidate.critical_slot_allowed === false ? ["critical_slot_not_allowed"] : []),
          ...(slotRole === "opening_establishing" && candidate.opening_allowed === false ? ["opening_not_allowed"] : []),
          ...(slotRole === "closing_payoff" && candidate.closing_allowed === false ? ["closing_not_allowed"] : []),
          ...(candidate.editorial_approved !== true ? ["not_editorially_approved"] : []),
          ...(criticalSlot && (
            String(candidate.source_tier || "free").toLowerCase() === "generated"
            || (String(candidate.source_tier || "free").toLowerCase() === "free" && !isStrongFreeCriticalCandidate(candidate))
          ) ? ["critical_slot_weak_source_tier"] : []),
          ...(FOOD_VISUAL_INTENTS.has(String(block.visual_intent || "").toLowerCase()) && !themeEvidenceMatched ? ["theme_evidence_missing_for_intent"] : []),
          ...(selected?.hard_blocked ? ["hard_boundary_candidate_forced"] : []),
          ...(diversitySelection.forced ? ["diversity_quota_enforced"] : []),
          ...boundaryForcedViolationCodes,
        ]),
        source_tier: candidate.source_tier || "free",
        approved_window_id: candidate.approved_window_id || candidate.id,
        visual_observation_origin: candidate.visual_observation_origin || "real_vision",
        theme_evidence_present: themeEvidenceMatched,
        asset: candidate.asset,
      });
    }
  }

  const plannedDuration = clips.reduce((acc, clip) => acc + Number(clip.clip_duration_seconds || 0), 0);
  const durationDiff = round3(Number(audioDuration || 0) - plannedDuration);
  if (clips.length && Math.abs(durationDiff) > 0.02) {
    const lastClip = clips[clips.length - 1];
    lastClip.clip_duration_seconds = round3(Math.max(0.1, Number(lastClip.clip_duration_seconds || 0) + durationDiff));
    lastClip.timeline_end_sec = round3(Number(lastClip.timeline_start_sec || 0) + lastClip.clip_duration_seconds);
    lastClip.clip_end_narrated_at = lastClip.timeline_end_sec;
    lastClip.source_end_seconds = round3(Number(lastClip.source_start_seconds || 0) + lastClip.clip_duration_seconds);
  }

  const uniqueAssetCount = new Set(clips.map((clip) => clip.asset?.local_path || clip.asset?.source_url).filter(Boolean)).size;
  const semanticScores = clips.map((clip) => Number(clip.timeline_score || 0));
  const hardBoundaryValidation = evaluateHardBoundaryDeterministic({ clips, microBlocks, hardBoundaryPolicy });

  const timelineSyncMetricsBase = computeTimelineSyncMetrics({
    clips,
    macroBlocks,
    policy: {
      ...policy,
      max_topic_switch_latency_sec: hardBoundaryPolicy.max_topic_switch_latency_sec,
    },
  });
  const timelineSyncMetrics = {
    ...timelineSyncMetricsBase,
    hard_boundary_status: hardBoundaryValidation.status,
    timeline_uses_approved_pool_only: true,
    max_visual_lag_sec: round3(Math.max(
      Number(timelineSyncMetricsBase.max_visual_lag_sec || 0),
      Number(hardBoundaryValidation.max_visual_lag_sec || 0)
    )),
    avg_visual_lag_sec: hardBoundaryValidation.avg_visual_lag_sec,
    hard_boundary_reports: hardBoundaryValidation.boundaries,
    hard_boundary_violations: hardBoundaryValidation.violations,
  };

  return {
    clips,
    clipPlan: clips,
    audioDuration,
    totalClipCount: clips.length,
    uniqueAssetCount,
    semanticAlignmentScoreAverage: round3(semanticScores.reduce((acc, score) => acc + score, 0) / Math.max(1, semanticScores.length)),
    lowConfidenceClipCount: semanticScores.filter((score) => score < 0).length,
    narrativeBlocks: macroBlocks,
    microBlocks,
    assetWindows: assetWindows.map((window) => ({
      id: window.id,
      approved_window_id: window.approved_window_id || window.id,
      asset_id: window.asset_id,
      scene_index: window.scene_index,
      start_sec: window.start_sec,
      end_sec: window.end_sec,
      description: window.description,
      tags: window.tags,
      location: window.location,
      landmarks: window.landmarks,
      location_type: window.location_type,
      confidence: window.confidence,
      neutral: window.neutral,
      visual_evidence_source: window.visual_evidence_source,
      visual_observation_origin: window.visual_observation_origin || "real_vision",
      visual_truth_status: window.visual_truth_status || "regional",
      source_tier: window.source_tier || "free",
    })),
    syncPolicy: policy,
    hardBoundaryPolicy,
    timelineSyncMetrics,
    transition: "none",
    renderStrategy: "concat",
    requiresExactSync: true,
  };
};

module.exports = {
  buildTimeline,
  chooseOutputResolution,
  buildVideoSourceWindow,
  normalizeAssetAnalysisWindows,
  buildNarrativeBlocks,
  flattenAssetWindows,
  filterCandidatesByHardRules,
  getNarrationTextBetween,
  getSyncPolicy,
  __test__: {
    normalizeAssetAnalysisWindows,
    buildNarrativeBlocks,
    buildApprovedWindowCandidates,
    flattenAssetWindows,
    filterCandidatesByHardRules,
    computeTimelineSyncMetrics,
    evaluateHardBoundaryDeterministic,
    inferNarrativeSlotRole,
    isCriticalSlotForBlock,
    selectBySourceTierPolicy,
    detectLocation,
    detectLandmarks,
    detectSubtheme,
    isSameLocation,
    belongsToTopic,
    splitBlockIntoTimelineSlots,
    getNarrationTextBetween,
  },
};
