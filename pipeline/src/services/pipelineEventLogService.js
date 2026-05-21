const path = require("path");
const fs = require("fs-extra");
const { ensureVideoStructure } = require("./stateService");

const appendPipelineEvent = async ({
  videoId = "",
  stage = "",
  event = "",
  status = "info",
  payload = {},
} = {}) => {
  if (!videoId || !stage || !event) return "";
  const paths = await ensureVideoStructure(videoId);
  const logPath = path.join(paths.base, "history", "pipeline-events.jsonl");
  await fs.ensureDir(path.dirname(logPath));
  const row = {
    at: new Date().toISOString(),
    video_id: String(videoId || ""),
    stage: String(stage || ""),
    event: String(event || ""),
    status: String(status || "info"),
    payload: payload || {},
  };
  await fs.appendFile(logPath, `${JSON.stringify(row)}\n`, "utf8");
  return logPath;
};

module.exports = {
  appendPipelineEvent,
};

