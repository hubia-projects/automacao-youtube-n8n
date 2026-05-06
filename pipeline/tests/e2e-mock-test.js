const fs = require("fs-extra");
const axios = require("axios");
const { app } = require("../src/app");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const run = async () => {
  const server = app.listen(8092, "127.0.0.1");
  const client = axios.create({ baseURL: "http://127.0.0.1:8092/api", timeout: 240000 });

  try {
    const ideas = await client.post("/videos/ideas/generate", { mock_mode: true, count: 5 });
    const videoId = ideas.data.video_id;

    await client.post("/videos/ideas/approve", { video_id: videoId, idea_number: 2, mock_mode: true });
    await client.post("/videos/script/generate", { video_id: videoId, mock_mode: true });
    await client.post("/videos/audio/generate", { video_id: videoId, mock_mode: true, provider: "elevenlabs" });
    await client.post("/videos/captions/generate", { video_id: videoId, mock_mode: true });
    await client.post("/videos/assets/search", { video_id: videoId, mock_mode: true, max_assets: 6 });
    await client.post("/videos/render", { video_id: videoId, mock_mode: true });
    const validation = await client.post("/videos/render/validate", { video_id: videoId, mock_mode: true });
    assert(validation.data.is_publishable === true, "render mock deveria ficar publicavel antes do upload");
    await client.post("/videos/metadata/generate", { video_id: videoId, mock_mode: true });
    await client.post("/videos/final/approve", { video_id: videoId, approved: true, mock_mode: true });
    await client.post("/videos/youtube/upload", { video_id: videoId, mock_mode: true, privacy_status: "private" });

    const stateRes = await client.get(`/videos/${videoId}/state`);
    const state = stateRes.data.state;

    assert(state.video_id === videoId, "video_id inconsistente");
    assert(state.script_path && (await fs.pathExists(state.script_path)), "script.md não criado");
    assert(state.audio_path && (await fs.pathExists(state.audio_path)), "narration.mp3 não criado");
    assert(state.caption_path_srt && (await fs.pathExists(state.caption_path_srt)), "SRT não criado");
    assert(state.caption_path_vtt && (await fs.pathExists(state.caption_path_vtt)), "VTT não criado");
    assert(state.render_path && (await fs.pathExists(state.render_path)), "final.mp4 não criado");
    assert(state.thumbnail_path && (await fs.pathExists(state.thumbnail_path)), "thumbnail não criado");
    assert(state.youtube_url, "youtube_url não preenchido");

    console.log("✅ E2E mock passou com sucesso");
    console.log(JSON.stringify({
      video_id: videoId,
      current_step: state.current_step,
      status: state.status,
      youtube_url: state.youtube_url,
    }, null, 2));
  } finally {
    server.close();
  }
};

run().catch((error) => {
  console.error("❌ E2E mock falhou", error.message);
  process.exit(1);
});