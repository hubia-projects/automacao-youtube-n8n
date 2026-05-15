const { config } = require("../config/env");
const { loadState, updateState } = require("./stateService");
const { sendWorkflowStatus } = require("./telegramService");
const { generateAssets } = require("./assetsService");
const { renderVideo } = require("./renderService");
const { generateMetadata } = require("./metadataService");

const LOW_CONFIDENCE_THRESHOLD = 2.5;
const MIN_REFRESH_SCENE_COUNT = 2;
const MAX_REFRESH_SCENE_COUNT = 3;
const REVIEW_REFRESH_REASON = "review_low_confidence_or_reuse";
const REVIEW_REFRESH_MAX_ASSETS = 3;

const unique = (values = []) => [...new Set(values.filter(Boolean))];
const average = (values = []) => values.reduce((accumulator, value) => accumulator + Number(value || 0), 0) / Math.max(1, values.length);

const chooseScenesForAssetRefresh = ({
  state,
  lowConfidenceThreshold = LOW_CONFIDENCE_THRESHOLD,
  minSceneCount = MIN_REFRESH_SCENE_COUNT,
  maxSceneCount = MAX_REFRESH_SCENE_COUNT,
}) => {
  const visualPlan = Array.isArray(state?.visual_plan) ? state.visual_plan : [];
  const timelineClips = Array.isArray(state?.render_timeline?.clips) ? state.render_timeline.clips : [];
  const qaSceneIndexes = state?.render_validation?.scene_indexes_to_refresh || state?.render_validation?.regeneration_plan?.scene_indexes_to_refresh;
  const editorialSceneIndexesFromQa = unique(
    (state?.render_validation?.critical_slot_audit || [])
      .filter((entry) => entry.status === "fail")
      .map((entry) => Number(entry.scene_index || 0))
      .filter((sceneIndex) => sceneIndex > 0)
  );
  if (Array.isArray(qaSceneIndexes) && qaSceneIndexes.length) {
    return unique([
      ...qaSceneIndexes.map((sceneIndex) => Number(sceneIndex || 0)).filter((sceneIndex) => sceneIndex > 0),
      ...editorialSceneIndexesFromQa,
    ]).slice(0, maxSceneCount);
  }

  const sceneIndexes = new Set(visualPlan.map((scene) => Number(scene.scene_index || 0)).filter((sceneIndex) => sceneIndex > 0));
  const metricsByScene = new Map();

  timelineClips.forEach((clip) => {
    const sceneIndex = Number(clip.scene_index || 0);
    if (!sceneIndexes.has(sceneIndex)) return;
    if (String(clip.scene_role || "body") !== "body") return;

    const metrics = metricsByScene.get(sceneIndex) || {
      scores: [],
      assetKeys: new Set(),
      windowKeys: new Set(),
      clipCount: 0,
      editorialFlags: 0,
    };

    metrics.scores.push(Number((clip.timeline_score ?? clip.composite_score ?? clip.semantic_match_score) || 0));
    metrics.clipCount += 1;
    if (
      clip.editorial_slot_ok === false
      || clip.visual_truth_status === "uncertain"
      || clip.visual_truth_status === "wrong"
      || (clip.critical_slot === true && clip.visual_truth_status !== "exact" && clip.visual_truth_status !== "regional")
    ) {
      metrics.editorialFlags += 1;
    }
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
        editorialFlags: 0,
      };
      const averageScore = metrics.scores.length ? average(metrics.scores) : 0;
      const assetDiversity = metrics.assetKeys.size;
      const windowDiversity = metrics.windowKeys.size;
      const lowConfidence = metrics.scores.length ? averageScore < lowConfidenceThreshold : true;
      const heavyReuse = metrics.clipCount > 1 && (assetDiversity <= 1 || windowDiversity <= 1);
      const editorialFailure = metrics.editorialFlags > 0;
      const rankingScore =
        averageScore
        - (heavyReuse ? 0.6 : 0)
        - (metrics.clipCount === 0 ? 0.8 : 0)
        - (editorialFailure ? 0.95 : 0);

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
        editorialFailure,
        rankingScore,
      };
    })
    .filter((candidate) => candidate.scene_index > 0);

  if (!candidates.length) {
    return [];
  }

  const flaggedCandidates = candidates.filter((candidate) => candidate.lowConfidence || candidate.heavyReuse || candidate.editorialFailure);
  const desiredCount = Math.min(
    Math.max(1, candidates.length),
    Math.max(1, Math.min(maxSceneCount, flaggedCandidates.length ? Math.max(minSceneCount, flaggedCandidates.length) : minSceneCount))
  );
  const rankedCandidates = (flaggedCandidates.length ? flaggedCandidates : candidates).sort(
    (left, right) =>
      left.rankingScore - right.rankingScore ||
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
        last_refresh_reason: refreshedSceneIndexes.length ? REVIEW_REFRESH_REASON : "",
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
    ],
  }).catch(() => null);

  if (refreshedSceneIndexes.length) {
    await generateAssets({
      videoId,
      mockMode,
      maxAssets: REVIEW_REFRESH_MAX_ASSETS,
      sceneIndexes: refreshedSceneIndexes,
      preserveExisting: true,
      refreshReason: REVIEW_REFRESH_REASON,
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
    ...metadata,
  };
};

module.exports = {
  requestReviewRegeneration,
  __test__: {
    chooseScenesForAssetRefresh,
  },
};
