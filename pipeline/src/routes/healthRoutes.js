const { Router } = require("express");
const { runIntegrationHealthchecks } = require("../services/integrationHealthService");
const { config } = require("../config/env");

const router = Router();

router.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "youtube-faceless-pipeline-api",
    mock_mode: config.MOCK_MODE,
    timestamp: new Date().toISOString(),
  });
});

router.get("/health/integrations", async (req, res, next) => {
  try {
    const payload = await runIntegrationHealthchecks();
    res.json({ ok: true, ...payload });
  } catch (error) {
    next(error);
  }
});

module.exports = router;