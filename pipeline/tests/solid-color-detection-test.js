const assert = require("assert");
const path = require("path");
const fs = require("fs-extra");
const { config } = require("../src/config/env");
const { runFfmpeg } = require("../src/utils/mediaUtils");
const { validateRenderQuality } = require("../src/services/renderQualityService");

const run = async () => {
  const tempDir = path.join(config.OUTPUT_ROOT, "tests-render-quality");
  await fs.ensureDir(tempDir);
  const renderPath = path.join(tempDir, "solid-color-blue.mp4");

  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=#1d4ed8:s=1920x1080:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=2",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    renderPath,
  ]);

  const result = await validateRenderQuality({ renderPath });
  assert(result.issues.some((issue) => issue.type === "solid_color_frames_detected"), "deveria detectar frames solidos ou placeholder-like");

  console.log("solid color detection validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
