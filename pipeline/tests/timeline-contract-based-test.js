#!/usr/bin/env node
/**
 * PARTE 5 — Teste: Timeline baseada em contrato visual
 *
 * Regras testadas:
 * - CONTRACT_DIVERSITY_RULES para gastronomia vs default
 * - resolveContractDiversityRules retorna regras corretas
 * - applyContractDiversityRules valida asset/source_url/family
 * - filterCandidatesByHardDiversity aplica regras
 * - max_consecutive_visual_family = 2 para gastronomia
 * - max_same_asset_uses = 1 para gastronomia
 * - max_same_source_url_uses = 1 para gastronomia
 */

const {
  resolveContractDiversityRules,
  applyContractDiversityRules,
  filterCandidatesByHardDiversity,
  enrichCandidateIdentity,
  CONTRACT_DIVERSITY_RULES,
} = require("../src/services/diversityGuardService");
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
// CONTRACT_DIVERSITY_RULES
// ═══════════════════════════════════════════════════════════════════════════

test("Gastronomia: max_same_asset_uses = 1", () => {
  assert(CONTRACT_DIVERSITY_RULES.gastronomy.max_same_asset_uses === 1);
});

test("Gastronomia: max_same_source_url_uses = 1", () => {
  assert(CONTRACT_DIVERSITY_RULES.gastronomy.max_same_source_url_uses === 1);
});

test("Gastronomia: max_consecutive_visual_family = 2", () => {
  assert(CONTRACT_DIVERSITY_RULES.gastronomy.max_consecutive_visual_family === 2);
});

test("Gastronomia: max_city_landmark_ratio = 0.15", () => {
  assert(CONTRACT_DIVERSITY_RULES.gastronomy.max_city_landmark_ratio === 0.15);
});

test("Gastronomia: max_aerial_city_ratio = 0.10", () => {
  assert(CONTRACT_DIVERSITY_RULES.gastronomy.max_aerial_city_ratio === 0.10);
});

test("Default: max_same_asset_uses >= 2", () => {
  assert(CONTRACT_DIVERSITY_RULES.default.max_same_asset_uses >= 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveContractDiversityRules
// ═══════════════════════════════════════════════════════════════════════════

test("resolveContractDiversityRules: gastronomy", () => {
  const rules = resolveContractDiversityRules({
    dominant_theme: "gastronomy",
    video_topic: "Portugal gastronómico",
  });
  assert(rules.max_same_asset_uses === 1, "gastronomy deve ter max 1 asset");
  assert(rules.max_same_source_url_uses === 1, "gastronomy deve ter max 1 source_url");
});

test("resolveContractDiversityRules: null → default", () => {
  const rules = resolveContractDiversityRules(null);
  assert(rules.max_same_asset_uses >= 2, "null deve usar default");
});

test("resolveContractDiversityRules: tema não-gastronomia → default", () => {
  const rules = resolveContractDiversityRules({
    dominant_theme: "travel",
    video_topic: "Viagem a Portugal",
  });
  assert(rules.max_same_asset_uses >= 2, "travel deve usar default");
});

// ═══════════════════════════════════════════════════════════════════════════
// applyContractDiversityRules
// ═══════════════════════════════════════════════════════════════════════════

test("applyContractDiversityRules: asset não repetido → passa", () => {
  const result = applyContractDiversityRules({
    candidate: {
      asset_id: "asset_novo",
      visual_family: "food_closeup|medium|proof",
      source_url: "https://example.com/novo.mp4",
    },
    clips: [
      { asset_id: "asset_velho", visual_family: "market_stall|wide|proof", source_url: "https://example.com/velho.mp4" },
    ],
    visualContract: { dominant_theme: "gastronomy" },
  });
  assert(result.passed === true, `Deveria passar: ${result.violations.join(", ")}`);
});

test("applyContractDiversityRules: asset repetido → falha", () => {
  const result = applyContractDiversityRules({
    candidate: {
      asset_id: "asset_x",
      visual_family: "food_closeup|medium|proof",
      source_url: "https://example.com/a.mp4",
    },
    clips: [
      { asset_id: "asset_x", visual_family: "food_closeup|medium|proof", source_url: "https://example.com/a.mp4" },
    ],
    visualContract: { dominant_theme: "gastronomy" },
  });
  assert(result.passed === false, "Asset repetido deveria falhar");
  assert(result.violations.includes("contract_max_asset_uses"),
    `Violations: ${result.violations.join(", ")}`);
});

test("applyContractDiversityRules: source_url repetido → falha", () => {
  const result = applyContractDiversityRules({
    candidate: {
      asset_id: "asset_b",
      visual_family: "food_closeup|medium|proof",
      source_url: "https://example.com/repeated.mp4",
    },
    clips: [
      { asset_id: "asset_a", source_url: "https://example.com/repeated.mp4", visual_family: "other" },
    ],
    visualContract: { dominant_theme: "gastronomy" },
  });
  assert(result.passed === false, "Source_url repetido deveria falhar");
});

test("applyContractDiversityRules: 3 mesma visual_family consecutivas → falha", () => {
  const result = applyContractDiversityRules({
    candidate: {
      asset_id: "asset_d",
      visual_family: "same_family",
      source_url: "https://example.com/d.mp4",
    },
    clips: [
      { visual_family: "same_family", source_url: "url1", asset_id: "a1" },
      { visual_family: "same_family", source_url: "url2", asset_id: "a2" },
    ],
    visualContract: { dominant_theme: "gastronomy" },
  });
  assert(result.passed === false,
    "3 visual_families iguais consecutivas deveria falhar");
  assert(result.violations.includes("contract_consecutive_visual_family"),
    `Violations: ${result.violations.join(", ")}`);
});

test("applyContractDiversityRules: sem visualContract → regras default (asset repetido uma vez passa)", () => {
  const result = applyContractDiversityRules({
    candidate: {
      asset_id: "asset_y",
      visual_family: "unique_family_y",
      source_url: "https://example.com/y.mp4",
    },
    clips: [
      { asset_id: "asset_y", visual_family: "different_family", source_url: "https://example.com/y.mp4" },
    ],
    visualContract: null,
  });
  // Default permite até 2 usos do mesmo asset e source_url;
  // visual_family é diferente → passa
  assert(result.passed === true,
    `Default deveria permitir 1 reuso com families diferentes: ${result.violations.join(", ")}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// filterCandidatesByHardDiversity
// ═══════════════════════════════════════════════════════════════════════════

test("filterCandidatesByHardDiversity: candidato único passa", () => {
  const result = filterCandidatesByHardDiversity({
    candidates: [{
      asset_id: "unique_asset",
      visual_family: "food",
      source_url: "unique_url",
    }],
    clips: [],
    block: { block_id: "block_1", scene_index: 1 },
    slotRole: "proof_exact",
    criticalSlot: false,
  });
  assert(result.allowed_candidates.length === 1, "Candidato único deve passar");
  assert(result.bypass_required === false, "Não deve precisar de bypass");
});

test("filterCandidatesByHardDiversity: candidato repetido é bloqueado", () => {
  const enriched = enrichCandidateIdentity({
    candidate: {
      asset_id: "repeated",
      visual_family: "food",
      source_url: "url1",
    },
    slotRole: "proof_exact",
    block: { block_id: "block_2" },
  });

  const result = filterCandidatesByHardDiversity({
    candidates: [enriched],
    clips: [{
      macro_block_id: "parent",
      block_id: "block_2",
      source_asset_id: "repeated",
      visual_family: "food",
      source_url: "url1",
    }],
    block: { block_id: "block_2", macro_block_id: "parent", scene_index: 1 },
    slotRole: "proof_exact",
    criticalSlot: false,
  });
  // Candidato repetido no mesmo bloco: allowed_candidates deve estar vazio
  // OU bypass_required === true (se o sistema decidir deixar passar com aviso)
  assert(result.allowed_candidates.length === 0,
    `Candidato repetido deve ser bloqueado. allowed=${result.allowed_candidates.length}, bypass=${result.bypass_required}`);
});

// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n=== Resultado: ${passed} passaram, ${failed} falharam ===`);
process.exit(failed > 0 ? 1 : 0);
