const assert = require("assert");

process.env.LOCAL_TEST_MODE = "false";
process.env.EXTERNAL_API_CIRCUIT_BREAKER_ENABLED = "true";
process.env.EXTERNAL_API_MAX_CALLS_TOTAL = "2";
process.env.EXTERNAL_API_MAX_CALLS_OPENAI = "1";
process.env.EXTERNAL_API_MAX_CALLS_GEMINI = "-1";
process.env.EXTERNAL_API_MAX_CALLS_YOUTUBE = "-1";

const {
  consumeExternalCallBudget,
  getExternalApiStats,
} = require("../src/services/externalApiControlService");

const run = async () => {
  const videoId = `budget_guard_${Date.now()}`;
  const first = consumeExternalCallBudget({
    provider: "openai",
    videoId,
    operation: "test_openai_1",
  });
  const second = consumeExternalCallBudget({
    provider: "openai",
    videoId,
    operation: "test_openai_2",
  });
  const third = consumeExternalCallBudget({
    provider: "gemini",
    videoId,
    operation: "test_gemini_1",
  });
  const stats = getExternalApiStats({ videoId });

  assert.strictEqual(first.allowed, true, "primeira chamada openai deve passar");
  assert.strictEqual(second.allowed, false, "segunda chamada openai deve bloquear pelo teto do provider");
  assert.strictEqual(third.allowed, true, "gemini deve passar com budget livre");
  assert.strictEqual(Number(stats.total_calls || 0), 2, "total de chamadas permitidas deve respeitar teto");
  assert(Number(stats.blocked_calls || 0) >= 1, "deve contabilizar chamadas bloqueadas");

  console.log("external api circuit breaker validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
