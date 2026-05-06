const { runFfmpeg, probeMedia, extractFrameRawRgb } = require("../utils/mediaUtils");
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

const computeFrameColorStats = (buffer = Buffer.alloc(0)) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) {
    return {
      avgDeviation: 999,
      maxChannelRange: 999,
      uniqueBuckets: 999,
    };
  }

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let minR = 255;
  let minG = 255;
  let minB = 255;
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;
  const bucketSet = new Set();
  const pixelCount = Math.floor(buffer.length / 3);

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 3;
    const red = buffer[offset];
    const green = buffer[offset + 1];
    const blue = buffer[offset + 2];

    sumR += red;
    sumG += green;
    sumB += blue;
    if (red < minR) minR = red;
    if (green < minG) minG = green;
    if (blue < minB) minB = blue;
    if (red > maxR) maxR = red;
    if (green > maxG) maxG = green;
    if (blue > maxB) maxB = blue;
    bucketSet.add(`${Math.floor(red / 16)}-${Math.floor(green / 16)}-${Math.floor(blue / 16)}`);
    if (bucketSet.size > 12) break;
  }

  const meanR = sumR / pixelCount;
  const meanG = sumG / pixelCount;
  const meanB = sumB / pixelCount;
  let deviationSum = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 3;
    deviationSum += Math.abs(buffer[offset] - meanR);
    deviationSum += Math.abs(buffer[offset + 1] - meanG);
    deviationSum += Math.abs(buffer[offset + 2] - meanB);
  }

  return {
    avgDeviation: deviationSum / (pixelCount * 3),
    maxChannelRange: Math.max(maxR - minR, maxG - minG, maxB - minB),
    uniqueBuckets: bucketSet.size,
  };
};

const isSolidColorFrame = (stats = {}) =>
  Number(stats.maxChannelRange ?? 999) <= 12 &&
  Number(stats.avgDeviation ?? 999) <= 3 &&
  Number(stats.uniqueBuckets ?? 999) <= 4;

const analyzeSolidColorFrames = async (renderPath, duration = 0) => {
  const safeDuration = Math.max(1, Number(duration || 0));
  const sampleTimes = [...new Set([
    0.2,
    Math.max(0.2, safeDuration * 0.2),
    Math.max(0.2, safeDuration * 0.5),
    Math.max(0.2, safeDuration * 0.8),
  ].map((value) => round3(Math.min(Math.max(0, value), Math.max(0, safeDuration - 0.1)))))]
    .sort((left, right) => left - right);

  const flaggedSamples = [];
  for (const timeSeconds of sampleTimes) {
    try {
      const frameBuffer = await extractFrameRawRgb({ inputPath: renderPath, timeSeconds, width: 64, height: 64 });
      const stats = computeFrameColorStats(frameBuffer);
      if (isSolidColorFrame(stats)) {
        flaggedSamples.push({
          time_seconds: timeSeconds,
          max_channel_range: round3(stats.maxChannelRange),
          avg_deviation: round3(stats.avgDeviation),
          unique_buckets: Number(stats.uniqueBuckets || 0),
        });
      }
    } catch {
      // ignore individual sample failures
    }
  }

  return flaggedSamples;
};

const validateRenderQuality = async ({ renderPath, allowPlaceholderArtifacts = false }) => {
  const info = await probeMedia(renderPath).catch(() => ({ width: 0, height: 0, duration: 0, streams: [] }));
  const videoStream = (info.streams || []).find((stream) => stream.codec_type === "video") || {};
  const audioStream = (info.streams || []).find((stream) => stream.codec_type === "audio") || {};
  const fps = parseFps(videoStream);

  const [blackSegments, silenceSegments, freezeSegments, solidColorSamples] = await Promise.all([
    analyzeBlackFrames(renderPath),
    analyzeSilence(renderPath),
    analyzeFreezes(renderPath),
    allowPlaceholderArtifacts ? Promise.resolve([]) : analyzeSolidColorFrames(renderPath, info.duration),
  ]);

  const issues = [];
  if (Number(info.width || 0) < Number(config.OUTPUT_WIDTH || 1920) || Number(info.height || 0) < Number(config.OUTPUT_HEIGHT || 1080)) {
    issues.push({ type: "resolution_below_target", severity: "critical", width: info.width, height: info.height });
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
  if (solidColorSamples.length >= 2) {
    issues.push({
      type: "solid_color_frames_detected",
      severity: "critical",
      count: solidColorSamples.length,
      samples: solidColorSamples.slice(0, 6),
    });
  }

  let technicalScore = 1;
  if (issues.some((issue) => issue.type === "resolution_below_target")) technicalScore -= 0.35;
  if (issues.some((issue) => issue.type === "missing_audio")) technicalScore -= 0.5;
  if (issues.some((issue) => issue.type === "black_frames_detected")) technicalScore -= 0.25;
  if (issues.some((issue) => issue.type === "freeze_detected")) technicalScore -= 0.1;
  if (issues.some((issue) => issue.type === "unexpected_silence")) technicalScore -= 0.1;
  if (issues.some((issue) => issue.type === "solid_color_frames_detected")) technicalScore -= 0.4;

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
    solid_color_samples: solidColorSamples,
    allow_placeholder_artifacts: allowPlaceholderArtifacts,
    technical_score: round3(Math.max(0, technicalScore)),
    issues,
  };
};

module.exports = {
  validateRenderQuality,
  __test__: {
    analyzeSolidColorFrames,
    computeFrameColorStats,
    hasUnexpectedSilence,
    isSolidColorFrame,
    parseFps,
    parseSegments,
  },
};
