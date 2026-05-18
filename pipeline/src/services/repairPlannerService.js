const { config } = require("../config/env");

const REPAIR_BLOCK_STATE = {
  STRONG: "strong",
  REPAIR_REQUIRED: "repair_required",
  DEGRADED: "degraded",
  BLOCKED: "blocked",
};

const unique = (values = []) => [...new Set((values || []).filter(Boolean))];
const normalize = (value = "") => String(value || "").toLowerCase().trim();

const buildSceneIndexByBlockId = ({ visualPlan = [], blockPackages = [] } = {}) => {
  const byBlock = new Map();
  (blockPackages || []).forEach((block) => {
    const key = String(block.block_id || "").trim();
    if (!key) return;
    byBlock.set(
      key,
      unique((block.scene_indexes || []).map((sceneIndex) => Number(sceneIndex || 0)).filter((sceneIndex) => sceneIndex > 0))
    );
  });
  (visualPlan || []).forEach((scene) => {
    const key = String(scene.block_id || `scene_${Number(scene.scene_index || 0)}`).trim();
    if (!key) return;
    const current = byBlock.get(key) || [];
    byBlock.set(
      key,
      unique([...current, Number(scene.scene_index || 0)].filter((sceneIndex) => sceneIndex > 0))
    );
  });
  return byBlock;
};

const buildSceneMetaByIndex = ({ visualPlan = [] } = {}) =>
  (visualPlan || []).reduce((acc, scene) => {
    const sceneIndex = Number(scene.scene_index || 0);
    if (!sceneIndex) return acc;
    acc[sceneIndex] = scene;
    return acc;
  }, {});

const inferFailureCausesForBlock = ({
  blockCoverage = {},
  funnelEntry = {},
  sceneReadiness = [],
  microCoverageGaps = [],
  lowDiversityBlocks = new Set(),
  blockId = "",
} = {}) => {
  const causes = [];
  const missingSlots = Array.isArray(blockCoverage.missing_slots) ? blockCoverage.missing_slots : [];
  const weakOnlySlots = Array.isArray(blockCoverage.weak_only_slots) ? blockCoverage.weak_only_slots : [];
  const excessSlots = Array.isArray(blockCoverage.excess_slots) ? blockCoverage.excess_slots : [];
  const coverageStatus = normalize(blockCoverage.coverage_status || "");
  const blockSceneReadiness = sceneReadiness.filter((scene) => String(scene.block_id || "").trim() === String(blockId || "").trim());
  const blockMicroGaps = microCoverageGaps.filter((gap) => String(gap.block_id || "").trim() === String(blockId || "").trim());
  const repeatedAssets = Number(funnelEntry.repeated_assets_in_block || 0);

  missingSlots.forEach((slot) => causes.push(`missing_${normalize(slot)}`));
  weakOnlySlots.forEach((slot) => causes.push(`weak_only_${normalize(slot)}`));
  excessSlots.forEach((slot) => causes.push(`too_much_${normalize(slot)}`));

  if (blockMicroGaps.some((gap) => normalize(gap.criticality || "") === "high" || gap.needs_visual_proof === true)) {
    causes.push("weak_phrase_alignment");
  }

  if (repeatedAssets > 0 || lowDiversityBlocks.has(String(blockId || "").trim())) {
    causes.push("repeated_visual_family");
  }

  if (blockSceneReadiness.some((scene) => (scene.blocking_reasons || []).includes("generic_exposure_too_high"))) {
    causes.push("too_much_city_context");
  }

  if (blockSceneReadiness.some((scene) =>
    (scene.blocking_reasons || []).includes("critical_slots_uncovered")
    && Number(scene.exact_windows || 0) === 0
    && Number(scene.regional_windows || 0) === 0
    && Number(scene.generic_windows || 0) > 0
  )) {
    causes.push("critical_slot_only_generic");
  }

  if (
    blockSceneReadiness.some((scene) =>
      String(scene.visual_intent || "").toLowerCase().includes("wine")
      && ((scene.blocking_reasons || []).includes("no_proof_for_promise") || (scene.blocking_reasons || []).includes("missing_micro_visual_proof"))
    )
  ) {
    causes.push("missing_closing_proof");
  }

  if (coverageStatus === "insufficient" && !missingSlots.length && !weakOnlySlots.length) {
    causes.push("coverage_insufficient_unknown_gap");
  }

  return unique(causes);
};

const buildRepairHintsFromCauses = ({ causes = [] } = {}) => {
  const targetMicroNeeds = [];
  const microRepairQueries = [];
  const diversityRepairQueries = [];
  const extraNegativeKeywords = [];
  const targetNarrativeRoles = [];

  causes.forEach((cause) => {
    if (cause.startsWith("missing_")) {
      const slotType = cause.replace("missing_", "").trim();
      if (slotType) {
        targetMicroNeeds.push(slotType);
        microRepairQueries.push(`${slotType.replace(/_/g, " ")} authentic real action`);
        targetNarrativeRoles.push("proof_exact", "detail_cutaway");
      }
      return;
    }
    if (cause.startsWith("weak_only_")) {
      const slotType = cause.replace("weak_only_", "").trim();
      if (slotType) {
        targetMicroNeeds.push(slotType);
        microRepairQueries.push(`${slotType.replace(/_/g, " ")} close up authentic evidence`);
      }
      return;
    }
    if (cause.startsWith("too_much_")) {
      const slotType = cause.replace("too_much_", "").trim();
      extraNegativeKeywords.push(slotType.replace(/_/g, " "), "generic overview only");
      targetNarrativeRoles.push("proof_exact", "detail_cutaway");
      return;
    }
    switch (cause) {
      case "weak_phrase_alignment":
        targetNarrativeRoles.push("proof_exact", "detail_cutaway");
        break;
      case "repeated_visual_family":
        diversityRepairQueries.push("authentic local human interaction", "different angle detailed close up");
        extraNegativeKeywords.push("same angle", "same landmark", "repeated skyline");
        break;
      case "too_much_city_context":
        extraNegativeKeywords.push("generic skyline", "aerial city only", "bridge wide shot");
        targetNarrativeRoles.push("proof_exact");
        break;
      case "missing_closing_proof":
        targetNarrativeRoles.push("closing_payoff", "proof_exact");
        microRepairQueries.push("closing payoff authentic local proof");
        break;
      case "critical_slot_only_generic":
        targetNarrativeRoles.push("hook_exact", "opening_establishing", "proof_exact", "closing_payoff");
        extraNegativeKeywords.push("generic travel footage", "overview only");
        break;
      default:
        break;
    }
  });

  return {
    target_micro_needs: unique(targetMicroNeeds),
    micro_repair_queries: unique(microRepairQueries),
    diversity_repair_queries: unique(diversityRepairQueries),
    extra_negative_keywords: unique(extraNegativeKeywords),
    target_narrative_roles: unique(targetNarrativeRoles),
    force_exact_required: true,
  };
};

const resolveBlockState = ({
  blockCoverage = {},
  repairRoundsUsed = 0,
  maxRepairRounds = Number(config.REPAIR_PLANNER_MAX_LOCAL_ROUNDS || 2),
  allowPartialDegrade = Boolean(config.COVERAGE_GATE_ALLOW_PARTIAL),
} = {}) => {
  const coverageStatus = normalize(blockCoverage.coverage_status || "");
  const needsRepair = blockCoverage.needs_repair === true;
  const canAdvance = blockCoverage.can_advance === true;
  const maxRoundsReached = Number(repairRoundsUsed || 0) >= Number(maxRepairRounds || 2);

  if (coverageStatus === "strong") return REPAIR_BLOCK_STATE.STRONG;
  if (needsRepair && !maxRoundsReached) return REPAIR_BLOCK_STATE.REPAIR_REQUIRED;
  if (coverageStatus === "partial" && allowPartialDegrade && canAdvance) return REPAIR_BLOCK_STATE.DEGRADED;
  return REPAIR_BLOCK_STATE.BLOCKED;
};

const buildLocalRepairPlan = ({
  state = {},
  selectedSceneIndexes = [],
} = {}) => {
  const assetsJson = state.assets_json || {};
  const blockCoverage = Array.isArray(assetsJson.block_coverage_by_block) ? assetsJson.block_coverage_by_block : [];
  const funnelByBlock = (assetsJson.block_candidate_funnel || []).reduce((acc, item) => {
    const key = String(item.block_id || "").trim();
    if (!key) return acc;
    acc[key] = item;
    return acc;
  }, {});
  const sceneReadiness = Array.isArray(assetsJson.scene_editorial_readiness) ? assetsJson.scene_editorial_readiness : [];
  const microCoverageGaps = Array.isArray(assetsJson.micro_coverage_gaps) ? assetsJson.micro_coverage_gaps : [];
  const lowDiversityBlocks = new Set(
    Array.isArray(state.render_timeline?.timeline_sync_metrics?.low_diversity_blocks)
      ? state.render_timeline.timeline_sync_metrics.low_diversity_blocks.map((item) => String(item || "").trim()).filter(Boolean)
      : []
  );
  const visualPlan = Array.isArray(state.visual_plan) ? state.visual_plan : [];
  const blockPackages = Array.isArray(assetsJson.block_packages) ? assetsJson.block_packages : [];
  const sceneIndexesByBlock = buildSceneIndexByBlockId({ visualPlan, blockPackages });
  const sceneMetaByIndex = buildSceneMetaByIndex({ visualPlan });
  const selectedSet = new Set((selectedSceneIndexes || []).map((sceneIndex) => Number(sceneIndex || 0)).filter((sceneIndex) => sceneIndex > 0));
  const maxRepairRounds = Number(config.REPAIR_PLANNER_MAX_LOCAL_ROUNDS || 2);
  const allowPartialDegrade = Boolean(config.COVERAGE_GATE_ALLOW_PARTIAL);

  const byBlock = blockCoverage.map((entry) => {
    const blockId = String(entry.block_id || "").trim();
    const funnel = funnelByBlock[blockId] || {};
    const repairRoundsUsed = Number(funnel.repair_rounds_used || 0);
    const stateValue = resolveBlockState({
      blockCoverage: entry,
      repairRoundsUsed,
      maxRepairRounds,
      allowPartialDegrade,
    });
    const causes = inferFailureCausesForBlock({
      blockCoverage: entry,
      funnelEntry: funnel,
      sceneReadiness,
      microCoverageGaps,
      lowDiversityBlocks,
      blockId,
    });
    const sceneIndexes = sceneIndexesByBlock.get(blockId) || [];
    return {
      block_id: blockId,
      package_id: entry.package_id || "",
      intent: entry.intent || "",
      scene_indexes: sceneIndexes,
      block_state: stateValue,
      coverage_status: entry.coverage_status || "",
      causes,
      repair_rounds_used: repairRoundsUsed,
      max_repair_rounds: maxRepairRounds,
      needs_repair: stateValue === REPAIR_BLOCK_STATE.REPAIR_REQUIRED,
    };
  });

  const repairByScene = [];
  byBlock
    .filter((block) => block.block_state === REPAIR_BLOCK_STATE.REPAIR_REQUIRED)
    .forEach((block) => {
      const hints = buildRepairHintsFromCauses({ causes: block.causes });
      (block.scene_indexes || []).forEach((sceneIndex) => {
        const sceneNumber = Number(sceneIndex || 0);
        if (!sceneNumber) return;
        if (selectedSet.size && !selectedSet.has(sceneNumber)) return;
        const scene = sceneMetaByIndex[sceneNumber] || {};
        repairByScene.push({
          scene_index: sceneNumber,
          block_id: block.block_id,
          block_state: block.block_state,
          failure_codes: block.causes,
          repair_actions: unique([
            block.causes.some((cause) => cause.startsWith("missing_")) ? "search_slot_gap" : "",
            block.causes.some((cause) => cause === "weak_phrase_alignment") ? "recut_timing_window" : "",
            block.causes.some((cause) => cause === "repeated_visual_family") ? "diversify_visual_family" : "",
            block.causes.some((cause) => cause === "missing_closing_proof") ? "force_closing_proof" : "",
          ]),
          ...hints,
          visual_intent: scene.visual_intent || "",
        });
      });
    });

  const blockedSceneIndexes = unique(
    byBlock
      .filter((block) => block.block_state === REPAIR_BLOCK_STATE.BLOCKED)
      .flatMap((block) => block.scene_indexes || [])
      .map((sceneIndex) => Number(sceneIndex || 0))
      .filter((sceneIndex) => sceneIndex > 0)
  );
  const repairSceneIndexes = unique(
    repairByScene
      .map((entry) => Number(entry.scene_index || 0))
      .filter((sceneIndex) => sceneIndex > 0)
  );
  const repairOutcomes = byBlock
    .filter((block) => block.causes.length || block.block_state !== REPAIR_BLOCK_STATE.STRONG)
    .map((block) => {
      const hints = buildRepairHintsFromCauses({ causes: block.causes });
      const attemptedActions = unique([
        block.causes.some((cause) => cause.startsWith("missing_") || cause.startsWith("weak_only_")) ? "search_slot_gap" : "",
        block.causes.includes("weak_phrase_alignment") ? "recut_timing_window" : "",
        block.causes.includes("repeated_visual_family") ? "diversify_visual_family" : "",
        block.causes.some((cause) => cause.startsWith("too_much_")) ? "tighten_negative_keywords" : "",
        block.causes.includes("critical_slot_only_generic") ? "force_exact_critical_slot" : "",
        block.causes.includes("missing_closing_proof") ? "force_closing_proof" : "",
      ]);
      return {
        block_id: block.block_id,
        failure_codes: block.causes,
        attempted_actions: attemptedActions,
        recovered: block.block_state === REPAIR_BLOCK_STATE.STRONG,
        remaining_gap: block.block_state !== REPAIR_BLOCK_STATE.STRONG,
        block_state: block.block_state,
        cost_budget_used: {
          repair_rounds_used: block.repair_rounds_used,
          max_repair_rounds: block.max_repair_rounds,
        },
        repair_hints: hints,
      };
    });

  return {
    generated_at: new Date().toISOString(),
    max_repair_rounds: maxRepairRounds,
    block_states: byBlock,
    repair_by_scene: repairByScene,
    repair_outcomes: repairOutcomes,
    scene_indexes_to_refresh: repairSceneIndexes,
    blocked_scene_indexes: blockedSceneIndexes,
    summary: {
      total_blocks: byBlock.length,
      strong_blocks: byBlock.filter((block) => block.block_state === REPAIR_BLOCK_STATE.STRONG).length,
      repair_required_blocks: byBlock.filter((block) => block.block_state === REPAIR_BLOCK_STATE.REPAIR_REQUIRED).length,
      degraded_blocks: byBlock.filter((block) => block.block_state === REPAIR_BLOCK_STATE.DEGRADED).length,
      blocked_blocks: byBlock.filter((block) => block.block_state === REPAIR_BLOCK_STATE.BLOCKED).length,
    },
  };
};

module.exports = {
  REPAIR_BLOCK_STATE,
  buildLocalRepairPlan,
  __test__: {
    inferFailureCausesForBlock,
    buildRepairHintsFromCauses,
    resolveBlockState,
  },
};
