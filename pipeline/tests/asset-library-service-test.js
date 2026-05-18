const assert = require("assert");
const {
  mergeApprovedWindowsIntoLibrary,
  summarizeLibrarySnapshot,
} = require("../src/services/assetLibraryService");

const approvedWindows = [
  {
    asset_id: "asset_lib_test_01",
    source_tier: "free",
    visual_truth_status: "exact",
    editorial_confidence: 0.88,
    content_slot_type: "food_closeup",
    content_slots_supported: ["food_closeup"],
    narrative_roles_supported: ["proof_exact"],
    visual_observation: {
      detected_visual_categories: ["food", "local_food"],
      landmarks: [],
      visual_features: { shot_type: "detail" },
    },
    window: {
      location: { city: "Lisboa" },
    },
    scene_visual_intent: "gastronomy",
  },
];

const assets = [
  {
    asset_id: "asset_lib_test_01",
    provider: "pexels",
    source_url: "https://example.com/asset_lib_test_01.mp4",
    local_path: "C:/tmp/asset_lib_test_01.mp4",
  },
];

const run = async () => {
  const afterFirst = await mergeApprovedWindowsIntoLibrary({
    approvedWindows,
    assets,
    videoId: "lib_test_video",
  });
  const afterSecond = await mergeApprovedWindowsIntoLibrary({
    approvedWindows,
    assets,
    videoId: "lib_test_video_2",
  });

  const snapshot = summarizeLibrarySnapshot(afterSecond, 50);
  const found = snapshot.sample.find((entry) => entry.asset_id === "asset_lib_test_01");
  assert(found, "asset aprovado deveria entrar na biblioteca");
  assert(Number(found.usage_count || 0) >= 2, "usage_count deveria subir com reuso");
  assert((found.slot_types_supported || []).includes("food_closeup"), "slot_type deve ser persistido na biblioteca");
  assert(Number(snapshot.total_assets || 0) >= 1, "biblioteca deve ter pelo menos um asset");
  assert(afterFirst && afterSecond, "merge da biblioteca deve retornar payload válido");

  console.log("asset-library-service-test ok");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
