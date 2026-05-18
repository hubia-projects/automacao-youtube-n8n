const unique = (values = []) => [...new Set((values || []).filter(Boolean))];

const ISSUE_TO_FAILURE_CODE = {
  uncertain_in_critical_slot: "CRITICAL_SLOT_UNCERTAIN",
  critical_slot_not_visually_confirmed: "CRITICAL_SLOT_NOT_CONFIRMED",
  hard_boundary_first_clip_not_visually_confirmed: "HARD_BOUNDARY_FIRST_CLIP_INVALID",
  timeline_not_using_approved_pool: "TIMELINE_OUTSIDE_APPROVED_POOL",
  generic_asset_overuse: "GENERIC_OVERUSE",
  wrong_visual_category: "WRONG_VISUAL_CATEGORY",
  scene_theme_coverage_missing: "THEME_COVERAGE_MISSING",
  critical_scene_theme_coverage_missing: "THEME_COVERAGE_MISSING",
  runtime_degradation_used: "RUNTIME_DEGRADATION_USED",
  theme_visual_mismatch: "THEME_VISUAL_MISMATCH",
  no_proof_for_promise: "NO_PROOF_FOR_PROMISE",
  low_diversity_block: "LOW_DIVERSITY_BLOCK",
  adjacent_visual_repetition: "LOW_DIVERSITY_BLOCK",
  block_coverage_insufficient: "BLOCK_COVERAGE_INSUFFICIENT",
  block_coverage_partial: "BLOCK_COVERAGE_PARTIAL",
  micro_proof_missing: "NO_MICRO_PROOF_FOR_PROMISE",
  micro_timing_drift_exceeded: "MICRO_TIMING_DRIFT_EXCEEDED",
};

const buildRepairActionFromCode = (failureCode = "") => {
  switch (failureCode) {
    case "CRITICAL_SLOT_UNCERTAIN":
    case "CRITICAL_SLOT_NOT_CONFIRMED":
      return {
        target_narrative_roles: ["hook_exact", "opening_establishing", "proof_exact", "closing_payoff"],
        enforce_source_tier: ["premium", "curated"],
        force_exact_required: true,
        extra_negative_keywords: ["skyline", "drone", "aerial", "coast", "bridge", "river", "generic street"],
        diversity_repair_queries: [],
      };
    case "NO_PROOF_FOR_PROMISE":
      return {
        target_narrative_roles: ["proof_exact"],
        enforce_source_tier: ["premium", "curated", "free"],
        force_exact_required: true,
        extra_negative_keywords: ["generic travel", "overview", "cityscape"],
        diversity_repair_queries: [],
      };
    case "GENERIC_OVERUSE":
    case "WRONG_VISUAL_CATEGORY":
    case "THEME_COVERAGE_MISSING":
    case "RUNTIME_DEGRADATION_USED":
      return {
        target_narrative_roles: ["proof_exact", "detail_cutaway"],
        enforce_source_tier: ["curated", "premium", "free"],
        force_exact_required: true,
        extra_negative_keywords: ["skyline", "aerial", "coast", "river", "bridge"],
        diversity_repair_queries: [],
      };
    case "LOW_DIVERSITY_BLOCK":
      return {
        target_narrative_roles: ["proof_exact", "detail_cutaway", "context_regional"],
        enforce_source_tier: ["curated", "premium", "free"],
        force_exact_required: true,
        extra_negative_keywords: ["same landmark", "same angle", "drone skyline", "generic establishing only", "wide city repeat"],
        diversity_repair_queries: [
          "authentic local human interaction",
          "close up detail local product",
          "street level dynamic people scene",
        ],
      };
    case "BLOCK_COVERAGE_INSUFFICIENT":
    case "BLOCK_COVERAGE_PARTIAL":
      return {
        target_narrative_roles: ["proof_exact", "detail_cutaway", "context_regional"],
        enforce_source_tier: ["premium", "curated", "free"],
        force_exact_required: true,
        extra_negative_keywords: ["generic travel", "overview", "aerial skyline", "bridge only", "coast only"],
        diversity_repair_queries: [
          "authentic local food close up",
          "human interaction local scene",
          "vendor preparing serving",
        ],
      };
    case "NO_MICRO_PROOF_FOR_PROMISE":
      return {
        target_narrative_roles: ["proof_exact", "detail_cutaway"],
        enforce_source_tier: ["premium", "curated", "free"],
        force_exact_required: true,
        extra_negative_keywords: ["generic travel", "skyline", "aerial", "bridge", "river", "overview"],
        diversity_repair_queries: [],
      };
    case "MICRO_TIMING_DRIFT_EXCEEDED":
      return {
        target_narrative_roles: ["proof_exact", "detail_cutaway", "closing_payoff"],
        enforce_source_tier: ["curated", "premium", "free"],
        force_exact_required: true,
        extra_negative_keywords: ["timelapse", "slow panorama", "wide skyline only"],
        diversity_repair_queries: [],
      };
    case "HARD_BOUNDARY_FIRST_CLIP_INVALID":
      return {
        target_narrative_roles: ["opening_establishing", "proof_exact", "context_regional"],
        enforce_source_tier: ["premium", "curated", "free"],
        force_exact_required: true,
        extra_negative_keywords: ["generic skyline", "no people", "aerial only", "timelapse city"],
        diversity_repair_queries: ["street level local identity", "recognizable city context with people"],
      };
    default:
      return {
        target_narrative_roles: ["proof_exact", "context_regional"],
        enforce_source_tier: ["curated", "premium", "free"],
        force_exact_required: false,
        extra_negative_keywords: [],
        diversity_repair_queries: [],
      };
  }
};

const buildEditorialRegenerationPlan = ({
  issues = [],
  sceneIndexesToRefresh = [],
  sceneEditorialReadiness = [],
} = {}) => {
  const failureCodes = unique(
    issues
      .map((issue) => ISSUE_TO_FAILURE_CODE[issue.type] || "")
      .filter(Boolean)
  );

  const microNeedsByScene = {};
  (issues || []).forEach((issue) => {
    const needsByScene = issue?.micro_needs_by_scene || {};
    Object.entries(needsByScene).forEach(([sceneKey, needs]) => {
      const sceneIndex = Number(sceneKey || 0);
      if (!sceneIndex) return;
      const existing = microNeedsByScene[sceneIndex] || [];
      microNeedsByScene[sceneIndex] = unique([
        ...existing,
        ...((Array.isArray(needs) ? needs : []).map((item) => String(item || "").trim()).filter(Boolean)),
      ]);
    });
  });

  const blockedScenes = unique(
    (sceneEditorialReadiness || [])
      .filter((scene) => scene.blocking === true || (scene.blocking_reasons || []).length > 0)
      .map((scene) => Number(scene.scene_index || 0))
      .filter((index) => index > 0)
  );

  const targetSceneIndexes = unique([
    ...(sceneIndexesToRefresh || []).map((index) => Number(index || 0)).filter((index) => index > 0),
    ...blockedScenes,
    ...Object.keys(microNeedsByScene).map((sceneKey) => Number(sceneKey || 0)).filter((index) => index > 0),
  ]);

  const repairByScene = targetSceneIndexes.map((sceneIndex) => {
    const sceneReadiness = (sceneEditorialReadiness || []).find((scene) => Number(scene.scene_index || 0) === sceneIndex) || {};
    const sceneFailureCodes = unique([
      ...failureCodes,
      ...(sceneReadiness.blocking_reasons || []).map((reason) => {
        if (reason === "missing_exact_for_required_proof" || reason === "no_proof_for_promise") return "NO_PROOF_FOR_PROMISE";
        if (reason === "generic_exposure_too_high") return "GENERIC_OVERUSE";
        if (reason === "critical_slots_uncovered") return "CRITICAL_SLOT_NOT_CONFIRMED";
        if (reason === "missing_theme_visual_proof") return "THEME_COVERAGE_MISSING";
        return "";
      }).filter(Boolean),
    ]);

    const actions = sceneFailureCodes.map((code) => buildRepairActionFromCode(code));
    return {
      scene_index: sceneIndex,
      failure_codes: sceneFailureCodes,
      target_narrative_roles: unique(actions.flatMap((action) => action.target_narrative_roles || [])),
      target_micro_needs: unique(microNeedsByScene[sceneIndex] || []),
      enforce_source_tier: unique(actions.flatMap((action) => action.enforce_source_tier || [])),
      force_exact_required: actions.some((action) => action.force_exact_required === true),
      extra_negative_keywords: unique(actions.flatMap((action) => action.extra_negative_keywords || [])),
      diversity_repair_queries: unique(actions.flatMap((action) => action.diversity_repair_queries || [])),
      micro_repair_queries: unique((microNeedsByScene[sceneIndex] || []).map((need) => `${String(need).replace(/_/g, " ")} authentic real action`)),
      preferred_providers: actions.some((action) => (action.enforce_source_tier || []).includes("premium"))
        ? ["shutterstock", "artgrid", "storyblocks", "getty", "adobestock", "pond5", "envato", "istock"]
        : [],
    };
  });

  return {
    scene_indexes_to_refresh: targetSceneIndexes,
    failure_codes: failureCodes,
    repair_by_scene: repairByScene,
  };
};

module.exports = {
  buildEditorialRegenerationPlan,
  __test__: {
    buildEditorialRegenerationPlan,
    buildRepairActionFromCode,
  },
};
