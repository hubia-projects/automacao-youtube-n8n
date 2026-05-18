const assert = require("assert");
const { buildLocalRepairPlan, REPAIR_BLOCK_STATE, __test__ } = require("../src/services/repairPlannerService");

const testResolveBlockState = () => {
  const strong = __test__.resolveBlockState({
    blockCoverage: { coverage_status: "strong", needs_repair: false, can_advance: true },
    repairRoundsUsed: 0,
    maxRepairRounds: 2,
    allowPartialDegrade: false,
  });
  assert.strictEqual(strong, REPAIR_BLOCK_STATE.STRONG, "strong deveria permanecer strong");

  const repairRequired = __test__.resolveBlockState({
    blockCoverage: { coverage_status: "partial", needs_repair: true, can_advance: false },
    repairRoundsUsed: 0,
    maxRepairRounds: 2,
    allowPartialDegrade: false,
  });
  assert.strictEqual(repairRequired, REPAIR_BLOCK_STATE.REPAIR_REQUIRED, "partial com repair pendente deveria exigir repair");

  const degraded = __test__.resolveBlockState({
    blockCoverage: { coverage_status: "partial", needs_repair: false, can_advance: true },
    repairRoundsUsed: 2,
    maxRepairRounds: 2,
    allowPartialDegrade: true,
  });
  assert.strictEqual(degraded, REPAIR_BLOCK_STATE.DEGRADED, "partial avançável com degrade permitido deveria ficar degraded");

  const blocked = __test__.resolveBlockState({
    blockCoverage: { coverage_status: "insufficient", needs_repair: true, can_advance: false },
    repairRoundsUsed: 2,
    maxRepairRounds: 2,
    allowPartialDegrade: false,
  });
  assert.strictEqual(blocked, REPAIR_BLOCK_STATE.BLOCKED, "insufficient após limite de repair deveria bloquear");
};

const testBuildLocalRepairPlan = () => {
  const state = {
    visual_plan: [
      { scene_index: 1, block_id: "block_gastro", visual_intent: "gastronomy" },
      { scene_index: 2, block_id: "block_city", visual_intent: "city" },
    ],
    assets_json: {
      block_packages: [
        { block_id: "block_gastro", scene_indexes: [1] },
        { block_id: "block_city", scene_indexes: [2] },
      ],
      block_coverage_by_block: [
        {
          block_id: "block_gastro",
          coverage_status: "partial",
          needs_repair: true,
          can_advance: false,
          missing_slots: ["food_closeup"],
          weak_only_slots: ["people_eating"],
        },
        {
          block_id: "block_city",
          coverage_status: "strong",
          needs_repair: false,
          can_advance: true,
          missing_slots: [],
          weak_only_slots: [],
        },
      ],
      block_candidate_funnel: [
        { block_id: "block_gastro", repair_rounds_used: 0, repeated_assets_in_block: 1 },
        { block_id: "block_city", repair_rounds_used: 0, repeated_assets_in_block: 0 },
      ],
      scene_editorial_readiness: [
        { scene_index: 1, block_id: "block_gastro", visual_intent: "gastronomy", blocking_reasons: [] },
        { scene_index: 2, block_id: "block_city", visual_intent: "city", blocking_reasons: [] },
      ],
      micro_coverage_gaps: [
        {
          micro_id: "micro_1",
          scene_index: 1,
          block_id: "block_gastro",
          visual_need: "food_closeup",
          criticality: "high",
          needs_visual_proof: true,
        },
      ],
    },
    render_timeline: {
      timeline_sync_metrics: {
        low_diversity_blocks: ["block_gastro"],
      },
    },
  };

  const result = buildLocalRepairPlan({ state, selectedSceneIndexes: [1, 2] });
  assert.strictEqual(result.summary.total_blocks, 2, "deveria haver 2 blocos avaliados");
  assert.strictEqual(result.summary.repair_required_blocks, 1, "deveria exigir repair em 1 bloco");
  assert(result.scene_indexes_to_refresh.includes(1), "scene 1 deveria estar em refresh");
  assert(!result.scene_indexes_to_refresh.includes(2), "scene 2 forte não deveria estar em refresh");

  const blockGastro = result.block_states.find((entry) => entry.block_id === "block_gastro");
  assert(blockGastro, "block_gastro deveria existir");
  assert.strictEqual(blockGastro.block_state, REPAIR_BLOCK_STATE.REPAIR_REQUIRED, "block_gastro deveria estar em repair_required");
  assert(blockGastro.causes.includes("missing_food_closeup"), "causa missing_food_closeup obrigatória");
  assert(blockGastro.causes.includes("weak_only_people_eating"), "causa weak_only_people_eating obrigatória");
  assert(blockGastro.causes.includes("weak_phrase_alignment"), "causa weak_phrase_alignment obrigatória");
  assert(blockGastro.causes.includes("repeated_visual_family"), "causa repeated_visual_family obrigatória");

  const repairScene = result.repair_by_scene.find((entry) => entry.scene_index === 1);
  assert(repairScene, "scene 1 precisa de plano de repair");
  assert(repairScene.repair_actions.includes("search_slot_gap"), "repair de gap por slot obrigatório");
  assert(repairScene.repair_actions.includes("recut_timing_window"), "repair de timing local obrigatório");
  assert(repairScene.repair_actions.includes("diversify_visual_family"), "repair de diversidade obrigatório");
  assert(repairScene.target_micro_needs.includes("food_closeup"), "food_closeup deve virar target micro need");
};

testResolveBlockState();
testBuildLocalRepairPlan();

console.log("repair planner service validado com sucesso");
