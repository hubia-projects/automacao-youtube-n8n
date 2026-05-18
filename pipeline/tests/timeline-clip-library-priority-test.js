const assert = require("assert");
const { __test__ } = require("../src/services/timelinePlanner");

const run = async () => {
  const block = {
    scene_index: 3,
    block_id: "block_003",
  };
  const slotRole = "proof_exact";
  const rawCandidate = {
    id: "raw_1",
    from_clip_library: false,
    scene_index: 3,
    block_id: "block_003",
    narrative_roles_supported: ["proof_exact"],
  };
  const clipLibraryCandidate = {
    id: "cliplib_1",
    from_clip_library: true,
    clip_library_id: "clip_abc",
    scene_index: 3,
    block_id: "block_003",
    narrative_roles_supported: ["proof_exact", "detail_cutaway"],
  };
  const prioritized = __test__.prioritizeClipLibraryPoolForSlot({
    block,
    slotRole,
    assetWindows: [rawCandidate, clipLibraryCandidate],
  });
  assert.strictEqual(prioritized.length, 1, "deveria priorizar somente pool de clip library quando existir");
  assert.strictEqual(prioritized[0].id, "cliplib_1", "candidate da clip library deve ser escolhido");

  const fallback = __test__.prioritizeClipLibraryPoolForSlot({
    block,
    slotRole,
    assetWindows: [rawCandidate],
  });
  assert.strictEqual(fallback.length, 1, "sem clip library deve manter pool original");
  assert.strictEqual(fallback[0].id, "raw_1", "fallback deve usar asset cru");

  console.log("timeline clip library priority validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

