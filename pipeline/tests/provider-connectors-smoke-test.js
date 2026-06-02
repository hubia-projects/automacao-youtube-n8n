const { basicMultivozesHealthcheck } = require("../src/services/ttsService");
const { basicGeminiHealthcheck } = require("../src/services/geminiService");

const run = async () => {
  const [multivozes, gemini] = await Promise.all([
    basicMultivozesHealthcheck(),
    basicGeminiHealthcheck(),
  ]);

  const summary = {
    multivozes,
    gemini,
  };

  console.log("🔎 Provider connectors smoke result");
  console.log(JSON.stringify(summary, null, 2));

  const failedConfigured = Object.entries(summary).filter(([, value]) => value.configured && !value.ok);
  if (failedConfigured.length > 0) {
    console.error("❌ Alguns conectores configurados falharam:");
    failedConfigured.forEach(([name, value]) => {
      console.error(` - ${name}: ${value.message}`);
    });
    process.exit(1);
  }

  console.log("✅ Todos os conectores configurados responderam com sucesso.");
};

run().catch((error) => {
  console.error("❌ Provider connectors smoke falhou", error.message);
  process.exit(1);
});