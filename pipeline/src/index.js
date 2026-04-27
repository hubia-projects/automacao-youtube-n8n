const { app } = require("./app");
const { config } = require("./config/env");
const { logger } = require("./utils/logger");

const server = app.listen(config.APP_PORT, "0.0.0.0", () => {
  logger.info(`YouTube pipeline API running on port ${config.APP_PORT}`);
  logger.info(`Mock mode: ${config.MOCK_MODE}`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});