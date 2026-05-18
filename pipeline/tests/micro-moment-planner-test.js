const assert = require("assert");
const { buildMicroSegmentsFromAudio, buildMicroVisualPlan } = require("../src/services/microMomentPlannerService");

const run = async () => {
  const words = [
    { word: "Nos", start: 0, end: 0.2 },
    { word: "mercados", start: 0.2, end: 0.6 },
    { word: "locais", start: 0.6, end: 1.0 },
    { word: "os", start: 1.0, end: 1.2 },
    { word: "vendedores", start: 1.2, end: 1.8 },
    { word: "servem", start: 1.8, end: 2.2 },
    { word: "produtos", start: 2.2, end: 2.7 },
    { word: "frescos.", start: 2.7, end: 3.1 },
    { word: "Depois", start: 3.4, end: 3.8 },
    { word: "os", start: 3.8, end: 4.0 },
    { word: "doces", start: 4.0, end: 4.5 },
    { word: "tradicionais", start: 4.5, end: 5.1 },
    { word: "aparecem", start: 5.1, end: 5.6 },
    { word: "em", start: 5.6, end: 5.8 },
    { word: "cada", start: 5.8, end: 6.0 },
    { word: "esquina.", start: 6.0, end: 6.4 },
  ];
  const pause_markers = [{ start: 3.2, end: 3.35, duration: 0.15, type: "sentence_break" }];
  const microSegments = buildMicroSegmentsFromAudio({ words, pauseMarkers: pause_markers });
  assert(microSegments.length >= 2, "deveria gerar microsegmentos por pausa e mudança semântica");

  const visualPlan = [{
    scene_index: 1,
    block_id: "lisboa_food",
    role: "body",
    visual_intent: "gastronomy",
    requires_visual_proof: true,
    subtheme: "food",
    audio_start_seconds: 0,
    audio_end_seconds: 7,
  }];
  const microVisualPlan = buildMicroVisualPlan({
    audioIntelligence: { words, pause_markers, micro_segments: microSegments, scene_boundaries: [{ scene_index: 1, audio_start_seconds: 0, audio_end_seconds: 7 }] },
    visualPlan,
    durationSeconds: 7,
  });

  assert(microVisualPlan.every((item) => item.scene_index === 1), "microtrechos deveriam mapear para cena correta");
  assert(microVisualPlan.some((item) => item.visual_need === "market_stall" || item.visual_need === "vendor_interaction"), "deveria inferir necessidade de mercado/vendedor");
  assert(microVisualPlan.some((item) => item.visual_need === "pastry_closeup" || item.visual_need === "food_closeup"), "deveria inferir necessidade de comida/doces");

  console.log("micro moment planner validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

