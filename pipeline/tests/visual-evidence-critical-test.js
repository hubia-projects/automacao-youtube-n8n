#!/usr/bin/env node
/**
 * PARTE 4 — Teste: Visual Evidence Approval — Slots críticos
 *
 * Regras testadas:
 * - metadata_fallback nunca aprova slot crítico
 * - WEAK_EVIDENCE_SOURCES completo
 * - forbidden categories → wrong
 * - exact evidence = all required found + real vision
 * - regional = partial evidence + real vision
 * - generic = real vision but no required evidence
 * - weak source sem evidência = unknown
 */

const { classifyVisualTruth, WEAK_EVIDENCE_SOURCES } = require("../src/services/visualEvidenceApprovalService");
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
// WEAK_EVIDENCE_SOURCES
// ═══════════════════════════════════════════════════════════════════════════

test("WEAK_EVIDENCE_SOURCES contém todas as origens fracas", () => {
  assert(WEAK_EVIDENCE_SOURCES.has("metadata_fallback"), "metadata_fallback");
  assert(WEAK_EVIDENCE_SOURCES.has("weak_fallback"), "weak_fallback");
  assert(WEAK_EVIDENCE_SOURCES.has("disabled"), "disabled");
  assert(WEAK_EVIDENCE_SOURCES.has("script_missing"), "script_missing");
  assert(WEAK_EVIDENCE_SOURCES.has("local_video_understanding_fallback"), "local_video_understanding_fallback");
});

// ═══════════════════════════════════════════════════════════════════════════
// Slot crítico + metadata_fallback = unknown
// ═══════════════════════════════════════════════════════════════════════════

test("metadata_fallback em slot crítico → unknown", () => {
  const result = classifyVisualTruth({
    asset: { analysis_provider: "metadata_fallback" },
    window: {
      visual_evidence_source: "metadata_fallback",
      required_evidence_found: [],
      detected_visual_categories: ["city_landmark"],
    },
    scene: {
      criticality: "critical",
      required_visual_evidence: ["food", "market"],
      forbidden_visual_categories: [],
    },
  });
  assert(result.visual_truth_status === "unknown",
    `metadata_fallback crítico deveria ser unknown, foi "${result.visual_truth_status}"`);
  assert(result.reason.includes("weak_evidence_source"),
    `Razão deveria mencionar weak source: "${result.reason}"`);
});

test("weak_fallback em slot crítico → unknown", () => {
  const result = classifyVisualTruth({
    asset: { analysis_provider: "weak_fallback" },
    window: {
      visual_evidence_source: "weak_fallback",
      required_evidence_found: [],
      detected_visual_categories: [],
    },
    scene: {
      criticality: "critical",
      required_visual_evidence: ["food"],
    },
  });
  assert(result.visual_truth_status === "unknown",
    `weak_fallback crítico deveria ser unknown: "${result.visual_truth_status}"`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Forbidden categories
// ═══════════════════════════════════════════════════════════════════════════

test("Forbidden categories → wrong", () => {
  const result = classifyVisualTruth({
    asset: { analysis_provider: "openai_vision" },
    window: {
      visual_evidence_source: "openai_vision",
      required_evidence_found: ["food"],
      detected_visual_categories: ["food", "aerial_city", "bridge"],
    },
    scene: {
      criticality: "critical",
      required_visual_evidence: ["food"],
      forbidden_visual_categories: ["aerial_city", "bridge", "river"],
    },
  });
  assert(result.visual_truth_status === "wrong",
    `Forbidden deveria ser wrong: "${result.visual_truth_status}"`);
  assert(result.reason === "forbidden_visual_category_detected",
    `Razão: "${result.reason}"`);
});

test("Forbidden categories deteta múltiplas", () => {
  const result = classifyVisualTruth({
    asset: { analysis_provider: "gemini_vision" },
    window: {
      visual_evidence_source: "gemini_vision",
      required_evidence_found: [],
      detected_visual_categories: ["aerial_city", "bridge", "river", "coast"],
    },
    scene: {
      criticality: "critical",
      required_visual_evidence: ["food"],
      forbidden_visual_categories: ["aerial_city", "bridge", "river", "coast", "city_landmark"],
    },
  });
  assert(result.visual_truth_status === "wrong", "Deveria ser wrong");
  assert(result.forbidden_categories.length >= 3,
    `Pelo menos 3 forbidden detectadas: ${result.forbidden_categories.length}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Exact evidence
// ═══════════════════════════════════════════════════════════════════════════

test("Evidência completa + real vision → exact", () => {
  const result = classifyVisualTruth({
    asset: { analysis_provider: "gemini_vision" },
    window: {
      visual_evidence_source: "gemini_vision",
      required_evidence_found: ["food", "restaurant", "people_eating"],
      detected_visual_categories: ["food", "restaurant", "people_eating"],
    },
    scene: {
      criticality: "critical",
      required_visual_evidence: ["food", "restaurant"],
      forbidden_visual_categories: ["aerial_city"],
    },
  });
  assert(result.visual_truth_status === "exact",
    `Deveria ser exact: "${result.visual_truth_status}"`);
  assert(result.editorial_confidence >= 0.9,
    `Confiança deveria ser alta: ${result.editorial_confidence}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Regional evidence
// ═══════════════════════════════════════════════════════════════════════════

test("Evidência parcial + real vision → regional", () => {
  const result = classifyVisualTruth({
    asset: { analysis_provider: "openai_vision" },
    window: {
      visual_evidence_source: "openai_vision",
      required_evidence_found: ["food"],
      detected_visual_categories: ["food", "historic_street"],
    },
    scene: {
      criticality: "supporting",
      required_visual_evidence: ["food", "restaurant"],
      forbidden_visual_categories: ["aerial_city"],
    },
  });
  assert(result.visual_truth_status === "regional",
    `Deveria ser regional: "${result.visual_truth_status}"`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Generic evidence
// ═══════════════════════════════════════════════════════════════════════════

test("Real vision sem required evidence → generic", () => {
  const result = classifyVisualTruth({
    asset: { analysis_provider: "gemini_vision" },
    window: {
      visual_evidence_source: "gemini_vision",
      required_evidence_found: [],
      detected_visual_categories: ["city_landmark", "historic_street"],
    },
    scene: {
      criticality: "supporting",
      required_visual_evidence: ["food"],
      forbidden_visual_categories: [],
    },
  });
  assert(result.visual_truth_status === "generic",
    `Deveria ser generic: "${result.visual_truth_status}"`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Disabled source
// ═══════════════════════════════════════════════════════════════════════════

test("disabled source → unknown", () => {
  const result = classifyVisualTruth({
    asset: { analysis_provider: "disabled" },
    window: {
      visual_evidence_source: "disabled",
      required_evidence_found: [],
      detected_visual_categories: [],
    },
    scene: {
      criticality: "supporting",
      required_visual_evidence: [],
    },
  });
  assert(result.visual_truth_status === "unknown",
    `Deveria ser unknown: "${result.visual_truth_status}"`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Non-critical slot + metadata_fallback
// ═══════════════════════════════════════════════════════════════════════════

test("metadata_fallback em slot NÃO-crítico → unknown", () => {
  const result = classifyVisualTruth({
    asset: { analysis_provider: "metadata_fallback" },
    window: {
      visual_evidence_source: "metadata_fallback",
      required_evidence_found: [],
      detected_visual_categories: [],
    },
    scene: {
      criticality: "supporting",
      required_visual_evidence: [],
    },
  });
  // Mesmo não-crítico, metadata_fallback = unknown
  assert(result.visual_truth_status === "unknown",
    `metadata_fallback deveria ser unknown: "${result.visual_truth_status}"`);
});

// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n=== Resultado: ${passed} passaram, ${failed} falharam ===`);
process.exit(failed > 0 ? 1 : 0);
