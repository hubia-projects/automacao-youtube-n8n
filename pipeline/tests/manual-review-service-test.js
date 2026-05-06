const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { loadState, updateState } = require("../src/services/stateService");
const { markNeedsManualReview } = require("../src/services/manualReviewService");

const run = async () => {
  const videoId = `manual_review_${Date.now()}`;
  const renderPath = path.join(__dirname, "..", "test_reports", `${videoId}.mp4`);

  fs.mkdirSync(path.dirname(renderPath), { recursive: true });
  fs.writeFileSync(renderPath, "fake render content");

  await updateState(
    videoId,
    {
      topic: "Teste manual review",
      render_path: renderPath,
      render_validation: {
        is_publishable: false,
        needs_regeneration: true,
        needs_manual_review: true,
        issues: [
          { type: "generic_asset_overuse", message: "Excesso de asset generico" },
        ],
      },
      error_message: "",
    },
    {
      currentStep: "render_validated",
      status: "render_validated",
    }
  );

  const result = await markNeedsManualReview({
    videoId,
    source: "workflow3_post_fix_validation",
  });

  const state = await loadState(videoId);
  assert.strictEqual(result.needs_manual_review, true, "o service deve sinalizar needs_manual_review");
  assert.strictEqual(state.status, "needs_manual_review", "o estado deve migrar para needs_manual_review");
  assert.strictEqual(state.current_step, "needs_manual_review", "o passo atual deve refletir revisao manual");
  assert.strictEqual(state.approved, false, "o video nao deve ficar aprovado apos marcar revisao manual");
  assert.strictEqual(state.render_validation?.needs_manual_review, true, "o render_validation deve manter needs_manual_review=true");
  assert.strictEqual(state.review?.manual_review_source, "workflow3_post_fix_validation", "o source da revisao manual deve ser persistido");

  console.log("manual review service validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});