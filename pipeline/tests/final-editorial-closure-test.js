const assert = require("assert");
process.env.PRE_RENDER_EDITORIAL_FAIL_FAST = "true";
process.env.QA_RUNTIME_PROFILE_PROD = "prod_strict";
process.env.EDITORIAL_STRONG_ONLY_PRE_RENDER = "true";
process.env.COVERAGE_GATE_ALLOW_PARTIAL = "false";
const { __test__: assetsTest } = require("../src/services/assetsService");
const { approveAssetsForVisualPlan } = require("../src/services/assetApprovalService");
const { __test__: timelineRepairTest, findLocalRecutCandidate } = require("../src/services/timelineRepairExecutorService");
const { __test__: renderTest } = require("../src/services/renderService");
const { __test__: syncTest } = require("../src/services/syncValidator");

const testLocalCuratedProviderContract = () => {
  const candidates = assetsTest.buildLocalCuratedCandidatesFromIndex({
    query: "lisbon food market vendor",
    limit: 4,
    entries: [{
      asset_id: "curated-food-1",
      local_path: "food-market.mp4",
      title: "Lisbon food market vendor",
      tags: ["food", "market", "vendor"],
      slot_types_supported: ["market_stall", "vendor_interaction"],
      intents: ["gastronomy"],
      cities: ["lisbon"],
      quality_score: 0.91,
      width: 1920,
      height: 1080,
    }],
  });

  assert.strictEqual(candidates.length, 1, "local_curated deve retornar candidato compatível");
  assert.strictEqual(candidates[0].provider, "local_curated");
  assert.strictEqual(candidates[0].source_tier, "curated", "local_curated entra como camada curada");
};

const testAdaptiveBudgetEscalatesForCriticalRepair = () => {
  const normal = assetsTest.resolveAdaptiveBudgetProfile({
    blockPackage: { budget_profile: { raw_candidates_per_block: 60, cheap_shortlist_per_block: 20, vision_finalists_per_block: 8 } },
    repairHints: {},
  });
  const scarcity = assetsTest.resolveAdaptiveBudgetProfile({
    blockPackage: { budget_profile: { raw_candidates_per_block: 60, cheap_shortlist_per_block: 20, vision_finalists_per_block: 8 } },
    repairHints: { target_micro_needs: ["vendor_interaction"], force_exact_required: true },
  });

  assert(Number(scarcity.raw_candidates_per_block) >= Number(normal.raw_candidates_per_block), "budget de escassez deve aumentar candidatos brutos");
  assert(Number(scarcity.vision_finalists_per_block) >= Number(normal.vision_finalists_per_block), "budget de escassez deve aumentar finalistas de visão");
};

const testWeakFallbackCannotBecomeExactProof = () => {
  const result = approveAssetsForVisualPlan({
    visualPlan: [{
      scene_index: 1,
      role: "body",
      visual_intent: "gastronomy",
      required_visual_evidence: ["food"],
      allowed_visual_categories: ["food", "market"],
      forbidden_visual_categories: ["skyline", "bridge"],
      generic_asset_allowed: false,
      expected_location: "Lisboa",
      location: { city: "Lisboa", country: "Portugal" },
    }],
    assets: [{
      scene_index: 1,
      provider: "metadata_fallback",
      source_tier: "free",
      analysis_provider: "metadata_fallback",
      analysis_windows: [{
        window_index: 1,
        start_seconds: 0,
        end_seconds: 4,
        summary: "Lisbon food market",
        tags: ["food", "market"],
        detected_visual_categories: [],
        detected_objects: [],
        visual_evidence_source: "metadata_fallback",
        visual_observation_origin: "weak_fallback",
        location: { city: "Lisboa", country: "Portugal", confidence: 0.5 },
      }],
    }],
  });

  const statuses = [
    ...result.approved_windows,
    ...result.rejected_windows,
  ].map((window) => window.visual_truth_status);
  assert(!statuses.includes("exact"), "weak_fallback nunca pode virar exact");
};

const testLocalRecutChoosesBetterSameAssetWindow = () => {
  const microMoment = {
    micro_id: "micro_vendor",
    visual_need: "vendor_interaction",
    needs_visual_proof: true,
    action_tokens: ["vendor"],
    start_sec: 10,
    end_sec: 13,
  };
  const current = {
    id: "asset-1:w01",
    asset_id: "asset-1",
    visual_truth_status: "regional",
    editorial_approved: true,
    visual_observation_origin: "real_vision",
    micro_needs_supported: ["market_stall"],
    micro_need_match_scores: { vendor_interaction: 0.2 },
    action_tokens_detected: ["market"],
    start_sec: 0,
    end_sec: 3,
    confidence: 0.65,
  };
  const better = {
    id: "asset-1:w02",
    asset_id: "asset-1",
    visual_truth_status: "exact",
    editorial_approved: true,
    visual_observation_origin: "real_vision",
    micro_needs_supported: ["vendor_interaction"],
    micro_need_match_scores: { vendor_interaction: 0.92 },
    action_tokens_detected: ["vendor"],
    start_sec: 4,
    end_sec: 7,
    confidence: 0.75,
  };

  const recut = findLocalRecutCandidate({
    currentCandidate: current,
    assetWindows: [current, better],
    microMoment,
    minScore: 0.55,
  });

  assert.strictEqual(recut.candidate.id, "asset-1:w02", "recut deve escolher janela interna mais precisa");
  assert.strictEqual(recut.action, "recut_timing_window");
  assert(timelineRepairTest.scoreLocalWindowForMicro({ candidate: better, microMoment }) > 0.7, "janela melhor deve ter score micro alto");
};

const testPreflightAndQaBlockCriticalWeaknesses = () => {
  const preflight = renderTest.evaluateRenderPreflightGate({
    state: {
      assets_json: {
        approved_windows: [{ id: "ok" }],
        scene_editorial_readiness: [{ scene_index: 1, coverage_status: "partial", blocking_reasons: [] }],
        block_coverage_by_block: [{ block_id: "b1", coverage_status: "partial" }],
        block_packages: [{ block_id: "b1", scene_indexes: [1] }],
      },
    },
    mockMode: false,
    allowRuntimeFallback: true,
  });
  assert(preflight.shouldAbort, "preflight prod deve bloquear cobertura partial em strong-only");
  assert(preflight.failure_codes.includes("PARTIAL_BLOCK_COVERAGE"), "partial deve gerar código específico");

  const issues = syncTest.collectTimelineIssues({
    timeline: {
      clips: [{
        clip_index: 1,
        scene_index: 1,
        critical_slot: true,
        visual_truth_status: "generic",
        editorial_slot_violation_codes: ["diversity_bypass_on_critical_slot"],
      }],
      timelineSyncMetrics: {},
    },
    technical: { issues: [] },
    visual: { hard_boundary_status: "pass", metrics: {} },
    diversityScore: 0.8,
  });
  const codes = syncTest.buildEditorialFailureCodes({
    issues,
    gate: {},
    microGate: {},
    approvedPoolAudit: { timeline_uses_approved_pool_only: true },
  });

  assert(codes.includes("CRITICAL_SLOT_ONLY_GENERIC"), "generic crítico deve bloquear publish");
  assert(codes.includes("DIVERSITY_BYPASS_ON_CRITICAL_SLOT"), "diversity bypass crítico deve bloquear publish");
};

testLocalCuratedProviderContract();
testAdaptiveBudgetEscalatesForCriticalRepair();
testWeakFallbackCannotBecomeExactProof();
testLocalRecutChoosesBetterSameAssetWindow();
testPreflightAndQaBlockCriticalWeaknesses();

console.log("final editorial closure validado com sucesso");
