const assert = require("assert");
const { rankCandidates } = require("../src/services/timelineScoringService");

const buildCandidate = ({
  id,
  analysisProvider,
  visualEvidenceSource = analysisProvider,
  confidence,
  semanticText,
}) => ({
  id,
  asset_id: id,
  asset: {
    provider: "pexels",
    asset_type: "video",
    source_url: `https://example.com/${id}.mp4`,
  },
  source: "pexels",
  description: semanticText,
  summary: semanticText,
  semantic_text: semanticText,
  tags: ["food", "market", "restaurant", "people eating"],
  location: { city: "Lisboa", country: "Portugal" },
  landmarks: [],
  location_type: "food",
  visual_features: { shot_type: "wide", camera_motion: "tracking" },
  quality: { brightness: 0.8, usable: true, resolution_score: 1 },
  detected_visual_categories: ["food", "market", "restaurant", "people_eating"],
  detected_objects: ["plate", "food"],
  visual_intent_match: true,
  generic_visual: false,
  required_evidence_found: ["food", "market", "people eating"],
  missing_required_visual_evidence: [],
  confidence,
  neutral: false,
  analysis_provider: analysisProvider,
  visual_evidence_source: visualEvidenceSource,
  start_sec: 0,
  end_sec: 6,
  duration_sec: 6,
});

const block = {
  topic: "Lisboa gastronomica",
  narration_excerpt: "Mercado, pratos e pessoas comendo em Lisboa.",
  keywords: ["lisbon food market", "people eating"],
  location: { city: "Lisboa", country: "Portugal" },
  topic_type: "city",
  macro_topic: "Lisboa",
  subtheme: "food",
  visual_intent: "gastronomy",
  generic_asset_allowed: false,
  required_visual_evidence: ["food", "market", "people eating"],
  allowed_visual_categories: ["food", "market", "restaurant", "people_eating"],
  forbidden_visual_categories: ["aerial_city", "bridge", "river"],
  forbidden_locations: [],
  block_id: "block-1",
};

(async () => {
  const ranked = await rankCandidates({
    block,
    narrationText: "Mercado com pratos e pessoas comendo em Lisboa.",
    candidates: [
      buildCandidate({
        id: "metadata-fallback",
        analysisProvider: "metadata_fallback",
        confidence: 0.95,
        semanticText: "Lisbon food market with people eating",
      }),
      buildCandidate({
        id: "real-evidence",
        analysisProvider: "openai_vision",
        confidence: 0.55,
        semanticText: "Lisbon food market with people eating and plates on table",
      }),
    ],
    previousMacroTopic: "",
    usage: {
      usedSourceUrls: new Map(),
      usedAssetIds: new Map(),
      usedLocalPaths: new Map(),
      usedWindowIds: new Map(),
      usedProviders: new Map(),
      usedBlockAssetIds: new Map(),
      usedVisualSignatures: new Map(),
      lastClipByAssetId: new Map(),
    },
    videoId: "metadata_fallback_test",
    clipIndex: 1,
  });

  assert.strictEqual(ranked[0].candidate.asset_id, "real-evidence", "evidencia real deveria vencer metadata_fallback em intent especifico");
  const metadataFallback = ranked.find((entry) => entry.candidate.asset_id === "metadata-fallback");
  assert(metadataFallback.features.metadataFallbackPenalty > 0, "metadata_fallback deveria receber penalidade explicita");
  assert.strictEqual(metadataFallback.features.visualIntentMatchScore, 0, "metadata_fallback nao deveria satisfazer sozinho visual_intent em intent especifico");

  console.log("metadata fallback tratado como evidencia fraca com sucesso");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});