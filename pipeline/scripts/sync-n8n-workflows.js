const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_CONTAINER = "yt-pipeline-n8n";
const ROOT_DIR = path.resolve(__dirname, "..");
const WORKFLOWS_DIR = path.join(ROOT_DIR, "n8n");
const EXPORT_PATH_IN_CONTAINER = "/tmp/runtime-workflows-sync.json";

const normalizeName = (value) =>
  String(value || "")
    .normalize("NFKC")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const parseArgs = (argv) => {
  const options = {
    container: DEFAULT_CONTAINER,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (current === "--container") {
      options.container = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (current === "--help" || current === "-h") {
      console.log("Usage: node scripts/sync-n8n-workflows.js [--container <name>] [--dry-run]");
      process.exit(0);
    }

    throw new Error(`Argumento nao suportado: ${current}`);
  }

  if (!options.container) {
    throw new Error("Informe um nome de container valido com --container.");
  }

  return options;
};

const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0) {
    const message = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(message || `${command} ${args.join(" ")} falhou.`);
  }

  if (!options.silent && result.stdout.trim()) {
    console.log(result.stdout.trim());
  }

  return result.stdout;
};

const getWorkflowFiles = () =>
  fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((fileName) => /^workflow.*\.json$/i.test(fileName))
    .sort();

const loadDesiredWorkflows = (workflowFiles) =>
  workflowFiles.map((workflowFile) => ({
    workflowFile,
    workflow: JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, workflowFile), "utf8")),
  }));

const buildDesiredWorkflowIdMap = ({ desiredWorkflows, runtimeWorkflows }) => {
  const runtimeByName = new Map(
    runtimeWorkflows.map((workflow) => [normalizeName(workflow.name), workflow])
  );

  const desiredWorkflowIds = new Map();

  desiredWorkflows.forEach(({ workflow }) => {
    const runtimeWorkflow = runtimeByName.get(normalizeName(workflow.name));
    const desiredId = runtimeWorkflow?.id || workflow.id || "";

    if (workflow.id && desiredId) {
      desiredWorkflowIds.set(workflow.id, desiredId);
    }
  });

  return desiredWorkflowIds;
};

const patchExecuteWorkflowTargets = ({ workflow, desiredWorkflowIds }) => {
  if (!Array.isArray(workflow.nodes) || !desiredWorkflowIds.size) {
    return workflow;
  }

  workflow.nodes = workflow.nodes.map((node) => {
    if (node.type !== "n8n-nodes-base.executeWorkflow") {
      return node;
    }

    const currentWorkflowId = String(node.parameters?.workflowId || "").trim();
    const resolvedWorkflowId = desiredWorkflowIds.get(currentWorkflowId);

    if (!resolvedWorkflowId || resolvedWorkflowId === currentWorkflowId) {
      return node;
    }

    return {
      ...node,
      parameters: {
        ...node.parameters,
        workflowId: resolvedWorkflowId,
      },
    };
  });

  return workflow;
};

const exportRuntimeWorkflows = (containerName, tempDir) => {
  const localExportPath = path.join(tempDir, "runtime-workflows.json");

  runCommand(
    "docker",
    [
      "exec",
      containerName,
      "n8n",
      "export:workflow",
      "--all",
      "--pretty",
      `--output=${EXPORT_PATH_IN_CONTAINER}`,
    ],
    { silent: true }
  );

  runCommand("docker", ["cp", `${containerName}:${EXPORT_PATH_IN_CONTAINER}`, localExportPath], {
    silent: true,
  });

  return JSON.parse(fs.readFileSync(localExportPath, "utf8"));
};

const syncWorkflow = ({ containerName, workflowFile, runtimeWorkflow, tempDir, dryRun, desiredWorkflowIds }) => {
  const sourcePath = path.join(WORKFLOWS_DIR, workflowFile);
  const workflow = patchExecuteWorkflowTargets({
    workflow: JSON.parse(fs.readFileSync(sourcePath, "utf8")),
    desiredWorkflowIds,
  });
  const tempLocalPath = path.join(tempDir, workflowFile);
  const tempContainerPath = `/tmp/${workflowFile}`;

  if (runtimeWorkflow?.id) {
    workflow.id = runtimeWorkflow.id;
  }

  const action = runtimeWorkflow?.id ? "update" : "create";
  console.log(`- ${workflow.name}: ${action}${runtimeWorkflow?.id ? ` (${runtimeWorkflow.id})` : ""}`);

  if (dryRun) {
    return;
  }

  fs.writeFileSync(tempLocalPath, JSON.stringify(workflow, null, 2));
  runCommand("docker", ["cp", tempLocalPath, `${containerName}:${tempContainerPath}`], { silent: true });
  runCommand(
    "docker",
    ["exec", containerName, "n8n", "import:workflow", `--input=${tempContainerPath}`],
    { silent: true }
  );
};

const applyDesiredActiveStates = ({ containerName, workflowFiles, runtimeWorkflows }) => {
  const runtimeByName = new Map(
    runtimeWorkflows.map((workflow) => [normalizeName(workflow.name), workflow])
  );

  for (const workflowFile of workflowFiles) {
    const workflow = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, workflowFile), "utf8"));

    if (typeof workflow.active !== "boolean") {
      continue;
    }

    const runtimeWorkflow = runtimeByName.get(normalizeName(workflow.name));
    if (!runtimeWorkflow?.id) {
      throw new Error(`Workflow nao encontrado para aplicar active: ${workflow.name}`);
    }

    if (workflow.active) {
      runCommand(
        "docker",
        ["exec", containerName, "n8n", "publish:workflow", `--id=${runtimeWorkflow.id}`],
        { silent: true }
      );
      continue;
    }

    runCommand(
      "docker",
      ["exec", containerName, "n8n", "unpublish:workflow", `--id=${runtimeWorkflow.id}`],
      { silent: true }
    );
  }
};

const verifySync = ({ runtimeWorkflows, workflowFiles }) => {
  const runtimeByName = new Map(
    runtimeWorkflows.map((workflow) => [normalizeName(workflow.name), workflow])
  );

  for (const workflowFile of workflowFiles) {
    const workflow = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, workflowFile), "utf8"));
    const match = runtimeByName.get(normalizeName(workflow.name));

    if (!match?.id) {
      throw new Error(`Workflow nao encontrado no n8n apos sync: ${workflow.name}`);
    }
  }
};

const restartContainer = (containerName) => {
  console.log(`Reiniciando ${containerName} para aplicar workflows publicados...`);
  runCommand("docker", ["restart", containerName], { silent: true });
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const workflowFiles = getWorkflowFiles();

  if (!workflowFiles.length) {
    throw new Error("Nenhum workflow*.json foi encontrado em pipeline/n8n.");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-workflow-sync-"));
  const desiredWorkflows = loadDesiredWorkflows(workflowFiles);

  try {
    const runtimeWorkflows = exportRuntimeWorkflows(options.container, tempDir);
    const runtimeByName = new Map(
      runtimeWorkflows.map((workflow) => [normalizeName(workflow.name), workflow])
    );
    const desiredWorkflowIds = buildDesiredWorkflowIdMap({
      desiredWorkflows,
      runtimeWorkflows,
    });

    console.log(`Sincronizando ${workflowFiles.length} workflow(s) com o container ${options.container}.`);

    for (const { workflowFile, workflow } of desiredWorkflows) {
      const runtimeWorkflow = runtimeByName.get(normalizeName(workflow.name));

      syncWorkflow({
        containerName: options.container,
        workflowFile,
        runtimeWorkflow,
        tempDir,
        dryRun: options.dryRun,
        desiredWorkflowIds,
      });
    }

    if (options.dryRun) {
      console.log("Dry run concluido sem importar alteracoes.");
      return;
    }

    const refreshedRuntimeWorkflows = exportRuntimeWorkflows(options.container, tempDir);
    verifySync({ runtimeWorkflows: refreshedRuntimeWorkflows, workflowFiles });
    applyDesiredActiveStates({
      containerName: options.container,
      workflowFiles,
      runtimeWorkflows: refreshedRuntimeWorkflows,
    });
    restartContainer(options.container);
    console.log("Sync concluido com sucesso.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    try {
      runCommand(
        "docker",
        ["exec", options.container, "sh", "-lc", `rm -f /tmp/workflow*.json ${EXPORT_PATH_IN_CONTAINER}`],
        { silent: true }
      );
    } catch {
      // noop
    }
  }
};

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}