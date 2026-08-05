#!/usr/bin/env node
/**
 * PARTE 5/11 — Teste: Landmark não domina vídeos gastronómicos
 *
 * Regras testadas:
 * - CONTRACT_DIVERSITY_RULES.gastronomy limita landmarks a 15%
 * - CONTRACT_DIVERSITY_RULES.gastronomy limita aerial a 10%
 * - editorialQaService deteta não-gastronomia > 25%
 * - buildQaDecision falha quando landmark+aerial ultrapassa limite
 * - cobertura por cidade deteta gastronomia baixa
 * - NON_GASTRONOMY_CATEGORIES completo para landmarks
 */

const { buildQaDecision, buildCoverageReport, NON_GASTRONOMY_CATEGORIES, GASTRONOMY_CATEGORIES } = require("../src/services/editorialQaService");
const { resolveContractDiversityRules } = require("../src/services/diversityGuardService");
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
// Regras de diversidade: limites de landmark
// ═══════════════════════════════════════════════════════════════════════════

test("Gastronomia: max_city_landmark_ratio ≤ 0.15", () => {
  const rules = resolveContractDiversityRules({ dominant_theme: "gastronomy" });
  assert(rules.max_city_landmark_ratio <= 0.15,
    `Landmark ratio: ${rules.max_city_landmark_ratio}`);
});

test("Gastronomia: max_aerial_city_ratio ≤ 0.10", () => {
  const rules = resolveContractDiversityRules({ dominant_theme: "gastronomy" });
  assert(rules.max_aerial_city_ratio <= 0.10,
    `Aerial ratio: ${rules.max_aerial_city_ratio}`);
});

test("Default: permite mais landmarks que gastronomia", () => {
  const gastroRules = resolveContractDiversityRules({ dominant_theme: "gastronomy" });
  const defaultRules = resolveContractDiversityRules({ dominant_theme: "travel" });
  assert(defaultRules.max_city_landmark_ratio >= gastroRules.max_city_landmark_ratio,
    "Default deve permitir mais landmarks que gastronomia");
});

// ═══════════════════════════════════════════════════════════════════════════
// NON_GASTRONOMY_CATEGORIES: landmarks
// ═══════════════════════════════════════════════════════════════════════════

test("NON_GASTRONOMY_CATEGORIES: cada categoria de landmark está explicitamente presente", () => {
  const landmarkCategories = ["city_landmark", "aerial_city", "bridge", "river", "coast", "historic_street", "generic_street"];
  landmarkCategories.forEach((cat) => {
    assert(NON_GASTRONOMY_CATEGORIES.has(cat),
      `"${cat}" deve estar em NON_GASTRONOMY_CATEGORIES`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildCoverageReport: deteta dominação de landmark
// ═══════════════════════════════════════════════════════════════════════════

const landmarkDominatedClips = [
  { clip_index: 1, detected_visual_categories: ["city_landmark"], visual_family: "city_landmark|wide|context", source_url: "url1" },
  { clip_index: 2, detected_visual_categories: ["city_landmark", "aerial_city"], visual_family: "aerial|wide|context", source_url: "url2" },
  { clip_index: 3, detected_visual_categories: ["historic_street"], visual_family: "street|medium|context", source_url: "url3" },
  { clip_index: 4, detected_visual_categories: ["bridge", "river"], visual_family: "bridge|wide|context", source_url: "url4" },
  { clip_index: 5, detected_visual_categories: ["food"], visual_family: "food|medium|proof", source_url: "url5" },
];

test("buildCoverageReport: deteta dominação de landmark", () => {
  const report = buildCoverageReport({ clips: landmarkDominatedClips, microMoments: [], visualContract: null });
  // 4/5 clips são não-gastronomia = 80%
  assert(report.non_gastronomy_clips >= 3,
    `Non-gastronomy clips: ${report.non_gastronomy_clips}`);
  assert(report.gastronomy_coverage_ratio <= 0.40,
    `Gastronomy ratio deve ser baixa: ${report.gastronomy_coverage_ratio}`);
  assert(report.landmark_aerial_ratio > 0.20,
    `Landmark/aerial ratio: ${report.landmark_aerial_ratio}`);
});

test("buildQaDecision: falha com dominação de landmark", () => {
  const report = buildCoverageReport({ clips: landmarkDominatedClips, microMoments: [], visualContract: null });
  const decision = buildQaDecision({
    coverageReport: report,
    visualAudit: [],
    state: {
      visual_contract: { dominant_theme: "gastronomy", video_topic: "Portugal gastronómico", cities: ["Lisboa", "Porto"] },
      render_timeline: { output_resolution: "1920x1080" },
    },
  });

  // Deve falhar por gastronomy_coverage baixo e/ou non_gastronomy alto
  assert(decision.passed === false,
    `Deveria falhar com dominação de landmark. Passou=${decision.passed}, falhas=${JSON.stringify(decision.failures)}`);
});

const balancedGastronomyClips = [
  { clip_index: 1, detected_visual_categories: ["food", "restaurant"], visual_family: "food|medium|proof", source_url: "url1" },
  { clip_index: 2, detected_visual_categories: ["market", "food"], visual_family: "market|wide|proof", source_url: "url2" },
  { clip_index: 3, detected_visual_categories: ["wine", "restaurant"], visual_family: "wine|medium|proof", source_url: "url3" },
  { clip_index: 4, detected_visual_categories: ["pastry", "cafe"], visual_family: "pastry|medium|proof", source_url: "url4" },
  { clip_index: 5, detected_visual_categories: ["food", "people_eating"], visual_family: "food|wide|proof", source_url: "url5" },
  { clip_index: 6, detected_visual_categories: ["restaurant", "people_eating"], visual_family: "restaurant|medium|proof", source_url: "url6" },
  { clip_index: 7, detected_visual_categories: ["food", "local_food"], visual_family: "food|medium|proof", source_url: "url7" },
  { clip_index: 8, detected_visual_categories: ["city_landmark"], visual_family: "landmark|wide|context", source_url: "url8" },
];

test("buildCoverageReport: vídeo equilibrado passa", () => {
  const report = buildCoverageReport({ clips: balancedGastronomyClips, microMoments: [], visualContract: null });
  // 7/8 clips com food = 87.5%
  assert(report.gastronomy_coverage_ratio >= 0.75,
    `Gastronomy ratio: ${report.gastronomy_coverage_ratio}`);
  // Landmark/aerial ≤ 1/8 ≈ 12.5%
  assert(report.non_gastronomy_combined_ratio <= 0.25,
    `Non-gastronomy combined: ${report.non_gastronomy_combined_ratio}`);
});

test("buildQaDecision: vídeo equilibrado de gastronomia passa", () => {
  const report = buildCoverageReport({ clips: balancedGastronomyClips, microMoments: [], visualContract: null });
  const decision = buildQaDecision({
    coverageReport: report,
    visualAudit: [],
    state: {
      visual_contract: { dominant_theme: "gastronomy", video_topic: "Portugal gastronómico", cities: ["Lisboa", "Porto"] },
      render_timeline: { output_resolution: "1920x1080" },
      approved_visual_evidence_pool: [{ asset_id: "1" }],
    },
  });

  assert(decision.passed === true,
    `Deveria passar com alta cobertura gastronómica. Falhas: ${JSON.stringify(decision.failures)}`);
});

// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n=== Resultado: ${passed} passaram, ${failed} falharam ===`);
process.exit(failed > 0 ? 1 : 0);
