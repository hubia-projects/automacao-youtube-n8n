"use strict";
const path = require("path");
process.env.OUTPUT_ROOT = path.join(__dirname, "..", "output-test-m3");
const assert = require("assert");
const { hasOpenAi, generateImageWithDallE3 } = require("../src/services/openaiService");

const run = async () => {
  // 1. Verificar que a função existe e é exportada corretamente
  assert(typeof generateImageWithDallE3 === "function", "generateImageWithDallE3 deve ser uma função exportada");

  // 2. Sem OpenAI configurado (ou budget zerado em LOCAL_TEST_MODE) retorna null graciosamente
  // Em ambiente de teste LOCAL_TEST_DISABLE_OPENAI=true, deve retornar null sem lançar erro
  const result = await generateImageWithDallE3({
    prompt: "",
    videoId: "m3_test",
    outputPath: "/tmp/test_dalle_m3.png",
  });
  // Prompt vazio ou sem API → deve retornar null graciosamente, nunca lançar
  assert(result === null || typeof result === "string", "deve retornar null ou path string, nunca lançar erro");

  // 3. Verificar que visual_type validation na M7 mapeia "specific" e "generic"
  const { validateScriptPackage } = require("../src/services/openaiService");
  const pkgWithSpecific = {
    video_objective: "x", intro_hook: "x",
    research_json: { facts: [], risks: [], sources: [] },
    outline_json: { sections: [{ title: "t", objective: "o" }] },
    script_text: "a".repeat(110),
    visual_suggestions: [], factual_notes: [], seo_keywords: [],
    youtube_title_options: [], youtube_description: "", tags: [], chapters: [],
    structured_blocks: [
      { block_id: "b01", text: "Lisboa street market", duration_estimate: 45,
        visual_type: "specific", visual_description: "Mercado da Ribeira em Lisboa ao entardecer", keywords: ["Lisboa", "mercado"] },
      { block_id: "b02", text: "Generic cityscape", duration_estimate: 30,
        visual_type: "generic", visual_description: "Vista genérica de cidade europeia", keywords: ["cidade"] },
    ],
  };
  assert.strictEqual(validateScriptPackage(pkgWithSpecific), true, "pacote com blocos specific+generic deve passar validação M7");

  if (!hasOpenAi() || process.env.LOCAL_TEST_DISABLE_OPENAI === "true") {
    console.log("⚠️  M3 test: OPENAI não disponível — geração de imagem não testada end-to-end");
  } else {
    console.log("ℹ️  M3 test: OpenAI disponível — geração real seria testada em e2e");
  }

  console.log("✅ M3 test passou — generateImageWithDallE3 exportada, fail-open validado, schema M7 com visual_type OK");
};

run().catch((e) => { console.error("❌ M3 test falhou:", e.message); process.exit(1); });
