const assert = require("assert");
const { evaluateCoverageGate, COVERAGE_STATUS } = require("../src/services/coverageGateService");

const blockPackages = [
  {
    package_id: "pkg_001",
    block_id: "b1",
    intent: "gastronomy",
    scene_indexes: [1],
    slots: [
      { slot_id: "b1:food_closeup:01", slot_type: "food_closeup", required: true, min_count: 1, requires_visual_proof: true, criticality: "high" },
      { slot_id: "b1:people_eating:01", slot_type: "people_eating", required: true, min_count: 1, requires_visual_proof: true, criticality: "high" },
    ],
  },
  {
    package_id: "pkg_002",
    block_id: "b2",
    intent: "city_landmark",
    scene_indexes: [2],
    slots: [
      { slot_id: "b2:street_level:01", slot_type: "street_level", required: true, min_count: 1, requires_visual_proof: true, criticality: "high" },
      { slot_id: "b2:landmark:01", slot_type: "landmark", required: true, min_count: 1, requires_visual_proof: true, criticality: "high" },
    ],
  },
];

const slotCoverageByBlock = [
  {
    block_id: "b1",
    slot_coverage: [
      { slot_id: "b1:food_closeup:01", slot_type: "food_closeup", selected_count: 2, eligible_count: 1, coverage_count: 1, min_count: 1, covered: true },
      { slot_id: "b1:people_eating:01", slot_type: "people_eating", selected_count: 1, eligible_count: 0, coverage_count: 0, min_count: 1, covered: false },
    ],
  },
  {
    block_id: "b2",
    slot_coverage: [
      { slot_id: "b2:street_level:01", slot_type: "street_level", selected_count: 2, eligible_count: 2, coverage_count: 1, min_count: 1, covered: true },
      { slot_id: "b2:landmark:01", slot_type: "landmark", selected_count: 2, eligible_count: 2, coverage_count: 1, min_count: 1, covered: true },
    ],
  },
];

const blockCandidateFunnel = [
  { block_id: "b1", approved_count: 3, distinct_visual_families: 2, repair_rounds_used: 0 },
  { block_id: "b2", approved_count: 6, distinct_visual_families: 4, repair_rounds_used: 1 },
];

const report = evaluateCoverageGate({
  blockPackages,
  slotCoverageByBlock,
  blockCandidateFunnel,
});

const block1 = report.blocks.find((item) => item.block_id === "b1");
const block2 = report.blocks.find((item) => item.block_id === "b2");

assert(block1, "bloco b1 deve existir");
assert(block2, "bloco b2 deve existir");
assert.strictEqual(block1.coverage_status, COVERAGE_STATUS.PARTIAL, "b1 deveria ficar partial");
assert.strictEqual(block1.needs_repair, true, "b1 deveria exigir repair");
assert.strictEqual(block1.can_advance, false, "b1 nao deveria avançar sem partial override");
assert(block1.missing_slots.includes("people_eating"), "b1 deveria listar slot faltante");
assert(block1.weak_only_slots.includes("people_eating"), "b1 deveria listar weak-only");

assert.strictEqual(block2.coverage_status, COVERAGE_STATUS.STRONG, "b2 deveria ficar strong");
assert.strictEqual(block2.can_advance, true, "b2 deveria poder avançar");

assert.strictEqual(report.summary.total, 2, "summary total");
assert.strictEqual(report.summary.strong, 1, "summary strong");
assert.strictEqual(report.summary.partial, 1, "summary partial");

console.log("coverage gate service validado com sucesso");

