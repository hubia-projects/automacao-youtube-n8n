const assert = require("assert");
const path = require("path");
const fs = require("fs-extra");
const { runFfmpeg } = require("../src/utils/mediaUtils");
const { validateRenderQuality } = require("../src/services/renderQualityService");

const run = async () => {
  const tempDir = path.join(process.cwd(), "output", "tests-render-quality");
  await fs.ensureDir(tempDir);
  const renderPath = path.join(tempDir, "full-hd-check.mp4");

  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=1920x1080:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
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
  assert(!result.issues.some((issue) => issue.type === "resolution_below_target"), "nao deveria sinalizar resolucao abaixo de 1080p");

  console.log("output 1080p validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});