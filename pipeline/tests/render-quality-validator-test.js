const assert = require("assert");
const path = require("path");
const fs = require("fs-extra");
const { runFfmpeg } = require("../src/utils/mediaUtils");
const { validateRenderQuality } = require("../src/services/renderQualityService");

const run = async () => {
  const tempDir = path.join(process.cwd(), "output", "tests-render-quality");
  await fs.ensureDir(tempDir);
  const renderPath = path.join(tempDir, "low-quality-black.mp4");

  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=1280x720:d=2",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    renderPath,
  ]);

  const result = await validateRenderQuality({ renderPath });
  assert(result.issues.some((issue) => issue.type === "resolution_below_target"), "deveria detectar output abaixo de 1080p");
  assert(result.issues.some((issue) => issue.type === "missing_audio"), "deveria detectar audio ausente");
  assert(result.issues.some((issue) => issue.type === "black_frames_detected"), "deveria detectar black frames");
  assert(result.issues.some((issue) => issue.type === "solid_color_frames_detected"), "deveria detectar frame solido placeholder-like");

  console.log("render quality validator validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
