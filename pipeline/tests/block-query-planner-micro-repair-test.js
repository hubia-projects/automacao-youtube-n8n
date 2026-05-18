const assert = require("assert");
const { buildBlockQueryPlan } = require("../src/services/assetQueryPlanner");

const run = async () => {
  const plan = buildBlockQueryPlan({
    block: {
      block_id: "lisboa_gastro",
      block_label: "Lisboa",
      visual_intent: "gastronomy",
      expected_location: "lisboa",
      location: { city: "Lisboa", country: "Portugal" },
      keywords: ["mercado", "comida"],
      negative_keywords: ["skyline"],
      forbidden_locations: ["paris"],
    },
    slots: [
      {
        slot_id: "s1",
        slot_type: "vendor_interaction",
        priority: 9,
        generic_tolerance: "low",
        requires_visual_proof: true,
        query_hints: ["vendor serving food"],
      },
    ],
    topic: "Portugal gastronomia",
    repairHints: {
      target_micro_needs: ["vendor_interaction"],
      micro_repair_queries: ["lisboa vendor interaction authentic real action"],
      force_exact_required: true,
      extra_negative_keywords: ["drone", "aerial"],
    },
    budgetProfile: {
      raw_candidates_per_block: 60,
      cheap_shortlist_per_block: 20,
      vision_finalists_per_block: 8,
      max_repair_rounds_per_block: 1,
    },
  });

  assert((plan.queryDetails || []).some((entry) => /repair_micro_need_vendor_interaction/i.test(String(entry.reason || ""))), "deve gerar query de repair por micro need");
  assert((plan.queries || []).some((query) => /vendor interaction|vendor serving|authentic real action/i.test(String(query))), "queries devem refletir need micro");
  assert((plan.negativeKeywords || []).includes("drone"), "negative keyword de repair deve propagar");
  assert((plan.queryDetails || []).some((entry) => String(entry.slot_type || "").toLowerCase() === "vendor_interaction"), "query micro deve manter vínculo com slot");

  console.log("block query planner micro repair validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

