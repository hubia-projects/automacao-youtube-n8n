const fs = require("fs-extra");
const path = require("path");
const { logger } = require("./logger");
const { ensureVideoStructure } = require("../services/stateService");
const { readJsonSafe } = require("./fileUtils");

const TEST_REPORT_GROUP_PATTERN = /^([a-zA-Z0-9_-]+)-(frames|visual-evidence|contact-sheet|visual-audit|summary)/;

const sanitizeInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const safeRemove = async (targetPath) => {
  try {
    if (!targetPath) return false;
    if (!(await fs.pathExists(targetPath))) return false;
    await fs.remove(targetPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Tier 2: Apaga ficheiros em <draft>/<videoId>/assets/raw/ que não foram
 * seleccionados pelo clipPlan final. Acionado por CLEANUP_UNUSED_DRAFT_ASSETS=true.
 * Por defeito está desactivado para não perder materiais que possam ser úteis em retry.
 *
 * IMPORTANTE: lê o state.json via readJsonSafe (read-only) para não criar ficheiros
 * fantasma se o state for inexistente. Só considera assets que estão no clipPlan.
 */
const cleanupUnusedDraftAssets = async ({ videoId } = {}) => {
  if (!videoId) {
    return { removed: 0, kept: 0, skipped: true, error: "missing_video_id" };
  }
  if (process.env.CLEANUP_UNUSED_DRAFT_ASSETS !== "true") {
    return { removed: 0, kept: 0, skipped: true };
  }
  try {
    const paths = await ensureVideoStructure(videoId);
    const statePath = path.join(paths.base, "state.json");
    const state = await readJsonSafe(statePath, null);
    if (!state || !fs.existsSync(statePath)) {
      // Sem state ainda: não arriscar apagar nada (pode ser usado em retry).
      return { removed: 0, kept: 0, skipped: true };
    }
    if (!(await fs.pathExists(paths.rawAssetsDir))) {
      return { removed: 0, kept: 0, skipped: true };
    }

    const usedPaths = new Set();
    const clips = Array.isArray(state.render_timeline?.clips)
      ? state.render_timeline.clips
      : [];
    clips.forEach((clip) => {
      const candidate = clip.local_path || clip.asset?.local_path;
      if (candidate) usedPaths.add(String(candidate));
    });

    const files = await fs.readdir(paths.rawAssetsDir);
    let removed = 0;
    for (const file of files) {
      const fullPath = path.join(paths.rawAssetsDir, file);
      if (usedPaths.has(fullPath)) continue;
      const didRemove = await safeRemove(fullPath);
      if (didRemove) {
        removed += 1;
      }
    }
    logger.info(`cleanup: draft assets não usados removidos`, {
      videoId,
      removed,
      kept: files.length - removed,
    });
    return { removed, kept: files.length - removed, skipped: false };
  } catch (error) {
    logger.warn(`cleanup: falha ao varrer draft assets`, { videoId, error: error.message });
    return { removed: 0, kept: 0, skipped: false, error: error.message };
  }
};

/**
 * Tier 6: Mantém apenas os últimos N videoIds em pipeline/test_reports/.
 * Apaga pastas <videoId>-frames, <videoId>-visual-evidence, ficheiros
 * <videoId>-contact-sheet.jpg, <videoId>-visual-audit.json, <videoId>-summary.json.
 */
const rotateTestReports = async ({ root = path.join("pipeline", "test_reports"), keepLast = 10 } = {}) => {
  const safeKeep = sanitizeInteger(keepLast, 0);
  if (safeKeep === 0) {
    return { removed_groups: 0, kept_groups: 0, disabled: true };
  }
  if (!(await fs.pathExists(root))) {
    return { removed_groups: 0, kept_groups: 0, missing_root: true };
  }

  try {
    const entries = await fs.readdir(root);
    const groupsByVideo = new Map();

    for (const entry of entries) {
      const match = String(entry || "").match(TEST_REPORT_GROUP_PATTERN);
      if (!match) continue;
      const fullPath = path.join(root, entry);
      let mtime = 0;
      try {
        const stats = await fs.stat(fullPath);
        mtime = Number(stats.mtimeMs || 0);
      } catch {
        mtime = 0;
      }
      const videoId = match[1];
      const group = groupsByVideo.get(videoId) || { videoId, mtime: 0, paths: [] };
      if (mtime > group.mtime) group.mtime = mtime;
      group.paths.push(fullPath);
      groupsByVideo.set(videoId, group);
    }

    const sorted = Array.from(groupsByVideo.values()).sort((a, b) => b.mtime - a.mtime);
    if (sorted.length <= safeKeep) {
      return { removed_groups: 0, kept_groups: sorted.length };
    }
    const toRemove = sorted.slice(safeKeep);
    let removedGroups = 0;
    for (const group of toRemove) {
      let allRemoved = true;
      for (const p of group.paths) {
        const ok = await safeRemove(p);
        if (!ok) allRemoved = false;
      }
      if (allRemoved) removedGroups += 1;
    }

    logger.info(`cleanup: rotated test_reports`, {
      root,
      kept_groups: safeKeep,
      removed_groups: removedGroups,
    });
    return { removed_groups: removedGroups, kept_groups: safeKeep };
  } catch (error) {
    logger.warn(`cleanup: rotação de test_reports falhou`, { root, error: error.message });
    return { removed_groups: 0, kept_groups: 0, error: error.message };
  }
};

module.exports = {
  cleanupUnusedDraftAssets,
  rotateTestReports,
  __test__: {
    TEST_REPORT_GROUP_PATTERN,
  },
};
