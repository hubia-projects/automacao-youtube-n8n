const assert = require("assert");
const { __test__ } = require("../src/services/assetsService");

const introScene = {
  scene_index: 1,
  role: "intro",
  hard_boundary: false,
  chapter_card_required: false,
};

const filteredSlots = __test__.resolveAiFallbackCriticalSlots({
  scene: introScene,
  slots: [
    { slot_type: "hook" },
    { slot_type: "proof_exact" },
  ],
});

assert.deepStrictEqual(
  filteredSlots.map((slot) => slot.slot_type),
  ["hook"],
  "fallback IA critico deveria manter apenas slot types explicitamente criticos"
);

const bodyScene = {
  scene_index: 2,
  role: "body",
  hard_boundary: false,
  chapter_card_required: false,
};

assert.deepStrictEqual(
  __test__.resolveAiFallbackCriticalSlots({
    scene: bodyScene,
    slots: [{ slot_type: "proof_exact" }],
  }),
  [],
  "cena nao critica nao deveria abrir fallback IA para slot nao listado como critico"
);

assert.strictEqual(
  __test__.sceneHasCoveredCriticalFallbackSlot({
    scene: introScene,
    slots: [{ slot_type: "hook" }],
    downloadedItems: [{ scene_index: 1, content_slot_type: "hook" }],
  }),
  true,
  "asset ja baixado para o slot critico deveria impedir novo fallback IA"
);

assert.strictEqual(
  __test__.sceneHasCoveredCriticalFallbackSlot({
    scene: { scene_index: 3, role: "intro", chapter_card_required: true },
    slots: [{ slot_type: "chapter_opening" }],
    downloadedItems: [{ scene_index: 3, chapter_card_candidate: true }],
  }),
  true,
  "chapter card candidate existente deveria contar como cobertura para fallback critico"
);

console.log("test_assets_GD validado com sucesso");