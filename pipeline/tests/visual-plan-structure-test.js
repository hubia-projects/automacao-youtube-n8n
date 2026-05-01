const assert = require("assert");
const { buildVisualPlan } = require("../src/utils/visualPlan");

const scriptText = `Se estas a pensar explorar Portugal, ha tres cidades que simplesmente tens de conhecer... cada uma com uma identidade completamente diferente, mas todas com algo especial.

Lisboa e o ponto de partida perfeito. E uma cidade cheia de vida, onde o moderno e o historico se misturam de uma forma natural. Tens bairros como Alfama e Bairro Alto, com ruas estreitas, casas tipicas e aquela sensacao autentica. Depois tens os miradouros, espalhados pela cidade, onde consegues ver o Tejo e todo o movimento a volta. Durante o dia, perdes-te pelas ruas, experimentas a comida local... e a noite, a cidade ganha outra energia.

Mais a norte, o Porto traz uma vibe completamente diferente. E mais calmo, mais intimista, mas com uma presenca muito forte. A zona da Ribeira, junto ao rio Douro, e provavelmente uma das mais bonitas do pais, com as casas coloridas e o reflexo na agua. As pontes, especialmente a Dom Luis I, dao um cenario unico. E claro, nao da para falar do Porto sem falar do vinho e das caves em Vila Nova de Gaia.

E depois ha Faro, no Algarve, que funciona como porta de entrada para algumas das melhores praias de Portugal. A cidade em si e mais tranquila, com um centro historico bonito e organizado, mas o verdadeiro destaque esta nas ilhas e praias a volta. Tens agua mais quente, paisagens abertas e aquele ambiente de verao constante. E o tipo de sitio perfeito para relaxar, aproveitar o sol e desligar um pouco do ritmo mais acelerado.

Lisboa, Porto e Faro... tres cidades, tres experiencias completamente diferentes... mas todas mostram o melhor que Portugal tem para oferecer.`;

const plan = buildVisualPlan({
  topic: "Portugal travel",
  scriptText,
  durationSeconds: 88,
});

assert(plan.length >= 8, "visual_plan deveria gerar cenas suficientes para um roteiro narrativo completo");
assert(plan.every((scene) => !/^Narracao principal/i.test(scene.title)), "titulos ainda estao genericos demais");

const lisboaScene = plan.find((scene) => /Lisboa/i.test(scene.title));
const portoScene = plan.find((scene) => /Porto/i.test(scene.title));
const faroScene = plan.find((scene) => /Faro/i.test(scene.title));
const openingScene = plan[0];
const closingScene = plan[plan.length - 1];

assert(lisboaScene, "visual_plan nao destacou Lisboa como bloco narrativo");
assert(portoScene, "visual_plan nao destacou Porto como bloco narrativo");
assert(faroScene, "visual_plan nao destacou Faro como bloco narrativo");
assert(/Abertura|Portugal/i.test(openingScene.title), "abertura nao ficou identificavel no visual_plan");
assert(/Fechamento|Portugal/i.test(closingScene.title), "fechamento nao ficou identificavel no visual_plan");
assert(
  lisboaScene.keywords.some((keyword) => /lisbon|lisboa|tagus|alfama|bairro alto/.test(keyword)),
  "keywords de Lisboa nao preservaram a geografia do texto"
);
assert(
  portoScene.keywords.some((keyword) => /porto|douro|ribeira|bridge|gaia/.test(keyword)),
  "keywords do Porto nao preservaram a geografia do texto"
);
assert(
  faroScene.keywords.some((keyword) => /faro|algarve|coast|beach/.test(keyword)),
  "keywords de Faro nao preservaram a geografia do texto"
);

console.log("visual_plan estruturado com sucesso");
console.log(
  JSON.stringify(
    {
      total_scenes: plan.length,
      opening_title: openingScene.title,
      lisboa_title: lisboaScene.title,
      porto_title: portoScene.title,
      faro_title: faroScene.title,
      closing_title: closingScene.title,
    },
    null,
    2
  )
);