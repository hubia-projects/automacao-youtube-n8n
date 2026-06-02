const assert = require("assert");
const { __test__ } = require("../src/services/assetsService");

const run = async () => {
  const wideBudget = __test__.resolveGeminiAssetAnalysisBudget({
    stageDeadlineAt: Date.now() + 120000,
    analysisBudgetMs: 120000,
  });
  assert(wideBudget, "orcamento amplo deve produzir parametros de analise");
  assert.strictEqual(wideBudget.timeoutMs, 20000, "orcamento amplo deve preservar timeout padrao de analise");
  assert.strictEqual(wideBudget.maxRetries, 3, "orcamento amplo deve permitir 3 retries");

  const tightBudget = __test__.resolveGeminiAssetAnalysisBudget({
    stageDeadlineAt: Date.now() + 15000,
    analysisBudgetMs: 15000,
  });
  assert(tightBudget, "orcamento ainda viavel deve gerar fallback temporal controlado");
  assert.strictEqual(tightBudget.timeoutMs, 15000, "timeout deve encolher para caber no orcamento restante");
  assert.strictEqual(tightBudget.maxRetries, 0, "sem janela sobrando, retries devem cair para zero");

  const exhaustedBudget = __test__.resolveGeminiAssetAnalysisBudget({
    stageDeadlineAt: Date.now() + 2000,
    analysisBudgetMs: 2000,
  });
  assert.strictEqual(exhaustedBudget, null, "orcamento exaurido deve pular Gemini e cair em fallback");

  console.log("assets stage deadline budget ok");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
