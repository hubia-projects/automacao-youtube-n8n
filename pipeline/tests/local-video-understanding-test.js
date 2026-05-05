const assert = require("assert");
const path = require("path");
const fs = require("fs-extra");
const { analyzeLocalVideo } = require("../src/services/localVideoUnderstandingService");
const { createPlaceholderImage, runFfmpeg } = require("../src/utils/mediaUtils");
const { config } = require("../src/config/env");

const run = async () => {
  const tempDir = path.join(process.cwd(), "output", "tests-local-understanding");
  await fs.ensureDir(tempDir);
  const imagePath = path.join(tempDir, "frame.png");
  const videoPath = path.join(tempDir, "sample.mp4");
  await createPlaceholderImage({ outputPath: imagePath, width: 1280, height: 720, seed: 7 });
  await runFfmpeg(["-y", "-loop", "1", "-i", imagePath, "-t", "2", "-pix_fmt", "yuv420p", videoPath]);

  const originalFlag = config.LOCAL_VIDEO_UNDERSTANDING_ENABLED;
  config.LOCAL_VIDEO_UNDERSTANDING_ENABLED = false;
  const disabled = await analyzeLocalVideo({ inputPath: videoPath, assetMetadata: { query: "porto market" }, sceneContext: { title: "Mercado", keywords: ["market"] } });
  assert(Array.isArray(disabled.analysis_windows) && disabled.analysis_windows.length > 0, "desligado ainda deveria devolver janelas fallback");

  config.LOCAL_VIDEO_UNDERSTANDING_ENABLED = true;
  config.LOCAL_VIDEO_UNDERSTANDING_SCRIPT = "tools/video-understanding/missing.py";
  const missingScript = await analyzeLocalVideo({ inputPath: videoPath, assetMetadata: { query: "porto market" }, sceneContext: { title: "Mercado", keywords: ["market"] } });
  assert(Array.isArray(missingScript.analysis_windows) && missingScript.analysis_windows.length > 0, "script ausente nao pode quebrar o pipeline");

  config.LOCAL_VIDEO_UNDERSTANDING_ENABLED = originalFlag;
  console.log("local video understanding validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
