const { config } = require("../config/env");
const { getCachedAudioIntelligence } = require("./audioIntelligence");
const {
  buildNarrativeBlocks,
  detectLocation,
  detectLandmarks,
  detectSubtheme,
  isSameLocation,
  belongsToTopic,
  buildSemanticTerms,
} = require("./narrativeBlockPlanner");
const { isPublishableAsset } = require("./assetReadinessService");
const { isSameCountry } = require("./assetRejectionService");
const { rankCandidates, registerClipUsage, buildVisualSignature } = require("./timelineScoringService");
const { generateFallbackAsset, isImagenEnabled } = require("./geminiGenerationService");
const { logger } = require("../utils/logger");

const OUTPUT_WIDTH = Number(config.OUTPUT_WIDTH || 1920);
const OUTPUT_HEIGHT = Number(config.OUTPUT_HEIGHT || 1080);
const PREFERRED_OUTPUT = { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT };

const SYNC_POLICIES = {
  "cost-efficient": {
    mode: "cost-efficient",
    max_topic_switch_latency_sec: Number(config.HARD_BOUNDARY_MAX_LAG_SEC || config.SEMANTIC_SYNC_MAX_LATENCY_SEC || 0.5),
    min_clip_duration_sec: 2.8,
    max_clip_duration_sec: 6.5,
    preferred_clip_duration_sec: 4.5,
    min_candidate_score: -2,
  },
  "high-quality": {
    mode: "high-quality",
    max_topic_switch_latency_sec: Number(config.HARD_BOUNDARY_MAX_LAG_SEC || config.SEMANTIC_SYNC_MAX_LATENCY_SEC || 0.5),
    min_clip_duration_sec: 2.5,
    max_clip_duration_sec: 7,
    preferred_clip_duration_sec: 4.2,
    min_candidate_score: -2,
  },
};

const round3 = (value) => Number(Number(value || 0).toFixed(3));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const unique = (values = []) => [...new Set(values.filter(Boolean))];

const isVideoFile = (filePath = "") => /\.(mp4|mov|webm|mkv|avi)$/i.test(filePath);
const isVideoAsset = (asset = {}) => (asset.asset_type || asset.type || "") === "video" || isVideoFile(asset.local_path || "");
const getAssetDuration = (asset = {}) => Number(asset.source_duration_seconds || asset.duration_estimate || 0);
const getAssetResolution = (asset = {}) => ({ width: Number(asset.resolution?.width || 0), height: Number(asset.resolution?.height || 0) });
const getAssetIdentity = (asset = {}, index = 0) => asset.asset_id || asset.local_path || asset.source_url || `asset_${index + 1}`;

const getSyncPolicy = () => {
  const mode = String(config.SEMANTIC_SYNC_MODE || "cost-efficient").toLowerCase();
  return SYNC_POLICIES[mode] || SYNC_POLICIES["cost-efficient"];
};

const getHardBoundaryPolicy = () => ({
  enabled: config.HARD_BOUNDARY_ENABLED !== false,
  max_topic_switch_latency_sec: Number(config.HARD_BOUNDARY_MAX_LAG_SEC || config.SEMANTIC_SYNC_MAX_LATENCY_SEC || 0.5),
  forbid_neutral_first_clip: Boolean(config.HARD_BOUNDARY_FORBID_NEUTRAL_FIRST_CLIP),
  require_location_on_hard_boundary: Boolean(config.HARD_BOUNDARY_REQUIRE_LOCATION),
  require_chapter_overlay: Boolean(config.HARD_BOUNDARY_REQUIRE_CHAPTER_OVERLAY),
  fail_on_missing_boundary_candidate: Boolean(config.HARD_BOUNDARY_FAIL_ON_MISS),
});

const normalizeAssetAnalysisWindows = (asset = {}) => {
  const assetDuration = round3(getAssetDuration(asset));
  const fallbackEndSeconds = assetDuration || Number(asset.analysis_window_seconds || 6) || 6;
  const rawWindows = Array.isArray(asset.analysis_windows) && asset.analysis_windows.length
    ? asset.analysis_windows
    : [{
        window_index: 1,
        start_seconds: 0,
        end_seconds: fallbackEndSeconds,
        summary: asset.analysis_summary || asset.semantic_text || asset.query || "travel footage",
        tags: unique([...(asset.analysis_tags || []), ...(asset.provider_tags || [])]),
        confidence: asset.is_fallback ? 0.35 : 0.45,
        method: asset.analysis_provider || "metadata_fallback",
        visual_evidence_source: asset.analysis_provider || "metadata_fallback",
      }];

  return rawWindows.map((window, index) => {
    const startSeconds = round3(Math.max(0, Number(window.start_seconds ?? window.start_sec ?? 0)));
    const endSeconds = round3(Math.max(startSeconds + 0.5, Math.min(fallbackEndSeconds || startSeconds + 6, Number(window.end_seconds ?? window.end_sec ?? fallbackEndSeconds))));
    const description = window.description || window.summary || window.semantic_text || asset.analysis_summary || asset.semantic_text || asset.query || "travel footage";
    const tags = unique([...(window.tags || []), ...(asset.analysis_tags || []), ...(asset.provider_tags || [])]).slice(0, 16);
    const visualText = `${description} ${tags.join(" ")} ${asset.query || ""} ${asset.semantic_text || ""}`;
    const location = detectLocation(visualText, window.location);
    const landmarks = detectLandmarks(visualText, window.landmarks);
    const visualEvidenceSource = window.visual_evidence_source || window.method || asset.analysis_provider || "metadata_fallback";
    const rawConfidence = clamp(Number(window.confidence || window.visual_confidence || 0.45), 0, 1);
    const confidence = visualEvidenceSource === "metadata_fallback" ? Math.min(rawConfidence, 0.35) : rawConfidence;
    const brightness = Number(window.quality?.brightness || 0.7);

    return {
      window_index: Number(window.window_index || index + 1),
      start_seconds: startSeconds,
      end_seconds: endSeconds,
      duration_seconds: round3(endSeconds - startSeconds),
      summary: description,
      description,
      tags,
      location,
      landmarks,
      location_type: window.location_type || detectSubtheme(visualText).subtheme,
      visual_features: {
        shot_type: window.visual_features?.shot_type || window.shot_type || "unknown",
        camera_motion: window.visual_features?.camera_motion || window.camera_motion || "unknown",
        dominant_colors: window.visual_features?.dominant_colors || [],
        has_people: Boolean(window.visual_features?.has_people),
        has_water: Boolean(window.visual_features?.has_water || /rio|river|water|sea|mar|ocean|beach|praia/i.test(visualText)),
        has_architecture: Boolean(window.visual_features?.has_architecture || /building|architecture|fachada|palace|castle|ponte|bridge/i.test(visualText)),
      },
      quality: {
        sharpness: Number(window.quality?.sharpness || 0.7),
        stability: Number(window.quality?.stability || 0.7),
        brightness,
        usable: window.quality?.usable !== false,
        resolution_score: 0.5,
      },
      detected_visual_categories: unique(window.detected_visual_categories || []),
      detected_objects: unique(window.detected_objects || []),
      visual_intent_match: window.visual_intent_match === true,
      generic_visual: Boolean(window.generic_visual),
      required_evidence_found: unique(window.required_evidence_found || []),
      missing_required_visual_evidence: unique(window.missing_required_visual_evidence || []),
      confidence,
      neutral: Boolean(window.neutral) || (!location.city && /travel|road|map|airplane|landscape|generic|overview/i.test(visualText)),
      analysis_provider: window.method || asset.analysis_provider || "metadata_fallback",
      visual_evidence_source: visualEvidenceSource,
    };
  });
};

const flattenAssetWindows = (assets = []) => {
  const windows = [];

  assets.forEach((asset, assetIndex) => {
    const assetIdentity = getAssetIdentity(asset, assetIndex);
    normalizeAssetAnalysisWindows(asset).forEach((window, windowIndex) => {
      const semanticText = `${window.description || ""} ${(window.tags || []).join(" ")} ${asset.query || ""} ${asset.semantic_text || ""}`.trim();
      const { width, height } = getAssetResolution(asset);
      const resolutionScore = width >= OUTPUT_WIDTH && height >= OUTPUT_HEIGHT ? 1 : width >= 1280 && height >= 720 ? 0.75 : 0.35;

      windows.push({
        id: `${Buffer.from(String(assetIdentity)).toString("base64").replace(/=+$/g, "").slice(0, 18)}_w${String(window.window_index || windowIndex + 1).padStart(2, "0")}`,
        asset_id: assetIdentity,
        asset_index: assetIndex,
        asset,
        source: asset.provider || "unknown",
        scene_index: Number(asset.scene_index || 0),
        start_sec: window.start_seconds,
        end_sec: window.end_seconds,
        duration_sec: window.duration_seconds,
        description: window.description,
        summary: window.summary,
        tags: window.tags,
        location: window.location,
        landmarks: window.landmarks,
        location_type: window.location_type,
        visual_features: window.visual_features,
        quality: {
          ...window.quality,
          resolution_score: resolutionScore,
        },
        detected_visual_categories: window.detected_visual_categories,
        detected_objects: window.detected_objects,
        visual_intent_match: window.visual_intent_match,
        generic_visual: window.generic_visual,
        required_evidence_found: window.required_evidence_found,
        missing_required_visual_evidence: window.missing_required_visual_evidence,
        confidence: window.confidence,
        neutral: window.neutral,
        visual_evidence_source: window.visual_evidence_source,
        semantic_text: semanticText,
        window_index: window.window_index,
        analysis_provider: window.analysis_provider,
      });
    });
  });

  return windows;
};

const buildFallbackCandidate = (fallbackAsset) => ({
  ...flattenAssetWindows([fallbackAsset])[0],
  neutral: true,
  confidence: 0.25,
  semantic_text: fallbackAsset.semantic_text || fallbackAsset.query || "neutral travel fallback",
});

const buildChapterCardCandidate = ({ block, fallbackAsset }) => {
  if (!fallbackAsset) return null;
  const base = buildFallbackCandidate(fallbackAsset);
  const expectedLocation = block.expected_location || block.location?.city || block.macro_topic || "";

  return {
    ...base,
    neutral: false,
    chapter_card_clip: true,
    semantic_text: `${expectedLocation} chapter transition card`.trim(),
    description: `${expectedLocation} chapter transition card`.trim(),
    location: {
      city: expectedLocation,
      country: block.location?.country || "",
      confidence: 1,
      source: "chapter_card",
    },
    visual_evidence_source: "chapter_card",
    analysis_provider: "chapter_card",
  };
};

const isCandidateAllowedByHardRules = ({ block, candidate, previousMacroTopic }) => {
  if (candidate.quality?.usable === false) return false;

  const candidateCity = candidate.location?.city || "";
  const candidateCountry = candidate.location?.country || "";
  const candidateLandmarks = candidate.landmarks || [];
  const expectedCity = block.location?.city || (block.topic_type === "city" ? block.macro_topic : "");
  const expectedCountry = block.expected_country || block.location?.country || "";

  // País errado = bloqueio absoluto (pega clips de Roma/Glasgow mesmo sem
  // alias de cidade conhecida).
  if (expectedCountry && candidateCountry && !isSameCountry(candidateCountry, expectedCountry)) {
    return false;
  }

  if (previousMacroTopic && block.hard_boundary) {
    if (candidateCity && belongsToTopic(candidateCity, previousMacroTopic)) return false;
    if (candidateLandmarks.some((landmark) => belongsToTopic(landmark.name, previousMacroTopic) || belongsToTopic(landmark.city, previousMacroTopic))) {
      return false;
    }
  }

  if (expectedCity) {
    if (candidateCity && !isSameLocation(candidateCity, expectedCity)) return false;
    const wrongLandmark = candidateLandmarks.some((landmark) => landmark.city && !isSameLocation(landmark.city, expectedCity));
    if (wrongLandmark) return false;

    // Modo strict: cena exige local e o candidato não confirmou cidade
    // nem é neutral verificado → bloqueia (fail-closed). Cobre tanto
    // assets analisados por visão quanto metadata_fallback sem cidade.
    if (
      (config.LOCATION_GATE_MODE || "strict") === "strict" &&
      !block.generic_asset_allowed &&
      !candidateCity &&
      !candidate.neutral
    ) {
      return false;
    }
  }

  return true;
};

const filterCandidatesByHardRules = ({
  block,
  assetWindows,
  previousMacroTopic,
  fallbackAsset,
  allowPlaceholderFallback = true,
  isBoundaryFirstSlot = false,
  hardBoundaryPolicy = getHardBoundaryPolicy(),
}) => {
  const expectedLocation = block.expected_location || block.location?.city || (block.topic_type === "city" ? block.macro_topic : "");

  // FASE 1: Priorizar assets da mesma cena (scene_index) — impede contaminação cruzada
  const sceneLocal = assetWindows.filter((c) => c.scene_index === block.scene_index);
  const sceneStrict = sceneLocal.filter((candidate) => isCandidateAllowedByHardRules({ block, candidate, previousMacroTopic }));

  // FASE 2: Se a cena local não é suficiente, expandir para pool global filtrado
  let strict = sceneStrict.length >= 2
    ? sceneStrict
    : assetWindows.filter((candidate) => isCandidateAllowedByHardRules({ block, candidate, previousMacroTopic }));

  if (isBoundaryFirstSlot && hardBoundaryPolicy.forbid_neutral_first_clip) {
    strict = strict.filter((candidate) => !candidate.neutral);
  }

  if (isBoundaryFirstSlot && hardBoundaryPolicy.require_location_on_hard_boundary && expectedLocation) {
    strict = strict.filter((candidate) => {
      const candidateCity = candidate.location?.city || "";
      return candidateCity && isSameLocation(candidateCity, expectedLocation);
    });
  }

  if (strict.length) return strict;

  if (isBoundaryFirstSlot) {
    if (block.chapter_card_required && allowPlaceholderFallback) {
      const chapterCardCandidate = buildChapterCardCandidate({ block, fallbackAsset });
      if (chapterCardCandidate) return [chapterCardCandidate];
    }

    if (hardBoundaryPolicy.fail_on_missing_boundary_candidate || hardBoundaryPolicy.forbid_neutral_first_clip) {
      return [];
    }
  }

  const neutral = assetWindows.filter((candidate) => candidate.neutral && candidate.scene_index === block.scene_index);
  if (neutral.length) return neutral;

  const generalNeutral = assetWindows.filter((candidate) => candidate.neutral);
  if (generalNeutral.length) return generalNeutral;

  return allowPlaceholderFallback ? [buildFallbackCandidate(fallbackAsset)] : [];
};

const getNarrationTextBetween = ({ words = [], startSeconds = 0, endSeconds = 0, fallback = "", block = null }) => {
  // Janela expandida: ±2s para capturar landmarks mencionados perto do slot
  const expandedStart = Math.max(0, startSeconds - 2);
  const expandedEnd = endSeconds + 2;
  const matchedWords = words
    .filter((word) => Number(word.start || 0) < expandedEnd && Number(word.end || 0) > expandedStart)
    .map((word) => word.word)
    .filter(Boolean);
  let text = matchedWords.length ? matchedWords.join(" ") : fallback;

  // Sempre anexar landmarks do bloco para que o ranking saiba o que a cena exige
  if (block) {
    const landmarkNames = (block.landmarks || []).map((l) => l.name).filter(Boolean);
    if (landmarkNames.length) text += " " + landmarkNames.join(" ");
    if (block.location?.city) text += " " + block.location.city;
  }
  return text;
};

const splitBlockIntoTimelineSlots = ({ block, policy, pauseMarkers = [] }) => {
  const slots = [];
  let cursor = Number(block.start_sec || 0);
  const end = Number(block.end_sec || cursor);

  while (cursor < end - 0.05) {
    const remaining = round3(end - cursor);
    if (remaining <= policy.max_clip_duration_sec) {
      slots.push({ start: round3(cursor), end: round3(end), duration: remaining, cutReason: block.hard_boundary && slots.length === 0 ? "block_transition" : "duration_limit" });
      break;
    }

    const idealCount = Math.max(2, Math.ceil(remaining / policy.preferred_clip_duration_sec));
    const evenDuration = round3(remaining / idealCount);
    if (evenDuration >= policy.min_clip_duration_sec && evenDuration <= policy.max_clip_duration_sec) {
      const nextEnd = round3(Math.min(end, cursor + evenDuration));
      slots.push({
        start: round3(cursor),
        end: nextEnd,
        duration: round3(nextEnd - cursor),
        cutReason: block.hard_boundary && slots.length === 0 ? "block_transition" : "semantic_shift",
      });
      cursor = nextEnd;
      continue;
    }

    const minEnd = cursor + policy.min_clip_duration_sec;
    const maxEnd = Math.min(end, cursor + policy.max_clip_duration_sec);
    const preferredEnd = Math.min(end, cursor + policy.preferred_clip_duration_sec);
    const marker = pauseMarkers
      .filter((pause) => Number(pause.start || 0) >= minEnd && Number(pause.start || 0) <= maxEnd)
      .sort((left, right) => Math.abs(Number(left.start || 0) - preferredEnd) - Math.abs(Number(right.start || 0) - preferredEnd))[0];

    if (marker) {
      slots.push({
        start: round3(cursor),
        end: round3(marker.start),
        duration: round3(Number(marker.start || 0) - cursor),
        cutReason: block.hard_boundary && slots.length === 0 ? "block_transition" : "pause_marker",
      });
      cursor = Number(marker.start || cursor);
      continue;
    }

    const nextEnd = clamp(preferredEnd, minEnd, maxEnd);
    slots.push({
      start: round3(cursor),
      end: round3(nextEnd),
      duration: round3(nextEnd - cursor),
      cutReason: block.hard_boundary && slots.length === 0 ? "block_transition" : "duration_limit",
    });
    cursor = nextEnd;
  }

  if (slots.length > 1) {
    const last = slots[slots.length - 1];
    if (last.duration < policy.min_clip_duration_sec * 0.6) {
      const previous = slots[slots.length - 2];
      previous.end = last.end;
      previous.duration = round3(previous.end - previous.start);
      previous.cutReason = previous.cutReason === "pause_marker" ? "semantic_shift" : previous.cutReason;
      slots.pop();
    }
  }

  return slots;
};

const buildVideoSourceWindow = ({ asset, clipDuration, preferredWindow = null, assetReuseIndex = 0, clipIndex = 1, draftVersion = 1 }) => {
  const assetDuration = getAssetDuration(asset);
  const safeClipDuration = round3(Number(clipDuration || 0));

  if (!isVideoAsset(asset) || !assetDuration || assetDuration <= safeClipDuration + 0.25) {
    return { source_start_seconds: 0, source_end_seconds: safeClipDuration, asset_duration_seconds: round3(assetDuration) };
  }

  if (preferredWindow) {
    const windowStart = Number(preferredWindow.start_sec ?? preferredWindow.start_seconds ?? 0);
    const windowEnd = Number(preferredWindow.end_sec ?? preferredWindow.end_seconds ?? assetDuration);
    const windowDuration = Math.max(0.25, windowEnd - windowStart);

    if (windowDuration >= safeClipDuration) {
      const extraTime = Math.max(0, windowDuration - safeClipDuration);
      const variation = ((assetReuseIndex * 0.29) + ((clipIndex - 1) * 0.13) + (draftVersion * 0.17)) % 1;
      const start = round3(clamp(windowStart + extraTime * variation, 0, Math.max(0, assetDuration - safeClipDuration)));
      return {
        source_start_seconds: start,
        source_end_seconds: round3(Math.min(assetDuration, start + safeClipDuration)),
        asset_duration_seconds: round3(assetDuration),
      };
    }
  }

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

const chooseOutputResolution = () => PREFERRED_OUTPUT;

const summarizeRejectedReasons = (ranked = []) => {
  const counts = new Map();
  ranked.slice(1).forEach((item) => {
    (item.rejected_reasons || []).forEach((reason) => counts.set(reason, (counts.get(reason) || 0) + 1));
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason]) => reason);
};

const evaluateHardBoundaryDeterministic = ({ clips = [], microBlocks = [], hardBoundaryPolicy = getHardBoundaryPolicy() }) => {
  const hardBoundaries = microBlocks.filter((block) => block.hard_boundary);
  if (!hardBoundaries.length || !hardBoundaryPolicy.enabled) {
    return {
      status: "pass",
      max_visual_lag_sec: 0,
      avg_visual_lag_sec: 0,
      boundaries: [],
      violations: [],
    };
  }

  const reports = [];
  const violations = [];
  const lagValues = [];

  hardBoundaries.forEach((block) => {
    const boundarySec = Number(block.expected_visual_start_sec ?? block.start_sec ?? 0);
    const expectedLocation = block.expected_location || block.location?.city || (block.topic_type === "city" ? block.macro_topic : "");
    const boundaryId = block.boundary_id || block.id;
    const crossingClip = clips.find((clip) => {
      const start = Number(clip.timeline_start_sec || 0);
      const end = Number(clip.timeline_end_sec || 0);
      return start < boundarySec - 0.001 && end > boundarySec + 0.001;
    });
    const firstClip = clips.find((clip) => Number(clip.timeline_start_sec || 0) >= boundarySec - 0.001);
    const detectedCity = firstClip?.detected_location?.city || "";
    const lagSec = firstClip
      ? Math.max(0, Number(firstClip.timeline_start_sec || boundarySec) - boundarySec)
      : hardBoundaryPolicy.max_topic_switch_latency_sec + 1;

    lagValues.push(round3(lagSec));

    const boundaryViolations = [];
    if (crossingClip) boundaryViolations.push("boundary_crossing");
    if (!firstClip) boundaryViolations.push("missing_first_clip");
    if (hardBoundaryPolicy.forbid_neutral_first_clip && firstClip?.neutral_fallback) boundaryViolations.push("neutral_first_clip_forbidden");
    if (hardBoundaryPolicy.require_location_on_hard_boundary && expectedLocation && !detectedCity) boundaryViolations.push("missing_location_on_first_clip");
    if (expectedLocation && detectedCity && !isSameLocation(detectedCity, expectedLocation)) boundaryViolations.push("wrong_boundary_city");
    if (lagSec > hardBoundaryPolicy.max_topic_switch_latency_sec) boundaryViolations.push("max_visual_lag_exceeded");

    const report = {
      boundary_id: boundaryId,
      boundary_sec: round3(boundarySec),
      expected_location: expectedLocation,
      transition_type: block.transition_type || "hard",
      first_clip_index: firstClip?.clip_index || null,
      first_clip_start_sec: round3(firstClip?.timeline_start_sec || 0),
      first_clip_end_sec: round3(firstClip?.timeline_end_sec || 0),
      first_clip_city: detectedCity,
      first_clip_neutral: Boolean(firstClip?.neutral_fallback),
      lag_sec: round3(lagSec),
      crossing_detected: Boolean(crossingClip),
      chapter_card_required: Boolean(block.chapter_card_required),
      chapter_trigger: block.chapter_trigger || null,
      status: boundaryViolations.length ? "fail" : "pass",
      violations: boundaryViolations,
    };

    reports.push(report);
    if (boundaryViolations.length) {
      violations.push(report);
    }
  });

  return {
    status: violations.length ? "fail" : "pass",
    max_visual_lag_sec: round3(Math.max(0, ...lagValues, 0)),
    avg_visual_lag_sec: round3(lagValues.reduce((acc, lag) => acc + lag, 0) / Math.max(1, lagValues.length)),
    boundaries: reports,
    violations,
  };
};

const computeTimelineSyncMetrics = ({ clips, macroBlocks, policy }) => {
  const lags = [];
  let wrongTopicExposureSec = 0;
  const issues = [];

  macroBlocks.forEach((macro, index) => {
    if (index === 0) return;
    const boundary = Number(macro.start_sec || 0);
    const previousTopic = macroBlocks[index - 1]?.topic || "";
    const crossingClip = clips.find((clip) => Number(clip.timeline_start_sec || 0) < boundary - 0.001 && Number(clip.timeline_end_sec || 0) > boundary + 0.001);
    if (crossingClip) {
      issues.push({
        type: "boundary_crossing",
        boundary_sec: round3(boundary),
        previous_topic: previousTopic,
        expected_topic: macro.topic,
        clip_index: crossingClip.clip_index,
      });
    }

    const firstAfterBoundary = clips.find((clip) => Number(clip.timeline_start_sec || 0) >= boundary - 0.001);
    const isWrong = firstAfterBoundary?.detected_location?.city && belongsToTopic(firstAfterBoundary.detected_location.city, previousTopic);
    const lag = isWrong ? Math.max(0, Number(firstAfterBoundary.timeline_start_sec || boundary) - boundary) : 0;
    lags.push(round3(lag));

    if (lag > policy.max_topic_switch_latency_sec) {
      issues.push({
        type: "topic_switch_lag",
        boundary_sec: round3(boundary),
        previous_topic: previousTopic,
        expected_topic: macro.topic,
        lag_sec: round3(lag),
      });
    }

    if (macro.topic_type === "city" && firstAfterBoundary?.detected_location?.city && !isSameLocation(firstAfterBoundary.detected_location.city, macro.topic)) {
      issues.push({
        type: "wrong_boundary_city",
        boundary_sec: round3(boundary),
        expected_topic: macro.topic,
        detected_city: firstAfterBoundary.detected_location.city,
        clip_index: firstAfterBoundary.clip_index,
      });
    }
  });

  clips.forEach((clip) => {
    const expected = clip.macro_topic;
    const detectedCity = clip.detected_location?.city || "";
    if (expected && detectedCity && !isSameLocation(expected, detectedCity) && clip.topic_type === "city") {
      wrongTopicExposureSec += Number(clip.clip_duration_seconds || 0);
    }
  });

  const sortedLags = [...lags].sort((a, b) => a - b);
  const p95Index = sortedLags.length ? Math.min(sortedLags.length - 1, Math.ceil(sortedLags.length * 0.95) - 1) : 0;
  const semanticScores = clips.map((clip) => Number(clip.timeline_score || 0));

  return {
    avg_topic_lag_sec: round3(lags.reduce((acc, item) => acc + item, 0) / Math.max(1, lags.length)),
    p95_topic_lag_sec: round3(sortedLags[p95Index] || 0),
    max_visual_lag_sec: round3(sortedLags.length ? sortedLags[sortedLags.length - 1] : 0),
    wrong_topic_exposure_sec: round3(wrongTopicExposureSec),
    semantic_alignment_score: round3(semanticScores.reduce((acc, item) => acc + item, 0) / Math.max(1, semanticScores.length)),
    hard_boundary_count: Math.max(0, macroBlocks.length - 1),
    issues,
  };
};

const buildTimeline = async ({ state, audioDuration, draftVersion, fallbackAsset, allowPlaceholderFallback = config.ALLOW_PLACEHOLDER_ASSETS }) => {
  const videoId = state.video_id || "unknown";
  const policy = getSyncPolicy();
  const hardBoundaryPolicy = getHardBoundaryPolicy();
  const audioIntelligence = await getCachedAudioIntelligence({ videoId }).catch(() => null);
  const { macroBlocks, microBlocks } = buildNarrativeBlocks({ state, audioIntelligence, audioDuration });
  const allAssets = Array.isArray(state.assets_json?.items) ? state.assets_json.items : [];
  const sceneAssetReadiness = Array.isArray(state.assets_json?.scene_asset_readiness)
    ? state.assets_json.scene_asset_readiness
    : [];
  const blockingSceneIndexes = !allowPlaceholderFallback
    ? sceneAssetReadiness.filter((entry) => entry.ready === false).map((entry) => Number(entry.scene_index || 0))
    : [];

  if (!allowPlaceholderFallback && blockingSceneIndexes.length) {
    throw new Error(`Timeline blocked: missing publishable assets for scene(s) ${blockingSceneIndexes.join(", ")}.`);
  }

  const eligibleAssets = allowPlaceholderFallback
    ? allAssets
    : allAssets.filter((asset) => isPublishableAsset(asset, { mockMode: false }));
  const assetWindows = flattenAssetWindows(eligibleAssets.length ? eligibleAssets : allowPlaceholderFallback ? [fallbackAsset] : []);
  const fallbackCandidate = allowPlaceholderFallback ? buildFallbackCandidate(fallbackAsset) : null;

  if (!allowPlaceholderFallback && !assetWindows.length) {
    throw new Error("Timeline blocked: no publishable assets available for render.");
  }
  const usage = {
    usedSourceUrls: new Map(),
    usedAssetIds: new Map(),
    usedLocalPaths: new Map(),
    usedWindowIds: new Map(),
    usedProviders: new Map(),
    usedBlockAssetIds: new Map(),
    usedVisualSignatures: new Map(),
    usedLandmarks: new Map(),
    lastClipByAssetId: new Map(),
  };
  const clips = [];
  const pauseMarkers = Array.isArray(audioIntelligence?.pause_markers) ? audioIntelligence.pause_markers : [];

  for (let blockIndex = 0; blockIndex < microBlocks.length; blockIndex += 1) {
    const block = microBlocks[blockIndex];
    const previousBlock = microBlocks[blockIndex - 1] || null;
    const previousMacroTopic = block.hard_boundary ? previousBlock?.macro_topic || "" : "";
    const slots = splitBlockIntoTimelineSlots({ block, policy, pauseMarkers });

    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const slot = slots[slotIndex];
      const isBoundaryFirstSlot = Boolean(block.hard_boundary && slotIndex === 0);
      const sceneFallbackNarration = `${block.topic || ""} ${block.narration_excerpt || ""} ${(block.keywords || []).join(" ")}`.trim();
      const narrationText = getNarrationTextBetween({
        words: audioIntelligence?.words || [],
        startSeconds: slot.start,
        endSeconds: slot.end,
        fallback: sceneFallbackNarration,
        block,
      });
      const candidates = filterCandidatesByHardRules({
        block,
        assetWindows,
        previousMacroTopic,
        fallbackAsset,
        allowPlaceholderFallback,
        isBoundaryFirstSlot,
        hardBoundaryPolicy,
      });
      const ranked = await rankCandidates({
        block: {
          ...block,
          is_boundary_first_slot: isBoundaryFirstSlot,
        },
        narrationText,
        candidates,
        previousMacroTopic,
        usage,
        videoId,
        clipIndex: clips.length + 1,
        hardBoundaryPolicy,
        isBoundaryFirstSlot,
      });
      let selected = ranked.find((item) => !item.hard_blocked) || (fallbackCandidate
        ? { candidate: fallbackCandidate, score: -10, features: {}, selection_reason: "fallback" }
        : null);

      // Gemini Imagen fallback: pool esgotado → gerar imagem com Ken Burns
      if (!selected && isImagenEnabled() && !config.DISABLE_GEMINI_GENERATION) {
        const generatedAsset = await generateFallbackAsset(block, videoId).catch(() => null);
        if (generatedAsset) {
          selected = { candidate: generatedAsset, score: -5, features: {}, selection_reason: "gemini_generated_fallback" };
          logger.info("timelinePlanner: usando asset gerado pelo Gemini", {
            scene: block.scene_index,
            topic: block.topic,
            city: block.location?.city,
          });
        }
      }

      if (!selected?.candidate || (isBoundaryFirstSlot && selected.hard_blocked && hardBoundaryPolicy.fail_on_missing_boundary_candidate)) {
        throw new Error(`Timeline blocked: no publishable candidate available for scene ${block.scene_index}.`);
      }

      const candidate = selected.candidate || fallbackCandidate;
      const expectedLocation = block.expected_location || block.location?.city || (block.topic_type === "city" ? block.macro_topic : "");
      if (
        isBoundaryFirstSlot
        && hardBoundaryPolicy.forbid_neutral_first_clip
        && candidate.neutral
      ) {
        throw new Error(`Hard boundary blocked: neutral first clip is forbidden for scene ${block.scene_index}.`);
      }
      if (
        isBoundaryFirstSlot
        && hardBoundaryPolicy.require_location_on_hard_boundary
        && expectedLocation
        && !candidate.location?.city
      ) {
        throw new Error(`Hard boundary blocked: missing location for first clip of ${expectedLocation}.`);
      }
      const assetReuseIndex = usage.usedAssetIds.get(candidate.asset_id) || 0;
      const sourceWindow = buildVideoSourceWindow({
        asset: candidate.asset,
        clipDuration: slot.duration,
        preferredWindow: candidate,
        assetReuseIndex,
        clipIndex: clips.length + 1,
        draftVersion,
      });
      const detectedVisualCategories = unique([
        ...(candidate.detected_visual_categories || []),
        ...((selected.features?.detectedVisualCategories) || []),
      ]);
      registerClipUsage({ usage, block, candidate, clipIndex: clips.length + 1 });

      clips.push({
        clip_index: clips.length + 1,
        scene_index: block.scene_index,
        scene_role: block.role || "body",
        scene_order: block.scene_order,
        title: block.topic,
        narration_excerpt: block.narration_excerpt,
        clip_script_excerpt: narrationText.slice(0, 240),
        clip_script_source: (audioIntelligence?.words || []).length ? "audio_word_timestamps" : "scene_fallback",
        clip_duration_seconds: slot.duration,
        timeline_start_sec: round3(slot.start),
        timeline_end_sec: round3(slot.end),
        clip_start_narrated_at: round3(slot.start),
        clip_end_narrated_at: round3(slot.end),
        cut_reason: slot.cutReason,
        source_start_seconds: sourceWindow.source_start_seconds,
        source_end_seconds: sourceWindow.source_end_seconds,
        asset_duration_seconds: sourceWindow.asset_duration_seconds,
        semantic_match_score: round3(selected.features?.semanticScore || 0),
        block_match_score: round3(selected.features?.blockMatchScore || 0),
        entity_match_score: round3(selected.features?.entityMatchScore || 0),
        visual_specificity_score: round3(selected.features?.visualSpecificityScore || 0),
        reuse_penalty: round3(selected.features?.reusePenalty || 0),
        timeline_score: round3(selected.score || 0),
        composite_score: round3(selected.score || 0),
        semantic_match_method: selected.method || "keyword_fallback",
        semantic_match_terms: buildSemanticTerms([narrationText, candidate.semantic_text]).filter((term) => buildSemanticTerms([narrationText]).includes(term)).slice(0, 12),
        selection_reason: selected.selection_reason || "best_candidate",
        rejected_candidates_count: Math.max(0, ranked.length - 1),
        candidate_debug: {
          top_rejected_reasons: summarizeRejectedReasons(ranked),
        },
        score_features: selected.features || {},
        visual_intent: block.visual_intent,
        required_visual_evidence: block.required_visual_evidence || [],
        allowed_visual_categories: block.allowed_visual_categories || [],
        forbidden_visual_categories: block.forbidden_visual_categories || [],
        asset_semantic_text: candidate.description || candidate.semantic_text || candidate.asset?.semantic_text || candidate.asset?.query || "",
        asset_window_id: candidate.id,
        asset_window_key: `${candidate.asset_id}:${candidate.start_sec}:${candidate.end_sec}`,
        asset_window_summary: candidate.description || candidate.summary || "",
        asset_window_start_seconds: Number(candidate.start_sec || 0),
        asset_window_end_seconds: Number(candidate.end_sec || 0),
        asset_analysis_provider: candidate.analysis_provider,
        detected_visual_categories: detectedVisualCategories,
        detected_objects: candidate.detected_objects || [],
        visual_intent_match: candidate.visual_intent_match === true || Number(selected.features?.visualIntentMatchScore || 0) > 0,
        macro_block_id: block.parent_id,
        micro_block_id: block.id,
        block_id: block.block_id,
        macro_topic: block.macro_topic,
        micro_topic: block.topic,
        subtheme: block.subtheme,
        topic_type: block.topic_type,
        hard_boundary: Boolean(block.hard_boundary),
        hard_boundary_first_clip: isBoundaryFirstSlot,
        transition_type: block.transition_type || (block.hard_boundary ? "hard" : "soft"),
        boundary_id: block.boundary_id || "",
        expected_location: block.expected_location || "",
        expected_visual_start_sec: Number(block.expected_visual_start_sec || block.start_sec || 0),
        chapter_trigger: block.chapter_trigger || null,
        chapter_card_required: Boolean(block.chapter_card_required),
        block_intro_asset: block.block_intro_asset || null,
        chapter_card_clip: Boolean(candidate.chapter_card_clip),
        transition: isBoundaryFirstSlot ? (block.hard_boundary ? "hard_cut" : "soft_cut") : "none",
        detected_location: candidate.location,
        detected_landmarks: candidate.landmarks,
        neutral_fallback: Boolean(candidate.neutral),
        visual_signature: buildVisualSignature(candidate),
        query_used: candidate.asset?.query_used || candidate.asset?.query || "",
        asset: candidate.asset,
      });
    }
  }

  const plannedDuration = clips.reduce((acc, clip) => acc + Number(clip.clip_duration_seconds || 0), 0);
  const durationDiff = round3(Number(audioDuration || 0) - plannedDuration);
  if (clips.length && Math.abs(durationDiff) > 0.02) {
    const lastClip = clips[clips.length - 1];
    lastClip.clip_duration_seconds = round3(Math.max(0.1, Number(lastClip.clip_duration_seconds || 0) + durationDiff));
    lastClip.timeline_end_sec = round3(Number(lastClip.timeline_start_sec || 0) + lastClip.clip_duration_seconds);
    lastClip.clip_end_narrated_at = lastClip.timeline_end_sec;
    lastClip.source_end_seconds = round3(Number(lastClip.source_start_seconds || 0) + lastClip.clip_duration_seconds);
  }

  const uniqueAssetCount = new Set(clips.map((clip) => clip.asset?.local_path || clip.asset?.source_url).filter(Boolean)).size;
  const semanticScores = clips.map((clip) => Number(clip.timeline_score || 0));
  const hardBoundaryValidation = evaluateHardBoundaryDeterministic({ clips, microBlocks, hardBoundaryPolicy });
  if (hardBoundaryPolicy.enabled && hardBoundaryPolicy.fail_on_missing_boundary_candidate && hardBoundaryValidation.status === "fail") {
    const firstViolation = hardBoundaryValidation.violations[0];
    throw new Error(`Hard boundary blocked: ${firstViolation?.violations?.[0] || "validation_failed"} at ${firstViolation?.boundary_id || "unknown_boundary"}.`);
  }

  const timelineSyncMetricsBase = computeTimelineSyncMetrics({
    clips,
    macroBlocks,
    policy: {
      ...policy,
      max_topic_switch_latency_sec: hardBoundaryPolicy.max_topic_switch_latency_sec,
    },
  });
  const timelineSyncMetrics = {
    ...timelineSyncMetricsBase,
    hard_boundary_status: hardBoundaryValidation.status,
    max_visual_lag_sec: round3(Math.max(
      Number(timelineSyncMetricsBase.max_visual_lag_sec || 0),
      Number(hardBoundaryValidation.max_visual_lag_sec || 0)
    )),
    avg_visual_lag_sec: hardBoundaryValidation.avg_visual_lag_sec,
    hard_boundary_reports: hardBoundaryValidation.boundaries,
    hard_boundary_violations: hardBoundaryValidation.violations,
  };

  return {
    clips,
    clipPlan: clips,
    audioDuration,
    totalClipCount: clips.length,
    uniqueAssetCount,
    semanticAlignmentScoreAverage: round3(semanticScores.reduce((acc, score) => acc + score, 0) / Math.max(1, semanticScores.length)),
    lowConfidenceClipCount: semanticScores.filter((score) => score < 0).length,
    narrativeBlocks: macroBlocks,
    microBlocks,
    assetWindows: assetWindows.map((window) => ({
      id: window.id,
      asset_id: window.asset_id,
      scene_index: window.scene_index,
      start_sec: window.start_sec,
      end_sec: window.end_sec,
      description: window.description,
      tags: window.tags,
      location: window.location,
      landmarks: window.landmarks,
      location_type: window.location_type,
      confidence: window.confidence,
      neutral: window.neutral,
      visual_evidence_source: window.visual_evidence_source,
    })),
    syncPolicy: policy,
    hardBoundaryPolicy,
    timelineSyncMetrics,
    transition: "none",
    renderStrategy: "concat",
    requiresExactSync: true,
  };
};

module.exports = {
  buildTimeline,
  chooseOutputResolution,
  buildVideoSourceWindow,
  normalizeAssetAnalysisWindows,
  buildNarrativeBlocks,
  flattenAssetWindows,
  filterCandidatesByHardRules,
  getNarrationTextBetween,
  getSyncPolicy,
  __test__: {
    normalizeAssetAnalysisWindows,
    buildNarrativeBlocks,
    flattenAssetWindows,
    filterCandidatesByHardRules,
    computeTimelineSyncMetrics,
    evaluateHardBoundaryDeterministic,
    detectLocation,
    detectLandmarks,
    detectSubtheme,
    isSameLocation,
    belongsToTopic,
    splitBlockIntoTimelineSlots,
    getNarrationTextBetween,
  },
};
