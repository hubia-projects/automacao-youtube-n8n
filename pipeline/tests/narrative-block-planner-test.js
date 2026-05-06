const assert = require("assert");
const { buildNarrativeBlocks, enrichVisualPlan } = require("../src/services/narrativeBlockPlanner");

const visualPlan = [
  { scene_index: 1, title: "Intro geral", narration_excerpt: "Portugal mistura cidades historicas e sabores marcantes.", keywords: ["portugal", "travel", "overview"], target_duration_seconds: 6 },
  { scene_index: 2, title: "Lisboa", narration_excerpt: "Lisboa combina cafes, miradouros e ruas cheias de vida.", keywords: ["lisboa", "cafe", "miradouro"], target_duration_seconds: 8 },
  { scene_index: 3, title: "Porto", narration_excerpt: "Porto traz o Douro, as caves e restaurantes ao redor da Ribeira.", keywords: ["porto", "douro", "wine cellar"], target_duration_seconds: 8 },
  { scene_index: 4, title: "Sintra", narration_excerpt: "Sintra parece um conto, com palacios, floresta e confeitarias classicas.", keywords: ["sintra", "palace", "bakery"], target_duration_seconds: 8 },
  { scene_index: 5, title: "Faro", narration_excerpt: "Faro e o Algarve fecham com marina, mercado e pratos de marisco.", keywords: ["faro", "algarve", "market"], target_duration_seconds: 8 },
];

const { macroBlocks, microBlocks } = buildNarrativeBlocks({
  state: { topic: "Portugal gastronomia", visual_plan: visualPlan },
  audioDuration: 40,
});

assert(macroBlocks.length >= 4, "planner deveria criar macro blocos por cidade");
assert(macroBlocks.some((block) => block.topic === "Lisboa"), "faltou bloco Lisboa");
assert(macroBlocks.some((block) => block.topic === "Porto"), "faltou bloco Porto");
assert(macroBlocks.some((block) => block.topic === "Sintra"), "faltou bloco Sintra");
assert(macroBlocks.some((block) => block.topic === "Faro"), "faltou bloco Faro");

const lisboaBlock = macroBlocks.find((block) => block.topic === "Lisboa");
assert(lisboaBlock.negative_keywords.includes("Porto"), "Lisboa deveria negar Porto");
assert(lisboaBlock.negative_keywords.includes("Sintra"), "Lisboa deveria negar Sintra");

const enriched = enrichVisualPlan({
  topic: "Portugal gastronomia",
  visualPlan,
  audioDuration: 40,
}).visualPlan;

assert(enriched.every((scene) => scene.block_id), "todas as cenas precisam herdar block_id");
assert(enriched.every((scene) => scene.block_label), "todas as cenas precisam herdar block_label");
assert(enriched.every((scene) => Array.isArray(scene.negative_keywords)), "todas as cenas precisam herdar negative_keywords");
assert(enriched.find((scene) => scene.title === "Lisboa").block_label === "Lisboa", "cena de Lisboa deveria herdar bloco Lisboa");
assert(enriched.every((scene) => scene.transition_type === "hard" || scene.transition_type === "soft"), "todas as cenas precisam ter transition_type");

const hardBoundaryScenes = enriched.filter((scene) => scene.hard_boundary);
assert(hardBoundaryScenes.length >= 3, "deveria haver multiplas trocas hard no roteiro");
assert(hardBoundaryScenes.every((scene) => scene.boundary_id), "cenas hard precisam de boundary_id");
assert(hardBoundaryScenes.every((scene) => scene.chapter_card_required === true), "cenas hard devem exigir chapter card");
assert(hardBoundaryScenes.every((scene) => scene.block_intro_asset?.required === true), "cenas hard devem expor block_intro_asset");

console.log("narrative block planner validado com sucesso");
