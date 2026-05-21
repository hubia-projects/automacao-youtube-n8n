const assert = require("assert");
const { updateState } = require("../src/services/stateService");
const { getProductionPreflightStatus } = require("../src/services/youtubeService");

const run = async () => {
  const successVideoId = `prod_gate_success_${Date.now()}`;
  await updateState(successVideoId, {
    render_validation: {
      is_publishable: true,
      needs_regeneration: false,
      needs_manual_review: false,
      hard_boundary_status: "pass",
      qa_runtime_profile: "prod_strict",
      publish_blocked: false,
      publish_blocked_codes: [],
      editorial_failure_codes: [],
    },
  }, { currentStep: "render_validated", status: "render_validated" });

  const successStatus = await getProductionPreflightStatus({ videoId: successVideoId, mockMode: false });
  assert(Array.isArray(successStatus.publish_blocked_codes), "deve retornar lista de bloqueios");
  assert.strictEqual(successStatus.publish_blocked_codes.length, 0, "fixture de sucesso não deve gerar bloqueio editorial");

  const failVideoId = `prod_gate_fail_${Date.now()}`;
  await updateState(failVideoId, {
    render_validation: {
      is_publishable: false,
      needs_regeneration: true,
      needs_manual_review: true,
      hard_boundary_status: "fail",
      qa_runtime_profile: "prod_strict",
      publish_blocked: true,
      publish_blocked_codes: ["CRITICAL_SLOT_MISSING", "NO_MICRO_PROOF_FOR_PROMISE"],
      editorial_failure_codes: ["NO_MICRO_PROOF_FOR_PROMISE", "TIMELINE_OUTSIDE_APPROVED_POOL"],
    },
  }, { currentStep: "render_validated", status: "render_validated" });

  const failStatus = await getProductionPreflightStatus({ videoId: failVideoId, mockMode: false });
  const failCodes = new Set(failStatus.publish_blocked_codes || []);
  assert(failCodes.has("CRITICAL_SLOT_MISSING"), "deve preservar código crítico de bloqueio");
  assert(failCodes.has("NO_MICRO_PROOF_FOR_PROMISE"), "deve preservar código micro crítico");
  assert(failCodes.has("TIMELINE_OUTSIDE_APPROVED_POOL"), "deve refletir código editorial de timeline");

  console.log("prod strict gate determinism validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
