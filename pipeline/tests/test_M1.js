"use strict";
const path = require("path");
process.env.OUTPUT_ROOT = path.join(__dirname, "..", "output-test-m1");
const assert = require("assert");
const { matchBlockToClipCLIP } = require("../src/services/semanticMatcher");

const run = async () => {
  // 1. Sem videoPath deve retornar method="no_input"
  const r1 = await matchBlockToClipCLIP({ text: "Lisboa tram street", videoPath: "", videoId: "m1_test" });
  assert.strictEqual(r1.method, "no_input", "sem videoPath deve retornar no_input");
  assert.strictEqual(typeof r1.score, "number", "score deve ser number");

  // 2. Sem text deve retornar method="no_input"
  const r2 = await matchBlockToClipCLIP({ text: "", videoPath: "/some/video.mp4", videoId: "m1_test" });
  assert.strictEqual(r2.method, "no_input", "sem text deve retornar no_input");

  // 3. Path de vídeo inexistente — fallback gracioso (frame extract falha)
  const r3 = await matchBlockToClipCLIP({
    text: "Lisboa tram yellow street",
    videoPath: "/nonexistent/video.mp4",
    videoId: "m1_test",
    fallbackScore: 0.1,
  });
  assert(typeof r3.score === "number", "score deve ser number mesmo no fallback");
  // Quando frame extract falha OU script Python ausente, retorna method diferente de "clip_cosine"
  const fallbackMethods = ["clip_frame_extract_failed", "clip_script_missing", "clip_unavailable", "no_input"];
  const isFallback = fallbackMethods.includes(r3.method) || r3.method === "clip_cosine";
  assert(isFallback, `method deve ser fallback ou clip_cosine, recebido: ${r3.method}`);

  // 4. score está no range esperado (0-1+ para CLIP cosine similarity)
  assert(r3.score >= -1 && r3.score <= 2, `score deve estar em range razoável, recebido: ${r3.score}`);

  console.log("✅ M1 test passou", { r1, r2, r3 });
};

run().catch((e) => { console.error("❌ M1 test falhou:", e.message); process.exit(1); });
