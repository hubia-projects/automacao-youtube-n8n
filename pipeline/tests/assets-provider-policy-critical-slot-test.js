const assert = require("assert");
const { __test__ } = require("../src/services/assetsService");

const slot = {
  slot_id: "s1",
  slot_type: "food_closeup",
  requires_visual_proof: true,
  criticality: "critical",
  min_count: 1,
};

const candidates = [
  { source_url: "https://a", provider: "pexels", provider_reliability_score: 0.25, pre_download_score: 3 },
  { source_url: "https://b", provider: "pixabay", provider_reliability_score: 0.7, pre_download_score: 2 },
];

const filtered = __test__.filterSlotCandidatesByProviderPolicy({
  candidates,
  slot,
  minProviderReliability: 0.45,
});

assert(filtered.some((item) => item.source_url === "https://b"), "deve manter candidato confiável em slot crítico");
assert(!filtered.some((item) => item.source_url === "https://a") || filtered.length === 1, "deve reduzir candidatos muito fracos quando há opção melhor");

console.log("assets-provider-policy-critical-slot-test ok");
