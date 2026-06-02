"use strict";
const path = require("path");
process.env.OUTPUT_ROOT = path.join(__dirname, "..", "output-test-youtube-preflight");
process.env.TEST_REPORTS_ROOT = path.join(process.env.OUTPUT_ROOT, "test_reports");
process.env.MIN_VIDEO_DURATION_SECONDS = "480";

const assert = require("assert");
const fs = require("fs-extra");
const { updateState } = require("../src/services/stateService");
const { getProductionPreflightStatus } = require("../src/services/youtubeService");

const run = async () => {
  const videoId = `preflight_duration_${Date.now()}`;
  const renderPath = path.join(process.env.TEST_REPORTS_ROOT, `${videoId}.mp4`);

  await fs.ensureDir(path.dirname(renderPath));
  await fs.writeFile(renderPath, "invalid render content", "utf8");

  await updateState(videoId, {
    render_path: renderPath,
    render_validation: {
      is_publishable: true,
      needs_regeneration: false,
      needs_manual_review: false,
      hard_boundary_status: "pass",
      qa_runtime_profile: "prod_strict",
      publish_blocked: false,
      publish_blocked_codes: [],
      editorial_failure_codes: [],
    },
  }, { currentStep: "render_validated", status: "render_validated" });

  const status = await getProductionPreflightStatus({ videoId, mockMode: false });
  const codes = new Set(status.blocking_codes || []);

  assert.strictEqual(status.checks.has_render_file, true, "preflight deve reconhecer o arquivo de render existente");
  assert.strictEqual(Number(status.checks.render_duration_seconds || 0), 0, "arquivo inválido deve cair como duração 0");
  assert.strictEqual(Number(status.checks.min_video_duration_seconds || 0), 480, "preflight deve expor o mínimo configurado");
  assert.strictEqual(status.checks.render_duration_pass, false, "duração curta deve reprovar no preflight");
  assert(codes.has("VIDEO_DURATION_BELOW_MINIMUM"), "preflight deve bloquear quando a duração for menor que o mínimo");

  console.log("youtube preflight duration alignment ok");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});