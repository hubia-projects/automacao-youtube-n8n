const axios = require("axios");
const { config } = require("../src/config/env");
const { runIntegrationHealthchecks } = require("../src/services/integrationHealthService");
const { app } = require("../src/app");

const run = async () => {
  const server = app.listen(8094, "127.0.0.1");
  const client = axios.create({ baseURL: "http://127.0.0.1:8094/api", timeout: 180000 });

  try {
    const localChecks = await runIntegrationHealthchecks();
    const apiChecks = await client.get("/health/integrations");

    const summary = {
      mock_mode: config.MOCK_MODE,
      local: localChecks,
      api: apiChecks.data,
    };

    console.log("🔎 Integration healthcheck result");
    console.log(JSON.stringify(summary, null, 2));

    const configuredProviders = Object.entries(localChecks.checks).filter(([, value]) => value.configured);
    const failedConfigured = configuredProviders.filter(([, value]) => !value.ok);

    if (failedConfigured.length > 0) {
      console.error("❌ Algumas integrações configuradas falharam:");
      failedConfigured.forEach(([name, value]) => {
        console.error(` - ${name}: ${value.message}`);
      });
      process.exit(1);
    }

    console.log("✅ Todas as integrações configuradas responderam com sucesso.");
  } finally {
    server.close();
  }
};

run().catch((error) => {
  console.error("❌ Integration healthcheck script falhou", error.message);
  process.exit(1);
});