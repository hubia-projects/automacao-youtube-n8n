const levels = ["debug", "info", "warn", "error"];
const currentLevel = process.env.LOG_LEVEL || "info";

const shouldLog = (level) => levels.indexOf(level) >= levels.indexOf(currentLevel);

const log = (level, message, meta) => {
  if (!shouldLog(level)) return;
  const timestamp = new Date().toISOString();
  if (meta) {
    console[level](`[${timestamp}] [${level.toUpperCase()}] ${message}`, meta);
  } else {
    console[level](`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }
};

module.exports = {
  logger: {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
  },
};