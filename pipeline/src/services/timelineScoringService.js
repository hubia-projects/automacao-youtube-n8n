const { config } = require("../config/env");
const { matchNarrationToAssetWindows, keywordOverlapScore } = require("./semanticMatcher");
const { shouldRejectAssetForScene } = require("./assetRejectionService");
const {
  buildSemanticTerms,
  detectLandmarks,
  isSameLocation,
  belongsToTopic,
  normalizeLabel,
} = require("./narrativeBlockPlanner");
const { evaluateVisualEvidence } = require("./visualIntentService");
const {
  FIT_PRIORITY,
  buildWindowEditorialAssessment,
  isCriticalScene,
  isSpecificScene,
} = require("./editorialAssetService");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round3 = (value) => Number(Number(value || 0).toFixed(3));

// Pesos rebalanceados para priorizar sincronia narração↔visual.
// semanticScore (8.0) é o fator dominante — o que o áudio diz deve
// corresponder ao que o vídeo mostra. visualIntentMatch (3.0) e
// editorialFit (3.0) são secundários para evitar que um asset com
// fit editorial "exact" mas sem relação com a narração vença um
// asset com match semântico forte.
const SCORE_WEIGHTS = {
  semanticScore: 8.0,
  visualIntentMatchScore: 3.0,
  requiredEvidenceScore: 5.0,
  blockMatchScore: 3.0,
  entityMatchScore: 3.5,
  visualSpecificityScore: 3.0,
  gastronomySpecificityScore: 3.0,
  evidenceSourceScore: 2.5,
  editorialFitScore: 3.0,
  sceneBindingScore: 3.5,
  resolutionScore: 1.0,
  motionScore: 1.0,
  confidenceScore: 1.0,
  forbiddenCategoryPenalty: 10.0,
  sourceReusePenalty: 4.0,
  assetReusePenalty: 4.0,
  windowReusePenalty: 5.0,
  signatureReusePenalty: 3.5,
  blockMismatchPenalty: 8.0,
  sceneBindingPenalty: 8.5,
  genericAssetPenalty: 7.0,
  uncertainAssetPenalty: 5.0,
  metadataFallbackPenalty: 4.5,
  darkFramePenalty: 4.0,
  // Penalidade de mismatch temático: narração fala de comida,
  // asset mostra paisagem → penalidade severa para forçar coerência.
  thematicMismatchPenalty: 15.0,
};

const EDITORIAL_FIT_SCORES = {
  exact: 1,
  regional: 0.72,
  generic: 0.28,
  uncertain: 0.08,
  wrong: 0,
};

const buildVisualSignature = (candidate = {}) => [
  normalizeLabel(candidate.location_type || "unknown"),
  normalizeLabel(candidate.visual_features?.shot_type || "unknown"),
  normalizeLabel(candidate.visual_features?.camera_motion || "unknown"),
  normalizeLabel(candidate.location?.city || "neutral"),
  normalizeLabel((candidate.tags || []).slice(0, 3).join(" ")),
].join("|");

const computeSemanticScores = async ({ narrationText, candidates, videoId }) => {
  try {
    const results = await matchNarrationToAssetWindows({
      narrationText,
      assetWindows: candidates.map((candidate) => ({
        summary: candidate.description || candidate.summary || candidate.semantic_text || "",
        tags: candidate.tags || [],
      })),
      videoId,
    });

    return candidates.map((candidate, index) => {
      const result = results[index];
      return {
        score: clamp(Number(result?.similarity_score || 0), 0, 1),
        method: result?.method || "embedding_cosine",
      };
    });
  } catch {
    return candidates.map((candidate) => ({
      score: clamp(keywordOverlapScore(narrationText, candidate.semantic_text || candidate.description || ""), 0, 1),
      method: "keyword_fallback",
    }));
  }
};

const computeBlockMatchScore = ({ block, candidate, previousMacroTopic }) => {
  const expectedCity = block.location?.city || (block.topic_type === "city" ? block.macro_topic : "");
  const candidateCity = candidate.location?.city || "";

  if (!expectedCity) {
    if (candidate.neutral) return 0.85;
    if (!candidateCity) return 0.65;
    return 0.45;
  }

  if (candidateCity && isSameLocation(candidateCity, expectedCity)) return 1;
  if (!candidateCity && candidate.neutral) return 0.45;
  if (previousMacroTopic && belongsToTopic(candidateCity, previousMacroTopic)) return 0;
  return 0;
};

const computeEntityMatchScore = ({ block, candidate }) => {
  const expectedLandmarks = block.landmarks || [];
  const candidateLandmarks = candidate.landmarks || [];
  const blockTerms = buildSemanticTerms([
    block.topic,
    block.narration_excerpt,
    ...(block.keywords || []),
  ]);
  const candidateTerms = buildSemanticTerms([
    candidate.description,
    candidate.semantic_text,
    ...(candidate.tags || []),
    ...candidateLandmarks.map((item) => item.name),
  ]);

  let score = 0;
  if ((block.location?.city || block.macro_topic) && isSameLocation(candidate.location?.city || "", block.location?.city || block.macro_topic)) {
    score += 0.55;
  }

  if (expectedLandmarks.length && candidateLandmarks.length) {
    const exactMatches = expectedLandmarks.filter((landmark) =>
      candidateLandmarks.some((item) => normalizeLabel(item.name) === normalizeLabel(landmark.name))
    ).length;
    if (exactMatches) {
      score += 0.45;
    } else if (expectedLandmarks.some((landmark) => candidateLandmarks.some((item) => item.city && landmark.city && isSameLocation(item.city, landmark.city)))) {
      score += 0.25;
    }
  }

  const overlap = blockTerms.filter((term) => candidateTerms.includes(term)).length;
  if (overlap) score += Math.min(0.25, overlap * 0.05);
  return clamp(score, 0, 1);
};

const computeVisualSpecificityScore = ({ block, candidate }) => {
  const text = `${candidate.description || ""} ${(candidate.tags || []).join(" ")} ${candidate.location_type || ""}`;
  let score = 0.25;
  if (candidate.location?.city) score += 0.25;
  if ((candidate.landmarks || []).length) score += 0.2;
  if (candidate.location_type && candidate.location_type !== "general") score += 0.15;
  if ((candidate.tags || []).length >= 4) score += 0.1;
  if ((block.subtheme === "food" || block.subtheme === "market" || block.subtheme === "wine_pastry") && /food|market|wine|pastry|cafe|restaurant|street/i.test(text)) {
    score += 0.15;
  }
  return clamp(score, 0, 1);
};

const computeResolutionScore = (candidate = {}) => clamp(Number(candidate.quality?.resolution_score || 0.5), 0, 1);

const computeMotionScore = (candidate = {}) => {
  if (!candidate.asset || candidate.asset.asset_type !== "video") return 0.55;
  const motion = normalizeLabel(candidate.visual_features?.camera_motion || "unknown");
  if (["pan", "tilt", "tracking", "drone"].includes(motion)) return 0.9;
  if (motion === "static") return 0.55;
  return 0.7;
};

const computeConfidenceScore = (candidate = {}) => clamp(Number(candidate.confidence || 0), 0, 1);

const isWeakMetadataEvidence = (candidate = {}) =>
  (candidate.visual_evidence_source || candidate.analysis_provider || "") === "metadata_fallback";

const computeEvidenceSourceScore = (candidate = {}) => {
  const source = candidate.visual_evidence_source || candidate.analysis_provider || "metadata_fallback";
  if (source === "metadata_fallback") return 0.15;
  if (source === "local_video_understanding_fallback") return 0.45;
  if (source === "local_video_understanding") return 0.75;
  return 1;
};

const computeDarkFramePenalty = (candidate = {}) => {
  const brightness = Number(candidate.quality?.brightness || 0.7);
  return brightness < 0.28 ? clamp((0.28 - brightness) / 0.28, 0, 1) : 0;
};

const computeGenericAssetPenalty = ({ block, candidate, editorialAssessment }) => {
  if (editorialAssessment?.editorial_fit === "generic") return 1;

  const text = normalizeLabel(`${candidate.description || ""} ${candidate.semantic_text || ""} ${(candidate.tags || []).join(" ")}`);
  if (candidate.neutral) return 0.5;
  if (/generic|travel footage|travel video|city skyline|coastline|lifestyle/.test(text) && block.topic_type === "city") return 0.75;
  if ((block.subtheme === "food" || block.subtheme === "market" || block.subtheme === "wine_pastry") && !/food|market|wine|pastry|dessert|bakery|cafe|restaurant|dish/.test(text)) {
    return 0.85;
  }
  return 0;
};

const computeGastronomySpecificityScore = ({ block, evidence }) => {
  if (!["gastronomy", "market", "wine", "pastry", "restaurant", "cafe", "street_food"].includes(block.visual_intent)) {
    return 0.45;
  }

  const categories = evidence.detected_visual_categories || [];
  const specificHits = categories.filter((category) => ["food", "local_food", "market", "wine", "pastry", "restaurant", "cafe", "street_food", "people_eating"].includes(category)).length;
  return clamp(specificHits / 3, 0, 1);
};

const buildReuseSnapshot = ({ usage, candidate }) => {
  const sourceUrl = candidate.asset?.source_url || "";
  const localPath = candidate.asset?.local_path || "";
  const signature = buildVisualSignature(candidate);

  return {
    sourceUrlCount: usage.usedSourceUrls?.get(sourceUrl) || 0,
    assetCount: usage.usedAssetIds?.get(candidate.asset_id) || 0,
    localPathCount: usage.usedLocalPaths?.get(localPath) || 0,
    windowCount: usage.usedWindowIds?.get(candidate.id) || 0,
    providerCount: usage.usedProviders?.get(candidate.source || candidate.asset?.provider || "unknown") || 0,
    signatureCount: usage.usedVisualSignatures?.get(signature) || 0,
    signature,
  };
};

const computeReusePenalties = ({ block, candidate, usage, clipIndex }) => {
  const snapshot = buildReuseSnapshot({ usage, candidate });
  const sameAssetLastGap = usage.lastClipByAssetId?.get(candidate.asset_id);

  const sourceReusePenalty = clamp(snapshot.sourceUrlCount > 0 ? snapshot.sourceUrlCount / 2 : 0, 0, 1);
  const assetReusePenalty = clamp(snapshot.assetCount > 0 ? snapshot.assetCount / 2 : 0, 0, 1);
  const windowReusePenalty = clamp(snapshot.windowCount > 0 ? 1 : 0, 0, 1);
  const signatureReusePenalty = clamp(snapshot.signatureCount > 0 ? Math.min(1, snapshot.signatureCount / 2) : 0, 0, 1);
  const minGapPenalty = sameAssetLastGap && clipIndex - sameAssetLastGap < 2 ? 1 : 0;
  const blockOverusePenalty = block.block_id && (usage.usedBlockAssetIds?.get(`${block.block_id}:${candidate.asset_id}`) || 0) > 0.5 ? 0.5 : 0;

  return {
    sourceReusePenalty,
    assetReusePenalty: clamp(assetReusePenalty + blockOverusePenalty + minGapPenalty, 0, 1),
    windowReusePenalty,
    signatureReusePenalty,
    total: clamp((sourceReusePenalty + assetReusePenalty + windowReusePenalty + signatureReusePenalty) / 4, 0, 1),
    signature: snapshot.signature,
  };
};

// ===== Penalidade de mismatch temático =====
// Quando a narração menciona termos de gastronomia/comida mas o
// asset não mostra nenhuma categoria visual de comida, aplica-se
// uma penalidade severa. Isto evita que um vídeo de bacalhau mostre
// um ponto turístico de Lisboa.

const FOOD_NARRATION_TERMS = new Set([
  "comida", "comidas", "prato", "pratos", "bacalhau", "sardinha",
  "sardinhas", "marisco", "mariscos", "polvo", "lula", "lulas",
  "camarao", "camaroes", "carne", "porco", "frango", "arroz",
  "marisco", "peixe", "peixes", "atum", "salmao", "dourada",
  "robalo", "cataplana", "acorda", "caldeirada", "cozido",
  "grelhado", "grelhados", "assado", "assados", "frito", "fritos",
  "cozinha", "culinaria", "gastronomia", "gastronomico",
  "gastronomica", "restaurante", "restaurantes", "tasca", "tascas",
  "taberna", "tabernas", "mercado", "mercados", "feira", "feiras",
  "pastel", "pasteis", "nata", "docaria", "doce", "doces",
  "sobremesa", "sobremesas", "queijo", "queijos", "vinho", "vinhos",
  "azeite", "pão", "pao", "broa", "alheira", "francesinha",
  "francesinhas", "bifana", "bifanas", "prego", "pregos",
  "degustacao", "degustar", "provar", "saborear", "paladar",
  "ingrediente", "ingredientes", "tempero", "temperos", "receita",
  "receitas", "chef", "cozinheiro", "cozinheira",
]);

const FOOD_VISUAL_CATEGORIES = new Set([
  "food", "local_food", "market", "wine", "pastry", "restaurant",
  "cafe", "street_food", "people_eating", "dish", "meal", "cooking",
  "kitchen", "seafood", "fish", "meat", "dessert", "bakery",
  "fruit", "vegetable", "fresh_produce", "gastronomy",
]);

const computeThematicMismatchPenalty = ({ narrationText = "", candidate = {} }) => {
  const narrationWords = normalizeLabel(narrationText).split(/\s+/).filter(Boolean);
  const hasFoodNarration = narrationWords.some((word) => FOOD_NARRATION_TERMS.has(word));
  if (!hasFoodNarration) return 0;

  const candidateCategories = [
    ...(candidate.detected_visual_categories || []),
    ...(candidate.tags || []),
  ].map((c) => normalizeLabel(String(c || "")));

  const hasFoodVisual = candidateCategories.some((category) =>
    FOOD_VISUAL_CATEGORIES.has(category)
  );

  // Narração fala de comida mas asset não mostra comida → penalidade máxima
  if (!hasFoodVisual) return 1;
  return 0;
};

const computeBlockMismatchPenalty = ({ block, candidate, previousMacroTopic }) => {
  const candidateCity = candidate.location?.city || "";
  if (!candidateCity) return 0;
  if (block.location?.city && !isSameLocation(candidateCity, block.location.city)) return 1;
  if (previousMacroTopic && block.hard_boundary && belongsToTopic(candidateCity, previousMacroTopic)) return 1;
  if ((block.forbidden_locations || []).some((topic) => belongsToTopic(candidateCity, topic))) return 1;
  return 0;
};

const computeSceneBinding = ({ block, candidate }) => {
  const blockSceneIndex = Number(block.scene_index || 0);
  const candidateSceneIndex = Number(candidate.scene_index || candidate.asset?.scene_index || 0);
  const sameScene = blockSceneIndex > 0 && candidateSceneIndex > 0 && blockSceneIndex === candidateSceneIndex;
  const specificScene = isSpecificScene(block);
  const criticalScene = isCriticalScene(block);

  if (sameScene) {
    return {
      sameScene: true,
      score: 1,
      penalty: 0,
      hardBlocked: false,
      reason: "scene_bound",
    };
  }

  if (specificScene || criticalScene) {
    return {
      sameScene: false,
      score: 0,
      penalty: 1,
      hardBlocked: true,
      reason: "cross_scene_candidate_for_specific_slot",
    };
  }

  return {
    sameScene: false,
    score: 0.15,
    penalty: 0.45,
    hardBlocked: false,
    reason: "cross_scene_candidate_soft_penalty",
  };
};

// ===== Dedup hard: asset/source/landmark usados não voltam (FASE 4) =====

const computeHardReuseBlockReason = ({ candidate, usage }) => {
  const maxUses = Math.max(1, Number(config.MAX_ASSET_USES_PER_VIDEO || 1));
  const assetUseCount = usage.usedAssetIds?.get(candidate.asset_id) || 0;
  if (assetUseCount >= maxUses) return "asset_reuse_blocked";

  const sourceUrl = candidate.asset?.source_url || "";
  if (sourceUrl && (usage.usedSourceUrls?.get(sourceUrl) || 0) >= maxUses) return "source_url_reuse_blocked";

  const localPath = candidate.asset?.local_path || "";
  if (localPath && (usage.usedLocalPaths?.get(localPath) || 0) >= maxUses) return "local_path_reuse_blocked";

  // Mesmo landmark nomeado (ex: Mosteiro dos Jerónimos) não repete em outro
  // clip, mesmo vindo de assets/janelas diferentes.
  const candidateLandmarks = (candidate.landmarks || []).map((item) => normalizeLabel(item.name)).filter(Boolean);
  if (candidateLandmarks.length && usage.usedLandmarks) {
    const reusedLandmark = candidateLandmarks.find((name) => (usage.usedLandmarks.get(name) || 0) >= maxUses);
    if (reusedLandmark) return "landmark_reuse_blocked";
  }

  return "";
};

// ===== Constraint de entidade nomeada (FASE 7) =====
// Quando a narração do slot cita um landmark específico ("Rio Douro"),
// candidatos genéricos são bloqueados NAQUELE slot: ou o candidato
// evidencia a entidade, ou não entra.

const computeNamedEntityBlockReason = ({ narrationText, candidate, entityMatchScore }) => {
  const narrationLandmarks = detectLandmarks(narrationText || "");
  if (!narrationLandmarks.length) return "";

  const candidateLandmarkNames = (candidate.landmarks || []).map((item) => normalizeLabel(item.name)).filter(Boolean);
  const candidateText = normalizeLabel(`${candidate.description || ""} ${candidate.semantic_text || ""} ${(candidate.tags || []).join(" ")}`);

  const candidateHasEntity = narrationLandmarks.some((landmark) => {
    const name = normalizeLabel(landmark.name);
    return candidateLandmarkNames.includes(name) || candidateText.includes(name);
  });

  if (candidateHasEntity) return "";

  const candidateCity = candidate.location?.city || "";
  const candidateCityMatchesEntity = narrationLandmarks.some(
    (landmark) => landmark.city && candidateCity && isSameLocation(candidateCity, landmark.city)
  );

  // Cidade certa + score razoável: aceitar como regional match
  if (candidateCityMatchesEntity && entityMatchScore > 0.2) return "";

  return "named_entity_in_narration_not_in_candidate";
};

const computeHardBoundaryBlockReason = ({
  block,
  candidate,
  previousMacroTopic,
  hardBoundaryPolicy = {},
  isBoundaryFirstSlot = false,
}) => {
  if (!block.hard_boundary || !isBoundaryFirstSlot) return "";

  const expectedLocation = block.expected_location || block.location?.city || (block.topic_type === "city" ? block.macro_topic : "");
  const candidateCity = candidate.location?.city || "";

  if (hardBoundaryPolicy.forbid_neutral_first_clip && candidate.neutral) {
    return "neutral_first_clip_forbidden";
  }

  if (hardBoundaryPolicy.require_location_on_hard_boundary && expectedLocation && !candidateCity) {
    return "missing_location_on_first_clip";
  }

  if (expectedLocation && candidateCity && !isSameLocation(candidateCity, expectedLocation)) {
    return "wrong_boundary_city";
  }

  if (previousMacroTopic && candidateCity && belongsToTopic(candidateCity, previousMacroTopic)) {
    return "belongs_to_previous_topic";
  }

  return "";
};

const computeHardBoundaryIntroBonus = ({ block, candidate, isBoundaryFirstSlot = false }) => {
  if (!block.hard_boundary || !isBoundaryFirstSlot) return 0;
  if (candidate.asset?.block_intro_candidate) return 2.2;
  if (candidate.asset?.chapter_card_candidate || candidate.chapter_card_clip) return 1.4;
  return 0;
};

const buildRejectedReasons = (components = {}) => {
  const reasons = [];
  if (components.blockMismatchPenalty >= 1) reasons.push("wrong_block");
  if (components.windowReusePenalty >= 1) reasons.push("reused_window");
  if (components.assetReusePenalty >= 1) reasons.push("reused_asset");
  if (components.sourceReusePenalty >= 1) reasons.push("reused_source_url");
  if (components.signatureReusePenalty >= 0.5) reasons.push("repeated_visual_signature");
  if (components.sceneBindingPenalty >= 1) reasons.push("cross_scene_candidate");
  if (components.editorialFit === "generic") reasons.push("generic_asset");
  if (components.editorialFit === "uncertain") reasons.push("uncertain_asset");
  if (components.editorialFit === "wrong") reasons.push("wrong_editorial_fit");
  if (components.darkFramePenalty >= 0.5) reasons.push("dark_frame_risk");
  if (components.semanticScore < 0.2) reasons.push("low_semantic_score");
  return reasons;
};

const rankCandidates = async ({
  block,
  narrationText,
  candidates,
  previousMacroTopic,
  usage,
  videoId,
  clipIndex = 1,
  hardBoundaryPolicy = {},
  isBoundaryFirstSlot = false,
}) => {
  const ranked = [];
  const semanticScores = await computeSemanticScores({ narrationText, candidates, videoId });

  for (const [index, candidate] of candidates.entries()) {
    const semantic = semanticScores[index] || { score: 0, method: "keyword_fallback" };
    const windowContext = {
      summary: candidate.description || candidate.summary || candidate.semantic_text || "",
      description: candidate.description || candidate.summary || candidate.semantic_text || "",
      tags: candidate.tags || [],
      detected_visual_categories: candidate.detected_visual_categories || [],
      detected_objects: candidate.detected_objects || [],
      start_seconds: candidate.start_sec,
      end_seconds: candidate.end_sec,
      duration_seconds: candidate.duration_sec,
      location: candidate.location,
    };
    const evidence = evaluateVisualEvidence({
      scene: block,
      window: windowContext,
      asset: candidate.asset || candidate,
    });
    const hardRejection = shouldRejectAssetForScene({
      asset: candidate.asset || candidate,
      scene: block,
      window: {
        ...windowContext,
        detected_visual_categories: evidence.detected_visual_categories,
        detected_objects: evidence.detected_objects,
      },
    });
    const editorialAssessment = buildWindowEditorialAssessment({
      scene: block,
      asset: candidate.asset || candidate,
      window: {
        ...windowContext,
        detected_visual_categories: evidence.detected_visual_categories,
        detected_objects: evidence.detected_objects,
      },
    });
    const sceneBinding = computeSceneBinding({ block, candidate });
    const blockMatchScore = computeBlockMatchScore({ block, candidate, previousMacroTopic });
    const entityMatchScore = computeEntityMatchScore({ block, candidate });
    const visualSpecificityScore = computeVisualSpecificityScore({ block, candidate });
    const gastronomySpecificityScore = computeGastronomySpecificityScore({ block, evidence });
    const specificIntentRequiresStrongEvidence = Array.isArray(block.required_visual_evidence) && block.required_visual_evidence.length > 0 && !block.generic_asset_allowed;
    const weakMetadataEvidence = isWeakMetadataEvidence(candidate);
    const editorialFitScore = EDITORIAL_FIT_SCORES[editorialAssessment.editorial_fit] ?? 0;
    const visualIntentMatchScore = evidence.visual_intent_match
      ? editorialAssessment.editorial_fit === "exact"
        ? 1
        : editorialAssessment.editorial_fit === "regional"
          ? 0.82
          : editorialAssessment.editorial_fit === "generic"
            ? 0.35
            : 0.15
      : 0;
    const rawRequiredEvidenceScore = clamp(Number(evidence.required_evidence_score || 0), 0, 1);
    const requiredEvidenceScore = weakMetadataEvidence && specificIntentRequiresStrongEvidence
      ? Math.min(rawRequiredEvidenceScore, 0.35)
      : Math.min(rawRequiredEvidenceScore, Math.max(editorialFitScore, 0.2));
    const evidenceSourceScore = computeEvidenceSourceScore(candidate);
    const resolutionScore = computeResolutionScore(candidate);
    const motionScore = computeMotionScore(candidate);
    const confidenceScore = weakMetadataEvidence ? Math.min(computeConfidenceScore(candidate), 0.35) : computeConfidenceScore(candidate);
    const reuse = computeReusePenalties({ block, candidate, usage, clipIndex });
    const blockMismatchPenalty = computeBlockMismatchPenalty({ block, candidate, previousMacroTopic });
    const hardBoundaryBlockReason = computeHardBoundaryBlockReason({
      block,
      candidate,
      previousMacroTopic,
      hardBoundaryPolicy,
      isBoundaryFirstSlot,
    });
    const hardBoundaryIntroBonus = computeHardBoundaryIntroBonus({ block, candidate, isBoundaryFirstSlot });
    const genericAssetPenalty = hardRejection.reason === "generic_visual_for_specific_intent"
      ? 1
      : Math.max(Number(evidence.generic_visual ? 1 : 0), computeGenericAssetPenalty({ block, candidate, editorialAssessment }));
    const forbiddenCategoryPenalty = clamp(Number(evidence.forbidden_category_penalty || 0), 0, 1);
    const metadataFallbackPenalty = weakMetadataEvidence && specificIntentRequiresStrongEvidence ? 1 : weakMetadataEvidence ? 0.35 : 0;
    const uncertainAssetPenalty = editorialAssessment.editorial_fit === "uncertain" ? 1 : 0;
    const darkFramePenalty = computeDarkFramePenalty(candidate);
    const thematicMismatchPenalty = computeThematicMismatchPenalty({ narrationText, candidate });

    const rawScore =
      semantic.score * SCORE_WEIGHTS.semanticScore +
      visualIntentMatchScore * SCORE_WEIGHTS.visualIntentMatchScore +
      requiredEvidenceScore * SCORE_WEIGHTS.requiredEvidenceScore +
      blockMatchScore * SCORE_WEIGHTS.blockMatchScore +
      entityMatchScore * SCORE_WEIGHTS.entityMatchScore +
      visualSpecificityScore * SCORE_WEIGHTS.visualSpecificityScore +
      gastronomySpecificityScore * SCORE_WEIGHTS.gastronomySpecificityScore +
      evidenceSourceScore * SCORE_WEIGHTS.evidenceSourceScore +
      editorialFitScore * SCORE_WEIGHTS.editorialFitScore +
      sceneBinding.score * SCORE_WEIGHTS.sceneBindingScore +
      resolutionScore * SCORE_WEIGHTS.resolutionScore +
      motionScore * SCORE_WEIGHTS.motionScore +
      confidenceScore * SCORE_WEIGHTS.confidenceScore +
      hardBoundaryIntroBonus -
      forbiddenCategoryPenalty * SCORE_WEIGHTS.forbiddenCategoryPenalty -
      reuse.sourceReusePenalty * SCORE_WEIGHTS.sourceReusePenalty -
      reuse.assetReusePenalty * SCORE_WEIGHTS.assetReusePenalty -
      reuse.windowReusePenalty * SCORE_WEIGHTS.windowReusePenalty -
      reuse.signatureReusePenalty * SCORE_WEIGHTS.signatureReusePenalty -
      blockMismatchPenalty * SCORE_WEIGHTS.blockMismatchPenalty -
      sceneBinding.penalty * SCORE_WEIGHTS.sceneBindingPenalty -
      genericAssetPenalty * SCORE_WEIGHTS.genericAssetPenalty -
      uncertainAssetPenalty * SCORE_WEIGHTS.uncertainAssetPenalty -
      metadataFallbackPenalty * SCORE_WEIGHTS.metadataFallbackPenalty -
      darkFramePenalty * SCORE_WEIGHTS.darkFramePenalty -
      thematicMismatchPenalty * SCORE_WEIGHTS.thematicMismatchPenalty;

    const reasons = buildRejectedReasons({
      semanticScore: semantic.score,
      sourceReusePenalty: reuse.sourceReusePenalty,
      assetReusePenalty: reuse.assetReusePenalty,
      windowReusePenalty: reuse.windowReusePenalty,
      signatureReusePenalty: reuse.signatureReusePenalty,
      blockMismatchPenalty,
      sceneBindingPenalty: sceneBinding.penalty,
      editorialFit: editorialAssessment.editorial_fit,
      genericAssetPenalty,
      uncertainAssetPenalty,
      metadataFallbackPenalty,
      forbiddenCategoryPenalty,
      darkFramePenalty,
      thematicMismatchPenalty,
    });
    const hardReuseBlockReason = computeHardReuseBlockReason({ candidate, usage });
    const namedEntityBlockReason = computeNamedEntityBlockReason({ narrationText, candidate, entityMatchScore });

    if (hardBoundaryBlockReason) reasons.unshift(hardBoundaryBlockReason);
    if (hardReuseBlockReason) reasons.unshift(hardReuseBlockReason);
    if (namedEntityBlockReason) reasons.unshift(namedEntityBlockReason);
    if (sceneBinding.hardBlocked && sceneBinding.reason) reasons.unshift(sceneBinding.reason);
    if (hardRejection.reject && hardRejection.reason) reasons.unshift(hardRejection.reason);

    const hardBlocked = Boolean(
      hardBoundaryBlockReason ||
      hardReuseBlockReason ||
      namedEntityBlockReason ||
      hardRejection.reject ||
      sceneBinding.hardBlocked ||
      editorialAssessment.editorial_fit === "wrong" ||
      (isCriticalScene(block) && !editorialAssessment.allowed_for_critical_slot)
    );
    // Score normalizado: -1 para hard-blocked em vez de -9999 para não distorcer
    // a média semântica quando há escassez de assets (ex: 12 assets para 132 clips).
    const finalScore = hardBlocked ? -1 : rawScore;

    ranked.push({
      candidate,
      score: round3(finalScore),
      method: semantic.method,
      hard_blocked: hardBlocked,
      hard_blocked_reason: hardBoundaryBlockReason || hardReuseBlockReason || namedEntityBlockReason || (hardRejection.reject ? hardRejection.reason : "") || (sceneBinding.hardBlocked ? sceneBinding.reason : editorialAssessment.editorial_fit === "wrong" ? "wrong_editorial_fit" : ""),
      features: {
        semanticScore: round3(semantic.score),
        visualIntentMatchScore: round3(visualIntentMatchScore),
        requiredEvidenceScore: round3(requiredEvidenceScore),
        blockMatchScore: round3(blockMatchScore),
        entityMatchScore: round3(entityMatchScore),
        visualSpecificityScore: round3(visualSpecificityScore),
        gastronomySpecificityScore: round3(gastronomySpecificityScore),
        evidenceSourceScore: round3(evidenceSourceScore),
        editorialFit: editorialAssessment.editorial_fit,
        editorialFitScore: round3(editorialFitScore),
        sceneBindingScore: round3(sceneBinding.score),
        sceneBindingPenalty: round3(sceneBinding.penalty),
        resolutionScore: round3(resolutionScore),
        motionScore: round3(motionScore),
        confidenceScore: round3(confidenceScore),
        forbiddenCategoryPenalty: round3(forbiddenCategoryPenalty),
        sourceReusePenalty: round3(reuse.sourceReusePenalty),
        assetReusePenalty: round3(reuse.assetReusePenalty),
        windowReusePenalty: round3(reuse.windowReusePenalty),
        signatureReusePenalty: round3(reuse.signatureReusePenalty),
        blockMismatchPenalty: round3(blockMismatchPenalty),
        genericAssetPenalty: round3(genericAssetPenalty),
        uncertainAssetPenalty: round3(uncertainAssetPenalty),
        metadataFallbackPenalty: round3(metadataFallbackPenalty),
        darkFramePenalty: round3(darkFramePenalty),
        thematicMismatchPenalty: round3(thematicMismatchPenalty),
        hardBoundaryIntroBonus: round3(hardBoundaryIntroBonus),
        reusePenalty: round3(reuse.total),
        detectedVisualCategories: evidence.detected_visual_categories,
        missingRequiredVisualEvidence: evidence.missing_required_visual_evidence,
        rejectionWarnings: hardRejection.warnings || [],
        visualEvidenceSource: candidate.visual_evidence_source || candidate.analysis_provider || "metadata_fallback",
      },
      selection_reason: hardBlocked
        ? `hard_blocked_${hardBoundaryBlockReason || sceneBinding.reason || editorialAssessment.editorial_fit}`
        : hardRejection.reject
          ? `rejected_${hardRejection.reason}`
          : `best_${semantic.method}_${editorialAssessment.editorial_fit}`,
      rejected_reasons: reasons,
      visual_signature: reuse.signature,
    });
  }

  return ranked.sort((left, right) => right.score - left.score);
};

const registerClipUsage = ({ usage, block, candidate, clipIndex }) => {
  const sourceUrl = candidate.asset?.source_url || "";
  const localPath = candidate.asset?.local_path || "";
  const provider = candidate.source || candidate.asset?.provider || "unknown";
  const signature = buildVisualSignature(candidate);

  usage.usedSourceUrls = usage.usedSourceUrls || new Map();
  usage.usedAssetIds = usage.usedAssetIds || new Map();
  usage.usedLocalPaths = usage.usedLocalPaths || new Map();
  usage.usedWindowIds = usage.usedWindowIds || new Map();
  usage.usedProviders = usage.usedProviders || new Map();
  usage.usedBlockAssetIds = usage.usedBlockAssetIds || new Map();
  usage.usedVisualSignatures = usage.usedVisualSignatures || new Map();
  usage.lastClipByAssetId = usage.lastClipByAssetId || new Map();
  usage.usedLandmarks = usage.usedLandmarks || new Map();

  if (sourceUrl) usage.usedSourceUrls.set(sourceUrl, (usage.usedSourceUrls.get(sourceUrl) || 0) + 1);
  if (localPath) usage.usedLocalPaths.set(localPath, (usage.usedLocalPaths.get(localPath) || 0) + 1);
  usage.usedAssetIds.set(candidate.asset_id, (usage.usedAssetIds.get(candidate.asset_id) || 0) + 1);
  usage.usedWindowIds.set(candidate.id, (usage.usedWindowIds.get(candidate.id) || 0) + 1);
  usage.usedProviders.set(provider, (usage.usedProviders.get(provider) || 0) + 1);
  usage.usedVisualSignatures.set(signature, (usage.usedVisualSignatures.get(signature) || 0) + 1);
  if (block.block_id) {
    const blockKey = `${block.block_id}:${candidate.asset_id}`;
    usage.usedBlockAssetIds.set(blockKey, (usage.usedBlockAssetIds.get(blockKey) || 0) + 1);
  }
  usage.lastClipByAssetId.set(candidate.asset_id, clipIndex);
  (candidate.landmarks || []).forEach((item) => {
    const name = normalizeLabel(item?.name || "");
    if (name) usage.usedLandmarks.set(name, (usage.usedLandmarks.get(name) || 0) + 1);
  });
};

module.exports = {
  SCORE_WEIGHTS,
  buildVisualSignature,
  rankCandidates,
  registerClipUsage,
  __test__: {
    SCORE_WEIGHTS,
    buildVisualSignature,
    computeHardReuseBlockReason,
    computeNamedEntityBlockReason,
    computeBlockMatchScore,
    computeEvidenceSourceScore,
    computeEntityMatchScore,
    computeReusePenalties,
    computeBlockMismatchPenalty,
    computeSceneBinding,
    computeHardBoundaryBlockReason,
    computeHardBoundaryIntroBonus,
    computeGenericAssetPenalty,
    computeGastronomySpecificityScore,
    computeDarkFramePenalty,
    computeThematicMismatchPenalty,
    isWeakMetadataEvidence,
    FIT_PRIORITY,
  },
};