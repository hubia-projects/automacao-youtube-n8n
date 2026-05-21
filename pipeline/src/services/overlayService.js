const fs = require("fs-extra");
const path = require("path");
const { config } = require("../config/env");
const { runFfmpeg } = require("../utils/mediaUtils");

const round3 = (value) => Number(Number(value || 0).toFixed(3));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const escapeDrawtext = (value = "") =>
  String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");

const buildBlockOverlays = ({
  narrativeBlocks = [],
  clips = [],
  enabled = config.ENABLE_BLOCK_OVERLAYS,
  requireChapterOverlay = Boolean(config.HARD_BOUNDARY_REQUIRE_CHAPTER_OVERLAY),
}) => {
  if (!enabled) return [];

  const safeBlocks = Array.isArray(narrativeBlocks) ? narrativeBlocks : [];
  const safeClips = Array.isArray(clips) ? clips : [];

  return safeBlocks
    .filter((block, index) => {
      if (index === 0) return String(block.topic || "").trim();
      return requireChapterOverlay ? true : Boolean(block.hard_boundary);
    })
    .map((block, index) => {
      const isBoundary = index > 0;
      const firstBoundaryClip = safeClips.find((clip) => {
        if (clip.macro_block_id && block.id && clip.macro_block_id === block.id) return true;
        return Number(clip.timeline_start_sec || 0) >= Number(block.start_seconds ?? block.start_sec ?? 0) - 0.001;
      });
      const startSeconds = round3(Number(firstBoundaryClip?.timeline_start_sec ?? block.start_seconds ?? block.start_sec ?? 0));

      return {
        start_seconds: startSeconds,
        end_seconds: round3(startSeconds + 2.6),
        text: block.overlay_title || `${index + 1}. ${block.label || block.topic || "Bloco"}`,
        type: isBoundary ? "chapter_card_clip" : "block_title",
        block_id: block.block_id || block.id,
        boundary_id: block.boundary_id || "",
      };
    });
};

const buildOverlayLayout = ({ videoWidth = Number(config.OUTPUT_WIDTH || 1920), videoHeight = Number(config.OUTPUT_HEIGHT || 1080) } = {}) => {
  const width = Math.max(640, Number(videoWidth || config.OUTPUT_WIDTH || 1920));
  const height = Math.max(360, Number(videoHeight || config.OUTPUT_HEIGHT || 1080));
  const boxX = Math.round(width * 0.06);
  const boxY = Math.round(height * 0.08);
  const boxW = Math.round(width * 0.42);
  const boxH = Math.round(clamp(height * 0.085, 72, 132));
  const textX = Math.round(width * 0.09);
  const textY = Math.round(boxY + (boxH * 0.58));
  const fontSize = Math.round(clamp(height * 0.039, 30, 54));
  return {
    width,
    height,
    boxX,
    boxY,
    boxW,
    boxH,
    textX,
    textY,
    fontSize,
  };
};

const buildOverlayFilter = ({ overlays = [], videoWidth = Number(config.OUTPUT_WIDTH || 1920), videoHeight = Number(config.OUTPUT_HEIGHT || 1080) }) => {
  const fontPath = process.platform === "win32"
    ? "C\\:/Windows/Fonts/arial.ttf"
    : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const layout = buildOverlayLayout({ videoWidth, videoHeight });

  const parts = [];
  overlays.forEach((overlay) => {
    const start = Number(overlay.start_seconds || 0);
    const end = Number(overlay.end_seconds || start + 2.5);
    const enable = `between(t,${start.toFixed(3)},${end.toFixed(3)})`;
    parts.push(`drawbox=x=${layout.boxX}:y=${layout.boxY}:w=${layout.boxW}:h=${layout.boxH}:color=black@0.45:t=fill:enable='${enable}'`);
    parts.push(`drawtext=fontfile='${fontPath}':text='${escapeDrawtext(overlay.text || "")}':fontcolor=white:fontsize=${layout.fontSize}:x=${layout.textX}:y=${layout.textY}:enable='${enable}'`);
  });
  return parts.join(",");
};

const preflightOverlayFilter = async ({ overlays = [], videoWidth = Number(config.OUTPUT_WIDTH || 1920), videoHeight = Number(config.OUTPUT_HEIGHT || 1080) }) => {
  if (!overlays.length) return { ok: true, status: "skipped" };
  const filter = buildOverlayFilter({ overlays, videoWidth, videoHeight });
  await runFfmpeg([
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${Math.max(640, Number(videoWidth || 1920))}x${Math.max(360, Number(videoHeight || 1080))}:d=1`,
    "-vf",
    filter,
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ]);
  return { ok: true, status: "ok" };
};

const applyOverlaysToVideo = async ({
  inputPath,
  outputPath,
  overlays = [],
  fps = config.OUTPUT_FPS || 30,
  videoBitrate = config.VIDEO_BITRATE || "6M",
  maxVideoBitrate = config.MAX_VIDEO_BITRATE || "8M",
  videoWidth = Number(config.OUTPUT_WIDTH || 1920),
  videoHeight = Number(config.OUTPUT_HEIGHT || 1080),
  runPreflight = true,
}) => {
  if (!overlays.length) {
    if (inputPath !== outputPath) {
      await fs.copy(inputPath, outputPath, { overwrite: true });
    }
    return outputPath;
  }

  if (runPreflight) {
    await preflightOverlayFilter({ overlays, videoWidth, videoHeight });
  }

  const filter = buildOverlayFilter({ overlays, videoWidth, videoHeight });
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
  buildOverlayLayout,
  preflightOverlayFilter,
};
