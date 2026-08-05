#!/usr/bin/env node
/**
 * PARTE 6 — Teste: Editorial QA — Gastronomia
 *
 * Regras testadas:
 * - classifyGastronomyCoverage classifica corretamente
 * - GASTRONOMY_CATEGORIES e NON_GASTRONOMY_CATEGORIES
 * - buildCoverageReport calcula rácios corretos
 * - buildQaDecision falha quando gastronomy_coverage < 70%
 * - buildQaDecision falha quando non_gastronomy > 25%
 * - buildQaDecision falha quando source_url repetido
 * - buildQaDecision falha quando missing_visual_contract
 * - buildVisualAudit gera entradas com is_midpoint
 */

const {
  buildVisualAudit,
  buildCoverageReport,
  buildQaDecision,
  classifyGastronomyCoverage,
  GASTRONOMY_CATEGORIES,
  NON_GASTRONOMY_CATEGORIES,
} = require("../src/services/editorialQaService");
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
// classifyGastronomyCoverage
// ═══════════════════════════════════════════════════════════════════════════

test("classifyGastronomyCoverage: gastronomy_evidence", () => {
  assert(classifyGastronomyCoverage(["food", "restaurant"]) === "gastronomy_evidence");
  assert(classifyGastronomyCoverage(["market", "wine", "people_eating"]) === "gastronomy_evidence");
});

test("classifyGastronomyCoverage: non_gastronomy", () => {
  assert(classifyGastronomyCoverage(["city_landmark", "aerial_city"]) === "non_gastronomy");
  assert(classifyGastronomyCoverage(["bridge", "river", "coast"]) === "non_gastronomy");
});

test("classifyGastronomyCoverage: mixed", () => {
  assert(classifyGastronomyCoverage(["food", "city_landmark"]) === "mixed");
});

test("classifyGastronomyCoverage: unclassified", () => {
  assert(classifyGastronomyCoverage([]) === "unclassified");
  assert(classifyGastronomyCoverage(["unknown_category"]) === "unclassified");
});

// ═══════════════════════════════════════════════════════════════════════════
// GASTRONOMY_CATEGORIES e NON_GASTRONOMY_CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════

test("GASTRONOMY_CATEGORIES tem todas as categorias de comida", () => {
  assert(GASTRONOMY_CATEGORIES.has("food"), "food");
  assert(GASTRONOMY_CATEGORIES.has("market"), "market");
  assert(GASTRONOMY_CATEGORIES.has("wine"), "wine");
  assert(GASTRONOMY_CATEGORIES.has("pastry"), "pastry");
  assert(GASTRONOMY_CATEGORIES.has("restaurant"), "restaurant");
  assert(GASTRONOMY_CATEGORIES.has("cafe"), "cafe");
  assert(GASTRONOMY_CATEGORIES.has("street_food"), "street_food");
  assert(GASTRONOMY_CATEGORIES.has("people_eating"), "people_eating");
  assert(GASTRONOMY_CATEGORIES.has("local_food"), "local_food");
});

test("NON_GASTRONOMY_CATEGORIES tem todas as de não-comida", () => {
  assert(NON_GASTRONOMY_CATEGORIES.has("city_landmark"), "city_landmark");
  assert(NON_GASTRONOMY_CATEGORIES.has("aerial_city"), "aerial_city");
  assert(NON_GASTRONOMY_CATEGORIES.has("bridge"), "bridge");
  assert(NON_GASTRONOMY_CATEGORIES.has("river"), "river");
  assert(NON_GASTRONOMY_CATEGORIES.has("coast"), "coast");
  assert(NON_GASTRONOMY_CATEGORIES.has("generic_street"), "generic_street");
});

// ═══════════════════════════════════════════════════════════════════════════
// buildCoverageReport
// ═══════════════════════════════════════════════════════════════════════════

const mockClips = [
  { clip_index: 1, detected_visual_categories: ["food", "restaurant"], visual_family: "food_closeup|medium|proof", source_url: "url1" },
  { clip_index: 2, detected_visual_categories: ["market", "food"], visual_family: "market_stall|wide|proof", source_url: "url2" },
  { clip_index: 3, detected_visual_categories: ["city_landmark", "aerial_city"], visual_family: "city_landmark|wide|context", source_url: "url3" },
  { clip_index: 4, detected_visual_categories: ["food", "people_eating"], visual_family: "food_closeup|medium|proof", source_url: "url4" },
  { clip_index: 5, detected_visual_categories: ["wine", "restaurant"], visual_family: "wine_pouring|medium|proof", source_url: "url5" },
];

test("buildCoverageReport: 5 clips mistos", () => {
  const report = buildCoverageReport({ clips: mockClips, microMoments: [], visualContract: null });
  assert(report.total_clips === 5, `Total: ${report.total_clips}`);
  // 4 clips com food evidence (1,2,4,5) — clip 3 é non_gastronomy
  assert(report.gastronomy_clips >= 3,
    `Gastronomy clips: ${report.gastronomy_clips}`);
  assert(report.non_gastronomy_clips >= 1,
    `Non-gastronomy clips: ${report.non_gastronomy_clips}`);
});

test("buildCoverageReport: gastronomy_coverage_ratio", () => {
  const report = buildCoverageReport({ clips: mockClips, microMoments: [], visualContract: null });
  assert(report.gastronomy_coverage_ratio >= 0.60,
    `Gastronomy ratio: ${report.gastronomy_coverage_ratio}`);
});

test("buildCoverageReport: non_gastronomy_combined_ratio é número >= 0", () => {
  const report = buildCoverageReport({ clips: mockClips, microMoments: [], visualContract: null });
  assert(typeof report.non_gastronomy_combined_ratio === "number",
    "non_gastronomy_combined_ratio deve ser número");
  assert(!isNaN(report.non_gastronomy_combined_ratio),
    "non_gastronomy_combined_ratio não deve ser NaN");
  assert(report.non_gastronomy_combined_ratio >= 0,
    `Deve ser >= 0: ${report.non_gastronomy_combined_ratio}`);
});

test("buildCoverageReport: repeated_source_urls deteta repetições", () => {
  const clipsWithRepeat = [
    { clip_index: 1, detected_visual_categories: ["food"], visual_family: "f1", source_url: "url_repeat" },
    { clip_index: 2, detected_visual_categories: ["food"], visual_family: "f2", source_url: "url_repeat" },
  ];
  const report = buildCoverageReport({ clips: clipsWithRepeat, microMoments: [], visualContract: null });
  assert(report.repeated_source_urls >= 1,
    `Source URLs repetidos: ${report.repeated_source_urls}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// buildQaDecision
// ═══════════════════════════════════════════════════════════════════════════

const mockVisualContract = {
  dominant_theme: "gastronomy",
  video_topic: "Portugal gastronómico: sabores de Lisboa e Porto",
  cities: ["Lisboa", "Porto"],
};

const highCoverageReport = {
  total_clips: 10,
  gastronomy_coverage_ratio: 0.85,
  non_gastronomy_combined_ratio: 0.10,
  consecutive_visual_family_repeats: 1,
  repeated_source_urls: 0,
  repeated_visual_families: 0,
  repeated_landmarks: 0,
  coverage_by_city: {},
};

test("buildQaDecision: passa com cobertura alta", () => {
  const decision = buildQaDecision({
    coverageReport: highCoverageReport,
    visualAudit: [],
    state: {
      visual_contract: mockVisualContract,
      render_timeline: { output_resolution: "1920x1080" },
      caption_path_srt: null,
      approved_visual_evidence_pool: [{ asset_id: "1" }],
    },
  });
  assert(decision.passed === true,
    `Deveria passar: ${JSON.stringify(decision.failures)}`);
});

test("buildQaDecision: falha com gastronomy_coverage < 0.70", () => {
  const lowCoverage = { ...highCoverageReport, gastronomy_coverage_ratio: 0.35, non_gastronomy_combined_ratio: 0.40 };
  const decision = buildQaDecision({
    coverageReport: lowCoverage,
    visualAudit: [],
    state: {
      visual_contract: mockVisualContract,
      render_timeline: { output_resolution: "1920x1080" },
    },
  });
  assert(decision.passed === false, "Deveria falhar com cobertura baixa");
  assert(decision.failures.some((f) => f.rule === "gastronomy_coverage_minimum"),
    "Deve ter falha gastronomy_coverage_minimum");
});

test("buildQaDecision: falha com non_gastronomy > 25%", () => {
  const highNonFood = { ...highCoverageReport, non_gastronomy_combined_ratio: 0.35, gastronomy_coverage_ratio: 0.55 };
  const decision = buildQaDecision({
    coverageReport: highNonFood,
    visualAudit: [],
    state: {
      visual_contract: mockVisualContract,
      render_timeline: { output_resolution: "1920x1080" },
    },
  });
  assert(decision.passed === false, "Deveria falhar com non_gastronomy alto");
  assert(decision.failures.some((f) => f.rule === "gastronomy_coverage_minimum" || f.rule === "max_non_gastronomy_coverage"),
    `Falhas: ${JSON.stringify(decision.failures)}`);
});

test("buildQaDecision: falha com source_url repetido", () => {
  const withRepeats = { ...highCoverageReport, repeated_source_urls: 2 };
  const decision = buildQaDecision({
    coverageReport: withRepeats,
    visualAudit: [],
    state: {
      visual_contract: mockVisualContract,
      render_timeline: { output_resolution: "1920x1080" },
    },
  });
  assert(decision.failures.some((f) => f.rule === "no_source_url_repetition"),
    "Deve falhar por source_url repetido");
});

test("buildQaDecision: falha sem visual_contract", () => {
  const decision = buildQaDecision({
    coverageReport: highCoverageReport,
    visualAudit: [],
    state: { render_timeline: { output_resolution: "1920x1080" } },
  });
  assert(decision.failures.some((f) => f.rule === "missing_visual_contract"),
    "Deve falhar sem visual_contract");
});

test("buildQaDecision: gera warnings para approved pool vazio", () => {
  const decision = buildQaDecision({
    coverageReport: highCoverageReport,
    visualAudit: [],
    state: {
      visual_contract: mockVisualContract,
      render_timeline: { output_resolution: "1920x1080" },
      approved_visual_evidence_pool: [],
    },
  });
  assert(decision.warnings.some((w) => w.rule === "missing_approved_evidence_pool"),
    `Warnings: ${JSON.stringify(decision.warnings)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// buildVisualAudit
// ═══════════════════════════════════════════════════════════════════════════

test("buildVisualAudit: gera entradas com is_midpoint", () => {
  const audit = buildVisualAudit({ clips: mockClips, microMoments: [], visualContract: null });
  assert(audit.length > 0, "Audit deve ter entradas");
  const midpoints = audit.filter((r) => r.is_midpoint);
  assert(midpoints.length === mockClips.length,
    `Deve ter ${mockClips.length} midpoints, tem ${midpoints.length}`);
});

test("buildVisualAudit: entradas têm campos obrigatórios", () => {
  const audit = buildVisualAudit({ clips: mockClips.slice(0, 2), microMoments: [], visualContract: null });
  assert(audit.length > 0, "Deve ter entradas");
  const entry = audit[0];
  assert(typeof entry.timestamp_sec === "number", "timestamp_sec");
  assert(typeof entry.clip_index === "number", "clip_index");
  assert(typeof entry.visual_truth_status === "string", "visual_truth_status");
  assert(typeof entry.is_match === "boolean", "is_match");
});

// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n=== Resultado: ${passed} passaram, ${failed} falharam ===`);
process.exit(failed > 0 ? 1 : 0);
