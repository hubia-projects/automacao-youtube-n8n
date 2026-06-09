const assert = require("assert");
const { __test__ } = require("../src/services/assetsService");

__test__.clearProviderRateLimitState();

assert.strictEqual(__test__.isProviderAvailable("pexels"), true, "provider sem tracking deveria iniciar disponivel");

const lowRemaining = __test__.trackProviderRateLimit("pexels", {
  "x-ratelimit-remaining": "9",
});

assert.strictEqual(lowRemaining.remaining, 9, "deveria rastrear remaining baixo do header");
assert.strictEqual(__test__.isProviderAvailable("pexels"), true, "remaining baixo sem 429 nao deveria bloquear provider");

const cooldownState = __test__.markProviderRateLimited("pexels", "unit_test_429");
assert.strictEqual(cooldownState.remaining, 0, "429 deveria zerar remaining efetivo");
assert.strictEqual(__test__.isProviderAvailable("pexels"), false, "provider com cooldown ativo deveria ser pulado");

__test__.clearProviderRateLimitState();
assert.strictEqual(__test__.isProviderAvailable("pexels"), true, "clear deveria resetar estado de cooldown");

console.log("test_assets_GA validado com sucesso");