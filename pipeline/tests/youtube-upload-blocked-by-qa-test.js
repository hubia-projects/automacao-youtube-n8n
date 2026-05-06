const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { loadState, updateState } = require("../src/services/stateService");
const { uploadToYoutube } = require("../src/services/youtubeService");

const run = async () => {
  const videoId = `youtube_blocked_${Date.now()}`;
  const renderPath = path.join(__dirname, "..", "test_reports", `${videoId}.mp4`);

  fs.mkdirSync(path.dirname(renderPath), { recursive: true });
  fs.writeFileSync(renderPath, "fake render content");

  await updateState(
    videoId,
    {
      topic: "Teste de bloqueio de upload",
      approved: true,
      render_path: renderPath,
      render_validation: {
        is_publishable: false,
        needs_regeneration: true,
        needs_manual_review: true,
      },
      error_message: "",
    },
    {
      currentStep: "final_approved",
      status: "final_approved",
    }
  );

  await assert.rejects(
    () => uploadToYoutube({ videoId, mockMode: true, privacyStatus: "private" }),
    /qa|regeneracao|revisao manual|reprovado/i,
    "o upload deve falhar mesmo em mock quando o QA reprovou o render"
  );

  const state = await loadState(videoId);
  assert.strictEqual(Boolean(state.youtube_video_id), false, "o estado nao deve marcar upload apos bloqueio de QA");

  console.log("upload bloqueado por QA com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});