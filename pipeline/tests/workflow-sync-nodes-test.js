const assert = require("assert");
const workflow1 = require("../n8n/workflow1_weekly_topic_script.json");
const workflow2 = require("../n8n/workflow2_audio_captions_assets.json");
const workflow3 = require("../n8n/workflow3_render_youtube.json");

const nodeNames1 = workflow1.nodes.map((node) => node.name);
assert(nodeNames1.includes("Manual Trigger"), "workflow 1 deveria incluir Manual Trigger para disparo manual");
assert(nodeNames1.includes("Schedule Trigger"), "workflow 1 deveria incluir Schedule Trigger para disparo agendado");

assert.strictEqual(workflow2.id, "YiezxhzyVQT3XJuz", "workflow 2 deveria manter id estavel para executeWorkflow");
assert.strictEqual(workflow3.id, "SWfoFJ3aNt2nJboC", "workflow 3 deveria manter id estavel para executeWorkflow");

const workflow1CallWorkflow2 = workflow1.nodes.find((node) => node.name === "Call Workflow 2");
assert.strictEqual(
	workflow1CallWorkflow2?.parameters?.workflowId,
	workflow2.id,
	"workflow 1 deveria apontar para o id estavel do workflow 2"
);

const nodeNames2 = workflow2.nodes.map((node) => node.name);
assert(nodeNames2.includes("Analyze Audio Intelligence"), "workflow 2 deveria incluir Analyze Audio Intelligence");
assert(nodeNames2.includes("If Assets Ready"), "workflow 2 deveria validar readiness dos assets antes de chamar o workflow 3");
assert(nodeNames2.includes("Mark Needs Manual Review Missing Assets"), "workflow 2 deveria marcar revisao manual quando faltar asset real");

const workflow2CallWorkflow3 = workflow2.nodes.find((node) => node.name === "Call Workflow 3");
assert.strictEqual(
	workflow2CallWorkflow3?.parameters?.workflowId,
	workflow3.id,
	"workflow 2 deveria apontar para o id estavel do workflow 3"
);

assert.strictEqual(
	workflow2.connections?.["Search Assets"]?.main?.[0]?.[0]?.node,
	"If Assets Ready",
	"workflow 2 deveria checar readiness logo apos Search Assets"
);

assert.strictEqual(
	workflow2.connections?.["If Assets Ready"]?.main?.[0]?.[0]?.node,
	"Call Workflow 3",
	"workflow 2 deveria chamar workflow 3 apenas no ramo em que os assets estao prontos"
);

assert.strictEqual(
	workflow2.connections?.["If Assets Ready"]?.main?.[1]?.[0]?.node,
	"Mark Needs Manual Review Missing Assets",
	"workflow 2 deveria parar o fluxo normal e marcar revisao manual quando faltar asset"
);

const workflow2ManualReview = workflow2.nodes.find((node) => node.name === "Mark Needs Manual Review Missing Assets");
assert.strictEqual(
	workflow2ManualReview?.parameters?.url,
	"={{$env.BACKEND_BASE_URL}}/api/videos/review/mark-manual-review",
	"workflow 2 deveria usar a rota de marcacao de revisao manual para assets ausentes"
);

const nodeNames3 = workflow3.nodes.map((node) => node.name);
assert(nodeNames3.includes("Validate Render Sync"), "workflow 3 deveria incluir Validate Render Sync");
assert(nodeNames3.includes("Fix Render Sync"), "workflow 3 deveria incluir Fix Render Sync");
assert(nodeNames3.includes("Mark Needs Manual Review"), "workflow 3 deveria marcar needs_manual_review apos falha no pos-fix");
assert(!nodeNames3.includes("Generate Metadata With Warning"), "workflow 3 nao deveria mais seguir para metadata com warning apos falha no pos-fix");

const ifRenderOk = workflow3.nodes.find((node) => node.name === "If Render OK");
assert(
	String(ifRenderOk?.parameters?.conditions?.boolean?.[0]?.value1 || "").includes("hard_boundary_status === 'pass'"),
	"workflow 3 deveria validar hard_boundary_status antes de seguir"
);

const ifRenderOkAfterFix = workflow3.nodes.find((node) => node.name === "If Render OK After Fix");
assert(
	String(ifRenderOkAfterFix?.parameters?.conditions?.boolean?.[0]?.value1 || "").includes("max_visual_lag_sec"),
	"workflow 3 deveria validar max_visual_lag_sec antes de metadata"
);

const markNeedsManualReview = workflow3.nodes.find((node) => node.name === "Mark Needs Manual Review");
assert.strictEqual(
	markNeedsManualReview?.parameters?.url,
	"={{$env.BACKEND_BASE_URL}}/api/videos/review/mark-manual-review",
	"workflow 3 deveria chamar a rota de marcacao de revisao manual"
);

console.log("workflow sync nodes validados com sucesso");
