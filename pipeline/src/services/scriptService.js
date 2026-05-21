const { writeTextAtomic } = require("../utils/fileUtils");
const { updateState, ensureVideoStructure, loadState } = require("./stateService");
const { generateScriptPackageWithOpenAI } = require("./openaiService");
const { sendWorkflowStatus } = require("./telegramService");
const { buildVisualPlan } = require("../utils/visualPlan");
const { registerFallback, getExternalApiStats } = require("./externalApiControlService");

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

const normalizeTopicLabel = (value = "") =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const deriveTopicChapters = (topic = "", approvedIdea = {}) => {
  const raw = `${topic} ${approvedIdea?.angle || ""}`;
  const pieces = raw
    .split(/[:;,]| e | and |\/|-/i)
    .map((entry) => normalizeTopicLabel(entry))
    .filter(Boolean);
  const uniquePieces = [...new Set(pieces)];
  if (uniquePieces.length >= 3) return uniquePieces.slice(0, 3);
  if (uniquePieces.length === 2) return [...uniquePieces, "logística e custos"];
  if (uniquePieces.length === 1) return [uniquePieces[0], "dicas práticas", "logística e custos"];
  return ["contexto", "dicas práticas", "logística e custos"];
};

const buildDeterministicLocalPackage = ({
  topic,
  angle,
  targetDurationSeconds = 0,
  selectedIdea = null,
}) => {
  const durationSeconds = Math.max(480, Number(targetDurationSeconds || 0) || 720);
  const targetWords = Math.max(450, Math.round(durationSeconds * 2.2));
  const chapters = deriveTopicChapters(topic, selectedIdea || {});
  const chapterDuration = Math.max(90, Math.round(durationSeconds / (chapters.length + 2)));
  const sections = [
    { title: "Abertura e promessa editorial", objective: "Definir benefício direto para retenção" },
    ...chapters.map((chapter, index) => ({
      title: `${index + 1}. ${chapter}`,
      objective: `Cobrir evidências visuais e contexto prático de ${chapter}`,
    })),
    { title: "Fechamento e próximos passos", objective: "Consolidar utilidade e CTA sem exagero" },
  ];

  const baseParagraphs = [
    `Hoje vamos analisar ${topic} com um recorte ${angle || "documental prático"}, focando em decisão real para quem quer viajar melhor.`,
    `A ideia é sair do vídeo com critérios claros: o que priorizar, o que evitar e onde cada trecho visual realmente comprova a promessa editorial.`,
    ...chapters.map((chapter) =>
      `No bloco sobre ${chapter}, conectamos prova visual, contexto local e orientação prática, sempre evitando clipes genéricos que não sustentam o roteiro.`
    ),
    "No fechamento, organizamos os critérios usados, reforçamos limites de orçamento e deixamos checklist objetivo para aplicação imediata.",
  ];

  let scriptText = [
    `# ${topic}`,
    "",
    "## Intro Hook",
    `Se você quer um guia verificável sobre ${topic}, aqui está um roteiro completo com foco em decisão prática.`,
    "",
    ...sections.map((section) => `## ${section.title}\n\n${baseParagraphs.join(" ")}`),
    "",
    "## Encerramento",
    "Com esse panorama, você consegue montar um plano sem improviso e com melhor aderência ao objetivo da viagem.",
  ].join("\n");

  const currentWordCount = scriptText.split(/\s+/).filter(Boolean).length;
  if (currentWordCount < targetWords) {
    const reinforcement =
      " Critério adicional: validar consistência visual, densidade informativa e aderência semântica antes de confirmar cada corte da timeline.";
    const missingWords = targetWords - currentWordCount;
    const repeatCount = Math.ceil(missingWords / reinforcement.split(/\s+/).length);
    scriptText += `\n\n${Array.from({ length: repeatCount }).map(() => reinforcement).join(" ")}`;
  }

  return {
    video_objective: `Entregar roteiro verificável e prático sobre ${topic} com foco em retenção e utilidade.`,
    intro_hook: `Vamos provar, com exemplos objetivos, por que ${topic} pode ser uma ótima escolha quando o planejamento é bem executado.`,
    research_json: {
      facts: [
        `Mapear pontos de maior interesse sobre ${topic}`,
        "Checar sazonalidade e variação de custo",
        "Comparar logística entre regiões-chave",
      ],
      risks: ["Dados de preço desatualizados", "Trechos visuais genéricos sem relação com o texto"],
      sources: ["dados oficiais de turismo", "índices de custo de vida", "fontes públicas locais"],
    },
    outline_json: { sections },
    script_text: scriptText,
    visual_suggestions: sections.map((section) => ({
      section: section.title,
      shots: [
        `Plano contextual de ${topic}`,
        "Plano de detalhe com elemento citado na fala",
        "Plano de transição para continuidade narrativa",
      ],
    })),
    factual_notes: [
      "Evitar afirmações absolutas sem evidência visual.",
      "Priorizar termos verificáveis por cena.",
      "Registrar incerteza quando não houver prova micro.",
    ],
    seo_keywords: [topic, "guia completo", "planejamento de viagem", "dicas práticas", "roteiro real"],
    youtube_title_options: [
      `${topic}: guia prático e verificável`,
      `${topic} sem enrolação: o que realmente importa`,
      `${topic}: roteiro completo com foco em decisão`,
    ],
    youtube_description: `Roteiro completo sobre ${topic} com abordagem prática, critérios de decisão e foco em evidências visuais por cena.`,
    tags: [topic, "viagem", "guia", "planejamento", "dicas"],
    chapters: [
      "00:00 Introdução",
      ...chapters.map((chapter, index) => {
        const sec = chapterDuration * (index + 1);
        const mm = String(Math.floor(sec / 60)).padStart(2, "0");
        const ss = String(sec % 60).padStart(2, "0");
        return `${mm}:${ss} ${chapter}`;
      }),
      `${String(Math.floor((chapterDuration * (chapters.length + 1)) / 60)).padStart(2, "0")}:${String((chapterDuration * (chapters.length + 1)) % 60).padStart(2, "0")} Conclusão`,
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

const generateScript = async ({
  videoId,
  mockMode = false,
  topic: providedTopic = "",
  targetDurationSeconds = 0,
}) => {
  const state = await loadState(videoId);
  const topic = providedTopic || state.topic || state.selected_idea?.topic;
  const angle = state.angle || state.selected_idea?.angle || "documental";

  if (!topic) {
    throw new Error("Nenhum tópico disponível. Gere e aprove uma ideia antes do roteiro.");
  }

  let pkg = null;
  let scriptProvider = "local_mock_script_template";
  let scriptFallbackUsed = false;

  if (!mockMode) {
    pkg = await generateScriptPackageWithOpenAI({ topic, angle, targetDurationSeconds, videoId });
    if (pkg) {
      scriptProvider = "openai_script";
    } else {
      pkg = buildDeterministicLocalPackage({
        topic,
        angle,
        targetDurationSeconds,
        selectedIdea: state.selected_idea || null,
      });
      scriptProvider = "local_custom_script_fallback";
      scriptFallbackUsed = true;
      registerFallback({
        videoId,
        provider: "openai",
        operation: "generate_script_package",
        reason: "openai_unavailable_or_blocked",
      });
    }
  } else {
    pkg = buildMockPackage({ topic, angle });
  }
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
      script_provider: scriptProvider,
      script_fallback_used: scriptFallbackUsed,
      external_api_stats: getExternalApiStats({ videoId }),
      script_target_duration_seconds: Number(targetDurationSeconds || 0) || undefined,
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
