const fs = require("fs-extra");
const path = require("path");
const { config } = require("../config/env");
const { runFfmpeg } = require("../utils/mediaUtils");
const { isSameLocation } = require("./narrativeBlockPlanner");
const { logger } = require("../utils/logger");

const round3 = (value) => Number(Number(value || 0).toFixed(3));

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
      // Só blocos com overlay_title válido geram overlay — blocos genéricos
      // ("Introducao" etc.) já chegam aqui com overlay_title vazio.
      if (!String(block.overlay_title || "").trim()) return false;
      if (index === 0) return String(block.topic || "").trim();
      return requireChapterOverlay ? true : Boolean(block.hard_boundary);
    })
    .map((block, index) => {
      const isBoundary = index > 0;
      const firstBoundaryClip = safeClips.find((clip) => {
        if (clip.macro_block_id && block.id && clip.macro_block_id === block.id) return true;
        return Number(clip.timeline_start_sec || 0) >= Number(block.start_seconds ?? block.start_sec ?? 0) - 0.001;
      });

      // Nunca mostrar um rótulo de cidade sobre um clip de OUTRA cidade
      // (ex: "Faro" sobre Lisboa). Se o clip sob o overlay tem cidade
      // conhecida e incompatível com o tópico, suprime o overlay.
      const clipCity = firstBoundaryClip?.location?.city || firstBoundaryClip?.detected_location?.city || "";
      const blockCity = block.expected_location || block.location?.city || "";
      if (blockCity && clipCity && !isSameLocation(clipCity, blockCity)) {
        logger.warn("overlayService: overlay suprimido — clip de cidade diferente do rótulo", {
          overlay: block.overlay_title,
          block_city: blockCity,
          clip_city: clipCity,
        });
        return null;
      }

      const startSeconds = round3(Number(firstBoundaryClip?.timeline_start_sec ?? block.start_seconds ?? block.start_sec ?? 0));

      return {
        start_seconds: startSeconds,
        end_seconds: round3(startSeconds + 2.6),
        text: block.overlay_title,
        type: isBoundary ? "chapter_card_clip" : "block_title",
        block_id: block.block_id || block.id,
        boundary_id: block.boundary_id || "",
      };
    })
    .filter(Boolean);
};

const buildOverlayFilter = ({ overlays = [], width = 1920, height = 1080 }) => {
  const fontPath = process.platform === "win32"
    ? "C\\:/Windows/Fonts/arial.ttf"
    : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  // FFmpeg 8.0+ rejeita expressões aritméticas (w*0.06) em drawbox/drawtext.
  // Pre-calcular pixels literais a partir da resolução de saída real.
  const boxX = Math.round(width * 0.06);
  const boxY = Math.round(height * 0.08);
  const boxW = Math.round(width * 0.42);
  const textX = Math.round(width * 0.09);
  const textY = Math.round(height * 0.115);

  const parts = [];
  overlays.forEach((overlay) => {
    const start = Number(overlay.start_seconds || 0);
    const end = Number(overlay.end_seconds || start + 2.5);
    const enable = `between(t,${start.toFixed(3)},${end.toFixed(3)})`;
    const fadeAlpha = `if(lt(t,${(start + 0.3).toFixed(3)}),(t-${start.toFixed(3)})/0.3,if(gt(t,${(end - 0.3).toFixed(3)}),(${end.toFixed(3)}-t)/0.3,1))`;
    parts.push(`drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=92:color=black@0.45:t=fill:enable='${enable}'`);
    parts.push(`drawtext=fontfile='${fontPath}':text='${escapeDrawtext(overlay.text || "")}':fontcolor=white:fontsize=42:x=${textX}:y=${textY}:alpha='${fadeAlpha}':enable='${enable}'`);
  });
  return parts.join(",");
};

const buildBurnedCaptionsFilter = (subtitlePath) => {
  if (!subtitlePath) return "";
  const escaped = String(subtitlePath).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/'/g, "\\'");
  // Estilo discreto: 2 linhas máx (quebra do SRT), fonte semibold, outline
  // suave, margem segura inferior.
  const style = "FontName=DejaVu Sans,FontSize=20,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H66000000,BorderStyle=1,Outline=1.4,Shadow=0.6,MarginV=42";
  return `subtitles='${escaped}':force_style='${style}'`;
};

const applyOverlaysToVideo = async ({ inputPath, outputPath, overlays = [], subtitlePath = "", fps = config.OUTPUT_FPS || 30, videoBitrate = config.VIDEO_BITRATE || "6M", maxVideoBitrate = config.MAX_VIDEO_BITRATE || "8M", width = config.OUTPUT_WIDTH || 1920, height = config.OUTPUT_HEIGHT || 1080 }) => {
  const captionsFilter = config.BURN_CAPTIONS ? buildBurnedCaptionsFilter(subtitlePath) : "";

  if (!overlays.length && !captionsFilter) {
    if (inputPath !== outputPath) {
      await fs.copy(inputPath, outputPath, { overwrite: true });
    }
    return outputPath;
  }

  const filter = [buildOverlayFilter({ overlays, width, height }), captionsFilter].filter(Boolean).join(",");
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
