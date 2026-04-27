const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const { app } = require("../src/app");

const run = async () => {
  const server = app.listen(8091, "127.0.0.1");
  const client = axios.create({ baseURL: "http://127.0.0.1:8091/api", timeout: 180000 });

  try {
    const ideas = await client.post("/videos/ideas/generate", { count: 5, mock_mode: true });
    const videoId = ideas.data.video_id;

    await client.post("/videos/ideas/approve", {
      video_id: videoId,
      idea_number: 1,
      mock_mode: true,
    });

    await client.post("/videos/script/generate", {
      video_id: videoId,
      mock_mode: true,
    });

    await client.post("/videos/audio/generate", {
      video_id: videoId,
      mock_mode: true,
      provider: "elevenlabs",
    });

    await client.post("/videos/render", {
      video_id: videoId,
      mock_mode: true,
    });

    const stateRes = await client.get(`/videos/${videoId}/state`);
    const state = stateRes.data.state;

    const checks = {
      scriptExists: await fs.pathExists(state.script_path),
      audioExists: await fs.pathExists(state.audio_path),
      renderExists: await fs.pathExists(state.render_path),
      currentStep: state.current_step,
    };

    if (!checks.scriptExists || !checks.audioExists || !checks.renderExists) {
      throw new Error(`POC falhou: ${JSON.stringify(checks)}`);
    }

    console.log("✅ POC core test passou com sucesso");
    console.log(JSON.stringify({ video_id: videoId, checks }, null, 2));
  } finally {
    server.close();
  }
};

run().catch((error) => {
  console.error("❌ POC core test falhou", error.message);
  process.exit(1);
});