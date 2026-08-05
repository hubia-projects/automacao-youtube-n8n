const { config } = require("../config/env");
const { loadState, updateState } = require("./stateService");
const { probeMedia, runFfmpeg } = require("../utils/mediaUtils");
const { logger } = require("../utils/logger");
const path = require("path");
const fs = require("fs-extra");

const round3 = (value) => Number(Number(value || 0).toFixed(3));

// ─── Palavras-chave de erro FFmpeg ─────────────────────────────────────────

const FFMPEG_DECODE_ERROR_PATTERNS = [
  /Packet corrupt/i,
  /partial file/i,
  /Invalid NAL unit/i,
  /Error splitting/i,
  /Decoding error/i,
  /moov atom not found/i,
  /Invalid data found/i,
  /error while decoding/i,
  /corrupt decoded frame/i,
  /missing picture in access unit/i,
  /concealing \d+ DC/i,
  /concealing \d+ AC/i,
  /concealing \d+ MV/i,
];

// ─── Validação de resolução ─────────────────────────────────────────────────

const validateResolution = async (renderPath) => {
  try {
    const info = await probeMedia(renderPath);
    const width = Number(info.width || 0);
    const height = Number(info.height || 0);
    const expectedWidth = Number(config.OUTPUT_WIDTH || 1920);
    const expectedHeight = Number(config.OUTPUT_HEIGHT || 1080);

    const matches = width === expectedWidth && height === expectedHeight;

    return {
      passed: matches,
      actual: `${width}x${height}`,
      expected: `${expectedWidth}x${expectedHeight}`,
      width,
      height,
      error: matches ? "" : `Expected ${expectedWidth}x${expectedHeight}, got ${width}x${height}`,
    };
  } catch (error) {
    return {
      passed: false,
      actual: "unknown",
      expected: `${config.OUTPUT_WIDTH || 1920}x${config.OUTPUT_HEIGHT || 1080}`,
      width: 0,
      height: 0,
      error: error.message,
    };
  }
};

// ─── Validação de decode FFmpeg ─────────────────────────────────────────────

const validateDecode = async (renderPath) => {
  try {
    const { execSync } = require("child_process");

    const output = execSync(
      `ffmpeg -v warning -i "${renderPath}" -f null - 2>&1`,
      { timeout: 120000, encoding: "utf8" }
    );

    const stderr = String(output || "");
    const errors = [];

    FFMPEG_DECODE_ERROR_PATTERNS.forEach((pattern) => {
      const matches = stderr.match(new RegExp(pattern.source, "gi"));
      if (matches) {
        errors.push({
          pattern: pattern.source.replace(/\\/g, ""),
          count: matches.length,
        });
      }
    });

    const passed = errors.length === 0;

    return {
      passed,
      errors,
      decode_output: stderr.slice(0, 2000),
      has_warnings: /warning/i.test(stderr),
    };
  } catch (error) {
    return {
      passed: false,
      errors: [{ pattern: "ffmpeg_execution_error", count: 1 }],
      decode_output: error.message?.slice(0, 1000) || "unknown error",
      has_warnings: true,
    };
  }
};

// ─── Validação de bitrate ───────────────────────────────────────────────────

const validateBitrate = async (renderPath) => {
  try {
    const info = await probeMedia(renderPath);
    const videoStream = (info.streams || []).find((s) => s.codec_type === "video");
    const bitrate = Number(videoStream?.bit_rate || 0) / 1000000; // Mbps

    const expectedBitrate = String(config.VIDEO_BITRATE || "6M").replace(/[^0-9.]/g, "");
    const expectedMin = Math.max(1, Number(expectedBitrate) * 0.5);
    const expectedMax = Number(expectedBitrate) * 2;

    const passed = bitrate >= expectedMin && bitrate <= expectedMax;

    return {
      passed,
      actual_mbps: round3(bitrate),
      expected_range: `${round3(expectedMin)}-${round3(expectedMax)} Mbps`,
      error: passed ? "" : `Bitrate ${round3(bitrate)} Mbps outside expected range`,
    };
  } catch (error) {
    return {
      passed: false,
      actual_mbps: 0,
      expected_range: "unknown",
      error: error.message,
    };
  }
};

// ─── Probe de integridade completa ──────────────────────────────────────────

const probeRenderIntegrity = async (renderPath) => {
  if (!renderPath || !(await fs.pathExists(renderPath))) {
    return {
      passed: false,
      error: "render_path_not_found",
      render_path: renderPath || "undefined",
    };
  }

  const fileSize = (await fs.stat(renderPath)).size;
  const minExpectedSize = 5 * 1024 * 1024; // 5MB mínimo

  if (fileSize < minExpectedSize) {
    return {
      passed: false,
      error: `file_too_small ${(fileSize / 1024 / 1024).toFixed(1)}MB < 5MB`,
      file_size_bytes: fileSize,
    };
  }

  try {
    const info = await probeMedia(renderPath);
    const duration = Number(info.duration || 0);
    const hasVideo = (info.streams || []).some((s) => s.codec_type === "video");
    const hasAudio = (info.streams || []).some((s) => s.codec_type === "audio");

    return {
      passed: duration > 0 && hasVideo,
      duration_seconds: round3(duration),
      file_size_mb: round3(fileSize / 1024 / 1024),
      has_video_stream: hasVideo,
      has_audio_stream: hasAudio,
      format: info.format?.format_name || "unknown",
      error: !hasVideo ? "no_video_stream" : duration <= 0 ? "zero_duration" : "",
    };
  } catch (error) {
    return {
      passed: false,
      error: `probe_failed: ${error.message}`,
      file_size_bytes: fileSize,
    };
  }
};

// ─── Validação completa ─────────────────────────────────────────────────────

const runMediaIntegrityQa = async ({ videoId }) => {
  const state = await loadState(videoId);
  const renderPath = state.render_path || "";

  if (!renderPath) {
    return {
      video_id: videoId,
      passed: false,
      error: "no_render_path_in_state",
    };
  }

  // 1. Probe de integridade
  const integrity = await probeRenderIntegrity(renderPath);

  // 2. Validação de resolução
  const resolution = await validateResolution(renderPath);

  // 3. Validação de decode FFmpeg
  const decode = await validateDecode(renderPath);

  // 4. Validação de bitrate
  const bitrate = await validateBitrate(renderPath);

  const allPassed = integrity.passed && resolution.passed && decode.passed && bitrate.passed;

  const result = {
    video_id: videoId,
    render_path: renderPath,
    passed: allPassed,
    integrity,
    resolution,
    decode,
    bitrate,
    failures: [],
  };

  if (!integrity.passed) result.failures.push({ stage: "integrity", error: integrity.error });
  if (!resolution.passed) result.failures.push({ stage: "resolution", error: resolution.error });
  if (!decode.passed) result.failures.push({ stage: "decode", errors: decode.errors });
  if (!bitrate.passed) result.failures.push({ stage: "bitrate", error: bitrate.error });

  const updated = await updateState(videoId, {
    media_integrity_qa: result,
  });

  logger.info("mediaIntegrityQaService: QA de integridade concluído", {
    videoId,
    passed: allPassed,
    failures: result.failures.length,
  });

  return result;
};

module.exports = {
  runMediaIntegrityQa,
  probeRenderIntegrity,
  validateResolution,
  validateDecode,
  validateBitrate,
  FFMPEG_DECODE_ERROR_PATTERNS,
  __test__: {
    probeRenderIntegrity,
    validateResolution,
    validateDecode,
    validateBitrate,
  },
};
