const assert = require("assert");
const { buildBlockQueryPlan } = require("../src/services/assetQueryPlanner");

const run = async () => {
  const plan = buildBlockQueryPlan({
    block: {
      block_id: "porto_food",
      block_label: "Porto",
      visual_intent: "gastronomy",
      expected_location: "porto",
      location: { city: "Porto", country: "Portugal" },
      keywords: ["mercado", "vinho"],
      negative_keywords: [],
      forbidden_locations: [],
    },
    slots: [
      {
        slot_id: "s1",
        slot_type: "food_closeup",
        priority: 10,
        generic_tolerance: "low",
        requires_visual_proof: true,
        query_hints: ["food close up", "market food"],
      },
    ],
    topic: "Porto gastronomia",
    repairHints: {
      diversity_repair_queries: ["people eating local food interaction", "close up detail local food product"],
      avoid_visual_families: ["market_stall|wide|context"],
      extra_negative_keywords: ["drone"],
    },
    budgetProfile: {
      raw_candidates_per_block: 60,
      cheap_shortlist_per_block: 20,
      vision_finalists_per_block: 8,
      max_repair_rounds_per_block: 1,
    },
  });

  assert((plan.queryDetails || []).some((entry) => String(entry.reason || "").includes("repair_diversity_query_")), "deve gerar query de repair por diversidade");
  assert((plan.queries || []).some((query) => /people eating local food interaction|close up detail local food product/i.test(String(query))), "queries de diversidade devem entrar no plano");
  assert((plan.negativeKeywords || []).some((keyword) => String(keyword || "").toLowerCase() === "market_stall"), "família repetida deve virar negativo de busca");
  assert((plan.negativeKeywords || []).includes("drone"), "negativos explícitos devem permanecer");

  console.log("block query planner diversity repair validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
