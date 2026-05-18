const { loadState, updateState } = require("./stateService");
const { applyRetentionSignalsToLibrary, summarizeLibrarySnapshot } = require("./assetLibraryService");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round3 = (value) => Number(Number(value || 0).toFixed(3));
const unique = (values = []) => [...new Set((values || []).filter(Boolean))];

const normalizeRetentionScore = (value = 0) => {
  const numeric = Number(value || 0);
  if (numeric > 1) return clamp(numeric / 100, 0, 1);
  return clamp(numeric, 0, 1);
};

const findClipByTimestamp = (clips = [], timestampSec = 0) =>
  (clips || []).find((clip) => {
    const start = Number(clip.timeline_start_sec || clip.clip_start_narrated_at || 0);
    const end = Number(clip.timeline_end_sec || clip.clip_end_narrated_at || (start + Number(clip.clip_duration_seconds || 0)));
    return timestampSec >= start - 0.001 && timestampSec < end + 0.001;
  }) || null;

const aggregateProviderRetention = (observations = []) => {
  const byProvider = new Map();
  observations.forEach((obs) => {
    const provider = String(obs.provider || "unknown").toLowerCase();
    if (!provider) return;
    const row = byProvider.get(provider) || { sum: 0, count: 0 };
    row.sum += Number(obs.retention_score || 0);
    row.count += 1;
    byProvider.set(provider, row);
  });
  const snapshot = {};
  byProvider.forEach((row, provider) => {
    snapshot[provider] = round3(row.sum / Math.max(1, row.count));
  });
  return snapshot;
};

const mergeProviderReliability = ({
  previous = {},
  current = {},
  alpha = 0.35,
}) => {
  const providers = unique([...Object.keys(previous || {}), ...Object.keys(current || {})]);
  return providers.reduce((acc, provider) => {
    const prev = clamp(Number(previous[provider] || 0.5), 0, 1);
    const curr = clamp(Number(current[provider] || prev), 0, 1);
    acc[provider] = round3((1 - alpha) * prev + alpha * curr);
    return acc;
  }, {});
};

const mapRetentionSamplesToObservations = ({ samples = [], clips = [] }) =>
  (samples || [])
    .map((sample) => {
      const timestamp = Number(sample.timestamp_sec ?? sample.timestamp ?? -1);
      const retentionScore = normalizeRetentionScore(sample.retention_score ?? sample.retention ?? sample.score ?? 0);
      if (!Number.isFinite(timestamp) || timestamp < 0) return null;
      const clip = findClipByTimestamp(clips, timestamp);
      if (!clip) return null;
      return {
        timestamp_sec: round3(timestamp),
        retention_score: retentionScore,
        clip_index: Number(clip.clip_index || 0),
        asset_id: clip.asset?.asset_id || clip.asset_id || clip.asset_window_id || "",
        provider: clip.source_provider || clip.asset?.provider || clip.source_tier || "unknown",
        source_tier: clip.source_tier || "free",
        content_slot_type: clip.content_slot_type || "",
        content_slot_id: clip.content_slot_id || "",
        narrative_role_selected: clip.narrative_role_selected || "",
        scene_index: Number(clip.scene_index || 0),
      };
    })
    .filter(Boolean);

const ingestRetentionLearning = async ({
  videoId,
  retentionSamples = [],
  alpha = 0.35,
} = {}) => {
  const state = await loadState(videoId);
  const clips = Array.isArray(state.render_timeline?.clips) ? state.render_timeline.clips : [];
  const observations = mapRetentionSamplesToObservations({
    samples: retentionSamples,
    clips,
  });
  const providerSnapshot = aggregateProviderRetention(observations);
  const previousReliability = state.assets_json?.provider_reliability || state.render_validation?.provider_reliability || {};
  const nextReliability = mergeProviderReliability({
    previous: previousReliability,
    current: providerSnapshot,
    alpha,
  });

  const library = await applyRetentionSignalsToLibrary({
    observations,
    videoId,
  });

  const nextState = await updateState(videoId, {
    assets_json: {
      provider_reliability: nextReliability,
      editorial_asset_library_snapshot: summarizeLibrarySnapshot(library, 20),
      retention_learning: {
        updated_at: new Date().toISOString(),
        observations_count: observations.length,
        provider_retention_snapshot: providerSnapshot,
      },
    },
    render_validation: {
      provider_reliability: nextReliability,
      editorial_observability: {
        ...(state.render_validation?.editorial_observability || {}),
        retention_learning: {
          updated_at: new Date().toISOString(),
          observations_count: observations.length,
          provider_retention_snapshot: providerSnapshot,
        },
      },
    },
  });

  return {
    video_id: videoId,
    observations_count: observations.length,
    provider_retention_snapshot: providerSnapshot,
    provider_reliability: nextReliability,
    updated_state_path: nextState.state_path,
  };
};

module.exports = {
  ingestRetentionLearning,
  __test__: {
    normalizeRetentionScore,
    aggregateProviderRetention,
    mergeProviderReliability,
    mapRetentionSamplesToObservations,
  },
};
