const { detectLocation, isSameLocation, normalizeLabel } = require("./narrativeBlockPlanner");
const { evaluateVisualEvidence } = require("./visualIntentService");

const unique = (values = []) => [...new Set(values.filter(Boolean))];
const round3 = (value) => Number(Number(value || 0).toFixed(3));
const FOOD_INTENTS = new Set(["gastronomy", "market", "wine", "pastry", "restaurant", "cafe", "street_food"]);
const CRITICAL_ROLES = new Set(["hook", "intro", "bridge", "midpoint", "closing", "outro"]);
const GENERIC_CATEGORIES = new Set(["aerial_city", "bridge", "river", "coast", "generic_street", "clouds", "landscape", "city_landmark", "historic_street"]);
const FOOD_CATEGORIES = new Set(["food", "local_food", "market", "wine", "pastry", "restaurant", "cafe", "street_food", "people_eating"]);

const buildTextCorpus = ({ scene = {}, block = {}, candidate = {} } = {}) =>
  [
    scene.title,
    scene.narration_excerpt,
    ...(scene.keywords || []),
    block.topic,
    block.label,
    candidate.description,
    candidate.summary,
    candidate.semantic_text,
    candidate.asset?.semantic_text,
    candidate.asset?.query,
    candidate.query_used,
    ...(candidate.tags || []),
    ...(candidate.detected_objects || []),
  ].filter(Boolean).join(" ");

const getNarrativeRole = ({ sceneRole = "body", sceneOrder = 1, totalScenes = 0, hardBoundary = false } = {}) => {
  const normalizedRole = String(sceneRole || "body").toLowerCase();
  const safeOrder = Number(sceneOrder || 1);
  const safeTotalScenes = Number(totalScenes || 0);
  if (safeOrder <= 1) return normalizedRole === "intro" ? "hook" : "hook";
  if (safeTotalScenes > 1 && safeOrder >= safeTotalScenes) return normalizedRole === "outro" ? "closing" : "closing";
  if (normalizedRole === "intro") return "intro";
  if (normalizedRole === "outro") return "outro";
  if (hardBoundary) return "bridge";
  if (safeTotalScenes >= 5 && safeOrder === Math.ceil(safeTotalScenes / 2)) return "midpoint";
  return "body";
};

const isCriticalNarrativeRole = (role = "") => CRITICAL_ROLES.has(String(role || "").toLowerCase());

const resolveExpectedLocation = ({ scene = {}, block = {} } = {}) =>
  scene.expected_location || scene.location?.city || block.expected_location || block.location?.city || (block.topic_type === "city" ? block.macro_topic || block.topic : "") || "";

const resolveCandidateLocation = ({ candidate = {}, corpus = "" } = {}) => {
  if (candidate.location?.city) return candidate.location;
  if (candidate.detected_location?.city) return candidate.detected_location;
  return detectLocation(corpus);
};

const buildEditorialFamilyKey = ({ scene = {}, block = {}, candidate = {}, evidence = null } = {}) => {
  const corpus = buildTextCorpus({ scene, block, candidate });
  const location = resolveCandidateLocation({ candidate, corpus }).city || resolveExpectedLocation({ scene, block }) || "neutral";
  const categories = unique([
    ...((evidence && evidence.detected_visual_categories) || []),
    ...(candidate.detected_visual_categories || []),
  ]);
  const familyCategories = categories.filter((category) => !GENERIC_CATEGORIES.has(category)).slice(0, 2);
  const family = familyCategories.length ? familyCategories.join("+") : categories.slice(0, 2).join("+") || "unknown";
  const provider = candidate.asset?.provider || candidate.source || candidate.provider || "unknown";
  return [normalizeLabel(location) || "neutral", normalizeLabel(family) || "unknown", normalizeLabel(provider) || "unknown"].join("|");
};

const classifyEditorialCandidate = ({ scene = {}, block = {}, candidate = {}, evidence = null } = {}) => {
  const resolvedEvidence = evidence || evaluateVisualEvidence({
    scene,
    window: {
      summary: candidate.description || candidate.summary || candidate.semantic_text || "",
      description: candidate.description || candidate.summary || candidate.semantic_text || "",
      tags: candidate.tags || [],
      detected_visual_categories: candidate.detected_visual_categories || [],
      detected_objects: candidate.detected_objects || [],
      location: candidate.location,
    },
    asset: candidate.asset || candidate,
  });
  const corpus = buildTextCorpus({ scene, block, candidate });
  const expectedLocation = resolveExpectedLocation({ scene, block });
  const candidateLocation = resolveCandidateLocation({ candidate, corpus }).city || "";
  const narrativeRole = getNarrativeRole({
    sceneRole: scene.role || block.role,
    sceneOrder: Number(scene.scene_order || block.scene_order || 1),
    totalScenes: Number(scene.total_scenes || block.total_scenes || 0),
    hardBoundary: Boolean(scene.hard_boundary || block.hard_boundary),
  });
  const criticalRole = isCriticalNarrativeRole(narrativeRole) || Boolean(scene.hard_boundary || block.hard_boundary || scene.is_boundary_first_slot || block.is_boundary_first_slot);
  const weakEvidence = ["metadata_fallback", "local_video_understanding_fallback"].includes(candidate.visual_evidence_source || candidate.analysis_provider || candidate.asset_analysis_provider || "metadata_fallback");
  const wrongLocation = Boolean(expectedLocation && candidateLocation && !isSameLocation(candidateLocation, expectedLocation));
  const genericVisual = Boolean(resolvedEvidence.generic_visual);
  const forbiddenHit = Number(resolvedEvidence.forbidden_category_penalty || 0) > 0;
  const confidence = Number(candidate.confidence || candidate.visual_confidence || candidate.location?.confidence || 0);
  const requiredEvidenceScore = Number(resolvedEvidence.required_evidence_score || 0);
  const allowedCategoryScore = Number(resolvedEvidence.allowed_category_score || 0);
  const hasFoodEvidence = (resolvedEvidence.detected_visual_categories || []).some((category) => FOOD_CATEGORIES.has(category));
  const foodIntent = FOOD_INTENTS.has(scene.visual_intent || block.visual_intent);
  let status = "uncertain";
  let reason = "insufficient_editorial_evidence";

  if (wrongLocation || forbiddenHit) {
    status = "wrong";
    reason = wrongLocation ? "wrong_location" : "forbidden_category";
  } else if (criticalRole && weakEvidence && requiredEvidenceScore < 0.9) {
    status = "uncertain";
    reason = "weak_evidence_in_critical_slot";
  } else if (foodIntent && !hasFoodEvidence && !scene.generic_asset_allowed) {
    status = genericVisual ? "generic" : "uncertain";
    reason = genericVisual ? "generic_food_intent" : "missing_food_proof";
  } else if (genericVisual) {
    status = "generic";
    reason = "generic_visual";
  } else if (requiredEvidenceScore >= 0.85 && (!expectedLocation || !candidateLocation || isSameLocation(candidateLocation, expectedLocation)) && !weakEvidence) {
    status = "exact";
    reason = "strong_required_evidence";
  } else if (requiredEvidenceScore >= 0.5 || allowedCategoryScore >= 0.45) {
    status = weakEvidence && criticalRole ? "uncertain" : "regional";
    reason = weakEvidence ? "partial_metadata_evidence" : "partial_required_evidence";
  } else if (confidence < 0.45 || weakEvidence) {
    status = "uncertain";
    reason = confidence < 0.45 ? "low_confidence" : "metadata_only";
  }

  return {
    status,
    reason,
    narrative_role: narrativeRole,
    critical_role: criticalRole,
    expected_location: expectedLocation,
    candidate_location: candidateLocation,
    required_evidence_score: round3(requiredEvidenceScore),
    allowed_category_score: round3(allowedCategoryScore),
    has_food_evidence: hasFoodEvidence,
    weak_evidence: weakEvidence,
    editorial_family_key: buildEditorialFamilyKey({ scene, block, candidate, evidence: resolvedEvidence }),
  };
};

const buildCoverageRequirements = ({ visualPlan = [], topic = "" } = {}) => {
  const gastronomySceneCount = visualPlan.filter((scene) => FOOD_INTENTS.has(scene.visual_intent)).length;
  const gastronomyTheme = gastronomySceneCount > 0 || /(food|gastronom|restaurant|restaurante|mercado|market|vinho|wine|pastry|pastel|cafe|coffee)/i.test(topic || "");
  if (!gastronomyTheme) {
    return {
      applicable: false,
      required_categories: {},
      max_uncertain_critical_slots: 0,
      max_generic_critical_slots: 0,
      max_adjacent_family_reuse: 1,
    };
  }

  const requestedIntents = new Set(visualPlan.map((scene) => scene.visual_intent).filter(Boolean));
  const requiredCategories = {
    food: Math.max(2, Math.ceil(visualPlan.length * 0.18)),
    people_eating: 1,
  };
  if (requestedIntents.has("market") || /market|mercado/i.test(topic || "")) requiredCategories.market = 1;
  if (requestedIntents.has("wine") || /wine|vinho/i.test(topic || "")) requiredCategories.wine = 1;
  if (requestedIntents.has("pastry") || /pastel|pastry|dessert|docaria|confeitaria/i.test(topic || "")) requiredCategories.pastry = 1;
  if (requestedIntents.has("restaurant") || requestedIntents.has("cafe")) requiredCategories.restaurant_or_cafe = 1;

  return {
    applicable: true,
    required_categories: requiredCategories,
    max_uncertain_critical_slots: 0,
    max_generic_critical_slots: 0,
    max_adjacent_family_reuse: 0,
  };
};

const countCoverageHits = ({ clips = [] }) => {
  const counters = {
    food: 0,
    people_eating: 0,
    market: 0,
    wine: 0,
    pastry: 0,
    restaurant_or_cafe: 0,
  };

  clips.forEach((clip) => {
    const categories = unique([
      ...(clip.detected_visual_categories || []),
      ...((clip.score_features && clip.score_features.detectedVisualCategories) || []),
    ]);
    if (categories.includes("food") || categories.includes("local_food")) counters.food += 1;
    if (categories.includes("people_eating")) counters.people_eating += 1;
    if (categories.includes("market") || categories.includes("street_food")) counters.market += 1;
    if (categories.includes("wine")) counters.wine += 1;
    if (categories.includes("pastry")) counters.pastry += 1;
    if (categories.includes("restaurant") || categories.includes("cafe")) counters.restaurant_or_cafe += 1;
  });

  return counters;
};

const evaluateTimelineEditorialCoverage = ({ state = {}, timeline = {} } = {}) => {
  const clips = Array.isArray(timeline.clips) ? timeline.clips : [];
  const coverage = buildCoverageRequirements({ visualPlan: state.visual_plan || [], topic: state.topic || "" });
  const issues = [];
  const sceneIndexes = new Set();
  const clipIndexes = new Set();
  const classificationRows = clips.map((clip) => {
    const scene = {
      role: clip.scene_role,
      scene_order: clip.scene_order,
      total_scenes: (state.visual_plan || []).length,
      hard_boundary: clip.hard_boundary,
      visual_intent: clip.visual_intent,
      expected_location: clip.expected_location,
      generic_asset_allowed: false,
      required_visual_evidence: clip.required_visual_evidence,
      allowed_visual_categories: clip.allowed_visual_categories,
      forbidden_visual_categories: clip.forbidden_visual_categories,
    };
    const candidate = {
      description: clip.asset_window_summary || clip.asset_semantic_text || "",
      summary: clip.asset_window_summary || clip.asset_semantic_text || "",
      semantic_text: clip.asset_semantic_text || "",
      query_used: clip.query_used || "",
      tags: clip.semantic_match_terms || [],
      detected_visual_categories: clip.detected_visual_categories || [],
      detected_objects: clip.detected_objects || [],
      location: clip.detected_location || {},
      confidence: Number(clip.semantic_match_score || clip.timeline_score || 0),
      visual_evidence_source: clip.asset_analysis_provider || "metadata_fallback",
      analysis_provider: clip.asset_analysis_provider || "metadata_fallback",
      asset: { provider: clip.provider || "unknown" },
    };
    const classification = classifyEditorialCandidate({ scene, block: scene, candidate });
    return { clip, classification };
  });

  const criticalRows = classificationRows.filter((row) => row.classification.critical_role);
  criticalRows.forEach(({ clip, classification }) => {
    if (["generic", "uncertain", "wrong"].includes(classification.status)) {
      issues.push({
        type: "critical_slot_editorial_failure",
        severity: "critical",
        clip_index: Number(clip.clip_index || 0),
        scene_index: Number(clip.scene_index || 0),
        narrative_role: classification.narrative_role,
        editorial_status: classification.status,
      });
      sceneIndexes.add(Number(clip.scene_index || 0));
      clipIndexes.add(Number(clip.clip_index || 0));
    }
  });

  const counts = countCoverageHits({ clips });
  if (coverage.applicable) {
    Object.entries(coverage.required_categories).forEach(([category, minCount]) => {
      if (Number(counts[category] || 0) >= Number(minCount || 0)) return;
      issues.push({
        type: "coverage_gap",
        severity: "high",
        category,
        expected_min: Number(minCount || 0),
        actual: Number(counts[category] || 0),
      });
      clips.forEach((clip) => {
        if (FOOD_INTENTS.has(clip.visual_intent)) sceneIndexes.add(Number(clip.scene_index || 0));
      });
    });
  }

  const adjacentRepeats = [];
  for (let index = 1; index < classificationRows.length; index += 1) {
    const previous = classificationRows[index - 1];
    const current = classificationRows[index];
    if (previous.classification.editorial_family_key && previous.classification.editorial_family_key === current.classification.editorial_family_key) {
      adjacentRepeats.push({
        clip_index: Number(current.clip.clip_index || 0),
        scene_index: Number(current.clip.scene_index || 0),
        family_key: current.classification.editorial_family_key,
      });
      sceneIndexes.add(Number(current.clip.scene_index || 0));
      clipIndexes.add(Number(current.clip.clip_index || 0));
    }
  }
  if (adjacentRepeats.length > Number(coverage.max_adjacent_family_reuse || 0)) {
    issues.push({
      type: "editorial_family_repetition",
      severity: "high",
      count: adjacentRepeats.length,
      examples: adjacentRepeats.slice(0, 4),
    });
  }

  return {
    coverage,
    counts,
    issues,
    classifications: classificationRows.map(({ clip, classification }) => ({
      clip_index: Number(clip.clip_index || 0),
      scene_index: Number(clip.scene_index || 0),
      narrative_role: classification.narrative_role,
      editorial_status: classification.status,
      editorial_reason: classification.reason,
      editorial_family_key: classification.editorial_family_key,
    })),
    scene_indexes_to_refresh: unique(Array.from(sceneIndexes).filter((value) => value > 0)),
    clip_indexes_to_replace: unique(Array.from(clipIndexes).filter((value) => value > 0)),
  };
};

module.exports = {
  FOOD_INTENTS,
  CRITICAL_ROLES,
  buildCoverageRequirements,
  buildEditorialFamilyKey,
  classifyEditorialCandidate,
  evaluateTimelineEditorialCoverage,
  getNarrativeRole,
  isCriticalNarrativeRole,
  __test__: {
    buildCoverageRequirements,
    buildEditorialFamilyKey,
    classifyEditorialCandidate,
    evaluateTimelineEditorialCoverage,
    getNarrativeRole,
    isCriticalNarrativeRole,
  },
};