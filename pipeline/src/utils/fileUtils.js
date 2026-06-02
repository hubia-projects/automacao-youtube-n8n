const fs = require("fs-extra");
const path = require("path");

const ensureDir = async (dirPath) => {
  await fs.ensureDir(dirPath);
  return dirPath;
};

const uniqueTempPath = (filePath) => {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${filePath}.${suffix}.tmp`;
};

const readJsonSafe = async (filePath, fallback = null) => {
  try {
    if (!(await fs.pathExists(filePath))) return fallback;
    return await fs.readJson(filePath);
  } catch {
    return fallback;
  }
};

const copyIfExists = async (source, target) => {
  if (await fs.pathExists(source)) {
    await fs.copy(source, target);
  }
};

const writeJsonAtomic = async (filePath, data) => {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tempPath = uniqueTempPath(filePath);
  await fs.writeJson(tempPath, data, { spaces: 2 });
  await fs.move(tempPath, filePath, { overwrite: true });
};

const writeTextAtomic = async (filePath, content) => {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tempPath = uniqueTempPath(filePath);
  await fs.writeFile(tempPath, content, "utf8");
  await fs.move(tempPath, filePath, { overwrite: true });
};

const timestampForFile = () =>
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;

const escapeSubtitlePath = (subtitlePath) => subtitlePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/'/g, "\\'");

module.exports = {
  ensureDir,
  readJsonSafe,
  copyIfExists,
  writeJsonAtomic,
  writeTextAtomic,
  timestampForFile,
  escapeSubtitlePath,
};