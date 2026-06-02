const assert = require("assert");
const { __test__ } = require("../src/services/assetsService");

const baseScene = {
  scene_index: 1,
  visual_intent: "gastronomy",
  slot_criticality: "critical",
  requires_visual_proof: true,
  generic_asset_allowed: false,
};

assert.strictEqual(
  __test__.sceneNeedsCriticalAiGeneration({
    scene: baseScene,
    sceneReadiness: {
      blocking: true,
      exact_windows: 0,
      regional_windows: 0,
      generic_windows: 0,
      critical_slots_missing: ["food_closeup"],
      block_slot_coverage_missing: [],
      coverage_weak_only_slots: [],
    },
    blockingSceneSet: new Set([1]),
    preserveExisting: false,
    autoRepairRound: 0,
  }),
  true,
  "cena critica bloqueante deveria habilitar geracao IA ja no primeiro passe"
);

assert.strictEqual(
  __test__.sceneNeedsCriticalAiGeneration({
    scene: {
      scene_index: 2,
      visual_intent: "generic_travel",
      slot_criticality: "medium",
      requires_visual_proof: false,
      generic_asset_allowed: true,
    },
    sceneReadiness: {
      blocking: true,
      exact_windows: 1,
      regional_windows: 0,
      generic_windows: 0,
      critical_slots_missing: [],
      block_slot_coverage_missing: [],
      coverage_weak_only_slots: [],
    },
    blockingSceneSet: new Set([2]),
    preserveExisting: false,
    autoRepairRound: 0,
  }),
  false,
  "cena bloqueante sem gap critico nao deveria abrir geracao IA no primeiro passe"
);

assert.strictEqual(
  __test__.sceneNeedsCriticalAiGeneration({
    scene: baseScene,
    sceneReadiness: {
      blocking: true,
      exact_windows: 1,
      regional_windows: 0,
      generic_windows: 0,
      critical_slots_missing: [],
      block_slot_coverage_missing: ["people_eating"],
      coverage_weak_only_slots: [],
    },
    blockingSceneSet: new Set([1]),
    preserveExisting: false,
    autoRepairRound: 0,
  }),
  true,
  "gap de required content slot em cena critica tambem deveria liberar geracao IA no primeiro passe"
);

const firstPassReadiness = __test__.buildFirstPassSceneGenerationReadiness({
  scene: baseScene,
  missingRequiredSlots: [
    {
      slot_id: "slot_food_closeup_1",
      slot_type: "food_closeup",
      scene_index_hint: 1,
      criticality: "critical",
      requires_visual_proof: true,
      min_count: 1,
    },
  ],
});

assert.deepStrictEqual(
  firstPassReadiness.critical_slots_missing,
  ["food_closeup"],
  "fresh run deveria sintetizar critical slot missing a partir do block package atual"
);

assert.deepStrictEqual(
  firstPassReadiness.block_slot_coverage_missing,
  ["food_closeup"],
  "fresh run deveria sintetizar required slot missing a partir do block package atual"
);

assert.strictEqual(
  __test__.sceneNeedsCriticalAiGeneration({
    scene: baseScene,
    sceneReadiness: __test__.mergeSceneGenerationReadiness({
      previous: {},
      current: firstPassReadiness,
    }),
    blockingSceneSet: new Set(),
    preserveExisting: false,
    autoRepairRound: 0,
  }),
  true,
  "fresh run sem readiness anterior deveria liberar geracao IA quando o bloco atual ainda deixa slot critico sem cobertura"
);

console.log("critical scene first pass ai generation validado com sucesso");