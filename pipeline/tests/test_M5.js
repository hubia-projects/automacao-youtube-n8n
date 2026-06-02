"use strict";
const path = require("path");
process.env.OUTPUT_ROOT = path.join(__dirname, "..", "output-test-m5");
const assert = require("assert");
const { __test__: t } = require("../src/services/renderService");

const run = () => {
  // 1. TRANSITION_DURATION deve ser 0.3 (reduzido de 0.45)
  assert.strictEqual(t.TRANSITION_DURATION, 0.3, "TRANSITION_DURATION deve ser 0.3s");

  // 2. Verificar que as funções críticas ainda existem (não quebrou interfaces)
  assert(typeof t.buildClipPlan === "function", "buildClipPlan deve existir");
  assert(typeof t.buildVideoSourceWindow === "function", "buildVideoSourceWindow deve existir");
  assert(typeof t.evaluateRenderPreflightGate === "function", "evaluateRenderPreflightGate deve existir");

  console.log("✅ M5 test passou — TRANSITION_DURATION=0.3 e interfaces intactas");
};

run();
