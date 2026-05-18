const assert = require("assert");
const { __test__ } = require("../src/services/timelineScoringService");

const candidate = {
  source_tier: "free",
  source: "pexels",
  editorial_confidence: 0.85,
  visual_truth_status: "exact",
};

const highReliability = __test__.computeSourceTierScore({
  candidate,
  criticalSlot: true,
  providerReliability: { pexels: 0.9 },
});

const lowReliability = __test__.computeSourceTierScore({
  candidate,
  criticalSlot: true,
  providerReliability: { pexels: 0.2 },
});

assert(highReliability > lowReliability, "slot crítico deve favorecer provider com maior confiabilidade");
console.log("timeline-provider-reliability-critical-test ok");
