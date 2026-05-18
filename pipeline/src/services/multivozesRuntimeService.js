const path = require("path");
const fs = require("fs-extra");
const { execFile } = require("child_process");
const { config } = require("../config/env");

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ETIMEDOUT",
]);
const COMMAND_NOT_FOUND_CODES = new Set(["ENOENT"]);

let pendingStart = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getProjectPath = () => {
  const rawPath = String(config.MULTIVOZES_PROJECT_PATH || "").trim();
  if (!rawPath) return "";
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(config.REPO_ROOT, rawPath);
};
const getDockerService = () => String(config.MULTIVOZES_DOCKER_SERVICE || "").trim();

const hasMultivozesAutoStartConfiguration = () =>
  Boolean(config.MULTIVOZES_AUTO_START && getProjectPath());

const shouldAttemptMultivozesAutoStart = (error) =>
  hasMultivozesAutoStartConfiguration()
  && NETWORK_ERROR_CODES.has(String(error?.code || "").trim().toUpperCase());

const runCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { windowsHide: true, maxBuffer: 10 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });

const formatCommandError = (error) => {
  const message = String(error?.message || "").trim();
  const stderrLine = String(error?.stderr || "").trim().split(/\r?\n/).find(Boolean) || "";
  const stdoutLine = String(error?.stdout || "").trim().split(/\r?\n/).find(Boolean) || "";
  const code = String(error?.code || "").trim();

  return stderrLine || stdoutLine || message || code || "Falha ao executar docker compose.";
};

const startMultivozesWithDockerCompose = async () => {
  const projectPath = getProjectPath();
  if (!projectPath) {
    return { attempted: false, ok: false, message: "MULTIVOZES_PROJECT_PATH ausente" };
  }

  if (!(await fs.pathExists(projectPath))) {
    return {
      attempted: true,
      ok: false,
      message: `MULTIVOZES_PROJECT_PATH inexistente: ${projectPath}`,
    };
  }

  const serviceArgs = getDockerService() ? [getDockerService()] : [];
  const commandCandidates = [
    { command: "docker", args: ["compose", "up", "-d", ...serviceArgs] },
    { command: "docker-compose", args: ["up", "-d", ...serviceArgs] },
  ];

  let lastError = null;
  for (const candidate of commandCandidates) {
    try {
      await runCommand(candidate.command, candidate.args, { cwd: projectPath });
      return {
        attempted: true,
        ok: true,
        message: `${candidate.command} ${candidate.args.join(" ")}`,
      };
    } catch (error) {
      lastError = error;
      if (!COMMAND_NOT_FOUND_CODES.has(String(error?.code || "").trim().toUpperCase())) {
        break;
      }
    }
  }

  return {
    attempted: true,
    ok: false,
    message: formatCommandError(lastError),
  };
};

const ensureMultivozesStarted = async () => {
  if (!hasMultivozesAutoStartConfiguration()) {
    return {
      attempted: false,
      ok: false,
      message: "Auto-start do Multivozes desabilitado ou sem path configurado",
    };
  }

  if (!pendingStart) {
    pendingStart = startMultivozesWithDockerCompose().finally(() => {
      pendingStart = null;
    });
  }

  return pendingStart;
};

const waitForMultivozesReady = async (probeFn) => {
  const timeoutMs = Math.max(5000, Number(config.MULTIVOZES_START_TIMEOUT_MS || 30000));
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await probeFn();
    } catch (error) {
      lastError = error;
      if (!NETWORK_ERROR_CODES.has(String(error?.code || "").trim().toUpperCase())) {
        throw error;
      }
      await sleep(2500);
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`Multivozes não respondeu após ${timeoutMs}ms.`);
};

module.exports = {
  ensureMultivozesStarted,
  hasMultivozesAutoStartConfiguration,
  shouldAttemptMultivozesAutoStart,
  waitForMultivozesReady,
  __test__: {
    formatCommandError,
  },
};