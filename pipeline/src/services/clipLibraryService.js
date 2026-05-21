const crypto = require("crypto");
const path = require("path");
const fs = require("fs-extra");
const { DatabaseSync } = require("node:sqlite");
const { config } = require("../config/env");
const { runFfmpeg, probeMedia } = require("../utils/mediaUtils");

const round3 = (value) => Number(Number(value || 0).toFixed(3));
const unique = (values = []) => [...new Set((values || []).filter(Boolean))];
const MIN_CLIP_SECONDS = 0.8;
const sourceDurationCache = new Map();

const getMicroClipDurations = () =>
  unique(
    String(config.CLIP_LIBRARY_TARGET_DURATIONS || "3,5,15")
      .split(",")
      .map((item) => Number(String(item || "").trim()))
      .filter((value) => Number.isFinite(value) && value >= 1.5)
      .map((value) => round3(value))
  ).sort((left, right) => left - right);

const safeJsonParse = (raw, fallback) => {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const clipPathSafe = (value = "") =>
  String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 120);

const normalizeLabel = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const tokenize = (value = "") =>
  normalizeLabel(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 3);

const keywordOverlapScore = (leftText = "", rightText = "") => {
  const left = unique(tokenize(leftText));
  const right = unique(tokenize(rightText));
  if (!left.length || !right.length) return 0;
  const intersection = left.filter((token) => right.includes(token)).length;
  const union = unique([...left, ...right]).length;
  return union > 0 ? intersection / union : 0;
};

const normalizeInlineText = (value = "") =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const truncateText = (value = "", maxLength = 220) => {
  const normalized = normalizeInlineText(value);
  if (!normalized || normalized.length <= maxLength) return normalized;
  const clipped = normalized.slice(0, maxLength);
  const punctuationIndex = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("; "), clipped.lastIndexOf(", "));
  const safe = punctuationIndex >= 80 ? clipped.slice(0, punctuationIndex) : clipped;
  return `${safe.trim()}...`;
};

const pickSemanticName = ({ landmarks = [], location = {}, visualIntent = "", shotType = "" } = {}) => {
  const landmarkNames = (landmarks || []).map((entry) => entry?.name || entry).filter(Boolean);
  if (landmarkNames.length) return normalizeInlineText(landmarkNames[0]);
  if (location?.city && visualIntent) {
    return normalizeInlineText(`${location.city} ${String(visualIntent || "").replace(/_/g, " ")}`);
  }
  if (location?.city) return normalizeInlineText(location.city);
  if (visualIntent && shotType) return normalizeInlineText(`${String(visualIntent || "").replace(/_/g, " ")} ${shotType}`);
  return normalizeInlineText(String(visualIntent || "").replace(/_/g, " ") || shotType || "travel scene");
};

const pickSemanticPhrase = ({ summary = "", semanticName = "", tags = [], entities = [], shotType = "" } = {}) => {
  const normalizedSummary = normalizeInlineText(summary);
  if (normalizedSummary) {
    const words = normalizedSummary.split(" ").slice(0, 12).join(" ");
    return truncateText(words, 96);
  }
  return truncateText(
    [semanticName, shotType, ...(tags || []).slice(0, 2), ...(entities || []).slice(0, 1)].filter(Boolean).join(" "),
    96
  );
};

const buildClipSemanticMetadata = ({
  microWindow = {},
  asset = {},
  tagsSemanticas = [],
  entities = [],
  location = {},
  shotType = "",
  visualIntent = "",
} = {}) => {
  const baseSummary = truncateText(
    microWindow.summary
      || microWindow.description
      || asset.analysis_summary
      || asset.semantic_text
      || "",
    220
  );
  const semanticName = pickSemanticName({
    landmarks: microWindow.landmarks || [],
    location,
    visualIntent,
    shotType,
  });
  const semanticPhrase = pickSemanticPhrase({
    summary: baseSummary,
    semanticName,
    tags: tagsSemanticas,
    entities,
    shotType,
  });
  const semanticSummary = baseSummary || truncateText(
    [semanticName, String(visualIntent || "").replace(/_/g, " "), ...(tagsSemanticas || []).slice(0, 3), ...(entities || []).slice(0, 2)].filter(Boolean).join(" "),
    220
  );
  const semanticText = normalizeInlineText(
    [semanticPhrase, semanticSummary, semanticName, visualIntent, ...(tagsSemanticas || []), ...(entities || [])].filter(Boolean).join(" ")
  );

  return {
    semantic_name: semanticName,
    semantic_phrase: semanticPhrase,
    semantic_summary: semanticSummary,
    semantic_text: semanticText,
    semantic_source: normalizeInlineText(microWindow.analysis_provider || asset.analysis_provider || microWindow.visual_evidence_source || "window_context"),
  };
};

const mergeClipMetadata = (existingMetadata = {}, nextMetadata = {}) => {
  const merged = { ...(existingMetadata || {}) };
  Object.entries(nextMetadata || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string" && !String(value).trim()) return;
    if (Array.isArray(value) && !value.length) return;
    if (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) return;
    merged[key] = value;
  });
  return merged;
};

let db = null;

const ensureDb = () => {
  if (db) return db;
  fs.ensureDirSync(path.dirname(config.CLIP_LIBRARY_DB_PATH));
  db = new DatabaseSync(config.CLIP_LIBRARY_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS clips (
      clip_id TEXT PRIMARY KEY,
      clip_signature TEXT UNIQUE NOT NULL,
      policy_version TEXT NOT NULL,
      video_id TEXT NOT NULL,
      scene_index INTEGER DEFAULT 0,
      block_id TEXT DEFAULT '',
      asset_id TEXT NOT NULL,
      source_video_path TEXT NOT NULL,
      source_start_sec REAL NOT NULL,
      source_end_sec REAL NOT NULL,
      duration_sec REAL NOT NULL,
      clip_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      tags_semanticas_json TEXT NOT NULL,
      entities_json TEXT NOT NULL,
      location_json TEXT NOT NULL,
      shot_type TEXT DEFAULT '',
      confidence REAL DEFAULT 0,
      visual_intent TEXT DEFAULT '',
      approval_context_json TEXT NOT NULL,
      usage_count INTEGER DEFAULT 0,
      last_used_at TEXT DEFAULT '',
      history_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clips_video_status ON clips(video_id, status);
    CREATE INDEX IF NOT EXISTS idx_clips_scene_status ON clips(scene_index, status);
    CREATE INDEX IF NOT EXISTS idx_clips_asset ON clips(asset_id);
  `);
  return db;
};

const closeClipLibraryDb = () => {
  if (!db) return;
  try {
    db.close();
  } catch {
    // noop
  } finally {
    db = null;
  }
};

const buildClipSignature = ({
  assetId = "",
  sourceVideoPath = "",
  sourceStartSec = 0,
  sourceEndSec = 0,
  policyVersion = "v1",
}) =>
  [
    String(assetId || ""),
    String(sourceVideoPath || ""),
    round3(sourceStartSec),
    round3(sourceEndSec),
    String(policyVersion || "v1"),
  ].join("|");

const buildClipId = (signature = "") =>
  `clip_${crypto.createHash("sha1").update(String(signature || "")).digest("hex").slice(0, 16)}`;

const getClipOutputPath = ({ videoId = "", assetId = "", clipId = "" }) => {
  const safeVideoId = clipPathSafe(videoId || "unknown_video");
  const safeAssetId = clipPathSafe(assetId || "unknown_asset");
  return path.join(config.CLIP_LIBRARY_ROOT_DIR, safeVideoId, safeAssetId, `${clipId}.mp4`);
};

const mapRowToClip = (row) => {
  if (!row) return null;
  const metadata = safeJsonParse(row.metadata_json, {});
  const semanticSummary = metadata.semantic_summary || metadata.summary || metadata.description || "";
  const semanticPhrase = metadata.semantic_phrase || "";
  const semanticName = metadata.semantic_name || "";
  const semanticText = normalizeInlineText(
    metadata.semantic_text
      || [semanticPhrase, semanticSummary, semanticName, row.visual_intent || "", ...safeJsonParse(row.tags_semanticas_json, []), ...safeJsonParse(row.entities_json, [])].join(" ")
  );
  return {
    clip_id: row.clip_id,
    clip_signature: row.clip_signature,
    policy_version: row.policy_version,
    video_id: row.video_id,
    scene_index: Number(row.scene_index || 0),
    block_id: row.block_id || "",
    asset_id: row.asset_id,
    source_video_path: row.source_video_path,
    source_start_sec: Number(row.source_start_sec || 0),
    source_end_sec: Number(row.source_end_sec || 0),
    duration_sec: Number(row.duration_sec || 0),
    clip_path: row.clip_path,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status,
    tags_semanticas: safeJsonParse(row.tags_semanticas_json, []),
    entities: safeJsonParse(row.entities_json, []),
    location: safeJsonParse(row.location_json, {}),
    shot_type: row.shot_type || "",
    confidence: Number(row.confidence || 0),
    visual_intent: row.visual_intent || "",
    semantic_name: semanticName,
    semantic_phrase: semanticPhrase,
    semantic_summary: semanticSummary,
    semantic_text: semanticText,
    approval_context: safeJsonParse(row.approval_context_json, {}),
    usage_count: Number(row.usage_count || 0),
    last_used_at: row.last_used_at || "",
    history: safeJsonParse(row.history_json, []),
    metadata,
  };
};

const expandWindowToMicroclips = (window = {}) => {
  const start = round3(Math.max(0, Number(window.start_seconds ?? window.start_sec ?? 0)));
  const end = round3(Math.max(start + MIN_CLIP_SECONDS, Number(window.end_seconds ?? window.end_sec ?? start + MIN_CLIP_SECONDS)));
  const windowDuration = round3(Math.max(MIN_CLIP_SECONDS, end - start));
  const maxSegmentsPerWindow = Math.max(1, Number(config.CLIP_LIBRARY_MAX_MICROCLIPS_PER_WINDOW || 8));
  const targetDurations = getMicroClipDurations();

  const candidates = [{
    ...window,
    start_seconds: start,
    end_seconds: end,
    duration_seconds: windowDuration,
    clip_variant: "full_window",
    clip_variant_rank: 0,
  }];

  for (const durationTarget of targetDurations) {
    if (windowDuration <= durationTarget + 0.35) continue;
    const segmentCount = Math.max(2, Math.floor(windowDuration / durationTarget));
    const segmentStride = windowDuration / segmentCount;

    for (let index = 0; index < segmentCount; index += 1) {
      const segmentStart = round3(start + (index * segmentStride));
      const segmentEnd = round3(Math.min(end, segmentStart + durationTarget));
      if (segmentEnd - segmentStart < MIN_CLIP_SECONDS) continue;
      candidates.push({
        ...window,
        start_seconds: segmentStart,
        end_seconds: segmentEnd,
        duration_seconds: round3(segmentEnd - segmentStart),
        clip_variant: `${durationTarget}s_slice`,
        clip_variant_rank: targetDurations.indexOf(durationTarget) + 1,
      });
      if (candidates.length >= maxSegmentsPerWindow) break;
    }
    if (candidates.length >= maxSegmentsPerWindow) break;
  }

  const deduped = [];
  const signatures = new Set();
  for (const entry of candidates) {
    const signature = `${round3(entry.start_seconds)}:${round3(entry.end_seconds)}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    deduped.push(entry);
    if (deduped.length >= maxSegmentsPerWindow) break;
  }
  return deduped;
};

const getClipById = async ({ clipId = "" }) => {
  const conn = ensureDb();
  const stmt = conn.prepare("SELECT * FROM clips WHERE clip_id = ?");
  return mapRowToClip(stmt.get(String(clipId || "")));
};

const appendHistory = (history = [], entry = {}) =>
  [
    ...(Array.isArray(history) ? history : []).slice(-39),
    {
      at: new Date().toISOString(),
      ...entry,
    },
  ];

const getSourceDurationSeconds = async (inputPath = "") => {
  const key = String(inputPath || "");
  if (!key) return 0;
  if (sourceDurationCache.has(key)) return Number(sourceDurationCache.get(key) || 0);
  const mediaInfo = await probeMedia(key).catch(() => ({ duration: 0 }));
  const duration = Number(mediaInfo?.duration || 0);
  sourceDurationCache.set(key, duration);
  return duration;
};

const clampClipBounds = async ({ inputPath = "", sourceStartSec = 0, sourceEndSec = 0 }) => {
  const rawStart = Math.max(0, Number(sourceStartSec || 0));
  const rawEnd = Math.max(rawStart + 0.2, Number(sourceEndSec || 0));
  const duration = await getSourceDurationSeconds(inputPath);

  if (!Number.isFinite(duration) || duration <= 0) {
    return {
      start: round3(rawStart),
      end: round3(rawEnd),
      duration: round3(Math.max(0.2, rawEnd - rawStart)),
    };
  }

  const usableTail = Math.max(0.25, duration - 0.05);
  const safeStart = Math.min(rawStart, Math.max(0, usableTail - 0.2));
  const safeEnd = Math.min(rawEnd, usableTail);
  const safeDuration = Math.max(0.2, safeEnd - safeStart);
  return {
    start: round3(safeStart),
    end: round3(safeStart + safeDuration),
    duration: round3(safeDuration),
  };
};

const extractClipFile = async ({
  inputPath = "",
  outputPath = "",
  sourceStartSec = 0,
  sourceEndSec = 0,
}) => {
  const bounds = await clampClipBounds({
    inputPath,
    sourceStartSec,
    sourceEndSec,
  });
  const start = bounds.start;
  const end = bounds.end;
  const duration = bounds.duration;
  await fs.ensureDir(path.dirname(outputPath));

  const commonArgs = [
    "-vf",
    `scale=${config.OUTPUT_WIDTH}:${config.OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${config.OUTPUT_WIDTH}:${config.OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    "-r",
    String(config.OUTPUT_FPS || 30),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-b:v",
    String(config.VIDEO_BITRATE || "6M"),
    "-maxrate",
    String(config.MAX_VIDEO_BITRATE || "8M"),
    "-pix_fmt",
    "yuv420p",
    "-an",
    outputPath,
  ];

  try {
    await runFfmpeg([
      "-y",
      "-ss",
      String(round3(start)),
      "-i",
      inputPath,
      "-t",
      String(duration),
      ...commonArgs,
    ]);
  } catch {
    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-ss",
      String(round3(start)),
      "-to",
      String(round3(end)),
      ...commonArgs,
    ]);
  }
};

const registerClip = async ({
  videoId = "",
  sceneIndex = 0,
  blockId = "",
  asset = {},
  sourceStartSec = 0,
  sourceEndSec = 0,
  tagsSemanticas = [],
  entities = [],
  location = {},
  shotType = "",
  confidence = 0,
  visualIntent = "",
  approvalContext = {},
  initialStatus = "raw_cut",
  policyVersion = config.CLIP_LIBRARY_POLICY_VERSION || "v1",
  metadata = {},
}) => {
  const sourceVideoPath = String(asset.local_path || "");
  if (!sourceVideoPath || !(await fs.pathExists(sourceVideoPath))) return null;

  const bounds = await clampClipBounds({
    inputPath: sourceVideoPath,
    sourceStartSec,
    sourceEndSec,
  });
  const normalizedStart = bounds.start;
  const normalizedEnd = bounds.end;
  const signature = buildClipSignature({
    assetId: asset.asset_id || asset.source_url || sourceVideoPath,
    sourceVideoPath,
    sourceStartSec: normalizedStart,
    sourceEndSec: normalizedEnd,
    policyVersion,
  });
  const clipId = buildClipId(signature);
  const outputPath = getClipOutputPath({
    videoId,
    assetId: asset.asset_id || asset.source_url || sourceVideoPath,
    clipId,
  });

  const conn = ensureDb();
  const existingRow = conn.prepare("SELECT * FROM clips WHERE clip_signature = ?").get(signature);
  const now = new Date().toISOString();

  if (existingRow) {
    const existing = mapRowToClip(existingRow);
    if (!(await fs.pathExists(existing.clip_path))) {
      await extractClipFile({
        inputPath: sourceVideoPath,
        outputPath: existing.clip_path,
        sourceStartSec: existing.source_start_sec,
        sourceEndSec: existing.source_end_sec,
      });
    }
    const nextMetadata = mergeClipMetadata(existing.metadata, metadata);
    const nextHistory = appendHistory(existing.history, {
      event: "reused_existing_clip",
      scene_index: sceneIndex,
      block_id: blockId,
    });
    conn.prepare(`
      UPDATE clips
      SET updated_at = ?, history_json = ?, metadata_json = ?
      WHERE clip_id = ?
    `).run(now, JSON.stringify(nextHistory), JSON.stringify(nextMetadata), existing.clip_id);
    return { ...existing, metadata: nextMetadata, history: nextHistory };
  }

  await extractClipFile({
    inputPath: sourceVideoPath,
    outputPath,
    sourceStartSec: normalizedStart,
    sourceEndSec: normalizedEnd,
  });
  const mediaInfo = await probeMedia(outputPath).catch(() => ({ duration: normalizedEnd - normalizedStart }));
  const durationSec = round3(mediaInfo.duration || (normalizedEnd - normalizedStart));
  const history = appendHistory([], {
    event: "created",
    scene_index: sceneIndex,
    block_id: blockId,
    status: initialStatus,
  });

  const insert = conn.prepare(`
    INSERT INTO clips (
      clip_id, clip_signature, policy_version, video_id, scene_index, block_id, asset_id,
      source_video_path, source_start_sec, source_end_sec, duration_sec, clip_path,
      created_at, updated_at, status, tags_semanticas_json, entities_json, location_json,
      shot_type, confidence, visual_intent, approval_context_json, usage_count, last_used_at,
      history_json, metadata_json
    ) VALUES (
      @clip_id, @clip_signature, @policy_version, @video_id, @scene_index, @block_id, @asset_id,
      @source_video_path, @source_start_sec, @source_end_sec, @duration_sec, @clip_path,
      @created_at, @updated_at, @status, @tags_semanticas_json, @entities_json, @location_json,
      @shot_type, @confidence, @visual_intent, @approval_context_json, @usage_count, @last_used_at,
      @history_json, @metadata_json
    )
  `);

  insert.run({
    clip_id: clipId,
    clip_signature: signature,
    policy_version: String(policyVersion || "v1"),
    video_id: String(videoId || ""),
    scene_index: Number(sceneIndex || 0),
    block_id: String(blockId || ""),
    asset_id: String(asset.asset_id || asset.source_url || sourceVideoPath),
    source_video_path: sourceVideoPath,
    source_start_sec: normalizedStart,
    source_end_sec: normalizedEnd,
    duration_sec: durationSec,
    clip_path: outputPath,
    created_at: now,
    updated_at: now,
    status: String(initialStatus || "raw_cut"),
    tags_semanticas_json: JSON.stringify(unique(tagsSemanticas || [])),
    entities_json: JSON.stringify(unique(entities || [])),
    location_json: JSON.stringify(location || {}),
    shot_type: String(shotType || ""),
    confidence: Number(confidence || 0),
    visual_intent: String(visualIntent || ""),
    approval_context_json: JSON.stringify(approvalContext || {}),
    usage_count: 0,
    last_used_at: "",
    history_json: JSON.stringify(history),
    metadata_json: JSON.stringify(metadata || {}),
  });

  return getClipById({ clipId });
};

const extractAndRegister = async ({
  videoId = "",
  sceneIndex = 0,
  blockId = "",
  asset = {},
  windows = [],
  initialStatus = "raw_cut",
  policyVersion = config.CLIP_LIBRARY_POLICY_VERSION || "v1",
  approvalContext = {},
}) => {
  const generatedClips = [];
  for (const window of windows || []) {
    const microclipWindows = expandWindowToMicroclips(window);
    for (const microWindow of microclipWindows) {
      const sourceStartSec = Number(microWindow.start_seconds ?? microWindow.start_sec ?? 0);
      const sourceEndSec = Number(microWindow.end_seconds ?? microWindow.end_sec ?? sourceStartSec + MIN_CLIP_SECONDS);
      const semanticMetadata = buildClipSemanticMetadata({
        microWindow,
        asset,
        tagsSemanticas: unique([
          ...(microWindow.tags || []),
          ...(microWindow.detected_visual_categories || []),
          String(microWindow.clip_variant || ""),
        ]),
        entities: unique([
          ...(microWindow.detected_objects || []),
          ...((microWindow.landmarks || []).map((entry) => entry?.name || entry).filter(Boolean)),
        ]),
        location: microWindow.location || {},
        shotType: microWindow.visual_features?.shot_type || microWindow.shot_type || "",
        visualIntent: microWindow.scene_visual_intent || microWindow.visual_intent || "",
      });
      const clip = await registerClip({
        videoId,
        sceneIndex: Number(microWindow.scene_index || sceneIndex || 0),
        blockId: String(microWindow.block_id || blockId || ""),
        asset,
        sourceStartSec,
        sourceEndSec,
        tagsSemanticas: unique([
          ...(microWindow.tags || []),
          ...(microWindow.detected_visual_categories || []),
          String(microWindow.clip_variant || ""),
        ]),
        entities: unique([
          ...(microWindow.detected_objects || []),
          ...((microWindow.landmarks || []).map((entry) => entry?.name || entry).filter(Boolean)),
        ]),
        location: microWindow.location || {},
        shotType: microWindow.visual_features?.shot_type || microWindow.shot_type || "",
        confidence: Number(microWindow.editorial_confidence || microWindow.confidence || 0),
        visualIntent: microWindow.scene_visual_intent || microWindow.visual_intent || "",
        approvalContext,
        initialStatus,
        policyVersion,
        metadata: {
          approved_window_id: microWindow.approved_window_id || microWindow.id || "",
          scene_function: microWindow.scene_function || "",
          visual_truth_status: microWindow.visual_truth_status || "",
          clip_variant: microWindow.clip_variant || "full_window",
          clip_variant_rank: Number(microWindow.clip_variant_rank || 0),
          parent_window_start_sec: Number(window.start_seconds ?? window.start_sec ?? 0),
          parent_window_end_sec: Number(window.end_seconds ?? window.end_sec ?? 0),
          parent_window_summary: truncateText(window.summary || window.description || "", 220),
          parent_window_description: truncateText(window.description || window.summary || "", 220),
          ...semanticMetadata,
        },
      });
      if (clip) generatedClips.push(clip);
    }
  }
  return generatedClips;
};

const updateClipStatus = async ({
  clipId = "",
  status = "approved",
  approvalContext = {},
  confidence,
}) => {
  const conn = ensureDb();
  const row = conn.prepare("SELECT * FROM clips WHERE clip_id = ?").get(String(clipId || ""));
  if (!row) return null;
  const current = mapRowToClip(row);
  const nextConfidence = confidence === undefined ? current.confidence : Number(confidence || 0);
  const nextHistory = appendHistory(current.history, {
    event: "status_change",
    from: current.status,
    to: status,
    approval_context: approvalContext || {},
  });
  const now = new Date().toISOString();
  conn.prepare(`
    UPDATE clips
    SET status = ?, updated_at = ?, confidence = ?, approval_context_json = ?, history_json = ?
    WHERE clip_id = ?
  `).run(
    String(status || "approved"),
    now,
    nextConfidence,
    JSON.stringify({ ...(current.approval_context || {}), ...(approvalContext || {}) }),
    JSON.stringify(nextHistory),
    String(clipId || "")
  );
  return getClipById({ clipId });
};

const bulkUpdateStatusByAssetAndWindow = async ({
  assetId = "",
  sourceStartSec = 0,
  sourceEndSec = 0,
  status = "approved",
  approvalContext = {},
  policyVersion = config.CLIP_LIBRARY_POLICY_VERSION || "v1",
  sourceVideoPath = "",
}) => {
  const signature = buildClipSignature({
    assetId,
    sourceVideoPath,
    sourceStartSec,
    sourceEndSec,
    policyVersion,
  });
  const conn = ensureDb();
  const row = conn.prepare("SELECT clip_id FROM clips WHERE clip_signature = ?").get(signature);
  if (!row?.clip_id) return null;
  return updateClipStatus({
    clipId: row.clip_id,
    status,
    approvalContext,
  });
};

const searchApprovedClips = async ({
  sceneIndex = 0,
  blockId = "",
  visualIntent = "",
  keywords = [],
  expectedLocation = "",
  strictLocation = false,
  limit = config.CLIP_LIBRARY_MAX_SEARCH_RESULTS || 24,
}) => {
  const conn = ensureDb();
  const max = Math.max(1, Math.min(100, Number(limit || 24)));
  let rows = [];
  if (Number(sceneIndex || 0) > 0) {
    rows = conn.prepare(`
      SELECT * FROM clips
      WHERE status = 'approved' AND scene_index = ?
      ORDER BY confidence DESC, usage_count ASC, updated_at DESC
      LIMIT ?
    `).all(Number(sceneIndex || 0), max);
  }

  if (!rows.length && String(blockId || "").trim()) {
    rows = conn.prepare(`
      SELECT * FROM clips
      WHERE status = 'approved' AND block_id = ?
      ORDER BY confidence DESC, usage_count ASC, updated_at DESC
      LIMIT ?
    `).all(String(blockId || "").trim(), max);
  }

  if (!rows.length) {
    rows = conn.prepare(`
      SELECT * FROM clips
      WHERE status = 'approved'
      ORDER BY confidence DESC, usage_count ASC, updated_at DESC
      LIMIT ?
    `).all(max);
  }

  const semanticQuery = [visualIntent, ...(keywords || [])].join(" ").trim();
  const normalizedExpectedLocation = normalizeLabel(expectedLocation);
  const clips = rows
    .map(mapRowToClip)
    .filter((clip) => {
      if (!normalizedExpectedLocation) return true;
      const locationCity = normalizeLabel(clip?.location?.city || "");
      const semanticHaystack = normalizeLabel([
        clip?.semantic_text || "",
        clip?.semantic_summary || "",
        clip?.semantic_phrase || "",
        clip?.semantic_name || "",
        ...(clip?.tags_semanticas || []),
        ...(clip?.entities || []),
      ].join(" "));
      const locationMatch = locationCity === normalizedExpectedLocation;
      const semanticMatch = semanticHaystack.includes(normalizedExpectedLocation);
      if (strictLocation) return Boolean(locationMatch || semanticMatch);
      return true;
    });

  if (!semanticQuery && !normalizedExpectedLocation) return clips;

  return clips
    .map((clip) => {
      const haystack = [
        clip.semantic_text,
        clip.semantic_summary,
        clip.semantic_phrase,
        clip.visual_intent,
        ...(clip.tags_semanticas || []),
        ...(clip.entities || []),
        clip.shot_type,
      ].join(" ");
      const semanticHaystack = normalizeLabel(haystack);
      const locationCity = normalizeLabel(clip?.location?.city || "");
      const locationBoost = normalizedExpectedLocation
        && (locationCity === normalizedExpectedLocation || semanticHaystack.includes(normalizedExpectedLocation))
        ? 0.25
        : 0;
      return {
        ...clip,
        _semantic_score: keywordOverlapScore(semanticQuery, haystack),
        _location_boost: locationBoost,
      };
    })
    .sort((left, right) =>
      Number(right._location_boost || 0) - Number(left._location_boost || 0)
      || Number(right._semantic_score || 0) - Number(left._semantic_score || 0)
      || Number(right.confidence || 0) - Number(left.confidence || 0)
      || Number(left.usage_count || 0) - Number(right.usage_count || 0)
    );
};

const markClipUsed = async ({ clipId = "" }) => {
  const current = await getClipById({ clipId });
  if (!current) return null;
  const now = new Date().toISOString();
  const nextHistory = appendHistory(current.history, {
    event: "used_in_timeline",
  });
  const conn = ensureDb();
  conn.prepare(`
    UPDATE clips
    SET usage_count = ?, last_used_at = ?, updated_at = ?, history_json = ?
    WHERE clip_id = ?
  `).run(
    Number(current.usage_count || 0) + 1,
    now,
    now,
    JSON.stringify(nextHistory),
    String(clipId || "")
  );
  return getClipById({ clipId });
};

const summarizeClipLibrary = async ({ videoId = "" } = {}) => {
  const conn = ensureDb();
  const where = String(videoId || "").trim() ? "WHERE video_id = ?" : "";
  const params = String(videoId || "").trim() ? [String(videoId || "").trim()] : [];
  const total = conn.prepare(`SELECT COUNT(*) AS count FROM clips ${where}`).get(...params)?.count || 0;
  const approved = conn.prepare(`SELECT COUNT(*) AS count FROM clips ${where ? `${where} AND` : "WHERE"} status = 'approved'`).get(...params)?.count || 0;
  const used = conn.prepare(`SELECT COUNT(*) AS count FROM clips ${where ? `${where} AND` : "WHERE"} usage_count > 0`).get(...params)?.count || 0;
  const generatedClipIds = conn.prepare(`SELECT clip_id FROM clips ${where} ORDER BY created_at DESC LIMIT 200`).all(...params).map((row) => row.clip_id);
  const approvedClipIds = conn.prepare(`SELECT clip_id FROM clips ${where ? `${where} AND` : "WHERE"} status = 'approved' ORDER BY updated_at DESC LIMIT 200`).all(...params).map((row) => row.clip_id);

  return {
    clips_generated: Number(total || 0),
    clips_approved: Number(approved || 0),
    clip_reuse_ratio: Number(approved ? (Number(used || 0) / Number(approved || 1)) : 0),
    generated_clip_ids: generatedClipIds,
    approved_clip_ids: approvedClipIds,
    last_updated_at: new Date().toISOString(),
  };
};

module.exports = {
  extractAndRegister,
  searchApprovedClips,
  getClipById,
  updateClipStatus,
  bulkUpdateStatusByAssetAndWindow,
  markClipUsed,
  summarizeClipLibrary,
  closeClipLibraryDb,
  __test__: {
    buildClipSignature,
    buildClipId,
    buildClipSemanticMetadata,
    keywordOverlapScore,
    mapRowToClip,
  },
};
