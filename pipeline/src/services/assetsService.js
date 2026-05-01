const path = require("path");
const fs = require("fs-extra");
const axios = require("axios");
const { config } = require("../config/env");
const { loadState, ensureVideoStructure, updateState } = require("./stateService");
const { sendWorkflowStatus } = require("./telegramService");
const { buildVisualPlan } = require("../utils/visualPlan");
const { createPlaceholderImage, extractVideoFrame, probeMedia, getResolutionLabel } = require("../utils/mediaUtils");
const { hasOpenAi, describeImagesWithOpenAI } = require("./openaiService");

const hasPexels = () => Boolean(config.PEXELS_API_KEY);
const hasPixabay = () => Boolean(config.PIXABAY_API_KEY);

const MIN_WIDTH = 1280;
const MIN_HEIGHT = 720;
const PREFERRED_WIDTH = 1920;
const PREFERRED_HEIGHT = 1080;
const MAX_ASSETS_PER_SCENE = 3;
const MIN_VIDEO_DURATION_SECONDS = 5;
const PREFERRED_VIDEO_DURATION_SECONDS = 16;
const MAX_ANALYSIS_WINDOWS = 3;

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

  if (!isVideoCandidate(candidate)) {
    return baseScore;
  }

  const duration = getCandidateDuration(candidate);
  const durationBonus = Math.min(duration, 45) * 220_000;
  const longFormBonus = duration >= PREFERRED_VIDEO_DURATION_SECONDS ? 6_000_000 : duration >= MIN_VIDEO_DURATION_SECONDS ? 4_000_000 : 1_500_000;
  return baseScore + durationBonus + longFormBonus;
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

const buildAnalysisWindowBlueprints = ({ assetDuration = 0 }) => {
  const safeDuration = Math.max(0.5, Number(assetDuration || 0));
  const windowCount = safeDuration >= 24 ? 3 : safeDuration >= 12 ? 2 : 1;

  return Array.from({ length: Math.min(MAX_ANALYSIS_WINDOWS, windowCount) }, (_, index) => {
    const startSeconds = round3((safeDuration * index) / windowCount);
    const endSeconds = round3(index === windowCount - 1 ? safeDuration : (safeDuration * (index + 1)) / windowCount);
    const sampleTimeSeconds = round3(Math.min(safeDuration - 0.1, startSeconds + Math.max(0.1, (endSeconds - startSeconds) / 2)));

    return {
      window_index: index + 1,
      start_seconds: startSeconds,
      end_seconds: Math.max(startSeconds + 0.5, endSeconds),
      sample_time_seconds: sampleTimeSeconds,
    };
  });
};

const buildFallbackAnalysisPayload = ({ asset, scene }) => {
  const baseSummary = asset.semantic_text || asset.query || scene.narration_excerpt || scene.title || "travel footage";
  const baseTags = unique([...(asset.provider_tags || []), ...(scene.keywords || []), ...extractKeywords(baseSummary)]).slice(0, 10);
  const windows = buildAnalysisWindowBlueprints({ assetDuration: asset.source_duration_seconds || asset.duration_estimate || 0 }).map((window) => ({
    window_index: window.window_index,
    start_seconds: window.start_seconds,
    end_seconds: window.end_seconds,
    sample_time_seconds: window.sample_time_seconds,
    summary: baseSummary,
    tags: baseTags,
    confidence: 0.35,
  }));

  return {
    semantic_text: baseSummary,
    analysis_summary: baseSummary,
    analysis_tags: baseTags,
    analysis_windows: windows,
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

Retorne JSON estrito no formato:
{
  "overall_summary": "",
  "overall_tags": [""],
  "windows": [
    {
      "frame_index": 1,
      "summary": "",
      "tags": [""],
      "location_type": "",
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

    return {
      window_index: windowBlueprint.window_index,
      start_seconds: windowBlueprint.start_seconds,
      end_seconds: windowBlueprint.end_seconds,
      sample_time_seconds: windowBlueprint.sample_time_seconds,
      summary,
      tags,
      location_type: responseWindow.location_type || "",
      confidence: Math.max(0, Math.min(1, Number(responseWindow.confidence || 0.6))),
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
  };
};

const analyzeDownloadedAssetSemantics = async ({ asset, scene, paths }) => {
  const fallbackPayload = buildFallbackAnalysisPayload({ asset, scene });

  if (!hasOpenAi() || asset.asset_type !== "video" || !asset.local_path) {
    return {
      ...asset,
      ...fallbackPayload,
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
      ...(response ? normalizeAssetAnalysisResponse({ response, asset, scene, windowBlueprints }) : fallbackPayload),
    };
  } catch {
    await fs.remove(analysisDir).catch(() => null);
    return {
      ...asset,
      ...fallbackPayload,
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
  const outputPath = path.join(
    paths.rawAssetsDir,
    `scene-${String(scene.scene_index).padStart(2, "0")}-fallback.png`
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

const buildSceneQueries = ({ scene, topic }) => {
  const topicTerms = String(topic || "")
    .split(/[,:|-]/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 3)
    .slice(0, 2);

  const keywords = unique(scene.keywords || []).slice(0, 5);
  const queries = unique([
    [keywords[0], keywords[1], "travel footage"].filter(Boolean).join(" "),
    keywords.slice(0, 2).join(" "),
    keywords.slice(0, 3).join(" "),
    [topicTerms[0], keywords[0], "drone footage"].filter(Boolean).join(" "),
    [topicTerms[0], keywords[0], keywords[1]].filter(Boolean).join(" "),
    [keywords[0], "travel video"].filter(Boolean).join(" "),
  ]);

  return queries.filter((query) => query.split(/\s+/).filter(Boolean).length >= 2).slice(0, 4);
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

const searchPexels = async (query, limit = 8) => {
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

const searchPixabay = async (query, limit = 8) => {
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
}) => {
  const state = await loadState(videoId);
  const paths = await ensureVideoStructure(videoId);

  const visualPlan = Array.isArray(state.visual_plan) && state.visual_plan.length
    ? state.visual_plan
    : buildVisualPlan({
        topic: state.topic,
        scriptText: state.script_text,
        outlineSections: state.outline_json?.sections || [],
        durationSeconds: Number(state.duration_seconds || 0),
      });

  const requestedSceneIndexes = normalizeSceneIndexes(sceneIndexes);
  const requestedSceneIndexSet = new Set(requestedSceneIndexes);
  const selectedScenes = requestedSceneIndexSet.size
    ? visualPlan.filter((scene) => requestedSceneIndexSet.has(Number(scene.scene_index || 0)))
    : visualPlan;
  const selectedSceneIndexes = selectedScenes.map((scene) => Number(scene.scene_index || 0));
  const selectiveRefresh = selectedSceneIndexes.length > 0 && selectedSceneIndexes.length < visualPlan.length;
  const preserveUntouchedScenes = Boolean(selectiveRefresh && preserveExisting);
  const previousItems = Array.isArray(state.assets_json?.items) ? state.assets_json.items : [];
  const previousSceneQueries = Array.isArray(state.assets_json?.scene_queries) ? state.assets_json.scene_queries : [];
  const previousFallbackPlan = Array.isArray(state.assets_json?.fallback_plan) ? state.assets_json.fallback_plan : [];

  if (requestedSceneIndexSet.size && !selectedScenes.length) {
    return {
      video_id: videoId,
      assets_count: previousItems.length,
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
  const perSceneTarget = Math.max(1, Math.min(MAX_ASSETS_PER_SCENE, Number(maxAssets || MAX_ASSETS_PER_SCENE)));

  for (const scene of selectedScenes) {
    const queries = buildSceneQueries({ scene, topic: state.topic });
    const downloadedItems = [];
    const seenUrls = new Set();
    const longVideoCandidates = [];
    const shortVideoCandidates = [];
    const imageCandidates = [];
    const previouslyUsedSourceUrls = selectiveRefresh ? getSceneSourceUrlSet(previousItems, scene.scene_index) : new Set();
    sceneQueries.push({ scene_index: scene.scene_index, queries });

    if (!mockMode) {
      for (const query of queries) {
        const candidates = await cacheSearchResults({ query, cache: searchCache });
        const partitioned = partitionSceneCandidates(candidates);
        longVideoCandidates.push(...partitioned.longVideos);
        shortVideoCandidates.push(...partitioned.shortVideos);
        imageCandidates.push(...partitioned.images);
      }

      const candidatePasses = [
        dedupeCandidatesByUrl(longVideoCandidates),
        dedupeCandidatesByUrl(shortVideoCandidates),
        dedupeCandidatesByUrl(imageCandidates),
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
      downloadedItems.push(await createSceneFallbackAsset({ scene, paths }));
      fallbackPlan.push(`Cena ${scene.scene_index}: fallback local usado para ${scene.title}.`);
    }

    const enrichedItems = [];
    for (const item of downloadedItems) {
      enrichedItems.push(await analyzeDownloadedAssetSemantics({ asset: item, scene, paths }));
    }

    items.push(...enrichedItems);
  }

  const mergedItems = preserveUntouchedScenes
    ? mergeSceneScopedEntries({ existingEntries: previousItems, nextEntries: items, sceneIndexes: selectedSceneIndexes })
    : sortSceneScopedEntries(items);
  const mergedSceneQueries = preserveUntouchedScenes
    ? mergeSceneScopedEntries({ existingEntries: previousSceneQueries, nextEntries: sceneQueries, sceneIndexes: selectedSceneIndexes })
    : sortSceneScopedEntries(sceneQueries);
  const mergedFallbackPlan = preserveUntouchedScenes
    ? mergeFallbackPlan({ existingFallbackPlan: previousFallbackPlan, nextFallbackPlan: fallbackPlan, sceneIndexes: selectedSceneIndexes })
    : mergeFallbackPlan({ nextFallbackPlan: fallbackPlan });
  const flattenedKeywords = unique(visualPlan.flatMap((scene) => scene.keywords || [])).slice(0, 30);
  const searchQueries = unique(mergedSceneQueries.flatMap((entry) => entry.queries || []));
  const missingAssets = mergedItems.some((item) => item.is_fallback);
  const refreshSceneIndexes = selectiveRefresh ? selectedSceneIndexes : [];
  const refreshedAt = new Date().toISOString();

  const nextState = await updateState(
    videoId,
    {
      visual_plan: visualPlan,
      assets_json: {
        visual_keywords: flattenedKeywords,
        search_queries: searchQueries,
        scene_queries: mergedSceneQueries,
        items: mergedItems,
        fallback_plan: mergedFallbackPlan,
        missing_assets: missingAssets,
        last_refresh_scene_indexes: refreshSceneIndexes,
        last_refresh_reason: refreshReason || (selectiveRefresh ? "scene_refresh" : "full_refresh"),
        last_refreshed_at: refreshedAt,
      },
      error_message: "",
    },
    { currentStep: "assets_searched", status: "assets_searched" }
  );

  await sendWorkflowStatus({
    videoId,
    title: "Assets preparados",
    icon: "🖼️",
    lines: [
      `${mergedItems.length} asset(s) válidos distribuídos em ${visualPlan.length} cena(s).`,
      `${mergedItems.filter((item) => item.asset_type === "video").length} vídeo(s) e ${mergedItems.filter((item) => item.asset_type !== "video").length} imagem(ns) selecionados.`,
      selectiveRefresh ? `Rebusca seletiva em ${refreshSceneIndexes.length} cena(s): ${refreshSceneIndexes.join(", ")}.` : null,
      missingAssets ? `${mergedFallbackPlan.length} cena(s) usaram fallback local em HD.` : "Todas as cenas receberam assets externos em resolução HD ou maior.",
    ],
  }).catch(() => null);

  return {
    video_id: videoId,
    assets_count: mergedItems.length,
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