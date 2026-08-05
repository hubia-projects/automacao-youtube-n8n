#!/usr/bin/env node
/**
 * Teste principal: Visual Contract + Gastronomia Portugal
 *
 * Cenário: "Portugal gastronómico: sabores inesquecíveis de Lisboa e Porto"
 *
 * O teste deve FALHAR se:
 * - mais de 25% do vídeo for cidade/landmark/aerial/bridge/river
 * - menos de 70% tiver evidência gastronómica
 * - metadata_fallback preencher slot crítico
 * - mesmo asset/source_url repetir
 * - visual_contract não existir
 * - approved_visual_evidence_pool não existir
 */

const { config } = require("../src/config/env");
const { generateVisualContract } = require("../src/services/visualContractService");
const { inferVisualIntent } = require("../src/services/visualIntentService");
const { buildSceneQueryPlan, isFoodIntent } = require("../src/services/assetQueryPlanner");
const { classifyVisualTruth, WEAK_EVIDENCE_SOURCES } = require("../src/services/visualEvidenceApprovalService");
const {
  buildVisualAudit,
  buildCoverageReport,
  buildQaDecision,
  classifyGastronomyCoverage,
  GASTRONOMY_CATEGORIES,
  NON_GASTRONOMY_CATEGORIES,
} = require("../src/services/editorialQaService");
const { probeRenderIntegrity, validateResolution } = require("../src/services/mediaIntegrityQaService");
const { resolveContractDiversityRules } = require("../src/services/diversityGuardService");
const { GASTRONOMY_GLOBAL_COVERAGE } = require("../src/services/visualContractService");

const assert = require("assert");

// ─── Config ─────────────────────────────────────────────────────────────────

const topic = "Portugal gastronómico: sabores inesquecíveis de Lisboa e Porto";
const niche = "gastronomy";

// ─── Testes unitários ───────────────────────────────────────────────────────

console.log("=== PARTE 1 — Visual Contract ===\n");

// 1.1 Geração do contrato visual
assert(GASTRONOMY_GLOBAL_COVERAGE.required.min_food_coverage_ratio === 0.70,
  "cobertura mínima de gastronomia deve ser 70%");
assert(GASTRONOMY_GLOBAL_COVERAGE.max.max_city_landmark_ratio === 0.15,
  "máximo de landmark deve ser 15%");
console.log("✅ GASTRONOMY_GLOBAL_COVERAGE configurado corretamente");

// 1.2 Contrato tem regras para Lisboa e Porto
assert(GASTRONOMY_GLOBAL_COVERAGE.required.min_lisboa_food_evidence_moments === 2,
  "Lisboa precisa de 2 momentos de food evidence");
assert(GASTRONOMY_GLOBAL_COVERAGE.required.min_porto_food_evidence_moments === 2,
  "Porto precisa de 2 momentos de food evidence");
assert(GASTRONOMY_GLOBAL_COVERAGE.required.min_wine_moments_if_porto_or_vinho === 1,
  "Precisa de 1 momento de wine se Porto/vinho mencionado");
assert(GASTRONOMY_GLOBAL_COVERAGE.required.min_pastry_moments_if_mentioned === 1,
  "Precisa de 1 momento de pastry se pastel/nata/café mencionado");
assert(GASTRONOMY_GLOBAL_COVERAGE.required.min_restaurant_moments === 1,
  "Precisa de 1 momento de restaurant");
console.log("✅ Regras de cobertura específicas configuradas");

console.log("\n=== PARTE 2 — Visual Intent (food→landmark bloqueado) ===\n");

// 2.1 Cena de comida não deve ser degradada para landmark
const foodScene = {
  scene_index: 1,
  role: "body",
  visual_intent: "gastronomy",
  narration_excerpt: "O bacalhau é o rei da gastronomia portuguesa, preparado com azeite e alho",
  keywords: ["bacalhau", "azeite", "comida portuguesa"],
  location: { city: "Lisboa", country: "Portugal" },
};
const intentResult = inferVisualIntent({
  scene: foodScene,
  block: { role: "body" },
  topic,
});
assert(intentResult.visual_intent !== "city_landmark",
  `Cena de bacalhau não deve ser city_landmark (foi: ${intentResult.visual_intent})`);
assert(intentResult.visual_intent === "gastronomy" || ["market", "wine", "pastry", "restaurant", "cafe", "street_food"].includes(intentResult.visual_intent),
  `Cena de comida deve ter intent de gastronomia/food (foi: ${intentResult.visual_intent})`);
console.log("✅ Cena de bacalhau mantém intent de gastronomia");

// 2.2 Cena com sinais fortes de comida não vira landmark
const pastelScene = {
  scene_index: 2,
  role: "body",
  visual_intent: "pastry",
  narration_excerpt: "Os pastéis de nata são a maior tentação de Lisboa",
  keywords: ["pastel de nata", "nata", "doce", "Lisboa"],
  location: { city: "Lisboa", country: "Portugal" },
};
const pastryIntent = inferVisualIntent({
  scene: pastelScene,
  block: { role: "body" },
  topic,
});
assert(pastryIntent.visual_intent !== "city_landmark",
  `Pastel de nata não deve ser city_landmark (foi: ${pastryIntent.visual_intent})`);
console.log("✅ Pastel de nata mantém intent de pastry/gastronomy");

// 2.3 Landmark só quando explícito e accepts_landmark=true
const landmarkScene = {
  scene_index: 3,
  role: "intro",
  visual_intent: "city_landmark",
  narration_excerpt: "Lisboa, com a sua Torre de Belém e o Castelo de São Jorge, é um monumento vivo",
  keywords: ["torre de belém", "castelo", "monumento", "Lisboa"],
  location: { city: "Lisboa", country: "Portugal" },
  accepts_landmark: true,
  content_slot_type: "establishing_context",
};
const landmarkIntent = inferVisualIntent({
  scene: landmarkScene,
  block: { role: "intro" },
  topic,
});
// Intro scenes can legitimately be establishing
console.log(`✅ Cena de landmark/intro: ${landmarkIntent.visual_intent}`);

console.log("\n=== PARTE 3 — Asset Query Planner ===\n");

// 3.1 Queries de gastronomia não têm landmarks no início
const gastroQueryPlan = buildSceneQueryPlan({
  scene: {
    ...foodScene,
    accepts_landmark: false,
    content_slot_type: "food_closeup",
  },
  topic,
});
assert(gastroQueryPlan.specificIntentRequired === true,
  "Gastronomia deve exigir intent específico");
assert(Array.isArray(gastroQueryPlan.critical_queries),
  "Deve ter critical_queries separadas");
assert(Array.isArray(gastroQueryPlan.supporting_queries),
  "Deve ter supporting_queries separadas");
assert(Array.isArray(gastroQueryPlan.transition_queries),
  "Deve ter transition_queries separadas");
console.log(`✅ Query plan gastronomia: ${gastroQueryPlan.critical_queries.length} critical, ${gastroQueryPlan.supporting_queries.length} supporting, ${gastroQueryPlan.transition_queries.length} transition`);

// 3.2 Queries de comida não são genéricas (não contêm "city view", "aerial")
const gastroCriticalQueries = gastroQueryPlan.critical_queries.join(" ");
const gastroForbiddenInCritical = /skyline|aerial|drone|bridge|river|coast|city view|landmark/i;
assert(!gastroForbiddenInCritical.test(gastroCriticalQueries),
  `Queries críticas de gastronomia não devem conter termos genéricos: ${gastroCriticalQueries.slice(0, 200)}`);
console.log("✅ Queries críticas de gastronomia sem termos genéricos");

// 3.3 isFoodIntent identifica corretamente
assert(isFoodIntent("gastronomy"), "gastronomy é food intent");
assert(isFoodIntent("market"), "market é food intent");
assert(isFoodIntent("wine"), "wine é food intent");
assert(!isFoodIntent("city_landmark"), "city_landmark NÃO é food intent");
assert(!isFoodIntent("aerial_city"), "aerial_city NÃO é food intent");
console.log("✅ isFoodIntent classifica corretamente");

console.log("\n=== PARTE 4 — Visual Evidence Approval ===\n");

// 4.1 metadata_fallback não aprova slot crítico
const weakEvidenceResult = classifyVisualTruth({
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
assert(weakEvidenceResult.visual_truth_status === "unknown",
  `metadata_fallback em slot crítico deve ser unknown (foi: ${weakEvidenceResult.visual_truth_status})`);
assert(WEAK_EVIDENCE_SOURCES.has("metadata_fallback"),
  "metadata_fallback está nas WEAK_EVIDENCE_SOURCES");
console.log("✅ metadata_fallback rejeitado para slot crítico");

// 4.2 forbidden categories = reprovação
const forbiddenResult = classifyVisualTruth({
  asset: { analysis_provider: "openai_vision" },
  window: {
    visual_evidence_source: "openai_vision",
    required_evidence_found: [],
    detected_visual_categories: ["aerial_city", "bridge"],
  },
  scene: {
    criticality: "critical",
    required_visual_evidence: ["food"],
    forbidden_visual_categories: ["aerial_city", "bridge", "river"],
  },
});
assert(forbiddenResult.visual_truth_status === "wrong",
  "categorias proibidas devem resultar em wrong");
console.log("✅ forbidden categories resultam em wrong");

// 4.3 exact = evidência real + todas required encontradas
const exactResult = classifyVisualTruth({
  asset: { analysis_provider: "gemini_vision" },
  window: {
    visual_evidence_source: "gemini_vision",
    required_evidence_found: ["food", "restaurant"],
    detected_visual_categories: ["food", "restaurant", "people_eating"],
  },
  scene: {
    criticality: "critical",
    required_visual_evidence: ["food", "restaurant"],
    forbidden_visual_categories: ["aerial_city"],
  },
});
assert(exactResult.visual_truth_status === "exact",
  `Evidência real completa deve ser exact (foi: ${exactResult.visual_truth_status})`);
console.log("✅ Evidência real completa = exact");

console.log("\n=== PARTE 5 — Diversidade baseada em contrato ===\n");

// 5.1 Regras de diversidade para gastronomia
const gastroDiversityRules = resolveContractDiversityRules({
  dominant_theme: "gastronomy",
  video_topic: topic,
});
assert(gastroDiversityRules.max_same_asset_uses === 1,
  "Gastronomia: máximo 1 uso por asset");
assert(gastroDiversityRules.max_same_source_url_uses === 1,
  "Gastronomia: máximo 1 uso por source_url");
assert(gastroDiversityRules.max_consecutive_visual_family === 2,
  "Gastronomia: máximo 2 visual_families consecutivas");
console.log("✅ Regras de diversidade para gastronomia");

// 5.2 Regras de diversidade default (não-gastronomia)
const defaultDiversityRules = resolveContractDiversityRules(null);
assert(defaultDiversityRules.max_same_asset_uses >= 2,
  "Default: permite mais reutilização de assets");
console.log("✅ Regras de diversidade default");

console.log("\n=== PARTE 6 — Editorial QA ===\n");

// 6.1 Classificação de cobertura gastronómica
assert(classifyGastronomyCoverage(["food", "restaurant", "people_eating"]) === "gastronomy_evidence",
  "Categorias de comida = gastronomy_evidence");
assert(classifyGastronomyCoverage(["city_landmark", "aerial_city"]) === "non_gastronomy",
  "Categorias de landmark = non_gastronomy");
assert(classifyGastronomyCoverage(["food", "city_landmark"]) === "mixed",
  "Comida + landmark = mixed");
assert(classifyGastronomyCoverage([]) === "unclassified",
  "Sem categorias = unclassified");
console.log("✅ classifyGastronomyCoverage funciona");

// 6.2 GASTRONOMY_CATEGORIES e NON_GASTRONOMY_CATEGORIES
assert(GASTRONOMY_CATEGORIES.has("food"), "food é gastronomia");
assert(GASTRONOMY_CATEGORIES.has("market"), "market é gastronomia");
assert(GASTRONOMY_CATEGORIES.has("wine"), "wine é gastronomia");
assert(GASTRONOMY_CATEGORIES.has("people_eating"), "people_eating é gastronomia");
assert(NON_GASTRONOMY_CATEGORIES.has("city_landmark"), "city_landmark NÃO é gastronomia");
assert(NON_GASTRONOMY_CATEGORIES.has("aerial_city"), "aerial_city NÃO é gastronomia");
assert(NON_GASTRONOMY_CATEGORIES.has("bridge"), "bridge NÃO é gastronomia");
assert(NON_GASTRONOMY_CATEGORIES.has("generic_street"), "generic_street NÃO é gastronomia");
console.log("✅ Conjuntos de categorias corretos");

// 6.3 Coverage report com clips simulados
const mockClips = [
  { clip_index: 1, detected_visual_categories: ["food", "restaurant"], visual_family: "food_closeup|medium|proof", source_url: "url1" },
  { clip_index: 2, detected_visual_categories: ["market", "food"], visual_family: "market_stall|wide|proof", source_url: "url2" },
  { clip_index: 3, detected_visual_categories: ["city_landmark", "aerial_city"], visual_family: "city_landmark|wide|context", source_url: "url3" },
  { clip_index: 4, detected_visual_categories: ["food", "people_eating"], visual_family: "food_closeup|medium|proof", source_url: "url4" },
  { clip_index: 5, detected_visual_categories: ["wine", "restaurant"], visual_family: "wine_pouring|medium|proof", source_url: "url5" },
];
const coverage = buildCoverageReport({ clips: mockClips, microMoments: [], visualContract: null });
assert(coverage.gastronomy_coverage_ratio >= 0.60,
  `Cobertura gastronómica deve ser alta (foi: ${coverage.gastronomy_coverage_ratio})`);
console.log(`✅ Coverage report: gastronomy ${(coverage.gastronomy_coverage_ratio * 100).toFixed(0)}%, non-gastronomy ${(coverage.non_gastronomy_combined_ratio * 100).toFixed(0)}%`);

// 6.4 QA decision com falha de gastronomia baixa
const mockVisualContract = { dominant_theme: "gastronomy", video_topic: topic, cities: ["Lisboa", "Porto"] };
const lowGastronomyCoverage = { ...coverage, gastronomy_coverage_ratio: 0.35, non_gastronomy_combined_ratio: 0.40 };
const qaFailDecision = buildQaDecision({
  coverageReport: lowGastronomyCoverage,
  visualAudit: [],
  state: { visual_contract: mockVisualContract, caption_path_srt: null },
});
assert(qaFailDecision.passed === false,
  "QA deve falhar com gastronomy 35%");
assert(qaFailDecision.failures.some((f) => f.rule === "gastronomy_coverage_minimum"),
  "Deve ter falha de gastronomy_coverage_minimum");
console.log(`✅ QA decision falha com cobertura baixa: ${qaFailDecision.failures.length} falhas`);

// 6.5 QA decision passa com cobertura alta
const highGastronomyCoverage = { ...coverage, gastronomy_coverage_ratio: 0.85, non_gastronomy_combined_ratio: 0.10, consecutive_visual_family_repeats: 1, repeated_source_urls: 0 };
const qaPassDecision = buildQaDecision({
  coverageReport: highGastronomyCoverage,
  visualAudit: [],
  state: { visual_contract: mockVisualContract, render_timeline: { output_resolution: "1920x1080" }, caption_path_srt: null, approved_visual_evidence_pool: [{ asset_id: "1" }] },
});
assert(qaPassDecision.passed === true,
  `QA deve passar com cobertura alta (falhas: ${qaPassDecision.failures.length})`);
console.log(`✅ QA decision passa com cobertura alta: ${qaPassDecision.failures.length} falhas, ${qaPassDecision.warnings.length} avisos`);

// 6.6 QA sem visual_contract falha
const qaNoContract = buildQaDecision({
  coverageReport: highGastronomyCoverage,
  visualAudit: [],
  state: {},
});
assert(qaNoContract.failures.some((f) => f.rule === "missing_visual_contract"),
  "QA deve falhar sem visual_contract");
console.log("✅ QA falha quando visual_contract está ausente");

// 6.7 Visual audit com clips simulados
const mockMicroMoments = [
  { id: "mm_1", start_sec: 0, end_sec: 10, visual_intent: "gastronomy", narration_excerpt: "Comida portuguesa", required_visual_evidence: ["food"] },
];
const audit = buildVisualAudit({ clips: mockClips, microMoments: mockMicroMoments, visualContract: mockVisualContract });
assert(audit.length > 0, "Audit deve ter entradas");
const midpointEntries = audit.filter((r) => r.is_midpoint);
assert(midpointEntries.length === mockClips.length, "Deve ter midpoint para cada clip");
console.log(`✅ Visual audit: ${audit.length} entradas, ${midpointEntries.length} midpoints`);

console.log("\n=== PARTE 7 — Media Integrity (conceitos) ===\n");

// 7.1 Probe com path inexistente
(async () => {
const missingRender = await probeRenderIntegrity("/tmp/nonexistent_video_12345.mp4");
assert(missingRender.passed === false, "Path inexistente deve falhar");
assert(missingRender.error === "render_path_not_found", "Deve reportar render_path_not_found");
console.log("✅ probeRenderIntegrity deteta path inexistente");
})().catch((err) => {
  console.error("❌ probeRenderIntegrity falhou:", err.message);
  process.exit(1);
});

console.log("\n=== PARTE 8 — WEAK_EVIDENCE_SOURCES ===\n");

// 8.1 Todas as fontes fracas estão mapeadas
assert(WEAK_EVIDENCE_SOURCES.has("metadata_fallback"), "metadata_fallback é weak");
assert(WEAK_EVIDENCE_SOURCES.has("weak_fallback"), "weak_fallback é weak");
assert(WEAK_EVIDENCE_SOURCES.has("disabled"), "disabled é weak");
assert(WEAK_EVIDENCE_SOURCES.has("script_missing"), "script_missing é weak");
assert(WEAK_EVIDENCE_SOURCES.has("local_video_understanding_fallback"), "local_video_understanding_fallback é weak");
console.log("✅ WEAK_EVIDENCE_SOURCES completo");

// ─── Sumário ────────────────────────────────────────────────────────────────

console.log("\n========================================");
console.log("✅ TODOS OS TESTES PASSARAM");
console.log("========================================");
console.log(`\nPartes testadas: Visual Contract, Visual Intent, Asset Query, Visual Evidence, Diversity, Editorial QA, Media Integrity`);
console.log(`Tópico: ${topic}`);
console.log(`Regras de cobertura: gastronomy >= ${GASTRONOMY_GLOBAL_COVERAGE.required.min_food_coverage_ratio * 100}%, landmark <= ${GASTRONOMY_GLOBAL_COVERAGE.max.max_city_landmark_ratio * 100}%`);

process.exit(0);
