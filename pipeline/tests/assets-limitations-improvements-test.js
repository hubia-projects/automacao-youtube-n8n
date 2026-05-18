const assert = require("assert");
const { __test__ } = require("../src/services/assetsService");

const testLibraryPoolFallsBackWhenStrictMatchMissing = () => {
  const library = {
    assets: [
      {
        asset_id: "a1",
        source_url: "https://cdn.local/a1.mp4",
        reuse_allowed: true,
        quality_score: 0.82,
        usage_count: 2,
        intents: ["city_landmark"],
        cities: ["porto"],
        slot_types_supported: ["food_closeup"],
        source: "library",
        source_tier: "curated",
        visual_family: "food_market_closeup",
      },
      {
        asset_id: "a2",
        source_url: "https://cdn.local/a2.mp4",
        reuse_allowed: true,
        quality_score: 0.78,
        usage_count: 1,
        intents: ["generic_travel"],
        cities: ["coimbra"],
        slot_types_supported: ["market_stall"],
        source: "library",
        source_tier: "free",
        visual_family: "market_vendor_action",
      },
    ],
  };

  const blockPackage = {
    intent: "gastronomy",
    slots_required: [{ slot_type: "food_closeup", min_count: 1 }],
  };
  const representativeScene = {
    visual_intent: "gastronomy",
    expected_location: "lisboa",
    location: { city: "Lisboa" },
    block_label: "Lisboa gastronomia",
  };

  const pool = __test__.buildLibraryCandidatePoolForBlock({
    library,
    blockPackage,
    representativeScene,
    negativeKeywords: [],
    limit: 5,
  });

  assert(pool.length > 0, "deveria retornar candidatos de biblioteca mesmo sem match estrito");
  assert(
    pool.some((candidate) => ["slot_only", "broad", "relaxed_geo", "relaxed_intent"].includes(String(candidate.library_match_tier || ""))),
    "deveria usar fallback relaxado de match tier quando strict não cobre"
  );
};

const testAdaptiveProviderCapDoesNotOverPruneLowSupply = () => {
  const shortlist = Array.from({ length: 6 }).map((_, index) => ({
    source_url: `https://single-provider/video-${index + 1}.mp4`,
    provider: "pexels",
    pre_download_score: 10 - index,
    _slot_score: 9 - index,
    slot_id: "slot_food_1",
    slot_type: "food_closeup",
  }));

  const selected = __test__.selectCoverageFirstFinalists({
    shortlist,
    blockPackage: {
      slots_required: [{ slot_id: "slot_food_1", slot_type: "food_closeup", min_count: 2 }],
    },
    limit: 6,
  });

  assert.strictEqual(selected.length, 6, "não deveria podar agressivamente quando só existe 1 provider disponível");
};

testLibraryPoolFallsBackWhenStrictMatchMissing();
testAdaptiveProviderCapDoesNotOverPruneLowSupply();

console.log("assets limitations improvements validado com sucesso");
