const { config } = require("../config/env");
const { summarizeSceneApproval } = require("./editorialAssetService");

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

const buildSceneAssetReadiness = ({ scene = {}, assets = [], mockMode = false } = {}) => {
  const sceneIndex = Number(scene.scene_index || 0);
  const sceneAssets = assets.filter((asset) => Number(asset.scene_index || 0) === sceneIndex);
  const relaxedMode = shouldAllowPlaceholderAssets({ mockMode });
  const publishableAssets = sceneAssets.filter((asset) => isPublishableAsset(asset, { mockMode }));
  const placeholderAssets = sceneAssets.filter((asset) => isPlaceholderAsset(asset));
  const approval = summarizeSceneApproval({ scene, assets: publishableAssets });

  let failureReason = "";
  if (!publishableAssets.length) {
    failureReason = sceneAssets.length ? "scene_has_only_placeholder_assets" : "scene_has_no_assets";
  } else if (!relaxedMode && !approval.ready) {
    if (approval.critical_scene && !approval.critical_ready) {
      failureReason = "scene_missing_critical_exact_or_regional_asset";
    } else if (approval.specific_scene && approval.strong_assets === 0) {
      failureReason = "scene_missing_specific_editorial_coverage";
    } else {
      failureReason = "scene_missing_editorial_approval";
    }
  }

  const ready = relaxedMode ? publishableAssets.length > 0 : approval.ready;

  return {
    scene_index: sceneIndex,
    title: scene.title || "",
    visual_intent: scene.visual_intent || "",
    role: scene.role || "body",
    ready,
    blocking: !ready,
    total_assets: sceneAssets.length,
    publishable_assets: publishableAssets.length,
    placeholder_assets: placeholderAssets.length,
    approved_assets: approval.approved_assets,
    strong_assets: approval.strong_assets,
    exact_assets: approval.exact_assets,
    regional_assets: approval.regional_assets,
    generic_assets: approval.generic_assets,
    uncertain_assets: approval.uncertain_assets,
    wrong_assets: approval.wrong_assets,
    critical_scene: approval.critical_scene,
    specific_scene: approval.specific_scene,
    critical_ready: approval.critical_ready,
    best_editorial_fit: approval.best_fit,
    editorial_bins: approval.editorial_bins,
    failure_reason: failureReason,
  };
};

const summarizeAssetReadiness = ({ visualPlan = [], assets = [], mockMode = false } = {}) => {
  const sceneAssetReadiness = (Array.isArray(visualPlan) ? visualPlan : []).map((scene) =>
    buildSceneAssetReadiness({ scene, assets, mockMode })
  );
  const blockingScenes = sceneAssetReadiness.filter((entry) => entry.ready === false);
  const failureReason = blockingScenes.length
    ? blockingScenes
        .map((entry) => `${entry.scene_index}:${entry.failure_reason || "missing_publishable_assets"}`)
        .join(",")
    : "";

  return {
    scene_asset_readiness: sceneAssetReadiness,
    missing_assets: blockingScenes.length > 0,
    blocking_scene_indexes: blockingScenes.map((entry) => entry.scene_index),
    failure_reason: failureReason,
  };
};

module.exports = {
  buildSceneAssetReadiness,
  isPlaceholderAsset,
  isPublishableAsset,
  shouldAllowPlaceholderAssets,
  summarizeAssetReadiness,
};