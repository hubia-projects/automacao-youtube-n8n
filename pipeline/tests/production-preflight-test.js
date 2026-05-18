const assert = require("assert");
const { updateState } = require("../src/services/stateService");
const { getProductionPreflightStatus } = require("../src/services/youtubeService");

const run = async () => {
  const videoId = `production_preflight_${Date.now()}`;
  await updateState(videoId, {
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

  const status = await getProductionPreflightStatus({ videoId, mockMode: false });
  assert(typeof status.ready_for_real_publish === "boolean", "preflight deve retornar flag de prontidão");
  assert(Array.isArray(status.blocking_codes), "preflight deve retornar códigos de bloqueio");
  assert(status.checks && typeof status.checks.has_youtube_credentials === "boolean", "preflight deve expor checks estruturados");
  assert(status.qa_runtime_profile === "prod_strict", "perfil QA deve refletir o estado");

  console.log("production preflight validado com sucesso");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

