const { generateTextWithGemini, basicGeminiHealthcheck } = require("./pipeline/src/services/geminiService");

const run = async () => {
  const health = await basicGeminiHealthcheck();
  console.log("Gemini health:");
  console.log(JSON.stringify(health, null, 2));

  if (!health.configured) {
    throw new Error("GEMINI_API_KEY ausente.");
  }

  const result = await generateTextWithGemini({
    model: process.env.GEMINI_VISION_MODEL_LITE || "gemini-2.5-flash",
    prompt: "Responda apenas: API Gemini funcionando.",
  });

  if (!result?.text) {
    throw new Error("Gemini não retornou texto.");
  }

  console.log("Gemini text result:");
  console.log(JSON.stringify(result, null, 2));
};

run().catch((error) => {
  console.error("Gemini standalone test falhou:", error.message || error);
  process.exit(1);
});
