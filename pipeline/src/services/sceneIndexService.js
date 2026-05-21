const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { config } = require("../config/env");
const { extractAndRegister } = require("./clipLibraryService");

const round3 = (value) => Number(Number(value || 0).toFixed(3));
const unique = (values = []) => [...new Set((values || []).filter(Boolean))];

let db = null;

const ensureDb = () => {
  if (db) return db;
  fs.ensureDirSync(path.dirname(config.SCENE_INDEX_DB_PATH));
  db = new DatabaseSync(config.SCENE_INDEX_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS scene_index_entries (
      index_id TEXT PRIMARY KEY,
      index_signature TEXT UNIQUE NOT NULL,
      policy_version TEXT NOT NULL,
      video_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      scene_id TEXT NOT NULL,
      scene_index INTEGER DEFAULT 0,
      block_id TEXT DEFAULT '',
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      duration_sec REAL NOT NULL,
      description TEXT DEFAULT '',
      entities_json TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      location_json TEXT NOT NULL,
      shot_type TEXT DEFAULT '',
      visual_quality_json TEXT NOT NULL,
      speech_presence INTEGER DEFAULT 0,
      onscreen_text TEXT DEFAULT '',
      usage_intent TEXT DEFAULT '',
      usage_constraints_json TEXT NOT NULL,
      confidence REAL DEFAULT 0,
      tags_json TEXT NOT NULL,
      source_video_path TEXT NOT NULL,
      clip_id TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scene_index_asset ON scene_index_entries(asset_id);
    CREATE INDEX IF NOT EXISTS idx_scene_index_scene ON scene_index_entries(scene_index, confidence);
    CREATE INDEX IF NOT EXISTS idx_scene_index_clip ON scene_index_entries(clip_id);
  `);
  return db;
};

const closeSceneIndexDb = () => {
  if (!db) return;
  try {
    db.close();
  } catch {
    // noop
  } finally {
    db = null;
  }
};

const buildIndexSignature = ({
  assetId = "",
  sceneId = "",
  startSec = 0,
  endSec = 0,
  policyVersion = "v1",
}) => [assetId, sceneId, round3(startSec), round3(endSec), policyVersion].join("|");

const buildIndexId = (signature = "") =>
  `idx_${crypto.createHash("sha1").update(String(signature || "")).digest("hex").slice(0, 16)}`;

const getSceneId = ({ scene = {}, window = {}, fallbackIndex = 1 }) =>
  String(
    window.scene_id
    || scene.scene_id
    || scene.id
    || `scene_${Number(scene.scene_index || fallbackIndex)}`
  );

const indexAsset = async ({
  videoId = "",
  asset = {},
  scene = {},
  windows = [],
  policyVersion = config.CLIP_LIBRARY_POLICY_VERSION || "v1",
  generatePhysicalClips = true,
}) => {
  if (!config.USE_SCENE_INDEX && !config.USE_CLIP_LIBRARY) {
    return { indexed_entries: [], generated_clip_ids: [] };
  }

  const sourceVideoPath = String(asset.local_path || "");
  const assetId = String(asset.asset_id || asset.source_url || sourceVideoPath);
  if (!sourceVideoPath || !assetId) {
    return { indexed_entries: [], generated_clip_ids: [] };
  }

  const conn = ensureDb();
  const now = new Date().toISOString();
  const indexedEntries = [];

  for (let index = 0; index < (windows || []).length; index += 1) {
    const window = windows[index] || {};
    const startSec = round3(Math.max(0, Number(window.start_seconds ?? window.start_sec ?? 0)));
    const endSec = round3(Math.max(startSec + 0.2, Number(window.end_seconds ?? window.end_sec ?? startSec + 0.2)));
    const durationSec = round3(Math.max(0.2, endSec - startSec));
    const sceneId = getSceneId({ scene, window, fallbackIndex: index + 1 });
    const signature = buildIndexSignature({
      assetId,
      sceneId,
      startSec,
      endSec,
      policyVersion,
    });
    const indexId = buildIndexId(signature);
    const existing = conn.prepare("SELECT index_id FROM scene_index_entries WHERE index_signature = ?").get(signature);

    const payload = {
      index_id: indexId,
      index_signature: signature,
      policy_version: String(policyVersion || "v1"),
      video_id: String(videoId || ""),
      asset_id: assetId,
      scene_id: sceneId,
      scene_index: Number(window.scene_index || scene.scene_index || 0),
      block_id: String(window.block_id || scene.block_id || ""),
      start_sec: startSec,
      end_sec: endSec,
      duration_sec: durationSec,
      description: String(window.summary || window.description || ""),
      entities_json: JSON.stringify(unique([
        ...(window.detected_objects || []),
        ...((window.landmarks || []).map((entry) => entry?.name || entry).filter(Boolean)),
      ])),
      actions_json: JSON.stringify(unique(window.action_tokens_detected || [])),
      location_json: JSON.stringify(window.location || {}),
      shot_type: String(window.visual_features?.shot_type || window.shot_type || ""),
      visual_quality_json: JSON.stringify(window.quality || {}),
      speech_presence: window.speech_presence === true ? 1 : 0,
      onscreen_text: String(window.overlay_text || window.text || ""),
      usage_intent: String(window.scene_visual_intent || window.visual_intent || scene.visual_intent || ""),
      usage_constraints_json: JSON.stringify({
        required_visual_evidence: scene.required_visual_evidence || [],
        forbidden_visual_categories: scene.forbidden_visual_categories || [],
      }),
      confidence: Number(window.editorial_confidence || window.confidence || 0),
      tags_json: JSON.stringify(unique([
        ...(window.tags || []),
        ...(window.detected_visual_categories || []),
      ])),
      source_video_path: sourceVideoPath,
      clip_id: "",
      created_at: now,
      updated_at: now,
    };

    if (existing?.index_id) {
      conn.prepare(`
        UPDATE scene_index_entries
        SET updated_at = ?, confidence = ?, description = ?, tags_json = ?, entities_json = ?, actions_json = ?,
            location_json = ?, shot_type = ?, visual_quality_json = ?, usage_intent = ?, usage_constraints_json = ?
        WHERE index_signature = ?
      `).run(
        now,
        payload.confidence,
        payload.description,
        payload.tags_json,
        payload.entities_json,
        payload.actions_json,
        payload.location_json,
        payload.shot_type,
        payload.visual_quality_json,
        payload.usage_intent,
        payload.usage_constraints_json,
        signature
      );
      indexedEntries.push({ ...payload, index_id: existing.index_id });
      continue;
    }

    conn.prepare(`
      INSERT INTO scene_index_entries (
        index_id, index_signature, policy_version, video_id, asset_id, scene_id, scene_index, block_id,
        start_sec, end_sec, duration_sec, description, entities_json, actions_json, location_json,
        shot_type, visual_quality_json, speech_presence, onscreen_text, usage_intent, usage_constraints_json,
        confidence, tags_json, source_video_path, clip_id, created_at, updated_at
      ) VALUES (
        @index_id, @index_signature, @policy_version, @video_id, @asset_id, @scene_id, @scene_index, @block_id,
        @start_sec, @end_sec, @duration_sec, @description, @entities_json, @actions_json, @location_json,
        @shot_type, @visual_quality_json, @speech_presence, @onscreen_text, @usage_intent, @usage_constraints_json,
        @confidence, @tags_json, @source_video_path, @clip_id, @created_at, @updated_at
      )
    `).run(payload);
    indexedEntries.push(payload);
  }

  let generatedClipIds = [];
  if (generatePhysicalClips && config.USE_CLIP_LIBRARY) {
    const clips = await extractAndRegister({
      videoId,
      sceneIndex: Number(scene.scene_index || 0),
      blockId: String(scene.block_id || ""),
      asset,
      windows: windows.map((window) => ({
        ...window,
        scene_visual_intent: window.scene_visual_intent || scene.visual_intent || "",
      })),
      initialStatus: "raw_cut",
      policyVersion,
      approvalContext: {
        source: "scene_index_service",
        stage: "raw_cut",
      },
    });
    generatedClipIds = unique(clips.map((clip) => clip.clip_id));

    if (generatedClipIds.length) {
      indexedEntries.forEach((entry) => {
        const matchedClip = clips.find((clip) =>
          String(clip.asset_id || "") === String(entry.asset_id || "")
          && Math.abs(Number(clip.source_start_sec || 0) - Number(entry.start_sec || 0)) <= 0.05
          && Math.abs(Number(clip.source_end_sec || 0) - Number(entry.end_sec || 0)) <= 0.05
        );
        const clipId = matchedClip?.clip_id || "";
        if (!clipId) return;
        conn.prepare(`
          UPDATE scene_index_entries
          SET clip_id = ?, updated_at = ?
          WHERE index_signature = ?
        `).run(String(clipId || ""), now, entry.index_signature);
      });
    }
  }

  return {
    indexed_entries: indexedEntries,
    generated_clip_ids: generatedClipIds,
  };
};

module.exports = {
  indexAsset,
  closeSceneIndexDb,
  __test__: {
    buildIndexSignature,
    buildIndexId,
  },
};
