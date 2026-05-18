const assert = require("assert");
const { buildEditorialRegenerationPlan } = require("../src/services/editorialRepairPlanner");

const run = async () => {
  const plan = buildEditorialRegenerationPlan({
    issues: [
      {
        type: "micro_proof_missing",
        severity: "critical",
        scene_indexes: [3],
        micro_needs_by_scene: {
          3: ["vendor_interaction", "market_stall"],
        },
      },
    ],
    sceneIndexesToRefresh: [],
    sceneEditorialReadiness: [],
  });

  assert(plan.scene_indexes_to_refresh.includes(3), "cena com micro falho deve entrar no refresh");
  const repairScene3 = (plan.repair_by_scene || []).find((item) => Number(item.scene_index || 0) === 3);
  assert(repairScene3, "plano de reparo por cena deve existir");
  assert((repairScene3.target_micro_needs || []).includes("vendor_interaction"), "micro need deve propagar para repair");
  assert((repairScene3.micro_repair_queries || []).some((query) => /vendor interaction|vendor_interaction/i.test(query)), "query de repair micro deve ser gerada");
  assert(repairScene3.force_exact_required === true, "micro proof missing deve forçar exact");

  console.log("editorial repair micro plan validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

