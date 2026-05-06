const assert = require("assert");
const { buildChapterTriggers } = require("../src/services/audioIntelligence");

const sceneBoundaries = [
  { scene_index: 1, audio_start_seconds: 0, audio_end_seconds: 8, boundary_confidence: 0.82, anchor_word: "Lisboa" },
  { scene_index: 2, audio_start_seconds: 8, audio_end_seconds: 16, boundary_confidence: 0.87, anchor_word: "Porto" },
  { scene_index: 3, audio_start_seconds: 16, audio_end_seconds: 24, boundary_confidence: 0.91, anchor_word: "Sintra" },
];

const words = [
  { word: "Agora", start: 7.8, end: 8.0 },
  { word: "seguimos", start: 8.0, end: 8.2 },
  { word: "para", start: 8.2, end: 8.3 },
  { word: "Porto", start: 8.3, end: 8.6 },
  { word: "Depois", start: 15.8, end: 16.0 },
  { word: "vamos", start: 16.0, end: 16.2 },
  { word: "para", start: 16.2, end: 16.3 },
  { word: "Sintra", start: 16.3, end: 16.6 },
];

const triggers = buildChapterTriggers({
  scenes: [
    { scene_index: 1 },
    { scene_index: 2 },
    { scene_index: 3 },
  ],
  sceneBoundaries,
  words,
});

assert.strictEqual(triggers.length, 2, "deveria detectar trigger para cada troca de capítulo");
assert(triggers.every((trigger) => trigger.scene_index > 1), "trigger deve começar da segunda cena");
assert(triggers.every((trigger) => trigger.confidence >= 0.55), "confidence mínima deveria ser respeitada");
assert(triggers.some((trigger) => trigger.cue_detected), "deveria marcar cue quando houver termo de transição");

console.log("chapter trigger detector validado com sucesso");
