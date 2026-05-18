const assert = require("assert");
const { buildTimeline } = require("../src/services/timelinePlanner");

const run = async () => {
  const rawAsset = {
    asset_id: "asset_vendor_001",
    scene_index: 1,
    provider: "mock",
    asset_type: "video",
    type: "video",
    local_path: "C:\\mock\\vendor.mp4",
    source_url: "https://example.com/vendor.mp4",
    source_duration_seconds: 12,
    duration_estimate: 12,
    resolution: { width: 1920, height: 1080 },
  };
  const approvedWindow = {
    id: "asset_vendor_001:w01",
    approved_window_id: "asset_vendor_001:w01",
    asset_id: "asset_vendor_001",
    scene_index: 1,
    visual_truth_status: "exact",
    editorial_confidence: 0.9,
    approved: true,
    opening_allowed: true,
    closing_allowed: true,
    critical_slot_allowed: true,
    narrative_roles_supported: ["proof_exact", "detail_cutaway"],
    source_tier: "free",
    visual_observation_origin: "real_vision",
    visual_evidence_source: "local_video_understanding",
    visual_observation: {
      summary: "vendor serving food in market stall",
      tags: ["vendor", "food", "market"],
      detected_visual_categories: ["market", "food", "people_eating"],
      detected_objects: ["vendor", "plate"],
    },
    editorial_inference: {
      visual_intent_match: true,
      required_evidence_found: ["market", "food"],
      missing_required_visual_evidence: [],
      generic_visual: false,
    },
    window: {
      window_index: 1,
      start_seconds: 0,
      end_seconds: 8,
      duration_seconds: 8,
      summary: "vendor serving food in market stall",
      tags: ["vendor", "food", "market"],
      location: { city: "Lisboa", country: "Portugal", confidence: 0.9 },
      landmarks: [],
    },
    micro_needs_supported: ["vendor_interaction", "market_stall", "food_closeup"],
    action_tokens_detected: ["serving"],
    temporal_match_hints: { duration_seconds: 8 },
  };

  const state = {
    video_id: `timeline_micro_integration_${Date.now()}`,
    topic: "Lisboa gastronomia",
    script_text: "Nos mercados, os vendedores servem produtos frescos. Depois, os doces aparecem em cada esquina.",
    duration_seconds: 8,
    visual_plan: [{
      scene_index: 1,
      title: "Mercados de Lisboa",
      narration_excerpt: "Vendedores servem e depois doces tradicionais.",
      keywords: ["lisboa", "mercado", "doces"],
      role: "body",
      visual_intent: "gastronomy",
      requires_visual_proof: true,
    }],
    assets_json: {
      raw_items: [rawAsset],
      approved_items: [rawAsset],
      approved_windows: [approvedWindow],
      micro_visual_plan: [
        {
          micro_id: "mic_0001",
          scene_index: 1,
          block_id: "mercados",
          start_sec: 0,
          end_sec: 4,
          visual_need: "vendor_interaction",
          needs_visual_proof: true,
          criticality: "high",
          target_narrative_roles: ["proof_exact"],
          action_tokens: ["serving"],
        },
        {
          micro_id: "mic_0002",
          scene_index: 1,
          block_id: "mercados",
          start_sec: 4,
          end_sec: 8,
          visual_need: "pastry_closeup",
          needs_visual_proof: true,
          criticality: "high",
          target_narrative_roles: ["detail_cutaway"],
          action_tokens: [],
        },
      ],
      scene_asset_readiness: [{ scene_index: 1, approved_publishable_assets: 1, publishable_assets: 1 }],
    },
  };

  const timeline = await buildTimeline({
    state,
    audioDuration: 8,
    draftVersion: 1,
    fallbackAsset: rawAsset,
    allowPlaceholderFallback: true,
  });

  assert(timeline.clips.length > 0, "timeline deveria produzir clips");
  assert(timeline.clips.every((clip) => Object.prototype.hasOwnProperty.call(clip, "micro_id")), "clips devem carregar micro_id");
  assert(timeline.clips.every((clip) => typeof clip.micro_timing_score === "number"), "clips devem carregar micro_timing_score");
  assert(timeline.timelineSyncMetrics && typeof timeline.timelineSyncMetrics.micro_mismatch_rate === "number", "timeline deve expor métricas micro");

  console.log("timeline micro plan integration validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

