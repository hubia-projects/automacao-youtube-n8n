const crypto = require("crypto");
const path = require("path");
const fs = require("fs-extra");
const { DatabaseSync } = require("node:sqlite");
const { config } = require("../config/env");
const { runFfmpeg, probeMedia } = require("../utils/mediaUtils");

const round3 = (value) => Number(Number(value || 0).toFixed(3));
const unique = (values = []) => [...new Set((values || []).filter(Boolean))];

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
    approval_context: safeJsonParse(row.approval_context_json, {}),
    usage_count: Number(row.usage_count || 0),
    last_used_at: row.last_used_at || "",
    history: safeJsonParse(row.history_json, []),
    metadata: safeJsonParse(row.metadata_json, {}),
  };
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

const extractClipFile = async ({
  inputPath = "",
  outputPath = "",
  sourceStartSec = 0,
  sourceEndSec = 0,
}) => {
  const start = Math.max(0, Number(sourceStartSec || 0));
  const end = Math.max(start + 0.2, Number(sourceEndSec || 0));
  const duration = round3(Math.max(0.2, end - start));
  await fs.ensureDir(path.dirname(outputPath));

  await runFfmpeg([
    "-y",
    "-ss",
    String(round3(start)),
    "-i",
    inputPath,
    "-t",
    String(duration),
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
  ]);
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

  const normalizedStart = round3(Math.max(0, Number(sourceStartSec || 0)));
  const normalizedEnd = round3(Math.max(normalizedStart + 0.2, Number(sourceEndSec || 0)));
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
    const nextHistory = appendHistory(existing.history, {
      event: "reused_existing_clip",
      scene_index: sceneIndex,
      block_id: blockId,
    });
    conn.prepare(`
      UPDATE clips
      SET updated_at = ?, history_json = ?
      WHERE clip_id = ?
    `).run(now, JSON.stringify(nextHistory), existing.clip_id);
    return { ...existing, history: nextHistory };
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
    const sourceStartSec = Number(window.start_seconds ?? window.start_sec ?? 0);
    const sourceEndSec = Number(window.end_seconds ?? window.end_sec ?? sourceStartSec + 0.2);
    const clip = await registerClip({
      videoId,
      sceneIndex: Number(window.scene_index || sceneIndex || 0),
      blockId: String(window.block_id || blockId || ""),
      asset,
      sourceStartSec,
      sourceEndSec,
      tagsSemanticas: unique([
        ...(window.tags || []),
        ...(window.detected_visual_categories || []),
      ]),
      entities: unique([
        ...(window.detected_objects || []),
        ...((window.landmarks || []).map((entry) => entry?.name || entry).filter(Boolean)),
      ]),
      location: window.location || {},
      shotType: window.visual_features?.shot_type || window.shot_type || "",
      confidence: Number(window.editorial_confidence || window.confidence || 0),
      visualIntent: window.scene_visual_intent || window.visual_intent || "",
      approvalContext,
      initialStatus,
      policyVersion,
      metadata: {
        approved_window_id: window.approved_window_id || window.id || "",
        scene_function: window.scene_function || "",
        visual_truth_status: window.visual_truth_status || "",
      },
    });
    if (clip) generatedClips.push(clip);
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
  const clips = rows.map(mapRowToClip);
  if (!semanticQuery) return clips;

  return clips
    .map((clip) => {
      const haystack = [
        clip.visual_intent,
        ...(clip.tags_semanticas || []),
        ...(clip.entities || []),
        clip.shot_type,
      ].join(" ");
      return {
        ...clip,
        _semantic_score: keywordOverlapScore(semanticQuery, haystack),
      };
    })
    .sort((left, right) =>
      Number(right._semantic_score || 0) - Number(left._semantic_score || 0)
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
  __test__: {
    buildClipSignature,
    buildClipId,
    keywordOverlapScore,
    mapRowToClip,
  },
};

