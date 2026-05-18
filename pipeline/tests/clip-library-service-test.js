const assert = require("assert");
const path = require("path");
const fs = require("fs-extra");
const { config } = require("../src/config/env");
const { createPlaceholderImage, runFfmpeg } = require("../src/utils/mediaUtils");

const run = async () => {
  const outputRoot = path.join(process.cwd(), "output", "tests-clip-library");
  await fs.emptyDir(outputRoot);
  const videoPath = path.join(outputRoot, "source.mp4");
  const framePath = path.join(outputRoot, "frame.png");
  await createPlaceholderImage({ outputPath: framePath, width: 1920, height: 1080, seed: 4 });
  await runFfmpeg(["-y", "-loop", "1", "-i", framePath, "-t", "8", "-pix_fmt", "yuv420p", videoPath]);

  config.USE_CLIP_LIBRARY = true;
  config.CLIP_LIBRARY_DB_PATH = path.join(outputRoot, "clip-library.db");
  config.CLIP_LIBRARY_ROOT_DIR = path.join(outputRoot, "library");
  delete require.cache[require.resolve("../src/services/clipLibraryService")];
  const {
    extractAndRegister,
    searchApprovedClips,
    updateClipStatus,
    getClipById,
    markClipUsed,
    summarizeClipLibrary,
  } = require("../src/services/clipLibraryService");

  const asset = {
    asset_id: "asset_test_01",
    local_path: videoPath,
    source_url: "local://asset_test_01",
    asset_type: "video",
  };
  const windows = [{
    start_seconds: 1,
    end_seconds: 3.2,
    tags: ["city", "street"],
    detected_visual_categories: ["city_landmark"],
    detected_objects: ["tram"],
    location: { city: "Lisboa", country: "Portugal", confidence: 0.9 },
    visual_features: { shot_type: "wide" },
    confidence: 0.84,
    visual_intent: "city_landmark",
  }];

  const first = await extractAndRegister({
    videoId: "cliplib_test_video",
    sceneIndex: 1,
    blockId: "block_a",
    asset,
    windows,
    initialStatus: "raw_cut",
    approvalContext: { stage: "test" },
  });
  assert.strictEqual(first.length, 1, "deveria gerar 1 clip");
  assert(await fs.pathExists(first[0].clip_path), "arquivo físico do clip deveria existir");

  const second = await extractAndRegister({
    videoId: "cliplib_test_video",
    sceneIndex: 1,
    blockId: "block_a",
    asset,
    windows,
    initialStatus: "raw_cut",
    approvalContext: { stage: "test_repeat" },
  });
  assert.strictEqual(second.length, 1, "segunda execução deveria retornar 1 clip");
  assert.strictEqual(second[0].clip_id, first[0].clip_id, "reprocessar não deveria duplicar clip lógico");

  const promoted = await updateClipStatus({
    clipId: first[0].clip_id,
    status: "approved",
    approvalContext: { stage: "qa_approved" },
  });
  assert.strictEqual(promoted.status, "approved", "status deveria ser approved");

  const approved = await searchApprovedClips({
    sceneIndex: 1,
    blockId: "block_a",
    visualIntent: "city_landmark",
    keywords: ["tram"],
    limit: 10,
  });
  assert(approved.length >= 1, "busca deveria encontrar clip aprovado");

  await markClipUsed({ clipId: first[0].clip_id });
  const usedClip = await getClipById({ clipId: first[0].clip_id });
  assert(Number(usedClip.usage_count || 0) >= 1, "usage_count deveria incrementar");

  const summary = await summarizeClipLibrary({ videoId: "cliplib_test_video" });
  assert(Number(summary.clips_generated || 0) >= 1, "summary deveria refletir clips gerados");
  assert(Number(summary.clips_approved || 0) >= 1, "summary deveria refletir clips aprovados");

  console.log("clip library service validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

