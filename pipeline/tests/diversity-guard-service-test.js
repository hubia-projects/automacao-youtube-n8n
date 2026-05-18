const assert = require("assert");
const {
  __test__,
  filterCandidatesByHardDiversity,
  enrichCandidateIdentity,
} = require("../src/services/diversityGuardService");

const buildCandidate = (overrides = {}) => ({
  asset_id: overrides.asset_id || "asset_a",
  source_url: overrides.source_url || "https://example.com/a.mp4",
  content_slot_type: overrides.content_slot_type || "market_stall",
  detected_visual_categories: overrides.detected_visual_categories || ["market"],
  detected_objects: overrides.detected_objects || ["vendor"],
  visual_features: overrides.visual_features || { shot_type: "wide", has_people: true },
  landmarks: overrides.landmarks || [{ name: "Mercado da Ribeira", city: "Lisboa" }],
  location: overrides.location || { city: "Lisboa", country: "Portugal" },
  ...overrides,
});

const run = async () => {
  const block = { block_id: "b1", visual_intent: "gastronomy" };
  const recentClips = [
    { visual_family: "market_stall|wide|proof", landmark_id: "mercado da ribeira|lisboa", scene_function: "context", asset_id: "x1", source_url: "https://example.com/x1.mp4" },
    { visual_family: "market_stall|wide|proof", landmark_id: "mercado da ribeira|lisboa", scene_function: "context", asset_id: "x2", source_url: "https://example.com/x2.mp4" },
  ];
  const candidate = enrichCandidateIdentity({
    candidate: buildCandidate({ visual_family: "market_stall|wide|proof", landmark_id: "mercado da ribeira|lisboa", scene_function: "context" }),
    slotRole: "proof_exact",
    block,
  });
  const decision = __test__.evaluateCandidateHardDiversity({
    candidate,
    recentBlockClips: recentClips,
    blockClips: recentClips,
    block,
    slotRole: "proof_exact",
    criticalSlot: false,
  });
  assert(decision.allowed === false, "deveria bloquear repeticao de familia visual recente");
  assert(decision.violations.includes("repeat_visual_family_recent"), "deveria registrar motivo de repeticao de familia");

  const candidates = [
    buildCandidate({ asset_id: "same", source_url: "https://example.com/a.mp4", content_slot_type: "market_stall" }),
    buildCandidate({
      asset_id: "new",
      source_url: "https://example.com/b.mp4",
      content_slot_type: "food_closeup",
      visual_features: { shot_type: "closeup", has_people: false },
      landmarks: [{ name: "Rua Augusta", city: "Lisboa" }],
    }),
  ];
  const filtered = filterCandidatesByHardDiversity({
    candidates,
    clips: [
      { block_id: "b1", visual_family: "market_stall|wide|proof", landmark_id: "mercado da ribeira|lisboa", source_url: "https://example.com/a.mp4", scene_function: "context", asset_id: "same" },
      { block_id: "b1", visual_family: "market_stall|wide|proof", landmark_id: "mercado da ribeira|lisboa", source_url: "https://example.com/x2.mp4", scene_function: "context", asset_id: "x2" },
    ],
    block,
    slotRole: "detail_cutaway",
    criticalSlot: false,
  });
  assert(filtered.allowed_candidates.length === 1, "deveria manter apenas candidato diverso");
  assert(String(filtered.allowed_candidates[0].asset_id) === "new", "deveria selecionar candidato alternativo");

  const audit = __test__.buildBlockDiversityAudit({
    block,
    clips: [
      { block_id: "b1", visual_family: "market_stall|wide|context", scene_function: "context", landmark_id: "m1", source_url: "u1" },
      { block_id: "b1", visual_family: "market_stall|wide|context", scene_function: "context", landmark_id: "m1", source_url: "u1" },
      { block_id: "b1", visual_family: "market_stall|wide|context", scene_function: "context", landmark_id: "m1", source_url: "u1" },
    ],
  });
  assert(audit.low_diversity_block === true, "deveria marcar bloco monotematico como baixa diversidade");
  assert(audit.missing_scene_functions.includes("proof"), "deveria detectar ausencia de prova visual");
  console.log("diversity guard service validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
