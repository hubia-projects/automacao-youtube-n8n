const assert = require("assert");
const { __test__: timelinePlannerTest } = require("../src/services/timelinePlanner");

const block = {
  hard_boundary: true,
  scene_index: 2,
  topic_type: "city",
  macro_topic: "Porto",
  expected_location: "Porto",
  chapter_card_required: true,
};

const previousMacroTopic = "Lisboa";

const neutralCandidate = {
  id: "neutral_01",
  scene_index: 2,
  neutral: true,
  quality: { usable: true },
  location: { city: "", country: "", confidence: 0 },
  landmarks: [],
};

const wrongCityCandidate = {
  id: "lisboa_01",
  scene_index: 2,
  neutral: false,
  quality: { usable: true },
  location: { city: "Lisboa", country: "Portugal", confidence: 0.95 },
  landmarks: [],
};

const filtered = timelinePlannerTest.filterCandidatesByHardRules({
  block,
  assetWindows: [neutralCandidate, wrongCityCandidate],
  previousMacroTopic,
  fallbackAsset: null,
  allowPlaceholderFallback: false,
  isBoundaryFirstSlot: true,
  hardBoundaryPolicy: {
    enabled: true,
    max_topic_switch_latency_sec: 0.5,
    forbid_neutral_first_clip: true,
    require_location_on_hard_boundary: true,
    require_chapter_overlay: true,
    fail_on_missing_boundary_candidate: true,
  },
});

assert.strictEqual(filtered.length, 0, "primeiro slot hard deveria bloquear neutral e cidade anterior");

const hardBoundaryValidation = timelinePlannerTest.evaluateHardBoundaryDeterministic({
  clips: [
    {
      clip_index: 4,
      timeline_start_sec: 10,
      timeline_end_sec: 12,
      detected_location: { city: "Porto" },
      neutral_fallback: false,
    },
  ],
  microBlocks: [
    {
      id: "micro_001",
      hard_boundary: false,
      start_sec: 0,
    },
    {
      id: "micro_002",
      hard_boundary: true,
      boundary_id: "hb_002_porto",
      transition_type: "hard",
      start_sec: 10,
      expected_visual_start_sec: 10,
      expected_location: "Porto",
      topic_type: "city",
      chapter_card_required: true,
      chapter_trigger: { detected: true, timestamp_sec: 10 },
    },
  ],
  hardBoundaryPolicy: {
    enabled: true,
    max_topic_switch_latency_sec: 0.5,
    forbid_neutral_first_clip: true,
    require_location_on_hard_boundary: true,
    require_chapter_overlay: true,
    fail_on_missing_boundary_candidate: true,
  },
});

assert.strictEqual(hardBoundaryValidation.status, "pass", "hard boundary válido deveria passar no planner");
assert.strictEqual(hardBoundaryValidation.max_visual_lag_sec, 0, "lag máximo deveria ser zero no caso alinhado");

console.log("hard boundary lock validado com sucesso");
