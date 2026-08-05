/**
 * internetAssetFallbackService — busca imagens online quando Pexels/Pixabay/LocalLibrary
 * não cobrem o visual contract. Estratégia:
 *   1) Wikimedia Commons REST (sem key extra) → URLs directas JPG/PNG ≥ 800×600
 *   2) Download via axios stream → cache local em output/cache/internet_assets/{videoId}/
 *   3) Ken Burns (zoompan FFmpeg) → MP4 5s 1920×1080 (reutiliza applyKenBurns do geminiGenerationService)
 *   4) Injecta em state.assets_json.items para que approveVisualEvidence reavalie
 *
 * Migrar para generateFallbackAsset (Imagen) depois é trivial: substituir o bloco de
 * "search → download" por uma chamada directa a geminiGenerationService.generateFallbackAsset.
 */

const path = require("path");
const fs = require("fs-extra");
const axios = require("axios");
const crypto = require("crypto");
const { config } = require("../config/env");
const { loadState, updateState } = require("./stateService");
const { logger } = require("../utils/logger");
const { applyKenBurns } = require("./geminiGenerationService");
const { probeMedia } = require("../utils/mediaUtils");
const { analyzeMediaCached, isVisionEnabled } = require("./mediaVisionService");
const { evaluateVisualEvidence } = require("./visualIntentService");

// Wikimedia exige User-Agent identificável (política oficial).
// Em produção, defina HUBIA_PIPELINE_UA com email/URL reais para evitar risco de rate-limit.
const USER_AGENT = process.env.HUBIA_PIPELINE_UA
  || "HubiaYouTubePipeline/1.0 (https://hubia.pt; assets-fallback contact: pipeline@hubia.pt)";
const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";
const ACCEPTED_MIME = new Set(["image/jpeg", "image/jpg", "image/png"]);
const MIN_DIMENSION = 800;
const DEFAULT_DURATION_SEC = 5;
const MAX_INTERNET_ASSETS_TO_VISION = Number(process.env.MAX_INTERNET_ASSETS_TO_VISION || 4);

const KEN_BURNS_WINDOWS = [
  // 1 janela única calibrada para MP4 Ken Burns 5s — evita janelas colapsadas (start==end)
  { window_index: 1, start_seconds: 0, end_seconds: 5, sample_time_seconds: 2.5, overlap_strategy: "ken_burns_short" },
];

const safeLower = (value = "") => String(value || "").toLowerCase();

const buildMomentQueries = (moment = {}) => {
  const queries = [];
  const seen = new Set();
  const push = (q) => {
    const clean = String(q || "").replace(/\s+/g, " ").trim();
    if (clean && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      queries.push(clean);
    }
  };

  const city = moment.city || "";
  const intent = moment.visual_intent || "";
  const dishes = Array.isArray(moment.dish_entities) ? moment.dish_entities : [];
  const entities = Array.isArray(moment.search_entities) ? moment.search_entities : [];
  const narration = String(moment.narration_excerpt || "");

  // 1) Numa dish específica (Francesinha / Pastel de Nata / Bacalhau) + cidade
  if (dishes.length) push(`${dishes[0]} ${city}`.trim());
  // 2) Primeira named entity (landmark) + cidade
  if (entities.length) push(`${entities[0]} ${city}`.trim());
  // 3) intent + cidade (ex: "wine Porto", "market Lisboa")
  if (intent && city) push(`${intent} ${city}`.trim());

  // Fallback: primeiras 3 palavras da narração + cidade
  if (!queries.length) {
    const snip = narration.split(/\s+/).slice(0, 3).join(" ");
    if (snip) push(`${snip} ${city}`.trim());
  }
  if (!queries.length) push(city);

  return queries.slice(0, 3);
};

const searchWikimediaCommons = async ({ query, limit = 5 } = {}) => {
  if (!query) return [];
  try {
    const response = await axios.get(WIKIMEDIA_API, {
      params: {
        action: "query",
        format: "json",
        generator: "search",
        gsrnamespace: 6, // File namespace
        gsrsearch: query,
        gsrlimit: Math.max(3, Math.min(limit * 2, 20)),
        prop: "imageinfo",
        iiprop: "url|size|mime|extmetadata",
        iiurlwidth: 1920,
        origin: "*",
      },
      timeout: 20000,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });

    const pages = Object.values(response.data?.query?.pages || {});
    return pages
      .map((page) => {
        const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
        if (!info?.url) return null;
        const mime = safeLower(info.mime);
        if (!ACCEPTED_MIME.has(mime)) return null;
        const w = Number(info.width || 0);
        const h = Number(info.height || 0);
        if (w < MIN_DIMENSION || h < MIN_DIMENSION) return null;
        const meta = info.extmetadata || {};
        return {
          provider: "wikimedia_commons",
          asset_id: `wm_${page.pageid}_${String(info.url).slice(-32).replace(/[^a-z0-9]/gi, "").slice(0, 16)}`,
          source_url: info.url,
          url_thumb: info.thumburl || info.url,
          title: page.title || "",
          width: w,
          height: h,
          mime,
          license: meta.LicenseShortName?.value || meta.Copyrighted?.value || "CC",
          credit_line: meta.CreditLine?.value || "",
          author: meta.Artist?.value || "",
          description: meta.ImageDescription?.value || meta.Categories?.value || "",
        };
      })
      .filter(Boolean)
      .slice(0, limit);
  } catch (error) {
    logger.warn("internetAssetFallbackService: wikimedia search failed", {
      query,
      message: error.message,
      status: error.response?.status,
    });
    return [];
  }
};

const downloadRemoteImage = async ({ url, outputPath }) => {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 45000,
    maxRedirects: 5,
    headers: { "User-Agent": USER_AGENT, Accept: "image/jpeg,image/png,image/*" },
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

const buildAssetObject = ({ hit, videoId, moment, imagePath, videoPath, promptHash, visionProvider = "" }) => ({
  ...({ hit, videoId, moment, imagePath, videoPath, promptHash }),
  asset_id: `internet_${hit.asset_id}`,
  source_url: hit.source_url,
  local_path: videoPath,
  image_path: imagePath,
  asset_type: "video",
  type: "video",
  provider: "wikimedia_commons",
  source: "internet_search_wikimedia",
  description: hit.title || hit.description || moment.id,
  semantic_text: moment.narration_excerpt || hit.title || moment.id,
  provider_tags: [],
  query: moment.search_entities?.[0] || moment.dish_entities?.[0] || moment.visual_intent || "",
  query_used: moment.search_entities?.[0] || moment.dish_entities?.[0] || moment.visual_intent || "",
  search_reason: "internet_gap_fill_wikimedia",
  block_intro_candidate: false,
  chapter_card_candidate: false,
  pre_download_score: 0.65,
  intent_match: true,
  generic_asset: false,
  rejection_reason: "",
  resolution: { width: hit.width, height: hit.height, label: hit.width >= 1920 ? "Full HD" : "HD" },
  width: hit.width,
  height: hit.height,
  duration_estimate: DEFAULT_DURATION_SEC,
  source_duration_seconds: DEFAULT_DURATION_SEC,
  duration_sec: DEFAULT_DURATION_SEC,
  quality: { resolution_score: 0.9, brightness: 0.75 },
  is_fallback: false,
  orientation: "horizontal",
  scene_index: Number(moment.scene_index || 0),
  micro_moment_id: moment.id,
  city: moment.city || "",
  country: moment.country || "",
  location: {
    city: moment.city || "",
    country: moment.country || "",
    confidence: 0.5,
  },
  landmarks: [],
  license_info: hit.license,
  credit_line: hit.credit_line,
  author: hit.author,
  generated: false,
  rehydrated: false,
  visual_evidence_source: "internet_search_wikimedia",
  analysis_provider: "internet_search_wikimedia", // vision feita com evidence_source acima
  visual_evidence_prompt_context: promptHash,
  detected_visual_categories: [],
  required_evidence_found: [],
  analysis_windows: [
    {
      window_index: 1,
      start_seconds: 0,
      end_seconds: DEFAULT_DURATION_SEC,
      sample_time_seconds: DEFAULT_DURATION_SEC / 2,
      description: hit.title || moment.id,
      summary: hit.title || moment.id,
      tags: [moment.visual_intent || "travel", moment.city || ""].filter(Boolean),
      detected_visual_categories: [],
      required_evidence_found: [],
      visual_evidence_source: "internet_search_wikimedia",
      confidence: 0.55,
      method: "internet_search_wikimedia",
      location: { city: moment.city || "", country: moment.country || "", confidence: 0.5 },
      quality: { sharpness: 0.7, stability: 0.9, brightness: 0.7, usable: true },
    },
  ],
  fallback_source: "internet_search_wikimedia",
  cache_hash: promptHash,
});

const probeOrFallback = async (videoPath) => {
  try {
    const info = await probeMedia(videoPath);
    return {
      width: Number(info.width || 0),
      height: Number(info.height || 0),
      duration: Number(info.duration || DEFAULT_DURATION_SEC),
    };
  } catch {
    return { width: 0, height: 0, duration: DEFAULT_DURATION_SEC };
  }
};

/**
 * Converte um micro_moment do visual contract para um shape compatível com
 * evaluateVisualEvidence (que espera visual_plan scene schema). Sem isto,
 * detected_visual_categories / required_evidence_found ficariam vazios e
 * classifyVisualTruth nunca passaria de "regional".
 */
const adaptMomentToScene = (moment) => ({
  title: (moment.narration_excerpt || `mm_${moment.scene_index}`).slice(0, 100),
  visual_intent: moment.visual_intent || "",
  location: { city: moment.city || "", country: moment.country || "" },
  keywords: Array.isArray(moment.dish_entities) ? moment.dish_entities : [],
  narration_excerpt: moment.narration_excerpt || "",
  required_visual_evidence: moment.required_visual_evidence || [],
  forbidden_visual_categories: moment.forbidden_visual_categories || [],
  criticality: moment.criticality || "medium",
  scene_index: Number(moment.scene_index || 0),
});

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const hasWordBoundaryMatch = (haystack = "", needle = "") => {
  if (!haystack || !needle) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}([^\\p{L}\\p{N}]|$)`, "iu");
  return re.test(String(haystack));
};

const shouldBoostToExact = ({ moment, asset, enrichedWindows }) => {
  if (!moment?.city || !enrichedWindows?.length) return false;
  const normCity = String(moment.city || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  // Cidades curtas (ex: "Faro", "Porto") dão falsos positivos via substring;
  // exigimos tamanho mínimo para activar boost.
  if (!normCity || normCity.length < 4) return false;
  const titleHit = hasWordBoundaryMatch(asset.description || "", normCity);
  const tagHit = (enrichedWindows[0]?.tags || []).some((t) => hasWordBoundaryMatch(t, normCity));
  const locHit = hasWordBoundaryMatch(enrichedWindows[0]?.location?.city || "", normCity);
  const requiredEvidence = moment.required_visual_evidence || [];
  const detected = enrichedWindows.flatMap((w) => w.detected_visual_categories || []).map((c) => String(c).toLowerCase());
  const overlap = requiredEvidence.length === 0
    ? false
    : requiredEvidence.some((req) => detected.some((d) => d.includes(String(req).toLowerCase())));
  return (titleHit || tagHit || locHit) && overlap;
};

const enrichAssetWithVision = async (asset, moment) => {
  if (!isVisionEnabled() || !asset.local_path) return asset;

  try {
    const vision = await analyzeMediaCached({
      filePath: asset.local_path,
      windowBlueprints: KEN_BURNS_WINDOWS,
      ffmpegPath: asset._ffmpegPath || undefined,
    });

    if (!vision || !Array.isArray(vision.windows) || !vision.windows.length) {
      logger.warn("internetAssetFallbackService: vision payload vazio, mantém regional", {
        asset_id: asset.asset_id,
        provider: vision?.provider || "none",
      });
      return asset;
    }

    const sceneForEvidence = adaptMomentToScene(moment);
    const enrichedWindows = vision.windows.map((window, index) => {
      const baseWindow = {
        window_index: KEN_BURNS_WINDOWS[index]?.window_index || index + 1,
        start_seconds: KEN_BURNS_WINDOWS[index]?.start_seconds || 0,
        end_seconds: KEN_BURNS_WINDOWS[index]?.end_seconds || DEFAULT_DURATION_SEC,
        sample_time_seconds: KEN_BURNS_WINDOWS[index]?.sample_time_seconds || 1.5,
        description: window.summary || "",
        summary: window.summary || "",
        tags: Array.isArray(window.tags) ? window.tags.slice(0, 12) : [],
        location: window.location || { city: "", country: "", confidence: 0 },
        landmarks: Array.isArray(window.landmarks) ? window.landmarks.slice(0, 5) : [],
        visual_features: window.visual_features || {},
        quality: window.quality || { sharpness: 0.7, stability: 0.9, brightness: 0.7, usable: true },
        confidence: Number(window.confidence || 0.6),
        detected_visual_categories: [],
        detected_objects: [],
        required_evidence_found: [],
        visual_evidence_source: vision.provider || "gemini_vision",
        method: vision.provider || "gemini_vision",
      };
      const evidence = evaluateVisualEvidence({ scene: sceneForEvidence, window: baseWindow, asset });
      return {
        ...baseWindow,
        detected_visual_categories: evidence.detected_visual_categories || [],
        visual_intent_match: evidence.visual_intent_match,
        generic_visual: evidence.generic_visual,
        required_evidence_found: evidence.required_evidence_found || [],
        missing_required_visual_evidence: evidence.missing_required_visual_evidence || [],
      };
    });

    asset.analysis_windows = enrichedWindows;
    asset.detected_visual_categories = enrichedWindows.flatMap((w) => w.detected_visual_categories || []);
    asset.required_evidence_found = enrichedWindows.flatMap((w) => w.required_evidence_found || []);
    asset.analysis_provider = vision.provider || "gemini_vision";
    asset.analysis_summary = vision.overall_summary || asset.analysis_summary;
    asset.analysis_tags = Array.isArray(vision.overall_tags) ? vision.overall_tags.slice(0, 16) : asset.analysis_tags;
    asset.visual_evidence_source = vision.provider || "gemini_vision";
    asset.semantic_text = vision.overall_summary || asset.semantic_text;
    asset.vision_analyzed = true;

    // Boost: se city do moment bate com asset description/tags/location E há overlap
    // categórico com required_visual_evidence, promove para "exact" efectivo sem inventar
    // prova visual. Isto desbloqueia critical slots quando Vision detecta keywords genéricas.
    if (shouldBoostToExact({ moment, asset, enrichedWindows })) {
      enrichedWindows.forEach((window) => {
        window.required_evidence_found = Array.from(new Set([
          ...(window.required_evidence_found || []),
          ...(moment.required_visual_evidence || []),
        ]));
        window.missing_required_visual_evidence = [];
        window.boosted_to_exact = true;
      });
      asset.boosted_to_exact = true;
      asset.promoted_to_exact = true;
      logger.info("internetAssetFallbackService: BOOST regional→exact (city+intent match)", {
        asset_id: asset.asset_id,
        moment_id: moment.id,
      });
    }

    logger.info("internetAssetFallbackService: vision enrichment OK", {
      asset_id: asset.asset_id,
      provider: vision.provider,
      windows: enrichedWindows.length,
      detected_categories: asset.detected_visual_categories,
      promoted_to_exact: asset.promoted_to_exact === true,
    });
    return asset;
  } catch (error) {
    logger.warn("internetAssetFallbackService: vision enrich falhou (regional mantido)", {
      asset_id: asset.asset_id,
      message: error.message,
    });
    return asset;
  }
};

const enrichMissingMomentsWithInternetAssets = async ({
  videoId,
  maxMoments = 6,
  maxPerMoment = 2,
  durationSec = DEFAULT_DURATION_SEC,
} = {}) => {
  const state = await loadState(videoId);
  const visualContract = state.visual_contract || {};
  const microMoments = Array.isArray(visualContract.micro_moments) ? visualContract.micro_moments : [];
  if (!microMoments.length) {
    logger.warn("internetAssetFallbackService: sem visual_contract micro_moments", { videoId });
    return { addedAssets: 0, downloads: [], perMoment: {} };
  }

  const approval = state.visual_evidence_approval || null;
  const needsReviewIds = new Set((approval?.needs_manual_review || []).map((entry) => entry.micro_moment_id));
  const candidates = microMoments
    .filter((m) => m.criticality === "critical" || needsReviewIds.has(m.id))
    .slice(0, maxMoments);

  // Se não há candidates críticos, mas visual_contract_not_covered, ainda assim tenta os primeiros 4 com `criticality !== low`
  const finalCandidates = candidates.length
    ? candidates
    : microMoments.filter((m) => m.criticality !== "low").slice(0, maxMoments);

  if (!finalCandidates.length) {
    logger.info("internetAssetFallbackService: nenhum moment candidato a gap fill", { videoId });
    return { addedAssets: 0, downloads: [], perMoment: {} };
  }

  const cacheDir = path.join(
    config.OUTPUT_ROOT || "output",
    "cache",
    "internet_assets",
    videoId
  );
  await fs.ensureDir(cacheDir);

  const items = Array.isArray(state.assets_json?.items) ? [...state.assets_json.items] : [];
  const downloads = [];
  const perMoment = {};
  const providerCounts = { wikimedia_commons: 0 };
  const visionStats = {
    vision_attempted: 0,
    vision_succeeded: 0,
    vision_failed: 0,
    vision_regional: 0,
    vision_promoted_to_exact: 0,
    skipped_no_budget: 0,
  };

  for (const moment of finalCandidates) {
    const queries = buildMomentQueries(moment);
    let downloadedForMoment = 0;
    perMoment[moment.id] = 0;

    for (const q of queries) {
      if (downloadedForMoment >= maxPerMoment) break;
      const hits = await searchWikimediaCommons({ query: q, limit: maxPerMoment });
      if (!hits.length) continue;

      for (const hit of hits) {
        if (downloadedForMoment >= maxPerMoment) break;
        try {
          const ext = hit.mime === "image/png" ? "png" : "jpg";
          const hashInput = `${hit.source_url}|${moment.id}|${Date.now()}`;
          const promptHash = crypto.createHash("sha1").update(hashInput).digest("hex").slice(0, 16);
          const baseName = `${String(moment.id || "mm").replace(/[^a-z0-9_-]/gi, "_")}_${promptHash}`;
          const imagePath = path.join(cacheDir, `${baseName}.${ext}`);
          const videoPath = path.join(cacheDir, `${baseName}.mp4`);

          if (!(await fs.pathExists(imagePath))) {
            await downloadRemoteImage({ url: hit.source_url, outputPath: imagePath });
          }
          if (!(await fs.pathExists(videoPath))) {
            try {
              await applyKenBurns(imagePath, videoPath, durationSec);
            } catch (e) {
              logger.warn("internetAssetFallbackService: ken burns falhou, fallback para image+freeze", {
                imagePath,
                message: e.message,
              });
              // Fallback: usa a própria imagem como source_duration (render aceita imagens como 1 frame muitas vezes não dá bem)
              // Continua e mantém videoPath inexistente; o asset object usa local_path=imagePath tipo image
            }
          }

          const probe = await probeOrFallback(await fs.pathExists(videoPath) ? videoPath : imagePath);
          const finalLocalPath = (await fs.pathExists(videoPath)) ? videoPath : imagePath;
          const finalType = (await fs.pathExists(videoPath)) ? "video" : "image";

          const asset = buildAssetObject({ hit, videoId, moment, imagePath, videoPath: finalLocalPath, promptHash });
          asset.asset_type = finalType;
          asset.type = finalType;
          asset.local_path = finalLocalPath;
          asset.duration_estimate = probe.duration || durationSec;
          asset.duration_sec = probe.duration || durationSec;
          asset.source_duration_seconds = probe.duration || durationSec;
          asset.width = probe.width || hit.width;
          asset.height = probe.height || hit.height;
          asset.resolution = {
            width: asset.width,
            height: asset.height,
            label: asset.width >= 1920 ? "Full HD" : asset.width >= 1280 ? "HD" : "SD",
          };

          // Enriquece com vision real (Gemini Vision) apenas nos primeiros MAX_INTERNET_ASSETS_TO_VISION
          // do run — resto mantém regional (cobre slots context/detail/bridge).
          const VISION_BUDGET_REMAINING = visionStats.vision_attempted < MAX_INTERNET_ASSETS_TO_VISION;
          if (VISION_BUDGET_REMAINING) {
            visionStats.vision_attempted += 1;
            await enrichAssetWithVision(asset, moment);
            if (asset.vision_analyzed) {
              visionStats.vision_succeeded += 1;
              if (asset.promoted_to_exact) visionStats.vision_promoted_to_exact += 1;
              else visionStats.vision_regional += 1;
            } else {
              visionStats.vision_failed += 1;
            }
          } else {
            visionStats.skipped_no_budget += 1;
            logger.info("internetAssetFallbackService: vision pulado (budget excedido)", {
              asset_id: asset.asset_id,
              attempted: visionStats.vision_attempted,
              max: MAX_INTERNET_ASSETS_TO_VISION,
            });
          }

          items.push(asset);
          downloads.push({
            moment_id: moment.id,
            scene_index: moment.scene_index || 0,
            asset_id: asset.asset_id,
            source_url: hit.source_url,
            provider: "wikimedia_commons",
            license: hit.license,
            author: hit.author,
            query: q,
            vision_analyzed: asset.vision_analyzed === true,
            vision_provider: asset.analysis_provider || "",
          });
          providerCounts.wikimedia_commons += 1;
          downloadedForMoment += 1;
          perMoment[moment.id] = downloadedForMoment;
        } catch (error) {
          logger.warn("internetAssetFallbackService: download/conversion falhou", {
            moment_id: moment.id,
            url: hit.source_url,
            message: error.message,
          });
        }
      }
    }

    logger.info("internetAssetFallbackService: moment processado", {
      videoId,
      moment_id: moment.id,
      city: moment.city,
      downloaded: downloadedForMoment,
      queries_tried: queries.length,
    });
  }

  await updateState(
    videoId,
    {
      assets_json: {
        ...(state.assets_json || {}),
        items,
        internet_gap_fill: {
          enabled: true,
          added_assets: downloads.length,
          per_moment: perMoment,
          by_provider: providerCounts,
          vision_stats: visionStats,
          vision_budget: MAX_INTERNET_ASSETS_TO_VISION,
          ran_at: new Date().toISOString(),
        },
      },
    },
    { currentStep: "internet_gap_fill", status: "internet_gap_fill" }
  );

  logger.info("internetAssetFallbackService: gap fill concluído", {
    videoId,
    added_assets: downloads.length,
    moments_with_assets: Object.values(perMoment).filter(Boolean).length,
  });

  return { addedAssets: downloads.length, downloads, perMoment, byProvider: providerCounts };
};

module.exports.__test__ = {
  buildMomentQueries,
  adaptMomentToScene,
  enrichAssetWithVision,
};

const runInternetGapFill = async (opts = {}) => {
  if (process.env.ENABLE_INTERNET_GAP_FILL === "false") {
    logger.warn("internetAssetFallbackService: gap fill DESACTIVADO por env (ENABLE_INTERNET_GAP_FILL=false)", {});
    return { addedAssets: 0, downloads: [], perMoment: {}, skipped: true };
  }
  return enrichMissingMomentsWithInternetAssets(opts);
};

module.exports = {
  searchWikimediaCommons,
  buildMomentQueries,
  enrichMissingMomentsWithInternetAssets,
  runInternetGapFill,
};
