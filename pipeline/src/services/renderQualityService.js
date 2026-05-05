const { runFfmpeg, probeMedia } = require("../utils/mediaUtils");
const { config } = require("../config/env");

const round3 = (value) => Number(Number(value || 0).toFixed(3));

const parseSegments = (stderr = "", pattern) => {
  const matches = [];
  const regex = new RegExp(pattern, "g");
  let match;
  while ((match = regex.exec(stderr))) {
    matches.push(match.groups || {});
  }
  return matches;
};

const runDetector = async (args) => {
  try {
    const { stderr } = await runFfmpeg(["-hide_banner", "-loglevel", "info", ...args]);
    return stderr || "";
  } catch (error) {
    return error.stderr || "";
  }
};

const analyzeBlackFrames = async (renderPath) => {
  const stderr = await runDetector([
    "-i",
    renderPath,
    "-vf",
    "blackdetect=d=0.08:pix_th=0.10",
    "-an",
    "-f",
    "null",
    "-",
  ]);

  const matches = parseSegments(stderr, "black_start:(?<start>[0-9.]+)\\s+black_end:(?<end>[0-9.]+)\\s+black_duration:(?<duration>[0-9.]+)");
  return matches.map((item) => ({
    start: round3(item.start),
    end: round3(item.end),
    duration: round3(item.duration),
  }));
};

const analyzeSilence = async (renderPath) => {
  const stderr = await runDetector([
    "-i",
    renderPath,
    "-af",
    "silencedetect=n=-40dB:d=0.35",
    "-f",
    "null",
    "-",
  ]);

  const starts = parseSegments(stderr, "silence_start: (?<start>[0-9.]+)");
  const ends = parseSegments(stderr, "silence_end: (?<end>[0-9.]+) \\| silence_duration: (?<duration>[0-9.]+)");
  return ends.map((item, index) => ({
    start: round3(starts[index]?.start || 0),
    end: round3(item.end),
    duration: round3(item.duration),
  }));
};

const analyzeFreezes = async (renderPath) => {
  const stderr = await runDetector([
    "-i",
    renderPath,
    "-vf",
    "freezedetect=n=-50dB:d=0.4",
    "-an",
    "-f",
    "null",
    "-",
  ]);

  const starts = parseSegments(stderr, "freeze_start: (?<start>[0-9.]+)");
  const ends = parseSegments(stderr, "freeze_end: (?<end>[0-9.]+) \\| freeze_duration: (?<duration>[0-9.]+)");
  return ends.map((item, index) => ({
    start: round3(starts[index]?.start || 0),
    end: round3(item.end),
    duration: round3(item.duration),
  }));
};

const hasUnexpectedSilence = (segments = []) =>
  segments.some(
    (segment) => Number(segment.duration || 0) >= 1.0 && Number(segment.start || 0) > 1
  );

const parseFps = (stream = {}) => {
  const raw = String(stream.avg_frame_rate || stream.r_frame_rate || "0/1");
  const [num, den] = raw.split("/").map(Number);
  if (!num || !den) return 0;
  return num / den;
};

const validateRenderQuality = async ({ renderPath }) => {
  const info = await probeMedia(renderPath).catch(() => ({ width: 0, height: 0, duration: 0, streams: [] }));
  const videoStream = (info.streams || []).find((stream) => stream.codec_type === "video") || {};
  const audioStream = (info.streams || []).find((stream) => stream.codec_type === "audio") || {};
  const fps = parseFps(videoStream);

  const [blackSegments, silenceSegments, freezeSegments] = await Promise.all([
    analyzeBlackFrames(renderPath),
    analyzeSilence(renderPath),
    analyzeFreezes(renderPath),
  ]);

  const issues = [];
  if (Number(info.width || 0) < Number(config.OUTPUT_WIDTH || 1920) || Number(info.height || 0) < Number(config.OUTPUT_HEIGHT || 1080)) {
    issues.push({ type: "resolution_below_target", severity: "high", width: info.width, height: info.height });
  }
  if (!audioStream.codec_name) {
    issues.push({ type: "missing_audio", severity: "critical" });
  }
  if (blackSegments.some((segment) => Number(segment.duration || 0) >= 0.08)) {
    issues.push({ type: "black_frames_detected", severity: "high", count: blackSegments.length, segments: blackSegments.slice(0, 6) });
  }
  if (freezeSegments.some((segment) => Number(segment.duration || 0) >= 0.45)) {
    issues.push({ type: "freeze_detected", severity: "medium", count: freezeSegments.length, segments: freezeSegments.slice(0, 6) });
  }
  if (hasUnexpectedSilence(silenceSegments)) {
    issues.push({ type: "unexpected_silence", severity: "medium", count: silenceSegments.length, segments: silenceSegments.slice(0, 6) });
  }

  let technicalScore = 1;
  if (issues.some((issue) => issue.type === "resolution_below_target")) technicalScore -= 0.25;
  if (issues.some((issue) => issue.type === "missing_audio")) technicalScore -= 0.5;
  if (issues.some((issue) => issue.type === "black_frames_detected")) technicalScore -= 0.25;
  if (issues.some((issue) => issue.type === "freeze_detected")) technicalScore -= 0.1;
  if (issues.some((issue) => issue.type === "unexpected_silence")) technicalScore -= 0.1;

  return {
    render_path: renderPath,
    width: Number(info.width || 0),
    height: Number(info.height || 0),
    duration: round3(info.duration || 0),
    fps: round3(fps),
    has_audio: Boolean(audioStream.codec_name),
    black_segments: blackSegments,
    silence_segments: silenceSegments,
    freeze_segments: freezeSegments,
    technical_score: round3(Math.max(0, technicalScore)),
    issues,
  };
};

module.exports = {
  validateRenderQuality,
  __test__: {
    hasUnexpectedSilence,
    parseFps,
    parseSegments,
  },
};
