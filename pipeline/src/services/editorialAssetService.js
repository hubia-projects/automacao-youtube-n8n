const { detectLocation, isSameLocation } = require("./narrativeBlockPlanner");
const { evaluateVisualEvidence } = require("./visualIntentService");

const FIT_PRIORITY = {
  wrong: 0,
  uncertain: 1,
  generic: 2,
  regional: 3,
  exact: 4,
};

const SPECIFIC_INTENTS = new Set([
  "gastronomy",
  "market",
  "wine",
  "pastry",
  "restaurant",
  "cafe",
  "street_food",
]);
const CRITICAL_ROLES = new Set(["intro", "hook", "outro", "closing"]);
const WEAK_EVIDENCE_SOURCES = new Set(["metadata_fallback"]);

const unique = (values = []) => [...new Set(values.filter(Boolean))];

const getSceneRole = (scene = {}) => String(scene.role || scene.scene_role || "body").toLowerCase();
const getExpectedLocation = (scene = {}) => scene.expected_location || scene.location?.city || "";
const getExpectedCountry = (scene = {}) => scene.location?.country || "";

const isSpecificScene = (scene = {}) =>
  SPECIFIC_INTENTS.has(scene.visual_intent) ||
  (Array.isArray(scene.required_visual_evidence) && scene.required_visual_evidence.length > 0 && scene.generic_asset_allowed !== true);

const isCriticalScene = (scene = {}) =>
  CRITICAL_ROLES.has(getSceneRole(scene)) || Boolean(scene.hard_boundary || scene.chapter_card_required);

const getWindowText = ({ window = {}, asset = {} } = {}) =>
  [
    window.summary,
    window.description,
    asset.semantic_text,
    asset.query,
    ...(window.tags || []),
    ...(asset.analysis_tags || []),
    ...(asset.provider_tags || []),
  ]
    .filter(Boolean)
    .join(" ");

const getDetectedLocation = ({ window = {}, asset = {} } = {}) => {
  if (window.location?.city) {
    return {
      city: window.location.city,
      country: window.location.country || "",
      confidence: Number(window.location.confidence || 0),
      source: window.location.source || "window",
    };
  }

  return detectLocation(getWindowText({ window, asset }));
};

const getEvidenceSource = ({ window = {}, asset = {} } = {}) =>
  window.visual_evidence_source || window.method || asset.analysis_provider || "metadata_fallback";

const buildWindowEditorialAssessment = ({ scene = {}, asset = {}, window = {} } = {}) => {
  const evidence = evaluateVisualEvidence({ scene, asset, window });
  const expectedLocation = getExpectedLocation(scene);
  const expectedCountry = getExpectedCountry(scene);
  const detectedLocation = getDetectedLocation({ window, asset });
  const sameLocation = Boolean(expectedLocation && detectedLocation.city && isSameLocation(detectedLocation.city, expectedLocation));
  const wrongLocation = Boolean(expectedLocation && detectedLocation.city && !sameLocation);
  const sameCountry = Boolean(!expectedCountry || !detectedLocation.country || detectedLocation.country === expectedCountry);
  const evidenceSource = getEvidenceSource({ window, asset });
  const weakEvidenceSource = WEAK_EVIDENCE_SOURCES.has(evidenceSource);
  const specificScene = isSpecificScene(scene);
  const criticalScene = isCriticalScene(scene);
  const strongEvidence = evidence.visual_intent_match && Number(evidence.required_evidence_score || 0) >= 0.5;
  const partialEvidence = evidence.visual_intent_match && Number(evidence.required_evidence_score || 0) >= 0.25;

  let editorialFit = "generic";
  const reasons = [];

  if (wrongLocation || Number(evidence.forbidden_category_penalty || 0) >= 0.5) {
    editorialFit = "wrong";
    reasons.push(wrongLocation ? "wrong_location" : "forbidden_category");
  } else if (sameLocation && strongEvidence && !evidence.generic_visual && !weakEvidenceSource) {
    editorialFit = "exact";
  } else if ((sameLocation || (!expectedLocation && sameCountry) || (!detectedLocation.city && partialEvidence)) && partialEvidence && !evidence.generic_visual && !weakEvidenceSource) {
    editorialFit = "regional";
  } else if (specificScene && (weakEvidenceSource || (!strongEvidence && !evidence.generic_visual))) {
    editorialFit = "uncertain";
    reasons.push(weakEvidenceSource ? "metadata_only" : "missing_strong_evidence");
  } else if (specificScene && evidence.generic_visual) {
    editorialFit = "generic";
    reasons.push("generic_visual");
  } else if (!specificScene && weakEvidenceSource && !sameLocation) {
    editorialFit = "uncertain";
    reasons.push("metadata_only");
  } else if (!specificScene && partialEvidence && !evidence.generic_visual) {
    editorialFit = sameLocation ? "exact" : "regional";
  }

  if (!evidence.visual_intent_match && !scene.generic_asset_allowed && editorialFit !== "wrong") {
    editorialFit = weakEvidenceSource ? "uncertain" : "generic";
    reasons.push("visual_intent_mismatch");
  }

  const approvedForTimeline =
    editorialFit !== "wrong" &&
    (specificScene ? ["exact", "regional"].includes(editorialFit) : editorialFit !== "uncertain");
  const allowedForCriticalSlot = ["exact", "regional"].includes(editorialFit);

  return {
    editorial_fit: editorialFit,
    fit_rank: FIT_PRIORITY[editorialFit] ?? 0,
    approved_for_timeline: approvedForTimeline,
    allowed_for_critical_slot: criticalScene ? allowedForCriticalSlot : approvedForTimeline,
    specific_scene: specificScene,
    critical_scene: criticalScene,
    evidence_source: evidenceSource,
    weak_evidence_source: weakEvidenceSource,
    expected_location: expectedLocation,
    detected_location: detectedLocation,
    same_location: sameLocation,
    wrong_location: wrongLocation,
    same_country: sameCountry,
    required_evidence_score: Number(evidence.required_evidence_score || 0),
    visual_intent_match: Boolean(evidence.visual_intent_match),
    generic_visual: Boolean(evidence.generic_visual),
    detected_visual_categories: evidence.detected_visual_categories || [],
    missing_required_visual_evidence: evidence.missing_required_visual_evidence || [],
    required_evidence_found: evidence.required_evidence_found || [],
    reasons: unique(reasons),
  };
};

const getAssetWindows = (asset = {}) => {
  if (Array.isArray(asset.analysis_windows) && asset.analysis_windows.length) {
    return asset.analysis_windows;
  }

  return [{
    summary: asset.analysis_summary || asset.semantic_text || asset.query || "",
    description: asset.analysis_summary || asset.semantic_text || asset.query || "",
    tags: unique([...(asset.analysis_tags || []), ...(asset.provider_tags || [])]),
    location: { city: "", country: "", confidence: 0 },
    detected_visual_categories: [],
    visual_evidence_source: asset.analysis_provider || "metadata_fallback",
  }];
};

const pickBestAssessment = (assessments = []) =>
  [...assessments].sort((left, right) =>
    Number(right.fit_rank || 0) - Number(left.fit_rank || 0) ||
    Number(right.required_evidence_score || 0) - Number(left.required_evidence_score || 0)
  )[0] || null;

const summarizeAssetForScene = ({ scene = {}, asset = {} } = {}) => {
  const assessments = getAssetWindows(asset).map((window, index) => ({
    window_index: Number(window.window_index || index + 1),
    ...buildWindowEditorialAssessment({ scene, asset, window }),
  }));
  const bestAssessment = pickBestAssessment(assessments);
  const editorialBins = assessments.reduce((accumulator, assessment) => {
    accumulator[assessment.editorial_fit] = (accumulator[assessment.editorial_fit] || 0) + 1;
    return accumulator;
  }, { exact: 0, regional: 0, generic: 0, uncertain: 0, wrong: 0 });

  return {
    asset,
    best_fit: bestAssessment?.editorial_fit || "uncertain",
    best_fit_rank: bestAssessment?.fit_rank || 0,
    approved_for_timeline: Boolean(bestAssessment?.approved_for_timeline),
    allowed_for_critical_slot: Boolean(bestAssessment?.allowed_for_critical_slot),
    critical_scene: Boolean(bestAssessment?.critical_scene),
    specific_scene: Boolean(bestAssessment?.specific_scene),
    exact_windows: editorialBins.exact || 0,
    regional_windows: editorialBins.regional || 0,
    generic_windows: editorialBins.generic || 0,
    uncertain_windows: editorialBins.uncertain || 0,
    wrong_windows: editorialBins.wrong || 0,
    best_assessment: bestAssessment,
    window_assessments: assessments,
  };
};

const summarizeSceneApproval = ({ scene = {}, assets = [] } = {}) => {
  const assetSummaries = assets.map((asset) => summarizeAssetForScene({ scene, asset }));
  const counts = assetSummaries.reduce((accumulator, summary) => {
    accumulator[summary.best_fit] = (accumulator[summary.best_fit] || 0) + 1;
    return accumulator;
  }, { exact: 0, regional: 0, generic: 0, uncertain: 0, wrong: 0 });
  const approvedAssets = assetSummaries.filter((summary) => summary.approved_for_timeline).length;
  const strongAssets = (counts.exact || 0) + (counts.regional || 0);
  const criticalScene = isCriticalScene(scene);
  const specificScene = isSpecificScene(scene);
  const criticalReady = !criticalScene || assetSummaries.some((summary) => summary.allowed_for_critical_slot);
  const ready = assets.length > 0 && (specificScene ? strongAssets > 0 : approvedAssets > 0) && criticalReady;
  const bestFit = pickBestAssessment(assetSummaries.map((summary) => ({ editorial_fit: summary.best_fit, fit_rank: summary.best_fit_rank })))?.editorial_fit || "uncertain";

  return {
    ready,
    critical_ready: criticalReady,
    critical_scene: criticalScene,
    specific_scene: specificScene,
    approved_assets: approvedAssets,
    strong_assets: strongAssets,
    exact_assets: counts.exact || 0,
    regional_assets: counts.regional || 0,
    generic_assets: counts.generic || 0,
    uncertain_assets: counts.uncertain || 0,
    wrong_assets: counts.wrong || 0,
    best_fit: bestFit,
    editorial_bins: counts,
    asset_summaries: assetSummaries,
  };
};

module.exports = {
  CRITICAL_ROLES,
  FIT_PRIORITY,
  SPECIFIC_INTENTS,
  buildWindowEditorialAssessment,
  summarizeAssetForScene,
  summarizeSceneApproval,
  isCriticalScene,
  isSpecificScene,
};