const assert = require("assert");
const { __test__: renderServiceTest } = require("../src/services/renderService");

const gateBlocked = renderServiceTest.evaluateRenderPreflightGate({
  state: {
    assets_json: {
      approved_windows: [],
      scene_editorial_readiness: [
        {
          scene_index: 1,
          blocking_reasons: ["missing_theme_visual_proof", "critical_slots_uncovered"],
          critical_slots_missing: ["hook", "first_clip"],
        },
      ],
    },
  },
  mockMode: false,
  allowRuntimeFallback: false,
});

assert.strictEqual(gateBlocked.shouldAbort, true, "preflight deve bloquear quando nao ha pool aprovado e cena critica bloqueada");
assert(gateBlocked.failure_codes.includes("NO_APPROVED_WINDOWS"));
assert(gateBlocked.failure_codes.includes("ALL_SCENES_EDITORIALLY_BLOCKED"));

const gateMock = renderServiceTest.evaluateRenderPreflightGate({
  state: {
    assets_json: {
      approved_windows: [],
      scene_editorial_readiness: [],
    },
  },
  mockMode: true,
  allowRuntimeFallback: true,
});

assert.strictEqual(gateMock.shouldAbort, false, "mock mode nao deve bloquear no preflight");

console.log("render-preflight-editorial-gate-test ok");
