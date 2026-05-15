const assert = require("assert");
const { rankCandidates } = require("../src/services/timelineScoringService");

const block = {
  block_id: "porto_block",
  visual_intent: "city_landmark",
  required_visual_evidence: ["city_landmark"],
  allowed_visual_categories: ["city_landmark", "historic_street", "aerial_city"],
  forbidden_visual_categories: [],
  generic_asset_allowed: true,
  location: { city: "Porto", country: "Portugal" },
  topic_type: "city",
  macro_topic: "Porto",
  narration_excerpt: "Porto entra com abertura do novo bloco",
  keywords: ["porto", "landmark"],
  hard_boundary: true,
};

const baseCandidate = {
  asset_id: "base",
  id: "base_w01",
  asset: { asset_type: "video", provider: "mock", source_url: "https://example.com/base.mp4" },
  description: "Porto landmark historic district",
  semantic_text: "Porto landmark historic district",
  tags: ["porto", "landmark"],
  location: { city: "Porto", country: "Portugal", confidence: 0.9 },
  landmarks: [],
  location_type: "historic_street",
  visual_features: { camera_motion: "tracking", shot_type: "wide" },
  quality: { resolution_score: 1, brightness: 0.8, usable: true },
  confidence: 0.8,
  start_sec: 0,
  end_sec: 6,
  duration_sec: 6,
  detected_visual_categories: ["city_landmark", "historic_street"],
  detected_objects: [],
  editorial_approved: true,
  critical_slot_allowed: true,
  narrative_roles_supported: ["proof_exact", "opening_establishing"],
  opening_allowed: true,
  closing_allowed: true,
};

const run = async () => {
  const ranked = await rankCandidates({
    block,
    narrationText: "Porto abre com landmark forte",
    candidates: [
      { ...baseCandidate, asset_id: "with_bonus", id: "with_bonus_w01", asset: { ...baseCandidate.asset, block_intro_candidate: true } },
      { ...baseCandidate, asset_id: "without_bonus", id: "without_bonus_w01", asset: { ...baseCandidate.asset, block_intro_candidate: false } },
    ],
    previousMacroTopic: "Lisboa",
    usage: {
      usedSourceUrls: new Map(),
      usedAssetIds: new Map(),
      usedLocalPaths: new Map(),
      usedWindowIds: new Map(),
      usedProviders: new Map(),
      usedBlockAssetIds: new Map(),
      usedVisualSignatures: new Map(),
      lastClipByAssetId: new Map(),
    },
    videoId: "hb_bonus_sign_test",
    clipIndex: 1,
    isBoundaryFirstSlot: true,
    slotRole: "opening_establishing",
    hardBoundaryPolicy: {
      enabled: true,
      forbid_neutral_first_clip: true,
      require_location_on_hard_boundary: true,
      fail_on_missing_boundary_candidate: true,
    },
  });

  assert.strictEqual(ranked[0].candidate.asset_id, "with_bonus", "hardBoundaryIntroBonus deveria favorecer candidato de intro");
  console.log("hard-boundary-intro-bonus-sign-test ok");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
