const path = require("path");
const fs = require("fs-extra");
const axios = require("axios");
const { config } = require("../config/env");
const { loadState, ensureVideoStructure, updateState } = require("./stateService");
const { sendWorkflowStatus } = require("./telegramService");
const { buildVisualPlan } = require("../utils/visualPlan");
const { createPlaceholderImage, extractVideoFrame, probeMedia, getResolutionLabel } = require("../utils/mediaUtils");
const { hasOpenAi, describeImagesWithOpenAI } = require("./openaiService");
const { getCachedAudioIntelligence } = require("./audioIntelligence");
const { enrichVisualPlan } = require("./narrativeBlockPlanner");
const { analyzeLocalVideo } = require("./localVideoUnderstandingService");
const { buildSceneQueryPlan } = require("./assetQueryPlanner");
const { scorePreDownloadCandidate } = require("./assetRejectionService");
const { summarizeAssetReadiness, shouldAllowPlaceholderAssets } = require("./assetReadinessService");
const { approveAssetsForVisualPlan } = require("./assetApprovalService");
const { evaluateVisualEvidence } = require("./visualIntentService");
const { logger } = require("../utils/logger");

const hasPexels = () => Boolean(config.PEXELS_API_KEY);
const hasPixabay = () => Boolean(config.PIXABAY_API_KEY);

const MIN_WIDTH = 1280;
const MIN_HEIGHT = 720;
const PREFERRED_WIDTH = 1920;
const PREFERRED_HEIGHT = 1080;
const MAX_ASSETS_PER_SCENE = Math.max(3, Number(config.ASSET_DOWNLOAD_TOP_PER_SCENE || 6));
const MIN_VIDEO_DURATION_SECONDS = 5;
const PREFERRED_VIDEO_DURATION_SECONDS = 16;
const MAX_ANALYSIS_WINDOWS = config.SEMANTIC_SYNC_MODE === "high-quality" ? 10 : 6;
const ANALYSIS_WINDOW_SECONDS = config.SEMANTIC_SYNC_MODE === "high-quality" ? 3 : 4;
const ANALYSIS_STRIDE_SECONDS = config.SEMANTIC_SYNC_MODE === "high-quality" ? 1.5 : 2;
const SEARCH_RESULTS_PER_QUERY = Math.max(4, Number(config.ASSET_SEARCH_RESULTS_PER_QUERY || 12));
const CANDIDATE_POOL_PER_SCENE = Math.max(6, Number(config.ASSET_CANDIDATE_POOL_PER_SCENE || 30));
const MIN_SPECIFIC_ASSETS_PER_SCENE = Math.max(1, Number(config.MIN_SPECIFIC_ASSETS_PER_SCENE || 2));

const unique = (values = []) => [...new Set(values.filter(Boolean))];

const round3 = (value) => Number(Number(value || 0).toFixed(3));

const normalizeSceneIndexes = (sceneIndexes = []) =>
  unique((Array.isArray(sceneIndexes) ? sceneIndexes : [sceneIndexes]).map((value) => Number(value || 0)).filter((value) => Number.isInteger(value) && value > 0))
    .sort((left, right) => left - right);

const getSceneScopedEntrySortKey = (entry = {}) =>
  entry.local_path || entry.query || entry.provider || (Array.isArray(entry.queries) ? entry.queries.join("|") : "");

const sortSceneScopedEntries = (entries = []) =>
  [...entries].sort((left, right) =>
    Number(left.scene_index || 0) - Number(right.scene_index || 0) ||
    String(getSceneScopedEntrySortKey(left)).localeCompare(String(getSceneScopedEntrySortKey(right)))
  );

const mergeSceneScopedEntries = ({ existingEntries = [], nextEntries = [], sceneIndexes = [] }) => {
  const targetSceneIndexes = new Set(normalizeSceneIndexes(sceneIndexes));
  if (!targetSceneIndexes.size) {
    return sortSceneScopedEntries(nextEntries);
  }

  return sortSceneScopedEntries([
    ...existingEntries.filter((entry) => !targetSceneIndexes.has(Number(entry.scene_index || 0))),
    ...nextEntries,
  ]);
};

const extractFallbackPlanSceneIndex = (line = "") => Number(String(line).match(/Cena\s+(\d+)/i)?.[1] || 0);

const mergeFallbackPlan = ({ existingFallbackPlan = [], nextFallbackPlan = [], sceneIndexes = [] }) => {
  const targetSceneIndexes = new Set(normalizeSceneIndexes(sceneIndexes));
  const preservedFallbackPlan = targetSceneIndexes.size
    ? existingFallbackPlan.filter((line) => !targetSceneIndexes.has(extractFallbackPlanSceneIndex(line)))
    : [];

  return [...preservedFallbackPlan, ...nextFallbackPlan].sort(
    (left, right) => extractFallbackPlanSceneIndex(left) - extractFallbackPlanSceneIndex(right)
  );
};

const getSceneSourceUrlSet = (items = [], sceneIndex = 0) =>
  new Set(
    items
      .filter((item) => Number(item.scene_index || 0) === Number(sceneIndex || 0))
      .map((item) => item.source_url)
      .filter((sourceUrl) => sourceUrl && sourceUrl !== "generated-local")
  );

const slugify = (value = "") =>
  String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

const isHorizontal = ({ width = 0, height = 0 }) => width >= MIN_WIDTH && height >= MIN_HEIGHT && width >= height;

const resolutionScore = ({ width = 0, height = 0, assetType = "image" }) => {
  const area = width * height;
  const preferredBonus = width >= PREFERRED_WIDTH && height >= PREFERRED_HEIGHT ? 1_500_000 : 0;
  const videoBonus = assetType === "video" ? 250_000 : 0;
  return area + preferredBonus + videoBonus;
};

const getCandidateDuration = (candidate = {}) => Number(candidate.duration_estimate || 0);

const isVideoCandidate = (candidate = {}) => candidate.asset_type === "video" || candidate.type === "video";

const candidateMotionScore = (candidate = {}) => {
  const baseScore = resolutionScore({
    width: Number(candidate.width || 0),
    height: Number(candidate.height || 0),
    assetType: candidate.asset_type || candidate.type || "image",
  });
  const relevanceBonus = Number(candidate.search_relevance_score || 0);

  if (!isVideoCandidate(candidate)) {
    return baseScore + relevanceBonus;
  }

  const duration = getCandidateDuration(candidate);
  const durationBonus = Math.min(duration, 45) * 220_000;
  const longFormBonus = duration >= PREFERRED_VIDEO_DURATION_SECONDS ? 6_000_000 : duration >= MIN_VIDEO_DURATION_SECONDS ? 4_000_000 : 1_500_000;
  return baseScore + durationBonus + longFormBonus + relevanceBonus;
};

const sortCandidatesForMotion = (candidates = []) =>
  [...candidates].sort((left, right) => candidateMotionScore(right) - candidateMotionScore(left));

const dedupeCandidatesByUrl = (candidates = []) => {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate?.source_url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const partitionSceneCandidates = (candidates = []) => {
  const longVideos = [];
  const shortVideos = [];
  const images = [];

  candidates.forEach((candidate) => {
    if (isVideoCandidate(candidate)) {
      if (getCandidateDuration(candidate) >= MIN_VIDEO_DURATION_SECONDS) {
        longVideos.push(candidate);
      } else {
        shortVideos.push(candidate);
      }
      return;
    }

    images.push(candidate);
  });

  return {
    longVideos: sortCandidatesForMotion(longVideos),
    shortVideos: sortCandidatesForMotion(shortVideos),
    images: images.sort((left, right) => resolutionScore(right) - resolutionScore(left)),
  };
};

const extractKeywords = (text = "", limit = 8) => {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4);

  const stopwords = new Set([
    "sobre",
    "entre",
    "porque",
    "quando",
    "como",
    "neste",
    "neste",
    "vídeo",
    "você",
    "para",
    "com",
    "mais",
    "menos",
  ]);

  const freq = new Map();
  words.forEach((word) => {
    if (stopwords.has(word)) return;
    freq.set(word, (freq.get(word) || 0) + 1);
  });

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
};

const normalizeToken = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const matchesNegativeKeyword = ({ candidate = {}, negativeKeywords = [] }) => {
  if (!Array.isArray(negativeKeywords) || !negativeKeywords.length) return false;
  const candidateText = normalizeToken([
    candidate.query,
    candidate.semantic_text,
    candidate.provider_title,
    ...(candidate.provider_tags || []),
  ].filter(Boolean).join(" "));
  return negativeKeywords.some((keyword) => {
    const token = normalizeToken(keyword);
    return token && candidateText.includes(token);
  });
};

const buildAnalysisWindowBlueprints = ({ assetDuration = 0 }) => {
  const safeDuration = Math.max(0.5, Number(assetDuration || 0));
  const windowSeconds = Math.min(ANALYSIS_WINDOW_SECONDS, safeDuration);
  const strideSeconds = Math.min(ANALYSIS_STRIDE_SECONDS, Math.max(0.5, windowSeconds * 0.75));
  const starts = [];

  for (let start = 0; start < safeDuration - 0.25; start += strideSeconds) {
    starts.push(round3(Math.min(start, Math.max(0, safeDuration - windowSeconds))));
    if (start + windowSeconds >= safeDuration) break;
  }

  if (!starts.length) starts.push(0);
  const uniqueStarts = unique(starts);
  const selectedStarts = uniqueStarts.length <= MAX_ANALYSIS_WINDOWS
    ? uniqueStarts
    : Array.from({ length: MAX_ANALYSIS_WINDOWS }, (_, index) => {
        const sourceIndex = Math.round((index * (uniqueStarts.length - 1)) / Math.max(1, MAX_ANALYSIS_WINDOWS - 1));
        return uniqueStarts[sourceIndex];
      });

  return unique(selectedStarts).map((startSeconds, index) => {
    const endSeconds = round3(Math.min(safeDuration, startSeconds + windowSeconds));
    const sampleTimeSeconds = round3(Math.min(safeDuration - 0.1, startSeconds + Math.max(0.1, (endSeconds - startSeconds) / 2)));

    return {
      window_index: index + 1,
      start_seconds: round3(startSeconds),
      end_seconds: Math.max(round3(startSeconds + 0.5), endSeconds),
      sample_time_seconds: sampleTimeSeconds,
      overlap_strategy: "short_window_stride",
    };
  });
};

const buildFallbackAnalysisPayload = ({ asset, scene }) => {
  const baseSummary = "visual evidence unavailable - weak fallback";
  const baseTags = [];
  const windows = buildAnalysisWindowBlueprints({ assetDuration: asset.source_duration_seconds || asset.duration_estimate || 0 }).map((window) => {
    const baseWindow = {
      window_index: window.window_index,
      start_seconds: window.start_seconds,
      end_seconds: window.end_seconds,
      sample_time_seconds: window.sample_time_seconds,
      description: baseSummary,
      summary: baseSummary,
      tags: baseTags,
      location: {
        city: "",
        country: "",
        confidence: 0,
      },
      landmarks: [],
      location_type: "",
      visual_features: {
        shot_type: "unknown",
        camera_motion: "unknown",
        dominant_colors: [],
        has_people: false,
        has_water: false,
        has_architecture: false,
      },
      quality: {
        sharpness: 0.7,
        stability: 0.7,
        brightness: 0.7,
        usable: true,
      },
      confidence: 0.35,
      method: "metadata_fallback",
      visual_evidence_source: "metadata_fallback",
      visual_observation_origin: "weak_fallback",
    };
    const evidence = evaluateVisualEvidence({ scene, window: baseWindow, asset });
    return {
      ...baseWindow,
      detected_visual_categories: evidence.detected_visual_categories,
      detected_objects: [],
      visual_intent_match: evidence.visual_intent_match,
      generic_visual: evidence.generic_visual,
      required_evidence_found: evidence.required_evidence_found,
      missing_required_visual_evidence: evidence.missing_required_visual_evidence,
    };
  });

  return {
    semantic_text: baseSummary,
    analysis_summary: baseSummary,
    analysis_tags: baseTags,
    analysis_windows: windows,
    analysis_provider: "metadata_fallback",
    analysis_window_seconds: ANALYSIS_WINDOW_SECONDS,
  };
};

const mergeAnalysisPayload = ({ asset, scene, payload = {} }) => {
  const fallback = buildFallbackAnalysisPayload({ asset, scene });
  const analysisWindows = Array.isArray(payload.analysis_windows) && payload.analysis_windows.length
    ? payload.analysis_windows.map((window) => {
        const evidence = evaluateVisualEvidence({ scene, window, asset });
        return {
          ...window,
          detected_visual_categories: window.detected_visual_categories || evidence.detected_visual_categories,
          detected_objects: window.detected_objects || [],
          visual_intent_match: typeof window.visual_intent_match === "boolean" ? window.visual_intent_match : evidence.visual_intent_match,
          generic_visual: typeof window.generic_visual === "boolean" ? window.generic_visual : evidence.generic_visual,
          required_evidence_found: window.required_evidence_found || evidence.required_evidence_found,
          missing_required_visual_evidence: window.missing_required_visual_evidence || evidence.missing_required_visual_evidence,
          visual_evidence_source: window.visual_evidence_source || payload.analysis_provider || payload.provider || fallback.analysis_provider,
          visual_observation_origin: window.visual_observation_origin || (String(window.visual_evidence_source || payload.analysis_provider || payload.provider || fallback.analysis_provider).toLowerCase().includes("fallback") ? "weak_fallback" : "real_vision"),
        };
      })
    : fallback.analysis_windows;
  return {
    ...fallback,
    ...payload,
    semantic_text: payload.semantic_text || payload.analysis_summary || fallback.semantic_text,
    analysis_summary: payload.analysis_summary || payload.semantic_text || fallback.analysis_summary,
    analysis_tags: unique([...(payload.analysis_tags || []), ...(fallback.analysis_tags || [])]).slice(0, 16),
    analysis_windows: analysisWindows,
    analysis_provider: payload.analysis_provider || payload.provider || fallback.analysis_provider,
    analysis_window_seconds: Number(payload.analysis_window_seconds || fallback.analysis_window_seconds || ANALYSIS_WINDOW_SECONDS),
  };
};

const buildAssetAnalysisPrompt = ({ scene, asset, windowBlueprints }) => `Analise os frames em ordem. Cada frame representa uma janela diferente do mesmo video de viagem.

Contexto da cena esperada:
- titulo: ${scene.title || ""}
- trecho narrado: ${scene.narration_excerpt || ""}
- keywords: ${(scene.keywords || []).join(", ")}
- query do asset: ${asset.query || ""}

Regras:
- descreva apenas o que esta visivel
- nao invente cidade, pais ou ponto turistico sem evidencia visual clara
- priorize elementos concretos como telhados, rua estreita, bonde, ponte, rio, castelo, mata, praia, falesia, mercado, comida, pessoas caminhando, panorama urbano
- se o frame for generico, diga que e generico
- se reconhecer cidade ou landmark, informe com confianca; se nao reconhecer, deixe vazio

Retorne JSON estrito no formato:
{
  "overall_summary": "",
  "overall_tags": [""],
  "windows": [
    {
      "frame_index": 1,
      "summary": "",
      "tags": [""],
      "location": {"city": "", "country": "", "confidence": 0.0},
      "landmarks": [{"name": "", "confidence": 0.0}],
      "location_type": "",
      "visual_features": {
        "shot_type": "wide|medium|detail|aerial|unknown",
        "camera_motion": "static|pan|tilt|drone|tracking|unknown",
        "dominant_colors": [""],
        "has_people": false,
        "has_water": false,
        "has_architecture": false
      },
      "quality": {"sharpness": 0.0, "stability": 0.0, "brightness": 0.0, "usable": true},
      "confidence": 0.0
    }
  ]
}

Os frames enviados correspondem a ${windowBlueprints.map((window) => `frame ${window.window_index} = ${window.start_seconds}s ate ${window.end_seconds}s`).join("; ")}.`;

const normalizeAssetAnalysisResponse = ({ response, asset, scene, windowBlueprints }) => {
  const responseWindows = Array.isArray(response?.windows) ? response.windows : [];
  const fallback = buildFallbackAnalysisPayload({ asset, scene });

  const analysisWindows = windowBlueprints.map((windowBlueprint, index) => {
    const responseWindow = responseWindows.find((item) => Number(item.frame_index || item.window_index) === windowBlueprint.window_index) || responseWindows[index] || {};
    const summary = responseWindow.summary || responseWindow.description || fallback.analysis_windows[index]?.summary || fallback.analysis_summary;
    const tags = unique([
      ...(Array.isArray(responseWindow.tags) ? responseWindow.tags : []),
      ...(fallback.analysis_windows[index]?.tags || []),
    ]).slice(0, 12);
    const location = responseWindow.location && typeof responseWindow.location === "object"
      ? {
          city: responseWindow.location.city || "",
          country: responseWindow.location.country || "",
          confidence: Math.max(0, Math.min(1, Number(responseWindow.location.confidence || 0))),
        }
      : fallback.analysis_windows[index]?.location;
    const landmarks = Array.isArray(responseWindow.landmarks)
      ? responseWindow.landmarks
          .map((landmark) => ({
            name: landmark?.name || "",
            confidence: Math.max(0, Math.min(1, Number(landmark?.confidence || 0))),
          }))
          .filter((landmark) => landmark.name)
          .slice(0, 5)
      : fallback.analysis_windows[index]?.landmarks || [];
    const visualFeatures = responseWindow.visual_features && typeof responseWindow.visual_features === "object"
      ? {
          shot_type: responseWindow.visual_features.shot_type || "unknown",
          camera_motion: responseWindow.visual_features.camera_motion || "unknown",
          dominant_colors: Array.isArray(responseWindow.visual_features.dominant_colors) ? responseWindow.visual_features.dominant_colors.slice(0, 5) : [],
          has_people: Boolean(responseWindow.visual_features.has_people),
          has_water: Boolean(responseWindow.visual_features.has_water),
          has_architecture: Boolean(responseWindow.visual_features.has_architecture),
        }
      : fallback.analysis_windows[index]?.visual_features;
    const quality = responseWindow.quality && typeof responseWindow.quality === "object"
      ? {
          sharpness: Math.max(0, Math.min(1, Number(responseWindow.quality.sharpness || 0.7))),
          stability: Math.max(0, Math.min(1, Number(responseWindow.quality.stability || 0.7))),
          brightness: Math.max(0, Math.min(1, Number(responseWindow.quality.brightness || 0.7))),
          usable: responseWindow.quality.usable !== false,
        }
      : fallback.analysis_windows[index]?.quality;

    return {
      window_index: windowBlueprint.window_index,
      start_seconds: windowBlueprint.start_seconds,
      end_seconds: windowBlueprint.end_seconds,
      sample_time_seconds: windowBlueprint.sample_time_seconds,
      description: summary,
      summary,
      tags,
      location,
      landmarks,
      location_type: responseWindow.location_type || "",
      visual_features: visualFeatures,
      quality,
      confidence: Math.max(0, Math.min(1, Number(responseWindow.confidence || 0.6))),
      detected_visual_categories: responseWindow.detected_visual_categories || [],
      detected_objects: responseWindow.detected_objects || [],
      visual_intent_match: responseWindow.visual_intent_match,
      generic_visual: responseWindow.generic_visual,
    };
  });

  const overallSummary = response?.overall_summary || response?.summary || analysisWindows.map((window) => window.summary).filter(Boolean).join("; ") || fallback.analysis_summary;
  const overallTags = unique([
    ...(Array.isArray(response?.overall_tags) ? response.overall_tags : []),
    ...analysisWindows.flatMap((window) => window.tags || []),
    ...(fallback.analysis_tags || []),
  ]).slice(0, 16);

  return {
    semantic_text: overallSummary,
    analysis_summary: overallSummary,
    analysis_tags: overallTags,
    analysis_windows: analysisWindows,
    analysis_provider: "openai_vision",
    analysis_window_seconds: ANALYSIS_WINDOW_SECONDS,
  };
};

const analyzeDownloadedAssetSemantics = async ({ asset, scene, paths }) => {
  const fallbackPayload = buildFallbackAnalysisPayload({ asset, scene });

  if (asset.asset_type !== "video" || !asset.local_path) {
    return {
      ...asset,
      ...fallbackPayload,
    };
  }

  const localPayload = await analyzeLocalVideo({
    inputPath: asset.local_path,
    windowSeconds: config.LOCAL_VIDEO_UNDERSTANDING_WINDOW_SECONDS || ANALYSIS_WINDOW_SECONDS,
    maxWindows: config.LOCAL_VIDEO_UNDERSTANDING_MAX_WINDOWS || MAX_ANALYSIS_WINDOWS,
    mode: config.LOCAL_VIDEO_UNDERSTANDING_MODE || "frames",
    assetMetadata: asset,
    sceneContext: scene,
  }).catch(() => null);

  const localProvider = String(localPayload?.provider || "").toLowerCase();
  const weakLocalProvider = localProvider.startsWith("weak_fallback") || ["disabled", "script_missing", "metadata_fallback"].includes(localProvider);
  if (localPayload?.provider && !weakLocalProvider) {
    return {
      ...asset,
      ...mergeAnalysisPayload({
        asset,
        scene,
        payload: {
          semantic_text: localPayload.analysis_summary,
          analysis_summary: localPayload.analysis_summary,
          analysis_tags: localPayload.analysis_tags,
          analysis_windows: localPayload.analysis_windows,
          analysis_provider: localPayload.provider,
          analysis_window_seconds: localPayload.analysis_window_seconds,
        },
      }),
    };
  }

  if (!hasOpenAi()) {
    return {
      ...asset,
      ...mergeAnalysisPayload({ asset, scene, payload: localPayload || fallbackPayload }),
    };
  }

  const windowBlueprints = buildAnalysisWindowBlueprints({ assetDuration: asset.source_duration_seconds || asset.duration_estimate || 0 });
  const analysisDir = path.join(paths.base, "assets", "analysis", path.basename(asset.local_path, path.extname(asset.local_path)));

  try {
    await fs.ensureDir(analysisDir);
    const framePaths = [];

    for (const windowBlueprint of windowBlueprints) {
      const framePath = path.join(analysisDir, `window-${String(windowBlueprint.window_index).padStart(2, "0")}.jpg`);
      await extractVideoFrame({
        inputPath: asset.local_path,
        outputPath: framePath,
        timeSeconds: windowBlueprint.sample_time_seconds,
      });
      framePaths.push(framePath);
    }

    const response = await describeImagesWithOpenAI({
      prompt: buildAssetAnalysisPrompt({ scene, asset, windowBlueprints }),
      imagePaths: framePaths,
      detail: "low",
    });

    await fs.remove(analysisDir).catch(() => null);

    return {
      ...asset,
      ...mergeAnalysisPayload({
        asset,
        scene,
        payload: response
          ? {
              ...normalizeAssetAnalysisResponse({ response, asset, scene, windowBlueprints }),
              analysis_provider: "openai_vision",
              analysis_window_seconds: ANALYSIS_WINDOW_SECONDS,
            }
          : (localPayload || fallbackPayload),
      }),
    };
  } catch {
    await fs.remove(analysisDir).catch(() => null);
    return {
      ...asset,
      ...mergeAnalysisPayload({ asset, scene, payload: localPayload || fallbackPayload }),
    };
  }
};

const downloadFile = async (url, outputPath) => {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 45000,
    maxRedirects: 5,
  });
  await fs.ensureDir(path.dirname(outputPath));
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
  return outputPath;
};

const createSceneFallbackAsset = async ({ scene, paths }) => {
  const refreshToken = Date.now();
  const outputPath = path.join(
    paths.rawAssetsDir,
    `scene-${String(scene.scene_index).padStart(2, "0")}-fallback-${refreshToken}.png`
  );
  await createPlaceholderImage({
    outputPath,
    width: PREFERRED_WIDTH,
    height: PREFERRED_HEIGHT,
    seed: scene.scene_index,
  });

  return {
    scene_index: scene.scene_index,
    provider: "local_fallback",
    asset_type: "image",
    type: "image",
    query: scene.keywords.join(" "),
    semantic_text: scene.narration_excerpt || scene.title || scene.keywords.join(" "),
    source_url: "generated-local",
    local_path: outputPath,
    resolution: {
      width: PREFERRED_WIDTH,
      height: PREFERRED_HEIGHT,
      label: getResolutionLabel({ width: PREFERRED_WIDTH, height: PREFERRED_HEIGHT }),
    },
    duration_estimate: Number(scene.target_duration_seconds || 6),
    is_fallback: true,
    orientation: "horizontal",
  };
};

const pickBestPexelsVideoFile = (video = {}) => {
  return (video.video_files || [])
    .map((file) => ({
      ...file,
      width: Number(file.width || video.width || 0),
      height: Number(file.height || video.height || 0),
    }))
    .filter((file) => file.link && isHorizontal(file))
    .sort((left, right) => resolutionScore({ ...right, assetType: "video" }) - resolutionScore({ ...left, assetType: "video" }))[0];
};

const searchPexels = async (query, limit = SEARCH_RESULTS_PER_QUERY) => {
  if (!hasPexels()) return [];

  const [videoRes, imageRes] = await Promise.allSettled([
    axios.get("https://api.pexels.com/videos/search", {
      headers: { Authorization: config.PEXELS_API_KEY },
      params: {
        query,
        per_page: Math.max(6, limit),
        orientation: "landscape",
        size: "large",
      },
      timeout: 30000,
    }),
    axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: config.PEXELS_API_KEY },
      params: {
        query,
        per_page: Math.max(3, Math.ceil(limit / 2)),
        orientation: "landscape",
        size: "large",
      },
      timeout: 30000,
    }),
  ]);

  const items = [];

  if (videoRes.status === "fulfilled") {
    const videos = videoRes.value.data?.videos || [];
    videos.forEach((video) => {
      const file = pickBestPexelsVideoFile(video);
      if (file?.link) {
        items.push({
          provider: "pexels",
          asset_type: "video",
          type: "video",
          query,
          semantic_text: query,
          source_url: file.link,
          width: Number(file.width || video.width || 0),
          height: Number(file.height || video.height || 0),
          duration_estimate: Number(video.duration || 0),
        });
      }
    });
  }

  if (imageRes.status === "fulfilled") {
    const photos = imageRes.value.data?.photos || [];
    photos.forEach((photo) => {
      if (photo?.src?.original && isHorizontal({ width: Number(photo.width || 0), height: Number(photo.height || 0) })) {
        items.push({
          provider: "pexels",
          asset_type: "image",
          type: "image",
          query,
          semantic_text: photo.alt || query,
          source_url: photo.src.original || photo.src.large2x || photo.src.large,
          width: Number(photo.width || 0),
          height: Number(photo.height || 0),
        });
      }
    });
  }

  return sortCandidatesForMotion(items.filter((item) => isHorizontal(item)));
};

const normalizePixabayVideo = (query, hit = {}) => {
  const variants = Object.values(hit.videos || {})
    .map((variant) => ({
      url: variant?.url,
      width: Number(variant?.width || 0),
      height: Number(variant?.height || 0),
    }))
    .filter((variant) => variant.url && isHorizontal(variant));

  const best = variants.sort((left, right) => resolutionScore({ ...right, assetType: "video" }) - resolutionScore({ ...left, assetType: "video" }))[0];
  if (!best) return null;

  return {
    provider: "pixabay",
    asset_type: "video",
    type: "video",
    query,
    semantic_text: hit.tags || query,
    provider_tags: String(hit.tags || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    source_url: best.url,
    width: best.width,
    height: best.height,
    duration_estimate: Number(hit.duration || 0),
  };
};

const searchPixabay = async (query, limit = SEARCH_RESULTS_PER_QUERY) => {
  if (!hasPixabay()) return [];

  const [videoResponse, imageResponse] = await Promise.allSettled([
    axios.get("https://pixabay.com/api/videos/", {
      params: {
        key: config.PIXABAY_API_KEY,
        q: query,
        per_page: Math.max(4, limit),
      },
      timeout: 30000,
    }),
    axios.get("https://pixabay.com/api/", {
      params: {
        key: config.PIXABAY_API_KEY,
        q: query,
        image_type: "photo",
        orientation: "horizontal",
        min_width: MIN_WIDTH,
        min_height: MIN_HEIGHT,
        per_page: Math.max(4, limit),
      },
      timeout: 30000,
    }),
  ]);

  const items = [];

  if (videoResponse.status === "fulfilled") {
    (videoResponse.value.data?.hits || []).forEach((hit) => {
      const normalized = normalizePixabayVideo(query, hit);
      if (normalized) items.push(normalized);
    });
  }

  if (imageResponse.status === "fulfilled") {
    (imageResponse.value.data?.hits || []).forEach((hit) => {
      if (!isHorizontal({ width: Number(hit.imageWidth || 0), height: Number(hit.imageHeight || 0) })) return;
      items.push({
        provider: "pixabay",
        asset_type: "image",
        type: "image",
        query,
        semantic_text: hit.tags || query,
        provider_tags: String(hit.tags || "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        source_url: hit.largeImageURL || hit.webformatURL,
        width: Number(hit.imageWidth || 0),
        height: Number(hit.imageHeight || 0),
      });
    });
  }

  return sortCandidatesForMotion(items);
};

const cacheSearchResults = async ({ query, cache }) => {
  if (cache.has(query)) {
    return cache.get(query);
  }

  const [pexels, pixabay] = await Promise.allSettled([searchPexels(query), searchPixabay(query)]);
  const candidates = [
    ...(pexels.status === "fulfilled" ? pexels.value : []),
    ...(pixabay.status === "fulfilled" ? pixabay.value : []),
  ]
    .filter((candidate) => candidate?.source_url && isHorizontal(candidate))
    .sort((left, right) => candidateMotionScore(right) - candidateMotionScore(left));

  cache.set(query, candidates);
  return candidates;
};

const downloadSceneCandidate = async ({ candidate, scene, paths, sequence }) => {
  const extension = candidate.asset_type === "video" ? "mp4" : "jpg";
  const fileName = `scene-${String(scene.scene_index).padStart(2, "0")}-${String(sequence).padStart(2, "0")}-${slugify(candidate.provider)}.${extension}`;
  const localPath = path.join(paths.rawAssetsDir, fileName);

  await downloadFile(candidate.source_url, localPath);
  const mediaInfo = await probeMedia(localPath).catch(() => ({ width: 0, height: 0, duration: 0 }));
  const width = Number(mediaInfo.width || candidate.width || 0);
  const height = Number(mediaInfo.height || candidate.height || 0);

  if (!isHorizontal({ width, height })) {
    await fs.remove(localPath).catch(() => null);
    return null;
  }

  return {
    scene_index: scene.scene_index,
    provider: candidate.provider,
    asset_type: candidate.asset_type,
    type: candidate.asset_type,
    query: candidate.query,
    query_used: candidate.query_used || candidate.query,
    search_reason: candidate.search_reason || "",
    block_intro_candidate: /hard_boundary_block_intro_asset|intro establishing shot/i.test(`${candidate.search_reason || ""} ${candidate.query_used || ""}`),
    chapter_card_candidate: /hard_boundary_chapter_card_clip|chapter transition card/i.test(`${candidate.search_reason || ""} ${candidate.query_used || ""}`),
    pre_download_score: Number(candidate.pre_download_score || 0),
    intent_match: candidate.intent_match === true,
    generic_asset: candidate.generic_asset === true,
    rejection_reason: candidate.rejection_reason || "",
    semantic_text: candidate.semantic_text || candidate.query,
    provider_tags: candidate.provider_tags || [],
    provider_title: candidate.provider_title || "",
    source_url: candidate.source_url,
    local_path: localPath,
    resolution: {
      width,
      height,
      label: getResolutionLabel({ width, height }),
    },
    duration_estimate:
      candidate.asset_type === "video"
        ? Number(mediaInfo.duration || candidate.duration_estimate || scene.target_duration_seconds || 6)
        : Number(scene.target_duration_seconds || 6),
    source_duration_seconds: Number(mediaInfo.duration || candidate.duration_estimate || 0),
    is_fallback: false,
    orientation: "horizontal",
  };
};

const generateAssets = async ({
  videoId,
  mockMode = false,
  maxAssets = 8,
  sceneIndexes = [],
  preserveExisting = false,
  refreshReason = "",
  repairPlanByScene = [],
}) => {
  const state = await loadState(videoId);
  const paths = await ensureVideoStructure(videoId);
  const audioIntelligence = await getCachedAudioIntelligence({ videoId }).catch(() => null);
  const allowPlaceholderAssets = shouldAllowPlaceholderAssets({ mockMode });

  const baseVisualPlan = Array.isArray(state.visual_plan) && state.visual_plan.length
    ? state.visual_plan
    : buildVisualPlan({
        topic: state.topic,
        scriptText: state.script_text,
        outlineSections: state.outline_json?.sections || [],
        durationSeconds: Number(state.duration_seconds || 0),
        audioIntelligence,
      });
  const visualPlan = enrichVisualPlan({
    topic: state.topic,
    visualPlan: baseVisualPlan,
    audioIntelligence,
    audioDuration: Number(state.duration_seconds || 0),
  }).visualPlan;

  const requestedSceneIndexes = normalizeSceneIndexes(sceneIndexes);
  const requestedSceneIndexSet = new Set(requestedSceneIndexes);
  const selectedScenes = requestedSceneIndexSet.size
    ? visualPlan.filter((scene) => requestedSceneIndexSet.has(Number(scene.scene_index || 0)))
    : visualPlan;
  const selectedSceneIndexes = selectedScenes.map((scene) => Number(scene.scene_index || 0));
  const selectiveRefresh = selectedSceneIndexes.length > 0 && selectedSceneIndexes.length < visualPlan.length;
  const preserveUntouchedScenes = Boolean(selectiveRefresh && preserveExisting);
  const previousRawItems = Array.isArray(state.assets_json?.raw_items)
    ? state.assets_json.raw_items
    : (Array.isArray(state.assets_json?.items) ? state.assets_json.items : []);
  const previousApprovedItems = Array.isArray(state.assets_json?.approved_items)
    ? state.assets_json.approved_items
    : (Array.isArray(state.assets_json?.items) ? state.assets_json.items : []);
  const previousSceneQueries = Array.isArray(state.assets_json?.scene_queries) ? state.assets_json.scene_queries : [];
  const previousFallbackPlan = Array.isArray(state.assets_json?.fallback_plan) ? state.assets_json.fallback_plan : [];

  if (requestedSceneIndexSet.size && !selectedScenes.length) {
    return {
      video_id: videoId,
      assets_count: previousApprovedItems.length,
      missing_assets: Boolean(state.assets_json?.missing_assets),
      state_path: state.state_path,
      assets_json: state.assets_json,
      visual_plan: visualPlan,
      refreshed_scene_indexes: [],
    };
  }

  const items = [];
  const fallbackPlan = [];
  const sceneQueries = [];
  const searchCache = new Map();
  const repairPlanMap = new Map(
    (Array.isArray(repairPlanByScene) ? repairPlanByScene : [])
      .map((entry) => [Number(entry.scene_index || 0), entry])
      .filter(([sceneIndex]) => sceneIndex > 0)
  );
  const perSceneTarget = Math.max(1, Math.min(MAX_ASSETS_PER_SCENE, Number(maxAssets || MAX_ASSETS_PER_SCENE)));

  for (const scene of selectedScenes) {
    const repairHints = repairPlanMap.get(Number(scene.scene_index || 0)) || {};
    const queryPlan = buildSceneQueryPlan({ scene, topic: state.topic, repairHints });
    const queries = queryPlan.queries;
    const downloadedItems = [];
    const seenUrls = new Set();
    const longVideoCandidates = [];
    const shortVideoCandidates = [];
    const imageCandidates = [];
    const previouslyUsedSourceUrls = selectiveRefresh ? getSceneSourceUrlSet(previousRawItems, scene.scene_index) : new Set();
    sceneQueries.push({
      scene_index: scene.scene_index,
      block_id: scene.block_id || "",
      block_label: scene.block_label || "",
      visual_intent: scene.visual_intent || "",
      queries,
      query_details: queryPlan.queryDetails || [],
      retrieval_budget: queryPlan.retrievalBudget || {},
      negative_keywords: queryPlan.negativeKeywords,
      search_reason: queryPlan.searchReason,
      specific_intent_required: queryPlan.specificIntentRequired,
      repair_hints: repairHints,
    });

    logger.info(`assetsService: iniciando cena ${scene.scene_index}`, {
      videoId,
      scene_title: scene.title,
      visual_intent: scene.visual_intent || "",
      queries_count: queries.length,
      selective_refresh: selectiveRefresh,
    });

      if (!mockMode) {
        for (const queryDetail of queryPlan.queryDetails || []) {
          const candidates = await cacheSearchResults({ query: queryDetail.query, cache: searchCache });
          const candidatesAfterNegativeKeywords = candidates.filter((candidate) => !matchesNegativeKeyword({
            candidate,
            negativeKeywords: queryPlan.negativeKeywords || [],
          }));
          const scoredCandidates = [...candidatesAfterNegativeKeywords]
            .map((candidate) => ({
              ...candidate,
              query_used: queryDetail.query,
              search_reason: queryDetail.reason,
              negative_keywords: queryPlan.negativeKeywords || [],
              ...scorePreDownloadCandidate({ candidate: { ...candidate, query_used: queryDetail.query }, scene }),
            }))
            .filter((candidate) => !candidate.pre_download_rejected)
          .map((candidate) => ({
            ...candidate,
            search_relevance_score: (
              Number(candidate.pre_download_score || 0) * 1_000_000
              + ((queryPlan.preferredProviders || []).includes(String(candidate.provider || "").toLowerCase()) ? 350_000 : 0)
              + (queryPlan.forceExactRequired ? (candidate.intent_match ? 220_000 : -120_000) : 0)
            ),
          }))
          .sort((left, right) => Number(right.search_relevance_score || 0) - Number(left.search_relevance_score || 0));
        const partitioned = partitionSceneCandidates(scoredCandidates);
        longVideoCandidates.push(...partitioned.longVideos);
        shortVideoCandidates.push(...partitioned.shortVideos);
        imageCandidates.push(...partitioned.images);
      }

      const candidatePasses = [
        dedupeCandidatesByUrl(longVideoCandidates).slice(0, CANDIDATE_POOL_PER_SCENE),
        dedupeCandidatesByUrl(shortVideoCandidates).slice(0, Math.max(4, Math.ceil(CANDIDATE_POOL_PER_SCENE / 2))),
        dedupeCandidatesByUrl(imageCandidates).slice(0, Math.max(4, Math.ceil(CANDIDATE_POOL_PER_SCENE / 3))),
      ];

      const candidateRounds = selectiveRefresh && previouslyUsedSourceUrls.size ? [false, true] : [true];

      for (const allowPreviouslyUsedSourceUrls of candidateRounds) {
        if (downloadedItems.length >= perSceneTarget) break;

        for (const candidatePass of candidatePasses) {
          if (downloadedItems.length >= perSceneTarget) break;
          if (downloadedItems.length > 0 && candidatePass === candidatePasses[2]) break;

          for (const candidate of candidatePass) {
            if (seenUrls.has(candidate.source_url)) continue;
            if (!allowPreviouslyUsedSourceUrls && previouslyUsedSourceUrls.has(candidate.source_url)) continue;
            seenUrls.add(candidate.source_url);

            try {
              const downloaded = await downloadSceneCandidate({
                candidate,
                scene,
                paths,
                sequence: downloadedItems.length + 1,
              });

              if (downloaded) {
                downloadedItems.push(downloaded);
              }
            } catch {
              // ignore one-off download/probe failures
            }

            if (downloadedItems.length >= perSceneTarget) break;
          }
        }
      }
    }

    if (!downloadedItems.length) {
      if (queryPlan.specificIntentRequired) {
        fallbackPlan.push(`Cena ${scene.scene_index}: asset_search_failed_specific_intent para ${scene.title}.`);
      }
      if (allowPlaceholderAssets) {
        downloadedItems.push(await createSceneFallbackAsset({ scene, paths }));
        fallbackPlan.push(`Cena ${scene.scene_index}: fallback local usado para ${scene.title}.`);
      } else {
        fallbackPlan.push(`Cena ${scene.scene_index}: sem asset real disponivel para ${scene.title}; render deve ser bloqueado.`);
      }
    }

    const specificMatches = downloadedItems.filter((item) => item.intent_match && !item.generic_asset).length;
    if (queryPlan.specificIntentRequired && specificMatches < MIN_SPECIFIC_ASSETS_PER_SCENE) {
      fallbackPlan.push(`Cena ${scene.scene_index}: somente ${specificMatches} asset(s) especifico(s) encontrado(s) para intent ${scene.visual_intent}.`);
    }

    const enrichedResults = await Promise.allSettled(
      downloadedItems.map((item) => analyzeDownloadedAssetSemantics({ asset: item, scene, paths }))
    );
    const enrichedItems = enrichedResults.map((result, index) => {
      if (result.status === "fulfilled") return result.value;

      const asset = downloadedItems[index];
      logger.warn("assetsService: fallback apos falha ao enriquecer asset", {
        videoId,
        scene_index: scene.scene_index,
        local_path: asset?.local_path,
        error: result.reason?.message || String(result.reason || "unknown_error"),
      });
      return {
        ...asset,
        ...buildFallbackAnalysisPayload({ asset, scene }),
      };
    });

    logger.info(`assetsService: cena ${scene.scene_index} concluída`, {
      videoId,
      scene_title: scene.title,
      downloaded_items: downloadedItems.length,
      enriched_items: enrichedItems.length,
      specific_matches: specificMatches,
      used_fallback: enrichedItems.some((item) => item.is_fallback),
    });

    items.push(...enrichedItems);
  }

  const mergedRawItems = preserveUntouchedScenes
    ? mergeSceneScopedEntries({ existingEntries: previousRawItems, nextEntries: items, sceneIndexes: selectedSceneIndexes })
    : sortSceneScopedEntries(items);
  const mergedSceneQueries = preserveUntouchedScenes
    ? mergeSceneScopedEntries({ existingEntries: previousSceneQueries, nextEntries: sceneQueries, sceneIndexes: selectedSceneIndexes })
    : sortSceneScopedEntries(sceneQueries);
  const mergedFallbackPlan = preserveUntouchedScenes
    ? mergeFallbackPlan({ existingFallbackPlan: previousFallbackPlan, nextFallbackPlan: fallbackPlan, sceneIndexes: selectedSceneIndexes })
    : mergeFallbackPlan({ nextFallbackPlan: fallbackPlan });
  const retrievalBudgetSummary = mergedSceneQueries.map((entry) => ({
    scene_index: Number(entry.scene_index || 0),
    visual_intent: entry.visual_intent || "",
    retrieval_budget: entry.retrieval_budget || {},
    query_count: Array.isArray(entry.queries) ? entry.queries.length : 0,
  }));
  const flattenedKeywords = unique(visualPlan.flatMap((scene) => scene.keywords || [])).slice(0, 30);
  const searchQueries = unique(mergedSceneQueries.flatMap((entry) => entry.queries || []));
  const approvalResult = approveAssetsForVisualPlan({
    visualPlan,
    assets: mergedRawItems,
  });
  const approvedItems = approvalResult.approved_items || [];
  const readinessSummary = summarizeAssetReadiness({
    visualPlan,
    assets: mergedRawItems,
    approvedItems,
    approvedWindows: approvalResult.approved_windows || [],
    sceneEditorialReadiness: approvalResult.scene_editorial_readiness || [],
    editorialMetrics: approvalResult.editorial_metrics || {},
    mockMode,
  });
  const missingAssets = readinessSummary.missing_assets;
  const refreshSceneIndexes = selectiveRefresh ? selectedSceneIndexes : [];
  const refreshedAt = new Date().toISOString();
  const assetFailureMessage = missingAssets
    ? `Assets insuficientes para render: cenas bloqueadas ${readinessSummary.blocking_scene_indexes.join(", ")}.`
    : "";

  const nextState = await updateState(
    videoId,
    {
      visual_plan: visualPlan,
      asset_failure: missingAssets,
      failure_reason: readinessSummary.failure_reason || "",
      assets_json: {
        visual_keywords: flattenedKeywords,
        search_queries: searchQueries,
        scene_queries: mergedSceneQueries,
        retrieval_budget: retrievalBudgetSummary,
        raw_items: mergedRawItems,
        approved_items: approvedItems,
        items: approvedItems,
        approved_windows: approvalResult.approved_windows || [],
        rejected_windows: approvalResult.rejected_windows || [],
        editorial_bins_by_scene: approvalResult.editorial_bins_by_scene || {},
        editorial_metrics: approvalResult.editorial_metrics || {},
        scene_editorial_readiness: approvalResult.scene_editorial_readiness || [],
        fallback_plan: mergedFallbackPlan,
        missing_assets: missingAssets,
        blocking_scene_indexes: readinessSummary.blocking_scene_indexes,
        scene_asset_readiness: readinessSummary.scene_asset_readiness,
        last_repair_plan_by_scene: Array.from(repairPlanMap.values()),
        last_refresh_scene_indexes: refreshSceneIndexes,
        last_refresh_reason: refreshReason || (selectiveRefresh ? "scene_refresh" : "full_refresh"),
        last_refreshed_at: refreshedAt,
      },
      error_message: assetFailureMessage,
    },
    { currentStep: "assets_searched", status: "assets_searched" }
  );

  await sendWorkflowStatus({
    videoId,
    title: "Assets preparados",
    icon: "🖼️",
    lines: [
      `${approvedItems.length} asset(s) aprovados distribuídos em ${visualPlan.length} cena(s).`,
      `${approvedItems.filter((item) => item.asset_type === "video").length} vídeo(s) e ${approvedItems.filter((item) => item.asset_type !== "video").length} imagem(ns) aprovados.`,
      selectiveRefresh ? `Rebusca seletiva em ${refreshSceneIndexes.length} cena(s): ${refreshSceneIndexes.join(", ")}.` : null,
      missingAssets
        ? `Render bloqueado para ${readinessSummary.blocking_scene_indexes.length} cena(s) sem asset real: ${readinessSummary.blocking_scene_indexes.join(", ")}.`
        : "Pool editorial aprovado gerado com sucesso.",
    ],
  }).catch(() => null);

  return {
    video_id: videoId,
    assets_count: approvedItems.length,
    missing_assets: missingAssets,
    state_path: nextState.state_path,
    assets_json: nextState.assets_json,
    visual_plan: nextState.visual_plan,
    refreshed_scene_indexes: refreshSceneIndexes,
  };
};

const basicPexelsHealthcheck = async () => {
  if (!hasPexels()) {
    return { configured: false, ok: false, message: "PEXELS_API_KEY ausente" };
  }
  try {
    const response = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: config.PEXELS_API_KEY },
      params: { query: "travel city", per_page: 1 },
      timeout: 20000,
    });
    return {
      configured: true,
      ok: true,
      message: `Pexels respondeu com ${response.data?.photos?.length || 0} item(ns)`,
    };
  } catch (error) {
    return { configured: true, ok: false, message: error.message };
  }
};

const basicPixabayHealthcheck = async () => {
  if (!hasPixabay()) {
    return { configured: false, ok: false, message: "PIXABAY_API_KEY ausente" };
  }
  try {
    const response = await axios.get("https://pixabay.com/api/videos/", {
      params: { key: config.PIXABAY_API_KEY, q: "travel", per_page: 3 },
      timeout: 20000,
    });
    return {
      configured: true,
      ok: true,
      message: `Pixabay respondeu com ${response.data?.hits?.length || 0} vídeo(s)`,
    };
  } catch (error) {
    return { configured: true, ok: false, message: error.message };
  }
};

module.exports = {
  generateAssets,
  basicPexelsHealthcheck,
  basicPixabayHealthcheck,
};
