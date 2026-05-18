const path = require("path");
const fs = require("fs-extra");
const { config } = require("../config/env");

const LIBRARY_DIR = path.join(config.OUTPUT_ROOT, "editorial");
const LIBRARY_PATH = path.join(LIBRARY_DIR, "asset-library.json");
const DEFAULT_COOLDOWN_HOURS = Number(config.EDITORIAL_LIBRARY_REUSE_COOLDOWN_HOURS || 12);

const unique = (values = []) => [...new Set((values || []).filter(Boolean))];
const round3 = (value) => Number(Number(value || 0).toFixed(3));
const nowIso = () => new Date().toISOString();
const nowMs = () => Date.now();

const readLibrary = async () => {
  await fs.ensureDir(LIBRARY_DIR);
  if (!(await fs.pathExists(LIBRARY_PATH))) {
    return { version: 1, updated_at: nowIso(), assets: [] };
  }
  const parsed = await fs.readJson(LIBRARY_PATH).catch(() => null);
  if (!parsed || typeof parsed !== "object") {
    return { version: 1, updated_at: nowIso(), assets: [] };
  }
  return {
    version: Number(parsed.version || 1),
    updated_at: parsed.updated_at || nowIso(),
    assets: Array.isArray(parsed.assets) ? parsed.assets : [],
  };
};

const writeLibrary = async (library = {}) => {
  await fs.ensureDir(LIBRARY_DIR);
  const payload = {
    version: Number(library.version || 1),
    updated_at: nowIso(),
    assets: Array.isArray(library.assets) ? library.assets : [],
  };
  await fs.writeJson(LIBRARY_PATH, payload, { spaces: 2 });
  return payload;
};

const buildVisualFamily = (contract = {}) => {
  const categories = contract.visual_observation?.detected_visual_categories || [];
  const landmarks = (contract.visual_observation?.landmarks || []).map((entry) => entry?.name || entry).filter(Boolean);
  const shotType = contract.visual_observation?.visual_features?.shot_type || "";
  return unique([shotType, ...categories, ...landmarks]).slice(0, 4).join("|");
};

const buildAssetRecord = ({ contract = {}, asset = {}, videoId = "" }) => {
  const usageCount = Number(asset.usage_count || 0);
  const locationCity = contract.window?.location?.city || contract.visual_observation?.location?.city || "";
  return {
    asset_id: contract.asset_id || asset.asset_id || asset.local_path || asset.source_url || "",
    source_url: asset.source_url || "",
    local_path: asset.local_path || "",
    source: asset.provider || contract.provider_metadata?.provider || "",
    source_tier: contract.source_tier || "free",
    slot_types_supported: unique([
      contract.content_slot_type,
      ...(contract.content_slots_supported || []),
    ]),
    narrative_roles_supported: unique(contract.narrative_roles_supported || []),
    visual_family: buildVisualFamily(contract),
    cities: unique([locationCity]),
    intents: unique([contract.scene_visual_intent, contract.scene_intent, contract.visual_intent].filter(Boolean)),
    editorial_status: contract.visual_truth_status || "regional",
    quality_score: round3(contract.editorial_confidence || 0),
    usage_count: usageCount,
    reuse_allowed: contract.visual_truth_status !== "wrong" && contract.visual_truth_status !== "uncertain",
    last_used_at: nowIso(),
    last_video_id: videoId || "",
  };
};

const mergeApprovedWindowsIntoLibrary = async ({
  approvedWindows = [],
  assets = [],
  videoId = "",
}) => {
  const library = await readLibrary();
  const assetsById = new Map();
  (assets || []).forEach((asset, index) => {
    const key = asset.asset_id || asset.local_path || asset.source_url || `asset_${index + 1}`;
    assetsById.set(key, asset);
  });

  const byAssetId = new Map((library.assets || []).map((entry) => [entry.asset_id, entry]));
  (approvedWindows || []).forEach((contract) => {
    if (!contract?.asset_id) return;
    if (contract.visual_truth_status === "wrong" || contract.visual_truth_status === "uncertain") return;

    const previous = byAssetId.get(contract.asset_id);
    const asset = assetsById.get(contract.asset_id) || {};
    const next = buildAssetRecord({ contract, asset, videoId });

    if (previous) {
      byAssetId.set(contract.asset_id, {
        ...previous,
        source: next.source || previous.source,
        source_tier: next.source_tier || previous.source_tier,
        slot_types_supported: unique([...(previous.slot_types_supported || []), ...(next.slot_types_supported || [])]),
        narrative_roles_supported: unique([...(previous.narrative_roles_supported || []), ...(next.narrative_roles_supported || [])]),
        visual_family: next.visual_family || previous.visual_family,
        cities: unique([...(previous.cities || []), ...(next.cities || [])]),
        intents: unique([...(previous.intents || []), ...(next.intents || [])]),
        editorial_status: next.editorial_status,
        quality_score: round3(Math.max(Number(previous.quality_score || 0), Number(next.quality_score || 0))),
        usage_count: Number(previous.usage_count || 0) + 1,
        reuse_allowed: previous.reuse_allowed !== false && next.reuse_allowed !== false,
        last_used_at: nowIso(),
        last_video_id: videoId || previous.last_video_id || "",
      });
    } else {
      byAssetId.set(contract.asset_id, {
        ...next,
        usage_count: 1,
      });
    }
  });

  library.assets = [...byAssetId.values()];
  return writeLibrary(library);
};

const computeReusePenalty = ({
  candidate = {},
  blockId = "",
  usedAssetIds = new Set(),
  cooldownHours = DEFAULT_COOLDOWN_HOURS,
}) => {
  if (!candidate?.asset_id) return 0;
  let penalty = 0;
  if (usedAssetIds.has(candidate.asset_id)) penalty += 1.5;
  const lastUsedAtMs = candidate.last_used_at ? new Date(candidate.last_used_at).getTime() : 0;
  const cooldownMs = Number(cooldownHours || DEFAULT_COOLDOWN_HOURS) * 3600 * 1000;
  if (lastUsedAtMs > 0 && nowMs() - lastUsedAtMs < cooldownMs) penalty += 0.8;
  if (blockId && Array.isArray(candidate.last_used_blocks) && candidate.last_used_blocks.includes(blockId)) penalty += 1.2;
  penalty += Math.min(1.2, Number(candidate.usage_count || 0) * 0.08);
  return round3(penalty);
};

const summarizeLibrarySnapshot = (library = {}, limit = 20) => {
  const assets = Array.isArray(library.assets) ? library.assets : [];
  const byTier = assets.reduce((acc, entry) => {
    const tier = String(entry.source_tier || "free").toLowerCase();
    acc[tier] = Number(acc[tier] || 0) + 1;
    return acc;
  }, {});
  return {
    total_assets: assets.length,
    by_tier: byTier,
    sample: assets
      .sort((a, b) => Number(b.quality_score || 0) - Number(a.quality_score || 0))
      .slice(0, limit)
      .map((entry) => ({
        asset_id: entry.asset_id,
        source: entry.source,
        source_tier: entry.source_tier,
        slot_types_supported: entry.slot_types_supported || [],
        visual_family: entry.visual_family || "",
        cities: entry.cities || [],
        intents: entry.intents || [],
        quality_score: Number(entry.quality_score || 0),
        usage_count: Number(entry.usage_count || 0),
        last_used_at: entry.last_used_at || "",
      })),
  };
};

const applyRetentionSignalsToLibrary = async ({
  observations = [],
  videoId = "",
} = {}) => {
  const library = await readLibrary();
  const byAssetId = new Map((library.assets || []).map((entry) => [entry.asset_id, entry]));
  const grouped = new Map();
  (observations || []).forEach((obs) => {
    const assetId = String(obs.asset_id || "");
    if (!assetId) return;
    const bucket = grouped.get(assetId) || [];
    bucket.push(obs);
    grouped.set(assetId, bucket);
  });

  grouped.forEach((rows, assetId) => {
    const existing = byAssetId.get(assetId);
    if (!existing) return;
    const avgRetention = rows.reduce((acc, row) => acc + Number(row.retention_score || 0), 0) / Math.max(1, rows.length);
    const prevSamples = Number(existing.retention_samples || 0);
    const prevAvg = Number(existing.retention_score_avg || 0.5);
    const nextSamples = prevSamples + rows.length;
    const nextAvg = ((prevAvg * prevSamples) + rows.reduce((acc, row) => acc + Number(row.retention_score || 0), 0)) / Math.max(1, nextSamples);
    const slotPerf = { ...(existing.slot_performance || {}) };
    rows.forEach((row) => {
      const slotType = String(row.content_slot_type || row.slot_type || "").toLowerCase();
      if (!slotType) return;
      const current = slotPerf[slotType] || { avg: 0.5, samples: 0 };
      const nextSlotSamples = Number(current.samples || 0) + 1;
      slotPerf[slotType] = {
        avg: round3(((Number(current.avg || 0.5) * Number(current.samples || 0)) + Number(row.retention_score || 0)) / Math.max(1, nextSlotSamples)),
        samples: nextSlotSamples,
      };
    });

    byAssetId.set(assetId, {
      ...existing,
      retention_samples: nextSamples,
      retention_score_avg: round3(nextAvg),
      retention_last_video_id: videoId || existing.retention_last_video_id || "",
      retention_last_observed_at: nowIso(),
      slot_performance: slotPerf,
      quality_score: round3(Math.max(0, Math.min(1, Number(existing.quality_score || 0.5) * 0.75 + Number(avgRetention || 0.5) * 0.25))),
    });
  });

  library.assets = [...byAssetId.values()];
  return writeLibrary(library);
};

module.exports = {
  LIBRARY_PATH,
  computeReusePenalty,
  applyRetentionSignalsToLibrary,
  mergeApprovedWindowsIntoLibrary,
  readLibrary,
  summarizeLibrarySnapshot,
  __test__: {
    buildVisualFamily,
    computeReusePenalty,
  },
};
