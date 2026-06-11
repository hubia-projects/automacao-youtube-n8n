const { writeTextAtomic } = require("../utils/fileUtils");
const { updateState, ensureVideoStructure, loadState } = require("./stateService");
const { generateScriptPackageWithOpenAI } = require("./openaiService");
const { generateScriptPackageWithGemini } = require("./geminiService");
const { sendWorkflowStatus } = require("./telegramService");
const { buildVisualPlan } = require("../utils/visualPlan");

const buildMockPackage = ({ topic, angle }) => {
  const sections = [
    {
      title: "Abertura e contexto",
      objective: "Criar curiosidade imediata",
      narration:
        `Hoje você vai descobrir por que ${topic} está chamando tanta atenção e como isso pode transformar sua próxima viagem.`,
      visual_suggestions: [
        "Mapa animado do destino",
        "Tomadas aéreas de abertura",
        "Texto em tela com promessa principal",
      ],
      factual_notes: ["Contextualizar dados com ano de referência"],
    },
    {
      title: "Panorama prático",
      objective: "Entregar utilidade para o público",
      narration:
        "Vamos analisar custos, melhor época, logística e riscos para você planejar com confiança.",
      visual_suggestions: [
        "B-roll de transporte público",
        "Preços e orçamento em gráficos simples",
      ],
      factual_notes: ["Usar médias de custo de vida e variação cambial"],
    },
    {
      title: "Top pontos imperdíveis",
      objective: "Elevar retenção com lista visual",
      narration:
        "Agora o ranking que você realmente quer ver: os lugares que entregam experiência memorável sem estourar o orçamento.",
      visual_suggestions: [
        "Clipes de pontos turísticos",
        "Transições rápidas com marcador de ranking",
      ],
      factual_notes: ["Evitar superlativos sem base"],
    },
    {
      title: "Fechamento e CTA",
      objective: "Consolidar valor e incentivar ação",
      narration:
        "Se este guia te ajudou, salve para usar no planejamento e compartilhe com quem vai viajar com você.",
      visual_suggestions: ["Resumo em bullet points", "Tela final com CTA"],
      factual_notes: ["Reforçar que preços podem variar"],
    },
  ];

  const scriptText = [
    `# ${topic}`,
    "",
    "## Intro Hook",
    `Se você quer viajar melhor e gastar menos, este vídeo sobre ${topic} vai te poupar tempo e dinheiro.`,
    "",
    ...sections.map(
      (section, index) =>
        `## ${index + 1}. ${section.title}\n\n${section.narration}\n\nTransição: Vamos avançar para o próximo ponto com foco prático.`
    ),
    "",
    "## Encerramento",
    "Obrigado por assistir. Comente qual destino você quer ver no próximo vídeo.",
  ].join("\n");

  return {
    video_objective: `Entregar visão prática e envolvente sobre ${topic}`,
    intro_hook: `Você está prestes a descobrir detalhes pouco falados sobre ${topic}.`,
    research_json: {
      facts: [
        "Comparar custo médio diário por viajante",
        "Citar sazonalidade e impacto no preço",
        "Apontar logística de chegada e deslocamento",
      ],
      risks: ["Desatualização de preços", "Generalizações sem fonte"],
      sources: ["Numbeo", "Google Travel", "dados oficiais de turismo"],
    },
    outline_json: { sections: sections.map(({ title, objective }) => ({ title, objective })) },
    script_text: scriptText,
    visual_suggestions: sections.map((section) => ({
      section: section.title,
      shots: section.visual_suggestions,
    })),
    factual_notes: sections.flatMap((section) => section.factual_notes),
    seo_keywords: [topic, "viagem barata", "custo de vida", "destinos subestimados"],
    youtube_title_options: [
      `${topic}: Guia Completo para Viajar Melhor em 2026`,
      `${topic} Vale a Pena? Custos, Dicas e Lugares Imperdíveis`,
      `Tudo Sobre ${topic}: O Que Ninguém Te Conta`,
    ],
    youtube_description: `Neste vídeo você encontra um guia prático sobre ${topic}, com custos, dicas, curiosidades e planejamento para viajar com inteligência.`,
    tags: [topic, "viagem", "turismo", "cidades", "ranking de destinos"],
    chapters: [
      "00:00 Introdução",
      "00:45 Panorama",
      "03:30 Custos e logística",
      "06:20 Ranking de lugares",
      "09:30 Conclusão",
    ],
    angle: angle || "documental prático",
  };
};

const createScriptMarkdown = ({ topic, pkg }) => {
  const sectionLines = (pkg.outline_json?.sections || [])
    .map((section, idx) => `### ${idx + 1}. ${section.title}\nObjetivo: ${section.objective}`)
    .join("\n\n");

  return [
    `# Projeto de Vídeo: ${topic}`,
    "",
    "## Objetivo do Vídeo",
    pkg.video_objective,
    "",
    "## Intro Hook",
    pkg.intro_hook,
    "",
    "## Estrutura",
    sectionLines,
    "",
    "## Narração Completa",
    pkg.script_text,
    "",
    "## Sugestões Visuais",
    (pkg.visual_suggestions || [])
      .map((item) => `- ${item.section}: ${(item.shots || []).join(", ")}`)
      .join("\n"),
    "",
    "## Notas Factuais",
    (pkg.factual_notes || []).map((note) => `- ${note}`).join("\n"),
    "",
    "## SEO Keywords",
    (pkg.seo_keywords || []).join(", "),
    "",
    "## Opções de Título",
    (pkg.youtube_title_options || []).map((title) => `- ${title}`).join("\n"),
    "",
    "## Descrição YouTube",
    pkg.youtube_description || "",
    "",
    "## Tags",
    (pkg.tags || []).join(", "),
    "",
    "## Chapters",
    (pkg.chapters || []).map((chapter) => `- ${chapter}`).join("\n"),
    "",
  ].join("\n");
};

const generateScript = async ({ videoId, mockMode = false, topic: providedTopic = "" }) => {
  const state = await loadState(videoId);
  const topic = providedTopic || state.topic || state.selected_idea?.topic;
  const angle = state.angle || state.selected_idea?.angle || "documental";

  if (!topic) {
    throw new Error("Nenhum tópico disponível. Gere e aprove uma ideia antes do roteiro.");
  }

  // Gemini primeiro, OpenAI como fallback, mock como último recurso
  const pkg = !mockMode
    ? (await generateScriptPackageWithGemini({ topic, angle })) ||
      (await generateScriptPackageWithOpenAI({ topic, angle })) ||
      buildMockPackage({ topic, angle })
    : buildMockPackage({ topic, angle });
  const paths = await ensureVideoStructure(videoId);
  const markdown = createScriptMarkdown({ topic, pkg });
  const visualPlan = buildVisualPlan({
    topic,
    scriptText: pkg.script_text || markdown,
    outlineSections: pkg.outline_json?.sections || [],
    visualSuggestions: pkg.visual_suggestions || [],
    durationSeconds: Number(state.duration_seconds || 0),
  });
  await writeTextAtomic(paths.scriptPath, markdown);

  const nextState = await updateState(
    videoId,
    {
      topic,
      angle,
      research_json: pkg.research_json || {},
      outline_json: pkg.outline_json || {},
      script_text: pkg.script_text || markdown,
      script_path: paths.scriptPath,
      visual_plan: visualPlan,
      youtube_title: pkg.youtube_title_options?.[0] || "",
      youtube_description: pkg.youtube_description || "",
      youtube_tags: pkg.tags || [],
      youtube_chapters: pkg.chapters || [],
      error_message: "",
    },
    {
      currentStep: "script_generated",
      status: "script_generated",
    }
  );

  await sendWorkflowStatus({
    videoId,
    title: "Roteiro gerado",
    icon: "📝",
    lines: ["Roteiro concluído. Enviando para o Workflow 2 gerar áudio, legendas e assets."],
  }).catch(() => null);

  return {
    video_id: videoId,
    topic,
    script_path: nextState.script_path,
    state_path: nextState.state_path,
    script_preview: (nextState.script_text || "").slice(0, 600),
  };
};

module.exports = {
  generateScript,
};