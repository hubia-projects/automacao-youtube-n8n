const axios = require("axios");
const { app } = require("../src/app");

const assertField = (object, fieldPath) => {
  const parts = fieldPath.split(".");
  let current = object;
  for (const part of parts) {
    current = current?.[part];
    if (current === undefined || current === null || current === "") {
      throw new Error(`Campo obrigatório ausente no handoff: ${fieldPath}`);
    }
  }
};

const run = async () => {
  const server = app.listen(8093, "127.0.0.1");
  const client = axios.create({ baseURL: "http://127.0.0.1:8093/api", timeout: 240000 });

  try {
    const ideas = await client.post("/videos/ideas/generate", { mock_mode: true, count: 4 });
    const videoId = ideas.data.video_id;

    await client.post("/videos/ideas/approve", { video_id: videoId, idea_number: 1, mock_mode: true });

    const script = await client.post("/videos/script/generate", {
      video_id: videoId,
      mock_mode: true,
      trigger_workflow_2: false,
    });

    const handoffW2 = script.data.handoff_payload_workflow_2;
    ["video_id", "topic", "script_text", "state_path"].forEach((field) => assertField(handoffW2, field));

    await client.post("/videos/audio/generate", { video_id: videoId, mock_mode: true });
    await client.post("/videos/captions/generate", { video_id: videoId, mock_mode: true });

    const assets = await client.post("/videos/assets/search", {
      video_id: videoId,
      mock_mode: true,
      trigger_workflow_3: false,
    });

    const handoffW3 = assets.data.handoff_payload_workflow_3;
    ["video_id", "topic", "state_path", "script_text", "audio_path", "caption_path_srt", "assets_json"].forEach((field) =>
      assertField(handoffW3, field)
    );

    console.log("✅ Handoff test passou (W1→W2 e W2→W3)");
    console.log(JSON.stringify({ video_id: videoId, handoffW2, handoffW3 }, null, 2));
  } finally {
    server.close();
  }
};

run().catch((error) => {
  console.error("❌ Handoff test falhou", error.message);
  process.exit(1);
});