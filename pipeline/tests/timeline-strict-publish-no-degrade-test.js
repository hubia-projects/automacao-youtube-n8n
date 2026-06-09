const os = require("os");
const path = require("path");

const ensureHostWritableRuntimePaths = () => {
  const baseDir = path.join(os.tmpdir(), "youtube-pipeline-timeline-strict-no-degrade-test");
  const fallbackPaths = {
    OUTPUT_ROOT: path.join(baseDir, "output"),
    TEST_REPORTS_ROOT: path.join(baseDir, "reports"),
    CLIP_LIBRARY_DB_PATH: path.join(baseDir, "clip-library.json"),
    SCENE_INDEX_DB_PATH: path.join(baseDir, "scene-index.json"),
    CLIP_LIBRARY_ROOT_DIR: path.join(baseDir, "clip-library"),
    CLIP_LIBRARY_SHADOW_REPORT_DIR: path.join(baseDir, "clip-library-shadow"),
  };

  Object.entries(fallbackPaths).forEach(([envName, fallbackPath]) => {
    process.env[envName] = fallbackPath;
  });
};

ensureHostWritableRuntimePaths();
process.env.ALLOW_PLACEHOLDER_ASSETS = "false";

const assert = require("assert");
const { enrichVisualPlan } = require("../src/services/narrativeBlockPlanner");
const { buildTimeline } = require("../src/services/timelinePlanner");

const visualPlan = enrichVisualPlan({
  topic: "Lisboa gastronomica",
  visualPlan: [{
    scene_index: 1,
    title: "Mercado e pratos tipicos",
    narration_excerpt: "A cena mostra pratos, mercado e pessoas comendo em Lisboa.",
    keywords: ["lisbon", "food market", "plates"],
    role: "body",
    target_duration_seconds: 6,
  }],
  audioDuration: 6,
}).visualPlan;

const weakApprovedAsset = {
  scene_index: 1,
  provider: "pexels",
  asset_type: "video",
  type: "video",
  local_path: "/tmp/lisboa-square-walking.mp4",
  source_url: "https://example.com/lisboa-square-walking.mp4",
  source_tier: "free",
  resolution: {
    width: 1920,
    height: 1080,
    label: "Full HD",
  },
  duration_estimate: 6,
  visual_truth_status: "regional",
  analysis_windows: [{
    window_index: 1,
    start_seconds: 0,
    end_seconds: 6,
    summary: "People walking in a Lisbon square",
    tags: ["street", "square", "walking"],
    detected_visual_categories: ["street_life"],
    required_evidence_found: [],
    visual_evidence_source: "real_vision",
    visual_observation_origin: "real_vision",
    confidence: 0.82,
    location: { city: "Lisboa", country: "Portugal", confidence: 0.9 },
  }],
};

const state = {
  video_id: "timeline_strict_publish_no_degrade_test",
  topic: "Lisboa gastronomica",
  script_text: "Mercado e pratos tipicos em Lisboa.",
  visual_plan: visualPlan,
  assets_json: {
    approved_items: [weakApprovedAsset],
    items: [weakApprovedAsset],
    approved_windows: [],
    scene_asset_readiness: [{
      scene_index: 1,
      approved_publishable_assets: 1,
      publishable_assets: 1,
      blocking_reasons: [],
      coverage_status: "ready",
    }],
  },
};

(async () => {
  const previewTimeline = await buildTimeline({
    state,
    audioDuration: 6,
    draftVersion: 1,
    fallbackAsset: null,
    allowPlaceholderFallback: false,
    allowApprovedPoolDegrade: true,
  });

  assert.strictEqual(previewTimeline.clips.length > 0, true, "modo nao estrito ainda deve conseguir montar timeline degradada");
  assert(
    ["approved_pool_degrade", "emergency_cross_scene_fallback"].includes(previewTimeline.clips[0].selection_reason),
    "modo nao estrito deve usar degrade editorial quando necessario"
  );

  await assert.rejects(
    () => buildTimeline({
      state,
      audioDuration: 6,
      draftVersion: 1,
      fallbackAsset: null,
      allowPlaceholderFallback: false,
      allowApprovedPoolDegrade: false,
    }),
    /no strict publishable candidate available/i,
    "modo estrito nao deve aceitar degrade editorial silencioso"
  );

  console.log("timeline-strict-publish-no-degrade-test ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});