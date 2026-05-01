const path = require("path");
const fs = require("fs-extra");
const { logger } = require("../utils/logger");
const { loadState, ensureVideoStructure } = require("./stateService");
const { getCachedAudioIntelligence } = require("./audioIntelligence");
const { matchNarrationToAssetWindows, matchPauseToAsset } = require("./semanticMatcher");

// Config
const MIN_CLIP_DURATION = 3;
const MAX_CLIP_DURATION = 10;
const TARGET_AVERAGE_CLIP_DURATION = 6;
const TRANSITION_DURATION = 0.45;
const MIN_OUTPUT = { width: 1280, height: 720 };
const PREFERRED_OUTPUT = { width: 1920, height: 1080 };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round3 = (value) => Number(Number(value || 0).toFixed(3));
const sumValues = (values = []) => round3(values.reduce((acc, value) => acc + Number(value || 0), 0));
const unique = (values = []) => [...new Set(values.filter(Boolean))];

const isVideoFile = (filePath = "") => /\.(mp4|mov|webm|mkv|avi)$/i.test(filePath);
const isImageFile = (filePath = "") => /\.(jpg|jpeg|png|webp)$/i.test(filePath);
const isVideoAsset = (asset = {}) => (asset.asset_type || asset.type || "") === "video" || isVideoFile(asset.local_path || "");

const getAssetDuration = (asset = {}) => Number(asset.source_duration_seconds || asset.duration_estimate || 0);
const getAssetResolution = (asset = {}) => ({
  width: Number(asset.resolution?.width || 0),
  height: Number(asset.resolution?.height || 0),
});

const SCRIPT_TERM_STOPWORDS = new Set([
  "a", "ao", "aos", "as", "com", "como", "da", "das", "de", "do", "dos",
  "e", "em", "foco", "local", "no", "nos", "o", "os", "para", "por",
  "se", "sem", "um", "uma", "video", "travel", "visual",
]);

const buildSemanticTerms = (values = []) =>
  unique(
    String(values.filter(Boolean).join(" "))
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((term) => term.length >= 3 && !SCRIPT_TERM_STOPWORDS.has(term))
  );

const getDraftVersion = (state) => Math.max(1, Number(state.review?.draft_version || 1));

const buildSceneAssetMap = (items = []) => {
  const map = new Map();
  items.forEach((item, index) => {
    const sceneIndex = Number(item.scene_index || index + 1);
    const list = map.get(sceneIndex) || [];
    list.push(item);
    map.set(sceneIndex, list);
  });
  return map;
};

const normalizeAssetAnalysisWindows = (asset = {}) => {
  const assetDuration = round3(getAssetDuration(asset));
  const fallbackEndSeconds = assetDuration || MAX_CLIP_DURATION;
  const rawWindows = Array.isArray(asset.analysis_windows) && asset.analysis_windows.length
    ? asset.analysis_windows
    : [
        {
          window_index: 1,
          start_seconds: 0,
          end_seconds: fallbackEndSeconds,
          summary: asset.analysis_summary || asset.semantic_text || asset.query || "",
          tags: [...new Set([...(asset.analysis_tags || []), ...(asset.provider_tags || [])])],
        },
      ];

  return rawWindows.map((window, index) => {
    const startSeconds = round3(Math.max(0, Number(window.start_seconds || 0)));
    const endSeconds = round3(Math.max(startSeconds + 0.5, Math.min(fallbackEndSeconds, Number(window.end_seconds || fallbackEndSeconds))));
    return {
      window_index: Number(window.window_index || index + 1),
      start_seconds: startSeconds,
      end_seconds: endSeconds,
      summary: window.summary || window.semantic_text || asset.analysis_summary || asset.semantic_text || asset.query || "",
      tags: unique([...(window.tags || []), ...(asset.analysis_tags || []), ...(asset.provider_tags || [])]).slice(0, 12),
      confidence: Number(window.confidence || 0),
    };
  });
};

// ====== Core Planning Logic ======

/**
 * Get the best matching window of an asset for a given narration excerpt,
 * using embeddings if available, otherwise keyword overlap.
 */
const pickBestAssetWindow = async ({
  asset,
  narrationText,
  videoId,
  sceneKeywords = [],
  usageByWindowKey = new Map(),
}) => {
  const windows = normalizeAssetAnalysisWindows(asset);
  const windowTexts = windows.map(
    (w) => `${w.summary || ""} ${(w.tags || []).join(" ")}`.trim()
  );

  const assetTermTokens = buildSemanticTerms([
    narrationText,
    ...sceneKeywords,
    asset.query,
    asset.analysis_summary,
    ...(asset.analysis_tags || []),
    ...(asset.provider_tags || []),
  ]);

  // Use semantic matcher if available
  let matchResults = null;
  try {
    const { matchNarrationToAssetWindows } = require("./semanticMatcher");
    matchResults = await matchNarrationToAssetWindows({
      narrationText,
      assetWindows: windows,
      videoId,
    });
  } catch {
    matchResults = null;
  }

  let bestScore = -Infinity;
  let bestWindowIndex = 0;
  let bestWindow = windows[0];
  let bestMethod = "fallback";

  windows.forEach((window, index) => {
    const windowKey = `${asset.local_path || asset.source_url}:window:${window.window_index || index + 1}`;
    const reusePenalty = (usageByWindowKey.get(windowKey) || 0) * 1.5;

    let score;
    let method;

    if (matchResults && matchResults[index]) {
      score = matchResults[index].similarity_score * 10;
      method = matchResults[index].method;
    } else {
      // Fallback: count matching terms between asset window and narration
      const windowTerms = buildSemanticTerms([window.summary, ...(window.tags || [])]);
      const matchCount = windowTerms.filter((t) => assetTermTokens.includes(t)).length;
      score = matchCount * 2.5;
      method = "keyword_local";
    }

    score -= reusePenalty;

    // Small bonus for longer windows (more usable footage)
    const windowDuration = window.end_seconds - window.start_seconds;
    if (windowDuration >= 5 && windowDuration <= 12) {
      score += 0.5;
    }

    // Bonus for confidence
    if (window.confidence > 0) {
      score += window.confidence * 0.8;
    }

    if (score > bestScore) {
      bestScore = score;
      bestWindowIndex = index;
      bestWindow = window;
      bestMethod = method;
    }
  });

  // Track usage
  const bestWindowKey = `${asset.local_path || asset.source_url}:window:${bestWindow.window_index || bestWindowIndex + 1}`;
  usageByWindowKey.set(bestWindowKey, (usageByWindowKey.get(bestWindowKey) || 0) + 1);

  return {
    window: bestWindow,
    windowIndex: bestWindowIndex,
    score: round3(bestScore),
    method: bestMethod,
  };
};

/**
 * Build the video source window (start/end seconds) from the asset.
 * Uses the matched window as the preferred source.
 */
const buildVideoSourceWindow = ({
  asset,
  clipDuration,
  preferredWindow = null,
  assetReuseIndex = 0,
  clipIndex = 1,
  draftVersion = 1,
}) => {
  const assetDuration = getAssetDuration(asset);
  const safeClipDuration = round3(Number(clipDuration || MIN_CLIP_DURATION));

  if (!assetDuration || assetDuration <= safeClipDuration + 0.75) {
    return { source_start_seconds: 0, source_end_seconds: round3(safeClipDuration), asset_duration_seconds: round3(assetDuration) };
  }

  if (preferredWindow) {
    // Try to use the preferred window, but adjust if it's too short
    const windowStart = Number(preferredWindow.start_seconds || 0);
    const windowEnd = Number(preferredWindow.end_seconds || assetDuration);
    const windowDuration = Math.max(0.5, windowEnd - windowStart);

    if (windowDuration >= safeClipDuration) {
      // Window is long enough, take the best part
      const extraTime = windowDuration - safeClipDuration;
      const centerOffset = Math.max(0, extraTime * 0.5);
      const startOffset = centerOffset * ((clipIndex % 3) * 0.15);
      return {
        source_start_seconds: round3(clamp(windowStart + startOffset, 0, Math.max(0, assetDuration - safeClipDuration))),
        source_end_seconds: round3(clamp(windowStart + startOffset + safeClipDuration, safeClipDuration, assetDuration)),
        asset_duration_seconds: round3(assetDuration),
      };
    }

    // Window too short, use it as anchor and extend around it
    const extendBefore = Math.min(windowStart, (safeClipDuration - windowDuration) * 0.5);
    const extendAfter = Math.min(assetDuration - windowEnd, (safeClipDuration - windowDuration) * 0.5);
    const actualStart = Math.max(0, windowStart - extendBefore);
    const actualEnd = Math.min(assetDuration, windowEnd + extendAfter);

    if (actualEnd - actualStart >= safeClipDuration) {
      return {
        source_start_seconds: round3(actualStart),
        source_end_seconds: round3(Math.min(assetDuration, actualStart + safeClipDuration)),
        asset_duration_seconds: round3(assetDuration),
      };
    }
  }

  // Fall back to distribution-based selection
  const edgePadding = Math.min(0.9, Math.max(0.25, assetDuration * 0.04));
  const availableTravel = Math.max(0, assetDuration - safeClipDuration - edgePadding * 2);
  const variation = ((assetReuseIndex * 0.31) + ((clipIndex - 1) * 0.11) + (draftVersion * 0.17)) % 1;
  const start = round3(edgePadding + availableTravel * variation);

  return {
    source_start_seconds: start,
    source_end_seconds: round3(start + safeClipDuration),
    asset_duration_seconds: round3(assetDuration),
  };
};

/**
 * Choose the output resolution based on available assets.
 */
const chooseOutputResolution = (clipPlan = []) => {
  const hasVideoAssets = clipPlan.some((clip) => isVideoAsset(clip.asset));
  if (!hasVideoAssets) return MIN_OUTPUT;

  const fullHdCount = clipPlan.filter((clip) => {
    const { width, height } = getAssetResolution(clip.asset || {});
    return width >= PREFERRED_OUTPUT.width && height >= PREFERRED_OUTPUT.height;
  }).length;

  return clipPlan.length && fullHdCount / clipPlan.length >= 0.6 ? PREFERRED_OUTPUT : MIN_OUTPUT;
};

/**
 * Choose how many clips to use based on audio duration.
 */
const chooseClipCount = ({ audioDuration, sceneCount }) => {
  const safeDuration = Math.max(8, Number(audioDuration || 0));
  const minCount = Math.max(1, Math.ceil(safeDuration / MAX_CLIP_DURATION));
  const maxCount = Math.max(minCount, Math.floor(safeDuration / MIN_CLIP_DURATION));
  const idealCount = Math.max(sceneCount || 1, Math.round(safeDuration / TARGET_AVERAGE_CLIP_DURATION));
  return clamp(idealCount, minCount, maxCount);
};

/**
 * Build the full clip plan using audio intelligence + semantic matching.
 * This is the main function that replaces buildClipPlan() from renderService.js
 */
const buildTimeline = async ({
  state,
  audioDuration,
  draftVersion,
  fallbackAsset,
}) => {
  const videoId = state.video_id || "unknown";
  const scenes = Array.isArray(state.visual_plan) && state.visual_plan.length
    ? state.visual_plan
    : [];
  const allAssets = state.assets_json?.items || [];
  const sceneAssetMap = buildSceneAssetMap(allAssets);

  // Get audio intelligence (word-level timestamps + scene boundaries)
  let audioIntelligence = null;
  try {
    audioIntelligence = await getCachedAudioIntelligence({ videoId });
  } catch {
    audioIntelligence = null;
  }

  const sceneBoundaries = Array.isArray(audioIntelligence?.scene_boundaries)
    ? audioIntelligence.scene_boundaries
    : [];

  // Merge scene boundaries with scenes
  const enrichedScenes = scenes.map((scene) => {
    const boundary = sceneBoundaries.find(
      (sb) => Number(sb.scene_index) === Number(scene.scene_index)
    );
    return {
      ...scene,
      audio_start_seconds: boundary?.audio_start_seconds || ((Number(scene.scene_index) - 1) * audioDuration) / Math.max(1, scenes.length),
      audio_end_seconds: boundary?.audio_end_seconds || (Number(scene.scene_index) * audioDuration) / Math.max(1, scenes.length),
      boundary_confidence: boundary?.boundary_confidence || 0.3,
    };
  });

  // Pause markers for transitions
  const pauseMarkers = audioIntelligence?.pause_markers || [];
  const topicTransitions = pauseMarkers.filter((p) => p.type === "topic_transition" && p.duration >= 1.5);

  // Track usage to avoid repeating the same window
  const usageByWindowKey = new Map();

  // Build clip plan
  const clips = [];
  const totalClipCount = chooseClipCount({ audioDuration, sceneCount: enrichedScenes.length });
  const clipsPerScene = Math.max(1, Math.ceil(totalClipCount / Math.max(1, enrichedScenes.length)));

  for (let si = 0; si < enrichedScenes.length; si++) {
    const scene = enrichedScenes[si];
    const sceneAssets = sceneAssetMap.get(scene.scene_index) || [];

    const sceneStartTime = Number(scene.audio_start_seconds || 0);
    const sceneEndTime = Number(scene.audio_end_seconds || audioDuration);
    const sceneDurationSemantic = sceneEndTime - sceneStartTime;

    // Distribute clips within the scene's time window
    const sceneClipCount = Math.max(1, Math.round((sceneDurationSemantic / audioDuration) * totalClipCount));
    const clippedSceneClipCount = clamp(sceneClipCount, 1, Math.min(clipsPerScene + 1, Math.ceil(sceneDurationSemantic / MIN_CLIP_DURATION)));

    // Generate narration excerpt for this scene
    const narrationText = `${scene.title || ""} ${scene.narration_excerpt || ""} ${(scene.keywords || []).join(" ")}`.trim();

    // Check if there's a topic transition near this scene
    const nearTransition = topicTransitions.find(
      (t) => Math.abs(t.start - sceneStartTime) < 2.0
    );

    for (let ci = 0; ci < clippedSceneClipCount; ci++) {
      const clipFraction = clippedSceneClipCount > 1 ? ci / (clippedSceneClipCount - 1) : 0.5;
      const clipStartTime = sceneStartTime + clipFraction * sceneDurationSemantic;
      const clipEndTime = Math.min(sceneEndTime, clipStartTime + MAX_CLIP_DURATION);
      const clipDuration = Math.min(MAX_CLIP_DURATION, Math.max(MIN_CLIP_DURATION, clipEndTime - clipStartTime));

      // Find the best asset and window for this clip
      let bestAsset = fallbackAsset;
      let bestWindow = null;
      let bestScore = 0;
      let bestMethod = "fallback";

      if (sceneAssets.length) {
        for (const asset of sceneAssets) {
          if (!asset.local_path || !fs.existsSync(asset.local_path)) continue;

          const matchResult = await pickBestAssetWindow({
            asset,
            narrationText,
            videoId,
            sceneKeywords: scene.keywords || [],
            usageByWindowKey,
          });

          if (matchResult.score > bestScore) {
            bestScore = matchResult.score;
            bestAsset = asset;
            bestWindow = matchResult.window;
            bestMethod = matchResult.method;
          }
        }
      }

      // Build the video source window
      const sourceWindow = isVideoAsset(bestAsset)
        ? buildVideoSourceWindow({
            asset: bestAsset,
            clipDuration,
            preferredWindow: bestWindow,
            assetReuseIndex: 0,
            clipIndex: clips.length + 1,
            draftVersion,
          })
        : { source_start_seconds: 0, source_end_seconds: round3(clipDuration), asset_duration_seconds: round3(getAssetDuration(bestAsset)) };

      clips.push({
        clip_index: clips.length + 1,
        scene_index: scene.scene_index,
        scene_role: scene.role || "body",
        title: scene.title || `Cena ${scene.scene_index}`,
        narration_excerpt: scene.narration_excerpt || "",
        clip_script_excerpt: narrationText.slice(0, 200),
        clip_duration_seconds: clipDuration,
        clip_start_narrated_at: round3(clipStartTime),
        clip_end_narrated_at: round3(clipEndTime),
        source_start_seconds: sourceWindow.source_start_seconds,
        source_end_seconds: sourceWindow.source_end_seconds,
        asset_duration_seconds: sourceWindow.asset_duration_seconds,
        semantic_match_score: round3(bestScore),
        semantic_match_method: bestMethod,
        asset_semantic_text: bestWindow?.summary || bestAsset.analysis_summary || bestAsset.semantic_text || bestAsset.query || "",
        asset_window_summary: bestWindow?.summary || "",
        asset_window_start_seconds: Number(bestWindow?.start_seconds || 0),
        asset_window_end_seconds: Number(bestWindow?.end_seconds || 0),
        asset: bestAsset,
      });
    }
  }

  // Sort clips by their narrated time position
  clips.sort((a, b) => a.clip_start_narrated_at - b.clip_start_narrated_at);

  // Re-index after sorting
  clips.forEach((clip, index) => {
    clip.clip_index = index + 1;
  });

  const uniqueAssetCount = new Set(clips.map((clip) => clip.asset?.local_path).filter(Boolean)).size;
  const semanticScores = clips.map((clip) => Number(clip.semantic_match_score || 0));

  return {
    clips,
    clipPlan: clips,
    audioDuration,
    totalClipCount: clips.length,
    uniqueAssetCount,
    semanticAlignmentScoreAverage: round3(semanticScores.reduce((a, b) => a + b, 0) / Math.max(1, semanticScores.length)),
    lowConfidenceClipCount: semanticScores.filter((s) => s < 2.5).length,
  };
};

module.exports = {
  buildTimeline,
  chooseOutputResolution,
  buildVideoSourceWindow,
  pickBestAssetWindow,
  chooseClipCount,
  __test__: {
    normalizeAssetAnalysisWindows,
    buildSceneAssetMap,
  },
};