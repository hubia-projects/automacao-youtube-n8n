const { FOOD_VISUAL_INTENTS } = require("../config/editorialPolicy");

const unique = (values = []) => [...new Set((values || []).filter(Boolean))];
const normalize = (value = "") => String(value || "").toLowerCase().trim();
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
const resolveClipBlockScopeId = (clip = {}) =>
  String(
    clip.macro_block_id
    || clip.block_scope_id
    || clip.block_id
    || clip.scene_index
    || ""
  ).trim();

const DIVERSITY_POLICY_BY_INTENT = {
  gastronomy: {
    recent_window_size: 3,
    max_same_visual_family_per_block: 2,
    max_same_landmark_per_block: 2,
    max_same_source_per_block: 1,
    max_context_clips_before_proof: 1,
    min_unique_families_per_block: 4,
    min_required_scene_functions: ["proof", "human_action", "detail"],
  },
  wine: {
    recent_window_size: 3,
    max_same_visual_family_per_block: 2,
    max_same_landmark_per_block: 2,
    max_same_source_per_block: 1,
    max_context_clips_before_proof: 1,
    min_unique_families_per_block: 3,
    min_required_scene_functions: ["proof", "detail"],
  },
  default: {
    recent_window_size: 3,
    max_same_visual_family_per_block: 2,
    max_same_landmark_per_block: 2,
    max_same_source_per_block: 1,
    max_context_clips_before_proof: 2,
    min_unique_families_per_block: 3,
    min_required_scene_functions: ["proof", "detail"],
  },
};

const ROLE_TO_SCENE_FUNCTION = {
  hook_exact: "context",
  opening_establishing: "context",
  proof_exact: "proof",
  context_regional: "context",
  detail_cutaway: "detail",
  bridge_neutral_short: "transition",
  closing_payoff: "payoff",
};

const SLOT_TO_SCENE_FUNCTION = {
  food_closeup: "proof",
  pastry_closeup: "proof",
  wine_pouring: "proof",
  wine_tasting: "proof",
  market_stall: "proof",
  local_product: "detail",
  people_eating: "human_action",
  vendor_interaction: "human_action",
  chef_or_vendor: "human_action",
  city_context: "context",
  street_level: "context",
  wide_establishing: "context",
  transition_broll: "transition",
  fallback_safe: "transition",
};

const resolveDiversityPolicy = (block = {}) => {
  const intent = normalize(block.visual_intent || block.scene_visual_intent || "");
  if (DIVERSITY_POLICY_BY_INTENT[intent]) return DIVERSITY_POLICY_BY_INTENT[intent];
  if (FOOD_VISUAL_INTENTS.has(intent)) return DIVERSITY_POLICY_BY_INTENT.gastronomy;
  return DIVERSITY_POLICY_BY_INTENT.default;
};

const normalizeLandmark = (candidate = {}) => {
  const first = (candidate.landmarks || [])[0];
  const name = normalize(first?.name || first || "");
  const city = normalize(first?.city || candidate.location?.city || "");
  const key = `${name}|${city}`.replace(/\|+$/, "").trim();
  return key || "";
};

const normalizeShotScale = (candidate = {}) => {
  const shot = normalize(candidate.visual_features?.shot_type || candidate.shot_type || "");
  if (!shot) return "unknown";
  if (shot.includes("close")) return "closeup";
  if (shot.includes("wide") || shot.includes("aerial") || shot.includes("establish")) return "wide";
  if (shot.includes("medium")) return "medium";
  return shot;
};

const classifySceneFunction = ({ candidate = {}, slotRole = "" } = {}) => {
  const slotType = normalize(candidate.content_slot_type || candidate.slot_type || "");
  if (SLOT_TO_SCENE_FUNCTION[slotType]) return SLOT_TO_SCENE_FUNCTION[slotType];
  const role = normalize(slotRole || candidate.narrative_role_selected || "");
  if (ROLE_TO_SCENE_FUNCTION[role]) return ROLE_TO_SCENE_FUNCTION[role];
  if (candidate.visual_features?.has_people) return "human_action";
  return "context";
};

const classifyVisualFamily = ({ candidate = {}, slotRole = "" } = {}) => {
  const slotType = normalize(candidate.content_slot_type || candidate.slot_type || "");
  const sceneFunction = classifySceneFunction({ candidate, slotRole });
  const shotScale = normalizeShotScale(candidate);
  const topCategory = normalize((candidate.detected_visual_categories || [])[0] || candidate.location_type || "");
  const topObject = normalize((candidate.detected_objects || [])[0] || "");
  const anchor = slotType || topCategory || topObject || sceneFunction || "unknown";
  return `${anchor}|${shotScale}|${sceneFunction}`;
};

const buildProviderSignature = (candidate = {}) => {
  const provider = normalize(candidate.source || candidate.asset?.provider || "unknown");
  const sourceUrl = candidate.asset?.source_url || candidate.source_url || "";
  const assetId = candidate.asset_id || "";
  return `${provider}|${sourceUrl || assetId}`;
};

const enrichCandidateIdentity = ({ candidate = {}, slotRole = "", block = {} } = {}) => {
  const sceneFunction = classifySceneFunction({ candidate, slotRole });
  const visualFamily = classifyVisualFamily({ candidate, slotRole });
  const landmarkId = normalizeLandmark(candidate);
  const sourceUrl = candidate.asset?.source_url || candidate.source_url || "";
  const humanPresence = Boolean(candidate.visual_features?.has_people);

  return {
    ...candidate,
    scene_function: candidate.scene_function || sceneFunction,
    visual_family: candidate.visual_family || visualFamily,
    landmark_id: candidate.landmark_id || landmarkId,
    shot_scale: candidate.shot_scale || normalizeShotScale(candidate),
    human_presence: candidate.human_presence ?? humanPresence,
    color_mood: candidate.color_mood || normalize((candidate.visual_features?.dominant_colors || [])[0] || ""),
    provider_signature: candidate.provider_signature || buildProviderSignature(candidate),
    source_url: sourceUrl || candidate.source_url || "",
    block_id: candidate.block_id || block.block_id || block.id || "",
  };
};

const countBy = (items = [], getter = () => "") =>
  (items || []).reduce((acc, item) => {
    const key = normalize(getter(item));
    if (!key) return acc;
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});

const evaluateCandidateHardDiversity = ({
  candidate = {},
  recentBlockClips = [],
  blockClips = [],
  block = {},
  slotRole = "",
  criticalSlot = false,
} = {}) => {
  const policy = resolveDiversityPolicy(block);
  const violations = [];
  const recentWindow = [...recentBlockClips].slice(-Math.max(1, Number(policy.recent_window_size || 3)));
  const recentFamilies = recentWindow.map((clip) => normalize(clip.visual_family));
  const recentLandmarks = recentWindow.map((clip) => normalize(clip.landmark_id));
  const recentFunctions = recentWindow.map((clip) => normalize(clip.scene_function));

  const family = normalize(candidate.visual_family);
  const landmark = normalize(candidate.landmark_id);
  const assetId = String(candidate.asset_id || "").trim();
  const sourceUrl = String(candidate.source_url || candidate.asset?.source_url || "").trim();
  const functionName = normalize(candidate.scene_function || classifySceneFunction({ candidate, slotRole }));
  const recentFamilyRepeatCount = family ? recentFamilies.filter((item) => item === family).length : 0;
  const recentAssetReuseCount = assetId
    ? recentWindow.filter((clip) => {
      const clipAssetId = String(clip.asset_id || clip.source_asset_id || clip.asset?.asset_id || "").trim();
      return clipAssetId && clipAssetId === assetId;
    }).length
    : 0;

  if (family && recentFamilyRepeatCount >= (criticalSlot ? 2 : 1)) {
    violations.push("repeat_visual_family_recent");
  }
  if (landmark && recentLandmarks.filter((item) => item === landmark).length >= 1) {
    violations.push("repeat_landmark_recent");
  }
  if (!criticalSlot && recentFunctions.length >= 2 && recentFunctions.slice(-2).every((item) => item === functionName)) {
    violations.push("stagnant_scene_function_chain");
  }
  if (assetId && recentAssetReuseCount >= 1) {
    violations.push("same_asset_reuse_block");
  }

  const sourceCountByBlock = blockClips.filter((clip) => normalize(clip.source_url) === normalize(sourceUrl)).length;
  const maxSameSourcePerBlock = Number(policy.max_same_source_per_block || 1);
  const sourceOveruseThreshold = criticalSlot ? maxSameSourcePerBlock + 1 : maxSameSourcePerBlock;
  if (sourceUrl && sourceCountByBlock >= sourceOveruseThreshold) {
    violations.push("source_overuse_block");
  }

  const familyCountByBlock = blockClips.filter((clip) => normalize(clip.visual_family) === family).length;
  if (criticalSlot && family && familyCountByBlock >= 2) {
    violations.push("critical_slot_visual_family_reuse_block");
  }
  if (family && familyCountByBlock >= Number(policy.max_same_visual_family_per_block || 2)) {
    violations.push("visual_family_overuse_block");
  }

  const landmarkCountByBlock = landmark
    ? blockClips.filter((clip) => normalize(clip.landmark_id) === landmark).length
    : 0;
  if (landmark && landmarkCountByBlock >= Number(policy.max_same_landmark_per_block || 2)) {
    violations.push("landmark_overuse_block");
  }

  const blockFunctions = countBy(blockClips, (clip) => clip.scene_function);
  if (
    functionName === "context"
    && Number(blockFunctions.proof || 0) === 0
    && Number(blockFunctions.context || 0) >= Number(policy.max_context_clips_before_proof || 1)
  ) {
    violations.push("context_before_proof_limit");
  }

  if (criticalSlot) {
    const previousClip = recentWindow[recentWindow.length - 1] || null;
    if (previousClip && normalize(previousClip.visual_family) === family) {
      violations.push("critical_slot_adjacent_family_repeat");
    }
    if (previousClip && normalize(previousClip.source_url) && normalize(previousClip.source_url) === normalize(sourceUrl)) {
      violations.push("critical_slot_adjacent_source_repeat");
    }
  }

  return {
    allowed: violations.length === 0,
    violations: unique(violations),
  };
};

const filterCandidatesByHardDiversity = ({
  candidates = [],
  clips = [],
  block = {},
  slotRole = "",
  criticalSlot = false,
} = {}) => {
  const blockId = resolveBlockScopeId(block);
  const blockClips = (clips || []).filter((clip) => resolveClipBlockScopeId(clip) === blockId);
  const recentBlockClips = blockClips.slice(-4);
  const allowed = [];
  const blocked = [];

  (candidates || []).forEach((candidate) => {
    const enriched = enrichCandidateIdentity({ candidate, slotRole, block });
    const decision = evaluateCandidateHardDiversity({
      candidate: enriched,
      recentBlockClips,
      blockClips,
      block,
      slotRole,
      criticalSlot,
    });
    if (decision.allowed) {
      allowed.push(enriched);
      return;
    }
    blocked.push({
      candidate: enriched,
      violations: decision.violations,
    });
  });

  return {
    allowed_candidates: allowed,
    blocked_candidates: blocked,
    bypass_required: allowed.length === 0 && (candidates || []).length > 0,
  };
};

const buildBlockDiversityAudit = ({ clips = [], block = {} } = {}) => {
  const blockId = resolveBlockScopeId(block);
  const blockClips = (clips || []).filter((clip) => resolveClipBlockScopeId(clip) === blockId);
  const policy = resolveDiversityPolicy(block);
  const families = unique(blockClips.map((clip) => normalize(clip.visual_family)));
  const landmarks = unique(blockClips.map((clip) => normalize(clip.landmark_id)));
  const sources = unique(blockClips.map((clip) => normalize(clip.source_url)));
  const functions = countBy(blockClips, (clip) => clip.scene_function);
  const adjacentRepeats = blockClips.reduce((acc, clip, index) => {
    if (index === 0) return acc;
    const previous = blockClips[index - 1];
    if (normalize(clip.visual_family) === normalize(previous.visual_family)) acc.visual_family += 1;
    if (normalize(clip.landmark_id) && normalize(clip.landmark_id) === normalize(previous.landmark_id)) acc.landmark += 1;
    if (normalize(clip.source_url) && normalize(clip.source_url) === normalize(previous.source_url)) acc.source += 1;
    if (normalize(clip.scene_function) === normalize(previous.scene_function)) acc.scene_function += 1;
    return acc;
  }, { visual_family: 0, landmark: 0, source: 0, scene_function: 0 });

  const missingFunctions = (policy.min_required_scene_functions || [])
    .filter((sceneFunction) => Number(functions[normalize(sceneFunction)] || 0) <= 0);
  const lowDiversity = Boolean(
    families.length < Number(policy.min_unique_families_per_block || 3)
    || missingFunctions.length > 0
    || Number(adjacentRepeats.visual_family || 0) > 1
  );

  return {
    block_id: String(block.block_id || blockId),
    intent: normalize(block.visual_intent || ""),
    total_clips: blockClips.length,
    unique_visual_families: families.length,
    unique_landmarks: landmarks.filter(Boolean).length,
    unique_sources: sources.filter(Boolean).length,
    scene_function_distribution: functions,
    adjacent_repetition: adjacentRepeats,
    min_unique_families_required: Number(policy.min_unique_families_per_block || 3),
    required_scene_functions: policy.min_required_scene_functions || [],
    missing_scene_functions: missingFunctions,
    low_diversity_block: lowDiversity,
  };
};

const buildTimelineDiversityAudit = ({ clips = [], microBlocks = [] } = {}) => {
  const hasDeclaredBlocks = Array.isArray(microBlocks) && microBlocks.length > 0;
  const fallbackBlocks = !hasDeclaredBlocks
    ? unique((clips || []).map((clip) => resolveClipBlockScopeId(clip)).filter(Boolean))
      .map((blockId) => {
        const first = (clips || []).find((clip) => resolveClipBlockScopeId(clip) === blockId) || {};
        return {
          block_id: String(first.block_id || blockId),
          macro_block_id: String(first.macro_block_id || blockId),
          scene_index: Number(first.scene_index || 0),
          visual_intent: String(first.visual_intent || ""),
        };
      })
    : [];
  const targetBlocks = hasDeclaredBlocks ? microBlocks : fallbackBlocks;
  const byBlock = (targetBlocks || []).map((block) => buildBlockDiversityAudit({ clips, block }));
  const lowDiversityBlocks = byBlock.filter((item) => item.low_diversity_block).map((item) => item.block_id);
  return {
    blocks: byBlock,
    low_diversity_block_count: lowDiversityBlocks.length,
    low_diversity_blocks: lowDiversityBlocks,
    adjacent_repeat_total: byBlock.reduce((acc, item) => acc + Number(item.adjacent_repetition?.visual_family || 0), 0),
  };
};

module.exports = {
  resolveDiversityPolicy,
  enrichCandidateIdentity,
  filterCandidatesByHardDiversity,
  buildTimelineDiversityAudit,
  __test__: {
    classifyVisualFamily,
    classifySceneFunction,
    evaluateCandidateHardDiversity,
    buildBlockDiversityAudit,
  },
};
