const path = require("path");
const fs = require("fs-extra");
const { execFile } = require("child_process");
const { config } = require("../config/env");
const { probeMedia } = require("../utils/mediaUtils");
const { evaluateVisualEvidence } = require("./visualIntentService");

const round3 = (value) => Number(Number(value || 0).toFixed(3));
const unique = (values = []) => [...new Set(values.filter(Boolean))];
const WEAK_SOURCES = new Set([
  "metadata_fallback",
  "local_video_understanding_fallback",
  "local_video_understanding_stub",
  "weak_fallback",
  "script_missing",
  "disabled",
]);

const runPython = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 20 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

const isEnabled = () => Boolean(config.LOCAL_VIDEO_UNDERSTANDING_ENABLED);

const enrichWindowsWithEvidence = ({ windows = [], sceneContext = {}, assetMetadata = {} }) =>
  windows.map((window) => {
    const evidence = evaluateVisualEvidence({ scene: sceneContext, window, asset: assetMetadata });
    const visualEvidenceSource = window.visual_evidence_source || window.method || assetMetadata.analysis_provider || "local_video_understanding";
    const weakFallback = WEAK_SOURCES.has(String(visualEvidenceSource).toLowerCase());
    const rawConfidence = Number(window.confidence || 0.4);
    return {
      ...window,
      detected_visual_categories: window.detected_visual_categories || evidence.detected_visual_categories,
      detected_objects: window.detected_objects || [],
      visual_intent_match: typeof window.visual_intent_match === "boolean" ? window.visual_intent_match : evidence.visual_intent_match,
      generic_visual: typeof window.generic_visual === "boolean" ? window.generic_visual : evidence.generic_visual,
      required_evidence_found: window.required_evidence_found || evidence.required_evidence_found,
      missing_required_visual_evidence: window.missing_required_visual_evidence || evidence.missing_required_visual_evidence,
      confidence: weakFallback ? Math.min(rawConfidence, 0.28) : rawConfidence,
      weak_fallback: weakFallback,
      visual_evidence_source: weakFallback ? "weak_fallback" : visualEvidenceSource,
      visual_observation_origin: weakFallback ? "weak_fallback" : "real_vision",
    };
  });

const buildFallbackWindows = ({ duration = 0, windowSeconds = 8, maxWindows = 20, assetMetadata = {}, sceneContext = {} }) => {
  const safeDuration = Math.max(windowSeconds, Number(duration || 0) || windowSeconds);
  const windows = [];
  const step = Math.max(1, Math.floor(windowSeconds));
  for (let start = 0; start < safeDuration && windows.length < maxWindows; start += step) {
    const end = Math.min(safeDuration, start + windowSeconds);
    windows.push({
      window_index: windows.length + 1,
      start_seconds: round3(start),
      end_seconds: round3(Math.max(start + 1, end)),
      summary: "visual evidence unavailable - weak fallback",
      tags: [],
      confidence: 0.22,
      method: "weak_fallback",
      visual_evidence_source: "weak_fallback",
      visual_observation_origin: "weak_fallback",
      location: { city: "", country: "", confidence: 0 },
      landmarks: [],
      location_type: sceneContext.subtheme || "general",
      quality: { sharpness: 0.65, stability: 0.65, brightness: 0.65, usable: true },
    });
    if (end >= safeDuration) break;
  }
  return enrichWindowsWithEvidence({ windows, sceneContext, assetMetadata });
};

const analyzeLocalVideo = async ({
  inputPath,
  windowSeconds = config.LOCAL_VIDEO_UNDERSTANDING_WINDOW_SECONDS,
  maxWindows = config.LOCAL_VIDEO_UNDERSTANDING_MAX_WINDOWS,
  mode = config.LOCAL_VIDEO_UNDERSTANDING_MODE,
  assetMetadata = {},
  sceneContext = {},
}) => {
  const runtimeTimeoutMs = Math.max(5000, Number(config.LOCAL_VIDEO_UNDERSTANDING_TIMEOUT_MS || 25000));
  const mediaInfo = await probeMedia(inputPath).catch(() => ({ duration: 0 }));
  const fallbackWindows = buildFallbackWindows({
    duration: mediaInfo.duration,
    windowSeconds: Number(windowSeconds || 8),
    maxWindows: Number(maxWindows || 20),
    assetMetadata,
    sceneContext,
  });

  if (!isEnabled()) {
    return {
      enabled: false,
      provider: "weak_fallback_disabled",
      analysis_window_seconds: Number(windowSeconds || 8),
      analysis_windows: fallbackWindows,
      analysis_summary: "visual evidence unavailable - weak fallback",
      analysis_tags: unique(fallbackWindows.flatMap((window) => window.tags || [])).slice(0, 12),
    };
  }

  const python = config.LOCAL_VIDEO_UNDERSTANDING_PYTHON || "python";
  const scriptPath = path.isAbsolute(config.LOCAL_VIDEO_UNDERSTANDING_SCRIPT || "")
    ? config.LOCAL_VIDEO_UNDERSTANDING_SCRIPT
    : path.join(process.cwd(), config.LOCAL_VIDEO_UNDERSTANDING_SCRIPT || "tools/video-understanding/analyze_video.py");

  if (!(await fs.pathExists(scriptPath))) {
    return {
      enabled: true,
      provider: "weak_fallback_script_missing",
      analysis_window_seconds: Number(windowSeconds || 8),
      analysis_windows: fallbackWindows,
      analysis_summary: fallbackWindows[0]?.summary || "travel footage",
      analysis_tags: unique(fallbackWindows.flatMap((window) => window.tags || [])).slice(0, 12),
    };
  }

  try {
    const args = [
      scriptPath,
      "--input",
      inputPath,
      "--window-seconds",
      String(Number(windowSeconds || 8)),
      "--max-windows",
      String(Number(maxWindows || 20)),
      "--mode",
      String(mode || "frames"),
      "--asset-metadata",
      JSON.stringify({
        query: assetMetadata.query || "",
        semantic_text: assetMetadata.semantic_text || "",
        provider_tags: assetMetadata.provider_tags || [],
      }),
      "--scene-context",
      JSON.stringify({
        title: sceneContext.title || "",
        narration_excerpt: sceneContext.narration_excerpt || "",
        keywords: sceneContext.keywords || [],
        block_label: sceneContext.block_label || "",
        subtheme: sceneContext.subtheme || "",
      }),
    ];

    const { stdout } = await runPython(python, args, {
      cwd: process.cwd(),
      timeout: runtimeTimeoutMs,
    });
    const payload = JSON.parse(stdout || "{}");
    const windows = Array.isArray(payload.analysis_windows) && payload.analysis_windows.length
      ? enrichWindowsWithEvidence({ windows: payload.analysis_windows, sceneContext, assetMetadata })
      : fallbackWindows;

    return {
      enabled: true,
      provider: payload.analysis_provider || "local_video_understanding",
      analysis_window_seconds: Number(payload.analysis_window_seconds || windowSeconds || 8),
      analysis_windows: windows,
      analysis_summary: payload.analysis_summary || payload.semantic_text || windows[0]?.summary || "travel footage",
      analysis_tags: unique([
        ...(payload.analysis_tags || []),
        ...windows.flatMap((window) => window.tags || []),
      ]).slice(0, 16),
    };
  } catch {
    return {
      enabled: true,
      provider: "weak_fallback_runtime_error",
      analysis_window_seconds: Number(windowSeconds || 8),
      analysis_windows: fallbackWindows,
      analysis_summary: fallbackWindows[0]?.summary || "travel footage",
      analysis_tags: unique(fallbackWindows.flatMap((window) => window.tags || [])).slice(0, 12),
    };
  }
};

module.exports = {
  analyzeLocalVideo,
  isLocalVideoUnderstandingEnabled: isEnabled,
  __test__: {
    buildFallbackWindows,
  },
};
