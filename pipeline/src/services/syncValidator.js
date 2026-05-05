const fs = require("fs-extra");
const { config } = require("../config/env");
const { loadState, updateState } = require("./stateService");
const { getCachedAudioIntelligence } = require("./audioIntelligence");
const { hasOpenAi, describeImagesWithOpenAI } = require("./openaiService");
const { extractVideoFrame, probeMedia } = require("../utils/mediaUtils");
const { buildNarrativeBlocks, isSameLocation } = require("./narrativeBlockPlanner");
const { validateRenderQuality } = require("./renderQualityService");
const { renderVideo } = require("./renderService");
const { generateAssets } = require("./assetsService");

const DEFAULT_QA_THRESHOLD = 0.78;
const FOOD_VISUAL_INTENTS = new Set(["gastronomy", "market", "wine", "pastry", "restaurant", "cafe", "street_food"]);
const GASTRONOMY_THEME_PATTERN = /(gastronom|food|market|mercado|wine|vinho|pastry|pastel|cafe|coffee|restaurant|restaurante|bakery|dessert|docaria|confeitaria|comida)/i;
const MIN_GASTRONOMY_THEME_INTENT_COUNT = 2;
const MIN_GASTRONOMY_THEME_INTENT_RATIO = 0.35;
const round3 = (value) => Number(Number(value || 0).toFixed(3));
const unique = (values = []) => [...new Set(values.filter(Boolean))];

const findClipAtTime = (clips = [], timestampSec = 0) =>
  clips.find((clip) => {
    const start = Number(clip.timeline_start_sec ?? clip.clip_start_narrated_at ?? 0);
    const end = Number(clip.timeline_end_sec ?? clip.clip_end_narrated_at ?? start + Number(clip.clip_duration_seconds || 0));
    return timestampSec >= start - 0.001 && timestampSec < end - 0.001;
  }) || clips[clips.length - 1] || null;

const flattenNarrativeBlocks = (macroBlocks = []) =>
  macroBlocks.flatMap((macro) =>
    (macro.children || []).map((child) => ({
      ...child,
      macro_topic: macro.topic,
      macro_block_id: macro.id,
      topic_type: child.topic_type || macro.topic_type,
    }))
  );

const findNarrativeBlockAtTime = (macroBlocks = [], timestampSec = 0) => {
  const micro = flattenNarrativeBlocks(macroBlocks).find((block) => timestampSec >= Number(block.start_sec || 0) - 0.001 && timestampSec < Number(block.end_sec || 0) - 0.001);
  if (micro) return micro;
  const macro = macroBlocks.find((block) => timestampSec >= Number(block.start_sec || 0) - 0.001 && timestampSec < Number(block.end_sec || 0) - 0.001);
  return macro || macroBlocks[macroBlocks.length - 1] || null;
};

const getHardBoundaries = (macroBlocks = []) =>
  macroBlocks.slice(1).map((block, index) => ({
    timestamp_sec: Number(block.start_sec || 0),
    expected_topic: block.topic,
    expected_topic_type: block.topic_type || "",
    previous_topic: macroBlocks[index]?.topic || "",
    previous_topic_type: macroBlocks[index]?.topic_type || "",
  }));

const buildQaSampleTimestamps = ({ duration, hardBoundaries = [], intervalSec = 2 }) => {
  const safeDuration = Math.max(1, Number(duration || 0));
  const sampleSet = new Set();
  for (let t = 0; t <= safeDuration; t += Math.max(0.5, Number(intervalSec || 2))) {
    sampleSet.add(round3(Math.min(safeDuration - 0.05, t)));
  }
  hardBoundaries.forEach((boundary) => {
    [-1, -0.5, 0, 0.5, 1].forEach((offset) => {
      const sample = boundary.timestamp_sec + offset;
      if (sample >= 0 && sample < safeDuration) sampleSet.add(round3(sample));
    });
  });
  return Array.from(sampleSet).sort((left, right) => left - right);
};

const classifyFromTimelineClip = (clip = null) => {
  if (!clip) {
    return {
      detected_topic: "",
      location: { city: "", country: "", confidence: 0 },
      landmarks: [],
      confidence: 0,
      neutral: true,
      method: "timeline_missing",
    };
  }

  const location = clip.detected_location || { city: "", country: "", confidence: 0 };
  return {
    detected_topic: location.city || (clip.neutral_fallback ? "neutral" : clip.macro_topic || ""),
    location,
    landmarks: clip.detected_landmarks || [],
    confidence: Math.max(0, Math.min(1, Number(clip.timeline_score || 0) / 10 || Number(clip.semantic_match_score || 0))),
    neutral: Boolean(clip.neutral_fallback || (!location.city && /neutral|fallback|travel|generic/i.test(`${clip.asset_semantic_text || ""} ${clip.asset_window_summary || ""}`))),
    method: "timeline_metadata",
    clip_index: clip.clip_index,
  };
};

const classifyFramesWithVision = async ({ renderPath, sampleTimestamps }) => {
  if (!hasOpenAi() || config.SEMANTIC_SYNC_MODE !== "high-quality") return new Map();
  const limitedTimestamps = sampleTimestamps.slice(0, 24);
  const framesDir = `${renderPath}.semantic-qa`;
  await fs.emptyDir(framesDir);

  try {
    const framePaths = [];
    for (let index = 0; index < limitedTimestamps.length; index += 1) {
      const timestamp = limitedTimestamps[index];
      const framePath = `${framesDir}/semantic-frame-${String(index + 1).padStart(3, "0")}.jpg`;
      await extractVideoFrame({ inputPath: renderPath, outputPath: framePath, timeSeconds: timestamp, width: 640, height: 360 });
      framePaths.push(framePath);
    }

    const response = await describeImagesWithOpenAI({
      prompt: `Classifique cada frame em ordem para QA semantico de video de turismo e gastronomia. Retorne JSON estrito: {"frames":[{"frame_index":1,"topic":"","location":{"city":"","country":"","confidence":0},"landmarks":[{"name":"","confidence":0}],"neutral":false,"confidence":0}]}. Nao invente cidade se nao houver evidencia visual clara.`,
      imagePaths: framePaths,
      detail: "low",
    });

    const byTimestamp = new Map();
    (response?.frames || []).forEach((frame, index) => {
      const timestamp = limitedTimestamps[index];
      if (timestamp === undefined) return;
      byTimestamp.set(timestamp, {
        detected_topic: frame.topic || frame.location?.city || "",
        location: {
          city: frame.location?.city || "",
          country: frame.location?.country || "",
          confidence: Number(frame.location?.confidence || frame.confidence || 0),
        },
        landmarks: Array.isArray(frame.landmarks) ? frame.landmarks : [],
        neutral: Boolean(frame.neutral),
        confidence: Number(frame.confidence || frame.location?.confidence || 0),
        method: "openai_vision_frame",
      });
    });
    return byTimestamp;
  } catch {
    return new Map();
  } finally {
    await fs.remove(framesDir).catch(() => null);
  }
};

const scoreExpectedVsDetected = ({ expectedBlock, detected }) => {
  const expectedTopic = expectedBlock?.macro_topic || expectedBlock?.topic || "";
  const expectedType = expectedBlock?.topic_type || "";
  const detectedCity = detected?.location?.city || "";
  const detectedTopic = detected?.detected_topic || "";

  if (!expectedTopic) return { match: true, score: 1, reason: "no_expected_topic" };
  if (expectedType !== "city") {
    if (detected?.neutral || !detectedCity) return { match: true, score: 0.85, reason: "neutral_general_ok" };
    return { match: true, score: 0.82, reason: "general_topic" };
  }
  if (detectedCity && isSameLocation(detectedCity, expectedTopic)) return { match: true, score: Math.max(0.85, Number(detected.confidence || 0.85)), reason: "city_match" };
  if (detectedTopic && isSameLocation(detectedTopic, expectedTopic)) return { match: true, score: Math.max(0.8, Number(detected.confidence || 0.8)), reason: "topic_match" };
  if (detected?.neutral) return { match: true, score: 0.62, reason: "neutral_fallback" };
  if (!detectedCity && !detectedTopic) return { match: false, score: 0.35, reason: "unknown_visual" };
  return { match: false, score: 0, reason: "wrong_topic" };
};

const computeQaMetrics = ({ samples = [], hardBoundaries = [], sampleIntervalSec = 2, maxLatencySec = 1 }) => {
  let wrongTopicExposureSec = 0;
  const scores = [];
  const lags = [];

  samples.forEach((sample, index) => {
    const nextTimestamp = samples[index + 1]?.timestamp_sec;
    const weight = nextTimestamp === undefined ? Math.max(0.5, Number(sampleIntervalSec || 2)) : Math.max(0.1, nextTimestamp - sample.timestamp_sec);
    scores.push(Number(sample.alignment_score || 0));
    if (!sample.match && sample.reason === "wrong_topic") wrongTopicExposureSec += weight;
  });

  hardBoundaries.forEach((boundary) => {
    if (boundary.expected_topic_type !== "city") return;

    const afterSamples = samples.filter((sample) => sample.timestamp_sec >= boundary.timestamp_sec);
    const firstAcceptable = afterSamples.find((sample) => {
      if (sample.detected?.neutral) return true;
      const detectedCity = sample.detected?.location?.city || sample.detected?.detected_topic || "";
      return detectedCity && isSameLocation(detectedCity, boundary.expected_topic);
    });
    const lag = firstAcceptable ? Math.max(0, firstAcceptable.timestamp_sec - boundary.timestamp_sec) : maxLatencySec + sampleIntervalSec;
    lags.push(round3(lag));
  });

  const sortedLags = [...lags].sort((a, b) => a - b);
  const p95Index = sortedLags.length ? Math.min(sortedLags.length - 1, Math.ceil(sortedLags.length * 0.95) - 1) : 0;
  return {
    avg_topic_lag_sec: round3(lags.reduce((acc, item) => acc + item, 0) / Math.max(1, lags.length)),
    p95_topic_lag_sec: round3(sortedLags[p95Index] || 0),
    wrong_topic_exposure_sec: round3(wrongTopicExposureSec),
    semantic_alignment_score: round3(scores.reduce((acc, item) => acc + item, 0) / Math.max(1, scores.length)),
  };
};

const detectFailedRanges = ({ samples = [], metrics, threshold }) => {
  const failed = [];
  samples.forEach((sample) => {
    if (sample.match) {
      if (["general_topic", "neutral_general_ok", "neutral_fallback"].includes(sample.reason)) return;
      if (Number(sample.alignment_score || 0) >= threshold.minSemanticAlignmentScore) return;
    }
    failed.push({
      start_sec: round3(Math.max(0, sample.timestamp_sec - 1)),
      end_sec: round3(sample.timestamp_sec + 1),
      reason: sample.reason || "low_alignment",
      expected_topic: sample.expected_topic,
      detected_topic: sample.detected?.detected_topic || sample.detected?.location?.city || "",
      clip_index: sample.clip_index,
      scene_index: sample.scene_index,
    });
  });

  if (metrics.p95_topic_lag_sec > threshold.maxP95LagSec || metrics.wrong_topic_exposure_sec > threshold.maxWrongTopicExposureSec) return failed;
  return failed.filter((range) => range.reason !== "neutral_fallback");
};

const scoreTimelineDiversity = (clips = []) => {
  if (!clips.length) return 0;
  const uniqueAssets = new Set(clips.map((clip) => clip.local_path || clip.asset?.local_path || clip.asset?.source_url).filter(Boolean)).size;
  const uniqueSignatures = new Set(clips.map((clip) => clip.visual_signature).filter(Boolean)).size;
  const fallbackCount = clips.filter((clip) => clip.neutral_fallback || clip.clip_script_source === "scene_fallback").length;
  const assetScore = uniqueAssets / clips.length;
  const signatureScore = uniqueSignatures / clips.length;
  const fallbackPenalty = fallbackCount / clips.length;
  return round3(Math.max(0, Math.min(1, assetScore * 0.45 + signatureScore * 0.45 + (1 - fallbackPenalty) * 0.1)));
};

const getClipDetectedCategories = (clip = {}) =>
  unique([
    ...(clip.detected_visual_categories || []),
    ...((clip.score_features?.detectedVisualCategories) || []),
  ]);

const clipHasFoodEvidence = (clip = {}) =>
  clipHasCategory(clip, ["food", "local_food", "market", "wine", "pastry", "restaurant", "cafe", "street_food", "people_eating"]);

const clipHasCategory = (clip = {}, categories = []) =>
  getClipDetectedCategories(clip).some((category) => categories.includes(category));

const hasDominantFoodIntent = (items = []) => {
  const total = items.length;
  if (!total) return false;

  const foodIntentCount = items.filter((item) => FOOD_VISUAL_INTENTS.has(item?.visual_intent)).length;
  return foodIntentCount >= MIN_GASTRONOMY_THEME_INTENT_COUNT && (foodIntentCount / total) >= MIN_GASTRONOMY_THEME_INTENT_RATIO;
};

const isGastronomyTheme = ({ state = {}, timeline = {} }) => {
  const declaredTheme = `${state.topic || ""}`;
  if (GASTRONOMY_THEME_PATTERN.test(declaredTheme)) return true;
  if (hasDominantFoodIntent(state.visual_plan || [])) return true;
  if (hasDominantFoodIntent(timeline.clips || [])) return true;
  return false;
};

const computeVisualIntentDistribution = ({ clips = [] }) => {
  const total = Math.max(1, clips.length);
  const count = (predicate) => clips.filter(predicate).length;

  return {
    food_or_plate: round3(count((clip) => clipHasCategory(clip, ["food", "local_food", "pastry", "restaurant", "people_eating"])) / total),
    market: round3(count((clip) => clipHasCategory(clip, ["market", "street_food"])) / total),
    wine: round3(count((clip) => clipHasCategory(clip, ["wine"])) / total),
    restaurant_or_cafe: round3(count((clip) => clipHasCategory(clip, ["restaurant", "cafe", "people_eating"])) / total),
    generic_city: round3(count((clip) => !clipHasFoodEvidence(clip) && clipHasCategory(clip, ["aerial_city", "bridge", "river", "generic_street", "city_landmark", "historic_street"])) / total),
    landscape_or_skyline: round3(count((clip) => !clipHasFoodEvidence(clip) && clipHasCategory(clip, ["landscape", "aerial_city", "coast"])) / total),
  };
};

const evaluateVisualIntentCoverage = ({ state = {}, timeline = {} }) => {
  if (!isGastronomyTheme({ state, timeline })) {
    return {
      applicable: false,
      visual_intent_distribution: {},
      issues: [],
      scene_indexes_to_refresh: [],
      clip_indexes_to_replace: [],
    };
  }

  const clips = timeline.clips || [];
  const distribution = computeVisualIntentDistribution({ clips });
  const issues = [];
  const clipIndexes = new Set();
  const sceneIndexes = new Set();
  const quota = {
    food_or_plate_min_ratio: 0.25,
    market_min_ratio: 0.15,
    wine_min_ratio: 0.15,
    restaurant_or_cafe_min_ratio: 0.15,
    generic_city_max_ratio: 0.2,
    landscape_or_skyline_max_ratio: 0.15,
  };

  clips.forEach((clip) => {
    const foodIntentClip = FOOD_VISUAL_INTENTS.has(clip.visual_intent);
    const hasFoodEvidence = clipHasFoodEvidence(clip);
    const hasGenericVisual = clipHasCategory(clip, ["aerial_city", "bridge", "river", "coast", "generic_street", "landscape"]);

    if (foodIntentClip && (!clip.visual_intent_match || !hasFoodEvidence || hasGenericVisual)) {
      clipIndexes.add(Number(clip.clip_index || 0));
      sceneIndexes.add(Number(clip.scene_index || 0));
    }
  });

  if (distribution.food_or_plate < quota.food_or_plate_min_ratio || distribution.market < quota.market_min_ratio || distribution.wine < quota.wine_min_ratio || distribution.restaurant_or_cafe < quota.restaurant_or_cafe_min_ratio) {
    issues.push({
      type: "visual_intent_underrepresented",
      severity: "high",
      message: "Gastronomy video has too few food/market/wine/restaurant clips",
    });
  }

  if (distribution.generic_city > quota.generic_city_max_ratio) {
    issues.push({
      type: "generic_asset_overuse",
      severity: "high",
      message: "Generic city visuals exceed the allowed ratio for a gastronomy video",
    });
  }

  if (distribution.landscape_or_skyline > quota.landscape_or_skyline_max_ratio) {
    issues.push({
      type: "wrong_visual_category",
      severity: "high",
      message: "Landscape or skyline visuals exceed the allowed ratio for a gastronomy video",
    });
  }

  if (distribution.generic_city > 0.4 || distribution.food_or_plate < 0.18) {
    issues.push({
      type: "theme_visual_mismatch",
      severity: "critical",
      message: "Narrative theme is gastronomy but selected visuals are mostly generic city/landscape",
    });
  }

  return {
    applicable: true,
    visual_intent_distribution: distribution,
    issues,
    scene_indexes_to_refresh: unique(Array.from(sceneIndexes).filter(Boolean)),
    clip_indexes_to_replace: unique(Array.from(clipIndexes).filter(Boolean)),
  };
};

const collectTimelineIssues = ({ timeline, technical, visual, diversityScore }) => {
  const issues = [...(technical.issues || [])];
  const clips = timeline?.clips || [];
  const fallbackClipCount = clips.filter((clip) => clip.clip_script_source === "scene_fallback").length;

  if (Number(visual.metrics?.p95_topic_lag_sec || 0) > Number(timeline?.sync_policy?.max_topic_switch_latency_sec || config.SEMANTIC_SYNC_MAX_LATENCY_SEC || 1)) {
    issues.push({ type: "semantic_lag", severity: "high", p95_topic_lag_sec: visual.metrics.p95_topic_lag_sec });
  }
  if (Number(visual.metrics?.wrong_topic_exposure_sec || 0) > 0) {
    issues.push({ type: "wrong_topic_exposure", severity: "high", wrong_topic_exposure_sec: visual.metrics.wrong_topic_exposure_sec });
  }
  if (fallbackClipCount > 0) {
    issues.push({ type: "scene_fallback_used", severity: fallbackClipCount >= 2 ? "medium" : "low", count: fallbackClipCount });
  }
  if (diversityScore < 0.45) {
    issues.push({ type: "low_diversity", severity: "medium", diversity_score: diversityScore });
  }
  return issues;
};

const identifyClipsForReplacement = ({ timeline, visualResult, issues = [], forcedClipIndexes = [], forcedSceneIndexes = [] }) => {
  const clipIndexes = new Set();
  const sceneIndexes = new Set();
  const clips = timeline?.clips || [];

  if (!issues.length && !(visualResult?.failed_ranges || []).length && !forcedClipIndexes.length && !forcedSceneIndexes.length) {
    return {
      clip_indexes_to_replace: [],
      scene_indexes_to_refresh: [],
    };
  }

  forcedClipIndexes.forEach((clipIndex) => clipIndexes.add(Number(clipIndex || 0)));
  forcedSceneIndexes.forEach((sceneIndex) => sceneIndexes.add(Number(sceneIndex || 0)));

  (visualResult.failed_ranges || []).forEach((range) => {
    if (range.clip_index) clipIndexes.add(Number(range.clip_index));
    if (range.scene_index) sceneIndexes.add(Number(range.scene_index));
  });

  clips.forEach((clip) => {
    if (Number(clip.timeline_score || 0) < 0 || clip.clip_script_source === "scene_fallback") {
      clipIndexes.add(Number(clip.clip_index));
      sceneIndexes.add(Number(clip.scene_index));
    }
  });

  if (issues.some((issue) => issue.type === "low_diversity")) {
    const repeated = clips.filter((clip, index) => index > 0 && clip.visual_signature && clip.visual_signature === clips[index - 1]?.visual_signature);
    repeated.forEach((clip) => {
      clipIndexes.add(Number(clip.clip_index));
      sceneIndexes.add(Number(clip.scene_index));
    });
  }

  return {
    clip_indexes_to_replace: unique(Array.from(clipIndexes).filter(Boolean)),
    scene_indexes_to_refresh: unique(Array.from(sceneIndexes).filter(Boolean)),
  };
};

const validateTimelineAlignment = async ({ videoId }) => {
  const state = await loadState(videoId);
  const timeline = state.render_timeline;
  if (!timeline || !timeline.clips || !timeline.clips.length) {
    return {
      video_id: videoId,
      alignment_score: 0,
      issues: [{ type: "missing_timeline", severity: "critical", message: "Nenhum timeline encontrado para validacao." }],
    };
  }

  const timelineScores = timeline.clips.map((clip) => Number(clip.timeline_score ?? clip.composite_score ?? 0));
  const normalized = timelineScores.map((score) => Math.max(0, Math.min(1, (score + 10) / 20)));
  return {
    video_id: videoId,
    alignment_score: round3(normalized.reduce((acc, score) => acc + score, 0) / Math.max(1, normalized.length)),
    issues: [],
  };
};

const validateRenderWithVision = async ({ videoId, renderPath, audioIntelligence, timeline, state }) => {
  if (!renderPath || !(await fs.pathExists(renderPath))) {
    return { vision_validated: false, should_regenerate: true, reason: "render_path_not_found", metrics: { semantic_alignment_score: 0, p95_topic_lag_sec: 99, wrong_topic_exposure_sec: 99 } };
  }

  const renderInfo = await probeMedia(renderPath).catch(() => ({ duration: 0 }));
  const renderDuration = Number(renderInfo.duration || timeline?.output_duration_seconds || 0);
  const narrativeBlocks = Array.isArray(timeline?.narrative_blocks) && timeline.narrative_blocks.length
    ? timeline.narrative_blocks
    : buildNarrativeBlocks({ state, audioIntelligence, audioDuration: renderDuration }).macroBlocks;
  const hardBoundaries = getHardBoundaries(narrativeBlocks);
  const sampleIntervalSec = Number(config.SEMANTIC_SYNC_QA_SAMPLE_INTERVAL_SEC || (config.SEMANTIC_SYNC_MODE === "high-quality" ? 1 : 2));
  const sampleTimestamps = buildQaSampleTimestamps({ duration: renderDuration, hardBoundaries, intervalSec: sampleIntervalSec });
  const visionByTimestamp = await classifyFramesWithVision({ renderPath, sampleTimestamps });

  const samples = sampleTimestamps.map((timestamp) => {
    const expectedBlock = findNarrativeBlockAtTime(narrativeBlocks, timestamp);
    const clip = findClipAtTime(timeline?.clips || [], timestamp);
    const detected = visionByTimestamp.get(timestamp) || classifyFromTimelineClip(clip);
    const comparison = scoreExpectedVsDetected({ expectedBlock, detected });

    return {
      timestamp_sec: timestamp,
      expected_topic: expectedBlock?.macro_topic || expectedBlock?.topic || "",
      expected_micro_topic: expectedBlock?.topic || "",
      expected_topic_type: expectedBlock?.topic_type || "",
      detected,
      match: comparison.match,
      alignment_score: comparison.score,
      reason: comparison.reason,
      clip_index: clip?.clip_index,
      scene_index: clip?.scene_index,
    };
  });

  const metrics = computeQaMetrics({
    samples,
    hardBoundaries,
    sampleIntervalSec,
    maxLatencySec: Number(timeline?.sync_policy?.max_topic_switch_latency_sec || config.SEMANTIC_SYNC_MAX_LATENCY_SEC || 1),
  });
  const threshold = {
    maxWrongTopicExposureSec: 2,
    maxP95LagSec: Number(timeline?.sync_policy?.max_topic_switch_latency_sec || config.SEMANTIC_SYNC_MAX_LATENCY_SEC || 1),
    minSemanticAlignmentScore: Number(config.SEMANTIC_SYNC_QA_MIN_SCORE || DEFAULT_QA_THRESHOLD),
  };
  const failedRanges = detectFailedRanges({ samples, metrics, threshold });

  return {
    vision_validated: true,
    method: visionByTimestamp.size ? "openai_vision_frame" : "timeline_metadata",
    frames_analyzed: visionByTimestamp.size,
    samples_analyzed: samples.length,
    total_render_duration: round3(renderDuration),
    frame_interval_seconds: sampleIntervalSec,
    hard_boundaries: hardBoundaries,
    metrics,
    threshold,
    failed_ranges: failedRanges,
    should_regenerate: failedRanges.length > 0 || metrics.semantic_alignment_score < threshold.minSemanticAlignmentScore,
    samples: samples.slice(0, 80),
  };
};

const validateRender = async ({ videoId }) => {
  const state = await loadState(videoId);
  const renderPath = state.render_path;
  const timeline = state.render_timeline || {};
  const audioIntelligence = await getCachedAudioIntelligence({ videoId }).catch(() => null);
  const alignment = await validateTimelineAlignment({ videoId });
  const technical = await validateRenderQuality({ renderPath }).catch(() => ({ technical_score: 0, issues: [{ type: "render_probe_failed", severity: "critical" }] }));
  const visual = await validateRenderWithVision({ videoId, renderPath, audioIntelligence, timeline, state });
  const diversityScore = scoreTimelineDiversity(timeline.clips || []);
  const baseIssues = collectTimelineIssues({ timeline, technical, visual, diversityScore });
  const visualIntentCoverage = evaluateVisualIntentCoverage({ state, timeline });
  const issues = [...baseIssues, ...visualIntentCoverage.issues];
  const replacement = identifyClipsForReplacement({
    timeline,
    visualResult: visual,
    issues,
    forcedClipIndexes: visualIntentCoverage.clip_indexes_to_replace,
    forcedSceneIndexes: visualIntentCoverage.scene_indexes_to_refresh,
  });
  const coveragePenalty = issues.reduce((accumulator, issue) => accumulator + (["critical", "high"].includes(issue.severity) ? 0.08 : 0.03), 0);

  const qualityScore = round3(Math.max(0, Math.min(1,
    Number(technical.technical_score || 0) * 0.35 +
    Number(visual.metrics?.semantic_alignment_score || 0) * 0.45 +
    Number(diversityScore || 0) * 0.2 -
    coveragePenalty
  )));
  const needsRegeneration = Boolean(issues.some((issue) => ["critical", "high"].includes(issue.severity)) || visual.should_regenerate);
  const isPublishable = !needsRegeneration && qualityScore >= 0.72;

  const validationResult = {
    video_id: videoId,
    validated_at: new Date().toISOString(),
    is_publishable: isPublishable,
    needs_regeneration: needsRegeneration,
    needs_manual_review: !isPublishable,
    quality_score: qualityScore,
    alignment_score: round3(visual.metrics?.semantic_alignment_score || alignment.alignment_score || 0),
    diversity_score: diversityScore,
    technical_score: round3(technical.technical_score || 0),
    visual_intent_distribution: visualIntentCoverage.visual_intent_distribution,
    issues,
    scene_indexes_to_refresh: replacement.scene_indexes_to_refresh,
    clip_indexes_to_replace: replacement.clip_indexes_to_replace,
    render_quality: technical,
    visual_alignment: visual,
    timeline_alignment: alignment,
  };

  await updateState(videoId, { render_validation: validationResult, error_message: "" }, { currentStep: "render_validated", status: "render_validated" });
  return validationResult;
};

const fixRenderSync = async ({ videoId, mockMode = false }) => {
  const state = await loadState(videoId);
  const attempts = Number(state.render_sync_fix_attempts || 0);
  const validation = await validateRender({ videoId });
  if (!validation.needs_regeneration) return validation;
  if (attempts >= 2) {
    return {
      ...validation,
      needs_manual_review: true,
      fix_skipped_reason: "max_attempts_reached",
    };
  }

  const sceneIndexes = validation.scene_indexes_to_refresh || [];
  const dominantReason = validation.issues.find((issue) => ["theme_visual_mismatch", "visual_intent_underrepresented", "generic_asset_overuse", "wrong_visual_category"].includes(issue.type))?.type
    || validation.issues[0]?.type
    || "validation_failed";
  if (sceneIndexes.length) {
    await generateAssets({
      videoId,
      mockMode,
      maxAssets: Math.max(3, Number(config.ASSET_DOWNLOAD_TOP_PER_SCENE || 6)),
      sceneIndexes,
      preserveExisting: true,
      refreshReason: dominantReason,
    });
  }

  await renderVideo({ videoId, mockMode });
  const revalidated = await validateRender({ videoId });
  await updateState(videoId, {
    render_sync_fix_attempts: attempts + 1,
    last_sync_fix_at: new Date().toISOString(),
    last_sync_fix_reason: dominantReason,
    last_sync_fix_scene_indexes: validation.scene_indexes_to_refresh || [],
    last_sync_fix_clip_indexes: validation.clip_indexes_to_replace || [],
    render_validation: revalidated,
  }, { currentStep: "render_fix_attempted", status: "render_fix_attempted" });

  return revalidated;
};

module.exports = {
  validateTimelineAlignment,
  validateRender,
  validateRenderWithVision,
  fixRenderSync,
  __test__: {
    buildQaSampleTimestamps,
    computeQaMetrics,
    detectFailedRanges,
    scoreExpectedVsDetected,
    findClipAtTime,
    findNarrativeBlockAtTime,
    scoreTimelineDiversity,
    computeVisualIntentDistribution,
    evaluateVisualIntentCoverage,
    identifyClipsForReplacement,
  },
};
