/**
 * Testa os gates fail-closed de geografia, dedup hard e constraint de
 * entidade nomeada introduzidos para eliminar contaminação geográfica e
 * repetição de clips.
 */

process.env.LOCATION_GATE_MODE = "strict";
process.env.MAX_ASSET_USES_PER_VIDEO = "1";

const assert = require("assert");
const { shouldRejectAssetForScene, isSameCountry, normalizeCountry } = require("../src/services/assetRejectionService");
const { __test__: scoring } = require("../src/services/timelineScoringService");
const { __test__: blocks } = require("../src/services/narrativeBlockPlanner");
const { __test__: matcher } = require("../src/services/semanticMatcher");

const results = [];
const test = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
};

// ===== País =====

test("normalizeCountry mapeia aliases", () => {
  assert.strictEqual(normalizeCountry("Brasil"), "brazil");
  assert.strictEqual(normalizeCountry("Escócia"), "united kingdom");
  assert.strictEqual(isSameCountry("Portugal", "portugal"), true);
  assert.strictEqual(isSameCountry("Italy", "Portugal"), false);
});

test("wrong_country rejeita Coliseu em vídeo de Portugal", () => {
  const result = shouldRejectAssetForScene({
    asset: { query: "ancient amphitheater" },
    scene: {
      expected_location: "Lisboa",
      expected_country: "Portugal",
      location: { city: "Lisboa", country: "Portugal" },
      generic_asset_allowed: false,
      visual_intent: "city_tour",
    },
    window: {
      summary: "Large ancient stone amphitheater with arches, tourists walking",
      location: { city: "Roma", country: "Italy", confidence: 0.9 },
      visual_evidence_source: "gemini_vision",
    },
  });
  assert.strictEqual(result.reject, true);
  assert.strictEqual(result.reason, "wrong_country");
});

test("strict mode rejeita clip sem localização verificada em cena com local exigido", () => {
  const result = shouldRejectAssetForScene({
    asset: { query: "city street" },
    scene: {
      expected_location: "Porto",
      location: { city: "Porto", country: "Portugal" },
      generic_asset_allowed: false,
      visual_intent: "city_tour",
    },
    window: {
      summary: "generic street with people walking",
      location: { city: "", country: "", confidence: 0 },
      visual_evidence_source: "openai_vision",
    },
  });
  assert.strictEqual(result.reject, true);
  assert.strictEqual(result.reason, "unverified_location_for_location_scene");
});

test("clip do país certo com cidade confirmada passa o gate geográfico", () => {
  const result = shouldRejectAssetForScene({
    asset: { query: "porto ribeira" },
    scene: {
      expected_location: "Porto",
      expected_country: "Portugal",
      location: { city: "Porto", country: "Portugal" },
      generic_asset_allowed: true,
      visual_intent: "generic_travel",
    },
    window: {
      summary: "Ribeira do Porto com a Ponte Dom Luis ao fundo",
      location: { city: "Porto", country: "Portugal", confidence: 0.9 },
      visual_evidence_source: "gemini_vision",
    },
  });
  assert.strictEqual(result.reject, false);
});

// ===== Dedup hard =====

test("asset usado uma vez é hard-blocked na segunda tentativa", () => {
  const usage = { usedAssetIds: new Map([["asset-1", 1]]) };
  const reason = scoring.computeHardReuseBlockReason({
    candidate: { asset_id: "asset-1", asset: {} },
    usage,
  });
  assert.strictEqual(reason, "asset_reuse_blocked");
});

test("mesmo source_url com asset_id diferente também é bloqueado", () => {
  const usage = {
    usedAssetIds: new Map(),
    usedSourceUrls: new Map([["https://pexels.com/video/123", 1]]),
  };
  const reason = scoring.computeHardReuseBlockReason({
    candidate: { asset_id: "asset-2", asset: { source_url: "https://pexels.com/video/123" } },
    usage,
  });
  assert.strictEqual(reason, "source_url_reuse_blocked");
});

test("landmark já usado bloqueia janela diferente do mesmo monumento", () => {
  const usage = {
    usedAssetIds: new Map(),
    usedSourceUrls: new Map(),
    usedLocalPaths: new Map(),
    usedLandmarks: new Map([["torre de belem", 1]]),
  };
  const reason = scoring.computeHardReuseBlockReason({
    candidate: {
      asset_id: "asset-3",
      asset: { source_url: "https://other.url" },
      landmarks: [{ name: "Torre de Belem" }],
    },
    usage,
  });
  assert.strictEqual(reason, "landmark_reuse_blocked");
});

test("asset novo não é bloqueado", () => {
  const usage = { usedAssetIds: new Map(), usedSourceUrls: new Map(), usedLocalPaths: new Map(), usedLandmarks: new Map() };
  const reason = scoring.computeHardReuseBlockReason({
    candidate: { asset_id: "fresh", asset: { source_url: "https://new.url" }, landmarks: [] },
    usage,
  });
  assert.strictEqual(reason, "");
});

// ===== Entidade nomeada =====

test("narração cita Rio Douro → candidato genérico é bloqueado no slot", () => {
  const reason = scoring.computeNamedEntityBlockReason({
    narrationText: "agora vamos conhecer o famoso rio douro que corta a cidade",
    candidate: {
      description: "generic city street with cars",
      tags: ["street", "cars"],
      location: { city: "" },
      landmarks: [],
    },
    entityMatchScore: 0,
  });
  assert.strictEqual(reason, "named_entity_in_narration_not_in_candidate");
});

test("narração cita Rio Douro → candidato do Douro passa", () => {
  const reason = scoring.computeNamedEntityBlockReason({
    narrationText: "agora vamos conhecer o famoso rio douro",
    candidate: {
      description: "vista aerea do rio douro com a ponte dom luis",
      tags: ["douro", "porto"],
      location: { city: "Porto" },
      landmarks: [{ name: "Rio Douro" }],
    },
    entityMatchScore: 0.8,
  });
  assert.strictEqual(reason, "");
});

test("narração sem entidade nomeada não bloqueia nada", () => {
  const reason = scoring.computeNamedEntityBlockReason({
    narrationText: "portugal e um pais incrivel para visitar",
    candidate: { description: "generic", tags: [], landmarks: [] },
    entityMatchScore: 0,
  });
  assert.strictEqual(reason, "");
});

// ===== Capítulos =====

test("blocos genéricos não geram capítulo e numeração é sequencial só nas cidades", () => {
  const { macroBlocks } = blocks.buildNarrativeBlocks({
    state: {
      topic: "As 3 cidades de Portugal",
      visual_plan: [
        { scene_index: 1, title: "Abertura do video", narration_excerpt: "hoje voce vai descobrir" },
        { scene_index: 2, title: "Porto incrivel", narration_excerpt: "o porto e a ribeira junto ao douro" },
        { scene_index: 3, title: "Lisboa historica", narration_excerpt: "lisboa e alfama com o tejo" },
        { scene_index: 4, title: "Fechamento", narration_excerpt: "obrigado por assistir ate o final" },
      ],
    },
    audioIntelligence: null,
    audioDuration: 400,
  });

  const overlayTitles = macroBlocks.map((block) => block.overlay_title);
  const chapterTitles = overlayTitles.filter(Boolean);

  // Nenhum capítulo "Introducao"/"Fechamento"
  assert.ok(!chapterTitles.some((title) => /introducao|fechamento/i.test(title)), `capítulo genérico vazou: ${chapterTitles}`);
  // Numeração sequencial 1., 2.
  assert.ok(chapterTitles[0]?.startsWith("1. "), `primeiro capítulo deveria ser "1. ...": ${chapterTitles[0]}`);
  if (chapterTitles[1]) assert.ok(chapterTitles[1].startsWith("2. "), `segundo capítulo deveria ser "2. ...": ${chapterTitles[1]}`);
});

test("expected_country propaga país dominante para blocos sem cidade", () => {
  const { macroBlocks } = blocks.buildNarrativeBlocks({
    state: {
      topic: "Portugal",
      visual_plan: [
        { scene_index: 1, title: "Abertura", narration_excerpt: "hoje voce vai descobrir tres cidades" },
        { scene_index: 2, title: "Porto", narration_excerpt: "o porto junto ao douro" },
      ],
    },
    audioIntelligence: null,
    audioDuration: 300,
  });
  assert.ok(macroBlocks.every((block) => block.expected_country === "Portugal"), JSON.stringify(macroBlocks.map((b) => b.expected_country)));
});

// ===== Cache de embeddings =====

test("getCacheKey é sha1 estável e insensível a acentos/caixa", () => {
  const a = matcher.getCacheKey("Rio Douro do PORTO");
  const b = matcher.getCacheKey("rio douro do porto");
  assert.strictEqual(a, b);
  assert.match(a, /^[a-f0-9]{40}$/);
});

// ===== Report =====

const failed = results.filter((result) => !result.ok);
results.forEach((result) => {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok ? "" : ` — ${result.error}`}`);
});
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
