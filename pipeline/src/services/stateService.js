const path = require("path");
const fs = require("fs-extra");
const { config } = require("../config/env");
const { makeInitialState } = require("../utils/stateSchema");
const { writeJsonAtomic, readJsonSafe, timestampForFile } = require("../utils/fileUtils");
const { logger } = require("../utils/logger");

const getVideoDir = (videoId) => path.join(config.OUTPUT_ROOT, "draft", videoId);

const getStatePath = (videoId) => path.join(getVideoDir(videoId), "state.json");

const ensureVideoStructure = async (videoId) => {
  const base = getVideoDir(videoId);
  const dirs = [
    base,
    path.join(base, "audio"),
    path.join(base, "captions"),
    path.join(base, "assets", "raw"),
    path.join(base, "render"),
    path.join(base, "history"),
    path.join(base, "metadata"),
  ];

  await Promise.all(dirs.map((dir) => fs.ensureDir(dir)));
  return {
    base,
    statePath: path.join(base, "state.json"),
    scriptPath: path.join(base, "script.md"),
    audioPath: path.join(base, "audio", "narration.mp3"),
    captionSrtPath: path.join(base, "captions", "subtitles.srt"),
    captionVttPath: path.join(base, "captions", "subtitles.vtt"),
    renderPath: path.join(base, "render", "final.mp4"),
    thumbnailPath: path.join(base, "metadata", "thumbnail.png"),
    rawAssetsDir: path.join(base, "assets", "raw"),
    historyDir: path.join(base, "history"),
  };
};

const loadState = async (videoId) => {
  const statePath = getStatePath(videoId);
  const existing = await readJsonSafe(statePath, null);
  if (existing) return existing;

  const paths = await ensureVideoStructure(videoId);
  const state = makeInitialState({ videoId });
  state.state_path = paths.statePath;
  await writeJsonAtomic(paths.statePath, state);
  return state;
};

const saveState = async (videoId, nextState) => {
  const paths = await ensureVideoStructure(videoId);
  const current = await readJsonSafe(paths.statePath, null);

  if (current) {
    const backupPath = path.join(paths.historyDir, `state-${timestampForFile()}.json`);
    await writeJsonAtomic(backupPath, current);
  }

  nextState.video_id = videoId;
  nextState.state_path = paths.statePath;
  nextState.updated_at = new Date().toISOString();

  if (!nextState.created_at) {
    nextState.created_at = nextState.updated_at;
  }

  await writeJsonAtomic(paths.statePath, nextState);
  logger.info(`State saved for ${videoId}`, { step: nextState.current_step, status: nextState.status });
  return nextState;
};

const updateState = async (videoId, patch = {}, options = {}) => {
  const current = await loadState(videoId);

  const merged = {
    ...current,
    ...patch,
    assets_json: {
      ...(current.assets_json || {}),
      ...(patch.assets_json || {}),
    },
  };

  if (options.currentStep) merged.current_step = options.currentStep;
  if (options.status) merged.status = options.status;

  return saveState(videoId, merged);
};

const setStateError = async (videoId, error, currentStep = "error") => {
  const message = error?.message || String(error);
  return updateState(
    videoId,
    {
      error_message: message,
    },
    {
      currentStep,
      status: "error",
    }
  );
};

module.exports = {
  getVideoDir,
  getStatePath,
  ensureVideoStructure,
  loadState,
  saveState,
  updateState,
  setStateError,
};