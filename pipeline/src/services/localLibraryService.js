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
        try { meta = await fs.readJson(metaPath); } catch { /* meta malformado: segue sem */ }
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
  // Filtro hard de país: clip de país diferente nunca entra
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
      provider: "local_library",
      location: {
        city: entry.location.city,
        country: entry.location.country,
        confidence: entry.location.city || entry.location.country ? 0.9 : 0,
      },
    }));
};

const invalidateLibraryIndex = () => {
  libraryIndex = null;
  libraryIndexPath = null;
};

// ===== Auto-indexação com visão LLM (Gemini Flash / OpenAI) =====

/**
 * Varre a biblioteca, detecta arquivos sem .meta.json e gera os sidecars via
 * análise visual. Campos manuais existentes têm precedência sobre o gerado.
 */
const autoIndexLibrary = async ({ force = false, dryRun = false, onProgress = null } = {}) => {
  const { analyzeMediaCached, isVisionEnabled } = require("./mediaVisionService");

  const libraryPath = resolveLibraryPath();
  if (!libraryPath) {
    return { analyzed: 0, skipped: 0, failed: 0, error: "LOCAL_ASSET_LIBRARY_PATH não configurado" };
  }
  if (!(await fs.pathExists(libraryPath))) {
    return { analyzed: 0, skipped: 0, failed: 0, error: `Pasta não encontrada: ${libraryPath}` };
  }
  if (!isVisionEnabled()) {
    return { analyzed: 0, skipped: 0, failed: 0, error: "Nenhum provider de visão configurado (GEMINI_API_KEY ou OPENAI_API_KEY)" };
  }

  const mediaFiles = [];
  const walkDir = async (dirPath) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) { await walkDir(fullPath); continue; }
      if (entry.name.endsWith(".meta.json")) continue;
      if (getAssetType(entry.name)) mediaFiles.push(fullPath);
    }
  };
  await walkDir(libraryPath);

  const toAnalyze = [];
  for (const filePath of mediaFiles) {
    const metaPath = filePath.replace(/\.[^.]+$/, ".meta.json");
    if (!force && (await fs.pathExists(metaPath))) continue;
    toAnalyze.push(filePath);
  }

  logger.info("localLibraryService: auto-indexação iniciada", {
    total: mediaFiles.length,
    toAnalyze: toAnalyze.length,
    dryRun,
    force,
  });

  if (dryRun) {
    return {
      analyzed: 0,
      skipped: mediaFiles.length - toAnalyze.length,
      failed: 0,
      dryRun: true,
      wouldAnalyze: toAnalyze,
    };
  }

  let analyzed = 0;
  let failed = 0;
  const skipped = mediaFiles.length - toAnalyze.length;

  for (let i = 0; i < toAnalyze.length; i++) {
    const filePath = toAnalyze[i];
    if (onProgress) onProgress(i + 1, toAnalyze.length, filePath);

    const visionResult = await analyzeMediaCached({
      filePath,
      windowBlueprints: [
        { window_index: 1, start_seconds: 0, end_seconds: 4, sample_time_seconds: 1 },
        { window_index: 2, start_seconds: 4, end_seconds: 8, sample_time_seconds: 5 },
        { window_index: 3, start_seconds: 8, end_seconds: 12, sample_time_seconds: 9 },
      ],
    }).catch(() => null);

    if (!visionResult) {
      logger.warn("localLibraryService: análise retornou vazio", { filePath });
      failed++;
      continue;
    }

    const firstWindowWithLocation = (visionResult.windows || []).find((window) => window.location?.city || window.location?.country);
    const metaPath = filePath.replace(/\.[^.]+$/, ".meta.json");

    try {
      let existing = {};
      if (await fs.pathExists(metaPath)) {
        try { existing = await fs.readJson(metaPath); } catch { /* re-gera */ }
      }

      const merged = {
        description: existing.description || visionResult.overall_summary || "",
        tags: existing.tags?.length ? existing.tags : (visionResult.overall_tags || []),
        location: {
          city: existing.location?.city || firstWindowWithLocation?.location?.city || "",
          country: existing.location?.country || firstWindowWithLocation?.location?.country || "",
        },
        analyzed_by: visionResult.provider,
        analyzed_at: visionResult.analyzed_at,
      };

      await fs.writeJson(metaPath, merged, { spaces: 2 });
      analyzed++;
    } catch (writeError) {
      logger.warn("localLibraryService: falha ao gravar .meta.json", { metaPath, message: writeError.message });
      failed++;
    }
  }

  invalidateLibraryIndex();
  logger.info("localLibraryService: auto-indexação concluída", { analyzed, skipped, failed });
  return { analyzed, skipped, failed };
};

module.exports = {
  searchLocalLibrary,
  buildLibraryIndex,
  getLibraryIndex,
  invalidateLibraryIndex,
  autoIndexLibrary,
};
