"use strict";
const path = require("path");
process.env.OUTPUT_ROOT = path.join(__dirname, "..", "output-test-youtube-auto-approve");
process.env.TEST_REPORTS_ROOT = path.join(process.env.OUTPUT_ROOT, "test_reports");
process.env.AUTO_APPROVE_FOR_TESTING = "true";

const assert = require("assert");
const fs = require("fs-extra");
const { loadState, updateState } = require("../src/services/stateService");
const { uploadToYoutube } = require("../src/services/youtubeService");

const run = async () => {
  const videoId = `youtube_auto_approve_${Date.now()}`;
  const renderPath = path.join(process.env.TEST_REPORTS_ROOT, `${videoId}.mp4`);

  await fs.ensureDir(path.dirname(renderPath));
  await fs.writeFile(renderPath, "fake render content", "utf8");

  await updateState(
    videoId,
    {
      topic: "Teste auto approve upload",
      approved: false,
      render_path: renderPath,
      render_validation: {
        is_publishable: true,
        needs_regeneration: false,
        needs_manual_review: false,
        qa_runtime_profile: "mock_relaxed",
        publish_blocked: false,
        publish_blocked_codes: [],
        editorial_failure_codes: [],
        actual_is_publishable: true,
        actual_needs_regeneration: false,
        actual_needs_manual_review: false,
        actual_hard_boundary_status: "pass",
        final_hard_boundary_status: "pass",
        hard_boundary_status: "pass",
        max_visual_lag_sec: 0.1,
      },
      error_message: "",
    },
    {
      currentStep: "render_validated",
      status: "render_validated",
    }
  );

  const upload = await uploadToYoutube({ videoId, mockMode: true, privacyStatus: "private" });
  const state = await loadState(videoId);

  assert.strictEqual(upload.mocked, true, "upload em mock deve continuar mockado");
  assert.strictEqual(state.approved, true, "auto approve de teste deve persistir approved=true antes do upload");
  assert(Boolean(state.youtube_video_id), "upload mock deve gerar youtube_video_id");

  console.log("youtube upload auto approve testing ok");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});