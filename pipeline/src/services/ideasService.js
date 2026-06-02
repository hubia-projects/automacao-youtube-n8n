const { v4: uuidv4 } = require("uuid");
const { updateState } = require("./stateService");
const { generateIdeasWithGemini } = require("./geminiService");
const {
  sendTelegramMessage,
  buildIdeasApprovalMessage,
  sendWorkflowStatus,
} = require("./telegramService");
const { config } = require("../config/env");

const fallbackIdeas = [
  {
    topic: "10 países baratos para viajar em 2026",
    angle: "ranking com custo de vida e dicas práticas",
  },
  {
    topic: "Cidades subestimadas da Europa que parecem filme",
    angle: "curiosidades, visual incrível e roteiro econômico",
  },
  {
    topic: "Melhores cidades para nômades digitais iniciantes",
    angle: "internet, segurança, custo e qualidade de vida",
  },
  {
    topic: "Destinos mais bonitos e baratos da América do Sul",
    angle: "paisagens, logística e orçamento real",
  },
  {
    topic: "Top 12 cidades com melhor custo-benefício para morar fora",
    angle: "comparativo prático com riscos e oportunidades",
  },
];

const scoreIdea = (idea) => {
  const base = {
    search_demand: Math.floor(70 + Math.random() * 26),
    evergreen: Math.floor(65 + Math.random() * 31),
    retention: Math.floor(68 + Math.random() * 29),
    monetization: Math.floor(60 + Math.random() * 31),
    visual_assets: Math.floor(70 + Math.random() * 26),
    factual_risk: Math.floor(5 + Math.random() * 21),
  };

  const total = Math.round(
    base.search_demand * 0.24 +
      base.evergreen * 0.2 +
      base.retention * 0.24 +
      base.monetization * 0.14 +
      base.visual_assets * 0.14 +
      (100 - base.factual_risk) * 0.04
  );

  return {
    idea_id: uuidv4(),
    ...idea,
    scores: base,
    notes: "Pontuação baseada em demanda, evergreen, retenção e risco factual.",
    total_score: total,
  };
};

const normalizeAiIdeas = (items = []) =>
  items.map((item) => {
    const scores = item.scores || {};
    const normalized = {
      search_demand: Number(scores.search_demand || 70),
      evergreen: Number(scores.evergreen || 70),
      retention: Number(scores.retention || 70),
      monetization: Number(scores.monetization || 70),
      visual_assets: Number(scores.visual_assets || 70),
      factual_risk: Number(scores.factual_risk || 15),
    };

    const total = Math.round(
      normalized.search_demand * 0.24 +
        normalized.evergreen * 0.2 +
        normalized.retention * 0.24 +
        normalized.monetization * 0.14 +
        normalized.visual_assets * 0.14 +
        (100 - normalized.factual_risk) * 0.04
    );

    return {
      idea_id: item.idea_id || uuidv4(),
      topic: item.topic,
      angle: item.angle,
      scores: normalized,
      notes: item.notes || "",
      total_score: total,
    };
  });

const generateIdeas = async ({ videoId, count = 5, mockMode = false }) => {
  const requested = Math.max(3, Math.min(5, Number(count || 5)));

  await sendWorkflowStatus({
    videoId,
    title: "Automação iniciada",
    icon: "🚀",
    lines: ["Gerando ideias e preparando a primeira aprovação no Telegram."],
  }).catch(() => null);

  let ideas = [];
  if (!mockMode) {
    const aiIdeas = await generateIdeasWithGemini({ count: requested, videoId });
    if (aiIdeas?.length) {
      ideas = normalizeAiIdeas(aiIdeas);
    }
  }

  if (!ideas.length) {
    ideas = fallbackIdeas.slice(0, requested).map(scoreIdea);
  }

  ideas = ideas.sort((a, b) => b.total_score - a.total_score).slice(0, requested);

  const state = await updateState(
    videoId,
    {
      ideas,
      status: "ideas_generated",
      current_step: "ideas_generated",
      selected_idea: null,
      approved: false,
      error_message: "",
      topic: ideas[0]?.topic || "",
      angle: ideas[0]?.angle || "",
    },
    { status: "ideas_generated", currentStep: "ideas_generated" }
  );

  const telegramResult = await sendTelegramMessage({
    text: buildIdeasApprovalMessage({ videoId, ideas }),
  }).catch((error) => ({ configured: true, sent: false, error: error.message }));

  const nextState = telegramResult.telegram_message_id
    ? await updateState(videoId, {
        telegram: {
          chat_id: String(config.TELEGRAM_CHAT_ID || ""),
          ideas_message_id: telegramResult.telegram_message_id,
          ideas_message_sent_at: new Date().toISOString(),
        },
      })
    : state;

  return {
    video_id: videoId,
    ideas,
    telegram: telegramResult,
    state_path: nextState.state_path,
    current_step: nextState.current_step,
  };
};

const approveIdea = async ({ videoId, ideaNumber, ideaId }) => {
  const state = await updateState(videoId, {}, {});
  const ideas = Array.isArray(state.ideas) ? state.ideas : [];

  let selected = null;
  if (ideaId) {
    selected = ideas.find((idea) => idea.idea_id === ideaId);
  } else if (ideaNumber) {
    selected = ideas[Number(ideaNumber) - 1];
  }

  if (!selected) {
    throw new Error("Ideia não encontrada para aprovação");
  }

  const next = await updateState(
    videoId,
    {
      idea_id: selected.idea_id,
      selected_idea: selected,
      topic: selected.topic,
      angle: selected.angle,
      approved: false,
      status: "idea_approved",
      current_step: "idea_approved",
      error_message: "",
    },
    { status: "idea_approved", currentStep: "idea_approved" }
  );

  return {
    video_id: videoId,
    selected_idea: selected,
    state_path: next.state_path,
    current_step: next.current_step,
  };
};

module.exports = {
  generateIdeas,
  approveIdea,
};
