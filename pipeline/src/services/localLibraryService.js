const path = require("path");
const fs = require("fs-extra");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");

const SUPPORTED_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi"]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

let libraryIndex = null;
let libraryIndexPath = null;

const normalizeText = (value = "") =>
  String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");

const getAssetType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (SUPPORTED_VIDEO_EXTENSIONS.has(ext)) return "video";
  if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) return "image";
  return null;
};

const resolveLibraryPath = () => {
  if (!config.LOCAL_ASSET_LIBRARY_PATH) return null;
  return path.isAbsolute(config.LOCAL_ASSET_LIBRARY_PATH)
    ? config.LOCAL_ASSET_LIBRARY_PATH
    : path.join(process.cwd(), config.LOCAL_ASSET_LIBRARY_PATH);
};

const buildLibraryIndex = async (libraryPath) => {
  const index = new Map();

  if (!libraryPath || !(await fs.pathExists(libraryPath))) return index;

  const walkDir = async (dirPath) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
        continue;
      }
      if (entry.name.endsWith(".meta.json")) continue;

      const assetType = getAssetType(entry.name);
      if (!assetType) continue;

      const metaPath = fullPath.replace(/\.[^.]+$/, ".meta.json");
      let meta = {};
      if (await fs.pathExists(metaPath)) {
        try { meta = await fs.readJson(metaPath); } catch { /* skip malformed */ }
      }

      const description = meta.description || path.basename(fullPath, path.extname(fullPath)).replace(/[-_]/g, " ");
      const tags = Array.isArray(meta.tags) ? meta.tags.map(normalizeText) : [];
      const location = {
        city: normalizeText(meta.location?.city || ""),
        country: normalizeText(meta.location?.country || ""),
      };

      index.set(fullPath, { path: fullPath, description, tags, location, type: assetType });
    }
  };

  await walkDir(libraryPath);
  logger.info("localLibraryService: índice construído", { count: index.size, libraryPath });
  return index;
};

const getLibraryIndex = async () => {
  const libraryPath = resolveLibraryPath();
  if (!libraryPath) return new Map();

  if (libraryIndex && libraryIndexPath === libraryPath) return libraryIndex;

  libraryIndex = await buildLibraryIndex(libraryPath);
  libraryIndexPath = libraryPath;
  return libraryIndex;
};

const tokenize = (text = "") =>
  normalizeText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);

const scoreEntry = (entry, queryTokens, city, country) => {
  // Hard country filter
  if (country && entry.location.country && entry.location.country !== normalizeText(country)) {
    return -1;
  }

  const allEntryTokens = [...new Set([
    ...entry.tags.flatMap(tokenize),
    ...tokenize(entry.description),
  ])];

  if (!queryTokens.length || !allEntryTokens.length) return 0;

  const matches = queryTokens.filter((t) => allEntryTokens.includes(t)).length;
  let score = matches / queryTokens.length;

  if (city && entry.location.city && entry.location.city === normalizeText(city)) score += 0.3;
  if (country && entry.location.country && entry.location.country === normalizeText(country)) score += 0.1;

  return score;
};

const searchLocalLibrary = async (query, { city = "", country = "", maxResults = 5 } = {}) => {
  if (!config.LOCAL_ASSET_LIBRARY_PATH) return [];

  const index = await getLibraryIndex();
  if (!index.size) return [];

  const queryTokens = tokenize(query);
  const scored = [];

  for (const entry of index.values()) {
    const score = scoreEntry(entry, queryTokens, city, country);
    if (score >= 0) scored.push({ ...entry, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((entry) => ({
      ...entry,
      source_url: entry.path,
      local_path: entry.path,
      asset_type: entry.type,
      semantic_text: entry.description,
      provider_tags: entry.tags,
      pre_download_score: Math.min(1, entry.score),
      source: "local_library",
    }));
};

const invalidateLibraryIndex = () => {
  libraryIndex = null;
  libraryIndexPath = null;
};

module.exports = {
  searchLocalLibrary,
  buildLibraryIndex,
  getLibraryIndex,
  invalidateLibraryIndex,
};
