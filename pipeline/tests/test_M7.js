"use strict";
// Definir OUTPUT_ROOT antes de qualquer require que carregue env.js
const path = require("path");
process.env.OUTPUT_ROOT = path.join(__dirname, "..", "output-test-m7");
const assert = require("assert");
const { validateScriptPackage } = require("../src/services/openaiService");

const basePackage = {
  video_objective: "Objetivo do vídeo",
  intro_hook: "Hook de abertura",
  research_json: { facts: ["fato1"], risks: ["risco1"], sources: ["fonte1"] },
  outline_json: { sections: [{ title: "Seção 1", objective: "Objetivo" }] },
  script_text: "a".repeat(110),
  visual_suggestions: [{ section: "s1", shots: ["plano1"] }],
  factual_notes: ["nota1"],
  seo_keywords: ["kw1"],
  youtube_title_options: ["Título 1"],
  youtube_description: "Descrição",
  tags: ["tag1"],
  chapters: ["00:00 Introdução"],
};

// 1. Pacote válido com structured_blocks — deve passar
const validBlock = {
  block_id: "b01",
  text: "Texto do bloco",
  duration_estimate: 45,
  visual_type: "specific",
  visual_description: "Prato típico português em close",
  keywords: ["Lisboa", "comida"],
};
const validPackage = { ...basePackage, structured_blocks: [validBlock] };
assert.strictEqual(validateScriptPackage(validPackage), true, "pacote válido deve passar");

// 2. Sem structured_blocks (campo opcional) — deve passar
const noBlocks = { ...basePackage };
assert.strictEqual(validateScriptPackage(noBlocks), true, "structured_blocks é opcional, deve passar sem ele");

// 3. visual_type inválido — deve falhar
const badType = {
  ...basePackage,
  structured_blocks: [{ ...validBlock, visual_type: "nonsense" }],
};
assert.strictEqual(validateScriptPackage(badType), false, "visual_type inválido deve falhar");

// 4. block_id vazio — deve falhar
const emptyId = {
  ...basePackage,
  structured_blocks: [{ ...validBlock, block_id: "" }],
};
assert.strictEqual(validateScriptPackage(emptyId), false, "block_id vazio deve falhar");

// 5. duration_estimate negativo — deve falhar
const negDuration = {
  ...basePackage,
  structured_blocks: [{ ...validBlock, duration_estimate: -5 }],
};
assert.strictEqual(validateScriptPackage(negDuration), false, "duration_estimate negativo deve falhar");

// 6. script_text muito curto — deve falhar
const shortScript = { ...basePackage, script_text: "curto" };
assert.strictEqual(validateScriptPackage(shortScript), false, "script_text < 100 chars deve falhar");

console.log("✅ M7 test passou — todos os 6 casos validados");
