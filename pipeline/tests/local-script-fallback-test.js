const assert = require("assert");

process.env.LOCAL_TEST_MODE = "true";
process.env.LOCAL_TEST_DISABLE_OPENAI = "true";
process.env.EXTERNAL_API_CIRCUIT_BREAKER_ENABLED = "true";
process.env.EXTERNAL_API_MAX_CALLS_TOTAL = "0";
process.env.EXTERNAL_API_MAX_CALLS_OPENAI = "0";

const { updateState, loadState } = require("../src/services/stateService");
const { generateScript } = require("../src/services/scriptService");

const run = async () => {
  const videoId = `local_script_fallback_${Date.now()}`;
  await updateState(videoId, {
    topic: "3 cidades mais bonitas de Portugal: Porto, Lisboa e Sintra",
    angle: "documental prático",
    selected_idea: {
      topic: "3 cidades mais bonitas de Portugal: Porto, Lisboa e Sintra",
      angle: "comparativo visual e prático",
    },
  }, { currentStep: "idea_approved", status: "idea_approved" });

  await generateScript({
    videoId,
    mockMode: false,
    targetDurationSeconds: 660,
  });

  const state = await loadState(videoId);
  const words = String(state.script_text || "").split(/\s+/).filter(Boolean).length;

  assert.strictEqual(state.script_provider, "local_custom_script_fallback", "deve marcar provider de fallback local");
  assert.strictEqual(state.script_fallback_used, true, "deve marcar fallback como utilizado");
  assert(words >= 450, "roteiro fallback deve ser completo (>=450 palavras)");
  assert(
    Number(state.external_api_stats?.fallbacks_used || 0) >= 1
      || Number(state.external_api_stats?.blocked_calls || 0) >= 1,
    "deve registrar fallback/controle de chamada externa"
  );

  console.log("local script fallback validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
