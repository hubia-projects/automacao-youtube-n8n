const assert = require("assert");
const { loadState, updateState } = require("../src/services/stateService");
const { generateAssets } = require("../src/services/assetsService");

const run = async () => {
  const videoId = `block_funnel_test_${Date.now()}`;
  await loadState(videoId);
  await updateState(videoId, {
    topic: "Lisboa gastronomia",
    script_text: "Mercados, comida local e restaurantes em Lisboa.",
    duration_seconds: 24,
    visual_plan: [
      {
        scene_index: 1,
        scene_order: 1,
        block_id: "lisboa_food",
        block_label: "Lisboa gastronomia",
        title: "Hook gastronômico",
        narration_excerpt: "Mercados e comida local de Lisboa.",
        keywords: ["lisboa", "market", "food"],
        visual_intent: "gastronomy",
        role: "intro",
        narrative_function: "hook",
        probable_shot_role: "hook_exact",
      },
      {
        scene_index: 2,
        scene_order: 2,
        block_id: "lisboa_food",
        block_label: "Lisboa gastronomia",
        title: "Prova visual",
        narration_excerpt: "Pratos típicos e vendedores locais.",
        keywords: ["lisboa", "restaurant", "food"],
        visual_intent: "gastronomy",
        role: "body",
        narrative_function: "proof",
        probable_shot_role: "proof_exact",
      },
    ],
  });

  const result = await generateAssets({
    videoId,
    mockMode: true,
    maxAssets: 4,
  });

  const assetsJson = result.assets_json || {};
  assert(Array.isArray(assetsJson.block_packages), "deveria persistir block_packages");
  assert(Array.isArray(assetsJson.slot_query_plan), "deveria persistir slot_query_plan");
  assert(Array.isArray(assetsJson.block_candidate_funnel), "deveria persistir block_candidate_funnel");
  assert(Array.isArray(assetsJson.slot_coverage_by_block), "deveria persistir slot_coverage_by_block");
  assert(assetsJson.stage_progress && typeof assetsJson.stage_progress === "object", "deveria persistir stage_progress");
  assert(Number(assetsJson.stage_progress.blocks_total || 0) >= 1, "deveria registrar total de blocos");
  assert(assetsJson.editorial_asset_library_snapshot && typeof assetsJson.editorial_asset_library_snapshot === "object", "deveria persistir snapshot da biblioteca");

  console.log("generate-assets-block-funnel-test ok");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
