const { config } = require("../config/env");

const PLACEHOLDER_PROVIDERS = new Set(["local_fallback", "render_fallback"]);
const PLACEHOLDER_SOURCE_URLS = new Set(["generated-local"]);

const normalizeValue = (value = "") => String(value || "").trim().toLowerCase();

const shouldAllowPlaceholderAssets = ({ mockMode = false } = {}) => Boolean(mockMode || config.ALLOW_PLACEHOLDER_ASSETS);

const isPlaceholderAsset = (asset = {}) => {
  const provider = normalizeValue(asset.provider);
  const sourceUrl = normalizeValue(asset.source_url);
  const localPath = normalizeValue(asset.local_path);

  return Boolean(
    asset.is_fallback === true ||
      PLACEHOLDER_PROVIDERS.has(provider) ||
      PLACEHOLDER_SOURCE_URLS.has(sourceUrl) ||
      /render-fallback\.(png|jpg|jpeg|webp)$/i.test(localPath) ||
      /scene-\d+-fallback-\d+\.(png|jpg|jpeg|webp)$/i.test(localPath)
  );
};

const isPublishableAsset = (asset = {}, options = {}) => {
  if (!asset || typeof asset !== "object") return false;
  if (!shouldAllowPlaceholderAssets(options) && isPlaceholderAsset(asset)) return false;

  return Boolean(asset.local_path || asset.source_url);
};

const buildSceneAssetReadiness = ({
  scene = {},
  assets = [],
  approvedItems = [],
  approvedWindows = [],
  sceneEditorialReadiness = [],
  mockMode = false,
} = {}) => {
  const sceneIndex = Number(scene.scene_index || 0);
  const sceneAssets = (assets || []).filter((asset) => Number(asset.scene_index || 0) === sceneIndex);
  const sceneApprovedItems = (approvedItems || []).filter((asset) => Number(asset.scene_index || 0) === sceneIndex);
  const sceneApprovedWindows = (approvedWindows || []).filter((window) => Number(window.scene_index || 0) === sceneIndex);
  const publishableAssets = sceneAssets.filter((asset) => isPublishableAsset(asset, { mockMode }));
  const publishableApprovedItems = sceneApprovedItems.filter((asset) => isPublishableAsset(asset, { mockMode }));
  const placeholderAssets = sceneAssets.filter((asset) => isPlaceholderAsset(asset));
  const editorial = (sceneEditorialReadiness || []).find((entry) => Number(entry.scene_index || 0) === sceneIndex) || {};
  const exactWindows = sceneApprovedWindows.filter((item) => item.visual_truth_status === "exact").length;
  const regionalWindows = sceneApprovedWindows.filter((item) => item.visual_truth_status === "regional").length;
  const genericWindows = sceneApprovedWindows.filter((item) => item.visual_truth_status === "generic").length;
  const criticalSlotsMissing = Array.isArray(editorial.critical_slots_missing) ? editorial.critical_slots_missing : [];
  const requiresVisualProof = Boolean(
    (scene.required_visual_evidence || []).length
    || scene.hard_boundary
    || String(scene.role || "").toLowerCase() === "intro"
    || String(scene.role || "").toLowerCase() === "outro"
  );
  const blockingReasons = [];

  if (!publishableAssets.length) {
    blockingReasons.push(sceneAssets.length ? "scene_has_only_placeholder_assets" : "scene_has_no_assets");
  }
  if (!publishableApprovedItems.length) {
    blockingReasons.push("scene_has_no_editorially_approved_assets");
  }
  if (requiresVisualProof && exactWindows === 0 && regionalWindows === 0) {
    blockingReasons.push("scene_missing_exact_visual_proof");
  }
  if (criticalSlotsMissing.length) {
    blockingReasons.push("critical_slots_uncovered");
  }

  return {
    scene_index: sceneIndex,
    title: scene.title || "",
    visual_intent: scene.visual_intent || "",
    ready: blockingReasons.length === 0,
    blocking: blockingReasons.length > 0,
    total_assets: sceneAssets.length,
    publishable_assets: publishableAssets.length,
    approved_assets: sceneApprovedItems.length,
    approved_publishable_assets: publishableApprovedItems.length,
    approved_windows: sceneApprovedWindows.length,
    exact_windows: exactWindows,
    regional_windows: regionalWindows,
    generic_windows: genericWindows,
    critical_slots_missing: criticalSlotsMissing,
    placeholder_assets: placeholderAssets.length,
    failure_reason: blockingReasons.join(","),
    blocking_reasons: blockingReasons,
  };
};

const summarizeAssetReadiness = ({
  visualPlan = [],
  assets = [],
  approvedItems = [],
  approvedWindows = [],
  sceneEditorialReadiness = [],
  editorialMetrics = {},
  mockMode = false,
} = {}) => {
  const sceneAssetReadiness = (Array.isArray(visualPlan) ? visualPlan : []).map((scene) =>
    buildSceneAssetReadiness({
      scene,
      assets,
      approvedItems,
      approvedWindows,
      sceneEditorialReadiness,
      mockMode,
    })
  );
  const blockingScenes = sceneAssetReadiness.filter((entry) => entry.ready === false);
  const failureReason = blockingScenes.length
    ? blockingScenes
        .map((entry) => `${entry.scene_index}:${entry.failure_reason || "missing_editorial_assets"}`)
        .join(",")
    : "";

  const criticalSlotsCovered = sceneAssetReadiness.filter((entry) => !entry.critical_slots_missing?.length).length;

  return {
    scene_asset_readiness: sceneAssetReadiness,
    missing_assets: blockingScenes.length > 0,
    blocking_scene_indexes: blockingScenes.map((entry) => entry.scene_index),
    failure_reason: failureReason,
    editorial_readiness: {
      scene_count: sceneAssetReadiness.length,
      ready_scene_count: sceneAssetReadiness.filter((entry) => entry.ready).length,
      critical_slots_covered_scenes: criticalSlotsCovered,
      critical_slots_total_scenes: sceneAssetReadiness.length,
      exact_ratio: Number(editorialMetrics.exact_ratio || 0),
      regional_ratio: Number(editorialMetrics.regional_ratio || 0),
      generic_ratio: Number(editorialMetrics.generic_ratio || 0),
      uncertain_ratio: Number(editorialMetrics.uncertain_ratio || 0),
      timeline_uses_approved_pool_only: editorialMetrics.timeline_uses_approved_pool_only !== false,
    },
  };
};

module.exports = {
  buildSceneAssetReadiness,
  isPlaceholderAsset,
  isPublishableAsset,
  shouldAllowPlaceholderAssets,
  summarizeAssetReadiness,
};
