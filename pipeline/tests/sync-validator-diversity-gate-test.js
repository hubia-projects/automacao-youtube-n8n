const assert = require("assert");
const { __test__ } = require("../src/services/syncValidator");

const run = async () => {
  const issues = __test__.collectTimelineIssues({
    timeline: {
      clips: [
        { clip_script_source: "audio_word_timestamps", asset_analysis_provider: "local_video_understanding" },
        { clip_script_source: "audio_word_timestamps", asset_analysis_provider: "local_video_understanding" },
      ],
      timelineSyncMetrics: {
        low_diversity_blocks: ["block_a"],
        adjacent_repeat_total: 3,
      },
      sync_policy: { max_topic_switch_latency_sec: 0.5 },
    },
    technical: { issues: [] },
    visual: { hard_boundary_status: "pass", metrics: {} },
    diversityScore: 0.7,
  });

  assert(issues.some((item) => item.type === "low_diversity_block"), "deveria sinalizar bloco monotematico");
  assert(issues.some((item) => item.type === "adjacent_visual_repetition"), "deveria sinalizar repeticao adjacente");
  console.log("sync validator diversity gate validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

