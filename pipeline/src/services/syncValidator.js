const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { config } = require("../config/env");
const { loadState, updateState } = require("./stateService");
const { getCachedAudioIntelligence } = require("./audioIntelligence");
const { hasOpenAi, describeImagesWithOpenAI } = require("./openaiService");
const { extractVideoFrame, probeMedia, runFfmpeg } = require("../utils/mediaUtils");
const { buildNarrativeBlocks, isSameLocation } = require("./narrativeBlockPlanner");
const { validateRenderQuality } = require("./renderQualityService");
const { renderVideo } = require("./renderService");
const { generateAssets } = require("./assetsService");
const { buildEditorialRegenerationPlan } = require("./editorialRepairPlanner");

const DEFAULT_QA_THRESHOLD = 0.78;
const FOOD_VISUAL_INTENTS = new Set(["gastronomy", "market", "wine", "pastry", "restaurant", "cafe", "street_food"]);
const GASTRONOMY_THEME_PATTERN = /(gastronom|food|market|mercado|wine|vinho|pastry|pastel|cafe|coffee|restaurant|restaurante|bakery|dessert|docaria|confeitaria|comida)/i;
const MIN_GASTRONOMY_THEME_INTENT_COUNT = 2;
const MIN_GASTRONOMY_THEME_INTENT_RATIO = 0.35;
const EDITORIAL_QA_PROFILES = {
  strict: {
    uncertainRatioMax: 0.1,
    blockOnHigh: true,
    blockOnCritical: true,
  },
  balanced: {
    uncertainRatioMax: 0.16,
    blockOnHigh: false,
    blockOnCritical: true,
  },
};
const QA_RUNTIME_PROFILES = {
  prod_strict: "prod_strict",
  mock_relaxed: "mock_relaxed",
};
const round3 = (value) => Number(Number(value || 0).toFixed(3));
const unique = (values = []) => [...new Set(values.filter(Boolean))];
const sha256File = async (filePath = "") => {
  if (!filePath || !(await fs.pathExists(filePath))) return "";
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
};

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
  macroBlocks.slice(1).map((block, index) => {
    const firstChild = Array.isArray(block.children) ? block.children[0] : null;
    return {
      boundary_id: firstChild?.boundary_id || block.boundary_id || `hb_${String(index + 2).padStart(3, "0")}`,
      timestamp_sec: Number(firstChild?.expected_visual_start_sec ?? block.start_sec ?? 0),
      expected_topic: firstChild?.expected_location || block.expected_location || block.topic,
      expected_topic_type: firstChild?.topic_type || block.topic_type || "",
      previous_topic: macroBlocks[index]?.topic || "",
      previous_topic_type: macroBlocks[index]?.topic_type || "",
      chapter_card_required: Boolean(firstChild?.chapter_card_required),
      chapter_trigger: firstChild?.chapter_trigger || block.chapter_trigger || null,
    };
  });

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


const buildAuditTimestamps = ({ duration = 0, hardBoundaries = [], overlays = [], macroBlocks = [], clips = [] }) => {
  const safeDuration = Math.max(1, Number(duration || 0));
  const set = new Set();
  for (let t = 0; t <= safeDuration; t += 5) set.add(round3(Math.min(safeDuration - 0.05, t)));
  hardBoundaries.forEach((b) => {
    [0, 0.1, 0.5, 1.0].forEach((o) => {
      const ts = Number(b.timestamp_sec || 0) + o;
      if (ts >= 0 && ts < safeDuration) set.add(round3(ts));
    });
  });
  (overlays || []).forEach((o) => {
    const ts = Number(o.start_seconds || 0);
    if (ts >= 0 && ts < safeDuration) set.add(round3(ts));
  });
  (macroBlocks || []).forEach((b) => {
    const mid = (Number(b.start_sec || 0) + Number(b.end_sec || 0)) / 2;
    if (mid >= 0 && mid < safeDuration) set.add(round3(mid));
  });
  (clips || []).forEach((c) => {
    const mid = (Number(c.timeline_start_sec || 0) + Number(c.timeline_end_sec || 0)) / 2;
    if (mid >= 0 && mid < safeDuration) set.add(round3(mid));
  });
  return Array.from(set).sort((a,b)=>a-b);
};

const generateContactSheetAndAudit = async ({ videoId, renderPath, duration, hardBoundaries, overlays, macroBlocks, clips }) => {
  const reportsDir = path.join('pipeline','test_reports');
  await fs.ensureDir(reportsDir);
  const evidenceDir = path.join(reportsDir, `${videoId}-frames`);
  await fs.emptyDir(evidenceDir);
  const timestamps = buildAuditTimestamps({ duration, hardBoundaries, overlays, macroBlocks, clips });
  const audit = [];
  for (let i=0;i<timestamps.length;i+=1){
    const ts=timestamps[i];
    const framePath=path.join(evidenceDir,`frame-${String(i+1).padStart(4,'0')}-${String(ts).replace(/\./g,'_')}.jpg`);
    await extractVideoFrame({ inputPath: renderPath, outputPath: framePath, timeSeconds: ts, width: 640, height: 360 }).catch(()=>null);
    const clip=findClipAtTime(clips,ts);
    const block=findNarrativeBlockAtTime(macroBlocks,ts);
    audit.push({timestamp:ts, expected_block:block?.macro_topic||block?.topic||'', clip_index:clip?.clip_index||null, source_url:clip?.source_url||clip?.asset?.source_url||'', query_used:clip?.query_used||clip?.asset_query||'', metadata_location:clip?.detected_location?.city||'', frame_path:framePath});
  }
  const contactSheetPath = path.join(reportsDir, `${videoId}-contact-sheet.jpg`);
  await runFfmpeg(['-y','-pattern_type','glob','-i',`${evidenceDir}/*.jpg`,'-vf','scale=320:180,tile=6x6','-frames:v','1',contactSheetPath]).catch(()=>null);
  const visualAuditPath = path.join(reportsDir, `${videoId}-visual-audit.json`);
  await fs.writeJson(visualAuditPath, { video_id: videoId, render_path: renderPath, timestamps: audit, clip_audit: [], boundary_audit: [], overlay_audit: [], resolution_audit: {}, final_decision: {} }, { spaces: 2 });
  return { contactSheetPath, visualAuditPath, auditRows: audit };
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

const classifyFrameWithVisionAtTimestamp = async ({ renderPath, timestampSec, evidenceDir, label }) => {
  const framePath = path.join(evidenceDir, `${label}-${String(timestampSec).replace(/\./g, "_")}.jpg`);
  await extractVideoFrame({ inputPath: renderPath, outputPath: framePath, timeSeconds: Math.max(0, timestampSec), width: 960, height: 540 });
  if (!hasOpenAi()) {
    return { frame_path: framePath, method: "metadata_fallback", detected_topic: "", location: { city: "", country: "", confidence: 0 }, confidence: 0 };
  }

  const response = await describeImagesWithOpenAI({
    prompt: `Analise o frame e retorne JSON estrito: {"topic":"","location":{"city":"","country":"","confidence":0},"landmarks":[{"name":"","confidence":0}],"overlay_text":"","overlay_visible":false,"overlay_contrast_ok":false,"confidence":0}.`,
    imagePaths: [framePath],
    detail: "low",
  }).catch(() => null);

  return {
    frame_path: framePath,
    method: "openai_vision_frame",
    detected_topic: response?.topic || response?.location?.city || "",
    location: {
      city: response?.location?.city || "",
      country: response?.location?.country || "",
      confidence: Number(response?.location?.confidence || response?.confidence || 0),
    },
    landmarks: Array.isArray(response?.landmarks) ? response.landmarks : [],
    overlay_visible: Boolean(response?.overlay_visible),
    overlay_text: response?.overlay_text || "",
    overlay_contrast_ok: Boolean(response?.overlay_contrast_ok),
    confidence: Number(response?.confidence || response?.location?.confidence || 0),
  };
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
    max_visual_lag_sec: round3(sortedLags.length ? sortedLags[sortedLags.length - 1] : 0),
    wrong_topic_exposure_sec: round3(wrongTopicExposureSec),
    semantic_alignment_score: round3(scores.reduce((acc, item) => acc + item, 0) / Math.max(1, scores.length)),
  };
};

const evaluateHardBoundaryDeterministic = ({
  clips = [],
  hardBoundaries = [],
  overlays = [],
  maxLagSec = 0.5,
  requireLocation = true,
  forbidNeutralFirstClip = true,
  requireChapterOverlay = true,
}) => {
  if (!hardBoundaries.length) {
    return {
      status: "pass",
      max_visual_lag_sec: 0,
      avg_visual_lag_sec: 0,
      boundaries: [],
      violations: [],
    };
  }

  const lagValues = [];
  const boundaries = [];
  const violations = [];

  hardBoundaries.forEach((boundary) => {
    const boundarySec = Number(boundary.timestamp_sec || 0);
    const crossingClip = clips.find((clip) => {
      const start = Number(clip.timeline_start_sec || 0);
      const end = Number(clip.timeline_end_sec || 0);
      return start < boundarySec - 0.001 && end > boundarySec + 0.001;
    });
    const firstClip = clips.find((clip) => Number(clip.timeline_start_sec || 0) >= boundarySec - 0.001);
    const detectedCity = firstClip?.detected_location?.city || "";
    const lagSec = firstClip ? Math.max(0, Number(firstClip.timeline_start_sec || boundarySec) - boundarySec) : maxLagSec + 1;
    lagValues.push(round3(lagSec));

    const overlayFound = !requireChapterOverlay
      || !boundary.chapter_card_required
      || overlays.some((overlay) => {
        if ((overlay.type || "") !== "chapter_card_clip") return false;
        const start = Number(overlay.start_seconds || 0);
        return Math.abs(start - Number(firstClip?.timeline_start_sec || boundarySec)) <= 0.25;
      });

    const boundaryViolations = [];
    if (crossingClip) boundaryViolations.push("boundary_crossing");
    if (!firstClip) boundaryViolations.push("missing_first_clip");
    if (forbidNeutralFirstClip && firstClip?.neutral_fallback) boundaryViolations.push("neutral_first_clip_forbidden");
    if (requireLocation && boundary.expected_topic_type === "city" && !detectedCity) boundaryViolations.push("missing_location_on_first_clip");
    if (boundary.expected_topic_type === "city" && detectedCity && !isSameLocation(detectedCity, boundary.expected_topic)) boundaryViolations.push("wrong_boundary_city");
    if (lagSec > maxLagSec) boundaryViolations.push("max_visual_lag_exceeded");
    if (!overlayFound) boundaryViolations.push("chapter_overlay_missing");

    const report = {
      boundary_id: boundary.boundary_id || "",
      boundary_sec: round3(boundarySec),
      expected_topic: boundary.expected_topic,
      expected_topic_type: boundary.expected_topic_type,
      first_clip_index: firstClip?.clip_index || null,
      first_clip_start_sec: round3(firstClip?.timeline_start_sec || 0),
      first_clip_end_sec: round3(firstClip?.timeline_end_sec || 0),
      first_clip_city: detectedCity,
      first_clip_neutral: Boolean(firstClip?.neutral_fallback),
      lag_sec: round3(lagSec),
      chapter_overlay_found: overlayFound,
      crossing_detected: Boolean(crossingClip),
      violations: boundaryViolations,
      status: boundaryViolations.length ? "fail" : "pass",
    };

    boundaries.push(report);
    if (boundaryViolations.length) violations.push(report);
  });

  return {
    status: violations.length ? "fail" : "pass",
    max_visual_lag_sec: round3(Math.max(...lagValues, 0)),
    avg_visual_lag_sec: round3(lagValues.reduce((acc, lag) => acc + lag, 0) / Math.max(1, lagValues.length)),
    boundaries,
    violations,
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

  if (
    metrics.p95_topic_lag_sec > threshold.maxP95LagSec
    || metrics.wrong_topic_exposure_sec > threshold.maxWrongTopicExposureSec
    || Number(metrics.max_visual_lag_sec || 0) > Number(threshold.maxVisualLagSec || threshold.maxP95LagSec || 1)
  ) return failed;
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
  const runtimeDegraded = Boolean(timeline?.runtime_degraded);
  const fallbackClipCount = clips.filter((clip) => clip.clip_script_source === "scene_fallback").length;
  const metadataFallbackClipCount = clips.filter((clip) => clip.asset_analysis_provider === "metadata_fallback").length;

  if (visual.hard_boundary_status === "fail") {
    issues.push({
      type: "hard_boundary_violation",
      severity: "critical",
      max_visual_lag_sec: Number(visual.max_visual_lag_sec || visual.metrics?.max_visual_lag_sec || 0),
      violations: (visual.hard_boundary_report?.violations || []).slice(0, 6),
    });
  }

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
  if (metadataFallbackClipCount / Math.max(1, clips.length) > 0.35) {
    issues.push({
      type: "metadata_fallback_overuse",
      severity: "high",
      count: metadataFallbackClipCount,
      ratio: round3(metadataFallbackClipCount / Math.max(1, clips.length)),
    });
  }
  if (runtimeDegraded) {
    issues.push({
      type: "runtime_degradation_used",
      severity: "high",
      message: "Runtime fallback/degradation foi usado para manter o render executando.",
    });
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


const validateOverlayRenderedFrames = async ({ renderPath, overlays = [], evidenceDir }) => {
  const results = [];
  for (const overlay of overlays) {
    const ts = round3(Number(overlay.start_seconds || 0) + 0.5);
    const vision = await classifyFrameWithVisionAtTimestamp({ renderPath, timestampSec: ts, evidenceDir, label: `overlay-${overlay.type || 'overlay'}` });
    const detected = Boolean(vision.overlay_visible || (vision.overlay_text || '').trim());
    results.push({
      text: overlay.text || '',
      timestamp: ts,
      state_overlay_exists: true,
      frame_overlay_detected: detected,
      frame_path: vision.frame_path,
      status: detected ? 'pass' : 'fail',
    });
  }
  return results;
};

const buildClipAuditWithVision = async ({ clips = [], renderPath, evidenceDir }) => {
  const rows = [];
  for (const clip of clips) {
    const startSec = Number(clip.timeline_start_sec || 0);
    const endSec = Number(clip.timeline_end_sec || startSec);
    const duration = Math.max(0, endSec - startSec);
    const timestamps = [round3(startSec + (duration / 2))];
    if (duration >= 5) {
      timestamps.push(round3(Math.min(endSec - 0.5, startSec + 0.5)));
      timestamps.push(round3(Math.max(startSec + 0.5, endSec - 0.5)));
    }
    const frameChecks = [];
    for (const ts of [...new Set(timestamps)].filter((v)=>v>=startSec && v<=endSec)) {
      const vision = await classifyFrameWithVisionAtTimestamp({ renderPath, timestampSec: ts, evidenceDir, label: `clip-${clip.clip_index || 0}` });
      frameChecks.push({ ts, vision });
    }

    const expected = clip.macro_topic || clip.expected_location || "";
    const expectedLocation = clip.expected_location || "";
    const strictLocationCheck = Boolean(
      clip.topic_type === "city"
      || clip.hard_boundary_first_clip
      || clip.critical_slot
      || clip.narrative_role_selected === "hook_exact"
      || clip.narrative_role_selected === "opening_establishing"
      || clip.narrative_role_selected === "closing_payoff"
    );
    const metadataLocation = clip.detected_location?.city || "";
    const confirmed = frameChecks.find((item) => {
      const locationCity = item.vision.location?.city || "";
      return locationCity && expectedLocation && isSameLocation(locationCity, expectedLocation);
    });
    const wrong = frameChecks.find((item) => {
      const locationCity = item.vision.location?.city || "";
      return strictLocationCheck && expectedLocation && locationCity && !isSameLocation(locationCity, expectedLocation);
    });
    let status = 'uncertain';
    let reason = 'vision unavailable or inconclusive';
    if (confirmed) {
      status = 'pass';
      reason = 'vision confirmed expected location';
    } else if (wrong) {
      status = 'fail';
      reason = 'vision detected mismatched location';
    } else if (!strictLocationCheck) {
      status = 'pass';
      reason = 'non_city_block_without_strict_location_requirement';
    } else if (!expectedLocation && (clip.visual_truth_status === "exact" || clip.visual_truth_status === "regional") && clip.editorial_slot_ok !== false) {
      status = 'pass';
      reason = 'editorial_contract_backstop_without_explicit_location';
    } else if (metadataLocation && expectedLocation && isSameLocation(metadataLocation, expectedLocation)) {
      status = 'pass';
      reason = 'metadata_location_backstop_with_no_vision_mismatch';
    }

    const best = confirmed || wrong || frameChecks[0] || { vision: {} };
    const visionLocation = best.vision.location?.city || "";
    const outOfDomain = /portugal|lisboa|lisbon|porto|faro|algarve|ria formosa/i.test(expectedLocation)
      && visionLocation
      && !isSameLocation(visionLocation, expectedLocation)
      && !/portugal|lisboa|lisbon|porto|faro|algarve|ria formosa/i.test(visionLocation);

    rows.push({
      clip_index: clip.clip_index,
      expected_block: expected,
      expected_location: expectedLocation,
      frame_timestamps: frameChecks.map((f) => f.ts),
      frame_paths: frameChecks.map((f) => f.vision.frame_path).filter(Boolean),
      metadata_location: metadataLocation,
      vision_location: visionLocation,
      vision_confidence: Number(best.vision.confidence || 0),
      visual_truth_status: status,
      visual_truth_reason: reason,
      source_url: clip.source_url || clip.asset?.source_url || "",
      query_used: clip.query_used || clip.asset_query || "",
      provider: clip.provider || clip.asset_provider || "",
      out_of_domain_asset: Boolean(outOfDomain),
      is_hard_boundary_first_clip: Boolean(clip.hard_boundary_first_clip),
      critical_slot: Boolean(clip.critical_slot),
      narrative_role_selected: clip.narrative_role_selected || "",
      scene_index: Number(clip.scene_index || 0),
      editorial_slot_ok: clip.editorial_slot_ok !== false,
      approved_window_id: clip.approved_window_id || clip.asset_window_id || "",
    });
  }
  return rows;
};

const writeVisualTruthFinalReport = async ({ videoId, validation }) => {
  const outPath = path.join('pipeline','reports','visual-truth-final-report.md');
  const boundaries = validation?.visual_alignment?.boundary_visual_audit || [];
  const clips = validation?.clip_audit || [];
  const boundaryTable = ['| Boundary | Expected | Vision | Status |','|---|---|---|---|', ...boundaries.slice(0,60).map((b)=>`| ${b.boundary_id} @ ${b.frame_timestamp}s | ${b.expected_location||''} | ${b.vision_detected_location||''} | ${b.visual_truth_status} |`) ].join('\n');
  const clipTable = ['| Clip | Expected | Query | Metadata | Vision | Status |','|---|---|---|---|---|---|', ...clips.slice(0,120).map((c)=>`| ${c.clip_index} | ${c.expected_block||''} | ${c.query_used||''} | ${c.metadata_location||''} | ${c.vision_location||''} | ${c.visual_truth_status} |`) ].join('\n');
  const md = `# Visual Truth Final Report

- video_id: ${videoId}
- render_path: ${validation.render_path}
- upload_source_path: ${validation.upload_source_path}
- youtube_video_id: ${validation.youtube_video_id || ''}
- ffprobe: ${validation.ffprobe_width}x${validation.ffprobe_height} / ${validation.ffprobe_duration}s
- state_output_resolution: ${validation.state_output_resolution || ''}
- metadata_boundary_status: ${validation.metadata_boundary_status}
- visual_frame_boundary_status: ${validation.visual_frame_boundary_status}
- final_hard_boundary_status: ${validation.final_hard_boundary_status}
- contact_sheet: ${validation.contact_sheet_path || ''}
- visual_audit_json: ${validation.visual_audit_json_path || ''}

## Boundary Visual Audit
${boundaryTable}

## Clip Audit
${clipTable}
`;
  await fs.ensureDir(path.dirname(outPath));
  await fs.writeFile(outPath, md, 'utf8');
  return outPath;
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
  const hardBoundaryMaxLagSec = Number(
    config.HARD_BOUNDARY_MAX_LAG_SEC
    || timeline?.hard_boundary_policy?.max_topic_switch_latency_sec
    || timeline?.sync_policy?.max_topic_switch_latency_sec
    || config.SEMANTIC_SYNC_MAX_LATENCY_SEC
    || 0.5
  );
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

  const metricsBase = computeQaMetrics({
    samples,
    hardBoundaries,
    sampleIntervalSec,
    maxLatencySec: hardBoundaryMaxLagSec,
  });
  const hardBoundaryReport = evaluateHardBoundaryDeterministic({
    clips: timeline?.clips || [],
    hardBoundaries,
    overlays: state?.overlays || [],
    maxLagSec: hardBoundaryMaxLagSec,
    requireLocation: Boolean(config.HARD_BOUNDARY_REQUIRE_LOCATION),
    forbidNeutralFirstClip: Boolean(config.HARD_BOUNDARY_FORBID_NEUTRAL_FIRST_CLIP),
    requireChapterOverlay: Boolean(config.HARD_BOUNDARY_REQUIRE_CHAPTER_OVERLAY),
  });
  const evidenceDir = path.join("pipeline", "test_reports", `${videoId}-visual-evidence`);
  await fs.ensureDir(evidenceDir);
  const boundaryVisualAudit = [];
  for (const boundary of hardBoundaries) {
    const checks = [0.1, 0.5, 1.0];
    let boundaryPass = false;
    for (const offset of checks) {
      const ts = round3(Math.min(Math.max(0, boundary.timestamp_sec + offset), Math.max(0, renderDuration - 0.1)));
      const vision = await classifyFrameWithVisionAtTimestamp({ renderPath, timestampSec: ts, evidenceDir, label: `boundary-${boundary.boundary_id}` });
      const detectedCity = vision.location?.city || "";
      const metadataCity = (findClipAtTime(timeline?.clips || [], ts)?.detected_location?.city) || "";
      const hasCityMatchFromVision = boundary.expected_topic_type === "city" && detectedCity && isSameLocation(detectedCity, boundary.expected_topic);
      const hasCityMatchFromMetadata = boundary.expected_topic_type === "city" && metadataCity && isSameLocation(metadataCity, boundary.expected_topic);
      const status = boundary.expected_topic_type === "city"
        ? (hasCityMatchFromVision || hasCityMatchFromMetadata ? "pass" : "fail")
        : "pass";
      if (status === "pass") boundaryPass = true;
      boundaryVisualAudit.push({
        boundary_id: boundary.boundary_id,
        expected_location: boundary.expected_topic,
        frame_timestamp: ts,
        vision_detected_location: detectedCity,
        vision_confidence: Number(vision.confidence || 0),
        metadata_location: metadataCity,
        visual_truth_status: status,
        frame_path: vision.frame_path,
      });
    }
    if (!boundaryPass) {
      hardBoundaryReport.violations.push({ boundary_id: boundary.boundary_id, violations: ["visual_truth_not_confirmed"], boundary_sec: boundary.timestamp_sec, expected_topic: boundary.expected_topic });
    }
  }
  if (hardBoundaryReport.violations.length) hardBoundaryReport.status = "fail";
  const metrics = {
    ...metricsBase,
    max_visual_lag_sec: round3(Math.max(
      Number(metricsBase.max_visual_lag_sec || 0),
      Number(hardBoundaryReport.max_visual_lag_sec || 0)
    )),
  };
  const threshold = {
    maxWrongTopicExposureSec: 2,
    maxP95LagSec: hardBoundaryMaxLagSec,
    maxVisualLagSec: hardBoundaryMaxLagSec,
    minSemanticAlignmentScore: Number(config.SEMANTIC_SYNC_QA_MIN_SCORE || DEFAULT_QA_THRESHOLD),
  };
  const failedRanges = detectFailedRanges({ samples, metrics, threshold });
  hardBoundaryReport.violations.forEach((boundaryViolation) => {
    failedRanges.push({
      start_sec: boundaryViolation.boundary_sec,
      end_sec: round3(Number(boundaryViolation.boundary_sec || 0) + 0.75),
      reason: boundaryViolation.violations?.[0] || "hard_boundary_violation",
      expected_topic: boundaryViolation.expected_topic,
      detected_topic: boundaryViolation.first_clip_city || "",
      clip_index: boundaryViolation.first_clip_index || 0,
      scene_index: 0,
      boundary_id: boundaryViolation.boundary_id,
    });
  });
  const shouldRegenerate =
    failedRanges.length > 0
    || metrics.semantic_alignment_score < threshold.minSemanticAlignmentScore
    || hardBoundaryReport.status === "fail"
    || Number(metrics.max_visual_lag_sec || 0) > Number(threshold.maxVisualLagSec || 0.5);

  return {
    vision_validated: true,
    method: visionByTimestamp.size ? "openai_vision_frame" : "timeline_metadata",
    frames_analyzed: visionByTimestamp.size,
    samples_analyzed: samples.length,
    total_render_duration: round3(renderDuration),
    frame_interval_seconds: sampleIntervalSec,
    hard_boundaries: hardBoundaries,
    metrics,
    hard_boundary_status: hardBoundaryReport.status,
    max_visual_lag_sec: metrics.max_visual_lag_sec,
    hard_boundary_report: hardBoundaryReport,
    boundary_visual_audit: boundaryVisualAudit,
    threshold,
    failed_ranges: failedRanges,
    should_regenerate: shouldRegenerate,
    samples: samples.slice(0, 80),
  };
};


const isCriticalAuditRow = (row = {}) =>
  Boolean(
    row.is_hard_boundary_first_clip
    || row.critical_slot
    || ["hook_exact", "opening_establishing", "closing_payoff"].includes(String(row.narrative_role_selected || ""))
  );

const evaluateApprovedPoolAudit = ({ state = {}, timeline = {} }) => {
  const approvedWindows = Array.isArray(state.assets_json?.approved_windows) ? state.assets_json.approved_windows : [];
  const approvedIds = new Set(approvedWindows.map((item) => item.approved_window_id || item.id).filter(Boolean));
  const clips = Array.isArray(timeline.clips) ? timeline.clips : [];
  const clipRows = clips.map((clip) => ({
    clip_index: Number(clip.clip_index || 0),
    approved_window_id: clip.approved_window_id || clip.asset_window_id || "",
  }));
  const invalidRows = clipRows.filter((row) => row.approved_window_id && approvedIds.size && !approvedIds.has(row.approved_window_id));
  const missingRows = clipRows.filter((row) => !row.approved_window_id);
  const timelineUsesApprovedPoolOnly = invalidRows.length === 0 && missingRows.length === 0;
  return {
    timeline_uses_approved_pool_only: timelineUsesApprovedPoolOnly,
    invalid_clip_count: invalidRows.length,
    missing_approved_window_id_count: missingRows.length,
    invalid_rows: invalidRows.slice(0, 20),
    approved_pool_size: approvedIds.size,
  };
};

const computeEditorialTelemetry = ({ clips = [], clipAuditRows = [], sceneEditorialReadiness = [] }) => {
  const totalClips = Math.max(1, clips.length);
  const countStatus = (status) => clips.filter((clip) => (clip.visual_truth_status || "") === status).length;
  const criticalRows = clipAuditRows.filter((row) => isCriticalAuditRow(row));
  const criticalCovered = (sceneEditorialReadiness || []).filter((scene) => Array.isArray(scene.critical_slots_missing) && scene.critical_slots_missing.length === 0).length;

  return {
    exact_ratio: round3(countStatus("exact") / totalClips),
    regional_ratio: round3(countStatus("regional") / totalClips),
    generic_ratio: round3(countStatus("generic") / totalClips),
    uncertain_ratio: round3(countStatus("uncertain") / totalClips),
    uncertain_critical_ratio: round3(
      criticalRows.length
        ? criticalRows.filter((row) => row.visual_truth_status === "uncertain").length / criticalRows.length
        : 0
    ),
    critical_slots_covered: criticalCovered,
    critical_slots_total: (sceneEditorialReadiness || []).length,
    scene_editorial_readiness: sceneEditorialReadiness || [],
  };
};

const evaluateClipAuditGate = ({ clipAuditRows = [] }) => {
  const uncertainCount = clipAuditRows.filter((row) => row.visual_truth_status === 'uncertain').length;
  const uncertainRatio = clipAuditRows.length ? uncertainCount / clipAuditRows.length : 0;
  const hardBoundaryInvalid = clipAuditRows.some((row) => row.is_hard_boundary_first_clip && row.visual_truth_status !== 'pass');
  const criticalRows = clipAuditRows.filter((row) => isCriticalAuditRow(row));
  const uncertainCriticalCount = criticalRows.filter((row) => row.visual_truth_status === "uncertain").length;
  const criticalSlotInvalid = criticalRows.some((row) => row.visual_truth_status !== "pass");
  const outOfDomain = clipAuditRows.some((row) => row.out_of_domain_asset);
  return {
    uncertainRatio: round3(uncertainRatio),
    hardBoundaryInvalid,
    criticalSlotInvalid,
    uncertainCriticalCount,
    uncertainCriticalRatio: round3(criticalRows.length ? uncertainCriticalCount / criticalRows.length : 0),
    outOfDomain,
  };
};

const getEditorialQaProfile = () => {
  const profileKey = String(config.EDITORIAL_QA_PROFILE || "strict").toLowerCase();
  return EDITORIAL_QA_PROFILES[profileKey] || EDITORIAL_QA_PROFILES.strict;
};

const resolveQaRuntimeProfile = ({ mockMode = false } = {}) => {
  const normalize = (value = "", fallback = QA_RUNTIME_PROFILES.prod_strict) => {
    const profile = String(value || "").toLowerCase();
    if (profile === QA_RUNTIME_PROFILES.mock_relaxed) return QA_RUNTIME_PROFILES.mock_relaxed;
    if (profile === QA_RUNTIME_PROFILES.prod_strict) return QA_RUNTIME_PROFILES.prod_strict;
    return fallback;
  };
  if (mockMode) {
    return normalize(config.QA_RUNTIME_PROFILE_MOCK, QA_RUNTIME_PROFILES.mock_relaxed);
  }
  return normalize(config.QA_RUNTIME_PROFILE_PROD, QA_RUNTIME_PROFILES.prod_strict);
};

const buildProviderReliabilitySnapshot = ({ clips = [] }) => {
  const byProvider = new Map();
  clips.forEach((clip) => {
    const provider = String(clip.source_provider || clip.asset?.provider || clip.source_tier || "unknown").toLowerCase();
    if (!provider) return;
    const entry = byProvider.get(provider) || { total: 0, pass: 0 };
    entry.total += 1;
    if (clip.visual_truth_status === "pass") entry.pass += 1;
    byProvider.set(provider, entry);
  });

  const snapshot = {};
  byProvider.forEach((entry, provider) => {
    snapshot[provider] = round3(entry.pass / Math.max(1, entry.total));
  });
  return snapshot;
};

const buildEditorialFailureCodes = ({
  issues = [],
  gate = {},
  approvedPoolAudit = {},
  sceneEditorialReadiness = [],
} = {}) => {
  const codes = [];
  if (gate.uncertainCriticalCount > 0) codes.push("CRITICAL_SLOT_UNCERTAIN");
  if (gate.criticalSlotInvalid) codes.push("CRITICAL_SLOT_NOT_CONFIRMED");
  if (gate.hardBoundaryInvalid) codes.push("HARD_BOUNDARY_FIRST_CLIP_INVALID");
  if (!approvedPoolAudit.timeline_uses_approved_pool_only) codes.push("TIMELINE_OUTSIDE_APPROVED_POOL");
  if (issues.some((issue) => issue.type === "generic_asset_overuse")) codes.push("GENERIC_OVERUSE");
  if (issues.some((issue) => issue.type === "wrong_visual_category")) codes.push("WRONG_VISUAL_CATEGORY");
  if (issues.some((issue) => issue.type === "theme_visual_mismatch")) codes.push("THEME_VISUAL_MISMATCH");
  if (issues.some((issue) => issue.type === "runtime_degradation_used")) codes.push("RUNTIME_DEGRADATION_USED");
  if (issues.some((issue) => issue.type === "no_proof_for_promise")) {
    codes.push("NO_PROOF_FOR_PROMISE");
  }
  return unique(codes);
};

const normalizeIssueSeverity = ({ issue = {}, technicalScore = 0 }) => {
  if (!issue || typeof issue !== "object") return issue;
  if (issue.type === "unexpected_silence" && Number(technicalScore || 0) >= 0.7) {
    return {
      ...issue,
      severity: "medium",
      note: "downgraded_due_to_good_technical_score",
    };
  }
  return issue;
};

const validateRender = async ({ videoId, mockMode = config.MOCK_MODE }) => {
  const state = await loadState(videoId);
  const renderPath = state.render_path;
  const timeline = state.render_timeline || {};
  const audioIntelligence = await getCachedAudioIntelligence({ videoId }).catch(() => null);
  const alignment = await validateTimelineAlignment({ videoId });
  const technical = await validateRenderQuality({
    renderPath,
    allowPlaceholderArtifacts: Boolean(mockMode || config.ALLOW_PLACEHOLDER_ASSETS),
  }).catch(() => ({ technical_score: 0, issues: [{ type: "render_probe_failed", severity: "critical" }] }));
  const visual = await validateRenderWithVision({ videoId, renderPath, audioIntelligence, timeline, state });
  const renderProbe = await probeMedia(renderPath).catch(() => ({ width: 0, height: 0, duration: 0 }));
  const renderSha256 = await sha256File(renderPath);
  const uploadSourcePath = state.upload_source_path || state.render_path || "";
  const uploadedFileSha256 = uploadSourcePath ? await sha256File(uploadSourcePath) : "";
  const narrativeBlocks = Array.isArray(timeline?.narrative_blocks) && timeline.narrative_blocks.length
    ? timeline.narrative_blocks
    : buildNarrativeBlocks({ state, audioIntelligence, audioDuration: Number(renderProbe.duration || 0) }).macroBlocks;
  const contactAudit = await generateContactSheetAndAudit({
    videoId,
    renderPath,
    duration: Number(renderProbe.duration || 0),
    hardBoundaries: getHardBoundaries(narrativeBlocks),
    overlays: state?.overlays || [],
    macroBlocks: narrativeBlocks,
    clips: timeline.clips || [],
  });
  const diversityScore = scoreTimelineDiversity(timeline.clips || []);
  const overlayValidation = await validateOverlayRenderedFrames({
    renderPath,
    overlays: state?.overlays || [],
    evidenceDir: path.join('pipeline','test_reports', `${videoId}-visual-evidence`),
  });
  const baseIssues = collectTimelineIssues({ timeline, technical, visual, diversityScore })
    .map((issue) => normalizeIssueSeverity({ issue, technicalScore: Number(technical.technical_score || 0) }));
  if ((state.output_resolution || "") && `${renderProbe.width}x${renderProbe.height}` !== String(state.output_resolution)) {
    baseIssues.push({ type: "render_file_state_mismatch", severity: "critical", message: `State says ${state.output_resolution} but final file is ${renderProbe.width}x${renderProbe.height}` });
  }
  if ((visual.boundary_visual_audit || []).some((item) => item.visual_truth_status !== "pass")) {
    baseIssues.push({ type: "visual_truth_not_confirmed", severity: "critical" });
  }
  if (overlayValidation.some((item) => item.status !== "pass")) {
    baseIssues.push({ type: "overlay_not_rendered", severity: "medium" });
  }
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
  const metadataBoundaryStatus = visual.hard_boundary_report?.status || "unknown";
  const visualFrameBoundaryStatus = (visual.boundary_visual_audit || []).some((item) => item.visual_truth_status !== "pass") ? "fail" : "pass";
  const hardBoundaryStatus = (metadataBoundaryStatus === "pass" && visualFrameBoundaryStatus === "pass") ? "pass" : "fail";
  const maxVisualLagSec = Number(visual.max_visual_lag_sec || visual.metrics?.max_visual_lag_sec || 0);
  const hardBoundaryMaxLagSec = Number(config.HARD_BOUNDARY_MAX_LAG_SEC || 0.5);

  const clipAuditRows = await buildClipAuditWithVision({
    clips: timeline.clips || [],
    renderPath,
    evidenceDir: path.join('pipeline','test_reports', `${videoId}-visual-evidence`),
  });
  const approvedPoolAudit = evaluateApprovedPoolAudit({ state, timeline });
  const sceneEditorialReadiness = Array.isArray(state.assets_json?.scene_editorial_readiness)
    ? state.assets_json.scene_editorial_readiness
    : [];
  const qaProfile = getEditorialQaProfile();
  const qaRuntimeProfile = resolveQaRuntimeProfile({ mockMode });
  const strictRuntimeProfile = qaRuntimeProfile === QA_RUNTIME_PROFILES.prod_strict;
  const failedClipCount = clipAuditRows.filter((row) => row.visual_truth_status === 'fail').length;
  const gate = evaluateClipAuditGate({ clipAuditRows });
  const uncertainRatio = gate.uncertainRatio;
  const noProofScenes = sceneEditorialReadiness
    .filter((scene) => (scene.blocking_reasons || []).includes("missing_exact_for_required_proof") || (scene.blocking_reasons || []).includes("no_proof_for_promise"))
    .map((scene) => Number(scene.scene_index || 0))
    .filter((sceneIndex) => sceneIndex > 0);
  const editorialTelemetry = computeEditorialTelemetry({
    clips: timeline.clips || [],
    clipAuditRows,
    sceneEditorialReadiness,
  });
  if (failedClipCount > 0) issues.push({ type: 'clip_visual_truth_mismatch', severity: 'critical', count: failedClipCount });
  if (gate.hardBoundaryInvalid) issues.push({ type: 'hard_boundary_first_clip_not_visually_confirmed', severity: 'critical' });
  if (gate.criticalSlotInvalid) issues.push({ type: 'critical_slot_not_visually_confirmed', severity: 'critical' });
  if (gate.outOfDomain) issues.push({ type: 'out_of_domain_asset', severity: 'critical' });
  if (gate.uncertainCriticalCount > 0) issues.push({ type: 'uncertain_in_critical_slot', severity: 'critical', count: gate.uncertainCriticalCount });
  const criticalScenesPassingVisualAudit = new Set(
    (clipAuditRows || [])
      .filter((row) => row.critical_slot && row.visual_truth_status === "pass")
      .map((row) => Number(row.scene_index || 0))
      .filter((sceneIndex) => sceneIndex > 0)
  );
  const unresolvedNoProofScenes = noProofScenes.filter((sceneIndex) => !criticalScenesPassingVisualAudit.has(sceneIndex));
  if (unresolvedNoProofScenes.length) {
    issues.push({ type: "no_proof_for_promise", severity: "critical", scene_indexes: unresolvedNoProofScenes });
  }
  if (uncertainRatio > Number(qaProfile.uncertainRatioMax || 0.1)) {
    issues.push({ type: 'too_many_uncertain_clips', severity: 'high', ratio: round3(uncertainRatio) });
  }
  if (!approvedPoolAudit.timeline_uses_approved_pool_only) {
    issues.push({
      type: "timeline_not_using_approved_pool",
      severity: "critical",
      invalid_clip_count: approvedPoolAudit.invalid_clip_count,
      missing_approved_window_id_count: approvedPoolAudit.missing_approved_window_id_count,
    });
  }

  const qualityScore = round3(Math.max(0, Math.min(1,
    Number(technical.technical_score || 0) * 0.35 +
    Number(visual.metrics?.semantic_alignment_score || 0) * 0.45 +
    Number(diversityScore || 0) * 0.2 -
    coveragePenalty
  )));
  const needsRegenerationStrict = Boolean(
    issues.some((issue) => issue.severity === "critical" || (qaProfile.blockOnHigh && issue.severity === "high"))
    || visual.should_regenerate
    || hardBoundaryStatus === "fail"
    || maxVisualLagSec > hardBoundaryMaxLagSec
  );
  const editorialFailureCodes = buildEditorialFailureCodes({
    issues,
    gate,
    approvedPoolAudit,
    sceneEditorialReadiness,
  });
  const regenerationPlan = buildEditorialRegenerationPlan({
    issues,
    sceneIndexesToRefresh: replacement.scene_indexes_to_refresh,
    sceneEditorialReadiness,
  });
  const providerReliability = buildProviderReliabilitySnapshot({ clips: clipAuditRows });
  const isPublishableStrict =
    !needsRegenerationStrict
    && qualityScore >= 0.72
    && hardBoundaryStatus === "pass"
    && visualFrameBoundaryStatus === "pass"
    && uncertainRatio <= Number(qaProfile.uncertainRatioMax || 0.1)
    && gate.uncertainCriticalCount === 0
    && approvedPoolAudit.timeline_uses_approved_pool_only
    && editorialFailureCodes.length === 0;
  const hasCriticalTechnicalFailure = (technical.issues || []).some((issue) => issue.severity === "critical");
  const needsRegeneration = strictRuntimeProfile
    ? needsRegenerationStrict
    : Boolean(!renderPath || hasCriticalTechnicalFailure);
  const isPublishable = strictRuntimeProfile
    ? isPublishableStrict
    : Boolean(!needsRegeneration && (technical.technical_score || 0) > 0);

  const validationResult = {
    video_id: videoId,
    validated_at: new Date().toISOString(),
    is_publishable: isPublishable,
    needs_regeneration: needsRegeneration,
    needs_manual_review: !isPublishable,
    hard_boundary_status: hardBoundaryStatus,
    metadata_boundary_status: metadataBoundaryStatus,
    visual_frame_boundary_status: visualFrameBoundaryStatus,
    final_hard_boundary_status: hardBoundaryStatus,
    max_visual_lag_sec: round3(maxVisualLagSec),
    hard_boundary_report: visual.hard_boundary_report || { status: hardBoundaryStatus, boundaries: [], violations: [] },
    quality_score: qualityScore,
    alignment_score: round3(visual.metrics?.semantic_alignment_score || alignment.alignment_score || 0),
    diversity_score: diversityScore,
    technical_score: round3(technical.technical_score || 0),
    visual_intent_distribution: visualIntentCoverage.visual_intent_distribution,
    qa_profile: String(config.EDITORIAL_QA_PROFILE || "strict").toLowerCase(),
    qa_runtime_profile: qaRuntimeProfile,
    editorial_failure_codes: editorialFailureCodes,
    publish_blocked: strictRuntimeProfile ? !isPublishable : false,
    publish_blocked_codes: strictRuntimeProfile
      ? (isPublishable ? [] : editorialFailureCodes)
      : [],
    editorial_metrics: {
      ...editorialTelemetry,
      timeline_uses_approved_pool_only: approvedPoolAudit.timeline_uses_approved_pool_only,
      approved_pool_audit: approvedPoolAudit,
    },
    provider_reliability: providerReliability,
    critical_slot_audit: clipAuditRows
      .filter((row) => isCriticalAuditRow(row))
      .map((row) => ({
        clip_index: row.clip_index,
        scene_index: row.scene_index,
        narrative_role_selected: row.narrative_role_selected,
        status: row.visual_truth_status === "pass" ? "pass" : "fail",
        visual_truth_status: row.visual_truth_status,
        reason: row.visual_truth_reason || "",
      })),
    issues,
    scene_indexes_to_refresh: replacement.scene_indexes_to_refresh,
    clip_indexes_to_replace: replacement.clip_indexes_to_replace,
    regeneration_plan: regenerationPlan,
    render_quality: technical,
    render_path: renderPath,
    upload_source_path: uploadSourcePath,
    youtube_video_id: state.youtube_video_id || "",
    render_sha256: renderSha256,
    uploaded_file_sha256: uploadedFileSha256,
    ffprobe_width: Number(renderProbe.width || 0),
    ffprobe_height: Number(renderProbe.height || 0),
    ffprobe_duration: round3(renderProbe.duration || 0),
    state_output_resolution: state.output_resolution || "",
    visual_alignment: visual,
    timeline_alignment: alignment,
    contact_sheet_path: contactAudit.contactSheetPath,
    visual_audit_json_path: contactAudit.visualAuditPath,
    overlay_render_validation: overlayValidation,
    clip_audit: clipAuditRows,
    approved_pool_audit: approvedPoolAudit,
    editorial_observability: {
      generated_at: new Date().toISOString(),
      exact_ratio: editorialTelemetry.exact_ratio,
      regional_ratio: editorialTelemetry.regional_ratio,
      generic_ratio: editorialTelemetry.generic_ratio,
      uncertain_ratio: editorialTelemetry.uncertain_ratio,
      uncertain_critical_ratio: editorialTelemetry.uncertain_critical_ratio,
      critical_slots_covered: editorialTelemetry.critical_slots_covered,
      critical_slots_total: editorialTelemetry.critical_slots_total,
      timeline_uses_approved_pool_only: approvedPoolAudit.timeline_uses_approved_pool_only,
      failure_codes: editorialFailureCodes,
      provider_reliability: providerReliability,
    },
  };

  await fs.writeJson(contactAudit.visualAuditPath, {
    video_id: videoId,
    clip_audit: clipAuditRows,
    boundary_audit: visual.boundary_visual_audit || [],
    overlay_audit: overlayValidation,
    editorial_metrics: validationResult.editorial_metrics,
    approved_pool_audit: approvedPoolAudit,
    provider_reliability: validationResult.provider_reliability,
    resolution_audit: { ffprobe_width: validationResult.ffprobe_width, ffprobe_height: validationResult.ffprobe_height, state_output_resolution: validationResult.state_output_resolution },
    final_decision: {
      is_publishable: validationResult.is_publishable,
      needs_manual_review: validationResult.needs_manual_review,
      final_hard_boundary_status: validationResult.final_hard_boundary_status,
      editorial_failure_codes: validationResult.editorial_failure_codes || [],
    },
  }, { spaces: 2 });
  const finalReportPath = await writeVisualTruthFinalReport({ videoId, validation: validationResult });
  validationResult.visual_truth_final_report_path = finalReportPath;
  const observabilityHistory = [
    ...((state.editorial_observability_history || []).slice(-39)),
    validationResult.editorial_observability,
  ];
  await updateState(videoId, {
    render_validation: validationResult,
    visual_truth_final_report_path: finalReportPath,
    assets_json: {
      ...(state.assets_json || {}),
      provider_reliability: validationResult.provider_reliability || {},
    },
    editorial_observability_history: observabilityHistory,
    error_message: "",
  }, { currentStep: "render_validated", status: "render_validated" });
  return validationResult;
};

const fixRenderSync = async ({ videoId, mockMode = false }) => {
  const state = await loadState(videoId);
  const attempts = Number(state.render_sync_fix_attempts || 0);
  const validation = await validateRender({ videoId, mockMode });
  if (!validation.needs_regeneration) return validation;
  const dominantReason = validation.editorial_failure_codes?.[0]
    || validation.issues.find((issue) => [
      "theme_visual_mismatch",
      "visual_intent_underrepresented",
      "generic_asset_overuse",
      "wrong_visual_category",
      "uncertain_in_critical_slot",
      "critical_slot_not_visually_confirmed",
      "timeline_not_using_approved_pool",
      "scene_has_no_editorially_approved_assets",
      "no_proof_for_promise",
    ].includes(issue.type))?.type
    || validation.issues[0]?.type
    || "validation_failed";
  const attemptsByReason = { ...(state.render_sync_fix_attempts_by_reason || {}) };
  const reasonAttempts = Number(attemptsByReason[dominantReason] || 0);
  if (attempts >= 2 || reasonAttempts >= 2) {
    return {
      ...validation,
      needs_manual_review: true,
      fix_skipped_reason: "max_attempts_reached_for_reason",
    };
  }

  const sceneIndexes = validation.regeneration_plan?.scene_indexes_to_refresh || validation.scene_indexes_to_refresh || [];
  const repairPlanByScene = validation.regeneration_plan?.repair_by_scene || [];
  if (sceneIndexes.length) {
    await generateAssets({
      videoId,
      mockMode,
      maxAssets: Math.max(3, Number(config.ASSET_DOWNLOAD_TOP_PER_SCENE || 6)),
      sceneIndexes,
      preserveExisting: true,
      refreshReason: dominantReason,
      repairPlanByScene,
    });
  }

  await renderVideo({ videoId, mockMode });
  const revalidated = await validateRender({ videoId, mockMode });
  await updateState(videoId, {
    render_sync_fix_attempts: attempts + 1,
    render_sync_fix_attempts_by_reason: {
      ...attemptsByReason,
      [dominantReason]: reasonAttempts + 1,
    },
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
    evaluateHardBoundaryDeterministic,
    collectTimelineIssues,
    detectFailedRanges,
    scoreExpectedVsDetected,
    findClipAtTime,
    findNarrativeBlockAtTime,
    scoreTimelineDiversity,
    computeVisualIntentDistribution,
    evaluateVisualIntentCoverage,
    identifyClipsForReplacement,
    isCriticalAuditRow,
    evaluateApprovedPoolAudit,
    computeEditorialTelemetry,
    evaluateClipAuditGate,
    getEditorialQaProfile,
    buildEditorialFailureCodes,
    buildProviderReliabilitySnapshot,
  },
};
