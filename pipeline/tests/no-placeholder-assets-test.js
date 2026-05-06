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