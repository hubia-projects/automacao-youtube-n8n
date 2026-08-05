#!/usr/bin/env node
/**
 * PARTE 5/11 — Teste: Visual Family — sem repetições consecutivas
 *
 * Regras testadas:
 * - CONTRACT_DIVERSITY_RULES.gastronomy: max_consecutive_visual_family = 2
 * - applyContractDiversityRules deteta 3+ consecutivas
 * - buildCoverageReport conta consecutive_visual_family_repeats
 * - buildQaDecision falha quando > 2 repetições consecutivas
 */

const {
  resolveContractDiversityRules,
  applyContractDiversityRules,
} = require("../src/services/diversityGuardService");
const { buildCoverageReport, buildQaDecision } = require("../src/services/editorialQaService");
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
// CONTRACT_DIVERSITY_RULES: max_consecutive_visual_family
// ═══════════════════════════════════════════════════════════════════════════

test("Gastronomia: max_consecutive_visual_family = 2", () => {
  const rules = resolveContractDiversityRules({ dominant_theme: "gastronomy" });
  assert(rules.max_consecutive_visual_family === 2,
    `max_consecutive: ${rules.max_consecutive_visual_family}`);
});

test("Default: max_consecutive_visual_family = 3", () => {
  const rules = resolveContractDiversityRules(null);
  assert(rules.max_consecutive_visual_family === 3,
    `max_consecutive default: ${rules.max_consecutive_visual_family}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// applyContractDiversityRules: deteta repetições
// ═══════════════════════════════════════════════════════════════════════════

test("applyContractDiversityRules: 3 mesma visual_family consecutivas → violação", () => {
  const result = applyContractDiversityRules({
    candidate: {
      asset_id: "asset_c",
      visual_family: "city_landmark|wide|context",
      source_url: "https://example.com/c.mp4",
    },
    clips: [
      { asset_id: "a1", visual_family: "city_landmark|wide|context", source_url: "url_a" },
      { asset_id: "a2", visual_family: "city_landmark|wide|context", source_url: "url_b" },
    ],
    visualContract: { dominant_theme: "gastronomy" },
  });
  assert(result.passed === false,
    "3 consecutivas da mesma visual_family devem falhar");
  assert(result.violations.includes("contract_consecutive_visual_family"),
    `Violations: ${result.violations.join(", ")}`);
});

test("applyContractDiversityRules: 2 visual_families iguais com ratio baixo → passa", () => {
  // 9 clips com famílias diferentes + 1 mesma = ratio 1/10 = 0.10 < 0.12
  const result = applyContractDiversityRules({
    candidate: {
      asset_id: "asset_d",
      visual_family: "food_closeup|medium|proof",
      source_url: "https://example.com/d.mp4",
    },
    clips: [
      { asset_id: "a0", visual_family: "f0", source_url: "u0" },
      { asset_id: "a1", visual_family: "f1", source_url: "u1" },
      { asset_id: "a2", visual_family: "f2", source_url: "u2" },
      { asset_id: "a3", visual_family: "f3", source_url: "u3" },
      { asset_id: "a4", visual_family: "f4", source_url: "u4" },
      { asset_id: "a5", visual_family: "f5", source_url: "u5" },
      { asset_id: "a6", visual_family: "f6", source_url: "u6" },
      { asset_id: "a7", visual_family: "f7", source_url: "u7" },
      { asset_id: "a8", visual_family: "food_closeup|medium|proof", source_url: "url_x" },
    ],
    visualContract: { dominant_theme: "gastronomy" },
  });
  assert(result.passed === true,
    `2 iguais com ratio baixo devem passar: ${result.violations.join(", ")}`);
});

test("applyContractDiversityRules: famílias diferentes → passa", () => {
  const result = applyContractDiversityRules({
    candidate: {
      asset_id: "asset_e",
      visual_family: "food_closeup|medium|proof",
      source_url: "https://example.com/e.mp4",
    },
    clips: [
      { asset_id: "a1", visual_family: "market_stall|wide|proof", source_url: "url_market" },
      { asset_id: "a2", visual_family: "wine_pouring|medium|proof", source_url: "url_wine" },
    ],
    visualContract: { dominant_theme: "gastronomy" },
  });
  assert(result.passed === true,
    `Famílias diferentes devem passar: ${result.violations.join(", ")}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// buildCoverageReport: consecutive_visual_family_repeats
// ═══════════════════════════════════════════════════════════════════════════

const repeatedFamilyClips = [
  { clip_index: 1, detected_visual_categories: ["city_landmark"], visual_family: "city_landmark|wide|context", source_url: "url1" },
  { clip_index: 2, detected_visual_categories: ["city_landmark"], visual_family: "city_landmark|wide|context", source_url: "url2" },
  { clip_index: 3, detected_visual_categories: ["city_landmark"], visual_family: "city_landmark|wide|context", source_url: "url3" },
  { clip_index: 4, detected_visual_categories: ["city_landmark"], visual_family: "city_landmark|wide|context", source_url: "url4" },
];

test("buildCoverageReport: deteta 3+ repetições consecutivas", () => {
  const report = buildCoverageReport({ clips: repeatedFamilyClips, microMoments: [], visualContract: null });
  assert(report.consecutive_visual_family_repeats >= 3,
    `consecutive repeats: ${report.consecutive_visual_family_repeats}`);
});

const variedFamilyClips = [
  { clip_index: 1, detected_visual_categories: ["food"], visual_family: "food|medium|proof", source_url: "url1" },
  { clip_index: 2, detected_visual_categories: ["market"], visual_family: "market|wide|proof", source_url: "url2" },
  { clip_index: 3, detected_visual_categories: ["wine"], visual_family: "wine|medium|proof", source_url: "url3" },
  { clip_index: 4, detected_visual_categories: ["restaurant"], visual_family: "restaurant|medium|proof", source_url: "url4" },
];

test("buildCoverageReport: famílias variadas → 0 repetições", () => {
  const report = buildCoverageReport({ clips: variedFamilyClips, microMoments: [], visualContract: null });
  assert(report.consecutive_visual_family_repeats === 0,
    `consecutive repeats com famílias variadas: ${report.consecutive_visual_family_repeats}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// buildQaDecision
// ═══════════════════════════════════════════════════════════════════════════

test("buildQaDecision: falha com > 2 consecutivas", () => {
  const report = buildCoverageReport({ clips: repeatedFamilyClips, microMoments: [], visualContract: null });
  const decision = buildQaDecision({
    coverageReport: report,
    visualAudit: [],
    state: {
      visual_contract: { dominant_theme: "gastronomy", video_topic: "Portugal gastronómico", cities: ["Lisboa"] },
      render_timeline: { output_resolution: "1920x1080" },
      approved_visual_evidence_pool: [{ asset_id: "1" }],
    },
  });

  const hasConsecutiveFamilyFail = decision.failures.some(
    (f) => f.rule === "max_consecutive_visual_family"
  );
  assert(hasConsecutiveFamilyFail || decision.passed === false,
    `Deve falhar por consecutivas. Failures: ${JSON.stringify(decision.failures)}`);
});

test("buildQaDecision: passa sem repetições consecutivas", () => {
  const report = buildCoverageReport({ clips: variedFamilyClips, microMoments: [], visualContract: null });
  const decision = buildQaDecision({
    coverageReport: report,
    visualAudit: [],
    state: {
      visual_contract: { dominant_theme: "gastronomy", video_topic: "Portugal gastronómico", cities: ["Lisboa"] },
      render_timeline: { output_resolution: "1920x1080" },
      approved_visual_evidence_pool: [{ asset_id: "1" }],
    },
  });

  const consecutiveFail = decision.failures.some(
    (f) => f.rule === "max_consecutive_visual_family"
  );
  assert(!consecutiveFail,
    `Não deve ter falha de consecutivas. Failures: ${JSON.stringify(decision.failures)}`);
});

// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n=== Resultado: ${passed} passaram, ${failed} falharam ===`);
process.exit(failed > 0 ? 1 : 0);
