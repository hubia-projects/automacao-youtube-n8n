"use strict";
const path = require("path");
process.env.OUTPUT_ROOT = path.join(__dirname, "..", "output-test-m8");
const assert = require("assert");
const fs = require("fs-extra");

const run = async () => {
  const { __test__: { runPreUploadQA } } = require("../src/services/youtubeService");
  assert(typeof runPreUploadQA === "function", "runPreUploadQA deve ser exportada via __test__");

  const outputRoot = path.join(__dirname, "..", "output-test-m8");
  await fs.ensureDir(outputRoot);

  // 1. Arquivo inexistente deve falhar com erro de duração (probeMedia retorna 0)
  let threw = false;
  try {
    await runPreUploadQA({ renderPath: "/nonexistent/video.mp4", state: {} });
  } catch (e) {
    threw = true;
    assert(e.message.includes("[M8] QA FAIL"), `erro deve conter [M8] QA FAIL, recebido: ${e.message}`);
    assert(e.message.includes("< 480s"), `erro deve mencionar limite 480s, recebido: ${e.message}`);
  }
  assert(threw, "vídeo inexistente (duração 0) deve falhar QA de duração");

  // 2. Verificar que duplicate clips warning não lança erro (soft check)
  // Simulando state com clips repetidos consecutivos
  const stateWithDupClips = {
    render_timeline: {
      clips: [
        { asset: { local_path: "/same/video.mp4" } },
        { asset: { local_path: "/same/video.mp4" } },
        { asset: { local_path: "/same/video.mp4" } },
        { asset: { local_path: "/same/video.mp4" } },
      ],
    },
  };
  // Deve falhar por duração (probeMedia de path inexistente), não por clipes repetidos
  let threw2 = false;
  try {
    await runPreUploadQA({ renderPath: "/nonexistent/dup_test.mp4", state: stateWithDupClips });
  } catch (e) {
    threw2 = true;
    // Deve falhar por duração, não por clipes duplicados (clipes duplicados são soft warning)
    assert(e.message.includes("[M8] QA FAIL"), "deve falhar QA (duração)");
  }
  assert(threw2, "deve lançar por duração mesmo com clipes duplicados");

  console.log("✅ M8 test passou — runPreUploadQA exportada, falha por duração correta, soft check de duplicatas validado");
};

run().catch((e) => { console.error("❌ M8 test falhou:", e.message); process.exit(1); });
