const { writeTextAtomic } = require("../utils/fileUtils");
const { updateState, ensureVideoStructure, loadState } = require("./stateService");
const { generateScriptPackageWithOpenAI } = require("./openaiService");
const { generateScriptPackageWithGemini } = require("./geminiService");
const { sendWorkflowStatus } = require("./telegramService");
const { buildVisualPlan } = require("../utils/visualPlan");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");

const shortMockSectionSpecs = [
  { title: "Abertura", objective: "Gerar curiosidade imediata", intent: "city_landmark", narrationWords: 38 },
  { title: "Cena 1 — contexto geral", objective: "Contextualizar o destino", intent: "city_landmark", narrationWords: 56 },
  { title: "Cena 2 — primeira paragem", objective: "Mostrar o primeiro destaque", intent: "gastronomy", narrationWords: 60 },
  { title: "Cena 3 — cultura local", objective: "Evidenciar aspectos culturais", intent: "restaurant", narrationWords: 56 },
  { title: "Cena 4 — experiência autêntica", objective: "Apontar vivência única", intent: "market", narrationWords: 60 },
  { title: "Cena 5 — paisagem envolvente", objective: "Ancorar visualmente", intent: "street", narrationWords: 54 },
  { title: "Cena 6 — sabor típica", objective: "Evidenciar comida/patrimônio", intent: "pastry", narrationWords: 56 },
  { title: "Cena 7 — momento especial", objective: "Reforçar memória única", intent: "wine", narrationWords: 54 },
  { title: "Cena 8 — fecho prático", objective: "Síntese final e CTA curto", intent: "generic_transition", narrationWords: 38 },
];

const shortMockNarrations = [
  "Hoje vamos explorar ${topic} com olhos de quem quer ir além do óbvio.",
  "Para perceber ${topic}, o primeiro segredo é perder-se nas ruas antigas e deixar que o lugar te guie.",
  "Começamos pelo mercado municipal: cores, vozes e aromas que resumem a cidade em minutos.",
  "Depois é hora de sentar numa tasca típica e provar o prato que ninguém esquece: simples e verdadeiro.",
  "No coração do bairro histórico, paredes centenárias contam histórias que valem cada esquina.",
  "Em seguida, atravessamos o casario típico até uma padaria familiar que é patrimônio vivo.",
  "Aqui o tempo desacelera: prova-se o vinho local enquanto o sol poe sobre o rio Douro.",
  "No fim, o melhor souvenir não é objeto — é esta sensação de pertença que só ${topic} oferece.",
  "Guarde este vídeo, use como guia e comece a planear a sua próxima viagem hoje.",
];

const buildMockShortPackage = ({ topic = "", angle }) => {
  const sections = shortMockSectionSpecs.map((spec, index) => ({
    title: spec.title,
    objective: spec.objective,
    narrative_template: shortMockNarrations[index] || shortMockNarrations[shortMockNarrations.length - 1],
    visual_intent: spec.intent,
    narration_words_target: spec.narrationWords,
  }));

  const introduction = `Bem-vindo a um vídeo curto sobre ${topic}. Em poucos minutos, vamos percorrer o essencial.`;
  const closing = `Obrigado por ficar até ao fim. Subscreva e partilhe com quem vai gostar.`;
  const scriptText = [
    `# ${topic}`,
    "",
    `## Introdução`,
    introduction,
    "",
    ...sections.map((section, index) => {
      const narration = String(section.narrative_template || "").replace(/\$\{topic\}/g, topic);
      return `## ${index + 1}. ${section.title}\n\n${narration}`;
    }),
    "",
    `## Encerramento`,
    closing,
  ].join("\n");

  return {
    video_objective: `Mostrar ${topic} em pouco menos de 3 minutos, com foco visual direto e útil.`,
    intro_hook: introduction,
    research_json: {
      facts: [
        "Mercado municipal é referência local",
        "Cerveja / vinho artesanal é destaque",
        "Centro histórico conserva fachadas originais",
      ],
      risks: ["Desatualização de horários e preços"],
      sources: ["Site oficial", "Google Travel", "Roteiros locais"],
    },
    outline_json: { sections: sections.map(({ title, objective }) => ({ title, objective })) },
    script_text: scriptText,
    visual_suggestions: sections.map((section) => ({
      section: section.title,
      shots: [section.visual_intent, "Estabelecer lugar concreto"],
      visual_intent: section.visual_intent,
    })),
    factual_notes: ["Confirmar disponibilidade sazonal", "Validar nomes próprios"],
    seo_keywords: [topic, "guia rapido", "3 minutos", "cidade"],
    youtube_title_options: [
      `${topic} em 3 minutos`,
      `${topic}: tudo que precisa saber rápido`,
      `${topic} em pouco tempo`,
    ],
    youtube_description: `Vídeo curto sobre ${topic}, com os pontos essenciais em menos de 3 minutos de narração.`,
    tags: [topic, "viagem", "guia rapido", "cidades"],
    chapters: [
      "00:00 Introdução",
      "00:10 Contexto",
      "00:30 Primeira paragem",
      "01:10 Cultura local",
      "01:50 Mercado",
      "02:20 Bairro histórico",
      "02:40 Momento especial",
      "02:55 Encerramento",
    ],
    angle: angle || "guia curto em 3 minutos",
    structured_blocks: sections.map((section, index) => ({
      block_id: `b${String(index + 1).padStart(2, "0")}`,
      order: index + 1,
      text: sections[index].narrative_template.replace(/\$\{topic\}/g, topic),
      duration_estimate: Math.min(25, Math.max(12, Math.round(180 / sections.length))),
      visual_intent: section.visual_intent,
      expected_location: "",
      expected_country: "Portugal",
      required_visual_evidence: [],
      forbidden_visual_categories: [],
      asset_query_hints: [],
      generic_asset_allowed: section.visual_intent === "generic_transition",
    })),
  };
};

const buildMockPackage = ({ topic, angle, shortMode = false }) => {
  if (shortMode) return buildMockShortPackage({ topic, angle });

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

const countWords = (text = "") => String(text || "").trim().split(/\s+/).filter(Boolean).length;

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

const resolveEffectiveTargetDuration = (passedDurationSeconds = 0) => {
  const explicit = Number(passedDurationSeconds || 0);
  if (explicit > 0) return explicit;
  if (config.SHORT_VIDEO_MODE) return Number(config.TARGET_VIDEO_DURATION_SECONDS || 180);
  return 0;
};

const evaluateWordCount = ({ scriptText = "", minWords = 0, maxWords = 0, mockMode = false, hasStructuredBlocks = false }) => {
  const wordCount = countWords(scriptText);
  if (mockMode || hasStructuredBlocks || !minWords || !maxWords) {
    return { wordCount, status: "ok", minWords, maxWords };
  }
  if (wordCount < minWords) return { wordCount, status: "below", minWords, maxWords, delta: wordCount - minWords };
  if (wordCount > maxWords) return { wordCount, status: "above", minWords, maxWords, delta: wordCount - maxWords };
  return { wordCount, status: "ok", minWords, maxWords };
};

const generateScript = async ({
  videoId,
  mockMode = false,
  topic: providedTopic = "",
  targetDurationSeconds = 0,
  angle: providedAngle = "",
} = {}) => {
  const state = await loadState(videoId);
  const topic = providedTopic || state.topic || state.selected_idea?.topic;
  const angle = providedAngle || state.angle || state.selected_idea?.angle || "documental";

  if (!topic) {
    throw new Error("Nenhum tópico disponível. Gere e aprove uma ideia antes do roteiro.");
  }

  const effectiveTargetDuration = resolveEffectiveTargetDuration(targetDurationSeconds);
  const shortMode = effectiveTargetDuration > 0 && effectiveTargetDuration <= 240;
  const minWords = shortMode ? Number(config.TARGET_SCRIPT_WORDS_MIN || 380) : 0;
  const maxWords = shortMode ? Number(config.TARGET_SCRIPT_WORDS_MAX || 520) : 0;

  const generateOnce = async ({ wordCountRetry = false, previousWordCount = 0 } = {}) => {
    if (mockMode) {
      return buildMockPackage({ topic, angle, shortMode });
    }
    return (await generateScriptPackageWithGemini({ topic, angle, videoDurationSeconds: effectiveTargetDuration || undefined, wordCountRetry, previousWordCount })) ||
      (await generateScriptPackageWithOpenAI({ topic, angle, targetDurationSeconds: effectiveTargetDuration || undefined })) ||
      buildMockPackage({ topic, angle, shortMode });
  };

  let pkg = await generateOnce();
  let evalResult = evaluateWordCount({
    scriptText: pkg.script_text || "",
    minWords,
    maxWords,
    mockMode,
    hasStructuredBlocks: Array.isArray(pkg.structured_blocks) && pkg.structured_blocks.length > 0,
  });

  let wordCountRetryAttempted = false;
  if (!mockMode && evalResult.status !== "ok" && minWords > 0 && maxWords > 0) {
    wordCountRetryAttempted = true;
    logger.warn(
      `[MVP-SHORT] script_word_count fora do range (${evalResult.wordCount} vs ${minWords}-${maxWords}); retry com prompt reforçado.`
    );
    pkg = await generateOnce({ wordCountRetry: true, previousWordCount: evalResult.wordCount });
    evalResult = evaluateWordCount({
      scriptText: pkg.script_text || "",
      minWords,
      maxWords,
      mockMode,
      hasStructuredBlocks: Array.isArray(pkg.structured_blocks) && pkg.structured_blocks.length > 0,
    });
  }

  const paths = await ensureVideoStructure(videoId);
  const markdown = createScriptMarkdown({ topic, pkg });
  const visualPlan = buildVisualPlan({
    topic,
    scriptText: pkg.script_text || markdown,
    outlineSections: pkg.outline_json?.sections || [],
    visualSuggestions: pkg.visual_suggestions || [],
    durationSeconds: effectiveTargetDuration || Number(state.duration_seconds || 0),
    audioIntelligence: null,
  });
  await writeTextAtomic(paths.scriptPath, markdown);

  const nextState = await updateState(
    videoId,
    {
      topic,
      angle,
      short_mode: shortMode,
      target_duration_seconds: effectiveTargetDuration,
      script_word_count: evalResult.wordCount,
      script_word_count_target_min: minWords,
      script_word_count_target_max: maxWords,
      script_word_count_status: evalResult.status,
      script_word_count_retry_attempted: wordCountRetryAttempted,
      structured_blocks: Array.isArray(pkg.structured_blocks) ? pkg.structured_blocks : [],
      research_json: pkg.research_json || {},
      outline_json: pkg.outline_json || {},
      script_text: pkg.script_text || markdown,
      script_path: paths.scriptPath,
      visual_plan: visualPlan,
      youtube_title: pkg.youtube_title_options?.[0] || "",
      youtube_description: pkg.youtube_description || "",
      youtube_tags: pkg.tags || [],
      youtube_chapters: pkg.chapters || [],
      error_message: evalResult.status === "ok" || mockMode ? "" : `script_word_count fora do range (${evalResult.wordCount} vs ${minWords}-${maxWords})`,
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
    lines: [
      `Roteiro concluído (${evalResult.wordCount} palavras${shortMode ? `, alvo ${minWords}-${maxWords}` : ""}).`,
      "Enviando para o Workflow 2 gerar áudio, legendas e assets.",
    ],
  }).catch(() => null);

  return {
    video_id: videoId,
    topic,
    script_path: nextState.script_path,
    state_path: nextState.state_path,
    script_preview: (nextState.script_text || "").slice(0, 600),
    word_count: evalResult.wordCount,
    short_mode: shortMode,
    target_duration_seconds: effectiveTargetDuration,
    word_count_status: evalResult.status,
  };
};

module.exports = {
  generateScript,
};