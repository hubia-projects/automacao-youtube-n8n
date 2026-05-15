const { matchNarrationToAssetWindows, keywordOverlapScore } = require("./semanticMatcher");
const { shouldRejectAssetForScene } = require("./assetRejectionService");
const {
  buildSemanticTerms,
  isSameLocation,
  belongsToTopic,
  normalizeLabel,
} = require("./narrativeBlockPlanner");
const { evaluateVisualEvidence } = require("./visualIntentService");
const {
  buildEditorialFamilyKey,
  classifyEditorialCandidate,
} = require("./editorialPlanningService");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round3 = (value) => Number(Number(value || 0).toFixed(3));

const SCORE_WEIGHTS = {
  semanticScore: 5.0,
  visualIntentMatchScore: 6.0,
  requiredEvidenceScore: 5.0,
  blockMatchScore: 4.0,
  entityMatchScore: 3.5,
  visualSpecificityScore: 3.0,
  gastronomySpecificityScore: 3.0,
  evidenceSourceScore: 2.5,
  resolutionScore: 1.0,
  motionScore: 1.0,
  confidenceScore: 1.0,
  editorialStatusBonus: 2.8,
  editorialPenalty: 5.5,
  forbiddenCategoryPenalty: 10.0,
  sourceReusePenalty: 4.0,
  assetReusePenalty: 4.0,
  windowReusePenalty: 5.0,
  signatureReusePenalty: 4.5,
  blockMismatchPenalty: 8.0,
  genericAssetPenalty: 7.0,
  metadataFallbackPenalty: 4.5,
  darkFramePenalty: 4.0,
};

const buildVisualSignature = (candidate = {}) => {
  const categories = (candidate.detected_visual_categories || []).slice(0, 3).map((category) => normalizeLabel(category));
  return [
    normalizeLabel(candidate.location_type || "unknown"),
    normalizeLabel(candidate.visual_features?.shot_type || "unknown"),
    normalizeLabel(candidate.visual_features?.camera_motion || "unknown"),
    normalizeLabel(candidate.location?.city || "neutral"),
    categories.join("+"),
    normalizeLabel(candidate.asset?.provider || candidate.source || "unknown"),
  ].join("|");
};

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

const computeGenericAssetPenalty = ({ block, candidate }) => {
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

const computeEditorialStatusBonus = (editorial = {}) => {
  if (editorial.status === "exact") return 1;
  if (editorial.status === "regional") return 0.45;
  return 0;
};

const computeEditorialPenalty = (editorial = {}) => {
  if (editorial.status === "wrong") return 1;
  if (editorial.status === "generic") return editorial.critical_role ? 1 : 0.7;
  if (editorial.status === "uncertain") return editorial.critical_role ? 0.9 : 0.45;
  return 0;
};

const buildReuseSnapshot = ({ usage, candidate, signature }) => {
  const sourceUrl = candidate.asset?.source_url || "";
  const localPath = candidate.asset?.local_path || "";
  const resolvedSignature = signature || buildVisualSignature(candidate);

  return {
    sourceUrlCount: usage.usedSourceUrls?.get(sourceUrl) || 0,
    assetCount: usage.usedAssetIds?.get(candidate.asset_id) || 0,
    localPathCount: usage.usedLocalPaths?.get(localPath) || 0,
    windowCount: usage.usedWindowIds?.get(candidate.id) || 0,
    providerCount: usage.usedProviders?.get(candidate.source || candidate.asset?.provider || "unknown") || 0,
    signatureCount: usage.usedVisualSignatures?.get(resolvedSignature) || 0,
    lastSignatureClipIndex: usage.lastClipBySignature?.get(resolvedSignature) || 0,
    signature: resolvedSignature,
  };
};

const computeReusePenalties = ({ block, candidate, usage, clipIndex, signature }) => {
  const snapshot = buildReuseSnapshot({ usage, candidate, signature });
  const sameAssetLastGap = usage.lastClipByAssetId?.get(candidate.asset_id);
  const sameSignatureGap = snapshot.lastSignatureClipIndex ? clipIndex - snapshot.lastSignatureClipIndex : Infinity;

  const sourceReusePenalty = clamp(snapshot.sourceUrlCount > 0 ? snapshot.sourceUrlCount / 2 : 0, 0, 1);
  const assetReusePenalty = clamp(snapshot.assetCount > 0 ? snapshot.assetCount / 2 : 0, 0, 1);
  const windowReusePenalty = clamp(snapshot.windowCount > 0 ? 1 : 0, 0, 1);
  const signatureReusePenalty = clamp(snapshot.signatureCount > 0 ? Math.min(1, snapshot.signatureCount / 2) : 0, 0, 1);
  const adjacencyPenalty = sameSignatureGap < 3 ? clamp((3 - sameSignatureGap) / 2, 0, 1) : 0;
  const minGapPenalty = sameAssetLastGap && clipIndex - sameAssetLastGap < 2 ? 1 : 0;
  const blockOverusePenalty = block.block_id && (usage.usedBlockAssetIds?.get(`${block.block_id}:${candidate.asset_id}`) || 0) > 0.5 ? 0.5 : 0;

  return {
    sourceReusePenalty,
    assetReusePenalty: clamp(assetReusePenalty + blockOverusePenalty + minGapPenalty, 0, 1),
    windowReusePenalty,
    signatureReusePenalty: clamp(signatureReusePenalty + adjacencyPenalty, 0, 1),
    total: clamp((sourceReusePenalty + assetReusePenalty + windowReusePenalty + signatureReusePenalty + adjacencyPenalty) / 5, 0, 1),
    signature: snapshot.signature,
  };
};

const computeBlockMismatchPenalty = ({ block, candidate, previousMacroTopic }) => {
  const candidateCity = candidate.location?.city || "";
  if (!candidateCity) return 0;
  if (block.location?.city && !isSameLocation(candidateCity, block.location.city)) return 1;
  if (previousMacroTopic && block.hard_boundary && belongsToTopic(candidateCity, previousMacroTopic)) return 1;
  if ((block.forbidden_locations || []).some((topic) => belongsToTopic(candidateCity, topic))) return 1;
  return 0;
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
  if (components.blockMismatchPenalty >= 1) reasons.push("editorial_wrong");
  if (components.genericAssetPenalty >= 0.6) reasons.push("generic_asset");
  if (components.editorialPenalty >= 0.7) reasons.push("editorial_status_low");
  if (components.darkFramePenalty >= 0.5) reasons.push("dark_frame_risk");
  if (components.semanticScore < 0.2) reasons.push("low_semantic_score");
  return unique(reasons);
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
    const evidence = evaluateVisualEvidence({
      scene: block,
      window: {
        summary: candidate.description || candidate.summary || candidate.semantic_text || "",
        description: candidate.description || candidate.summary || candidate.semantic_text || "",
        tags: candidate.tags || [],
        detected_visual_categories: candidate.detected_visual_categories || [],
        detected_objects: candidate.detected_objects || [],
        start_seconds: candidate.start_sec,
        end_seconds: candidate.end_sec,
        duration_seconds: candidate.duration_sec,
        location: candidate.location,
      },
      asset: candidate.asset || candidate,
    });
    const editorial = classifyEditorialCandidate({ scene: block, block, candidate, evidence });
    const editorialSignature = buildEditorialFamilyKey({ scene: block, block, candidate, evidence });
    const hardRejection = shouldRejectAssetForScene({
      asset: candidate.asset || candidate,
      scene: { ...block, narrative_role: editorial.narrative_role, is_boundary_first_slot: isBoundaryFirstSlot },
      window: {
        summary: candidate.description || candidate.summary || candidate.semantic_text || "",
        description: candidate.description || candidate.summary || candidate.semantic_text || "",
        tags: candidate.tags || [],
        detected_visual_categories: evidence.detected_visual_categories,
        detected_objects: evidence.detected_objects,
        start_seconds: candidate.start_sec,
        end_seconds: candidate.end_sec,
        duration_seconds: candidate.duration_sec,
        location: candidate.location,
      },
    });
    const blockMatchScore = computeBlockMatchScore({ block, candidate, previousMacroTopic });
    const entityMatchScore = computeEntityMatchScore({ block, candidate });
    const visualSpecificityScore = computeVisualSpecificityScore({ block, candidate });
    const gastronomySpecificityScore = computeGastronomySpecificityScore({ block, evidence });
    const specificIntentRequiresStrongEvidence = Array.isArray(block.required_visual_evidence) && block.required_visual_evidence.length > 0 && !block.generic_asset_allowed;
    const weakMetadataEvidence = isWeakMetadataEvidence(candidate);
    const visualIntentMatchScore = evidence.visual_intent_match && !(weakMetadataEvidence && specificIntentRequiresStrongEvidence) ? 1 : 0;
    const rawRequiredEvidenceScore = clamp(Number(evidence.required_evidence_score || 0), 0, 1);
    const requiredEvidenceScore = weakMetadataEvidence && specificIntentRequiresStrongEvidence
      ? Math.min(rawRequiredEvidenceScore, 0.35)
      : rawRequiredEvidenceScore;
    const evidenceSourceScore = computeEvidenceSourceScore(candidate);
    const resolutionScore = computeResolutionScore(candidate);
    const motionScore = computeMotionScore(candidate);
    const confidenceScore = weakMetadataEvidence ? Math.min(computeConfidenceScore(candidate), 0.35) : computeConfidenceScore(candidate);
    const reuse = computeReusePenalties({ block, candidate, usage, clipIndex, signature: editorialSignature });
    const blockMismatchPenalty = computeBlockMismatchPenalty({ block, candidate, previousMacroTopic });
    const hardBoundaryBlockReason = computeHardBoundaryBlockReason({
      block,
      candidate,
      previousMacroTopic,
      hardBoundaryPolicy,
      isBoundaryFirstSlot,
    });
    const hardBoundaryIntroBonus = computeHardBoundaryIntroBonus({ block, candidate, isBoundaryFirstSlot });
    const editorialStatusBonus = computeEditorialStatusBonus(editorial);
    const editorialPenalty = computeEditorialPenalty(editorial);
    const hardBlocked = Boolean(hardBoundaryBlockReason)
      || (editorial.critical_role && ["generic", "uncertain", "wrong"].includes(editorial.status));
    const genericAssetPenalty = hardRejection.reason === "generic_visual_for_specific_intent"
      ? 1
      : Math.max(Number(evidence.generic_visual ? 1 : 0), computeGenericAssetPenalty({ block, candidate }));
    const forbiddenCategoryPenalty = clamp(Number(evidence.forbidden_category_penalty || 0), 0, 1);
    const metadataFallbackPenalty = weakMetadataEvidence && specificIntentRequiresStrongEvidence ? 1 : weakMetadataEvidence ? 0.35 : 0;
    const darkFramePenalty = computeDarkFramePenalty(candidate);

    const rawScore =
      semantic.score * SCORE_WEIGHTS.semanticScore +
      visualIntentMatchScore * SCORE_WEIGHTS.visualIntentMatchScore +
      requiredEvidenceScore * SCORE_WEIGHTS.requiredEvidenceScore +
      blockMatchScore * SCORE_WEIGHTS.blockMatchScore +
      entityMatchScore * SCORE_WEIGHTS.entityMatchScore +
      visualSpecificityScore * SCORE_WEIGHTS.visualSpecificityScore +
      gastronomySpecificityScore * SCORE_WEIGHTS.gastronomySpecificityScore +
      evidenceSourceScore * SCORE_WEIGHTS.evidenceSourceScore +
      resolutionScore * SCORE_WEIGHTS.resolutionScore +
      motionScore * SCORE_WEIGHTS.motionScore +
      confidenceScore * SCORE_WEIGHTS.confidenceScore +
      editorialStatusBonus * SCORE_WEIGHTS.editorialStatusBonus +
      hardBoundaryIntroBonus -
      editorialPenalty * SCORE_WEIGHTS.editorialPenalty -
      forbiddenCategoryPenalty * SCORE_WEIGHTS.forbiddenCategoryPenalty -
      reuse.sourceReusePenalty * SCORE_WEIGHTS.sourceReusePenalty -
      reuse.assetReusePenalty * SCORE_WEIGHTS.assetReusePenalty -
      reuse.windowReusePenalty * SCORE_WEIGHTS.windowReusePenalty -
      reuse.signatureReusePenalty * SCORE_WEIGHTS.signatureReusePenalty -
      blockMismatchPenalty * SCORE_WEIGHTS.blockMismatchPenalty -
      genericAssetPenalty * SCORE_WEIGHTS.genericAssetPenalty -
      metadataFallbackPenalty * SCORE_WEIGHTS.metadataFallbackPenalty -
      darkFramePenalty * SCORE_WEIGHTS.darkFramePenalty;

    const reasons = buildRejectedReasons({
      semanticScore: semantic.score,
      sourceReusePenalty: reuse.sourceReusePenalty,
      assetReusePenalty: reuse.assetReusePenalty,
      windowReusePenalty: reuse.windowReusePenalty,
      signatureReusePenalty: reuse.signatureReusePenalty,
      blockMismatchPenalty,
      genericAssetPenalty,
      editorialPenalty,
      metadataFallbackPenalty,
      forbiddenCategoryPenalty,
      darkFramePenalty,
    });
    if (editorial.reason) reasons.unshift(editorial.reason);
    if (hardBoundaryBlockReason) reasons.unshift(hardBoundaryBlockReason);
    if (hardRejection.reject && hardRejection.reason) reasons.unshift(hardRejection.reason);

    const finalScore = hardBlocked ? -9999 : rawScore;

    ranked.push({
      candidate,
      score: round3(finalScore),
      method: semantic.method,
      hard_blocked: hardBlocked,
      hard_blocked_reason: hardBoundaryBlockReason || (editorial.critical_role && ["generic", "uncertain", "wrong"].includes(editorial.status) ? `critical_slot_${editorial.status}` : ""),
      features: {
        semanticScore: round3(semantic.score),
        visualIntentMatchScore: round3(visualIntentMatchScore),
        requiredEvidenceScore: round3(requiredEvidenceScore),
        blockMatchScore: round3(blockMatchScore),
        entityMatchScore: round3(entityMatchScore),
        visualSpecificityScore: round3(visualSpecificityScore),
        gastronomySpecificityScore: round3(gastronomySpecificityScore),
        evidenceSourceScore: round3(evidenceSourceScore),
        resolutionScore: round3(resolutionScore),
        motionScore: round3(motionScore),
        confidenceScore: round3(confidenceScore),
        editorialStatusBonus: round3(editorialStatusBonus),
        editorialPenalty: round3(editorialPenalty),
        editorialStatus: editorial.status,
        editorialReason: editorial.reason,
        narrativeRole: editorial.narrative_role,
        criticalRole: Boolean(editorial.critical_role),
        editorialFamilyKey: editorial.editorial_family_key,
        forbiddenCategoryPenalty: round3(forbiddenCategoryPenalty),
        sourceReusePenalty: round3(reuse.sourceReusePenalty),
        assetReusePenalty: round3(reuse.assetReusePenalty),
        windowReusePenalty: round3(reuse.windowReusePenalty),
        signatureReusePenalty: round3(reuse.signatureReusePenalty),
        blockMismatchPenalty: round3(blockMismatchPenalty),
        genericAssetPenalty: round3(genericAssetPenalty),
        metadataFallbackPenalty: round3(metadataFallbackPenalty),
        darkFramePenalty: round3(darkFramePenalty),
        hardBoundaryIntroBonus: round3(hardBoundaryIntroBonus),
        reusePenalty: round3(reuse.total),
        detectedVisualCategories: evidence.detected_visual_categories,
        missingRequiredVisualEvidence: evidence.missing_required_visual_evidence,
        rejectionWarnings: hardRejection.warnings || [],
        visualEvidenceSource: candidate.visual_evidence_source || candidate.analysis_provider || "metadata_fallback",
      },
      selection_reason: hardBlocked
        ? `hard_boundary_blocked_${hardBoundaryBlockReason || editorial.status}`
        : hardRejection.reject
        ? `rejected_${hardRejection.reason}`
        : blockMismatchPenalty >= 1
        ? "blocked_wrong_block"
        : reasons.length
          ? `selected_despite_${reasons[0]}`
          : `best_${semantic.method}`,
      rejected_reasons: unique(reasons),
      visual_signature: editorialSignature || reuse.signature,
    });
  }

  return ranked.sort((left, right) => right.score - left.score);
};

const registerClipUsage = ({ usage, block, candidate, clipIndex, signature = "" }) => {
  const sourceUrl = candidate.asset?.source_url || "";
  const localPath = candidate.asset?.local_path || "";
  const provider = candidate.source || candidate.asset?.provider || "unknown";
  const resolvedSignature = signature || buildVisualSignature(candidate);

  usage.usedSourceUrls = usage.usedSourceUrls || new Map();
  usage.usedAssetIds = usage.usedAssetIds || new Map();
  usage.usedLocalPaths = usage.usedLocalPaths || new Map();
  usage.usedWindowIds = usage.usedWindowIds || new Map();
  usage.usedProviders = usage.usedProviders || new Map();
  usage.usedBlockAssetIds = usage.usedBlockAssetIds || new Map();
  usage.usedVisualSignatures = usage.usedVisualSignatures || new Map();
  usage.lastClipByAssetId = usage.lastClipByAssetId || new Map();
  usage.lastClipBySignature = usage.lastClipBySignature || new Map();

  if (sourceUrl) usage.usedSourceUrls.set(sourceUrl, (usage.usedSourceUrls.get(sourceUrl) || 0) + 1);
  if (localPath) usage.usedLocalPaths.set(localPath, (usage.usedLocalPaths.get(localPath) || 0) + 1);
  usage.usedAssetIds.set(candidate.asset_id, (usage.usedAssetIds.get(candidate.asset_id) || 0) + 1);
  usage.usedWindowIds.set(candidate.id, (usage.usedWindowIds.get(candidate.id) || 0) + 1);
  usage.usedProviders.set(provider, (usage.usedProviders.get(provider) || 0) + 1);
  usage.usedVisualSignatures.set(resolvedSignature, (usage.usedVisualSignatures.get(resolvedSignature) || 0) + 1);
  if (block.block_id) {
    const blockKey = `${block.block_id}:${candidate.asset_id}`;
    usage.usedBlockAssetIds.set(blockKey, (usage.usedBlockAssetIds.get(blockKey) || 0) + 1);
  }
  usage.lastClipByAssetId.set(candidate.asset_id, clipIndex);
  usage.lastClipBySignature.set(resolvedSignature, clipIndex);
};

module.exports = {
  SCORE_WEIGHTS,
  buildVisualSignature,
  rankCandidates,
  registerClipUsage,
  __test__: {
    SCORE_WEIGHTS,
    buildVisualSignature,
    computeBlockMatchScore,
    computeEvidenceSourceScore,
    computeEntityMatchScore,
    computeReusePenalties,
    computeBlockMismatchPenalty,
    computeHardBoundaryBlockReason,
    computeHardBoundaryIntroBonus,
    computeGenericAssetPenalty,
    computeGastronomySpecificityScore,
    computeDarkFramePenalty,
    isWeakMetadataEvidence,
  },
};