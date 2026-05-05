const fs = require("fs-extra");
const path = require("path");
const { config } = require("../config/env");
const { runFfmpeg } = require("../utils/mediaUtils");

const round3 = (value) => Number(Number(value || 0).toFixed(3));

const escapeDrawtext = (value = "") =>
  String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");

const buildBlockOverlays = ({ narrativeBlocks = [], enabled = config.ENABLE_BLOCK_OVERLAYS }) => {
  if (!enabled) return [];

  return (Array.isArray(narrativeBlocks) ? narrativeBlocks : [])
    .filter((block, index) => index > 0 || String(block.topic || "").trim())
    .map((block, index) => ({
      start_seconds: round3(Number(block.start_seconds ?? block.start_sec ?? 0)),
      end_seconds: round3(Number(block.start_seconds ?? block.start_sec ?? 0) + 2.6),
      text: block.overlay_title || `${index + 1}. ${block.label || block.topic || "Bloco"}`,
      type: "block_title",
      block_id: block.block_id || block.id,
    }));
};

const buildOverlayFilter = ({ overlays = [] }) => {
  const fontPath = process.platform === "win32"
    ? "C\\:/Windows/Fonts/arial.ttf"
    : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  const parts = [];
  overlays.forEach((overlay) => {
    const start = Number(overlay.start_seconds || 0);
    const end = Number(overlay.end_seconds || start + 2.5);
    const enable = `between(t,${start.toFixed(3)},${end.toFixed(3)})`;
    parts.push(`drawbox=x=w*0.06:y=h*0.08:w=w*0.42:h=92:color=black@0.45:t=fill:enable='${enable}'`);
    parts.push(`drawtext=fontfile='${fontPath}':text='${escapeDrawtext(overlay.text || "")}':fontcolor=white:fontsize=42:x=w*0.09:y=h*0.115:enable='${enable}'`);
  });
  return parts.join(",");
};

const applyOverlaysToVideo = async ({ inputPath, outputPath, overlays = [], fps = config.OUTPUT_FPS || 30, videoBitrate = config.VIDEO_BITRATE || "6M", maxVideoBitrate = config.MAX_VIDEO_BITRATE || "8M" }) => {
  if (!overlays.length) {
    if (inputPath !== outputPath) {
      await fs.copy(inputPath, outputPath, { overwrite: true });
    }
    return outputPath;
  }

  const filter = buildOverlayFilter({ overlays });
  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vf",
    filter,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(Number(fps || 30)),
    "-b:v",
    String(videoBitrate || "6M"),
    "-maxrate",
    String(maxVideoBitrate || "8M"),
    "-bufsize",
    "10M",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
  return outputPath;
};

module.exports = {
  applyOverlaysToVideo,
  buildBlockOverlays,
  buildOverlayFilter,
};
