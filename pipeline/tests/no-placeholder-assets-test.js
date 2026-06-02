const os = require("os");
const path = require("path");

const ensureHostWritableRuntimePaths = () => {
  const baseDir = path.join(os.tmpdir(), "youtube-pipeline-no-placeholder-assets-test");
  const fallbackPaths = {
    OUTPUT_ROOT: path.join(baseDir, "output"),
    TEST_REPORTS_ROOT: path.join(baseDir, "reports"),
    CLIP_LIBRARY_DB_PATH: path.join(baseDir, "clip-library.json"),
    SCENE_INDEX_DB_PATH: path.join(baseDir, "scene-index.json"),
    CLIP_LIBRARY_ROOT_DIR: path.join(baseDir, "clip-library"),
    CLIP_LIBRARY_SHADOW_REPORT_DIR: path.join(baseDir, "clip-library-shadow"),
  };

  Object.entries(fallbackPaths).forEach(([envName, fallbackPath]) => {
    const currentValue = String(process.env[envName] || "").trim();
    if (!currentValue || currentValue.startsWith("/app/")) {
      process.env[envName] = fallbackPath;
    }
  });
};

ensureHostWritableRuntimePaths();

process.env.ALLOW_PLACEHOLDER_ASSETS = "false";

const assert = require("assert");
const { enrichVisualPlan } = require("../src/services/narrativeBlockPlanner");
const { summarizeAssetReadiness } = require("../src/services/assetReadinessService");
const { buildTimeline } = require("../src/services/timelinePlanner");

const visualPlan = enrichVisualPlan({
  topic: "Lisboa gastronomica",
  visualPlan: [{
    scene_index: 1,
    title: "Mercado e pratos tipicos",
    narration_excerpt: "A cena mostra pratos, mercado e pessoas comendo em Lisboa.",
    keywords: ["lisbon", "food market", "plates"],
    role: "body",
    target_duration_seconds: 6,
  }],
  audioDuration: 6,
}).visualPlan;

const fallbackAsset = {
  scene_index: 1,
  provider: "local_fallback",
  asset_type: "image",
  type: "image",
  local_path: "C:/tmp/scene-01-fallback-123.png",
  source_url: "generated-local",
  resolution: {
    width: 1920,
    height: 1080,
    label: "Full HD",
  },
  duration_estimate: 6,
  is_fallback: true,
};

const readiness = summarizeAssetReadiness({ visualPlan, assets: [fallbackAsset], mockMode: false });

assert.strictEqual(readiness.missing_assets, true, "fallback local nao deve contar como asset publicavel");
assert.deepStrictEqual(readiness.blocking_scene_indexes, [1], "a cena com fallback deve ficar bloqueada");

const generatedVertexAsset = {
  scene_index: 1,
  provider: "vertex_ai_generated",
  asset_type: "image",
  type: "image",
  local_path: "/tmp/scene-01-vertex-generated.png",
  source_url: "vertex-ai-generated://lisboa-gastronomica",
  source_tier: "generated",
  resolution: {
    width: 1920,
    height: 1080,
    label: "Full HD",
  },
  duration_estimate: 6,
  is_fallback: false,
};

const generatedReadiness = summarizeAssetReadiness({ visualPlan, assets: [generatedVertexAsset], mockMode: false });
const generatedSceneReadiness = generatedReadiness.scene_asset_readiness[0];

assert.strictEqual(generatedSceneReadiness.publishable_assets, 1, "asset gerado via Vertex deve contar como asset publicavel");
assert.strictEqual(generatedSceneReadiness.placeholder_assets, 0, "asset gerado via Vertex nao deve ser contado como placeholder");
assert(!generatedSceneReadiness.blocking_reasons.includes("scene_has_only_placeholder_assets"), "asset gerado via Vertex nao deve bloquear a cena como placeholder");

const state = {
  video_id: "placeholder_gate_test",
  topic: "Lisboa gastronomica",
  script_text: "Mercado e pratos tipicos em Lisboa.",
  visual_plan: visualPlan,
  assets_json: {
    items: [fallbackAsset],
    scene_asset_readiness: readiness.scene_asset_readiness,
    missing_assets: readiness.missing_assets,
  },
};

(async () => {
  await assert.rejects(
    () => buildTimeline({
      state,
      audioDuration: 6,
      draftVersion: 1,
      fallbackAsset,
      allowPlaceholderFallback: false,
    }),
    /missing publishable assets|no publishable assets/i,
    "a timeline deve falhar quando so existir placeholder em producao"
  );

  console.log("placeholder assets bloqueados com sucesso");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});