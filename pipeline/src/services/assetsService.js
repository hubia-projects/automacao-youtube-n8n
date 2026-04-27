const path = require("path");
const fs = require("fs-extra");
const axios = require("axios");
const { config } = require("../config/env");
const { loadState, ensureVideoStructure, updateState } = require("./stateService");

const hasPexels = () => Boolean(config.PEXELS_API_KEY);
const hasPixabay = () => Boolean(config.PIXABAY_API_KEY);

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

const downloadFile = async (url, outputPath) => {
  const response = await axios.get(url, { responseType: "stream", timeout: 45000 });
  await fs.ensureDir(path.dirname(outputPath));
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
  return outputPath;
};

const createMockVisual = async (outputPath) => {
  await fs.ensureDir(path.dirname(outputPath));
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+f4kAAAAASUVORK5CYII=";
  await fs.writeFile(outputPath, Buffer.from(pngBase64, "base64"));
  return outputPath;
};

const searchPexels = async (query, limit = 4) => {
  if (!hasPexels()) return [];

  const [videoRes, imageRes] = await Promise.allSettled([
    axios.get("https://api.pexels.com/videos/search", {
      headers: { Authorization: config.PEXELS_API_KEY },
      params: { query, per_page: Math.max(1, Math.floor(limit / 2)) },
      timeout: 30000,
    }),
    axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: config.PEXELS_API_KEY },
      params: { query, per_page: Math.max(1, Math.ceil(limit / 2)) },
      timeout: 30000,
    }),
  ]);

  const items = [];

  if (videoRes.status === "fulfilled") {
    const videos = videoRes.value.data?.videos || [];
    videos.forEach((video) => {
      const file = (video.video_files || []).find((vf) => vf.quality === "sd") || video.video_files?.[0];
      if (file?.link) {
        items.push({
          provider: "pexels",
          type: "video",
          query,
          source_url: file.link,
        });
      }
    });
  }

  if (imageRes.status === "fulfilled") {
    const photos = imageRes.value.data?.photos || [];
    photos.forEach((photo) => {
      if (photo?.src?.large) {
        items.push({
          provider: "pexels",
          type: "image",
          query,
          source_url: photo.src.large,
        });
      }
    });
  }

  return items;
};

const searchPixabay = async (query, limit = 4) => {
  if (!hasPixabay()) return [];

  const response = await axios.get("https://pixabay.com/api/videos/", {
    params: {
      key: config.PIXABAY_API_KEY,
      q: query,
      per_page: limit,
    },
    timeout: 30000,
  });

  return (response.data?.hits || [])
    .map((hit) => ({
      provider: "pixabay",
      type: "video",
      query,
      source_url: hit.videos?.medium?.url || hit.videos?.small?.url,
    }))
    .filter((item) => item.source_url);
};

const generateAssets = async ({ videoId, mockMode = false, maxAssets = 8 }) => {
  const state = await loadState(videoId);
  const paths = await ensureVideoStructure(videoId);

  const baseText = `${state.topic || "travel"} ${state.angle || "guide"} ${state.script_text || ""}`;
  const keywords = extractKeywords(baseText, 6);
  const searchQueries = keywords.slice(0, 4).map((word) => `${word} travel`);

  let candidates = [];

  if (!mockMode) {
    for (const query of searchQueries) {
      const [pexels, pixabay] = await Promise.allSettled([searchPexels(query, 4), searchPixabay(query, 4)]);
      if (pexels.status === "fulfilled") candidates.push(...pexels.value);
      if (pixabay.status === "fulfilled") candidates.push(...pixabay.value);
      if (candidates.length >= maxAssets) break;
    }
  }

  const items = [];
  let index = 1;

  for (const candidate of candidates.slice(0, maxAssets)) {
    const ext = candidate.type === "video" ? "mp4" : "jpg";
    const localPath = path.join(paths.rawAssetsDir, `asset-${String(index).padStart(3, "0")}.${ext}`);
    try {
      await downloadFile(candidate.source_url, localPath);
      items.push({
        ...candidate,
        local_path: localPath,
      });
      index += 1;
    } catch {
      // ignore one-off download failures
    }
  }

  if (!items.length) {
    const fallbackPlan = [
      "Usar mapas animados para introdução",
      "B-roll de paisagens e ruas locais",
      "Blocos com custos e dicas práticas em texto",
      "Encerramento com checklist visual",
    ];

    for (let i = 1; i <= 4; i += 1) {
      const localPath = path.join(paths.rawAssetsDir, `mock-asset-${i}.png`);
      await createMockVisual(localPath, `Mock ${i}`);
      items.push({
        provider: "mock",
        type: "image",
        query: searchQueries[i - 1] || "travel",
        source_url: "generated-local",
        local_path: localPath,
      });
    }

    const nextState = await updateState(
      videoId,
      {
        assets_json: {
          visual_keywords: keywords,
          search_queries: searchQueries,
          items,
          fallback_plan: fallbackPlan,
          missing_assets: true,
        },
        error_message: "",
      },
      { currentStep: "assets_searched", status: "assets_searched" }
    );

    return {
      video_id: videoId,
      assets_count: items.length,
      missing_assets: true,
      state_path: nextState.state_path,
      assets_json: nextState.assets_json,
    };
  }

  const nextState = await updateState(
    videoId,
    {
      assets_json: {
        visual_keywords: keywords,
        search_queries: searchQueries,
        items,
        fallback_plan: [],
        missing_assets: false,
      },
      error_message: "",
    },
    { currentStep: "assets_searched", status: "assets_searched" }
  );

  return {
    video_id: videoId,
    assets_count: items.length,
    missing_assets: false,
    state_path: nextState.state_path,
    assets_json: nextState.assets_json,
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
    const response = await axios.get("https://pixabay.com/api/", {
      params: { key: config.PIXABAY_API_KEY, q: "travel", per_page: 1 },
      timeout: 20000,
    });
    return {
      configured: true,
      ok: true,
      message: `Pixabay respondeu com ${response.data?.hits?.length || 0} item(ns)`,
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