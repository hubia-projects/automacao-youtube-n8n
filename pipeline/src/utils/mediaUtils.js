const path = require("path");
const fs = require("fs-extra");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

const runProcess = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      }
    );
  });

const runFfmpeg = async (args, options = {}) => {
  const normalizedArgs = Array.isArray(args) ? args : [];
  const hasExplicitLogLevel = normalizedArgs.includes("-v") || normalizedArgs.includes("-loglevel");
  const ffmpegArgs = hasExplicitLogLevel
    ? normalizedArgs
    : ["-hide_banner", "-loglevel", "error", ...normalizedArgs];

  return runProcess(ffmpegPath, ffmpegArgs, {
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });
};

const probeMedia = async (filePath) => {
  const { stdout } = await runProcess(ffprobePath, [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ]);

  const payload = JSON.parse(stdout || "{}");
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const videoStream = streams.find((stream) => stream.codec_type === "video") || {};
  const audioStream = streams.find((stream) => stream.codec_type === "audio") || {};
  const format = payload.format || {};

  return {
    width: Number(videoStream.width || 0),
    height: Number(videoStream.height || 0),
    duration: Number(format.duration || videoStream.duration || audioStream.duration || 0),
    bitRate: Number(format.bit_rate || 0),
    streams,
    format,
  };
};

const getResolutionLabel = ({ width = 0, height = 0 }) => {
  if (width >= 3840 && height >= 2160) return "4K";
  if (width >= 1920 && height >= 1080) return "Full HD";
  if (width >= 1280 && height >= 720) return "HD";
  return "LOW";
};

const placeholderPalette = [
  "#0f766e",
  "#374151",
  "#166534",
  "#92400e",
  "#7f1d1d",
  "#3f3f46",
  "#14532d",
  "#78350f",
];

const createPlaceholderImage = async ({ outputPath, width = 1920, height = 1080, seed = 1 }) => {
  const color = placeholderPalette[Math.abs(Number(seed || 1)) % placeholderPalette.length];
  await fs.ensureDir(path.dirname(outputPath));
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${width}x${height}:d=1`,
    "-frames:v",
    "1",
    outputPath,
  ]);
  return outputPath;
};

const extractVideoFrame = async ({ inputPath, outputPath, timeSeconds = 0, width = 960, height = 540 }) => {
  await fs.ensureDir(path.dirname(outputPath));
  await runFfmpeg([
    "-y",
    "-ss",
    Number(Number(timeSeconds || 0).toFixed(3)).toString(),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    outputPath,
  ]);
  return outputPath;
};

const extractFrameRawRgb = async ({ inputPath, timeSeconds = 0, width = 64, height = 64 }) => {
  const { stdout } = await runFfmpeg(
    [
      "-ss",
      Number(Number(timeSeconds || 0).toFixed(3)).toString(),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:${height},format=rgb24`,
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer" }
  );

  return stdout;
};

module.exports = {
  runFfmpeg,
  probeMedia,
  createPlaceholderImage,
  extractVideoFrame,
  extractFrameRawRgb,
  getResolutionLabel,
};
