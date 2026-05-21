const assert = require("assert");
const clipLibraryService = require("../src/services/clipLibraryService");
const timelinePlanner = require("../src/services/timelinePlanner");

const run = async () => {
  const row = {
    clip_id: "clip_semantic_1",
    clip_signature: "sig",
    policy_version: "v1",
    video_id: "video_a",
    scene_index: 2,
    block_id: "lisboa",
    asset_id: "asset_raw_lisboa",
    source_video_path: "C:/tmp/source.mp4",
    source_start_sec: 0,
    source_end_sec: 3,
    duration_sec: 3,
    clip_path: "C:/tmp/clip.mp4",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "approved",
    tags_semanticas_json: JSON.stringify(["tram", "historic_street"]),
    entities_json: JSON.stringify(["tram"]),
    location_json: JSON.stringify({ city: "Lisboa", country: "Portugal" }),
    shot_type: "wide",
    confidence: 0.9,
    visual_intent: "city_landmark",
    approval_context_json: JSON.stringify({}),
    usage_count: 0,
    last_used_at: "",
    history_json: JSON.stringify([]),
    metadata_json: JSON.stringify({
      semantic_name: "Alfama",
      semantic_phrase: "Bonde em Alfama",
      semantic_summary: "Bonde amarelo descendo uma rua histórica de Alfama em Lisboa.",
      semantic_text: "Bonde em Alfama Bonde amarelo descendo uma rua histórica de Alfama em Lisboa.",
    }),
  };

  const clip = clipLibraryService.__test__.mapRowToClip(row);
  const candidate = timelinePlanner.__test__.mapClipLibraryRecordToCandidate(clip);

  assert.strictEqual(candidate.summary, "Bonde em Alfama", "summary da timeline deve priorizar semantic_phrase");
  assert(String(candidate.description || "").includes("Alfama"), "description deve usar semantic_summary persistido");
  assert(String(candidate.asset?.semantic_text || "").includes("Bonde em Alfama"), "asset.semantic_text deve carregar o texto enriquecido");

  console.log("timeline clip library semantic text validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});