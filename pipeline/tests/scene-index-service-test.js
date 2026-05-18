const assert = require("assert");
const path = require("path");
const fs = require("fs-extra");
const { config } = require("../src/config/env");
const { createPlaceholderImage, runFfmpeg } = require("../src/utils/mediaUtils");

const run = async () => {
  const outputRoot = path.join(process.cwd(), "output", "tests-scene-index");
  await fs.emptyDir(outputRoot);
  const framePath = path.join(outputRoot, "frame.png");
  const videoPath = path.join(outputRoot, "source.mp4");
  await createPlaceholderImage({ outputPath: framePath, width: 1920, height: 1080, seed: 9 });
  await runFfmpeg(["-y", "-loop", "1", "-i", framePath, "-t", "10", "-pix_fmt", "yuv420p", videoPath]);

  config.USE_SCENE_INDEX = true;
  config.USE_CLIP_LIBRARY = true;
  config.SCENE_INDEX_DB_PATH = path.join(outputRoot, "scene-index.db");
  config.CLIP_LIBRARY_DB_PATH = path.join(outputRoot, "clip-library.db");
  config.CLIP_LIBRARY_ROOT_DIR = path.join(outputRoot, "library");
  delete require.cache[require.resolve("../src/services/sceneIndexService")];
  delete require.cache[require.resolve("../src/services/clipLibraryService")];
  const { indexAsset } = require("../src/services/sceneIndexService");
  const { getClipById } = require("../src/services/clipLibraryService");

  const asset = {
    asset_id: "scene_index_asset_01",
    local_path: videoPath,
    source_url: "local://scene_index_asset_01",
    asset_type: "video",
  };
  const scene = {
    scene_index: 2,
    block_id: "block_scene_index",
    visual_intent: "city_landmark",
    required_visual_evidence: ["city_landmark"],
    forbidden_visual_categories: [],
  };
  const windows = [
    {
      start_seconds: 0.5,
      end_seconds: 2.8,
      summary: "clip one",
      tags: ["city", "bridge"],
      detected_visual_categories: ["city_landmark"],
      detected_objects: ["bridge"],
      visual_features: { shot_type: "wide" },
      confidence: 0.83,
    },
    {
      start_seconds: 3.2,
      end_seconds: 5.4,
      summary: "clip two",
      tags: ["street", "tram"],
      detected_visual_categories: ["historic_street"],
      detected_objects: ["tram"],
      visual_features: { shot_type: "medium" },
      confidence: 0.81,
    },
  ];

  const first = await indexAsset({
    videoId: "scene_index_video",
    asset,
    scene,
    windows,
    generatePhysicalClips: true,
  });
  assert.strictEqual(first.indexed_entries.length, 2, "deveria indexar 2 entradas");
  assert.strictEqual(first.generated_clip_ids.length, 2, "deveria gerar 2 microclips");

  const second = await indexAsset({
    videoId: "scene_index_video",
    asset,
    scene,
    windows,
    generatePhysicalClips: true,
  });
  assert.strictEqual(second.generated_clip_ids.length, 2, "reindexação deve manter 2 clip ids");
  assert.strictEqual(second.generated_clip_ids[0], first.generated_clip_ids[0], "clip_id deve ser estável");

  const traceClip = await getClipById({ clipId: first.generated_clip_ids[0] });
  assert(traceClip, "clip precisa existir para rastreabilidade");
  assert.strictEqual(traceClip.asset_id, "scene_index_asset_01", "asset_id de origem deve ser rastreável");
  assert(traceClip.source_end_sec > traceClip.source_start_sec, "start/end de origem precisam ser válidos");

  console.log("scene index service validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

