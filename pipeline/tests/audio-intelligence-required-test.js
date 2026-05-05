const assert = require("assert");
const { updateState, loadState } = require("../src/services/stateService");
const { generateAudio } = require("../src/services/ttsService");
const { renderVideo } = require("../src/services/renderService");

const run = async () => {
  const videoId = `audio_intel_required_${Date.now()}`;
  await updateState(videoId, {
    topic: "Portugal gastronomia",
    script_text: "Lisboa abre o roteiro. Porto entra depois com mercados e vinho.",
    visual_plan: [
      { scene_index: 1, title: "Lisboa", narration_excerpt: "Lisboa abre o roteiro.", keywords: ["lisboa", "city"], target_duration_seconds: 6 },
      { scene_index: 2, title: "Porto", narration_excerpt: "Porto entra depois com mercados e vinho.", keywords: ["porto", "market", "wine"], target_duration_seconds: 6 },
    ],
    assets_json: {
      items: [
        { scene_index: 1, provider: "mock", asset_type: "image", type: "image", semantic_text: "lisboa market", query: "lisboa market", local_path: "", resolution: { width: 1920, height: 1080 }, duration_estimate: 6 },
        { scene_index: 2, provider: "mock", asset_type: "image", type: "image", semantic_text: "porto wine market", query: "porto wine market", local_path: "", resolution: { width: 1920, height: 1080 }, duration_estimate: 6 },
      ],
    },
    audio_intelligence_path: "",
  }, { currentStep: "script_generated", status: "script_generated" });

  await generateAudio({ videoId, mockMode: true, provider: "multivozes" });
  await renderVideo({ videoId, mockMode: true });
  const state = await loadState(videoId);

  assert(state.audio_intelligence_path, "render deveria garantir audio_intelligence_path");
  assert(state.render_timeline?.clips?.length > 0, "render deveria produzir timeline");
  console.log("audio intelligence obrigatoria validada com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
