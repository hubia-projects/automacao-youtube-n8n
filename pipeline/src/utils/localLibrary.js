const path = require("path");
const fs = require("fs-extra");
const { probeMedia } = require("./mediaUtils");
const { logger } = require("./logger");

const PIPELINE_ROOT = path.resolve(__dirname, "..", "..");
const SUPPORTED_EXTENSIONS = new Set([".mp4", ".mov", ".jpg", ".jpeg", ".png", ".webp"]);

const normalizeTokenSafe = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const resolveLibraryPath = (libraryPath = "") => {
  const normalized = String(libraryPath || "").trim();
  if (!normalized) return "";
  return path.isAbsolute(normalized) ? normalized : path.resolve(PIPELINE_ROOT, normalized);
};

const resolveIndexPath = (libraryPath = "") => {
  const resolvedLibraryPath = resolveLibraryPath(libraryPath);
  return resolvedLibraryPath ? path.join(resolvedLibraryPath, "index.json") : "";
};

const tokenizeKeywords = (keywords = []) => {
  const rawValues = Array.isArray(keywords) ? keywords : [keywords];
  return [...new Set(rawValues
    .flatMap((value) => normalizeTokenSafe(value).split(/[^a-z0-9]+/))
    .map((value) => value.trim())
    .filter((value) => value.length >= 2))];
};

const resolveTagFilePath = (assetPath = "") => {
  const extension = path.extname(assetPath || "");
  return extension ? assetPath.slice(0, -extension.length) + ".tags.txt" : `${assetPath}.tags.txt`;
};

const collectLibraryFiles = async (rootPath = "") => {
  if (!rootPath || !(await fs.pathExists(rootPath))) return [];

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      return collectLibraryFiles(fullPath);
    }
    if (!entry.isFile()) return [];
    const extension = path.extname(entry.name || "").toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) return [];
    return [fullPath];
  }));

  return nested.flat();
};

const readTagsForAsset = async (assetPath = "") => {
  const tagFilePath = resolveTagFilePath(assetPath);
  if (!(await fs.pathExists(tagFilePath))) return [];
  const raw = await fs.readFile(tagFilePath, "utf8").catch(() => "");
  return [...new Set(String(raw || "")
    .split(/[\n,]/)
    .map((value) => normalizeTokenSafe(value))
    .filter(Boolean))];
};

const buildLocalLibraryIndex = async (libraryPath = "") => {
  const resolvedLibraryPath = resolveLibraryPath(libraryPath);
  if (!resolvedLibraryPath || !(await fs.pathExists(resolvedLibraryPath))) {
    return {
      libraryPath: resolvedLibraryPath,
      indexPath: resolveIndexPath(resolvedLibraryPath),
      assets: [],
    };
  }

  const assetFiles = await collectLibraryFiles(resolvedLibraryPath);
  const assets = [];

  for (const assetPath of assetFiles) {
    const mediaInfo = await probeMedia(assetPath).catch(() => ({ width: 0, height: 0, duration: 0 }));
    const tags = await readTagsForAsset(assetPath);
    const extension = path.extname(assetPath || "").toLowerCase();
    assets.push({
      asset_id: path.basename(assetPath),
      path: assetPath,
      relative_path: path.relative(resolvedLibraryPath, assetPath),
      duration: Number(mediaInfo.duration || 0),
      width: Number(mediaInfo.width || 0),
      height: Number(mediaInfo.height || 0),
      type: [".jpg", ".jpeg", ".png", ".webp"].includes(extension) ? "image" : "video",
      tags,
      title: path.basename(assetPath, extension),
    });
  }

  const payload = {
    generated_at: new Date().toISOString(),
    libraryPath: resolvedLibraryPath,
    assets,
  };
  const indexPath = resolveIndexPath(resolvedLibraryPath);
  await fs.ensureDir(resolvedLibraryPath);
  await fs.writeJson(indexPath, payload, { spaces: 2 });
  logger.info(`[LOCAL_LIB] Indexados ${assets.length} clips em ${resolvedLibraryPath}`);
  return {
    ...payload,
    indexPath,
  };
};

const searchLocalLibrary = async (keywords, libraryPath = "") => {
  const resolvedLibraryPath = resolveLibraryPath(libraryPath);
  const indexPath = resolveIndexPath(resolvedLibraryPath);
  if (!indexPath || !(await fs.pathExists(indexPath))) return [];

  const payload = await fs.readJson(indexPath).catch(() => null);
  const assets = Array.isArray(payload) ? payload : Array.isArray(payload?.assets) ? payload.assets : [];
  const terms = tokenizeKeywords(keywords);
  if (!terms.length) return [];

  return assets
    .map((asset) => {
      const tags = Array.isArray(asset.tags) ? asset.tags.map((tag) => normalizeTokenSafe(tag)) : [];
      const score = terms.reduce((acc, term) => acc + (tags.some((tag) => tag.includes(term) || term.includes(tag)) ? 1 : 0), 0);
      return {
        path: path.isAbsolute(asset.path || "") ? asset.path : path.join(resolvedLibraryPath, asset.relative_path || asset.path || ""),
        duration: Number(asset.duration || asset.duration_seconds || 0),
        width: Number(asset.width || asset.resolution?.width || 0),
        height: Number(asset.height || asset.resolution?.height || 0),
        tags,
        score,
        type: asset.type || "video",
        title: asset.title || path.basename(asset.path || asset.relative_path || ""),
      };
    })
    .filter((asset) => asset.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
};

module.exports = {
  buildLocalLibraryIndex,
  searchLocalLibrary,
  __test__: {
    resolveLibraryPath,
    resolveIndexPath,
    resolveTagFilePath,
    tokenizeKeywords,
  },
};