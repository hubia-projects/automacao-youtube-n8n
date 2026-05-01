const { app } = require("./app");
const { config } = require("./config/env");
const {
  startTelegramApprovalPolling,
  stopTelegramApprovalPolling,
} = require("./services/telegramApprovalService");
const { logger } = require("./utils/logger");

const server = app.listen(config.APP_PORT, "0.0.0.0", () => {
  logger.info(`YouTube pipeline API running on port ${config.APP_PORT}`);
  logger.info(`Mock mode: ${config.MOCK_MODE}`);
  startTelegramApprovalPolling();
});

process.on("SIGINT", () => {
  stopTelegramApprovalPolling();
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  stopTelegramApprovalPolling();
  server.close(() => process.exit(0));
});