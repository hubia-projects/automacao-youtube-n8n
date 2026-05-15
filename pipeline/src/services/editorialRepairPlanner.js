const unique = (values = []) => [...new Set((values || []).filter(Boolean))];

const ISSUE_TO_FAILURE_CODE = {
  uncertain_in_critical_slot: "CRITICAL_SLOT_UNCERTAIN",
  critical_slot_not_visually_confirmed: "CRITICAL_SLOT_NOT_CONFIRMED",
  hard_boundary_first_clip_not_visually_confirmed: "HARD_BOUNDARY_FIRST_CLIP_INVALID",
  timeline_not_using_approved_pool: "TIMELINE_OUTSIDE_APPROVED_POOL",
  generic_asset_overuse: "GENERIC_OVERUSE",
  wrong_visual_category: "WRONG_VISUAL_CATEGORY",
  theme_visual_mismatch: "THEME_VISUAL_MISMATCH",
  no_proof_for_promise: "NO_PROOF_FOR_PROMISE",
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
      };
    case "NO_PROOF_FOR_PROMISE":
      return {
        target_narrative_roles: ["proof_exact"],
        enforce_source_tier: ["premium", "curated", "free"],
        force_exact_required: true,
        extra_negative_keywords: ["generic travel", "overview", "cityscape"],
      };
    case "GENERIC_OVERUSE":
    case "WRONG_VISUAL_CATEGORY":
      return {
        target_narrative_roles: ["proof_exact", "detail_cutaway"],
        enforce_source_tier: ["curated", "premium", "free"],
        force_exact_required: true,
        extra_negative_keywords: ["skyline", "aerial", "coast", "river", "bridge"],
      };
    default:
      return {
        target_narrative_roles: ["proof_exact", "context_regional"],
        enforce_source_tier: ["curated", "premium", "free"],
        force_exact_required: false,
        extra_negative_keywords: [],
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

  const blockedScenes = unique(
    (sceneEditorialReadiness || [])
      .filter((scene) => scene.blocking === true || (scene.blocking_reasons || []).length > 0)
      .map((scene) => Number(scene.scene_index || 0))
      .filter((index) => index > 0)
  );

  const targetSceneIndexes = unique([
    ...(sceneIndexesToRefresh || []).map((index) => Number(index || 0)).filter((index) => index > 0),
    ...blockedScenes,
  ]);

  const repairByScene = targetSceneIndexes.map((sceneIndex) => {
    const sceneReadiness = (sceneEditorialReadiness || []).find((scene) => Number(scene.scene_index || 0) === sceneIndex) || {};
    const sceneFailureCodes = unique([
      ...failureCodes,
      ...(sceneReadiness.blocking_reasons || []).map((reason) => {
        if (reason === "missing_exact_for_required_proof" || reason === "no_proof_for_promise") return "NO_PROOF_FOR_PROMISE";
        if (reason === "generic_exposure_too_high") return "GENERIC_OVERUSE";
        if (reason === "critical_slots_uncovered") return "CRITICAL_SLOT_NOT_CONFIRMED";
        return "";
      }).filter(Boolean),
    ]);

    const actions = sceneFailureCodes.map((code) => buildRepairActionFromCode(code));
    return {
      scene_index: sceneIndex,
      failure_codes: sceneFailureCodes,
      target_narrative_roles: unique(actions.flatMap((action) => action.target_narrative_roles || [])),
      enforce_source_tier: unique(actions.flatMap((action) => action.enforce_source_tier || [])),
      force_exact_required: actions.some((action) => action.force_exact_required === true),
      extra_negative_keywords: unique(actions.flatMap((action) => action.extra_negative_keywords || [])),
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

