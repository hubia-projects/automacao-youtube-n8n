const assert = require("assert");
const { approveAssetsForVisualPlan } = require("../src/services/assetApprovalService");
const { summarizeAssetReadiness } = require("../src/services/assetReadinessService");
const { buildBlockContentPackages } = require("../src/services/contentSlotPlannerService");

const visualPlan = [
  {
    scene_index: 1,
    block_id: "lisboa_food",
    block_label: "Lisboa gastronomia",
    title: "Lisboa mercados e comida",
    narration_excerpt: "Vamos provar comida local em mercados tradicionais.",
    visual_intent: "gastronomy",
    role: "body",
    required_visual_evidence: ["food", "market"],
    keywords: ["lisboa", "market", "food"],
    location: { city: "Lisboa", country: "Portugal" },
  },
];

const assets = [
  {
    scene_index: 1,
    asset_id: "asset_city_context_only",
    provider: "pexels",
    source_url: "https://example.com/city-context.mp4",
    local_path: "C:/tmp/city-context.mp4",
    analysis_provider: "openai_vision",
    analysis_windows: [
      {
        window_index: 1,
        start_seconds: 0,
        end_seconds: 6,
        summary: "city skyline and bridge in lisbon",
        tags: ["city", "bridge", "skyline"],
        location: { city: "Lisboa", country: "Portugal", confidence: 0.9 },
        landmarks: [],
        detected_visual_categories: ["city_landmark", "bridge"],
        detected_objects: [],
        visual_evidence_source: "openai_vision",
        visual_observation_origin: "real_vision",
        confidence: 0.8,
      },
    ],
  },
];

const blockPackages = buildBlockContentPackages({ visualPlan });
const approval = approveAssetsForVisualPlan({ visualPlan, assets, blockPackages });
const readiness = summarizeAssetReadiness({
  visualPlan,
  assets,
  approvedItems: approval.approved_items || [],
  approvedWindows: approval.approved_windows || [],
  sceneEditorialReadiness: approval.scene_editorial_readiness || [],
  editorialMetrics: approval.editorial_metrics || {},
  mockMode: false,
});

assert((approval.slot_coverage_by_block || []).length === 1, "deveria gerar cobertura por bloco");
assert((approval.slot_coverage_by_block[0].missing_required_slots || []).length > 0, "bloco deveria falhar cobertura de slots obrigatórios");
assert.strictEqual(readiness.missing_assets, true, "readiness deveria falhar sem slots obrigatórios de gastronomia");
assert(
  (readiness.scene_asset_readiness[0].blocking_reasons || []).includes("scene_missing_required_content_slots"),
  "deveria bloquear por falta de slots obrigatórios"
);

console.log("slot-coverage-gastronomy-fail-test ok");
