const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ensureHostWritableRuntimePaths = () => {
  const baseDir = path.join(os.tmpdir(), "youtube-pipeline-vertex-media-smoke");
  const fallbackPaths = {
    OUTPUT_ROOT: path.join(baseDir, "output"),
    TEST_REPORTS_ROOT: path.join(baseDir, "reports"),
    CLIP_LIBRARY_DB_PATH: path.join(baseDir, "clip-library.json"),
    SCENE_INDEX_DB_PATH: path.join(baseDir, "scene-index.json"),
    CLIP_LIBRARY_ROOT_DIR: path.join(baseDir, "clip-library"),
    CLIP_LIBRARY_SHADOW_REPORT_DIR: path.join(baseDir, "clip-library-shadow"),
  };

  Object.entries(fallbackPaths).forEach(([envName, fallbackPath]) => {
    const currentValue = String(process.env[envName] || "").trim();
    if (!currentValue || currentValue.startsWith("/app/")) {
      process.env[envName] = fallbackPath;
    }
  });
};

ensureHostWritableRuntimePaths();

const {
  basicGeminiHealthcheck,
  generateTextWithGemini,
  generateImageWithGemini,
  generateVideoWithGemini,
  getVertexOperationStatus,
} = require("../src/services/geminiService");

const run = async () => {
  const reportDir = String(process.env.TEST_REPORTS_ROOT || path.join(os.tmpdir(), "youtube-pipeline-vertex-media-smoke", "reports"));
  fs.mkdirSync(reportDir, { recursive: true });

  const health = await basicGeminiHealthcheck();
  if (!health.configured) {
    console.log("Vertex media smoke skipped");
    console.log(JSON.stringify({ skipped: true, reason: health.message }, null, 2));
    return;
  }

  assert(health.ok, health.message || "Gemini/Vertex healthcheck falhou.");

  const summary = {
    health,
  };

  const textResult = await generateTextWithGemini({
    prompt: "Responda somente com OK_VERTEX_MEDIA_SMOKE",
    videoId: "vertex-media-smoke",
  });
  assert(textResult && /OK_VERTEX_MEDIA_SMOKE/i.test(String(textResult.text || "")), "Resposta de texto do Vertex nao confirmou o smoke test.");
  summary.text = textResult;

  const imageOutputPath = path.join(reportDir, `vertex-media-smoke-${Date.now()}.png`);
  const imageResult = await generateImageWithGemini({
    prompt: "Prato brasileiro cinematografico em mesa de madeira, iluminacao natural, enquadramento horizontal 16:9.",
    videoId: "vertex-media-smoke",
    outputPath: imageOutputPath,
  });
  assert(imageResult && imageResult.path && fs.existsSync(imageResult.path), "A geracao de imagem Vertex nao produziu arquivo local.");
  summary.image = {
    provider: imageResult.provider,
    model: imageResult.model,
    path: imageResult.path,
    mime_type: imageResult.mime_type,
  };

  const videoOutputPath = path.join(reportDir, `vertex-media-smoke-${Date.now()}.mp4`);
  const videoResult = await generateVideoWithGemini({
    prompt: "Plano curto e cinematografico de cafe sendo servido em xicara branca, camera suave, 16:9.",
    videoId: "vertex-media-smoke",
    outputPath: videoOutputPath,
    durationSeconds: 5,
  });
  assert(videoResult, "A geracao de video Vertex nao retornou resultado.");
  assert(videoResult.path || videoResult.operation_name, "A geracao de video Vertex nao retornou arquivo nem nome de operacao.");
  if (videoResult.path) {
    assert(fs.existsSync(videoResult.path), "O arquivo de video Vertex informado nao existe.");
  }

  summary.video = {
    provider: videoResult.provider,
    model: videoResult.model,
    path: videoResult.path || null,
    operation_name: videoResult.operation_name || null,
    console_url: videoResult.console_url || null,
  };

  if (videoResult.operation_name) {
    const operationStatus = await getVertexOperationStatus({
      operationName: videoResult.operation_name,
      projectNumber: String(process.env.GOOGLE_CLOUD_PROJECT_NUMBER || "").trim(),
    });
    assert(
      operationStatus.ok || operationStatus.unsupported_by_api === true || operationStatus.supported === true,
      operationStatus.message || "Nao foi possivel consultar a operacao Veo.",
    );
    summary.video_status = {
      ok: operationStatus.ok,
      supported: operationStatus.supported,
      unsupported_by_api: operationStatus.unsupported_by_api === true,
      message: operationStatus.message || "",
      attempts: Array.isArray(operationStatus.attempts) ? operationStatus.attempts.length : 0,
    };
  }

  console.log("Vertex media smoke result");
  console.log(JSON.stringify(summary, null, 2));
};

run().catch((error) => {
  console.error("Vertex media smoke falhou", error.message);
  process.exit(1);
});