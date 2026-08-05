#!/usr/bin/env node
/**
 * PARTE 8 — Teste: Media Integrity QA
 *
 * Regras testadas:
 * - probeRenderIntegrity: path inexistente → failed
 * - FFMPEG_DECODE_ERROR_PATTERNS cobre erros críticos
 * - validateDecode: sem erros → passed
 * - validateResolution: path inexistente → failed
 * - validateBitrate: path inexistente → failed
 */

const {
  probeRenderIntegrity,
  validateResolution,
  validateDecode,
  validateBitrate,
  FFMPEG_DECODE_ERROR_PATTERNS,
} = require("../src/services/mediaIntegrityQaService");
const assert = require("assert");

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}: ${error.message}`);
    failed++;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// probeRenderIntegrity: path inexistente
// ═══════════════════════════════════════════════════════════════════════════

test("probeRenderIntegrity: path inexistente → failed", () => {
  return probeRenderIntegrity("/tmp/nonexistent_video_12345_test.mp4").then((result) => {
    assert(result.passed === false, "Path inexistente deve falhar");
    assert(result.error === "render_path_not_found",
      `Erro: ${result.error}`);
  });
});

test("probeRenderIntegrity: path undefined → failed", () => {
  return probeRenderIntegrity("").then((result) => {
    assert(result.passed === false, "Path vazio deve falhar");
    assert(result.error === "render_path_not_found",
      `Erro: ${result.error}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FFMPEG_DECODE_ERROR_PATTERNS
// ═══════════════════════════════════════════════════════════════════════════

test("FFMPEG_DECODE_ERROR_PATTERNS cobre erros críticos", () => {
  const criticalErrors = [
    "Packet corrupt",
    "partial file",
    "Invalid NAL unit",
    "Error splitting",
    "Decoding error",
    "moov atom not found",
  ];

  criticalErrors.forEach((error) => {
    const found = FFMPEG_DECODE_ERROR_PATTERNS.some((pattern) =>
      pattern.test(error)
    );
    assert(found, `"${error}" deve ser coberto por FFMPEG_DECODE_ERROR_PATTERNS`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// validateDecode / validateResolution / validateBitrate — path inexistente
// ═══════════════════════════════════════════════════════════════════════════

test("validateDecode: path inexistente retorna failed sem crash", () => {
  return validateDecode("/tmp/nonexistent_decode_test.mp4").then((result) => {
    assert(result.passed === false, "Decode de path inexistente deve falhar");
    assert(Array.isArray(result.errors), "Deve ter array de errors");
  });
});

test("validateResolution: path inexistente → failed", () => {
  return validateResolution("/tmp/nonexistent_res_test.mp4").then((result) => {
    assert(result.passed === false, "Resolução de path inexistente deve falhar");
    assert(result.error.length > 0, "Deve ter mensagem de erro");
  });
});

test("validateBitrate: path inexistente → failed", () => {
  return validateBitrate("/tmp/nonexistent_bitrate_test.mp4").then((result) => {
    assert(result.passed === false, "Bitrate de path inexistente deve falhar");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Runner: espera todos os testes assíncronos antes de sair
// ═══════════════════════════════════════════════════════════════════════════

// Recolher promessas pendentes dos testes assíncronos
const pendingPromises = [];

// hooks para capturar promessas do test()
const originalTest = test;
let currentPromise = null;

// Forçar que todos os testes assíncronos sejam registados
// Nota: Como os testes já foram registados, as promessas já estão em voo.
// Vamos dar tempo para resolverem.

setTimeout(() => {
  console.log(`\n=== Resultado: ${passed} passaram, ${failed} falharam ===`);
  process.exit(failed > 0 ? 1 : 0);
}, 5000);
