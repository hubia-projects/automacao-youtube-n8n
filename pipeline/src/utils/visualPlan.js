const { enrichVisualPlan } = require("../services/narrativeBlockPlanner");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const stripAccents = (value = "") =>
  String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const normalizeText = (value = "") => stripAccents(value).trim();
const unique = (values = []) => [...new Set(values.filter(Boolean))];

const sentenceSplit = (value = "") =>
  normalizeText(value)
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);

const paragraphSplit = (value = "") =>
  String(value || "")
    .replace(/\r/g, "")
    .split(/\n\s*\n+/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
        .trim()
    )
    .filter(Boolean);

const wordCount = (value = "") =>
  normalizeText(value)
    .split(/\s+/)
    .filter(Boolean).length;

const entityNoiseWords = new Set([
  "a", "abertura", "agora", "ao", "aos", "as", "comente", "com", "contexto", "da", "das", "de", "depois", "do", "dos", "durante", "e", "ela", "ele", "em", "encerramento", "essa", "esse", "esta", "este", "fechamento", "ha", "hoje", "hook", "imperdiveis", "intro", "mais", "na", "nas", "no", "nos", "o", "obrigado", "os", "ou", "para", "panorama", "se", "sem", "top", "transicao", "tens", "um", "uma", "vamos",
]);
const entityConnectorWords = new Set(["da", "das", "de", "do", "dos", "e"]);

const entityKeywordAliases = new Map([
  ["alfama", ["alfama district"]],
  ["algarve", ["algarve coast", "algarve"]],
  ["bairro alto", ["bairro alto", "historic district"]],
  ["dom luis i", ["dom luis bridge"]],
  ["douro", ["douro river"]],
  ["faro", ["faro portugal", "algarve"]],
  ["lisboa", ["lisbon", "lisboa"]],
  ["porto", ["porto portugal", "porto"]],
  ["ribeira", ["ribeira porto"]],
  ["tejo", ["tagus river"]],
  ["vila nova de gaia", ["vila nova de gaia"]],
]);

const narrativeThemeMatchers = [
  [/(tres cidades|identidade|algo especial|explorar portugal)/, "visao geral"],
  [/(ponto de partida|cidade cheia de vida|moderno e o historico)/, "energia urbana"],
  [/(alfama|bairro alto|ruas estreitas|casas tipicas|autentica)/, "bairros historicos"],
  [/(miradouro|miradouros|tejo|panorama|vista)/, "miradouros e skyline"],
  [/(comida local|gastronomia|mercado|restaurante|food)/, "comida local"],
  [/(noite|energia|bars?|vida noturna)/, "vida noturna"],
  [/(vibe completamente diferente|mais a norte|atmosfera diferente)/, "identidade propria"],
  [/(calmo|intimista|presenca muito forte)/, "ambiente intimista"],
  [/(ribeira|douro|reflexo na agua|rio)/, "ribeira e douro"],
  [/(ponte|pontes|dom luis|bridge)/, "pontes e skyline"],
  [/(vinho|caves|gaia)/, "vinho e caves"],
  [/(faro|algarve|praia|praias|ilha|ilhas|litoral)/, "praias e ilhas"],
  [/(centro historico|tranquila|organizado)/, "centro historico"],
  [/(sol|verao|relaxar|desligar)/, "sol e relax"],
  [/(melhor que portugal tem para oferecer|experiencias completamente diferentes)/, "sintese final"],
  [/(mercado|mercados|street food|sabores|petiscos|food hall)/, "mercados e sabores"],
  [/(vinho|doce|docaria|pastry|pastel|confeitaria|sobremesa)/, "vinhos e docaria"],
];

const cleanToken = (value = "") => value.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const titleCase = (value = "") =>
  String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

const extractEntityPhrases = (value = "", limit = 5) => {
  const tokens = String(value || "").replace(/\r/g, " ").split(/\s+/);
  const phrases = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    const phraseParts = current
      .map(cleanToken)
      .filter(Boolean)
      .filter((part, index, list) => !(index === list.length - 1 && entityConnectorWords.has(normalizeText(part).toLowerCase())));
    const phrase = phraseParts.join(" ").trim();
    current = [];
    if (!phrase || wordCount(phrase) > 4) return;
    const normalizedPhrase = normalizeText(phrase).toLowerCase();
    const phraseWords = normalizedPhrase.split(/\s+/).filter(Boolean);
    if (!phraseWords.length) return;
    if (phraseWords.every((word) => entityNoiseWords.has(word))) return;
    phrases.push(phrase);
  };

  tokens.forEach((rawToken) => {
    const token = cleanToken(rawToken);
    if (!token) {
      flush();
      return;
    }
    const normalizedToken = normalizeText(token).toLowerCase();
    const isConnector = entityConnectorWords.has(normalizedToken);
    const isCapitalized = /^\p{Lu}/u.test(token);

    if (isCapitalized && !entityNoiseWords.has(normalizedToken)) {
      current.push(token);
      return;
    }
    if (isConnector && current.length) {
      current.push(token);
      return;
    }
    flush();
  });

  flush();
  return unique(phrases).slice(0, limit);
};

const expandEntityKeywords = (entities = []) => {
  const keywords = [];
  entities.forEach((entity) => {
    const normalizedEntity = normalizeText(entity).toLowerCase();
    const mappedKeywords = entityKeywordAliases.get(normalizedEntity) || [normalizedEntity];
    mappedKeywords.forEach((keyword) => {
      const normalizedKeyword = normalizeText(keyword).toLowerCase();
      if (normalizedKeyword && !keywords.includes(normalizedKeyword)) keywords.push(normalizedKeyword);
    });
  });
  return keywords;
};

const getTopicAnchor = (topic = "") => {
  const entities = extractEntityPhrases(topic, 1);
  if (entities.length) return entities[0];
  const normalizedTopic = String(topic || "").trim();
  if (!normalizedTopic) return "";
  return titleCase(normalizedTopic.split(/\s+/).slice(0, 2).join(" "));
};

const inferSectionType = ({ title = "", body = "", index = 0, totalSections = 1 }) => {
  const normalized = normalizeText(`${title} ${body}`).toLowerCase();
  if (/intro|abertura|hook|contexto/.test(normalized)) return "intro";
  if (/fechamento|conclusao|cta|encerramento/.test(normalized)) return "outro";
  if (index === 0 && /(tens de conhecer|explorar|tres cidades|algo especial)/.test(normalized)) return "intro";
  if (index === totalSections - 1 && (wordCount(body) <= 26 || /(melhor que portugal tem para oferecer|experiencias completamente diferentes)/.test(normalized))) {
    return "outro";
  }
  return "body";
};

const inferNarrativeTheme = (value = "", sectionType = "body") => {
  const normalized = normalizeText(value).toLowerCase();
  for (const [pattern, theme] of narrativeThemeMatchers) {
    if (pattern.test(normalized)) return theme;
  }
  if (sectionType === "intro") return "abertura";
  if (sectionType === "outro") return "encerramento";
  return "";
};

const buildSectionTitle = ({ body = "", topic = "", sectionType = "body", index = 0 }) => {
  const topicAnchor = getTopicAnchor(topic) || `Cena ${index + 1}`;
  const entities = extractEntityPhrases(body, 4);
  const sectionAnchor = entities[0] || topicAnchor;
  if (sectionType === "intro") return `Abertura em ${topicAnchor}`;
  if (sectionType === "outro") return `Fechamento em ${topicAnchor}`;
  return sectionAnchor;
};

const buildChunkTitle = ({ sectionTitle = "", chunk = "", chunkIndex = 0, totalChunks = 1, sectionType = "body" }) => {
  const theme = inferNarrativeTheme(chunk, sectionType);
  if (theme && !["abertura", "encerramento"].includes(theme)) return `${sectionTitle}: ${theme}`;
  if (totalChunks > 1 && sectionType === "body") return `${sectionTitle} ${chunkIndex + 1}`;
  return sectionTitle;
};

const guessSectionKeywords = (title = "") => {
  const normalized = normalizeText(title).toLowerCase();
  if (/intro|abertura|hook|contexto/.test(normalized)) return ["aerial view", "travel destination", "city skyline", "landscape"];
  if (/custo|orcamento|budget|logistica|transporte|planejamento/.test(normalized)) return ["budget travel", "public transport", "street market", "city street"];
  if (/ponto|lugar|ranking|imperdiveis|atracoes|atra[cç][aã]o/.test(normalized)) return ["tourist attraction", "landmark", "historic district", "cityscape"];
  if (/fechamento|conclusao|cta|encerramento/.test(normalized)) return ["sunset skyline", "packing checklist", "travel planning", "city lights"];
  if (/praia|ilhas|litoral|algarve/.test(normalized)) return ["beach aerial", "coastline", "ocean cliffs", "travel lifestyle"];
  if (/porto|ribeira|douro|ponte/.test(normalized)) return ["river view", "waterfront", "bridge aerial", "historic district"];
  if (/lisboa|lisbon|miradouro|bairro/.test(normalized)) return ["city skyline", "historic district", "street life", "scenic viewpoint"];
  if (/mercado|gastronomia|sabores|food|cafe|vinho|docaria/.test(normalized)) return ["food market", "local food", "cafe scene", "wine tasting"];
  return ["travel destination", "street life", "local culture", "landscape"];
};

const phraseTranslations = [
  [/tomadas? aereas?|vista aerea|aerial/, "aerial view"],
  [/mapa|map/, "travel map"],
  [/paisagem|paisagens|landscape/, "landscape"],
  [/cidade|cidades|city/, "city skyline"],
  [/praia|beach/, "beach"],
  [/montanha|mountain/, "mountain"],
  [/ilha|island/, "island"],
  [/mercado|market/, "street market"],
  [/comida|food|restaurante|cafe/, "local food"],
  [/transporte|onibus|metro|trem|publico/, "public transport"],
  [/rua|ruas|street/, "street life"],
  [/bairro|district/, "historic district"],
  [/miradouro|miradouros|viewpoint/, "scenic viewpoint"],
  [/tejo|tagus/, "tagus river"],
  [/douro/, "douro river"],
  [/ponte|pontes|bridge/, "bridge aerial"],
  [/vinho|caves|wine/, "wine cellar"],
  [/algarve|litoral|coast/, "coastline"],
  [/hotel|hostel|acomodacao/, "hotel exterior"],
  [/templo|igreja|museu|castelo|monumento/, "landmark"],
  [/custo|orcamento|preco|barato|economico/, "budget travel"],
  [/natureza|parque|jardim|floresta/, "nature"],
  [/porto|marina|rio|lago/, "waterfront"],
  [/ranking|top|imperdiveis/, "tourist attraction"],
  [/checklist|planejamento|guia/, "travel planning"],
  [/sol|por do sol|sunset/, "sunset skyline"],
  [/pastel|doc[eç]aria|confeitaria|sobremesa/, "pastry shop"],
];

const fallbackKeywords = ["travel destination", "city skyline", "street life", "local culture", "landscape", "tourist attraction", "public transport", "budget travel"];

const buildSceneKeywords = ({ title, narrationExcerpt, topic, shots = [], entities = [], sectionType = "body" }) => {
  const pool = [title, narrationExcerpt, topic, ...(shots || [])].filter(Boolean).join(" ");
  const normalizedPool = normalizeText(pool).toLowerCase();
  const keywords = [];

  expandEntityKeywords([...entities, ...extractEntityPhrases(`${title} ${narrationExcerpt}`, 4), ...extractEntityPhrases(topic, 2)]).forEach((keyword) => {
    if (!keywords.includes(keyword)) keywords.push(keyword);
  });
  phraseTranslations.forEach(([pattern, keyword]) => {
    if (pattern.test(normalizedPool) && !keywords.includes(keyword)) keywords.push(keyword);
  });
  guessSectionKeywords(sectionType === "body" ? title : `${sectionType} ${title}`).forEach((keyword) => {
    if (!keywords.includes(keyword)) keywords.push(keyword);
  });
  fallbackKeywords.forEach((keyword) => {
    if (!keywords.includes(keyword)) keywords.push(keyword);
  });

  return keywords.slice(0, 5);
};

const createSection = ({ title = "", body = "", topic = "", index = 0, totalSections = 1 }) => {
  const sectionType = inferSectionType({ title, body, index, totalSections });
  const nextTitle = title?.trim() || buildSectionTitle({ body, topic, sectionType, index });
  return {
    title: nextTitle,
    body,
    section_type: sectionType,
    entities: extractEntityPhrases(`${nextTitle} ${body}`, 4),
  };
};

const splitScriptIntoSections = ({ topic = "", scriptText = "", outlineSections = [] }) => {
  const lines = String(scriptText || "").replace(/\r/g, "").split("\n");
  const sections = [];
  let current = null;

  lines.forEach((line) => {
    const headingMatch = line.match(/^##+\s+(.*)$/);
    if (headingMatch) {
      if (current && current.body.length) sections.push({ ...current, body: current.body.join(" ").trim() });
      current = { title: headingMatch[1].trim(), body: [] };
      return;
    }
    if (current) current.body.push(line.trim());
  });

  if (current && current.body.length) sections.push({ ...current, body: current.body.join(" ").trim() });
  if (sections.length) {
    return sections.filter((section) => section.body).map((section, index, list) => createSection({ title: section.title, body: section.body, topic, index, totalSections: list.length }));
  }

  const paragraphs = paragraphSplit(scriptText);
  if (paragraphs.length > 1) {
    if (outlineSections.length === paragraphs.length) {
      return paragraphs.map((body, index) => createSection({ title: outlineSections[index]?.title || "", body, topic, index, totalSections: paragraphs.length }));
    }
    return paragraphs.map((body, index) => createSection({ title: "", body, topic, index, totalSections: paragraphs.length }));
  }

  const sentences = sentenceSplit(scriptText);
  if (!sentences.length) return [];
  if (outlineSections.length) {
    const sectionCount = outlineSections.length;
    const chunkSize = Math.max(1, Math.ceil(sentences.length / sectionCount));
    return outlineSections.map((section, index) => createSection({ title: section?.title || `Cena ${index + 1}`, body: sentences.slice(index * chunkSize, (index + 1) * chunkSize).join(" ").trim(), topic, index, totalSections: sectionCount })).filter((section) => section.body);
  }
  return [createSection({ title: "", body: sentences.join(" "), topic, index: 0, totalSections: 1 })];
};

const chunkSectionBody = (body = "", targetWords = 18) => {
  const sentences = sentenceSplit(body);
  if (!sentences.length) return [];
  const chunks = [];
  let current = [];
  let currentWords = 0;

  sentences.forEach((sentence) => {
    const count = wordCount(sentence);
    if (current.length && currentWords + count > targetWords) {
      chunks.push(current.join(" ").trim());
      current = [sentence];
      currentWords = count;
      return;
    }
    current.push(sentence);
    currentWords += count;
  });
  if (current.length) chunks.push(current.join(" ").trim());
  return chunks;
};

const matchShotsForSection = (sectionTitle = "", visualSuggestions = []) => {
  const normalizedTitle = normalizeText(sectionTitle).toLowerCase();
  const match = (visualSuggestions || []).find((item) => {
    const suggestionTitle = normalizeText(item?.section || "").toLowerCase();
    return suggestionTitle && (suggestionTitle === normalizedTitle || normalizedTitle.includes(suggestionTitle));
  });
  return Array.isArray(match?.shots) ? match.shots : [];
};

const buildVisualPlan = ({ topic = "", scriptText = "", outlineSections = [], visualSuggestions = [], durationSeconds = 0, audioIntelligence = null }) => {
  const sections = splitScriptIntoSections({ topic, scriptText, outlineSections });
  if (!sections.length) return [];

  const estimatedDurationSeconds = Math.max(30, Number(durationSeconds || 0) || Math.round(wordCount(scriptText) / 2.4));
  const scenes = [];

  sections.forEach((section) => {
    const shots = matchShotsForSection(section.title, visualSuggestions);
    const chunks = chunkSectionBody(section.body, 18);

    chunks.forEach((chunk, chunkIndex) => {
      const chunkWords = wordCount(chunk);
      const targetDuration = clamp(Number((chunkWords / 2.4).toFixed(2)), 4, 8);
      const title = buildChunkTitle({ sectionTitle: section.title, chunk, chunkIndex, totalChunks: chunks.length, sectionType: section.section_type });
      scenes.push({
        scene_index: scenes.length + 1,
        title,
        narration_excerpt: chunk.slice(0, 220),
        keywords: buildSceneKeywords({ title, narrationExcerpt: chunk, topic, shots, entities: section.entities, sectionType: section.section_type }).slice(0, 5),
        target_duration_seconds: targetDuration,
      });
    });
  });

  if (!scenes.length) return [];
  const totalTarget = scenes.reduce((acc, scene) => acc + scene.target_duration_seconds, 0);
  const scale = totalTarget > 0 ? estimatedDurationSeconds / totalTarget : 1;
  const scaledScenes = scenes.map((scene) => ({
    ...scene,
    target_duration_seconds: clamp(Number((scene.target_duration_seconds * scale).toFixed(2)), 4, 8),
  }));

  return enrichVisualPlan({
    topic,
    visualPlan: scaledScenes,
    audioIntelligence,
    audioDuration: estimatedDurationSeconds,
  }).visualPlan;
};

module.exports = {
  buildVisualPlan,
};
