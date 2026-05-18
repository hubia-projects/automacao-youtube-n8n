const round3 = (value) => Number(Number(value || 0).toFixed(3));
const normalize = (value = "") => String(value || "").toLowerCase().trim();
const unique = (values = []) => [...new Set((values || []).filter(Boolean))];

const getMicroNeedScore = ({ candidate = {}, microNeed = "" } = {}) => {
  const need = normalize(microNeed);
  if (!need) return 0;
  return Number(
    candidate.micro_need_match_scores?.[need]
    || candidate.micro_need_match_score
    || 0
  );
};

const supportsMicroNeed = ({ candidate = {}, microMoment = {} } = {}) => {
  const need = normalize(microMoment.visual_need || "");
  if (!need) return true;
  const supported = (candidate.micro_needs_supported || []).map(normalize);
  const slotType = normalize(candidate.content_slot_type || "");
  const categories = [
    ...(candidate.detected_visual_categories || []),
    ...(candidate.detected_objects || []),
    ...(candidate.action_tokens_detected || []),
  ].map(normalize);
  return supported.includes(need) || slotType === need || categories.includes(need);
};

const isProofSafe = ({ candidate = {}, microMoment = {}, minScore = 0.55 } = {}) => {
  if (!microMoment?.needs_visual_proof) return supportsMicroNeed({ candidate, microMoment });
  const status = normalize(candidate.visual_truth_status || "");
  if (!["exact", "regional"].includes(status)) return false;
  if (normalize(candidate.visual_observation_origin || "") === "weak_fallback") return false;
  if (!supportsMicroNeed({ candidate, microMoment })) return false;
  const score = getMicroNeedScore({ candidate, microNeed: microMoment.visual_need });
  return score === 0 || score >= minScore;
};

const scoreLocalWindowForMicro = ({ candidate = {}, microMoment = {}, minScore = 0.55 } = {}) => {
  if (!isProofSafe({ candidate, microMoment, minScore })) return -1;
  const need = normalize(microMoment.visual_need || "");
  const microScore = getMicroNeedScore({ candidate, microNeed: need }) || (supportsMicroNeed({ candidate, microMoment }) ? 0.65 : 0);
  const actionTokens = (candidate.action_tokens_detected || []).map(normalize);
  const wantedActions = (microMoment.action_tokens || []).map(normalize);
  const actionScore = wantedActions.length
    ? wantedActions.filter((token) => actionTokens.includes(token)).length / wantedActions.length
    : 0.5;
  const confidence = Number(candidate.editorial_confidence || candidate.confidence || 0);
  const duration = Math.max(0.1, Number(candidate.end_sec || 0) - Number(candidate.start_sec || 0));
  const targetDuration = Math.max(0.1, Number(microMoment.end_sec || 0) - Number(microMoment.start_sec || 0));
  const durationScore = Math.max(0, 1 - (Math.abs(duration - targetDuration) / Math.max(1, targetDuration)));

  return round3((microScore * 0.58) + (actionScore * 0.24) + (confidence * 0.12) + (durationScore * 0.06));
};

const findLocalRecutCandidate = ({
  currentCandidate = {},
  ranked = [],
  assetWindows = [],
  microMoment = null,
  minScore = 0.55,
} = {}) => {
  if (!currentCandidate || !microMoment) {
    return { candidate: null, action: null, score: 0 };
  }

  const assetId = String(currentCandidate.asset_id || "");
  if (!assetId) return { candidate: null, action: null, score: 0 };

  const currentScore = scoreLocalWindowForMicro({ candidate: currentCandidate, microMoment, minScore });
  const rankedById = new Map((ranked || [])
    .filter((entry) => entry?.candidate)
    .map((entry) => [String(entry.candidate.id || ""), entry]));

  const candidates = (assetWindows || [])
    .filter((window) => String(window.asset_id || "") === assetId)
    .filter((window) => String(window.id || "") !== String(currentCandidate.id || ""))
    .filter((window) => window.editorial_approved === true)
    .filter((window) => isProofSafe({ candidate: window, microMoment, minScore }))
    .map((window) => {
      const rankedEntry = rankedById.get(String(window.id || ""));
      return {
        candidate: window,
        score: Math.max(
          scoreLocalWindowForMicro({ candidate: window, microMoment, minScore }),
          Number(rankedEntry?.features?.microNeedExactMatchScore || 0)
        ),
      };
    })
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));

  const best = candidates[0];
  if (!best || Number(best.score || 0) < Math.max(minScore, currentScore + 0.08)) {
    return { candidate: null, action: null, score: currentScore };
  }

  return {
    candidate: best.candidate,
    action: "recut_timing_window",
    score: best.score,
  };
};

const repairTimelineClipSequence = ({ clips = [], minDurationSec = 1.8 } = {}) => {
  const actions = [];
  if (!Array.isArray(clips) || clips.length < 2) {
    return { clips, actions };
  }

  for (let index = 1; index < clips.length; index += 1) {
    const previous = clips[index - 1];
    const clip = clips[index];
    const sameBlock = String(previous.block_id || previous.scene_index || "") === String(clip.block_id || clip.scene_index || "");
    if (!sameBlock) continue;

    const repeatedFamily = clip.visual_family && previous.visual_family && clip.visual_family === previous.visual_family;
    const repeatedSource = clip.source_url && previous.source_url && clip.source_url === previous.source_url;
    const repeatedFunction = clip.scene_function && previous.scene_function && clip.scene_function === previous.scene_function;
    if (!repeatedFamily && !repeatedSource && !repeatedFunction) continue;

    const existingActions = Array.isArray(clip.timeline_repair_actions) ? clip.timeline_repair_actions : [];
    clip.timeline_repair_actions = unique([...existingActions, "adjacent_repetition_repair_hint"]);
    clip.timeline_repair_hint = "replace_or_recut_repeated_visual_family";
    actions.push({
      clip_index: clip.clip_index,
      block_id: clip.block_id || "",
      action: "adjacent_repetition_repair_hint",
      reason: repeatedFamily ? "repeated_visual_family" : repeatedSource ? "repeated_source" : "repeated_scene_function",
    });

    const duration = Number(clip.clip_duration_seconds || 0);
    if (duration > minDurationSec + 0.4) {
      clip.recommended_trim_sec = round3(Math.min(0.45, duration - minDurationSec));
      actions.push({
        clip_index: clip.clip_index,
        block_id: clip.block_id || "",
        action: "shorten_repetitive_clip",
        recommended_trim_sec: clip.recommended_trim_sec,
      });
    }
  }

  return { clips, actions };
};

module.exports = {
  findLocalRecutCandidate,
  repairTimelineClipSequence,
  __test__: {
    scoreLocalWindowForMicro,
    isProofSafe,
    supportsMicroNeed,
  },
};
