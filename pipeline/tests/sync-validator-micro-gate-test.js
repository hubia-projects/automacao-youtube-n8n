const assert = require("assert");
const { __test__ } = require("../src/services/syncValidator");

const run = async () => {
  const clips = [
    {
      clip_index: 1,
      micro_id: "mic_0001",
      critical_slot: true,
      micro_slot_ok: false,
      micro_timing_drift_sec: 0.3,
    },
    {
      clip_index: 2,
      micro_id: "mic_0002",
      critical_slot: true,
      micro_slot_ok: true,
      micro_timing_drift_sec: 1.35,
    },
    {
      clip_index: 3,
      micro_id: "mic_0003",
      critical_slot: false,
      micro_slot_ok: true,
      micro_timing_drift_sec: 0.2,
    },
  ];

  const microGate = __test__.evaluateMicroSyncGate({ clips, maxDriftSec: 1.0 });
  assert.strictEqual(microGate.critical_micro_missing_count, 1, "deveria contar micro crítico sem prova");
  assert.strictEqual(microGate.critical_micro_drift_exceeded_count, 1, "deveria contar drift crítico acima do limite");

  const codes = __test__.buildEditorialFailureCodes({
    issues: [],
    gate: {},
    microGate,
    approvedPoolAudit: { timeline_uses_approved_pool_only: true },
    sceneEditorialReadiness: [],
  });
  assert(codes.includes("NO_MICRO_PROOF_FOR_PROMISE"), "deveria emitir código NO_MICRO_PROOF_FOR_PROMISE");
  assert(codes.includes("MICRO_TIMING_DRIFT_EXCEEDED"), "deveria emitir código MICRO_TIMING_DRIFT_EXCEEDED");

  console.log("sync validator micro gate validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

