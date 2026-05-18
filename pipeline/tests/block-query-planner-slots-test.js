const assert = require("assert");
const { buildBlockQueryPlan } = require("../src/services/assetQueryPlanner");

const block = {
  block_id: "lisboa_food",
  block_label: "Lisboa",
  expected_location: "Lisboa",
  location: { city: "Lisboa", country: "Portugal" },
  visual_intent: "gastronomy",
  keywords: ["market", "food", "restaurant"],
  negative_keywords: ["skyline", "drone"],
};

const slots = [
  {
    slot_id: "lisboa_food:food_closeup:01",
    slot_type: "food_closeup",
    priority: 10,
    required: true,
    requires_visual_proof: true,
    generic_tolerance: "low",
    query_hints: ["food close up", "local dish close up"],
  },
  {
    slot_id: "lisboa_food:market_stall:02",
    slot_type: "market_stall",
    priority: 8,
    required: true,
    requires_visual_proof: true,
    generic_tolerance: "low",
    query_hints: ["market stall food"],
  },
];

const plan = buildBlockQueryPlan({ block, slots, topic: "Portugal gastronomia" });
assert(plan.queryDetails.length > 0, "deveria gerar queries por slot");
assert(plan.queryDetails.some((entry) => entry.slot_type === "food_closeup"), "deveria incluir slot food_closeup");
assert(plan.queryDetails.some((entry) => entry.slot_type === "market_stall"), "deveria incluir slot market_stall");
assert(plan.queryDetails.every((entry) => entry.slot_id), "query_details deve incluir slot_id");
assert((plan.negativeKeywords || []).includes("skyline"), "deveria propagar negative keywords do bloco");
assert(Number(plan.retrievalBudget.vision_finalists_per_block || 0) >= 4, "budget econômico deve constar no plano");

console.log("block-query-planner-slots-test ok");
