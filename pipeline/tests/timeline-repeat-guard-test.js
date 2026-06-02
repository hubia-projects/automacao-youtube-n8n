const assert = require("assert");
const { __test__ } = require("../src/services/timelinePlanner");

const buildClipLibraryCandidate = (overrides = {}) => ({
  id: overrides.id || "cliplib_a",
  asset_id: overrides.asset_id || "clip_a",
  source_asset_id: overrides.source_asset_id || "raw_asset_a",
  source: "clip_library",
  from_clip_library: true,
  clip_library_id: overrides.clip_library_id || "clip_a",
  block_id: overrides.block_id || "block_1",
  scene_index: overrides.scene_index || 1,
  tags: overrides.tags || ["street"],
  location: overrides.location || { city: "Lisboa", country: "Portugal" },
  landmarks: overrides.landmarks || [],
  visual_features: overrides.visual_features || { shot_type: "wide", camera_motion: "pan" },
  asset: {
    provider: "clip_library",
    asset_id: overrides.asset_id || "clip_a",
    source_asset_id: overrides.source_asset_id || "raw_asset_a",
  },
});

const buildExternalCandidate = (overrides = {}) => ({
  id: overrides.id || "pexels_a",
  asset_id: overrides.asset_id || "asset_ext_a",
  source_asset_id: overrides.source_asset_id || "asset_ext_a",
  source: overrides.source || "pexels",
  from_clip_library: false,
  block_id: overrides.block_id || "block_1",
  scene_index: overrides.scene_index || 1,
  tags: overrides.tags || ["street"],
  location: overrides.location || { city: "Lisboa", country: "Portugal" },
  landmarks: overrides.landmarks || [],
  visual_features: overrides.visual_features || { shot_type: "wide", camera_motion: "pan" },
  asset: {
    provider: overrides.source || "pexels",
    asset_id: overrides.asset_id || "asset_ext_a",
    source_asset_id: overrides.source_asset_id || "asset_ext_a",
  },
});

const run = async () => {
  const block = { block_id: "block_1", scene_index: 1 };
  const usage = {
    usedBlockProviders: new Map([["block_1:clip_library", 1]]),
    usedClipLibraryIds: new Map(),
    usedBlockVisualSignatures: new Map(),
    usedBlockLandmarks: new Map(),
    usedBlockAssetIds: new Map(),
  };

  const differentClipFromLibrary = buildClipLibraryCandidate({
    id: "cliplib_b",
    asset_id: "clip_b",
    source_asset_id: "raw_asset_b",
    clip_library_id: "clip_b",
  });

  assert.strictEqual(
    __test__.candidateRespectsDiversityQuotas({
      candidate: differentClipFromLibrary,
      block,
      usage,
      criticalSlot: true,
    }),
    true,
    "nao deve bloquear toda a Clip Library apenas porque um clip_library ja apareceu no bloco"
  );

  usage.usedBlockAssetIds.set("block_1:raw_asset_b", 1);
  assert.strictEqual(
    __test__.candidateRespectsDiversityQuotas({
      candidate: differentClipFromLibrary,
      block,
      usage,
      criticalSlot: false,
    }),
    false,
    "deve bloquear reuso do mesmo video-base dentro do mesmo bloco"
  );

  const externalCandidate = buildExternalCandidate();
  const prioritizedPool = __test__.prioritizeClipLibraryPoolForSlot({
    block,
    slotRole: "context_regional",
    assetWindows: [differentClipFromLibrary, externalCandidate],
  });

  assert.strictEqual(prioritizedPool.length, 2, "deve manter candidatos externos no pool quando houver hits da Clip Library");
  assert.strictEqual(prioritizedPool[0].id, differentClipFromLibrary.id, "deve manter a Clip Library priorizada no inicio do pool");
  assert.strictEqual(
    prioritizedPool.some((candidate) => candidate.id === externalCandidate.id),
    true,
    "deve preservar fallback externo para quebrar repeticao quando a Clip Library ficar fraca"
  );

  const repeatedSelected = {
    candidate: buildClipLibraryCandidate({
      id: "cliplib_repeat",
      asset_id: "clip_repeat",
      source_asset_id: "raw_asset_repeat",
      clip_library_id: "clip_repeat",
    }),
    score: 9,
  };
  const alternative = {
    candidate: buildClipLibraryCandidate({
      id: "cliplib_alt",
      asset_id: "clip_alt",
      source_asset_id: "raw_asset_alt",
      clip_library_id: "clip_alt",
      visual_features: { shot_type: "closeup", camera_motion: "static" },
      tags: ["food"],
    }),
    score: 8,
  };

  const chosen = __test__.pickAdjacencyDiversityAlternative({
    ranked: [repeatedSelected, alternative],
    selected: repeatedSelected,
    block,
    clips: [
      {
        block_id: "block_1",
        clip_library_id: "clip_repeat",
        source_asset_id: "raw_asset_repeat",
        visual_signature: "dummy",
      },
    ],
    microMoment: null,
  });

  assert.strictEqual(chosen.candidate.id, "cliplib_alt", "deve trocar por alternativa quando o mesmo trecho reaparece na sequencia recente");

  console.log("timeline repeat guard validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});