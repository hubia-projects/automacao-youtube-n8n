const assert = require("assert");
const { rankCandidates } = require("../src/services/timelineScoringService");

const run = async () => {
  const block = {
    block_id: "lisboa_market",
    visual_intent: "gastronomy",
    required_visual_evidence: ["market", "food"],
    allowed_visual_categories: ["market", "food", "people_eating"],
    forbidden_visual_categories: ["aerial_city", "bridge", "river"],
    generic_asset_allowed: false,
    location: { city: "Lisboa", country: "Portugal" },
    topic_type: "city",
    macro_topic: "Lisboa",
  };
  const drone = {
    asset_id: "drone",
    id: "drone_w01",
    asset: { asset_type: "video", provider: "pexels", source_url: "https://example.com/drone.mp4" },
    description: "aerial view of market district and city skyline",
    semantic_text: "market district skyline aerial",
    tags: ["aerial", "city", "market district"],
    location: { city: "Lisboa", country: "Portugal", confidence: 0.9 },
    visual_features: { camera_motion: "drone", shot_type: "wide" },
    quality: { resolution_score: 1, brightness: 0.8, usable: true },
    confidence: 0.8,
    duration_sec: 6,
    detected_visual_categories: ["aerial_city", "generic_street"],
    visual_truth_status: "regional",
    micro_needs_supported: ["street_level"],
    action_tokens_detected: [],
  };
  const vendor = {
    asset_id: "vendor",
    id: "vendor_w01",
    asset: { asset_type: "video", provider: "pexels", source_url: "https://example.com/vendor.mp4" },
    description: "vendor serving food at local market stall to customers",
    semantic_text: "vendor serving market stall food",
    tags: ["vendor", "serving", "food", "market stall"],
    location: { city: "Lisboa", country: "Portugal", confidence: 0.8 },
    visual_features: { camera_motion: "tracking", shot_type: "medium" },
    quality: { resolution_score: 1, brightness: 0.8, usable: true },
    confidence: 0.8,
    duration_sec: 5,
    detected_visual_categories: ["market", "food", "people_eating"],
    visual_truth_status: "exact",
    micro_needs_supported: ["vendor_interaction", "market_stall", "food_closeup"],
    action_tokens_detected: ["serving"],
  };

  const ranked = await rankCandidates({
    block,
    narrationText: "o vendedor serve produtos frescos no mercado",
    candidates: [drone, vendor],
    previousMacroTopic: "",
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
    videoId: "timeline_micro_scoring_test",
    clipIndex: 1,
    microMoment: {
      micro_id: "mic_0001",
      visual_need: "vendor_interaction",
      action_tokens: ["serving"],
      needs_visual_proof: true,
      start_sec: 3,
      end_sec: 6,
    },
    slotStartSec: 3,
    slotEndSec: 6,
  });

  assert.strictEqual(ranked[0].candidate.id, "vendor_w01", "janela de vendedor deve vencer drone para microtrecho de serviço");
  assert(ranked[0].features.microNeedExactMatchScore > ranked[1].features.microNeedExactMatchScore, "micro need exato deve favorecer o candidato correto");
  assert(ranked[0].features.microActionMatchScore >= ranked[1].features.microActionMatchScore, "ação detectada deve ajudar no micro match");

  console.log("timeline micro scoring validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

