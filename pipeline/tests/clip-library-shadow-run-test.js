const assert = require("assert");
const path = require("path");
const fs = require("fs-extra");
const { config } = require("../src/config/env");
const { createPlaceholderImage, runFfmpeg } = require("../src/utils/mediaUtils");

const run = async () => {
  const outputRoot = path.join(process.cwd(), "output", "tests-clip-shadow");
  await fs.emptyDir(outputRoot);
  const framePath = path.join(outputRoot, "frame.png");
  const videoPath = path.join(outputRoot, "long-source.mp4");
  await createPlaceholderImage({ outputPath: framePath, width: 1920, height: 1080, seed: 12 });
  await runFfmpeg(["-y", "-loop", "1", "-i", framePath, "-t", "18", "-pix_fmt", "yuv420p", videoPath]);

  config.USE_CLIP_LIBRARY = true;
  config.USE_SCENE_INDEX = true;
  config.CLIP_LIBRARY_DB_PATH = path.join(outputRoot, "clip-library.db");
  config.SCENE_INDEX_DB_PATH = path.join(outputRoot, "scene-index.db");
  config.CLIP_LIBRARY_ROOT_DIR = path.join(outputRoot, "clip-library-files");
  config.CLIP_LIBRARY_SHADOW_REPORT_DIR = path.join(outputRoot, "reports");
  delete require.cache[require.resolve("../src/services/sceneIndexService")];
  delete require.cache[require.resolve("../src/services/clipLibraryService")];
  delete require.cache[require.resolve("../src/services/clipLibraryShadowService")];
  const { runClipLibraryShadow } = require("../src/services/clipLibraryShadowService");

  const result = await runClipLibraryShadow({
    videoPath,
    videoId: "shadow_video_test",
    windowSec: 3,
  });

  assert(Number(result.decupagem_windows || 0) >= 4, "shadow deveria gerar múltiplas janelas");
  assert(Number(result.generated_clip_ids?.length || 0) >= 4, "shadow deveria gerar microclips físicos");
  assert(Number(result.timeline_mock_candidates_count || 0) >= 1, "timeline mock deveria consumir clip library");
  assert(await fs.pathExists(result.report_path), "relatório shadow precisa existir em disco");

  console.log("clip library shadow run validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

