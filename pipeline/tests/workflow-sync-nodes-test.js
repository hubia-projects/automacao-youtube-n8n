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

const workflow2CallWorkflow3 = workflow2.nodes.find((node) => node.name === "Call Workflow 3");
assert.strictEqual(
	workflow2CallWorkflow3?.parameters?.workflowId,
	workflow3.id,
	"workflow 2 deveria apontar para o id estavel do workflow 3"
);

const nodeNames3 = workflow3.nodes.map((node) => node.name);
assert(nodeNames3.includes("Validate Render Sync"), "workflow 3 deveria incluir Validate Render Sync");
assert(nodeNames3.includes("Fix Render Sync"), "workflow 3 deveria incluir Fix Render Sync");

console.log("workflow sync nodes validados com sucesso");
