const assert = require("assert");
const { __test__ } = require("../src/services/assetsService");

const run = async () => {
  const state = {
    visual_plan: [
      { scene_index: 1, block_id: "b_food" },
      { scene_index: 2, block_id: "b_food" },
    ],
    render_timeline: {
      clips: [
        { scene_index: 1, block_id: "b_food", source_url: "https://example.com/a.mp4", asset_id: "a1", visual_family: "market_stall|wide|context" },
        { scene_index: 1, block_id: "b_food", source_url: "https://example.com/b.mp4", asset_id: "a2", visual_family: "market_stall|wide|context" },
      ],
      micro_sync_metrics: {
        low_diversity_blocks: ["b_food"],
        diversity_blocks: [
          {
            block_id: "b_food",
            missing_scene_functions: ["proof", "human_action"],
          },
        ],
        micro_coverage_gaps: [],
      },
    },
    assets_json: {
      micro_coverage_gaps: [],
    },
  };

  const plan = __test__.buildAutoRepairPlanByScene({
    state,
    selectedSceneIndexes: [1, 2],
  });

  assert(plan.length >= 1, "deve gerar plano de repair automático");
  const first = plan[0];
  assert((first.diversity_repair_queries || []).length > 0, "deve sugerir queries de diversidade");
  assert((first.avoid_source_urls || []).includes("https://example.com/a.mp4"), "deve bloquear source_url repetido");
  assert((first.avoid_visual_families || []).includes("market_stall|wide|context"), "deve bloquear família visual repetida");
  assert((first.target_narrative_roles || []).includes("proof_exact"), "deve priorizar role de prova");
  assert(first.force_exact_required === true, "deve forçar prova exata em repair de diversidade");

  const skip = __test__.shouldSkipCandidateByRepairConstraints({
    candidate: { source_url: "https://example.com/a.mp4" },
    repairHints: { avoid_source_urls: ["https://example.com/a.mp4"] },
  });
  assert(skip === true, "deve pular candidato bloqueado por repair");

  console.log("assets auto repair diversity validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

