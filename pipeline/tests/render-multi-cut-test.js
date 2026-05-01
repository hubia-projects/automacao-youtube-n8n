const path = require("path");
const fs = require("fs-extra");
const axios = require("axios");
const { app } = require("../src/app");
const { probeMedia } = require("../src/utils/mediaUtils");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const getState = async (client, videoId) => {
  const response = await client.get(`/videos/${videoId}/state`);
  return response.data.state;
};

const clipSignature = (timeline = {}) =>
  (timeline.clips || []).map((clip) => `${clip.scene_index}:${path.basename(clip.local_path || "")}`).join("|");

const assertHdResolution = (resolution, label) => {
  assert(resolution?.width >= 1280, `${label} sem largura HD mínima`);
  assert(resolution?.height >= 720, `${label} sem altura HD mínima`);
  assert(resolution?.width >= resolution?.height, `${label} não está em landscape`);
};

const assertTimelineQuality = (state, label) => {
  assert(Array.isArray(state.render_timeline?.clips) && state.render_timeline.clips.length > 1, `${label} sem timeline multi-cut`);
  assert(state.render_timeline.total_clips >= 12, `${label} sem cortes suficientes para ~90s`);
  assert(state.render_timeline.unique_asset_count > 1, `${label} ainda parece um loop único de asset`);
  assert(
    state.render_timeline.clips.every(
      (clip) => Number(clip.clip_duration_seconds || 0) >= 3 && Number(clip.clip_duration_seconds || 0) <= 10
    ),
    `${label} tem clips fora da janela de 3 a 10 segundos`
  );
  state.render_timeline.clips.forEach((clip) => assertHdResolution(clip.resolution, `${label} clip ${clip.clip_index}`));
};

const run = async () => {
  const server = app.listen(8093, "127.0.0.1");
  const client = axios.create({ baseURL: "http://127.0.0.1:8093/api", timeout: 600000 });

  try {
    const ideas = await client.post("/videos/ideas/generate", { mock_mode: true, count: 5 });
    const videoId = ideas.data.video_id;

    await client.post("/videos/ideas/approve", { video_id: videoId, idea_number: 2, mock_mode: true });
    await client.post("/videos/script/generate", { video_id: videoId, mock_mode: true });
    await client.post("/videos/audio/generate", { video_id: videoId, mock_mode: true, provider: "multivozes" });
    await client.post("/videos/captions/generate", { video_id: videoId, mock_mode: true });
    await client.post("/videos/assets/search", { video_id: videoId, mock_mode: true, max_assets: 3 });
    await client.post("/videos/render", { video_id: videoId, mock_mode: true });
    await client.post("/videos/metadata/generate", { video_id: videoId, mock_mode: true });

    const stateV1 = await getState(client, videoId);
    assert(Array.isArray(stateV1.visual_plan) && stateV1.visual_plan.length >= 4, "visual_plan não foi criado com cenas suficientes");
    assert(Array.isArray(stateV1.assets_json?.items) && stateV1.assets_json.items.length >= stateV1.visual_plan.length, "assets por cena insuficientes");
    stateV1.assets_json.items.forEach((item, index) => assertHdResolution(item.resolution, `asset ${index + 1}`));
    assertTimelineQuality(stateV1, "render v1");

    const renderInfoV1 = await probeMedia(stateV1.render_path);
    assert(renderInfoV1.duration >= 90, "render v1 ficou abaixo de 90 segundos");
    assert(renderInfoV1.width >= 1280 && renderInfoV1.height >= 720, "render v1 ficou abaixo de HD");
    assert(stateV1.render_path && (await fs.pathExists(stateV1.render_path)), "final.mp4 do v1 não criado");

    const signatureV1 = clipSignature(stateV1.render_timeline);
    const baseScriptPath = stateV1.script_path;
    const baseAudioPath = stateV1.audio_path;

    await client.post("/videos/review/regenerate", {
      video_id: videoId,
      mock_mode: true,
      note: "Validando variacao de timeline para v2",
    });
    const stateV2 = await getState(client, videoId);
    assert(stateV2.review?.draft_version === 2, "draft v2 não foi criado");
    assert(stateV2.script_path === baseScriptPath, "v2 recriou roteiro em vez de reutilizar o existente");
    assert(stateV2.audio_path === baseAudioPath, "v2 recriou áudio em vez de reutilizar o existente");
    assert(Array.isArray(stateV2.review?.last_refreshed_scene_indexes) && stateV2.review.last_refreshed_scene_indexes.length >= 1, "v2 não marcou cenas para refresh seletivo");
    assert(Array.isArray(stateV2.assets_json?.last_refresh_scene_indexes) && stateV2.assets_json.last_refresh_scene_indexes.length >= 1, "v2 não registrou refresh seletivo de assets no state");
    assertTimelineQuality(stateV2, "render v2");
    const signatureV2 = clipSignature(stateV2.render_timeline);
    assert(signatureV2 !== signatureV1, "v2 não variou a ordem dos assets/cenas");

    await client.post("/videos/review/regenerate", {
      video_id: videoId,
      mock_mode: true,
      note: "Validando variacao de timeline para v3",
    });
    const stateV3 = await getState(client, videoId);
    assert(stateV3.review?.draft_version === 3, "draft v3 não foi criado");
    assert(stateV3.script_path === baseScriptPath, "v3 recriou roteiro em vez de reutilizar o existente");
    assert(stateV3.audio_path === baseAudioPath, "v3 recriou áudio em vez de reutilizar o existente");
    assert(Array.isArray(stateV3.review?.last_refreshed_scene_indexes) && stateV3.review.last_refreshed_scene_indexes.length >= 1, "v3 não marcou cenas para refresh seletivo");
    assert(Array.isArray(stateV3.assets_json?.last_refresh_scene_indexes) && stateV3.assets_json.last_refresh_scene_indexes.length >= 1, "v3 não registrou refresh seletivo de assets no state");
    assertTimelineQuality(stateV3, "render v3");
    const signatureV3 = clipSignature(stateV3.render_timeline);
    assert(signatureV3 !== signatureV2, "v3 não variou a ordem dos assets/cenas");
    assert(signatureV3 !== signatureV1, "v3 repetiu a ordem do v1");

    await client.post("/videos/final/approve", { video_id: videoId, approved: true, mock_mode: true });
    await client.post("/videos/youtube/upload", {
      video_id: videoId,
      mock_mode: true,
      privacy_status: "private",
    });

    const finalState = await getState(client, videoId);
    assert(finalState.youtube_url, "youtube_url não preenchido após upload mock");
    assert(finalState.youtube_privacy_status === "private", "upload não preservou privacy_status=private");

    console.log("✅ Teste visual multi-cut mock passou");
    console.log(
      JSON.stringify(
        {
          video_id: videoId,
          duration_seconds: finalState.render_timeline?.output_duration_seconds,
          total_clips: finalState.render_timeline?.total_clips,
          unique_asset_count: finalState.render_timeline?.unique_asset_count,
          draft_version: finalState.review?.draft_version,
          youtube_privacy_status: finalState.youtube_privacy_status,
          youtube_url: finalState.youtube_url,
        },
        null,
        2
      )
    );
  } finally {
    server.close();
  }
};

run().catch((error) => {
  console.error("❌ Teste visual multi-cut mock falhou", error.message);
  process.exit(1);
});