const os = require("os");
const path = require("path");

const ensureHostWritableRuntimePaths = () => {
  const baseDir = path.join(os.tmpdir(), "youtube-pipeline-vertex-veo");
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
  generateVideoWithGemini,
  getVertexOperationStatus,
  waitForVertexOperation,
} = require("../src/services/geminiService");

const parseArgs = (argv = []) => {
  const positional = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || String(next).startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return { positional, options };
};

const readOption = (options = {}, ...keys) => {
  for (const key of keys) {
    if (options[key] !== undefined) return options[key];
  }
  return "";
};

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const printUsage = () => {
  console.log([
    "Uso:",
    "  node scripts/vertex-veo-operation.js submit --prompt \"...\" [--video-id id] [--duration-sec 5] [--aspect-ratio 16:9] [--wait] [--timeout-sec 900] [--poll-sec 8] [--project-number 123456789]",
    "  node scripts/vertex-veo-operation.js status --operation \"projects/.../operations/...\" [--project-number 123456789]",
    "  node scripts/vertex-veo-operation.js wait --operation \"projects/.../operations/...\" [--timeout-sec 900] [--poll-sec 8] [--project-number 123456789]",
  ].join("\n"));
};

const buildSubmitSummary = (result = {}) => ({
  provider: result.provider || null,
  model: result.model || null,
  path: result.path || null,
  mime_type: result.mime_type || null,
  operation_name: result.operation_name || null,
  console_url: result.console_url || null,
  polling_hint: result.polling_hint || null,
});

const run = async () => {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = String(positional[0] || (options.prompt ? "submit" : "help")).trim().toLowerCase();
  const projectNumber = String(readOption(options, "project-number") || process.env.GOOGLE_CLOUD_PROJECT_NUMBER || "").trim();

  if (["help", "-h", "--help"].includes(command)) {
    printUsage();
    return;
  }

  if (command === "submit") {
    const prompt = String(readOption(options, "prompt")).trim();
    if (!prompt) {
      printUsage();
      throw new Error("Informe --prompt para enviar uma operacao Veo.");
    }

    const result = await generateVideoWithGemini({
      prompt,
      videoId: String(readOption(options, "video-id") || "vertex-veo").trim(),
      aspectRatio: String(readOption(options, "aspect-ratio") || "16:9").trim(),
      durationSeconds: Math.max(5, toNumber(readOption(options, "duration-sec"), 5)),
    });

    if (!result) {
      throw new Error("A geracao Veo nao retornou resposta. Verifique configuracao do Vertex AI.");
    }

    console.log(JSON.stringify({ command: "submit", result: buildSubmitSummary(result) }, null, 2));

    if (options.wait === true && result.operation_name) {
      const waitResult = await waitForVertexOperation({
        operationName: result.operation_name,
        projectNumber,
        timeoutMs: Math.max(30, toNumber(readOption(options, "timeout-sec"), 900)) * 1000,
        pollIntervalMs: Math.max(2, toNumber(readOption(options, "poll-sec"), 8)) * 1000,
      });
      console.log(JSON.stringify({ command: "wait", result: waitResult }, null, 2));
      if (waitResult.timed_out && !waitResult.done) process.exitCode = 2;
    }
    return;
  }

  if (!["status", "wait"].includes(command)) {
    printUsage();
    throw new Error(`Comando nao suportado: ${command}`);
  }

  const operationName = String(readOption(options, "operation")).trim();
  if (!operationName) {
    printUsage();
    throw new Error("Informe --operation com o nome completo da operacao Vertex.");
  }

  if (command === "status") {
    const status = await getVertexOperationStatus({ operationName, projectNumber });
    console.log(JSON.stringify({ command: "status", result: status }, null, 2));
    if (!status.ok && !status.unsupported_by_api) process.exitCode = 1;
    return;
  }

  const waitResult = await waitForVertexOperation({
    operationName,
    projectNumber,
    timeoutMs: Math.max(30, toNumber(readOption(options, "timeout-sec"), 900)) * 1000,
    pollIntervalMs: Math.max(2, toNumber(readOption(options, "poll-sec"), 8)) * 1000,
  });
  console.log(JSON.stringify({ command: "wait", result: waitResult }, null, 2));

  if (waitResult.timed_out && !waitResult.done) {
    process.exitCode = 2;
    return;
  }
  if (!waitResult.ok && !waitResult.unsupported_by_api) {
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error("vertex-veo-operation falhou", error.message);
  process.exit(1);
});