const assert = require("assert");
const { loadState, updateState } = require("../src/services/stateService");
const { ingestRetentionLearning } = require("../src/services/editorialLearningService");

const run = async () => {
  const videoId = `retention_learning_test_${Date.now()}`;
  await loadState(videoId);
  await updateState(videoId, {
    render_timeline: {
      clips: [
        {
          clip_index: 1,
          timeline_start_sec: 0,
          timeline_end_sec: 5,
          source_provider: "pexels",
          source_tier: "free",
          asset_id: "asset_retention_01",
          content_slot_type: "food_closeup",
          content_slot_id: "slot_1",
          asset: { asset_id: "asset_retention_01", provider: "pexels" },
        },
        {
          clip_index: 2,
          timeline_start_sec: 5,
          timeline_end_sec: 10,
          source_provider: "pixabay",
          source_tier: "free",
          asset_id: "asset_retention_02",
          content_slot_type: "city_context",
          content_slot_id: "slot_2",
          asset: { asset_id: "asset_retention_02", provider: "pixabay" },
        },
      ],
    },
    assets_json: {
      provider_reliability: {
        pexels: 0.5,
        pixabay: 0.5,
      },
    },
  });

  const result = await ingestRetentionLearning({
    videoId,
    retentionSamples: [
      { timestamp_sec: 2, retention_score: 80 },
      { timestamp_sec: 7, retention_score: 30 },
    ],
    alpha: 0.5,
  });

  assert.strictEqual(result.observations_count, 2, "deveria mapear os dois samples");
  assert(Number(result.provider_reliability.pexels || 0) > Number(result.provider_reliability.pixabay || 0), "provider com melhor retenção deve subir confiabilidade");
  assert(Number(result.provider_retention_snapshot.pexels || 0) > Number(result.provider_retention_snapshot.pixabay || 0), "snapshot deve refletir diferença de retenção");
  console.log("editorial-learning-retention-test ok");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
