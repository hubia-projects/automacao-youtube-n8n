const path = require("path");
const fs = require("fs-extra");
const axios = require("axios");
const { config } = require("../config/env");
const { loadState, ensureVideoStructure, updateState } = require("./stateService");
const { sendWorkflowStatus } = require("./telegramService");
const { buildVisualPlan } = require("../utils/visualPlan");
const { createPlaceholderImage, extractVideoFrame, probeMedia, getResolutionLabel } = require("../utils/mediaUtils");
const { hasOpenAi, describeImagesWithOpenAI } = require("./openaiService");
const { getCachedAudioIntelligence } = require("./audioIntelligence");
const { enrichVisualPlan } = require("./narrativeBlockPlanner");
const { analyzeLocalVideo } = require("./localVideoUnderstandingService");
const { buildBlockQueryPlan } = require("./assetQueryPlanner");
const { scorePreDownloadCandidate } = require("./assetRejectionService");
const { summarizeAssetReadiness, shouldAllowPlaceholderAssets } = require("./assetReadinessService");
const { approveAssetsForVisualPlan } = require("./assetApprovalService");
const { evaluateCoverageGate, COVERAGE_STATUS } = require("./coverageGateService");
const { buildLocalRepairPlan, REPAIR_BLOCK_STATE } = require("./repairPlannerService");
const { buildBlockContentPackages, ECONOMIC_BUDGET_PROFILE } = require("./contentSlotPlannerService");
const { buildMicroVisualPlan } = require("./microMomentPlannerService");
const {
  computeReusePenalty,
  mergeApprovedWindowsIntoLibrary,
  readLibrary,
  summarizeLibrarySnapshot,
} = require("./assetLibraryService");
const { evaluateVisualEvidence } = require("./visualIntentService");
const { logger } = require("../utils/logger");

const hasPexels = () => Boolean(config.PEXELS_API_KEY);
const hasPixabay = () => Boolean(config.PIXABAY_API_KEY);

const MIN_WIDTH = 1280;
const MIN_HEIGHT = 720;
const PREFERRED_WIDTH = 1920;
const PREFERRED_HEIGHT = 1080;
const MAX_ASSETS_PER_SCENE = Math.max(3, Number(config.ASSET_DOWNLOAD_TOP_PER_SCENE || 6));
const MIN_VIDEO_DURATION_SECONDS = 5;
const PREFERRED_VIDEO_DURATION_SECONDS = 16;
const MAX_ANALYSIS_WINDOWS = config.SEMANTIC_SYNC_MODE === "high-quality" ? 10 : 6;
const ANALYSIS_WINDOW_SECONDS = config.SEMANTIC_SYNC_MODE === "high-quality" ? 3 : 4;
const ANALYSIS_STRIDE_SECONDS = config.SEMANTIC_SYNC_MODE === "high-quality" ? 1.5 : 2;
const SEARCH_RESULTS_PER_QUERY = Math.max(4, Number(config.ASSET_SEARCH_RESULTS_PER_QUERY || 12));
const ECONOMIC_BUDGET = {
  raw_candidates_per_block: Math.max(40, Math.min(120, Number(config.ASSET_RAW_CANDIDATES_PER_BLOCK || ECONOMIC_BUDGET_PROFILE.raw_candidates_per_block))),
  cheap_shortlist_per_block: Math.max(12, Math.min(30, Number(config.ASSET_CHEAP_SHORTLIST_PER_BLOCK || ECONOMIC_BUDGET_PROFILE.cheap_shortlist_per_block))),
  vision_finalists_per_block: Math.max(4, Math.min(12, Number(config.ASSET_VISION_FINALISTS_PER_BLOCK || ECONOMIC_BUDGET_PROFILE.vision_finalists_per_block))),
  max_repair_rounds_per_block: Math.max(0, Math.min(2, Number(config.ASSET_MAX_REPAIR_ROUNDS_PER_BLOCK || ECONOMIC_BUDGET_PROFILE.max_repair_rounds_per_block))),
};
const SCARCITY_BUDGET = {
  raw_candidates_per_block: Math.max(ECONOMIC_BUDGET.raw_candidates_per_block, Math.min(150, Number(config.ASSET_SCARCITY_RAW_CANDIDATES_PER_BLOCK || 120))),
  cheap_shortlist_per_block: Math.max(ECONOMIC_BUDGET.cheap_shortlist_per_block, Math.min(40, Number(config.ASSET_SCARCITY_CHEAP_SHORTLIST_PER_BLOCK || 30))),
  vision_finalists_per_block: Math.max(ECONOMIC_BUDGET.vision_finalists_per_block, Math.min(16, Number(config.ASSET_SCARCITY_VISION_FINALISTS_PER_BLOCK || 12))),
  max_repair_rounds_per_block: Math.max(ECONOMIC_BUDGET.max_repair_rounds_per_block, Math.min(2, Number(config.ASSET_MAX_REPAIR_ROUNDS_PER_BLOCK || 2))),
};
const CRITICAL_SLOT_MIN_PROVIDER_RELIABILITY = Number(config.CRITICAL_SLOT_MIN_PROVIDER_RELIABILITY || 0.45);
const CRITICAL_SLOT_PREFERRED_PROVIDER_RELIABILITY = Number(config.CRITICAL_SLOT_PREFERRED_PROVIDER_RELIABILITY || 0.6);

const unique = (values = []) => [...new Set(values.filter(Boolean))];
const normalizeTokenSafe = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const DIVERSITY_SCENE_FUNCTION_TO_QUERY = {
  proof: "authentic close up local food market vendor serving",
  human_action: "people eating local food market interaction",
  detail: "product detail close up handmade local food",
  context: "street level authentic neighborhood local life",
  transition: "neutral short transition local scene",
  payoff: "restaurant table tasting wine food celebration",
};

const DIVERSITY_SCENE_FUNCTION_TO_ROLE = {
  proof: "proof_exact",
  human_action: "detail_cutaway",
  detail: "detail_cutaway",
  context: "context_regional",
  transition: "bridge_neutral_short",
  payoff: "closing_payoff",
};

const round3 = (value) => Number(Number(value || 0).toFixed(3));

const normalizeSceneIndexes = (sceneIndexes = []) =>
  unique((Array.isArray(sceneIndexes) ? sceneIndexes : [sceneIndexes]).map((value) => Number(value || 0)).filter((value) => Number.isInteger(value) && value > 0))
    .sort((left, right) => left - right);

const getSceneScopedEntrySortKey = (entry = {}) =>
  entry.local_path || entry.query || entry.provider || (Array.isArray(entry.queries) ? entry.queries.join("|") : "");

const sortSceneScopedEntries = (entries = []) =>
  [...entries].sort((left, right) =>
    Number(left.scene_index || 0) - Number(right.scene_index || 0) ||
    String(getSceneScopedEntrySortKey(left)).localeCompare(String(getSceneScopedEntrySortKey(right)))
  );

const mergeSceneScopedEntries = ({ existingEntries = [], nextEntries = [], sceneIndexes = [] }) => {
  const targetSceneIndexes = new Set(normalizeSceneIndexes(sceneIndexes));
  if (!targetSceneIndexes.size) {
    return sortSceneScopedEntries(nextEntries);
  }

  return sortSceneScopedEntries([
    ...existingEntries.filter((entry) => !targetSceneIndexes.has(Number(entry.scene_index || 0))),
    ...nextEntries,
  ]);
};

const extractFallbackPlanSceneIndex = (line = "") => Number(String(line).match(/Cena\s+(\d+)/i)?.[1] || 0);

const mergeFallbackPlan = ({ existingFallbackPlan = [], nextFallbackPlan = [], sceneIndexes = [] }) => {
  const targetSceneIndexes = new Set(normalizeSceneIndexes(sceneIndexes));
  const preservedFallbackPlan = targetSceneIndexes.size
    ? existingFallbackPlan.filter((line) => !targetSceneIndexes.has(extractFallbackPlanSceneIndex(line)))
    : [];

  return [...preservedFallbackPlan, ...nextFallbackPlan].sort(
    (left, right) => extractFallbackPlanSceneIndex(left) - extractFallbackPlanSceneIndex(right)
  );
};

const getSceneSourceUrlSet = (items = [], sceneIndex = 0) =>
  new Set(
    items
      .filter((item) => Number(item.scene_index || 0) === Number(sceneIndex || 0))
      .map((item) => item.source_url)
      .filter((sourceUrl) => sourceUrl && sourceUrl !== "generated-local")
  );

const buildAutoRepairPlanByScene = ({ state = {}, selectedSceneIndexes = [] }) => {
  const selectedSet = new Set((selectedSceneIndexes || []).map((item) => Number(item || 0)).filter((item) => item > 0));
  const visualPlan = Array.isArray(state.visual_plan) ? state.visual_plan : [];
  const timeline = state.render_timeline || {};
  const timelineMetrics = timeline.micro_sync_metrics || timeline.timelineSyncMetrics || {};
  const timelineClips = Array.isArray(timeline.clips) ? timeline.clips : [];
  const rawGaps = [
    ...((state.render_timeline?.micro_sync_metrics?.micro_coverage_gaps || []).map((gap) => ({
      ...gap,
      scene_index: Number(gap.scene_index || 0),
      visual_need: String(gap.visual_need || ""),
    }))),
    ...((state.assets_json?.micro_coverage_gaps || []).map((gap) => ({
      ...gap,
      scene_index: Number(gap.scene_index || 0),
      visual_need: String(gap.visual_need || ""),
    }))),
  ].filter((gap) => gap.scene_index > 0 && gap.visual_need);

  const byScene = new Map();
  rawGaps.forEach((gap) => {
    if (selectedSet.size && !selectedSet.has(Number(gap.scene_index || 0))) return;
    const sceneIndex = Number(gap.scene_index || 0);
    const current = byScene.get(sceneIndex) || {
      scene_index: sceneIndex,
      target_narrative_roles: ["proof_exact", "detail_cutaway"],
      target_micro_needs: [],
      micro_repair_queries: [],
      extra_negative_keywords: ["skyline", "aerial", "bridge", "river", "generic street", "coast"],
      force_exact_required: true,
    };
    const need = String(gap.visual_need || "").trim();
    if (need) {
      current.target_micro_needs = unique([...(current.target_micro_needs || []), need]);
      current.micro_repair_queries = unique([
        ...(current.micro_repair_queries || []),
        `${need.replace(/_/g, " ")} authentic real action`,
      ]);
    }
    byScene.set(sceneIndex, current);
  });

  const clipsByIndex = new Map(
    timelineClips
      .map((clip) => [Number(clip.clip_index || 0), clip])
      .filter(([clipIndex]) => clipIndex > 0)
  );
  const hardBoundaryViolations = Array.isArray(state.render_validation?.hard_boundary_report?.violations)
    ? state.render_validation.hard_boundary_report.violations
    : [];
  hardBoundaryViolations.forEach((violation) => {
    const reasons = Array.isArray(violation.violations) ? violation.violations : [];
    const hasLocationFailure = reasons.includes("missing_location_on_first_clip") || reasons.includes("wrong_boundary_city");
    if (!hasLocationFailure) return;
    const clipIndex = Number(violation.first_clip_index || 0);
    const clip = clipsByIndex.get(clipIndex) || null;
    const sceneIndex = Number(clip?.scene_index || 0);
    if (!sceneIndex) return;
    if (selectedSet.size && !selectedSet.has(sceneIndex)) return;
    const expectedLocation = String(violation.expected_topic || "").trim();
    if (!expectedLocation) return;
    const current = byScene.get(sceneIndex) || {
      scene_index: sceneIndex,
      target_narrative_roles: [],
      target_micro_needs: [],
      micro_repair_queries: [],
      diversity_repair_queries: [],
      extra_negative_keywords: [],
      force_exact_required: false,
    };
    byScene.set(sceneIndex, {
      ...current,
      target_narrative_roles: unique([...(current.target_narrative_roles || []), "opening_establishing", "proof_exact"]),
      micro_repair_queries: unique([
        ...(current.micro_repair_queries || []),
        `${expectedLocation} street level authentic local scene`,
        `${expectedLocation} market real people local food`,
      ]),
      diversity_repair_queries: unique([
        ...(current.diversity_repair_queries || []),
        `${expectedLocation} local landmark with people`,
      ]),
      extra_negative_keywords: unique([
        ...(current.extra_negative_keywords || []),
        "generic skyline",
        "aerial only",
        "timelapse city",
      ]),
      boundary_expected_location: expectedLocation,
      require_location_match: true,
      force_exact_required: true,
    });
  });

  const lowDiversityBlocks = new Set((timelineMetrics.low_diversity_blocks || []).map((item) => String(item || "").trim()).filter(Boolean));
  const diversityBlocks = Array.isArray(timelineMetrics.diversity_blocks) ? timelineMetrics.diversity_blocks : [];
  const scenesByBlockId = new Map();
  (visualPlan || []).forEach((scene) => {
    const blockId = String(scene.block_id || `scene_${Number(scene.scene_index || 0)}`).trim();
    const scenes = scenesByBlockId.get(blockId) || [];
    scenes.push(Number(scene.scene_index || 0));
    scenesByBlockId.set(blockId, scenes);
  });

  const relevantLowDiversityBlocks = diversityBlocks.filter((entry) =>
    lowDiversityBlocks.has(String(entry.block_id || "").trim())
  );
  relevantLowDiversityBlocks.forEach((entry) => {
    const blockId = String(entry.block_id || "").trim();
    const sceneIndexes = scenesByBlockId.get(blockId) || [];
    const missingFunctions = (entry.missing_scene_functions || []).map((item) => normalizeTokenSafe(item)).filter(Boolean);
    const repeatedFamilies = {};
    timelineClips
      .filter((clip) => String(clip.block_id || "").trim() === blockId)
      .forEach((clip) => {
        const family = String(clip.visual_family || "").trim();
        if (!family) return;
        repeatedFamilies[family] = Number(repeatedFamilies[family] || 0) + 1;
      });
    const avoidVisualFamilies = Object.entries(repeatedFamilies)
      .filter(([, count]) => Number(count || 0) >= 2)
      .map(([family]) => family);

    sceneIndexes.forEach((sceneIndex) => {
      const numericSceneIndex = Number(sceneIndex || 0);
      if (!numericSceneIndex) return;
      if (selectedSet.size && !selectedSet.has(numericSceneIndex)) return;
      const sceneClips = timelineClips.filter((clip) => Number(clip.scene_index || 0) === numericSceneIndex);
      const current = byScene.get(numericSceneIndex) || {
        scene_index: numericSceneIndex,
        target_narrative_roles: [],
        target_micro_needs: [],
        micro_repair_queries: [],
        diversity_repair_queries: [],
        avoid_source_urls: [],
        avoid_asset_ids: [],
        avoid_visual_families: [],
        extra_negative_keywords: [],
        force_exact_required: false,
      };

      const diversityQueries = missingFunctions
        .map((sceneFunction) => DIVERSITY_SCENE_FUNCTION_TO_QUERY[sceneFunction] || "")
        .filter(Boolean);
      const roleTargets = missingFunctions
        .map((sceneFunction) => DIVERSITY_SCENE_FUNCTION_TO_ROLE[sceneFunction] || "")
        .filter(Boolean);
      const repeatedFamilyTokens = avoidVisualFamilies
        .map((family) => String(family).split("|")[0])
        .map((token) => normalizeTokenSafe(token))
        .filter(Boolean);

      byScene.set(numericSceneIndex, {
        ...current,
        target_narrative_roles: unique([...(current.target_narrative_roles || []), ...roleTargets, "proof_exact", "detail_cutaway"]),
        diversity_repair_queries: unique([...(current.diversity_repair_queries || []), ...diversityQueries]),
        micro_repair_queries: unique([...(current.micro_repair_queries || []), ...diversityQueries]),
        avoid_source_urls: unique([
          ...(current.avoid_source_urls || []),
          ...sceneClips.map((clip) => clip.source_url).filter(Boolean),
        ]),
        avoid_asset_ids: unique([
          ...(current.avoid_asset_ids || []),
          ...sceneClips.map((clip) => clip.asset_id).filter(Boolean),
        ]),
        avoid_visual_families: unique([...(current.avoid_visual_families || []), ...avoidVisualFamilies]),
        extra_negative_keywords: unique([
          ...(current.extra_negative_keywords || []),
          ...repeatedFamilyTokens,
          "same angle",
          "same landmark",
          "duplicate visual style",
        ]),
        force_exact_required: true,
      });
    });
  });

  return [...byScene.values()];
};

const resolveAdaptiveBudgetProfile = ({ blockPackage = {}, repairHints = {} } = {}) => {
  const needsScarcityBudget = Boolean(
    repairHints.force_exact_required
    || (repairHints.target_micro_needs || []).length
    || (repairHints.diversity_repair_queries || []).length
    || (repairHints.avoid_visual_families || []).length
    || (blockPackage.slots_required || []).some((slot) =>
      slot.requires_visual_proof === true && ["high", "critical"].includes(String(slot.criticality || "").toLowerCase())
    )
  );
  return {
    ...(blockPackage.budget_profile || ECONOMIC_BUDGET),
    ...(needsScarcityBudget ? SCARCITY_BUDGET : {}),
  };
};

const shouldSkipCandidateByRepairConstraints = ({ candidate = {}, repairHints = {} }) => {
  const sourceUrl = String(candidate.source_url || "").trim();
  if (!sourceUrl) return false;
  const blockedUrls = new Set((repairHints.avoid_source_urls || []).map((item) => String(item || "").trim()).filter(Boolean));
  return blockedUrls.has(sourceUrl);
};

const slugify = (value = "") =>
  String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

const isHorizontal = ({ width = 0, height = 0 }) => width >= MIN_WIDTH && height >= MIN_HEIGHT && width >= height;

const resolutionScore = ({ width = 0, height = 0, assetType = "image" }) => {
  const area = width * height;
  const preferredBonus = width >= PREFERRED_WIDTH && height >= PREFERRED_HEIGHT ? 1_500_000 : 0;
  const videoBonus = assetType === "video" ? 250_000 : 0;
  return area + preferredBonus + videoBonus;
};

const getCandidateDuration = (candidate = {}) => Number(candidate.duration_estimate || 0);

const isVideoCandidate = (candidate = {}) => candidate.asset_type === "video" || candidate.type === "video";

const candidateMotionScore = (candidate = {}) => {
  const baseScore = resolutionScore({
    width: Number(candidate.width || 0),
    height: Number(candidate.height || 0),
    assetType: candidate.asset_type || candidate.type || "image",
  });
  const relevanceBonus = Number(candidate.search_relevance_score || 0);

  if (!isVideoCandidate(candidate)) {
    return baseScore + relevanceBonus;
  }

  const duration = getCandidateDuration(candidate);
  const durationBonus = Math.min(duration, 45) * 220_000;
  const longFormBonus = duration >= PREFERRED_VIDEO_DURATION_SECONDS ? 6_000_000 : duration >= MIN_VIDEO_DURATION_SECONDS ? 4_000_000 : 1_500_000;
  return baseScore + durationBonus + longFormBonus + relevanceBonus;
};

const sortCandidatesForMotion = (candidates = []) =>
  [...candidates].sort((left, right) => candidateMotionScore(right) - candidateMotionScore(left));

const dedupeCandidatesByUrl = (candidates = []) => {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate?.source_url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const partitionSceneCandidates = (candidates = []) => {
  const longVideos = [];
  const shortVideos = [];
  const images = [];

  candidates.forEach((candidate) => {
    if (isVideoCandidate(candidate)) {
      if (getCandidateDuration(candidate) >= MIN_VIDEO_DURATION_SECONDS) {
        longVideos.push(candidate);
      } else {
        shortVideos.push(candidate);
      }
      return;
    }

    images.push(candidate);
  });

  return {
    longVideos: sortCandidatesForMotion(longVideos),
    shortVideos: sortCandidatesForMotion(shortVideos),
    images: images.sort((left, right) => resolutionScore(right) - resolutionScore(left)),
  };
};

const extractKeywords = (text = "", limit = 8) => {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4);

  const stopwords = new Set([
    "sobre",
    "entre",
    "porque",
    "quando",
    "como",
    "neste",
    "neste",
    "vídeo",
    "você",
    "para",
    "com",
    "mais",
    "menos",
  ]);

  const freq = new Map();
  words.forEach((word) => {
    if (stopwords.has(word)) return;
    freq.set(word, (freq.get(word) || 0) + 1);
  });

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
};

const normalizeToken = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const matchesNegativeKeyword = ({ candidate = {}, negativeKeywords = [] }) => {
  if (!Array.isArray(negativeKeywords) || !negativeKeywords.length) return false;
  const candidateText = normalizeToken([
    candidate.query,
    candidate.semantic_text,
    candidate.provider_title,
    ...(candidate.provider_tags || []),
  ].filter(Boolean).join(" "));
  return negativeKeywords.some((keyword) => {
    const token = normalizeToken(keyword);
    return token && candidateText.includes(token);
  });
};

const getBlockIdForScene = (scene = {}) => String(scene.block_id || `scene_${Number(scene.scene_index || 0)}`);

const buildScenesByBlockId = (visualPlan = []) => {
  const map = new Map();
  (visualPlan || []).forEach((scene) => {
    const blockId = getBlockIdForScene(scene);
    const scenes = map.get(blockId) || [];
    scenes.push(scene);
    map.set(blockId, scenes);
  });
  return map;
};

const getRepresentativeSceneForBlock = (scenes = []) => {
  const ordered = [...(scenes || [])].sort((a, b) => Number(a.scene_order || a.scene_index || 0) - Number(b.scene_order || b.scene_index || 0));
  return ordered.find((scene) => ["proof", "detail"].includes(String(scene.narrative_function || "").toLowerCase()))
    || ordered[0]
    || {};
};

const scoreCandidateForSlot = ({ candidate = {}, slot = {}, scene = {}, libraryUsage = {}, blockId = "" }) => {
  const preScore = Number(candidate.pre_download_score || 0);
  const querySlotBoost = normalizeToken(candidate.slot_type || "") === normalizeToken(slot.slot_type || "") ? 1.2 : 0;
  const proofBoost = slot.requires_visual_proof === true ? (candidate.intent_match ? 1 : -0.6) : 0.2;
  const reusePenalty = computeReusePenalty({
    candidate: libraryUsage[candidate.source_url] || {},
    blockId,
    usedAssetIds: libraryUsage.usedAssetIds || new Set(),
  });
  const genericPenalty = candidate.generic_asset === true && slot.requires_visual_proof === true ? 1.4 : 0;
  const queryPriorityBoost = Number(candidate.slot_priority || 0) * 0.15;
  const sceneRoleBoost = (slot.target_roles || []).includes(scene.probable_shot_role) ? 0.5 : 0;
  const providerReliability = Number(candidate.provider_reliability_score || 0.5);
  const providerReliabilityBoost = slot.requires_visual_proof === true
    ? providerReliability * (["high", "critical"].includes(String(slot.criticality || "").toLowerCase()) ? 1.1 : 0.7)
    : providerReliability * 0.35;
  const slotPerfAvg = Number(libraryUsage[candidate.source_url]?.slot_performance?.[String(slot.slot_type || "").toLowerCase()]?.avg || 0.5);
  const slotPerfBoost = slotPerfAvg * 0.45;
  return Number((
    preScore
    + querySlotBoost
    + proofBoost
    + queryPriorityBoost
    + sceneRoleBoost
    + providerReliabilityBoost
    + slotPerfBoost
    - reusePenalty
    - genericPenalty
  ).toFixed(3));
};

const filterSlotCandidatesByProviderPolicy = ({ candidates = [], slot = {}, minProviderReliability = CRITICAL_SLOT_MIN_PROVIDER_RELIABILITY }) => {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const criticalSlot = slot.requires_visual_proof === true && ["high", "critical"].includes(String(slot.criticality || "").toLowerCase());
  if (!criticalSlot) return candidates;
  const strong = candidates.filter((candidate) => Number(candidate.provider_reliability_score || 0.5) >= Number(minProviderReliability || CRITICAL_SLOT_MIN_PROVIDER_RELIABILITY));
  if (strong.length >= Math.max(1, Number(slot.min_count || 1))) return strong;
  return [...candidates].sort((left, right) => Number(right.provider_reliability_score || 0.5) - Number(left.provider_reliability_score || 0.5));
};

const selectSlotFinalists = ({
  slot = {},
  candidates = [],
  scene = {},
  blockId = "",
  budgetProfile = ECONOMIC_BUDGET,
  libraryUsage = {},
}) => {
  const maxBySlot = Math.max(Number(slot.min_count || 1), Math.min(3, Number(slot.max_count || 2)));
  const filteredByProviderPolicy = filterSlotCandidatesByProviderPolicy({
    candidates,
    slot,
    minProviderReliability: CRITICAL_SLOT_MIN_PROVIDER_RELIABILITY,
  });
  const ranked = [...(filteredByProviderPolicy || [])]
    .map((candidate) => ({
      ...candidate,
      _slot_score: scoreCandidateForSlot({ candidate, slot, scene, blockId, libraryUsage }),
    }))
    .sort((left, right) => Number(right._slot_score || 0) - Number(left._slot_score || 0));

  return ranked.slice(0, maxBySlot).slice(0, Number(budgetProfile.vision_finalists_per_block || ECONOMIC_BUDGET.vision_finalists_per_block));
};

const mapLibraryBySourceUrl = (library = {}) => {
  const index = {};
  (library.assets || []).forEach((entry) => {
    if (!entry?.source_url) return;
    index[entry.source_url] = entry;
  });
  return index;
};

const buildWindowFamilyKey = (window = {}) => {
  const categories = window.visual_observation?.detected_visual_categories || window.detected_visual_categories || [];
  const landmarks = (window.visual_observation?.landmarks || window.landmarks || []).map((entry) => entry?.name || entry).filter(Boolean);
  const location = window.window?.location?.city || window.location?.city || "";
  return unique([location, ...categories, ...landmarks].map((value) => normalizeToken(value))).filter(Boolean).slice(0, 3).join("|");
};

const buildLibraryCandidatePoolForBlock = ({
  library = {},
  blockPackage = {},
  representativeScene = {},
  negativeKeywords = [],
  limit = 20,
}) => {
  const intent = normalizeToken(blockPackage.intent || representativeScene.visual_intent || "");
  const city = normalizeToken(representativeScene.expected_location || representativeScene.location?.city || "");
  const requiredSlotTypes = new Set((blockPackage.slots_required || []).map((slot) => String(slot.slot_type || "").toLowerCase()));
  const sortedEntries = (library.assets || [])
    .filter((entry) => entry?.source_url)
    .filter((entry) => entry.reuse_allowed !== false)
    .filter((entry) => !matchesNegativeKeyword({
      candidate: {
        query: [entry.visual_family, ...(entry.slot_types_supported || []), ...(entry.intents || [])].join(" "),
        semantic_text: entry.visual_family || "",
        provider_title: entry.source || "",
        provider_tags: [...(entry.slot_types_supported || []), ...(entry.cities || [])],
      },
      negativeKeywords,
    }))
    .sort((left, right) =>
      Number(right.quality_score || 0) - Number(left.quality_score || 0)
      || Number(left.usage_count || 0) - Number(right.usage_count || 0)
    );

  const isIntentMatch = (entry = {}) => {
    if (!intent) return true;
    const intents = (entry.intents || []).map((value) => normalizeToken(value));
    return intents.includes(intent) || intents.some((value) => value.includes(intent) || intent.includes(value));
  };
  const isCityMatch = (entry = {}) => {
    if (!city) return true;
    const cities = (entry.cities || []).map((value) => normalizeToken(value));
    return !cities.length || cities.includes(city);
  };
  const isSlotMatch = (entry = {}) => {
    if (!requiredSlotTypes.size) return true;
    const slots = (entry.slot_types_supported || []).map((value) => String(value || "").toLowerCase());
    return slots.some((slot) => requiredSlotTypes.has(slot));
  };

  const strict = sortedEntries.filter((entry) => isIntentMatch(entry) && isCityMatch(entry) && isSlotMatch(entry));
  const relaxedGeo = sortedEntries.filter((entry) => isIntentMatch(entry) && isSlotMatch(entry));
  const relaxedIntent = sortedEntries.filter((entry) => isCityMatch(entry) && isSlotMatch(entry));
  const slotOnly = sortedEntries.filter((entry) => isSlotMatch(entry));
  const broad = sortedEntries.filter((entry) => isIntentMatch(entry) || isCityMatch(entry));

  const entries = dedupeCandidatesByUrl([
    ...strict.map((entry) => ({ source_url: entry.source_url, entry, library_match_tier: "strict" })),
    ...relaxedGeo.map((entry) => ({ source_url: entry.source_url, entry, library_match_tier: "relaxed_geo" })),
    ...relaxedIntent.map((entry) => ({ source_url: entry.source_url, entry, library_match_tier: "relaxed_intent" })),
    ...slotOnly.map((entry) => ({ source_url: entry.source_url, entry, library_match_tier: "slot_only" })),
    ...broad.map((entry) => ({ source_url: entry.source_url, entry, library_match_tier: "broad" })),
  ]).map((wrapped) => wrapped.entry ? ({ ...wrapped.entry, library_match_tier: wrapped.library_match_tier }) : wrapped)
    .slice(0, Math.max(0, limit));

  return entries.map((entry) => ({
    provider: entry.source || "library",
    asset_type: "video",
    type: "video",
    query: `${representativeScene.location?.city || representativeScene.block_label || ""} ${(entry.slot_types_supported || [])[0] || "authentic scene"}`.trim(),
    semantic_text: entry.visual_family || "library asset",
    provider_tags: [...(entry.slot_types_supported || []), ...(entry.cities || [])],
    source_url: entry.source_url,
    width: 1920,
    height: 1080,
    duration_estimate: 10,
    from_library: true,
    library_quality_score: Number(entry.quality_score || 0),
    library_usage_count: Number(entry.usage_count || 0),
    library_last_used_at: entry.last_used_at || "",
    source_tier: entry.source_tier || "free",
    library_slots_supported: entry.slot_types_supported || [],
    library_intents: entry.intents || [],
    library_cities: entry.cities || [],
    library_match_tier: entry.library_match_tier || "strict",
  }));
};

const readLocalCuratedAssetIndex = async () => {
  const indexPath = String(config.LOCAL_CURATED_ASSET_INDEX || "").trim();
  if (!indexPath || !(await fs.pathExists(indexPath))) return [];
  const parsed = await fs.readJson(indexPath).catch(() => null);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.assets)) return parsed.assets;
  return [];
};

const resolveLocalCuratedPath = (entry = {}) => {
  const rawPath = String(entry.local_path || entry.path || "").trim();
  if (!rawPath) return "";
  return path.isAbsolute(rawPath) ? rawPath : path.join(config.LOCAL_CURATED_ASSETS_DIR, rawPath);
};

const buildLocalCuratedCandidatesFromIndex = ({ entries = [], query = "", limit = SEARCH_RESULTS_PER_QUERY } = {}) => {
  const queryTerms = normalizeTokenSafe(query)
    .split(/\s+/)
    .filter((term) => term.length >= 3);
  const scored = (entries || [])
    .map((entry) => {
      const localPath = resolveLocalCuratedPath(entry);
      const text = normalizeTokenSafe([
        entry.title,
        entry.semantic_text,
        entry.visual_family,
        ...(entry.tags || []),
        ...(entry.slot_types_supported || []),
        ...(entry.intents || []),
        ...(entry.cities || []),
        ...(entry.countries || []),
      ].filter(Boolean).join(" "));
      const hits = queryTerms.filter((term) => text.includes(term)).length;
      const slotBoost = (entry.slot_types_supported || []).length ? 1 : 0;
      const quality = Number(entry.quality_score || 0.7);
      return {
        entry,
        localPath,
        score: (hits * 2) + slotBoost + quality,
      };
    })
    .filter((row) => row.localPath || row.entry.source_url)
    .filter((row) => !queryTerms.length || row.score > 0.5)
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .slice(0, Math.max(0, Number(limit || SEARCH_RESULTS_PER_QUERY)));

  return scored.map(({ entry, localPath, score }) => ({
    provider: "local_curated",
    asset_type: /\.(jpg|jpeg|png|webp)$/i.test(localPath || entry.source_url || "") ? "image" : "video",
    type: /\.(jpg|jpeg|png|webp)$/i.test(localPath || entry.source_url || "") ? "image" : "video",
    query,
    semantic_text: entry.semantic_text || entry.visual_family || String((entry.slot_types_supported || [])[0] || query),
    provider_tags: unique([...(entry.tags || []), ...(entry.slot_types_supported || []), ...(entry.cities || [])]),
    provider_title: entry.title || entry.asset_id || "local curated asset",
    source_url: entry.source_url || `local_curated://${entry.asset_id || path.basename(localPath)}`,
    local_path: localPath,
    width: Number(entry.width || entry.resolution?.width || PREFERRED_WIDTH),
    height: Number(entry.height || entry.resolution?.height || PREFERRED_HEIGHT),
    duration_estimate: Number(entry.duration_seconds || entry.duration_estimate || PREFERRED_VIDEO_DURATION_SECONDS),
    source_tier: "curated",
    curated_asset: true,
    slot_type: (entry.slot_types_supported || [])[0] || "",
    library_slots_supported: entry.slot_types_supported || [],
    provider_reliability_score: 0.9,
    pre_download_score: Number(score || 0),
  }));
};

const selectCoverageFirstFinalists = ({
  shortlist = [],
  blockPackage = {},
  limit = 8,
}) => {
  const bySlotId = new Map();
  (shortlist || []).forEach((candidate) => {
    const key = String(candidate.slot_id || candidate.slot_type || "unslotted");
    const bucket = bySlotId.get(key) || [];
    bucket.push(candidate);
    bySlotId.set(key, bucket);
  });
  bySlotId.forEach((bucket, key) => {
    bySlotId.set(
      key,
      bucket.sort((left, right) =>
        Number(right._slot_score || right.pre_download_score || 0) - Number(left._slot_score || left.pre_download_score || 0)
      )
    );
  });

  const selected = [];
  const seenUrls = new Set();
  const providerCounts = new Map();
  const distinctProviders = new Set((shortlist || []).map((candidate) => String(candidate.provider || "unknown").toLowerCase()));
  const baseProviderCap = Math.max(1, Number(config.ASSET_PROVIDER_MAX_PER_BLOCK || 3));
  const relaxedProviderCap = Math.max(baseProviderCap, Number(config.ASSET_PROVIDER_MAX_PER_BLOCK_RELAXED || 8));
  const lowSupplyMode = (shortlist || []).length <= (limit * 2) || distinctProviders.size <= 2;
  const providerCap = lowSupplyMode ? Math.max(relaxedProviderCap, limit) : baseProviderCap;
  const pushCandidate = (candidate) => {
    if (!candidate?.source_url) return false;
    if (seenUrls.has(candidate.source_url)) return false;
    const provider = String(candidate.provider || "unknown").toLowerCase();
    const providerCount = Number(providerCounts.get(provider) || 0);
    if (providerCount >= providerCap) return false;
    selected.push(candidate);
    seenUrls.add(candidate.source_url);
    providerCounts.set(provider, providerCount + 1);
    return true;
  };

  (blockPackage.slots_required || []).forEach((slot) => {
    const key = String(slot.slot_id || slot.slot_type || "");
    const bucket = bySlotId.get(key) || bySlotId.get(String(slot.slot_type || "")) || [];
    const needed = Math.max(1, Number(slot.min_count || 1));
    let added = 0;
    for (const candidate of bucket) {
      if (added >= needed) break;
      if (selected.length >= limit) break;
      if (pushCandidate(candidate)) added += 1;
    }
  });

  const remainder = [...(shortlist || [])]
    .sort((left, right) =>
      Number(right._slot_score || right.pre_download_score || 0) - Number(left._slot_score || left.pre_download_score || 0)
    );
  for (const candidate of remainder) {
    if (selected.length >= limit) break;
    pushCandidate(candidate);
  }
  return selected.slice(0, limit);
};

const computeMissingRequiredSlots = ({ slotsRequired = [], candidates = [] }) => {
  const slotCounts = {};
  (candidates || []).forEach((candidate) => {
    const key = String(candidate.slot_id || candidate.slot_type || "unknown");
    slotCounts[key] = Number(slotCounts[key] || 0) + 1;
  });
  return (slotsRequired || []).filter((slot) =>
    Number(slotCounts[String(slot.slot_id || slot.slot_type)] || 0) < Number(slot.min_count || 1)
  );
};

const buildAnalysisWindowBlueprints = ({ assetDuration = 0 }) => {
  const safeDuration = Math.max(0.5, Number(assetDuration || 0));
  const windowSeconds = Math.min(ANALYSIS_WINDOW_SECONDS, safeDuration);
  const strideSeconds = Math.min(ANALYSIS_STRIDE_SECONDS, Math.max(0.5, windowSeconds * 0.75));
  const starts = [];

  for (let start = 0; start < safeDuration - 0.25; start += strideSeconds) {
    starts.push(round3(Math.min(start, Math.max(0, safeDuration - windowSeconds))));
    if (start + windowSeconds >= safeDuration) break;
  }

  if (!starts.length) starts.push(0);
  const uniqueStarts = unique(starts);
  const selectedStarts = uniqueStarts.length <= MAX_ANALYSIS_WINDOWS
    ? uniqueStarts
    : Array.from({ length: MAX_ANALYSIS_WINDOWS }, (_, index) => {
        const sourceIndex = Math.round((index * (uniqueStarts.length - 1)) / Math.max(1, MAX_ANALYSIS_WINDOWS - 1));
        return uniqueStarts[sourceIndex];
      });

  return unique(selectedStarts).map((startSeconds, index) => {
    const endSeconds = round3(Math.min(safeDuration, startSeconds + windowSeconds));
    const sampleTimeSeconds = round3(Math.min(safeDuration - 0.1, startSeconds + Math.max(0.1, (endSeconds - startSeconds) / 2)));

    return {
      window_index: index + 1,
      start_seconds: round3(startSeconds),
      end_seconds: Math.max(round3(startSeconds + 0.5), endSeconds),
      sample_time_seconds: sampleTimeSeconds,
      overlap_strategy: "short_window_stride",
    };
  });
};

const buildFallbackAnalysisPayload = ({ asset, scene }) => {
  const baseSummary = "visual evidence unavailable - weak fallback";
  const baseTags = [];
  const windows = buildAnalysisWindowBlueprints({ assetDuration: asset.source_duration_seconds || asset.duration_estimate || 0 }).map((window) => {
    const baseWindow = {
      window_index: window.window_index,
      start_seconds: window.start_seconds,
      end_seconds: window.end_seconds,
      sample_time_seconds: window.sample_time_seconds,
      description: baseSummary,
      summary: baseSummary,
      tags: baseTags,
      location: {
        city: "",
        country: "",
        confidence: 0,
      },
      landmarks: [],
      location_type: "",
      visual_features: {
        shot_type: "unknown",
        camera_motion: "unknown",
        dominant_colors: [],
        has_people: false,
        has_water: false,
        has_architecture: false,
      },
      quality: {
        sharpness: 0.7,
        stability: 0.7,
        brightness: 0.7,
        usable: true,
      },
      confidence: 0.35,
      method: "metadata_fallback",
      visual_evidence_source: "metadata_fallback",
      visual_observation_origin: "weak_fallback",
    };
    const evidence = evaluateVisualEvidence({ scene, window: baseWindow, asset });
    return {
      ...baseWindow,
      detected_visual_categories: evidence.detected_visual_categories,
      detected_objects: [],
      visual_intent_match: evidence.visual_intent_match,
      generic_visual: evidence.generic_visual,
      required_evidence_found: evidence.required_evidence_found,
      missing_required_visual_evidence: evidence.missing_required_visual_evidence,
    };
  });

  return {
    semantic_text: baseSummary,
    analysis_summary: baseSummary,
    analysis_tags: baseTags,
    analysis_windows: windows,
    analysis_provider: "metadata_fallback",
    analysis_window_seconds: ANALYSIS_WINDOW_SECONDS,
  };
};

const mergeAnalysisPayload = ({ asset, scene, payload = {} }) => {
  const fallback = buildFallbackAnalysisPayload({ asset, scene });
  const analysisWindows = Array.isArray(payload.analysis_windows) && payload.analysis_windows.length
    ? payload.analysis_windows.map((window) => {
        const evidence = evaluateVisualEvidence({ scene, window, asset });
        return {
          ...window,
          detected_visual_categories: window.detected_visual_categories || evidence.detected_visual_categories,
          detected_objects: window.detected_objects || [],
          visual_intent_match: typeof window.visual_intent_match === "boolean" ? window.visual_intent_match : evidence.visual_intent_match,
          generic_visual: typeof window.generic_visual === "boolean" ? window.generic_visual : evidence.generic_visual,
          required_evidence_found: window.required_evidence_found || evidence.required_evidence_found,
          missing_required_visual_evidence: window.missing_required_visual_evidence || evidence.missing_required_visual_evidence,
          visual_evidence_source: window.visual_evidence_source || payload.analysis_provider || payload.provider || fallback.analysis_provider,
          visual_observation_origin: window.visual_observation_origin || (String(window.visual_evidence_source || payload.analysis_provider || payload.provider || fallback.analysis_provider).toLowerCase().includes("fallback") ? "weak_fallback" : "real_vision"),
        };
      })
    : fallback.analysis_windows;
  return {
    ...fallback,
    ...payload,
    semantic_text: payload.semantic_text || payload.analysis_summary || fallback.semantic_text,
    analysis_summary: payload.analysis_summary || payload.semantic_text || fallback.analysis_summary,
    analysis_tags: unique([...(payload.analysis_tags || []), ...(fallback.analysis_tags || [])]).slice(0, 16),
    analysis_windows: analysisWindows,
    analysis_provider: payload.analysis_provider || payload.provider || fallback.analysis_provider,
    analysis_window_seconds: Number(payload.analysis_window_seconds || fallback.analysis_window_seconds || ANALYSIS_WINDOW_SECONDS),
  };
};

const buildAssetAnalysisPrompt = ({ scene, asset, windowBlueprints }) => `Analise os frames em ordem. Cada frame representa uma janela diferente do mesmo video de viagem.

Contexto da cena esperada:
- titulo: ${scene.title || ""}
- trecho narrado: ${scene.narration_excerpt || ""}
- keywords: ${(scene.keywords || []).join(", ")}
- query do asset: ${asset.query || ""}

Regras:
- descreva apenas o que esta visivel
- nao invente cidade, pais ou ponto turistico sem evidencia visual clara
- priorize elementos concretos como telhados, rua estreita, bonde, ponte, rio, castelo, mata, praia, falesia, mercado, comida, pessoas caminhando, panorama urbano
- se o frame for generico, diga que e generico
- se reconhecer cidade ou landmark, informe com confianca; se nao reconhecer, deixe vazio

Retorne JSON estrito no formato:
{
  "overall_summary": "",
  "overall_tags": [""],
  "windows": [
    {
      "frame_index": 1,
      "summary": "",
      "tags": [""],
      "location": {"city": "", "country": "", "confidence": 0.0},
      "landmarks": [{"name": "", "confidence": 0.0}],
      "location_type": "",
      "visual_features": {
        "shot_type": "wide|medium|detail|aerial|unknown",
        "camera_motion": "static|pan|tilt|drone|tracking|unknown",
        "dominant_colors": [""],
        "has_people": false,
        "has_water": false,
        "has_architecture": false
      },
      "quality": {"sharpness": 0.0, "stability": 0.0, "brightness": 0.0, "usable": true},
      "confidence": 0.0
    }
  ]
}

Os frames enviados correspondem a ${windowBlueprints.map((window) => `frame ${window.window_index} = ${window.start_seconds}s ate ${window.end_seconds}s`).join("; ")}.`;

const normalizeAssetAnalysisResponse = ({ response, asset, scene, windowBlueprints }) => {
  const responseWindows = Array.isArray(response?.windows) ? response.windows : [];
  const fallback = buildFallbackAnalysisPayload({ asset, scene });

  const analysisWindows = windowBlueprints.map((windowBlueprint, index) => {
    const responseWindow = responseWindows.find((item) => Number(item.frame_index || item.window_index) === windowBlueprint.window_index) || responseWindows[index] || {};
    const summary = responseWindow.summary || responseWindow.description || fallback.analysis_windows[index]?.summary || fallback.analysis_summary;
    const tags = unique([
      ...(Array.isArray(responseWindow.tags) ? responseWindow.tags : []),
      ...(fallback.analysis_windows[index]?.tags || []),
    ]).slice(0, 12);
    const location = responseWindow.location && typeof responseWindow.location === "object"
      ? {
          city: responseWindow.location.city || "",
          country: responseWindow.location.country || "",
          confidence: Math.max(0, Math.min(1, Number(responseWindow.location.confidence || 0))),
        }
      : fallback.analysis_windows[index]?.location;
    const landmarks = Array.isArray(responseWindow.landmarks)
      ? responseWindow.landmarks
          .map((landmark) => ({
            name: landmark?.name || "",
            confidence: Math.max(0, Math.min(1, Number(landmark?.confidence || 0))),
          }))
          .filter((landmark) => landmark.name)
          .slice(0, 5)
      : fallback.analysis_windows[index]?.landmarks || [];
    const visualFeatures = responseWindow.visual_features && typeof responseWindow.visual_features === "object"
      ? {
          shot_type: responseWindow.visual_features.shot_type || "unknown",
          camera_motion: responseWindow.visual_features.camera_motion || "unknown",
          dominant_colors: Array.isArray(responseWindow.visual_features.dominant_colors) ? responseWindow.visual_features.dominant_colors.slice(0, 5) : [],
          has_people: Boolean(responseWindow.visual_features.has_people),
          has_water: Boolean(responseWindow.visual_features.has_water),
          has_architecture: Boolean(responseWindow.visual_features.has_architecture),
        }
      : fallback.analysis_windows[index]?.visual_features;
    const quality = responseWindow.quality && typeof responseWindow.quality === "object"
      ? {
          sharpness: Math.max(0, Math.min(1, Number(responseWindow.quality.sharpness || 0.7))),
          stability: Math.max(0, Math.min(1, Number(responseWindow.quality.stability || 0.7))),
          brightness: Math.max(0, Math.min(1, Number(responseWindow.quality.brightness || 0.7))),
          usable: responseWindow.quality.usable !== false,
        }
      : fallback.analysis_windows[index]?.quality;

    return {
      window_index: windowBlueprint.window_index,
      start_seconds: windowBlueprint.start_seconds,
      end_seconds: windowBlueprint.end_seconds,
      sample_time_seconds: windowBlueprint.sample_time_seconds,
      description: summary,
      summary,
      tags,
      location,
      landmarks,
      location_type: responseWindow.location_type || "",
      visual_features: visualFeatures,
      quality,
      confidence: Math.max(0, Math.min(1, Number(responseWindow.confidence || 0.6))),
      detected_visual_categories: responseWindow.detected_visual_categories || [],
      detected_objects: responseWindow.detected_objects || [],
      visual_intent_match: responseWindow.visual_intent_match,
      generic_visual: responseWindow.generic_visual,
    };
  });

  const overallSummary = response?.overall_summary || response?.summary || analysisWindows.map((window) => window.summary).filter(Boolean).join("; ") || fallback.analysis_summary;
  const overallTags = unique([
    ...(Array.isArray(response?.overall_tags) ? response.overall_tags : []),
    ...analysisWindows.flatMap((window) => window.tags || []),
    ...(fallback.analysis_tags || []),
  ]).slice(0, 16);

  return {
    semantic_text: overallSummary,
    analysis_summary: overallSummary,
    analysis_tags: overallTags,
    analysis_windows: analysisWindows,
    analysis_provider: "openai_vision",
    analysis_window_seconds: ANALYSIS_WINDOW_SECONDS,
  };
};

const analyzeDownloadedAssetSemantics = async ({ asset, scene, paths }) => {
  const fallbackPayload = buildFallbackAnalysisPayload({ asset, scene });

  if (asset.asset_type !== "video" || !asset.local_path) {
    return {
      ...asset,
      ...fallbackPayload,
    };
  }

  const localPayload = await analyzeLocalVideo({
    inputPath: asset.local_path,
    windowSeconds: config.LOCAL_VIDEO_UNDERSTANDING_WINDOW_SECONDS || ANALYSIS_WINDOW_SECONDS,
    maxWindows: config.LOCAL_VIDEO_UNDERSTANDING_MAX_WINDOWS || MAX_ANALYSIS_WINDOWS,
    mode: config.LOCAL_VIDEO_UNDERSTANDING_MODE || "frames",
    assetMetadata: asset,
    sceneContext: scene,
  }).catch(() => null);

  const localProvider = String(localPayload?.provider || "").toLowerCase();
  const weakLocalProvider = localProvider.startsWith("weak_fallback") || ["disabled", "script_missing", "metadata_fallback"].includes(localProvider);
  if (localPayload?.provider && !weakLocalProvider) {
    return {
      ...asset,
      ...mergeAnalysisPayload({
        asset,
        scene,
        payload: {
          semantic_text: localPayload.analysis_summary,
          analysis_summary: localPayload.analysis_summary,
          analysis_tags: localPayload.analysis_tags,
          analysis_windows: localPayload.analysis_windows,
          analysis_provider: localPayload.provider,
          analysis_window_seconds: localPayload.analysis_window_seconds,
        },
      }),
    };
  }

  if (!hasOpenAi()) {
    return {
      ...asset,
      ...mergeAnalysisPayload({ asset, scene, payload: localPayload || fallbackPayload }),
    };
  }

  const windowBlueprints = buildAnalysisWindowBlueprints({ assetDuration: asset.source_duration_seconds || asset.duration_estimate || 0 });
  const analysisDir = path.join(paths.base, "assets", "analysis", path.basename(asset.local_path, path.extname(asset.local_path)));

  try {
    await fs.ensureDir(analysisDir);
    const framePaths = [];

    for (const windowBlueprint of windowBlueprints) {
      const framePath = path.join(analysisDir, `window-${String(windowBlueprint.window_index).padStart(2, "0")}.jpg`);
      await extractVideoFrame({
        inputPath: asset.local_path,
        outputPath: framePath,
        timeSeconds: windowBlueprint.sample_time_seconds,
      });
      framePaths.push(framePath);
    }

    const response = await describeImagesWithOpenAI({
      prompt: buildAssetAnalysisPrompt({ scene, asset, windowBlueprints }),
      imagePaths: framePaths,
      detail: "low",
    });

    await fs.remove(analysisDir).catch(() => null);

    return {
      ...asset,
      ...mergeAnalysisPayload({
        asset,
        scene,
        payload: response
          ? {
              ...normalizeAssetAnalysisResponse({ response, asset, scene, windowBlueprints }),
              analysis_provider: "openai_vision",
              analysis_window_seconds: ANALYSIS_WINDOW_SECONDS,
            }
          : (localPayload || fallbackPayload),
      }),
    };
  } catch {
    await fs.remove(analysisDir).catch(() => null);
    return {
      ...asset,
      ...mergeAnalysisPayload({ asset, scene, payload: localPayload || fallbackPayload }),
    };
  }
};

const downloadFile = async (url, outputPath) => {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 45000,
    maxRedirects: 5,
  });
  await fs.ensureDir(path.dirname(outputPath));
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
  return outputPath;
};

const createSceneFallbackAsset = async ({ scene, paths }) => {
  const refreshToken = Date.now();
  const outputPath = path.join(
    paths.rawAssetsDir,
    `scene-${String(scene.scene_index).padStart(2, "0")}-fallback-${refreshToken}.png`
  );
  await createPlaceholderImage({
    outputPath,
    width: PREFERRED_WIDTH,
    height: PREFERRED_HEIGHT,
    seed: scene.scene_index,
  });

  return {
    scene_index: scene.scene_index,
    provider: "local_fallback",
    asset_type: "image",
    type: "image",
    query: scene.keywords.join(" "),
    semantic_text: scene.narration_excerpt || scene.title || scene.keywords.join(" "),
    source_url: "generated-local",
    local_path: outputPath,
    resolution: {
      width: PREFERRED_WIDTH,
      height: PREFERRED_HEIGHT,
      label: getResolutionLabel({ width: PREFERRED_WIDTH, height: PREFERRED_HEIGHT }),
    },
    duration_estimate: Number(scene.target_duration_seconds || 6),
    is_fallback: true,
    orientation: "horizontal",
  };
};

const pickBestPexelsVideoFile = (video = {}) => {
  return (video.video_files || [])
    .map((file) => ({
      ...file,
      width: Number(file.width || video.width || 0),
      height: Number(file.height || video.height || 0),
    }))
    .filter((file) => file.link && isHorizontal(file))
    .sort((left, right) => resolutionScore({ ...right, assetType: "video" }) - resolutionScore({ ...left, assetType: "video" }))[0];
};

const searchPexels = async (query, limit = SEARCH_RESULTS_PER_QUERY) => {
  if (!hasPexels()) return [];

  const [videoRes, imageRes] = await Promise.allSettled([
    axios.get("https://api.pexels.com/videos/search", {
      headers: { Authorization: config.PEXELS_API_KEY },
      params: {
        query,
        per_page: Math.max(6, limit),
        orientation: "landscape",
        size: "large",
      },
      timeout: 30000,
    }),
    axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: config.PEXELS_API_KEY },
      params: {
        query,
        per_page: Math.max(3, Math.ceil(limit / 2)),
        orientation: "landscape",
        size: "large",
      },
      timeout: 30000,
    }),
  ]);

  const items = [];

  if (videoRes.status === "fulfilled") {
    const videos = videoRes.value.data?.videos || [];
    videos.forEach((video) => {
      const file = pickBestPexelsVideoFile(video);
      if (file?.link) {
        items.push({
          provider: "pexels",
          asset_type: "video",
          type: "video",
          query,
          semantic_text: query,
          source_url: file.link,
          width: Number(file.width || video.width || 0),
          height: Number(file.height || video.height || 0),
          duration_estimate: Number(video.duration || 0),
        });
      }
    });
  }

  if (imageRes.status === "fulfilled") {
    const photos = imageRes.value.data?.photos || [];
    photos.forEach((photo) => {
      if (photo?.src?.original && isHorizontal({ width: Number(photo.width || 0), height: Number(photo.height || 0) })) {
        items.push({
          provider: "pexels",
          asset_type: "image",
          type: "image",
          query,
          semantic_text: photo.alt || query,
          source_url: photo.src.original || photo.src.large2x || photo.src.large,
          width: Number(photo.width || 0),
          height: Number(photo.height || 0),
        });
      }
    });
  }

  return sortCandidatesForMotion(items.filter((item) => isHorizontal(item)));
};

const normalizePixabayVideo = (query, hit = {}) => {
  const variants = Object.values(hit.videos || {})
    .map((variant) => ({
      url: variant?.url,
      width: Number(variant?.width || 0),
      height: Number(variant?.height || 0),
    }))
    .filter((variant) => variant.url && isHorizontal(variant));

  const best = variants.sort((left, right) => resolutionScore({ ...right, assetType: "video" }) - resolutionScore({ ...left, assetType: "video" }))[0];
  if (!best) return null;

  return {
    provider: "pixabay",
    asset_type: "video",
    type: "video",
    query,
    semantic_text: hit.tags || query,
    provider_tags: String(hit.tags || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    source_url: best.url,
    width: best.width,
    height: best.height,
    duration_estimate: Number(hit.duration || 0),
  };
};

const searchPixabay = async (query, limit = SEARCH_RESULTS_PER_QUERY) => {
  if (!hasPixabay()) return [];

  const [videoResponse, imageResponse] = await Promise.allSettled([
    axios.get("https://pixabay.com/api/videos/", {
      params: {
        key: config.PIXABAY_API_KEY,
        q: query,
        per_page: Math.max(4, limit),
      },
      timeout: 30000,
    }),
    axios.get("https://pixabay.com/api/", {
      params: {
        key: config.PIXABAY_API_KEY,
        q: query,
        image_type: "photo",
        orientation: "horizontal",
        min_width: MIN_WIDTH,
        min_height: MIN_HEIGHT,
        per_page: Math.max(4, limit),
      },
      timeout: 30000,
    }),
  ]);

  const items = [];

  if (videoResponse.status === "fulfilled") {
    (videoResponse.value.data?.hits || []).forEach((hit) => {
      const normalized = normalizePixabayVideo(query, hit);
      if (normalized) items.push(normalized);
    });
  }

  if (imageResponse.status === "fulfilled") {
    (imageResponse.value.data?.hits || []).forEach((hit) => {
      if (!isHorizontal({ width: Number(hit.imageWidth || 0), height: Number(hit.imageHeight || 0) })) return;
      items.push({
        provider: "pixabay",
        asset_type: "image",
        type: "image",
        query,
        semantic_text: hit.tags || query,
        provider_tags: String(hit.tags || "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        source_url: hit.largeImageURL || hit.webformatURL,
        width: Number(hit.imageWidth || 0),
        height: Number(hit.imageHeight || 0),
      });
    });
  }

  return sortCandidatesForMotion(items);
};

const pexelsProvider = {
  name: "pexels",
  search: async ({ query, limit = SEARCH_RESULTS_PER_QUERY }) => searchPexels(query, limit),
};

const pixabayProvider = {
  name: "pixabay",
  search: async ({ query, limit = SEARCH_RESULTS_PER_QUERY }) => searchPixabay(query, limit),
};

const localCuratedProvider = {
  name: "local_curated",
  search: async ({ query, limit = SEARCH_RESULTS_PER_QUERY }) => {
    const entries = await readLocalCuratedAssetIndex();
    return buildLocalCuratedCandidatesFromIndex({ entries, query, limit });
  },
};

const aiGeneratedPlaceholderProvider = {
  name: "ai_generated_placeholder",
  search: async ({ query }) => {
    if (!config.AI_GENERATED_PLACEHOLDER_ENABLED) return [];
    return [{
      provider: "ai_generated_placeholder",
      asset_type: "image",
      type: "image",
      query,
      semantic_text: query,
      provider_tags: ["generated", "placeholder", "editorial_gap"],
      provider_title: "AI generated editorial placeholder",
      source_url: `generated-local://${slugify(query || "editorial-gap")}`,
      width: PREFERRED_WIDTH,
      height: PREFERRED_HEIGHT,
      duration_estimate: 6,
      source_tier: "generated",
      generated_placeholder: true,
      pre_download_score: 0.2,
    }];
  },
};

const providerAdapters = [localCuratedProvider, pexelsProvider, pixabayProvider, aiGeneratedPlaceholderProvider];

const searchProviderCandidates = async ({ query, limit = SEARCH_RESULTS_PER_QUERY, filters = {} }) => {
  const responses = await Promise.allSettled(
    providerAdapters.map((provider) =>
      provider.search({ query, limit, filters }).catch(() => [])
    )
  );

  const candidates = responses
    .flatMap((response) => (response.status === "fulfilled" ? response.value : []))
    .filter((candidate) => candidate?.source_url && isHorizontal(candidate));

  if (!filters || !Array.isArray(filters.blockedProviders) || !filters.blockedProviders.length) {
    return candidates.sort((left, right) => candidateMotionScore(right) - candidateMotionScore(left));
  }

  const blockedProviders = new Set(filters.blockedProviders.map((value) => String(value || "").toLowerCase()));
  return candidates
    .filter((candidate) => !blockedProviders.has(String(candidate.provider || "").toLowerCase()))
    .sort((left, right) => candidateMotionScore(right) - candidateMotionScore(left));
};

const cacheSearchResults = async ({ query, cache }) => {
  const cacheKey = query;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const candidates = await searchProviderCandidates({ query });
  cache.set(cacheKey, candidates);
  return candidates;
};

const cacheSearchResultsWithFilters = async ({ query, cache, filters = {} }) => {
  const cacheKey = `${query}::${JSON.stringify(filters || {})}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const candidates = await searchProviderCandidates({ query, filters });
  cache.set(cacheKey, candidates);
  return candidates;
};

const downloadSceneCandidate = async ({ candidate, scene, paths, sequence }) => {
  const extension = candidate.asset_type === "video" ? "mp4" : "jpg";
  const fileName = `scene-${String(scene.scene_index).padStart(2, "0")}-${String(sequence).padStart(2, "0")}-${slugify(candidate.provider)}.${extension}`;
  const localPath = path.join(paths.rawAssetsDir, fileName);

  if (candidate.generated_placeholder) {
    await createPlaceholderImage({ outputPath: localPath, seed: sequence });
  } else if (candidate.local_path && await fs.pathExists(candidate.local_path)) {
    await fs.copy(candidate.local_path, localPath);
  } else {
    await downloadFile(candidate.source_url, localPath);
  }
  const mediaInfo = await probeMedia(localPath).catch(() => ({ width: 0, height: 0, duration: 0 }));
  const width = Number(mediaInfo.width || candidate.width || 0);
  const height = Number(mediaInfo.height || candidate.height || 0);

  if (!isHorizontal({ width, height })) {
    await fs.remove(localPath).catch(() => null);
    return null;
  }

  return {
    scene_index: scene.scene_index,
    provider: candidate.provider,
    asset_type: candidate.asset_type,
    type: candidate.asset_type,
    query: candidate.query,
    query_used: candidate.query_used || candidate.query,
    search_reason: candidate.search_reason || "",
    block_intro_candidate: /hard_boundary_block_intro_asset|intro establishing shot/i.test(`${candidate.search_reason || ""} ${candidate.query_used || ""}`),
    chapter_card_candidate: /hard_boundary_chapter_card_clip|chapter transition card/i.test(`${candidate.search_reason || ""} ${candidate.query_used || ""}`),
    pre_download_score: Number(candidate.pre_download_score || 0),
    intent_match: candidate.intent_match === true,
    generic_asset: candidate.generic_asset === true,
    rejection_reason: candidate.rejection_reason || "",
    semantic_text: candidate.semantic_text || candidate.query,
    provider_tags: candidate.provider_tags || [],
    provider_title: candidate.provider_title || "",
    source_tier: candidate.source_tier || "free",
    curated_asset: candidate.curated_asset === true,
    generated_placeholder: candidate.generated_placeholder === true,
    source_url: candidate.source_url,
    local_path: localPath,
    resolution: {
      width,
      height,
      label: getResolutionLabel({ width, height }),
    },
    duration_estimate:
      candidate.asset_type === "video"
        ? Number(mediaInfo.duration || candidate.duration_estimate || scene.target_duration_seconds || 6)
        : Number(scene.target_duration_seconds || 6),
    source_duration_seconds: Number(mediaInfo.duration || candidate.duration_estimate || 0),
    is_fallback: false,
    orientation: "horizontal",
  };
};

const generateAssets = async ({
  videoId,
  mockMode = false,
  maxAssets = 8,
  sceneIndexes = [],
  preserveExisting = false,
  refreshReason = "",
  repairPlanByScene = [],
}) => {
  const state = await loadState(videoId);
  const paths = await ensureVideoStructure(videoId);
  const audioIntelligence = await getCachedAudioIntelligence({ videoId }).catch(() => null);
  const allowPlaceholderAssets = shouldAllowPlaceholderAssets({ mockMode });

  const baseVisualPlan = Array.isArray(state.visual_plan) && state.visual_plan.length
    ? state.visual_plan
    : buildVisualPlan({
        topic: state.topic,
        scriptText: state.script_text,
        outlineSections: state.outline_json?.sections || [],
        durationSeconds: Number(state.duration_seconds || 0),
        audioIntelligence,
      });
  const visualPlan = enrichVisualPlan({
    topic: state.topic,
    visualPlan: baseVisualPlan,
    audioIntelligence,
    audioDuration: Number(state.duration_seconds || 0),
  }).visualPlan;
  const microVisualPlan = buildMicroVisualPlan({
    audioIntelligence,
    visualPlan,
    durationSeconds: Number(state.duration_seconds || 0),
  });

  const requestedSceneIndexes = normalizeSceneIndexes(sceneIndexes);
  const requestedSceneIndexSet = new Set(requestedSceneIndexes);
  const selectedScenes = requestedSceneIndexSet.size
    ? visualPlan.filter((scene) => requestedSceneIndexSet.has(Number(scene.scene_index || 0)))
    : visualPlan;
  const selectedSceneIndexes = selectedScenes.map((scene) => Number(scene.scene_index || 0));
  const selectiveRefresh = selectedSceneIndexes.length > 0 && selectedSceneIndexes.length < visualPlan.length;
  const preserveUntouchedScenes = Boolean(selectiveRefresh && preserveExisting);
  const previousRawItems = Array.isArray(state.assets_json?.raw_items)
    ? state.assets_json.raw_items
    : (Array.isArray(state.assets_json?.items) ? state.assets_json.items : []);
  const previousApprovedItems = Array.isArray(state.assets_json?.approved_items)
    ? state.assets_json.approved_items
    : (Array.isArray(state.assets_json?.items) ? state.assets_json.items : []);
  const previousSceneQueries = Array.isArray(state.assets_json?.scene_queries) ? state.assets_json.scene_queries : [];
  const previousFallbackPlan = Array.isArray(state.assets_json?.fallback_plan) ? state.assets_json.fallback_plan : [];
  const providerReliability = state.assets_json?.provider_reliability || state.render_validation?.provider_reliability || {};

  if (requestedSceneIndexSet.size && !selectedScenes.length) {
    return {
      video_id: videoId,
      assets_count: previousApprovedItems.length,
      missing_assets: Boolean(state.assets_json?.missing_assets),
      state_path: state.state_path,
      assets_json: state.assets_json,
      visual_plan: visualPlan,
      refreshed_scene_indexes: [],
    };
  }

  const items = [];
  const fallbackPlan = [];
  const sceneQueries = [];
  const searchCache = new Map();
  const repairPlanMap = new Map(
    (Array.isArray(repairPlanByScene) ? repairPlanByScene : [])
      .map((entry) => [Number(entry.scene_index || 0), entry])
      .filter(([sceneIndex]) => sceneIndex > 0)
  );
  const autoRepairPlan = buildAutoRepairPlanByScene({ state, selectedSceneIndexes });
  autoRepairPlan.forEach((entry) => {
    const key = Number(entry.scene_index || 0);
    if (!key) return;
    const existing = repairPlanMap.get(key);
    if (!existing) {
      repairPlanMap.set(key, entry);
      return;
    }
    repairPlanMap.set(key, {
      ...existing,
      target_narrative_roles: unique([...(existing.target_narrative_roles || []), ...(entry.target_narrative_roles || [])]),
      target_micro_needs: unique([...(existing.target_micro_needs || []), ...(entry.target_micro_needs || [])]),
      micro_repair_queries: unique([...(existing.micro_repair_queries || []), ...(entry.micro_repair_queries || [])]),
      diversity_repair_queries: unique([...(existing.diversity_repair_queries || []), ...(entry.diversity_repair_queries || [])]),
      avoid_source_urls: unique([...(existing.avoid_source_urls || []), ...(entry.avoid_source_urls || [])]),
      avoid_asset_ids: unique([...(existing.avoid_asset_ids || []), ...(entry.avoid_asset_ids || [])]),
      avoid_visual_families: unique([...(existing.avoid_visual_families || []), ...(entry.avoid_visual_families || [])]),
      extra_negative_keywords: unique([...(existing.extra_negative_keywords || []), ...(entry.extra_negative_keywords || [])]),
      force_exact_required: Boolean(existing.force_exact_required || entry.force_exact_required),
      boundary_expected_location: existing.boundary_expected_location || entry.boundary_expected_location || "",
      require_location_match: Boolean(existing.require_location_match || entry.require_location_match),
    });
  });
  const blockCandidateFunnel = [];
  const slotQueryPlan = [];
  const scenesByBlockId = buildScenesByBlockId(visualPlan);
  const allBlockPackages = buildBlockContentPackages({ visualPlan, budgetProfile: ECONOMIC_BUDGET });
  const selectedBlockPackages = requestedSceneIndexSet.size
    ? allBlockPackages.filter((pkg) => (pkg.scene_indexes || []).some((sceneIndex) => requestedSceneIndexSet.has(Number(sceneIndex || 0))))
    : allBlockPackages;
  const library = await readLibrary();
  const libraryBySourceUrl = mapLibraryBySourceUrl(library);
  const perSceneSequence = new Map();

  for (const blockPackage of selectedBlockPackages) {
    const blockScenes = scenesByBlockId.get(String(blockPackage.block_id || "")) || [];
    const representativeScene = getRepresentativeSceneForBlock(blockScenes);
    const activeSceneIndexes = requestedSceneIndexSet.size
      ? (blockPackage.scene_indexes || []).filter((sceneIndex) => requestedSceneIndexSet.has(Number(sceneIndex || 0)))
      : (blockPackage.scene_indexes || []);
    const activeScenes = blockScenes.filter((scene) => activeSceneIndexes.includes(Number(scene.scene_index || 0)));
    if (!activeScenes.length) continue;

    const blockRepairHints = activeSceneIndexes.reduce((acc, sceneIndex) => {
      const hints = repairPlanMap.get(Number(sceneIndex || 0)) || {};
      return {
        target_narrative_roles: unique([...(acc.target_narrative_roles || []), ...(hints.target_narrative_roles || [])]),
        target_micro_needs: unique([...(acc.target_micro_needs || []), ...(hints.target_micro_needs || [])]),
        micro_repair_queries: unique([...(acc.micro_repair_queries || []), ...(hints.micro_repair_queries || [])]),
        diversity_repair_queries: unique([...(acc.diversity_repair_queries || []), ...(hints.diversity_repair_queries || [])]),
        avoid_source_urls: unique([...(acc.avoid_source_urls || []), ...(hints.avoid_source_urls || [])]),
        avoid_asset_ids: unique([...(acc.avoid_asset_ids || []), ...(hints.avoid_asset_ids || [])]),
        avoid_visual_families: unique([...(acc.avoid_visual_families || []), ...(hints.avoid_visual_families || [])]),
        extra_negative_keywords: unique([...(acc.extra_negative_keywords || []), ...(hints.extra_negative_keywords || [])]),
        preferred_providers: unique([...(acc.preferred_providers || []), ...(hints.preferred_providers || [])]),
        force_exact_required: acc.force_exact_required || hints.force_exact_required === true,
        boundary_expected_location: acc.boundary_expected_location || hints.boundary_expected_location || "",
        require_location_match: Boolean(acc.require_location_match || hints.require_location_match),
      };
    }, {});

    const activeBudgetProfile = resolveAdaptiveBudgetProfile({
      blockPackage,
      repairHints: blockRepairHints,
    });

    const queryPlan = buildBlockQueryPlan({
      block: {
        ...representativeScene,
        block_label: blockPackage.block_label || representativeScene.block_label || "",
        visual_intent: blockPackage.intent || representativeScene.visual_intent || "generic_travel",
      },
      slots: blockPackage.slots || [],
      topic: state.topic || "",
      repairHints: blockRepairHints,
      budgetProfile: activeBudgetProfile,
    });

    slotQueryPlan.push({
      block_id: blockPackage.block_id,
      package_id: blockPackage.package_id,
      intent: blockPackage.intent,
      query_details: queryPlan.queryDetails || [],
      negative_keywords: queryPlan.negativeKeywords || [],
      retrieval_budget: queryPlan.retrievalBudget || {},
      repair_hints: {
        target_narrative_roles: blockRepairHints.target_narrative_roles || [],
        target_micro_needs: blockRepairHints.target_micro_needs || [],
        diversity_repair_queries: blockRepairHints.diversity_repair_queries || [],
        avoid_source_urls: blockRepairHints.avoid_source_urls || [],
        avoid_visual_families: blockRepairHints.avoid_visual_families || [],
        boundary_expected_location: blockRepairHints.boundary_expected_location || "",
        require_location_match: Boolean(blockRepairHints.require_location_match),
      },
    });

    activeScenes.forEach((scene) => {
      sceneQueries.push({
        scene_index: scene.scene_index,
        block_id: blockPackage.block_id,
        block_label: blockPackage.block_label || scene.block_label || "",
        visual_intent: scene.visual_intent || blockPackage.intent || "",
        queries: queryPlan.queries || [],
        query_details: queryPlan.queryDetails || [],
        retrieval_budget: queryPlan.retrievalBudget || {},
        negative_keywords: queryPlan.negativeKeywords || [],
        search_reason: queryPlan.searchReason,
        specific_intent_required: Boolean((blockPackage.slots_required || []).some((slot) => slot.requires_visual_proof === true)),
        repair_hints: blockRepairHints,
      });
    });

    logger.info("assetsService: iniciando bloco", {
      videoId,
      block_id: blockPackage.block_id,
      intent: blockPackage.intent,
      scenes: activeSceneIndexes,
      slots: (blockPackage.slots || []).length,
      queries_count: (queryPlan.queries || []).length,
    });

    let rawCandidates = [];
    let shortlist = [];
    let finalists = [];
    let repairRoundsUsed = 0;
    const downloadedItems = [];
    const seenUrls = new Set();

    if (!mockMode) {
      for (const queryDetail of queryPlan.queryDetails || []) {
        const candidates = await cacheSearchResultsWithFilters({
          query: queryDetail.query,
          cache: searchCache,
          filters: {},
        });
        const filteredByNegatives = candidates.filter((candidate) => !matchesNegativeKeyword({
          candidate,
          negativeKeywords: queryPlan.negativeKeywords || [],
        })).filter((candidate) => !shouldSkipCandidateByRepairConstraints({ candidate, repairHints: blockRepairHints }));
        const scored = filteredByNegatives
          .map((candidate) => ({
            ...candidate,
            query_used: queryDetail.query,
            query: queryDetail.query,
            slot_id: queryDetail.slot_id || "",
            slot_type: queryDetail.slot_type || "",
            content_need: queryDetail.content_need || queryDetail.slot_type || "",
            slot_priority: Number(queryDetail.priority || 1),
            search_reason: queryDetail.reason || "",
            negative_keywords: queryPlan.negativeKeywords || [],
            ...scorePreDownloadCandidate({
              candidate: { ...candidate, query_used: queryDetail.query },
              scene: representativeScene,
            }),
          }))
          .filter((candidate) => !candidate.pre_download_rejected);
        rawCandidates.push(...scored);
      }

      rawCandidates = dedupeCandidatesByUrl(
        rawCandidates
          .sort((left, right) => Number(right.pre_download_score || 0) - Number(left.pre_download_score || 0))
      ).slice(0, Number(activeBudgetProfile.raw_candidates_per_block || ECONOMIC_BUDGET.raw_candidates_per_block));
      const libraryCandidates = buildLibraryCandidatePoolForBlock({
        library,
        blockPackage,
        representativeScene,
        negativeKeywords: queryPlan.negativeKeywords || [],
        limit: Math.max(8, Math.floor(Number(activeBudgetProfile.cheap_shortlist_per_block || ECONOMIC_BUDGET.cheap_shortlist_per_block) / 2)),
      }).map((candidate) => ({
        ...candidate,
        query_used: candidate.query,
        slot_id: (blockPackage.slots_required || [])[0]?.slot_id || "",
        slot_type: (blockPackage.slots_required || [])[0]?.slot_type || "fallback_safe",
        content_need: (blockPackage.slots_required || [])[0]?.slot_type || "fallback_safe",
        slot_priority: 2,
        search_reason: "editorial_library_seed",
        pre_download_score: Number(candidate.library_quality_score || 0.4) * 4,
        intent_match: true,
        generic_asset: false,
      })).filter((candidate) => !shouldSkipCandidateByRepairConstraints({ candidate, repairHints: blockRepairHints }));
      rawCandidates = dedupeCandidatesByUrl([...rawCandidates, ...libraryCandidates])
        .sort((left, right) => Number(right.pre_download_score || 0) - Number(left.pre_download_score || 0))
        .slice(0, Number(activeBudgetProfile.raw_candidates_per_block || ECONOMIC_BUDGET.raw_candidates_per_block));

      shortlist = rawCandidates
        .map((candidate) => ({
          ...(candidate),
          __slot_meta: (blockPackage.slots || []).find((slot) =>
            String(slot.slot_id || "") === String(candidate.slot_id || "")
            || String(slot.slot_type || "") === String(candidate.slot_type || "")
          ) || null,
        }))
        .map((candidate) => ({
          ...candidate,
          provider_reliability_score: Number(providerReliability[String(candidate.provider || "").toLowerCase()] || 0.5),
          slot_history_score: Number(
            libraryBySourceUrl[candidate.source_url]?.slot_performance?.[String(candidate.slot_type || "").toLowerCase()]?.avg
            || 0.5
          ),
          search_relevance_score: (
            Number(candidate.pre_download_score || 0) * 1_000_000
            + (candidate.intent_match ? 180_000 : -90_000)
            + (candidate.generic_asset ? -130_000 : 80_000)
            + (Number(providerReliability[String(candidate.provider || "").toLowerCase()] || 0.5) * 160_000)
            + (((candidate.__slot_meta?.criticality === "high" || candidate.__slot_meta?.criticality === "critical")
              ? Number(providerReliability[String(candidate.provider || "").toLowerCase()] || 0.5) * 120_000
              : 0))
            + (Number(
              libraryBySourceUrl[candidate.source_url]?.slot_performance?.[String(candidate.slot_type || "").toLowerCase()]?.avg
              || 0.5
            ) * 90_000)
            - (computeReusePenalty({
              candidate: libraryBySourceUrl[candidate.source_url] || {},
              blockId: blockPackage.block_id,
              usedAssetIds: new Set(downloadedItems.map((item) => item.asset_id).filter(Boolean)),
            }) * 100_000)
          ),
        }))
        .sort((left, right) => Number(right.search_relevance_score || 0) - Number(left.search_relevance_score || 0))
        .slice(0, Number(activeBudgetProfile.cheap_shortlist_per_block || ECONOMIC_BUDGET.cheap_shortlist_per_block));

      const finalistsBySlot = [];
      for (const slot of blockPackage.slots || []) {
        const slotCandidates = shortlist.filter((candidate) =>
          String(candidate.slot_id || "") === String(slot.slot_id || "")
          || String(candidate.slot_type || "") === String(slot.slot_type || "")
        );
        const targetScene = activeScenes.find((scene) => Number(scene.scene_index || 0) === Number(slot.scene_index_hint || 0))
          || representativeScene;
        const slotFinalists = selectSlotFinalists({
          slot,
          candidates: slotCandidates,
          scene: targetScene,
          blockId: blockPackage.block_id,
          budgetProfile: activeBudgetProfile,
          libraryUsage: {
            ...libraryBySourceUrl,
            usedAssetIds: new Set(downloadedItems.map((item) => item.asset_id).filter(Boolean)),
          },
        }).map((candidate) => ({
          ...candidate,
          slot_scene_index_hint: Number(slot.scene_index_hint || targetScene.scene_index || representativeScene.scene_index || 0),
        }));

        finalistsBySlot.push(...slotFinalists);
      }

      let dedupedFinalists = dedupeCandidatesByUrl(
        finalistsBySlot.sort((left, right) => Number(right._slot_score || 0) - Number(left._slot_score || 0))
      );
      let missingRequiredSlots = computeMissingRequiredSlots({
        slotsRequired: blockPackage.slots_required || [],
        candidates: dedupedFinalists,
      });

      const maxRepairRounds = Math.max(0, Number(activeBudgetProfile.max_repair_rounds_per_block || 0));
      const attemptedRepairQueries = new Set();
      while (missingRequiredSlots.length && repairRoundsUsed < maxRepairRounds) {
        repairRoundsUsed += 1;
        let appendedRepairCandidates = 0;
        const roundRepairPlans = [];
        for (const missingSlot of missingRequiredSlots) {
          for (const hint of (missingSlot.query_hints || []).slice(0, 2)) {
            roundRepairPlans.push({
              query: `${representativeScene.expected_location || representativeScene.location?.city || ""} ${hint} authentic real`.trim(),
              slot_id: missingSlot.slot_id,
              slot_type: missingSlot.slot_type,
              content_need: missingSlot.slot_type,
              slot_priority: Number(missingSlot.priority || 1) + 1,
              search_reason: `repair_slot_${missingSlot.slot_type}`,
            });
          }
        }
        for (const microNeed of (blockRepairHints.target_micro_needs || []).slice(0, 4)) {
          const slotMatch = (blockPackage.slots || []).find((slot) =>
            String(slot.slot_type || "").toLowerCase() === String(microNeed || "").toLowerCase()
          ) || (blockPackage.slots_required || [])[0] || {};
          roundRepairPlans.push({
            query: `${representativeScene.expected_location || representativeScene.location?.city || ""} ${String(microNeed || "").replace(/_/g, " ")} authentic close up human action`.trim(),
            slot_id: slotMatch.slot_id || "",
            slot_type: slotMatch.slot_type || String(microNeed || ""),
            content_need: slotMatch.slot_type || String(microNeed || ""),
            slot_priority: Number(slotMatch.priority || 1) + 1,
            search_reason: `repair_micro_need_${String(microNeed || "").toLowerCase()}`,
          });
        }

        for (const plan of roundRepairPlans) {
          if (!plan.query || attemptedRepairQueries.has(plan.query)) continue;
          attemptedRepairQueries.add(plan.query);
          const repairCandidates = await cacheSearchResultsWithFilters({
            query: plan.query,
            cache: searchCache,
            filters: {},
          });
          const mapped = repairCandidates
            .filter((candidate) => !matchesNegativeKeyword({ candidate, negativeKeywords: queryPlan.negativeKeywords || [] }))
            .filter((candidate) => !shouldSkipCandidateByRepairConstraints({ candidate, repairHints: blockRepairHints }))
            .map((candidate) => ({
              ...candidate,
              query_used: plan.query,
              query: plan.query,
              slot_id: plan.slot_id,
              slot_type: plan.slot_type,
              content_need: plan.content_need,
              slot_priority: plan.slot_priority,
              search_reason: plan.search_reason,
              ...scorePreDownloadCandidate({
                candidate: { ...candidate, query_used: plan.query },
                scene: representativeScene,
              }),
            }))
            .filter((candidate) => !candidate.pre_download_rejected);
          appendedRepairCandidates += mapped.length;
          shortlist.push(...mapped);
        }

        if (!appendedRepairCandidates) break;
        shortlist = dedupeCandidatesByUrl(shortlist)
          .sort((left, right) => Number(right.search_relevance_score || right.pre_download_score || 0) - Number(left.search_relevance_score || left.pre_download_score || 0))
          .slice(0, Math.max(
            Number(activeBudgetProfile.cheap_shortlist_per_block || ECONOMIC_BUDGET.cheap_shortlist_per_block),
            Number(activeBudgetProfile.vision_finalists_per_block || ECONOMIC_BUDGET.vision_finalists_per_block) * 3
          ));

        const refreshedFinalistsBySlot = [];
        for (const slot of blockPackage.slots || []) {
          const slotCandidates = shortlist.filter((candidate) =>
            String(candidate.slot_id || "") === String(slot.slot_id || "")
            || String(candidate.slot_type || "") === String(slot.slot_type || "")
          );
          const targetScene = activeScenes.find((scene) => Number(scene.scene_index || 0) === Number(slot.scene_index_hint || 0))
            || representativeScene;
          const slotFinalists = selectSlotFinalists({
            slot,
            candidates: slotCandidates,
            scene: targetScene,
            blockId: blockPackage.block_id,
            budgetProfile: activeBudgetProfile,
            libraryUsage: {
              ...libraryBySourceUrl,
              usedAssetIds: new Set(downloadedItems.map((item) => item.asset_id).filter(Boolean)),
            },
          }).map((candidate) => ({
            ...candidate,
            slot_scene_index_hint: Number(slot.scene_index_hint || targetScene.scene_index || representativeScene.scene_index || 0),
          }));
          refreshedFinalistsBySlot.push(...slotFinalists);
        }
        dedupedFinalists = dedupeCandidatesByUrl(
          refreshedFinalistsBySlot.sort((left, right) => Number(right._slot_score || 0) - Number(left._slot_score || 0))
        );
        missingRequiredSlots = computeMissingRequiredSlots({
          slotsRequired: blockPackage.slots_required || [],
          candidates: dedupedFinalists,
        });
      }

      const finalistLimit = Number(activeBudgetProfile.vision_finalists_per_block || ECONOMIC_BUDGET.vision_finalists_per_block);
      const coverageFirst = selectCoverageFirstFinalists({
        shortlist: dedupedFinalists.length ? dedupedFinalists : shortlist,
        blockPackage,
        limit: finalistLimit,
      });
      const preferredCritical = coverageFirst
        .filter((candidate) =>
          (blockPackage.slots_required || []).some((slot) =>
            String(slot.slot_id || "") === String(candidate.slot_id || "")
            && slot.requires_visual_proof === true
            && ["high", "critical"].includes(String(slot.criticality || "").toLowerCase())
          )
        );
      const criticalWithStrongProvider = preferredCritical.filter((candidate) =>
        Number(candidate.provider_reliability_score || 0.5) >= CRITICAL_SLOT_PREFERRED_PROVIDER_RELIABILITY
      );
      finalists = dedupeCandidatesByUrl(coverageFirst);
      if (criticalWithStrongProvider.length && finalists.length > criticalWithStrongProvider.length) {
        finalists = dedupeCandidatesByUrl([
          ...criticalWithStrongProvider,
          ...finalists,
        ]).slice(0, finalistLimit);
      }
      if (finalists.length < finalistLimit) {
        const topFallback = dedupeCandidatesByUrl(
          shortlist
            .sort((left, right) => Number(right.pre_download_score || 0) - Number(left.pre_download_score || 0))
        ).slice(0, finalistLimit);
        finalists = dedupeCandidatesByUrl([...finalists, ...topFallback]).slice(0, finalistLimit);
      }

      for (const candidate of finalists) {
        if (seenUrls.has(candidate.source_url)) continue;
        seenUrls.add(candidate.source_url);

        const sceneForCandidate = activeScenes.find((scene) => Number(scene.scene_index || 0) === Number(candidate.slot_scene_index_hint || 0))
          || representativeScene;
        const sequence = Number(perSceneSequence.get(Number(sceneForCandidate.scene_index || 0)) || 0) + 1;
        perSceneSequence.set(Number(sceneForCandidate.scene_index || 0), sequence);
        try {
          const downloaded = await downloadSceneCandidate({
            candidate,
            scene: sceneForCandidate,
            paths,
            sequence,
          });
          if (downloaded) {
            downloaded.content_slot_id = candidate.slot_id || "";
            downloaded.content_slot_type = candidate.slot_type || "";
            downloaded.content_need = candidate.content_need || candidate.slot_type || "";
            downloaded.block_id = blockPackage.block_id;
            downloaded.block_package_id = blockPackage.package_id;
            downloadedItems.push(downloaded);
          }
        } catch {
          // ignore
        }
      }
    }

    const distributionByScene = activeScenes.reduce((acc, scene) => {
      acc[scene.scene_index] = downloadedItems.filter((item) => Number(item.scene_index || 0) === Number(scene.scene_index || 0)).length;
      return acc;
    }, {});

    for (const scene of activeScenes) {
      if (distributionByScene[scene.scene_index] > 0) continue;
      if (allowPlaceholderAssets) {
        const placeholder = await createSceneFallbackAsset({ scene, paths });
        placeholder.block_id = blockPackage.block_id;
        placeholder.block_package_id = blockPackage.package_id;
        placeholder.content_slot_id = "fallback_safe";
        placeholder.content_slot_type = "fallback_safe";
        placeholder.content_need = "fallback_safe";
        downloadedItems.push(placeholder);
        fallbackPlan.push(`Cena ${scene.scene_index}: fallback local usado para cobertura minima do bloco ${blockPackage.block_label}.`);
      } else {
        fallbackPlan.push(`Cena ${scene.scene_index}: sem asset real disponivel para bloco ${blockPackage.block_label}; render deve ser bloqueado.`);
      }
    }

    const enrichedResults = await Promise.allSettled(
      downloadedItems.map((item) => {
        const scene = visualPlan.find((entry) => Number(entry.scene_index || 0) === Number(item.scene_index || 0)) || representativeScene;
        return analyzeDownloadedAssetSemantics({ asset: item, scene, paths });
      })
    );
    const enrichedItems = enrichedResults.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const asset = downloadedItems[index];
      const scene = visualPlan.find((entry) => Number(entry.scene_index || 0) === Number(asset.scene_index || 0)) || representativeScene;
      return {
        ...asset,
        ...buildFallbackAnalysisPayload({ asset, scene }),
      };
    });
    items.push(...enrichedItems);

    blockCandidateFunnel.push({
      block_id: blockPackage.block_id,
      package_id: blockPackage.package_id,
      intent: blockPackage.intent,
      scenes: activeSceneIndexes,
      raw_candidates_count: rawCandidates.length,
      cheap_shortlist_count: shortlist.length,
      vision_finalists_count: finalists.length,
      downloaded_count: downloadedItems.length,
      approved_count: 0,
      required_slots_total: Number((blockPackage.slots_required || []).length),
      required_slots_missing_before_download: Number(
        computeMissingRequiredSlots({
          slotsRequired: blockPackage.slots_required || [],
          candidates: finalists,
        }).length
      ),
      repair_rounds_used: repairRoundsUsed,
      retrieval_budget: activeBudgetProfile,
    });

    logger.info("assetsService: bloco concluido", {
      videoId,
      block_id: blockPackage.block_id,
      downloaded: downloadedItems.length,
      enriched: enrichedItems.length,
      raw_candidates: rawCandidates.length,
      shortlist: shortlist.length,
      finalists: finalists.length,
    });
  }

  const mergedRawItems = preserveUntouchedScenes
    ? mergeSceneScopedEntries({ existingEntries: previousRawItems, nextEntries: items, sceneIndexes: selectedSceneIndexes })
    : sortSceneScopedEntries(items);
  const mergedSceneQueries = preserveUntouchedScenes
    ? mergeSceneScopedEntries({ existingEntries: previousSceneQueries, nextEntries: sceneQueries, sceneIndexes: selectedSceneIndexes })
    : sortSceneScopedEntries(sceneQueries);
  const mergedFallbackPlan = preserveUntouchedScenes
    ? mergeFallbackPlan({ existingFallbackPlan: previousFallbackPlan, nextFallbackPlan: fallbackPlan, sceneIndexes: selectedSceneIndexes })
    : mergeFallbackPlan({ nextFallbackPlan: fallbackPlan });
  const mergedBlockPackages = allBlockPackages;
  const mergedSlotQueryPlan = slotQueryPlan;
  const retrievalBudgetSummary = mergedSceneQueries.map((entry) => ({
    scene_index: Number(entry.scene_index || 0),
    visual_intent: entry.visual_intent || "",
    retrieval_budget: entry.retrieval_budget || {},
    query_count: Array.isArray(entry.queries) ? entry.queries.length : 0,
  }));
  const flattenedKeywords = unique(visualPlan.flatMap((scene) => scene.keywords || [])).slice(0, 30);
  const searchQueries = unique(mergedSceneQueries.flatMap((entry) => entry.queries || []));
  const approvalResult = approveAssetsForVisualPlan({
    visualPlan,
    assets: mergedRawItems,
    blockPackages: mergedBlockPackages,
    microVisualPlan,
  });
  const approvedItems = approvalResult.approved_items || [];
  const slotCoverageByBlock = approvalResult.slot_coverage_by_block || [];
  const finalizedFunnel = blockCandidateFunnel.map((entry) => {
    const windowsForBlock = (approvalResult.approved_windows || []).filter((window) =>
      (entry.scenes || []).includes(Number(window.scene_index || 0))
    );
    const approvedCount = windowsForBlock.length;
    const distinctFamilies = new Set(windowsForBlock.map((window) => buildWindowFamilyKey(window)).filter(Boolean)).size;
    const assetCounts = windowsForBlock.reduce((acc, window) => {
      const key = String(window.asset_id || "");
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {});
    const repeatedAssetsInBlock = Object.values(assetCounts).filter((count) => Number(count || 0) > 1).length;
    const slotCoverageEntry = slotCoverageByBlock.find((item) => String(item.block_id || "") === String(entry.block_id || ""));
    const missingRequiredSlotsAfterApproval = slotCoverageEntry?.missing_required_slots || [];
    return {
      ...entry,
      approved_count: approvedCount,
      distinct_visual_families: distinctFamilies,
      repeated_assets_in_block: repeatedAssetsInBlock,
      same_asset_reuse_within_block: repeatedAssetsInBlock > 0,
      required_slots_missing_after_approval: missingRequiredSlotsAfterApproval,
      slot_coverage_ratio: Number(slotCoverageEntry?.coverage_ratio || 0),
    };
  });
  const coverageGate = evaluateCoverageGate({
    blockPackages: mergedBlockPackages,
    slotCoverageByBlock,
    blockCandidateFunnel: finalizedFunnel,
  });
  const localRepairPlan = buildLocalRepairPlan({
    state: {
      ...state,
      visual_plan: visualPlan,
      assets_json: {
        ...(state.assets_json || {}),
        block_packages: mergedBlockPackages,
        block_coverage_by_block: coverageGate.blocks || [],
        slot_coverage_by_block: slotCoverageByBlock,
        block_candidate_funnel: finalizedFunnel,
        micro_coverage_gaps: approvalResult.micro_coverage_gaps || [],
        scene_editorial_readiness: approvalResult.scene_editorial_readiness || [],
      },
    },
  });
  const coverageByBlockId = (coverageGate.blocks || []).reduce((acc, block) => {
    const key = String(block.block_id || "").trim();
    if (!key) return acc;
    acc[key] = block;
    return acc;
  }, {});
  const sceneEditorialReadiness = (approvalResult.scene_editorial_readiness || []).map((sceneReadiness) => {
    const scene = visualPlan.find((item) => Number(item.scene_index || 0) === Number(sceneReadiness.scene_index || 0)) || {};
    const blockId = String(scene.block_id || `scene_${Number(sceneReadiness.scene_index || 0)}`).trim();
    const blockCoverage = coverageByBlockId[blockId] || null;
    const coverageStatus = blockCoverage?.coverage_status || COVERAGE_STATUS.INSUFFICIENT;
    const coverageBlockingReasons = [];
    if (coverageStatus === COVERAGE_STATUS.INSUFFICIENT) {
      coverageBlockingReasons.push("block_coverage_insufficient");
    } else if (coverageStatus === COVERAGE_STATUS.PARTIAL && !Boolean(config.COVERAGE_GATE_ALLOW_PARTIAL)) {
      coverageBlockingReasons.push("block_coverage_partial");
    }
    return {
      ...sceneReadiness,
      block_id: blockId,
      block_repair_state: (localRepairPlan.block_states || []).find((entry) => String(entry.block_id || "") === blockId)?.block_state || "",
      coverage_status: coverageStatus,
      coverage_can_advance: blockCoverage?.can_advance === true,
      coverage_needs_repair: blockCoverage?.needs_repair === true,
      coverage_missing_slots: blockCoverage?.missing_slots || [],
      coverage_weak_only_slots: blockCoverage?.weak_only_slots || [],
      coverage_gaps: blockCoverage?.coverage_gaps || [],
      ready: Boolean(sceneReadiness.ready) && coverageBlockingReasons.length === 0,
      blocking: Boolean(sceneReadiness.blocking) || coverageBlockingReasons.length > 0,
      blocking_reasons: unique([
        ...((sceneReadiness.blocking_reasons || [])),
        ...coverageBlockingReasons,
      ]),
    };
  });
  const finalizedFunnelWithCoverage = finalizedFunnel.map((entry) => {
    const coverage = coverageByBlockId[String(entry.block_id || "").trim()] || null;
    const blockRepairState = (localRepairPlan.block_states || []).find((item) =>
      String(item.block_id || "").trim() === String(entry.block_id || "").trim()
    )?.block_state || REPAIR_BLOCK_STATE.BLOCKED;
    return {
      ...entry,
      coverage_status: coverage?.coverage_status || COVERAGE_STATUS.INSUFFICIENT,
      coverage_can_advance: coverage?.can_advance === true,
      coverage_needs_repair: coverage?.needs_repair === true,
      block_repair_state: blockRepairState,
      missing_slots: coverage?.missing_slots || [],
      weak_only_slots: coverage?.weak_only_slots || [],
    };
  });
  const libraryAfterMerge = await mergeApprovedWindowsIntoLibrary({
    approvedWindows: approvalResult.approved_windows || [],
    assets: mergedRawItems,
    videoId,
  });
  const librarySnapshot = summarizeLibrarySnapshot(libraryAfterMerge, 20);
  const readinessSummary = summarizeAssetReadiness({
    visualPlan,
    assets: mergedRawItems,
    approvedItems,
    approvedWindows: approvalResult.approved_windows || [],
    sceneEditorialReadiness,
    editorialMetrics: approvalResult.editorial_metrics || {},
    mockMode,
  });
  const missingAssets = readinessSummary.missing_assets;
  const mergedRepairPlanByScene = (() => {
    const byScene = new Map();
    Array.from(repairPlanMap.values()).forEach((entry) => {
      const key = Number(entry.scene_index || 0);
      if (!key) return;
      byScene.set(key, { ...entry });
    });
    (localRepairPlan.repair_by_scene || []).forEach((entry) => {
      const key = Number(entry.scene_index || 0);
      if (!key) return;
      const current = byScene.get(key);
      if (!current) {
        byScene.set(key, entry);
        return;
      }
      byScene.set(key, {
        ...current,
        failure_codes: unique([...(current.failure_codes || []), ...(entry.failure_codes || [])]),
        repair_actions: unique([...(current.repair_actions || []), ...(entry.repair_actions || [])]),
        target_narrative_roles: unique([...(current.target_narrative_roles || []), ...(entry.target_narrative_roles || [])]),
        target_micro_needs: unique([...(current.target_micro_needs || []), ...(entry.target_micro_needs || [])]),
        micro_repair_queries: unique([...(current.micro_repair_queries || []), ...(entry.micro_repair_queries || [])]),
        diversity_repair_queries: unique([...(current.diversity_repair_queries || []), ...(entry.diversity_repair_queries || [])]),
        extra_negative_keywords: unique([...(current.extra_negative_keywords || []), ...(entry.extra_negative_keywords || [])]),
        force_exact_required: Boolean(current.force_exact_required || entry.force_exact_required),
      });
    });
    return [...byScene.values()];
  })();
  const editorialMetricsWithCoverage = {
    ...(approvalResult.editorial_metrics || {}),
    block_coverage_strong_ratio: Number(coverageGate.summary?.strong_ratio || 0),
    block_coverage_partial_ratio: Number(coverageGate.summary?.partial_ratio || 0),
    block_coverage_insufficient_ratio: Number(coverageGate.summary?.insufficient_ratio || 0),
    block_coverage_repair_required_ratio: Number(coverageGate.summary?.repair_required_ratio || 0),
  };
  const refreshSceneIndexes = selectiveRefresh ? selectedSceneIndexes : [];
  const refreshedAt = new Date().toISOString();
  const assetFailureMessage = missingAssets
    ? `Assets insuficientes para render: cenas bloqueadas ${readinessSummary.blocking_scene_indexes.join(", ")}.`
    : "";

  const nextState = await updateState(
    videoId,
    {
      visual_plan: visualPlan,
      asset_failure: missingAssets,
      failure_reason: readinessSummary.failure_reason || "",
      assets_json: {
        visual_keywords: flattenedKeywords,
        search_queries: searchQueries,
        scene_queries: mergedSceneQueries,
        retrieval_budget: retrievalBudgetSummary,
        raw_items: mergedRawItems,
        approved_items: approvedItems,
        items: approvedItems,
        approved_windows: approvalResult.approved_windows || [],
        rejected_windows: approvalResult.rejected_windows || [],
        block_packages: mergedBlockPackages,
        slot_query_plan: mergedSlotQueryPlan,
        micro_visual_plan: microVisualPlan,
        slot_coverage_by_block: slotCoverageByBlock,
        micro_coverage_by_scene: approvalResult.micro_coverage_by_scene || [],
        micro_coverage_gaps: approvalResult.micro_coverage_gaps || [],
        block_candidate_funnel: finalizedFunnelWithCoverage,
        block_coverage_by_block: coverageGate.blocks || [],
        block_coverage_summary: coverageGate.summary || {},
        block_repair_states: localRepairPlan.block_states || [],
        local_repair_plan: localRepairPlan,
        editorial_asset_library_snapshot: librarySnapshot,
        editorial_bins_by_scene: approvalResult.editorial_bins_by_scene || {},
        editorial_metrics: editorialMetricsWithCoverage,
        scene_editorial_readiness: sceneEditorialReadiness,
        fallback_plan: mergedFallbackPlan,
        missing_assets: missingAssets,
        blocking_scene_indexes: readinessSummary.blocking_scene_indexes,
        scene_asset_readiness: readinessSummary.scene_asset_readiness,
        last_repair_plan_by_scene: mergedRepairPlanByScene,
        last_refresh_scene_indexes: refreshSceneIndexes,
        last_refresh_reason: refreshReason || (selectiveRefresh ? "scene_refresh" : "full_refresh"),
        last_refreshed_at: refreshedAt,
      },
      error_message: assetFailureMessage,
    },
    { currentStep: "assets_searched", status: "assets_searched" }
  );

  await sendWorkflowStatus({
    videoId,
    title: "Assets preparados",
    icon: "🖼️",
    lines: [
      `${approvedItems.length} asset(s) aprovados distribuídos em ${visualPlan.length} cena(s).`,
      `${approvedItems.filter((item) => item.asset_type === "video").length} vídeo(s) e ${approvedItems.filter((item) => item.asset_type !== "video").length} imagem(ns) aprovados.`,
      selectiveRefresh ? `Rebusca seletiva em ${refreshSceneIndexes.length} cena(s): ${refreshSceneIndexes.join(", ")}.` : null,
      missingAssets
        ? `Render bloqueado para ${readinessSummary.blocking_scene_indexes.length} cena(s) sem asset real: ${readinessSummary.blocking_scene_indexes.join(", ")}.`
        : "Pool editorial aprovado gerado com sucesso.",
    ],
  }).catch(() => null);

  return {
    video_id: videoId,
    assets_count: approvedItems.length,
    missing_assets: missingAssets,
    state_path: nextState.state_path,
    assets_json: nextState.assets_json,
    visual_plan: nextState.visual_plan,
    refreshed_scene_indexes: refreshSceneIndexes,
  };
};

const basicPexelsHealthcheck = async () => {
  if (!hasPexels()) {
    return { configured: false, ok: false, message: "PEXELS_API_KEY ausente" };
  }
  try {
    const response = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: config.PEXELS_API_KEY },
      params: { query: "travel city", per_page: 1 },
      timeout: 20000,
    });
    return {
      configured: true,
      ok: true,
      message: `Pexels respondeu com ${response.data?.photos?.length || 0} item(ns)`,
    };
  } catch (error) {
    return { configured: true, ok: false, message: error.message };
  }
};

const basicPixabayHealthcheck = async () => {
  if (!hasPixabay()) {
    return { configured: false, ok: false, message: "PIXABAY_API_KEY ausente" };
  }
  try {
    const response = await axios.get("https://pixabay.com/api/videos/", {
      params: { key: config.PIXABAY_API_KEY, q: "travel", per_page: 3 },
      timeout: 20000,
    });
    return {
      configured: true,
      ok: true,
      message: `Pixabay respondeu com ${response.data?.hits?.length || 0} vídeo(s)`,
    };
  } catch (error) {
    return { configured: true, ok: false, message: error.message };
  }
};

module.exports = {
  generateAssets,
  basicPexelsHealthcheck,
  basicPixabayHealthcheck,
  __test__: {
    filterSlotCandidatesByProviderPolicy,
    selectCoverageFirstFinalists,
    scoreCandidateForSlot,
    buildLibraryCandidatePoolForBlock,
    buildLocalCuratedCandidatesFromIndex,
    resolveAdaptiveBudgetProfile,
    computeMissingRequiredSlots,
    buildAutoRepairPlanByScene,
    shouldSkipCandidateByRepairConstraints,
  },
};
