const { config } = require("../config/env");
const { detectLocation, isSameLocation } = require("./narrativeBlockPlanner");
const { detectVisualCategories, evaluateVisualEvidence, normalizeLabel } = require("./visualIntentService");
const { classifyEditorialCandidate, isCriticalNarrativeRole } = require("./editorialPlanningService");

const POSITIVE_GASTRONOMY_TERMS = [
  "food", "meal", "dish", "restaurant", "cafe", "bakery", "pastry", "market", "wine", "glass", "kitchen",
  "chef", "eating", "dinner", "lunch", "seafood", "fish", "meat", "dessert", "coffee", "bar", "cellar",
  "grapes", "vineyard", "tasting", "pastel", "nata", "francesinha", "codfish", "bacalhau",
];

const NEGATIVE_GASTRONOMY_TERMS = [
  "skyline", "aerial", "drone", "bridge", "river", "coast", "beach", "clouds", "monument", "castle",
  "generic street", "cityscape", "landscape", "mountain", "tram", "tower",
];

const FOOD_INTENTS = new Set(["gastronomy", "market", "wine", "pastry", "restaurant", "cafe", "street_food"]);

const unique = (values = []) => [...new Set(values.filter(Boolean))];

const buildMetadataText = (candidate = {}) =>
  [
    candidate.query_used,
    candidate.query,
    candidate.semantic_text,
    candidate.provider_title,
    ...(candidate.provider_tags || []),
  ].filter(Boolean).join(" ");

const countMatches = (text = "", terms = []) => terms.filter((term) => normalizeLabel(text).includes(normalizeLabel(term))).length;

const computeResolutionScore = (candidate = {}) => {
  const width = Number(candidate.width || candidate.resolution?.width || 0);
  const height = Number(candidate.height || candidate.resolution?.height || 0);
  if (width >= 1920 && height >= 1080) return 1;
  if (width >= 1280 && height >= 720) return 0.7;
  return 0.2;
};

const computeCityMatch = ({ scene, text }) => {
  if (!scene.location?.city) return 0;
  const detected = detectLocation(text);
  if (detected.city && isSameLocation(detected.city, scene.location.city)) return 1;
  if (normalizeLabel(text).includes(normalizeLabel(scene.location.city))) return 0.75;
  return 0;
};

const countNegativeKeywordHits = ({ scene = {}, metadataText = "" }) => {
  const negativeKeywords = unique([...(scene.negative_keywords || []), ...(scene.forbidden_locations || [])]).map((value) => normalizeLabel(value));
  const normalizedText = normalizeLabel(metadataText);
  return negativeKeywords.filter((keyword) => keyword && normalizedText.includes(keyword)).length;
};

const scorePreDownloadCandidate = ({ candidate, scene }) => {
  const metadataText = buildMetadataText(candidate);
  const metadataCategories = detectVisualCategories({ text: metadataText, tags: candidate.provider_tags || [] });
  const evidence = evaluateVisualEvidence({
    scene,
    window: {
      summary: metadataText,
      tags: candidate.provider_tags || [],
      detected_visual_categories: metadataCategories,
    },
    asset: candidate,
  });

  const positiveMatches = countMatches(metadataText, POSITIVE_GASTRONOMY_TERMS);
  const negativeMatches = countMatches(metadataText, NEGATIVE_GASTRONOMY_TERMS);
  const negativeKeywordHits = countNegativeKeywordHits({ scene, metadataText });
  const queryIntentMatch = evidence.visual_intent_match ? 1 : evidence.required_evidence_score;
  const providerTagIntentMatch = candidate.provider_tags?.length
    ? evaluateVisualEvidence({
        scene,
        window: {
          summary: (candidate.provider_tags || []).join(" "),
          tags: candidate.provider_tags || [],
          detected_visual_categories: detectVisualCategories({ tags: candidate.provider_tags || [] }),
        },
        asset: candidate,
      }).required_evidence_score
    : 0;
  const cityMatch = computeCityMatch({ scene, text: metadataText });
  const videoBonus = candidate.asset_type === "video" || candidate.type === "video" ? 1 : 0;
  const resolutionScore = computeResolutionScore(candidate);
  const forbiddenCategoryPenalty = evidence.forbidden_category_penalty;
  const genericTravelPenalty = evidence.generic_visual || (negativeMatches > positiveMatches && FOOD_INTENTS.has(scene.visual_intent)) ? 1 : 0;
  const preDownloadScore =
    queryIntentMatch * 5 +
    providerTagIntentMatch * 4 +
    cityMatch * 3 +
    videoBonus * 2 +
    resolutionScore -
    forbiddenCategoryPenalty * 8 -
    genericTravelPenalty * 5 -
    negativeKeywordHits * 3.5;

  const missingRequired = !scene.generic_asset_allowed && !evidence.visual_intent_match;
  const rejectionReason = missingRequired
    ? "missing_required_visual_evidence"
    : negativeKeywordHits > 0
      ? "negative_keyword_match"
      : forbiddenCategoryPenalty >= 0.5
        ? "forbidden_visual_category"
        : genericTravelPenalty >= 1 && !scene.generic_asset_allowed
          ? "generic_travel_metadata"
          : "";

  return {
    pre_download_score: Number(preDownloadScore.toFixed(3)),
    intent_match: evidence.visual_intent_match,
    generic_asset: Boolean(genericTravelPenalty),
    detected_visual_categories: evidence.detected_visual_categories,
    rejection_reason: rejectionReason,
    pre_download_rejected: Boolean(rejectionReason),
  };
};

const shouldRejectAssetForScene = ({ asset = {}, scene = {}, window = {} }) => {
  const evidence = evaluateVisualEvidence({ scene, window, asset });
  const text = [window.summary, window.description, asset.semantic_text, asset.query].filter(Boolean).join(" ");
  const detectedLocation = detectLocation(text, window.location);
  const windowDuration = Number(window.duration_seconds || Math.max(0, Number(window.end_seconds || 0) - Number(window.start_seconds || 0)));
  const expectedLocation = scene.expected_location || scene.location?.city || (scene.topic_type === "city" ? scene.macro_topic : "");
  const isHardBoundaryFirstSlot = Boolean(scene.hard_boundary && scene.is_boundary_first_slot);
  const narrativeRole = scene.narrative_role || "body";
  const negativeKeywordHits = countNegativeKeywordHits({ scene, metadataText: text });
  const editorial = classifyEditorialCandidate({
    scene,
    block: scene,
    candidate: {
      description: window.summary || window.description || asset.semantic_text || asset.query || "",
      summary: window.summary || window.description || asset.semantic_text || asset.query || "",
      semantic_text: asset.semantic_text || asset.query || "",
      query_used: asset.query_used || asset.query || "",
      tags: unique([...(window.tags || []), ...(asset.provider_tags || []), ...(asset.analysis_tags || [])]),
      detected_visual_categories: unique([...(window.detected_visual_categories || []), ...(asset.detected_visual_categories || [])]),
      detected_objects: window.detected_objects || [],
      location: window.location || asset.location || {},
      confidence: Number(window.confidence || asset.confidence || 0),
      visual_evidence_source: window.visual_evidence_source || asset.analysis_provider || asset.asset_analysis_provider || "metadata_fallback",
      analysis_provider: window.method || asset.analysis_provider || asset.asset_analysis_provider || "metadata_fallback",
      asset,
    },
    evidence,
  });

  if (negativeKeywordHits > 0) {
    return {
      reject: true,
      reason: "negative_keyword_match",
      warnings: ["negative_keyword_match"],
      evidence,
      editorial,
    };
  }

  if (isHardBoundaryFirstSlot && config.HARD_BOUNDARY_FORBID_NEUTRAL_FIRST_CLIP && (asset.neutral || window.neutral || evidence.generic_visual)) {
    return {
      reject: true,
      reason: "neutral_first_clip_forbidden",
      warnings: ["hard_boundary_first_clip_must_be_specific"],
      evidence,
      editorial,
    };
  }

  if (isHardBoundaryFirstSlot && config.HARD_BOUNDARY_REQUIRE_LOCATION && expectedLocation && !detectedLocation.city) {
    return {
      reject: true,
      reason: "hard_boundary_missing_location",
      warnings: ["missing_location"],
      evidence,
      editorial,
    };
  }

  if (expectedLocation && detectedLocation.city && !isSameLocation(detectedLocation.city, expectedLocation)) {
    return {
      reject: true,
      reason: "wrong_block_city",
      warnings: ["asset_belongs_to_other_city"],
      evidence,
      editorial,
    };
  }

  if (editorial.status === "wrong") {
    return {
      reject: true,
      reason: editorial.reason || "editorial_wrong",
      warnings: ["editorial_wrong"],
      evidence,
      editorial,
    };
  }

  if (editorial.critical_role && ["generic", "uncertain"].includes(editorial.status)) {
    return {
      reject: true,
      reason: `critical_slot_${editorial.status}`,
      warnings: ["critical_slot_requires_exact_or_regional"],
      evidence,
      editorial,
    };
  }

  if (!scene.generic_asset_allowed && !evidence.visual_intent_match) {
    return {
      reject: true,
      reason: evidence.missing_required_visual_evidence.length ? "missing_required_visual_evidence" : "visual_intent_mismatch",
      warnings: evidence.missing_required_visual_evidence,
      evidence,
      editorial,
    };
  }

  if (!scene.generic_asset_allowed && evidence.generic_visual) {
    return {
      reject: true,
      reason: "generic_visual_for_specific_intent",
      warnings: ["generic_visual"],
      evidence,
      editorial,
    };
  }

  if (scene.generic_asset_allowed_reason === "establishing_shot" && evidence.generic_visual && windowDuration > Number(scene.max_generic_establishing_seconds || 3)) {
    return {
      reject: true,
      reason: "generic_establishing_too_long",
      warnings: ["generic_visual_duration_exceeded"],
      evidence,
      editorial,
    };
  }

  if (isCriticalNarrativeRole(narrativeRole) && editorial.status === "regional" && Number(editorial.required_evidence_score || 0) < 0.55) {
    return {
      reject: true,
      reason: "critical_slot_needs_stronger_proof",
      warnings: ["critical_slot_needs_stronger_proof"],
      evidence,
      editorial,
    };
  }

  return {
    reject: false,
    reason: "",
    warnings: evidence.missing_required_visual_evidence,
    evidence,
    editorial,
  };
};

module.exports = {
  NEGATIVE_GASTRONOMY_TERMS,
  POSITIVE_GASTRONOMY_TERMS,
  scorePreDownloadCandidate,
  shouldRejectAssetForScene,
  __test__: {
    scorePreDownloadCandidate,
    shouldRejectAssetForScene,
  },
};