const { config } = require("../config/env");
const { loadState, updateState } = require("./stateService");
const { sendWorkflowStatus } = require("./telegramService");
const { generateAssets } = require("./assetsService");
const { renderVideo } = require("./renderService");
const { generateMetadata } = require("./metadataService");

const LOW_CONFIDENCE_THRESHOLD = 2.5;
const MIN_REFRESH_SCENE_COUNT = 2;
const MAX_REFRESH_SCENE_COUNT = 4;
const REVIEW_REFRESH_REASON = "review_low_confidence_or_reuse";
const REVIEW_REFRESH_MAX_ASSETS = 4;
const EDITORIAL_ISSUE_TYPES = new Set([
  "coverage_gap",
  "critical_slot_editorial_failure",
  "editorial_family_repetition",
  "visual_intent_underrepresented",
  "generic_asset_overuse",
  "wrong_visual_category",
  "theme_visual_mismatch",
  "clip_visual_truth_mismatch",
  "too_many_uncertain_clips",
  "hard_boundary_first_clip_not_visually_confirmed",
]);

const unique = (values = []) => [...new Set(values.filter(Boolean))];
const average = (values = []) => values.reduce((accumulator, value) => accumulator + Number(value || 0), 0) / Math.max(1, values.length);

const detectDominantRefreshReason = ({ state }) => {
  const issues = Array.isArray(state?.render_validation?.issues) ? state.render_validation.issues : [];
  if (issues.some((issue) => ["coverage_gap", "visual_intent_underrepresented", "theme_visual_mismatch"].includes(issue.type))) {
    return "editorial_coverage_gap";
  }
  if (issues.some((issue) => ["editorial_family_repetition", "generic_asset_overuse"].includes(issue.type))) {
    return "editorial_repetition_or_generic_overuse";
  }
  if (issues.some((issue) => ["critical_slot_editorial_failure", "too_many_uncertain_clips"].includes(issue.type))) {
    return "critical_slot_editorial_repair";
  }
  return REVIEW_REFRESH_REASON;
};

const chooseScenesForAssetRefresh = ({
  state,
  lowConfidenceThreshold = LOW_CONFIDENCE_THRESHOLD,
  minSceneCount = MIN_REFRESH_SCENE_COUNT,
  maxSceneCount = MAX_REFRESH_SCENE_COUNT,
}) => {
  const visualPlan = Array.isArray(state?.visual_plan) ? state.visual_plan : [];
  const timelineClips = Array.isArray(state?.render_timeline?.clips) ? state.render_timeline.clips : [];
  const renderValidation = state?.render_validation || {};
  const qaSceneIndexes = renderValidation.scene_indexes_to_refresh || renderValidation.regeneration_plan?.scene_indexes_to_refresh;
  if (Array.isArray(qaSceneIndexes) && qaSceneIndexes.length) {
    return unique(qaSceneIndexes.map((sceneIndex) => Number(sceneIndex || 0)).filter((sceneIndex) => sceneIndex > 0)).slice(0, maxSceneCount);
  }

  const editorialIssuePresent = Array.isArray(renderValidation.issues) && renderValidation.issues.some((issue) => EDITORIAL_ISSUE_TYPES.has(issue.type));
  const sceneIndexes = new Set(visualPlan.map((scene) => Number(scene.scene_index || 0)).filter((sceneIndex) => sceneIndex > 0));
  const metricsByScene = new Map();

  timelineClips.forEach((clip) => {
    const sceneIndex = Number(clip.scene_index || 0);
    if (!sceneIndexes.has(sceneIndex)) return;

    const metrics = metricsByScene.get(sceneIndex) || {
      scores: [],
      assetKeys: new Set(),
      windowKeys: new Set(),
      clipCount: 0,
      exactishSignals: 0,
      genericSignals: 0,
      uncertainSignals: 0,
      repeatedFamilies: new Set(),
    };

    metrics.scores.push(Number((clip.timeline_score ?? clip.composite_score ?? clip.semantic_match_score) || 0));
    metrics.clipCount += 1;
    if (clip.local_path) metrics.assetKeys.add(String(clip.local_path));
    if (clip.asset_window_summary || clip.asset_window_start_seconds || clip.asset_window_end_seconds) {
      metrics.windowKeys.add(
        [
          clip.local_path || "",
          clip.asset_window_start_seconds || 0,
          clip.asset_window_end_seconds || 0,
          clip.asset_window_summary || "",
        ].join("|")
      );
    }
    const status = clip.score_features?.editorialStatus || clip.editorial_status || "";
    if (["exact", "regional"].includes(status)) metrics.exactishSignals += 1;
    if (status === "generic") metrics.genericSignals += 1;
    if (status === "uncertain") metrics.uncertainSignals += 1;
    if (clip.score_features?.editorialFamilyKey) metrics.repeatedFamilies.add(String(clip.score_features.editorialFamilyKey));

    metricsByScene.set(sceneIndex, metrics);
  });

  const candidates = visualPlan
    .map((scene, orderIndex) => {
      const sceneIndex = Number(scene.scene_index || 0);
      const metrics = metricsByScene.get(sceneIndex) || {
        scores: [],
        assetKeys: new Set(),
        windowKeys: new Set(),
        clipCount: 0,
        exactishSignals: 0,
        genericSignals: 0,
        uncertainSignals: 0,
        repeatedFamilies: new Set(),
      };
      const averageScore = metrics.scores.length ? average(metrics.scores) : 0;
      const assetDiversity = metrics.assetKeys.size;
      const windowDiversity = metrics.windowKeys.size;
      const lowConfidence = metrics.scores.length ? averageScore < lowConfidenceThreshold : true;
      const heavyReuse = metrics.clipCount > 1 && (assetDiversity <= 1 || windowDiversity <= 1 || metrics.repeatedFamilies.size <= 1);
      const editorialRisk = metrics.genericSignals > 0 || metrics.uncertainSignals > 0 || (scene.visual_intent && metrics.exactishSignals === 0);
      const rankingScore = averageScore - (heavyReuse ? 0.6 : 0) - (editorialRisk ? 0.9 : 0) - (metrics.clipCount === 0 ? 0.8 : 0);

      return {
        scene_index: sceneIndex,
        title: scene.title || `Cena ${sceneIndex}`,
        orderIndex,
        averageScore,
        assetDiversity,
        windowDiversity,
        clipCount: metrics.clipCount,
        lowConfidence,
        heavyReuse,
        editorialRisk,
        rankingScore,
      };
    })
    .filter((candidate) => candidate.scene_index > 0);

  if (!candidates.length) {
    return [];
  }

  const flaggedCandidates = candidates.filter((candidate) => candidate.lowConfidence || candidate.heavyReuse || candidate.editorialRisk);
  const desiredCount = editorialIssuePresent ? maxSceneCount : Math.min(maxSceneCount, Math.max(minSceneCount, flaggedCandidates.length || minSceneCount));
  const rankedCandidates = (flaggedCandidates.length ? flaggedCandidates : candidates).sort(
    (left, right) =>
      left.rankingScore - right.rankingScore ||
      Number(right.editorialRisk) - Number(left.editorialRisk) ||
      left.averageScore - right.averageScore ||
      left.assetDiversity - right.assetDiversity ||
      left.windowDiversity - right.windowDiversity ||
      left.orderIndex - right.orderIndex
  );

  return unique(rankedCandidates.slice(0, desiredCount).map((candidate) => candidate.scene_index));
};

const requestReviewRegeneration = async ({ videoId, note = "", mockMode = config.MOCK_MODE }) => {
  const state = await loadState(videoId);
  const nextVersion = Math.max(1, Number(state.review?.draft_version || 1)) + 1;
  const refreshedSceneIndexes = chooseScenesForAssetRefresh({ state });
  const refreshReason = detectDominantRefreshReason({ state });
  const refreshedScenesLabel = (state.visual_plan || [])
    .filter((scene) => refreshedSceneIndexes.includes(Number(scene.scene_index || 0)))
    .map((scene) => `#${scene.scene_index} ${scene.title}`)
    .join("; ");
  const refreshedAt = new Date().toISOString();

  await updateState(
    videoId,
    {
      approved: false,
      error_message: "",
      review: {
        ...state.review,
        draft_version: nextVersion,
        last_rejection_note: note,
        last_rejected_at: new Date().toISOString(),
        last_refreshed_scene_indexes: refreshedSceneIndexes,
        last_refresh_reason: refreshedSceneIndexes.length ? refreshReason : "",
        last_refreshed_at: refreshedSceneIndexes.length ? refreshedAt : "",
      },
    },
    {
      currentStep: "regenerating_review",
      status: "regenerating_review",
    }
  );

  await sendWorkflowStatus({
    videoId,
    title: "Revisão solicitada",
    icon: "🔁",
    lines: [
      `Gerando nova versão do draft: v${nextVersion}.`,
      refreshedSceneIndexes.length ? `Rebuscando assets nas cenas: ${refreshedScenesLabel}.` : "Mantendo os assets atuais e replanejando a timeline.",
      `Motivo dominante: ${refreshReason}.`,
    ],
  }).catch(() => null);

  if (refreshedSceneIndexes.length) {
    await generateAssets({
      videoId,
      mockMode,
      maxAssets: REVIEW_REFRESH_MAX_ASSETS,
      sceneIndexes: refreshedSceneIndexes,
      preserveExisting: true,
      refreshReason,
    });
  }

  await renderVideo({ videoId, mockMode });
  const metadata = await generateMetadata({ videoId, mockMode });

  return {
    video_id: videoId,
    regenerated: true,
    draft_version: nextVersion,
    note,
    refreshed_scene_indexes: refreshedSceneIndexes,
    refresh_reason: refreshReason,
    ...metadata,
  };
};

module.exports = {
  requestReviewRegeneration,
  __test__: {
    chooseScenesForAssetRefresh,
    detectDominantRefreshReason,
  },
};