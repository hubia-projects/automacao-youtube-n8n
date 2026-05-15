const { config } = require("../config/env");
const { detectLocation, isSameLocation } = require("./narrativeBlockPlanner");
const { detectVisualCategories, evaluateVisualEvidence, normalizeLabel } = require("./visualIntentService");

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
const buildSearchHypothesisText = (candidate = {}) =>
  [
    candidate.query_used,
    candidate.query,
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

const computeCityHintScore = ({ scene, text }) => {
  if (!scene.location?.city) return 0;
  const detected = detectLocation(text);
  if (detected.city && isSameLocation(detected.city, scene.location.city)) return 1;
  if (normalizeLabel(text).includes(normalizeLabel(scene.location.city))) return 0.75;
  return 0;
};

const containsAny = (text = "", values = []) =>
  (values || []).some((value) => {
    const normalizedValue = normalizeLabel(value);
    return normalizedValue && normalizeLabel(text).includes(normalizedValue);
  });

const isLowResolutionCandidate = (candidate = {}) => {
  const width = Number(candidate.width || candidate.resolution?.width || 0);
  const height = Number(candidate.height || candidate.resolution?.height || 0);
  return width < 1280 || height < 720;
};

const isShortVideo = (candidate = {}) =>
  (candidate.asset_type === "video" || candidate.type === "video")
  && Number(candidate.duration_estimate || 0) > 0
  && Number(candidate.duration_estimate || 0) < 2.5;

const scorePreDownloadCandidate = ({ candidate, scene }) => {
  const hypothesisText = buildSearchHypothesisText(candidate);
  const hintCategories = detectVisualCategories({ text: hypothesisText, tags: candidate.provider_tags || [] });
  const positiveMatches = countMatches(hypothesisText, POSITIVE_GASTRONOMY_TERMS);
  const negativeMatches = countMatches(hypothesisText, NEGATIVE_GASTRONOMY_TERMS);
  const cityHintScore = computeCityHintScore({ scene, text: hypothesisText });
  const videoBonus = candidate.asset_type === "video" || candidate.type === "video" ? 1 : 0;
  const resolutionScore = computeResolutionScore(candidate);
  const genericTravelPenalty = (negativeMatches > positiveMatches && FOOD_INTENTS.has(scene.visual_intent)) ? 1 : 0;
  const lowResolutionPenalty = isLowResolutionCandidate(candidate) ? 1 : 0;
  const shortVideoPenalty = isShortVideo(candidate) ? 1 : 0;
  const negativeKeywordPenalty = containsAny(hypothesisText, scene.negative_keywords || scene.forbidden_locations || []) ? 1 : 0;
  const intentHintScore = FOOD_INTENTS.has(scene.visual_intent)
    ? Math.max(0, (positiveMatches - negativeMatches) / Math.max(1, POSITIVE_GASTRONOMY_TERMS.length / 4))
    : 0.45;

  const preDownloadScore =
    intentHintScore * 4 +
    cityHintScore * 3 +
    videoBonus * 2 +
    resolutionScore -
    genericTravelPenalty * 3 -
    lowResolutionPenalty * 4 -
    shortVideoPenalty * 2 -
    negativeKeywordPenalty * 6;

  const rejectionReason = negativeKeywordPenalty
    ? "query_matches_negative_keywords"
    : lowResolutionPenalty
      ? "insufficient_resolution"
      : shortVideoPenalty
        ? "video_too_short"
        : genericTravelPenalty >= 1 && !scene.generic_asset_allowed
          ? "generic_search_hypothesis_for_specific_intent"
          : "";

  return {
    pre_download_score: Number(preDownloadScore.toFixed(3)),
    intent_match: intentHintScore >= 0.45,
    generic_asset: Boolean(genericTravelPenalty),
    detected_visual_categories: hintCategories,
    rejection_reason: rejectionReason,
    pre_download_rejected: Boolean(rejectionReason),
    evidence_mode: "retrieval_hypothesis_only",
  };
};

const shouldRejectAssetForScene = ({ asset = {}, scene = {}, window = {} }) => {
  const evidence = evaluateVisualEvidence({ scene, window, asset });
  const text = [window.summary, window.description, ...(window.tags || []), ...(window.detected_objects || [])].filter(Boolean).join(" ");
  const detectedLocation = detectLocation(text, window.location);
  const windowDuration = Number(window.duration_seconds || Math.max(0, Number(window.end_seconds || 0) - Number(window.start_seconds || 0)));
  const expectedLocation = scene.expected_location || scene.location?.city || (scene.topic_type === "city" ? scene.macro_topic : "");
  const isHardBoundaryFirstSlot = Boolean(scene.hard_boundary && scene.is_boundary_first_slot);

  if (isHardBoundaryFirstSlot && config.HARD_BOUNDARY_FORBID_NEUTRAL_FIRST_CLIP && (asset.neutral || window.neutral || evidence.generic_visual)) {
    return {
      reject: true,
      reason: "neutral_first_clip_forbidden",
      warnings: ["hard_boundary_first_clip_must_be_specific"],
      evidence,
    };
  }

  if (isHardBoundaryFirstSlot && config.HARD_BOUNDARY_REQUIRE_LOCATION && expectedLocation && !detectedLocation.city) {
    return {
      reject: true,
      reason: "hard_boundary_missing_location",
      warnings: ["missing_location"],
      evidence,
    };
  }

  if (expectedLocation && detectedLocation.city && !isSameLocation(detectedLocation.city, expectedLocation)) {
    return {
      reject: true,
      reason: "wrong_block_city",
      warnings: ["asset_belongs_to_other_city"],
      evidence,
    };
  }

  if (!scene.generic_asset_allowed && !evidence.visual_intent_match) {
    return {
      reject: true,
      reason: evidence.missing_required_visual_evidence.length ? "missing_required_visual_evidence" : "visual_intent_mismatch",
      warnings: evidence.missing_required_visual_evidence,
      evidence,
    };
  }

  if (!scene.generic_asset_allowed && evidence.generic_visual) {
    return {
      reject: true,
      reason: "generic_visual_for_specific_intent",
      warnings: ["generic_visual"],
      evidence,
    };
  }

  if (scene.generic_asset_allowed_reason === "establishing_shot" && evidence.generic_visual && windowDuration > Number(scene.max_generic_establishing_seconds || 3)) {
    return {
      reject: true,
      reason: "generic_establishing_too_long",
      warnings: ["generic_visual_duration_exceeded"],
      evidence,
    };
  }

  return {
    reject: false,
    reason: "",
    warnings: evidence.missing_required_visual_evidence,
    evidence,
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
