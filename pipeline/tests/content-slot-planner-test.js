const assert = require("assert");
const { buildBlockContentPackages } = require("../src/services/contentSlotPlannerService");

const visualPlan = [
  {
    scene_index: 1,
    block_id: "lisboa_food",
    block_label: "Lisboa gastronomia",
    visual_intent: "gastronomy",
    narrative_function: "hook",
    probable_shot_role: "hook_exact",
    role: "intro",
  },
  {
    scene_index: 2,
    block_id: "lisboa_food",
    block_label: "Lisboa gastronomia",
    visual_intent: "gastronomy",
    narrative_function: "proof",
    probable_shot_role: "proof_exact",
    role: "body",
  },
];

const packages = buildBlockContentPackages({ visualPlan });
assert.strictEqual(packages.length, 1, "deveria gerar pacote por bloco");
const pkg = packages[0];
assert(pkg.slots_required.some((slot) => slot.slot_type === "food_closeup"), "gastronomia deve exigir food_closeup");
assert(pkg.slots_required.some((slot) => slot.slot_type === "market_stall"), "gastronomia deve exigir market_stall");
const cityContext = pkg.slots.find((slot) => slot.slot_type === "city_context");
assert(cityContext && cityContext.max_count <= 1, "city_context deve ter teto baixo no bloco gastronômico");
assert(Number(pkg.budget_profile.vision_finalists_per_block || 0) >= 4, "budget econômico precisa manter finalistas de visão");

console.log("content-slot-planner-test ok");
