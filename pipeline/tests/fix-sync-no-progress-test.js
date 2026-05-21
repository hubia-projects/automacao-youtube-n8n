const assert = require("assert");
const { __test__ } = require("../src/services/syncValidator");

const run = async () => {
  const noProgress = __test__.hasNoProgressAfterRepair({
    beforeValidation: {
      needs_regeneration: true,
      editorial_failure_codes: ["CRITICAL_SLOT_MISSING", "NO_MICRO_PROOF_FOR_PROMISE"],
      publish_blocked_codes: [],
    },
    afterValidation: {
      needs_regeneration: true,
      editorial_failure_codes: ["NO_MICRO_PROOF_FOR_PROMISE", "CRITICAL_SLOT_MISSING"],
      publish_blocked_codes: [],
    },
  });

  const hasProgress = __test__.hasNoProgressAfterRepair({
    beforeValidation: {
      needs_regeneration: true,
      editorial_failure_codes: ["CRITICAL_SLOT_MISSING", "NO_MICRO_PROOF_FOR_PROMISE"],
      publish_blocked_codes: [],
    },
    afterValidation: {
      needs_regeneration: true,
      editorial_failure_codes: ["NO_MICRO_PROOF_FOR_PROMISE"],
      publish_blocked_codes: [],
    },
  });

  assert.strictEqual(noProgress, true, "deve detectar ausência de progresso quando códigos persistem");
  assert.strictEqual(hasProgress, false, "não deve sinalizar no-progress quando houve redução de códigos");
  console.log("fix sync no progress guard validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
