const { generateIdeas } = require("../src/services/ideasService");

const assert = (condition, message) => {
  if (condition) throw new Error(message);
};

const run = async () => {
  console.log("💡 Gerando novas ideias de vídeos com OpenAI...");

  // Gerar ideias variadas para testar diferentes temas
  const videoId = `ideas_test_${Date.now()}`;
  const ideas = await generateIdeas({
    videoId,
    mockMode: false,
    count: 10,
  });

  console.log(`📊 Recebidas ${ideas.length} ideias`);
  
  assert(ideas.length >= 3, "OpenAI não gerou ideias suficientes");
  assert(ideas[0].topic, "Ideias não têm topic");
  assert(ideas[0].angle, "Ideias não têm angle");

  console.log("✅ Ideias geradas com sucesso:");
  console.log("📋 Lista de Ideias:");
  
  ideas.forEach((idea, index) => {
    console.log(`\n${index + 1}. 🎯 **${idea.topic}**`);
    console.log(`   📝 ${idea.angle}`);
  });

  // Escolher a melhor ideia (primeira da lista)
  const selectedIdea = ideas[0];
  console.log(`\n🏆 **Ideia Selecionada:**`);
  console.log(`🎯 Tópico: ${selectedIdea.topic}`);
  console.log(`📝 Ângulo: ${selectedIdea.angle}`);

  return selectedIdea;
};

run().catch((error) => {
  console.error("❌ Falha ao gerar ideias:", error.message);
  process.exit(1);
});
