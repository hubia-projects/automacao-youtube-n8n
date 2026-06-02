const { matchNarrationToAssetWindows, keywordOverlapScore } = require("./semanticMatcher");
const { shouldRejectAssetForScene } = require("./assetRejectionService");
const {
  buildSemanticTerms,
  isSameLocation,
  belongsToTopic,
  normalizeLabel,
} = require("./narrativeBlockPlanner");
const { evaluateVisualEvidence } = require("./visualIntentService");
const { SOURCE_TIER_PRIORITY } = require("../config/editorialPolicy");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round3 = (value) => Number(Number(value || 0).toFixed(3));
const resolveBlockScopeId = (block = {}) =>
  String(
    block.macro_block_id
    || block.parent_id
    || block.block_scope_id
    || block.block_id
    || block.id
    || block.scene_index
    || ""
  ).trim();

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
  forbiddenCategoryPenalty: 10.0,
  sourceReusePenalty: 4.0,
  assetReusePenalty: 4.0,
  windowReusePenalty: 5.0,
  clipLibraryReusePenalty: 8.0,
  signatureReusePenalty: 3.5,
  blockSignaturePenalty: 4.5,
  blockProviderPenalty: 3.0,
  blockLandmarkPenalty: 3.5,
  blockMismatchPenalty: 8.0,
  genericAssetPenalty: 7.0,
  metadataFallbackPenalty: 4.5,
  darkFramePenalty: 4.0,
  microNeedExactMatchScore: 6.2,
  microActionMatchScore: 5.2,
  microTemporalPrecisionScore: 4.8,
  microProofMissPenalty: 8.5,
  repairStatePenalty: 4.4,
};

const MICRO_NEED_KEYWORDS = {
  market_stall: ["market", "mercado", "banca", "stall", "feira", "food hall"],
  vendor_interaction: ["vendor", "vendedor", "atendente", "serving", "servindo", "atendimento"],
  people_eating: ["people eating", "pessoas comendo", "comendo", "eating", "degustando", "tasting"],
  pastry_closeup: ["pastry", "pastel", "doces", "dessert", "bakery", "confeitaria"],
  food_closeup: ["food", "comida", "dish", "prato", "ingrediente", "fresh produce"],
  wine_pouring: ["wine", "vinho", "pour", "pouring", "taça", "glass", "brinde"],
  restaurant_table: ["restaurant", "restaurante", "table", "mesa", "cafe", "coffee shop"],
  street_level: ["street", "rua", "bairro", "walking", "centro", "downtown"],
  landmark: ["landmark", "ponte", "bridge", "tower", "torre", "rio", "river"],
};

const buildVisualSignature = (candidate = {}) => [
  normalizeLabel(candidate.location_type || "unknown"),
  normalizeLabel(candidate.visual_features?.shot_type || "unknown"),
  normalizeLabel(candidate.visual_features?.camera_motion || "unknown"),
  normalizeLabel(candidate.location?.city || "neutral"),
  normalizeLabel((candidate.tags || []).slice(0, 3).join(" ")),
].join("|");

const getCandidateReuseAssetKey = (candidate = {}) =>
  String(
    candidate.source_asset_id
    || candidate.asset?.source_asset_id
    || candidate.asset_id
    || candidate.asset?.asset_id
    || ""
  ).trim();

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

const computeMicroNeedExactMatchScore = ({ candidate = {}, microMoment = null }) => {
  if (!microMoment) return 0.5;
  const need = String(microMoment.visual_need || "").toLowerCase();
  if (!need) return 0.5;
  const slotType = String(candidate.content_slot_type || "").toLowerCase();
  if (slotType && slotType === need) return 1;
  const supported = (candidate.micro_needs_supported || []).map((item) => String(item || "").toLowerCase());
  if (supported.includes(need)) return 1;
  const keywords = MICRO_NEED_KEYWORDS[need] || [need.replace(/_/g, " ")];
  const haystack = normalizeLabel([
    candidate.description,
    candidate.summary,
    candidate.content_slot_type,
    ...(candidate.tags || []),
    ...(candidate.detected_visual_categories || []),
    ...(candidate.detected_objects || []),
  ].filter(Boolean).join(" "));
  const keywordHits = keywords.filter((keyword) => haystack.includes(String(keyword || "").toLowerCase())).length;
  if (keywordHits > 0) {
    const ratio = clamp(keywordHits / Math.max(1, Math.min(3, keywords.length)), 0, 1);
    return clamp(0.72 + (ratio * 0.28), 0, 1);
  }
  return 0.1;
};

const computeMicroActionMatchScore = ({ candidate = {}, microMoment = null }) => {
  if (!microMoment) return 0.5;
  const actions = (microMoment.action_tokens || []).map((item) => String(item || "").toLowerCase());
  if (!actions.length) return 0.5;
  const detected = (candidate.action_tokens_detected || []).map((item) => String(item || "").toLowerCase());
  const text = normalizeLabel([
    candidate.description,
    ...(candidate.tags || []),
    ...(candidate.detected_objects || []),
    ...(candidate.detected_visual_categories || []),
  ].filter(Boolean).join(" "));
  const hits = actions.filter((token) => detected.includes(token) || text.includes(token)).length;
  return clamp(hits / Math.max(1, actions.length), 0, 1);
};

const computeMicroTemporalPrecisionScore = ({ candidate = {}, microMoment = null, slotStartSec = 0, slotEndSec = 0 }) => {
  if (!microMoment) return 0.6;
  const microDuration = Math.max(0.2, Number(microMoment.end_sec || 0) - Number(microMoment.start_sec || 0));
  const hintDuration = Number(candidate.temporal_match_hints?.duration_seconds || 0);
  const candidateDuration = Math.max(0.2, hintDuration || Number(candidate.duration_sec || 0));
  const durationDelta = Math.abs(candidateDuration - microDuration);
  const durationFit = clamp(1 - (durationDelta / Math.max(1, microDuration)), 0, 1);
  const candidateActionHints = (candidate.temporal_match_hints?.dominant_action_tokens || []).map((item) => normalizeLabel(item));
  const microActions = (microMoment.action_tokens || []).map((item) => normalizeLabel(item));
  const actionFit = microActions.length
    ? clamp(microActions.filter((token) => candidateActionHints.includes(token)).length / microActions.length, 0, 1)
    : 0.7;
  const sourceFit = String(candidate.visual_observation_origin || "real_vision").toLowerCase() === "real_vision" ? 1 : 0.45;
  const slotMid = (Number(slotStartSec || 0) + Number(slotEndSec || slotStartSec || 0)) / 2;
  const microMid = (Number(microMoment.start_sec || 0) + Number(microMoment.end_sec || 0)) / 2;
  const drift = Math.abs(slotMid - microMid);
  const driftFit = clamp(1 - (drift / 1.2), 0, 1);
  return clamp((durationFit * 0.45) + (actionFit * 0.35) + (sourceFit * 0.1) + (driftFit * 0.1), 0, 1);
};

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

const computeEditorialContractPenalty = ({ candidate = {}, isBoundaryFirstSlot = false, slotRole = "" }) => {
  const approved = candidate.editorial_approved === true || candidate.approved === true;
  if (!approved) return 1;

  if (isBoundaryFirstSlot && candidate.critical_slot_allowed === false) return 1;
  if (slotRole === "opening_establishing" && candidate.opening_allowed === false) return 1;
  if (slotRole === "closing_payoff" && candidate.closing_allowed === false) return 1;

  return 0;
};

const computeGenericAssetPenalty = ({ block, candidate }) => {
  const text = normalizeLabel(`${candidate.description || ""} ${candidate.semantic_text || ""} ${(candidate.tags || []).join(" ")}`);
  if (candidate.neutral) return 0.5;
  if (/generic|travel footage|travel video|city skyline|coastline|lifestyle/.test(text) && block.topic_type === "city") return 0.75;
  if ((block.subtheme === "food" || block.subtheme === "market" || block.subtheme === "wine_pastry") && !/food|market|wine|pastry|dessert|bakery|cafe|restaurant|dish/.test(text)) {
    return 0.85;
  }
  if (["gastronomy", "market", "wine", "pastry", "restaurant", "cafe", "street_food"].includes(String(block.visual_intent || "").toLowerCase())) {
    if (/landscape|coast|bridge|river|aerial|skyline|historic street|generic_street|city_landmark/.test(text)) {
      return Math.max(0.82, Number(candidate.neutral ? 0.9 : 0.82));
    }
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
  const reuseAssetKey = getCandidateReuseAssetKey(candidate);

  return {
    sourceUrlCount: usage.usedSourceUrls?.get(sourceUrl) || 0,
    assetCount: usage.usedAssetIds?.get(reuseAssetKey) || 0,
    localPathCount: usage.usedLocalPaths?.get(localPath) || 0,
    windowCount: usage.usedWindowIds?.get(candidate.id) || 0,
    providerCount: usage.usedProviders?.get(candidate.source || candidate.asset?.provider || "unknown") || 0,
    clipLibraryCount: usage.usedClipLibraryIds?.get(String(candidate.clip_library_id || "")) || 0,
    signatureCount: usage.usedVisualSignatures?.get(signature) || 0,
    signature,
    reuseAssetKey,
  };
};

const computeReusePenalties = ({ block, candidate, usage, clipIndex }) => {
  const snapshot = buildReuseSnapshot({ usage, candidate });
  const sameAssetLastGap = usage.lastClipByAssetId?.get(snapshot.reuseAssetKey);
  const blockKey = resolveBlockScopeId(block);
  const provider = String(candidate.source || candidate.asset?.provider || "unknown").toLowerCase();
  const providerPenaltyExempt = candidate.from_clip_library === true || provider === "clip_library";
  const landmarkKey = normalizeLabel(
    `${(candidate.landmarks || [])[0]?.name || (candidate.landmarks || [])[0] || ""}|${(candidate.landmarks || [])[0]?.city || candidate.location?.city || ""}`
  );
  const blockSignatureCount = blockKey
    ? Number(usage.usedBlockVisualSignatures?.get(`${blockKey}:${snapshot.signature}`) || 0)
    : 0;
  const blockProviderCount = blockKey
    ? Number(usage.usedBlockProviders?.get(`${blockKey}:${provider}`) || 0)
    : 0;
  const blockLandmarkCount = blockKey && landmarkKey
    ? Number(usage.usedBlockLandmarks?.get(`${blockKey}:${landmarkKey}`) || 0)
    : 0;

  const sourceReusePenalty = clamp(snapshot.sourceUrlCount > 0 ? snapshot.sourceUrlCount / 2 : 0, 0, 1);
  const assetReusePenalty = clamp(snapshot.assetCount > 0 ? snapshot.assetCount / 2 : 0, 0, 1);
  const windowReusePenalty = clamp(snapshot.windowCount > 0 ? 1 : 0, 0, 1);
  const clipLibraryReusePenalty = clamp(snapshot.clipLibraryCount > 0 ? 1 : 0, 0, 1);
  const signatureReusePenalty = clamp(snapshot.signatureCount > 0 ? Math.min(1, snapshot.signatureCount / 2) : 0, 0, 1);
  const minGapPenalty = sameAssetLastGap && clipIndex - sameAssetLastGap < 3 ? 1 : 0;
  const blockOverusePenalty = blockKey && (usage.usedBlockAssetIds?.get(`${blockKey}:${snapshot.reuseAssetKey}`) || 0) > 0.5 ? 0.5 : 0;
  const blockSignaturePenalty = clamp(blockSignatureCount > 0 ? Math.min(1, blockSignatureCount / 1.5) : 0, 0, 1);
  const blockProviderPenalty = providerPenaltyExempt
    ? 0
    : clamp(blockProviderCount >= 2 ? Math.min(1, (blockProviderCount - 1) / 2) : 0, 0, 1);
  const blockLandmarkPenalty = clamp(blockLandmarkCount > 0 ? Math.min(1, blockLandmarkCount / 1.5) : 0, 0, 1);

  return {
    sourceReusePenalty,
    assetReusePenalty: clamp(assetReusePenalty + blockOverusePenalty + minGapPenalty, 0, 1),
    windowReusePenalty,
    clipLibraryReusePenalty,
    signatureReusePenalty,
    blockSignaturePenalty,
    blockProviderPenalty,
    blockLandmarkPenalty,
    total: clamp(
      (
        sourceReusePenalty
        + assetReusePenalty
        + windowReusePenalty
        + clipLibraryReusePenalty
        + signatureReusePenalty
        + blockSignaturePenalty
        + blockProviderPenalty
        + blockLandmarkPenalty
      ) / 8,
      0,
      1
    ),
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
  slotRole = "",
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

const computeSourceTierScore = ({ candidate = {}, criticalSlot = false, providerReliability = {} }) => {
  const tier = String(candidate.source_tier || "free").toLowerCase();
  const tierIndex = SOURCE_TIER_PRIORITY.indexOf(tier);
  const tierWeight = tierIndex === -1 ? 0 : (SOURCE_TIER_PRIORITY.length - tierIndex) / SOURCE_TIER_PRIORITY.length;
  const provider = String(candidate.source || candidate.asset?.provider || "unknown").toLowerCase();
  const reliability = clamp(Number(providerReliability[provider] || 0.5), 0, 1);

  let score = criticalSlot
    ? (tierWeight * 0.45 + reliability * 0.55)
    : (tierWeight * 0.7 + reliability * 0.3);
  if (criticalSlot && (tier === "premium" || tier === "curated")) score += 0.15;
  if (criticalSlot && tier === "generated") score -= 0.35;
  if (criticalSlot && reliability < 0.35) score -= 0.2;
  return clamp(score, 0, 1);
};

const computeSourceTierPenalty = ({ candidate = {}, criticalSlot = false }) => {
  if (!criticalSlot) return 0;
  const tier = String(candidate.source_tier || "free").toLowerCase();
  const status = String(candidate.visual_truth_status || "uncertain").toLowerCase();
  const confidence = Number(candidate.editorial_confidence || candidate.confidence || 0);
  if (tier === "premium" || tier === "curated") return 0;
  if (tier === "free" && (status === "exact" || (status === "regional" && confidence >= 0.8))) return 0.15;
  if (tier === "free") return 0.55;
  return 0.8;
};

const computeRepairStatePenalty = (candidate = {}) => {
  const state = String(candidate.block_repair_state || "").toLowerCase();
  if (state === "blocked") return 1;
  if (state === "repair_required") return 0.65;
  if (state === "degraded") return 0.3;
  return 0;
};

const buildRejectedReasons = (components = {}) => {
  const reasons = [];
  if (components.blockMismatchPenalty >= 1) reasons.push("wrong_block");
  if (components.windowReusePenalty >= 1) reasons.push("reused_window");
  if (components.clipLibraryReusePenalty >= 1) reasons.push("reused_clip_library_id");
  if (components.assetReusePenalty >= 1) reasons.push("reused_asset");
  if (components.sourceReusePenalty >= 1) reasons.push("reused_source_url");
  if (components.signatureReusePenalty >= 0.5) reasons.push("repeated_visual_signature");
  if (components.genericAssetPenalty >= 0.6) reasons.push("generic_asset");
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
  slotRole = "",
  criticalSlot = false,
  providerReliability = {},
  microMoment = null,
  slotStartSec = 0,
  slotEndSec = 0,
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
    const hardRejection = shouldRejectAssetForScene({
      asset: candidate.asset || candidate,
      scene: block,
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
    const microNeedExactMatchScore = computeMicroNeedExactMatchScore({ candidate, microMoment });
    const microActionMatchScore = computeMicroActionMatchScore({ candidate, microMoment });
    const microTemporalPrecisionScore = computeMicroTemporalPrecisionScore({
      candidate,
      microMoment,
      slotStartSec,
      slotEndSec,
    });
    const microProofMissPenalty = (microMoment?.needs_visual_proof === true && microNeedExactMatchScore < 0.5) ? 1 : 0;
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
    const sourceTierScore = computeSourceTierScore({ candidate, criticalSlot, providerReliability });
    const sourceTierPenalty = computeSourceTierPenalty({ candidate, criticalSlot });
    const repairStatePenalty = computeRepairStatePenalty(candidate);
    const hardBlocked = Boolean(hardBoundaryBlockReason);
    const genericAssetPenalty = hardRejection.reason === "generic_visual_for_specific_intent"
      ? 1
      : Math.max(Number(evidence.generic_visual ? 1 : 0), computeGenericAssetPenalty({ block, candidate }));
    const forbiddenCategoryPenalty = clamp(Number(evidence.forbidden_category_penalty || 0), 0, 1);
    const metadataFallbackPenalty = weakMetadataEvidence && specificIntentRequiresStrongEvidence ? 1 : weakMetadataEvidence ? 0.35 : 0;
    const darkFramePenalty = computeDarkFramePenalty(candidate);
    const editorialContractPenalty = computeEditorialContractPenalty({
      candidate,
      isBoundaryFirstSlot,
      slotRole,
    });

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
      microNeedExactMatchScore * SCORE_WEIGHTS.microNeedExactMatchScore +
      microActionMatchScore * SCORE_WEIGHTS.microActionMatchScore +
      microTemporalPrecisionScore * SCORE_WEIGHTS.microTemporalPrecisionScore +
      sourceTierScore * 2.2 +
      hardBoundaryIntroBonus -
      forbiddenCategoryPenalty * SCORE_WEIGHTS.forbiddenCategoryPenalty -
      reuse.sourceReusePenalty * SCORE_WEIGHTS.sourceReusePenalty -
      reuse.assetReusePenalty * SCORE_WEIGHTS.assetReusePenalty -
      reuse.windowReusePenalty * SCORE_WEIGHTS.windowReusePenalty -
      reuse.clipLibraryReusePenalty * SCORE_WEIGHTS.clipLibraryReusePenalty -
      reuse.signatureReusePenalty * SCORE_WEIGHTS.signatureReusePenalty -
      reuse.blockSignaturePenalty * SCORE_WEIGHTS.blockSignaturePenalty -
      reuse.blockProviderPenalty * SCORE_WEIGHTS.blockProviderPenalty -
      reuse.blockLandmarkPenalty * SCORE_WEIGHTS.blockLandmarkPenalty -
      blockMismatchPenalty * SCORE_WEIGHTS.blockMismatchPenalty -
      genericAssetPenalty * SCORE_WEIGHTS.genericAssetPenalty -
      metadataFallbackPenalty * SCORE_WEIGHTS.metadataFallbackPenalty -
      darkFramePenalty * SCORE_WEIGHTS.darkFramePenalty -
      microProofMissPenalty * SCORE_WEIGHTS.microProofMissPenalty -
      sourceTierPenalty * 7 -
      repairStatePenalty * SCORE_WEIGHTS.repairStatePenalty -
      editorialContractPenalty * 12;

    const reasons = buildRejectedReasons({
      semanticScore: semantic.score,
      sourceReusePenalty: reuse.sourceReusePenalty,
      assetReusePenalty: reuse.assetReusePenalty,
      windowReusePenalty: reuse.windowReusePenalty,
      clipLibraryReusePenalty: reuse.clipLibraryReusePenalty,
      signatureReusePenalty: reuse.signatureReusePenalty,
      blockMismatchPenalty,
      genericAssetPenalty,
      metadataFallbackPenalty,
      forbiddenCategoryPenalty,
      darkFramePenalty,
    });
    if (hardBoundaryBlockReason) reasons.unshift(hardBoundaryBlockReason);
    if (hardRejection.reject && hardRejection.reason) reasons.unshift(hardRejection.reason);

    const finalScore = hardBlocked ? -9999 : rawScore;

    ranked.push({
      candidate,
      score: round3(finalScore),
      method: semantic.method,
      hard_blocked: hardBlocked,
      hard_blocked_reason: hardBoundaryBlockReason,
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
        microNeedExactMatchScore: round3(microNeedExactMatchScore),
        microActionMatchScore: round3(microActionMatchScore),
        microTemporalPrecisionScore: round3(microTemporalPrecisionScore),
        microProofMissPenalty: round3(microProofMissPenalty),
        forbiddenCategoryPenalty: round3(forbiddenCategoryPenalty),
        sourceReusePenalty: round3(reuse.sourceReusePenalty),
        assetReusePenalty: round3(reuse.assetReusePenalty),
        windowReusePenalty: round3(reuse.windowReusePenalty),
        clipLibraryReusePenalty: round3(reuse.clipLibraryReusePenalty),
        signatureReusePenalty: round3(reuse.signatureReusePenalty),
        blockSignaturePenalty: round3(reuse.blockSignaturePenalty),
        blockProviderPenalty: round3(reuse.blockProviderPenalty),
        blockLandmarkPenalty: round3(reuse.blockLandmarkPenalty),
        blockMismatchPenalty: round3(blockMismatchPenalty),
        genericAssetPenalty: round3(genericAssetPenalty),
        metadataFallbackPenalty: round3(metadataFallbackPenalty),
        darkFramePenalty: round3(darkFramePenalty),
        editorialContractPenalty: round3(editorialContractPenalty),
        hardBoundaryIntroBonus: round3(hardBoundaryIntroBonus),
        sourceTierScore: round3(sourceTierScore),
        sourceTierPenalty: round3(sourceTierPenalty),
        repairStatePenalty: round3(repairStatePenalty),
        reusePenalty: round3(reuse.total),
        detectedVisualCategories: evidence.detected_visual_categories,
        missingRequiredVisualEvidence: evidence.missing_required_visual_evidence,
        rejectionWarnings: hardRejection.warnings || [],
        visualEvidenceSource: candidate.visual_evidence_source || candidate.analysis_provider || "metadata_fallback",
      },
      selection_reason: hardBlocked
        ? `hard_boundary_blocked_${hardBoundaryBlockReason}`
        : hardRejection.reject
        ? `rejected_${hardRejection.reason}`
        : blockMismatchPenalty >= 1
        ? "blocked_wrong_block"
        : reasons.length
          ? `selected_despite_${reasons[0]}`
          : `best_${semantic.method}`,
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
  const reuseAssetKey = getCandidateReuseAssetKey(candidate);
  const blockKey = resolveBlockScopeId(block);

  usage.usedSourceUrls = usage.usedSourceUrls || new Map();
  usage.usedAssetIds = usage.usedAssetIds || new Map();
  usage.usedLocalPaths = usage.usedLocalPaths || new Map();
  usage.usedWindowIds = usage.usedWindowIds || new Map();
  usage.usedProviders = usage.usedProviders || new Map();
  usage.usedClipLibraryIds = usage.usedClipLibraryIds || new Map();
  usage.usedBlockAssetIds = usage.usedBlockAssetIds || new Map();
  usage.usedVisualSignatures = usage.usedVisualSignatures || new Map();
  usage.usedBlockVisualSignatures = usage.usedBlockVisualSignatures || new Map();
  usage.usedBlockProviders = usage.usedBlockProviders || new Map();
  usage.usedBlockLandmarks = usage.usedBlockLandmarks || new Map();
  usage.lastClipByAssetId = usage.lastClipByAssetId || new Map();

  if (sourceUrl) usage.usedSourceUrls.set(sourceUrl, (usage.usedSourceUrls.get(sourceUrl) || 0) + 1);
  if (localPath) usage.usedLocalPaths.set(localPath, (usage.usedLocalPaths.get(localPath) || 0) + 1);
  if (reuseAssetKey) {
    usage.usedAssetIds.set(reuseAssetKey, (usage.usedAssetIds.get(reuseAssetKey) || 0) + 1);
  }
  usage.usedWindowIds.set(candidate.id, (usage.usedWindowIds.get(candidate.id) || 0) + 1);
  usage.usedProviders.set(provider, (usage.usedProviders.get(provider) || 0) + 1);
  if (candidate.clip_library_id) {
    const clipLibraryId = String(candidate.clip_library_id || "");
    usage.usedClipLibraryIds.set(clipLibraryId, (usage.usedClipLibraryIds.get(clipLibraryId) || 0) + 1);
  }
  usage.usedVisualSignatures.set(signature, (usage.usedVisualSignatures.get(signature) || 0) + 1);
  if (blockKey) {
    if (reuseAssetKey) {
      const blockAssetKey = `${blockKey}:${reuseAssetKey}`;
      usage.usedBlockAssetIds.set(blockAssetKey, (usage.usedBlockAssetIds.get(blockAssetKey) || 0) + 1);
    }
    const signatureKey = `${blockKey}:${signature}`;
    usage.usedBlockVisualSignatures.set(signatureKey, (usage.usedBlockVisualSignatures.get(signatureKey) || 0) + 1);
    const providerKey = `${blockKey}:${String(provider).toLowerCase()}`;
    usage.usedBlockProviders.set(providerKey, (usage.usedBlockProviders.get(providerKey) || 0) + 1);
    const landmark = (candidate.landmarks || [])[0];
    const landmarkKey = normalizeLabel(`${landmark?.name || landmark || ""}|${landmark?.city || candidate.location?.city || ""}`);
    if (landmarkKey) {
      const blockLandmarkKey = `${blockKey}:${landmarkKey}`;
      usage.usedBlockLandmarks.set(blockLandmarkKey, (usage.usedBlockLandmarks.get(blockLandmarkKey) || 0) + 1);
    }
  }
  if (reuseAssetKey) {
    usage.lastClipByAssetId.set(reuseAssetKey, clipIndex);
  }
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
    computeSourceTierScore,
    computeSourceTierPenalty,
    computeRepairStatePenalty,
    computeGenericAssetPenalty,
    computeGastronomySpecificityScore,
    computeDarkFramePenalty,
    isWeakMetadataEvidence,
  },
};
