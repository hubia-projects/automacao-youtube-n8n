const { inferVisualIntent } = require("./visualIntentService");

const CITY_ALIASES = [
  { city: "Lisboa", country: "Portugal", aliases: ["lisboa", "lisbon"], landmarks: ["Alfama", "Bairro Alto", "Torre de Belem", "Tejo", "Praca do Comercio", "Rossio", "Tram 28"] },
  { city: "Porto", country: "Portugal", aliases: ["porto", "oporto"], landmarks: ["Ribeira", "Douro", "Ponte Dom Luis", "Vila Nova de Gaia", "Livraria Lello"] },
  { city: "Sintra", country: "Portugal", aliases: ["sintra"], landmarks: ["Palacio da Pena", "Quinta da Regaleira", "Castelo dos Mouros"] },
  { city: "Faro", country: "Portugal", aliases: ["faro"], landmarks: ["Algarve", "Ria Formosa"] },
  { city: "Coimbra", country: "Portugal", aliases: ["coimbra"], landmarks: ["Universidade de Coimbra"] },
  { city: "Braga", country: "Portugal", aliases: ["braga"], landmarks: ["Bom Jesus"] },
  { city: "Madrid", country: "Spain", aliases: ["madrid"], landmarks: ["Plaza Mayor", "Retiro"] },
  { city: "Barcelona", country: "Spain", aliases: ["barcelona"], landmarks: ["Sagrada Familia", "Park Guell"] },
  { city: "Paris", country: "France", aliases: ["paris"], landmarks: ["Eiffel", "Louvre", "Montmartre"] },
  { city: "Roma", country: "Italy", aliases: ["roma", "rome"], landmarks: ["Colosseum", "Vatican"] },
  { city: "Londres", country: "United Kingdom", aliases: ["londres", "london"], landmarks: ["Big Ben", "Tower Bridge"] },
  { city: "Amsterdam", country: "Netherlands", aliases: ["amsterdam"], landmarks: ["Canals"] },
];

const LANDMARK_ALIASES = [
  { name: "Alfama", city: "Lisboa", aliases: ["alfama"] },
  { name: "Bairro Alto", city: "Lisboa", aliases: ["bairro alto"] },
  { name: "Torre de Belem", city: "Lisboa", aliases: ["torre de belem", "belem tower", "belem"] },
  { name: "Rio Tejo", city: "Lisboa", aliases: ["tejo", "tagus"] },
  { name: "Praca do Comercio", city: "Lisboa", aliases: ["praca do comercio", "commerce plaza", "terreiro do paco"] },
  { name: "Se de Lisboa", city: "Lisboa", aliases: ["se de lisboa", "catedral de lisboa", "lisbon cathedral"] },
  { name: "Castelo de Sao Jorge", city: "Lisboa", aliases: ["castelo de sao jorge", "castelo sao jorge", "sao jorge"] },
  { name: "Mosteiro dos Jeronimos", city: "Lisboa", aliases: ["mosteiro dos jeronimos", "jeronimos", "hieronymites"] },
  { name: "Elevador de Santa Justa", city: "Lisboa", aliases: ["elevador de santa justa", "santa justa"] },
  { name: "Padrao dos Descobrimentos", city: "Lisboa", aliases: ["padrao dos descobrimentos", "monument of discoveries", "padrao descobrimentos"] },
  { name: "Tram 28", city: "Lisboa", aliases: ["tram 28", "eletrico 28", "bonde 28"] },
  { name: "Ribeira", city: "Porto", aliases: ["ribeira"] },
  { name: "Rio Douro", city: "Porto", aliases: ["douro"] },
  { name: "Ponte Dom Luis", city: "Porto", aliases: ["dom luis", "dom luis i", "dom luis bridge", "ponte dom luis"] },
  { name: "Vila Nova de Gaia", city: "Porto", aliases: ["vila nova de gaia", "gaia"] },
  { name: "Se do Porto", city: "Porto", aliases: ["se do porto", "catedral do porto", "porto cathedral"] },
  { name: "Mercado do Bolhao", city: "Porto", aliases: ["mercado do bolhao", "bolhao"] },
  { name: "Torre dos Clerigos", city: "Porto", aliases: ["torre dos clerigos", "clerigos", "clerigos tower"] },
  { name: "Livraria Lello", city: "Porto", aliases: ["livraria lello", "lello"] },
  { name: "Estacao de Sao Bento", city: "Porto", aliases: ["estacao de sao bento", "sao bento", "estacao sao bento"] },
  { name: "Palacio da Pena", city: "Sintra", aliases: ["palacio da pena", "pena palace"] },
  { name: "Quinta da Regaleira", city: "Sintra", aliases: ["quinta da regaleira", "regaleira"] },
  { name: "Castelo dos Mouros", city: "Sintra", aliases: ["castelo dos mouros", "moorish castle"] },
  { name: "Algarve", city: "Faro", aliases: ["algarve"] },
  { name: "Ria Formosa", city: "Faro", aliases: ["ria formosa"] },
  { name: "Praia da Marinha", city: "Faro", aliases: ["praia da marinha", "marinha beach"] },
  { name: "Benagil", city: "Faro", aliases: ["benagil", "gruta de benagil", "benagil cave"] },
  { name: "Ponta da Piedade", city: "Faro", aliases: ["ponta da piedade", "piedade"] },
];

const SUBTHEME_PATTERNS = [
  { subtheme: "historic_center", label: "centro historico", pattern: /(centro historico|historic district|old town|ruas estreitas|alfama|bairro|cobblestone|azulej)/i },
  { subtheme: "architecture", label: "arquitetura", pattern: /(arquitetura|architecture|fachada|facade|predios|buildings|palacio|palace|castle|castelo)/i },
  { subtheme: "bridge", label: "ponte", pattern: /(ponte|bridge|dom luis)/i },
  { subtheme: "riverfront", label: "rio e margem", pattern: /(rio|river|waterfront|ribeira|douro|tejo|tagus|boats|barcos)/i },
  { subtheme: "beach", label: "praia", pattern: /(praia|beach|coast|coastline|litoral|mar|ocean|waves|cliffs|falesia)/i },
  { subtheme: "food", label: "gastronomia", pattern: /(gastronomia|comida|food|market|mercado|restaurant|vinho|wine|pastel|bacalhau|confeitaria|bakery|cafe|coffee)/i },
  { subtheme: "viewpoint", label: "miradouro", pattern: /(miradouro|viewpoint|skyline|panorama|rooftop|vista)/i },
  { subtheme: "transport", label: "transporte", pattern: /(tram|bonde|eletrico|train|comboio|metro|boat|barco)/i },
  { subtheme: "nature", label: "natureza", pattern: /(forest|floresta|mata|jardim|garden|hill|montanha|nature)/i },
  { subtheme: "market", label: "mercados e sabores", pattern: /(mercado|market|street food|barraca|stall|feira|food hall)/i },
  { subtheme: "wine_pastry", label: "vinhos e docaria", pattern: /(vinho|wine|port wine|doce|pastel|pastry|dessert|do[cç]aria|bakery|confeitaria)/i },
];

const SCRIPT_TERM_STOPWORDS = new Set([
  "a", "ao", "aos", "as", "com", "como", "da", "das", "de", "do", "dos", "e", "em", "foco", "local", "na", "nas", "no", "nos", "o", "os", "para", "por", "se", "sem", "um", "uma", "video", "visual", "travel", "footage", "scene", "cena", "que", "mais", "menos", "muito", "muita", "sobre", "entre",
]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round3 = (value) => Number(Number(value || 0).toFixed(3));
const unique = (values = []) => [...new Set(values.filter(Boolean))];

const normalizeLabel = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const tokenize = (value = "") =>
  normalizeLabel(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !SCRIPT_TERM_STOPWORDS.has(term));

const buildSemanticTerms = (values = []) => unique(tokenize(values.filter(Boolean).join(" ")));

const textIncludesAlias = (normalizedText, alias) => {
  const normalizedAlias = normalizeLabel(alias);
  if (!normalizedAlias) return false;
  const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i").test(normalizedText);
};

const isSameLocation = (left = "", right = "") => {
  const normalizedLeft = normalizeLabel(left);
  const normalizedRight = normalizeLabel(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  return CITY_ALIASES.some((entry) => {
    const aliases = [entry.city, ...entry.aliases].map(normalizeLabel);
    return aliases.includes(normalizedLeft) && aliases.includes(normalizedRight);
  });
};

const belongsToTopic = (value = "", topic = "") => {
  if (!value || !topic) return false;
  if (isSameLocation(value, topic)) return true;

  const landmark = LANDMARK_ALIASES.find((entry) => normalizeLabel(entry.name) === normalizeLabel(value));
  return landmark ? isSameLocation(landmark.city, topic) : false;
};

const detectLocation = (value = "", fallback = {}) => {
  if (fallback?.city) {
    return {
      city: fallback.city,
      country: fallback.country || "",
      confidence: Math.max(0.1, Number(fallback.confidence || 0.75)),
      source: "explicit",
    };
  }

  const normalized = normalizeLabel(value);
  let best = null;

  for (const entry of CITY_ALIASES) {
    for (const alias of entry.aliases) {
      if (textIncludesAlias(normalized, alias)) {
        const confidence = alias.length >= 6 ? 0.9 : 0.78;
        if (!best || confidence > best.confidence) {
          best = { city: entry.city, country: entry.country, confidence, matched_alias: alias, source: "alias" };
        }
      }
    }

    for (const landmark of entry.landmarks || []) {
      if (textIncludesAlias(normalized, landmark)) {
        const confidence = 0.86;
        if (!best || confidence > best.confidence) {
          best = { city: entry.city, country: entry.country, confidence, matched_alias: landmark, source: "landmark_city_hint" };
        }
      }
    }
  }

  return best || { city: "", country: "", confidence: 0, source: "unknown" };
};

const detectLandmarks = (value = "", explicitLandmarks = []) => {
  const normalized = normalizeLabel(value);
  const detected = [];

  (Array.isArray(explicitLandmarks) ? explicitLandmarks : []).forEach((item) => {
    const name = typeof item === "string" ? item : item?.name;
    if (!name) return;
    const match = LANDMARK_ALIASES.find((entry) => normalizeLabel(entry.name) === normalizeLabel(name));
    detected.push({
      name,
      city: match?.city || "",
      confidence: Math.max(0.1, Number(item?.confidence || 0.75)),
      source: "explicit",
    });
  });

  LANDMARK_ALIASES.forEach((entry) => {
    if (entry.aliases.some((alias) => textIncludesAlias(normalized, alias))) {
      detected.push({ name: entry.name, city: entry.city, confidence: 0.82, source: "alias" });
    }
  });

  const seen = new Set();
  return detected.filter((item) => {
    const key = normalizeLabel(`${item.name}:${item.city}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const detectSubtheme = (value = "") => SUBTHEME_PATTERNS.find((item) => item.pattern.test(value)) || { subtheme: "general", label: "geral" };

const inferSceneRole = ({ scene, index, totalScenes }) => {
  if (scene.narrative_function === "hook" || scene.narrative_function === "setup") return "intro";
  if (scene.narrative_function === "payoff" || scene.narrative_function === "closing") return "outro";
  const label = normalizeLabel(`${scene.title || ""} ${scene.narration_excerpt || ""}`);
  if (/abertura|intro|hook|visao geral|opening|overview/.test(label)) return "intro";
  if (/fechamento|encerramento|cta|sintese final|closing|outro|final/.test(label)) return "outro";
  if (index === 0 && totalScenes > 1 && !detectLocation(label).city) return "intro";
  if (index === totalScenes - 1 && totalScenes > 1 && !detectLocation(label).city) return "outro";
  return "body";
};

const buildBlockKeywords = (scene = {}, location = {}, subtheme = {}) =>
  unique([
    ...(scene.keywords || []),
    location.city,
    subtheme.label,
    ...buildSemanticTerms([scene.title, scene.narration_excerpt]).slice(0, 8),
  ]).slice(0, 12);

const buildWeightedBoundaryStarts = ({ scenes, audioDuration }) => {
  const weights = scenes.map((scene) => Math.max(1, Number(scene.target_duration_seconds || 0) || 1));
  const totalWeight = weights.reduce((acc, weight) => acc + weight, 0) || scenes.length || 1;
  const starts = [0];
  let cursor = 0;

  for (let index = 0; index < scenes.length - 1; index += 1) {
    cursor += (audioDuration * weights[index]) / totalWeight;
    starts.push(round3(cursor));
  }

  return starts;
};

const sceneBoundariesAreUsable = ({ scenes, sceneBoundaries, audioDuration }) => {
  if (!Array.isArray(sceneBoundaries) || sceneBoundaries.length < Math.max(2, scenes.length - 1)) return false;

  const minSceneSeconds = Math.max(2, Math.min(5, Number(audioDuration || 0) * 0.03));
  let previousStart = -Infinity;

  for (const scene of scenes) {
    const boundary = sceneBoundaries.find((item) => Number(item.scene_index || 0) === Number(scene.scene_index || 0));
    if (!boundary) return false;

    const start = Number(boundary.audio_start_seconds ?? boundary.start_seconds ?? boundary.start_sec);
    const end = Number(boundary.audio_end_seconds ?? boundary.end_seconds ?? boundary.end_sec);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (start < previousStart - 0.05) return false;
    if (end <= start) return false;
    if (end - start < minSceneSeconds && scenes.length > 2) return false;
    if (start < -0.05 || end > Number(audioDuration || 0) + 1) return false;

    previousStart = start;
  }

  return true;
};

const getBoundaryStart = ({ scene, index, totalScenes, sceneBoundaries, audioDuration }) => {
  const boundary = sceneBoundaries.find((item) => Number(item.scene_index || 0) === Number(scene.scene_index || 0));
  const boundaryStart = Number(boundary?.audio_start_seconds ?? boundary?.start_seconds ?? boundary?.start_sec);
  if (Number.isFinite(boundaryStart) && boundaryStart >= 0 && boundaryStart <= audioDuration) return boundaryStart;
  return (index * audioDuration) / Math.max(1, totalScenes);
};

const normalizeBoundaryStarts = ({ scenes, sceneBoundaries, audioDuration }) => {
  if (!scenes.length) return [0];

  if (!sceneBoundariesAreUsable({ scenes, sceneBoundaries, audioDuration })) {
    return buildWeightedBoundaryStarts({ scenes, audioDuration });
  }

  const starts = scenes.map((scene, index) => getBoundaryStart({ scene, index, totalScenes: scenes.length, sceneBoundaries, audioDuration }));
  starts[0] = 0;

  for (let i = 1; i < starts.length; i += 1) {
    const minStart = starts[i - 1] + 0.35;
    const maxStart = audioDuration - (scenes.length - i) * 0.35;
    starts[i] = clamp(Number.isFinite(starts[i]) ? starts[i] : minStart, minStart, Math.max(minStart, maxStart));
  }

  return starts.map(round3);
};

const buildFallbackScene = ({ state, audioDuration }) => ({
  scene_index: 1,
  title: state.topic || "Narracao principal",
  narration_excerpt: String(state.script_text || state.topic || "").slice(0, 280),
  keywords: buildSemanticTerms([state.topic, state.script_text]).slice(0, 8),
  target_duration_seconds: audioDuration,
});

const buildVisualRequirements = ({ role, subtheme, location, keywords = [] }) => {
  const requirements = [];
  if (location.city) requirements.push("location_specific");
  if (role === "intro") requirements.push("establishing_shot");
  if (role === "outro") requirements.push("closing_summary");
  if (subtheme.subtheme === "food") requirements.push("food_closeups", "market_life", "people_eating");
  if (subtheme.subtheme === "market") requirements.push("street_market", "stalls", "local_products");
  if (subtheme.subtheme === "wine_pastry") requirements.push("wine_cellar", "dessert_closeup", "cafe_scene");
  if (subtheme.subtheme === "riverfront") requirements.push("waterfront", "boats", "wide_city_view");
  if (subtheme.subtheme === "historic_center") requirements.push("street_life", "architecture", "walkthrough");
  return unique([...requirements, ...keywords.slice(0, 3)]).slice(0, 8);
};

const inferNarrativeFunction = ({ scene = {}, role = "body", index = 0, totalScenes = 1 }) => {
  if (scene.narrative_function) return scene.narrative_function;
  if (role === "intro") return index === 0 ? "hook" : "setup";
  if (role === "outro") return index === totalScenes - 1 ? "closing" : "payoff";
  if (index === 0) return "setup";
  if (index === totalScenes - 1) return "bridge";
  return "detail";
};

const buildBlockId = (label = "", index = 0) => {
  const slug = normalizeLabel(label).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `block-${index + 1}`;
  return slug;
};

const buildBoundaryId = ({ sceneOrder = 1, topic = "" }) =>
  `hb_${String(sceneOrder).padStart(3, "0")}_${buildBlockId(topic, Math.max(0, sceneOrder - 1))}`;

const buildNarrativeBlocks = ({ state = {}, audioIntelligence = null, audioDuration = 0 }) => {
  const scenes = Array.isArray(state.visual_plan) && state.visual_plan.length
    ? state.visual_plan
    : [buildFallbackScene({ state, audioDuration })];
  const sceneBoundaries = Array.isArray(audioIntelligence?.scene_boundaries) && audioIntelligence.scene_boundaries.length
    ? audioIntelligence.scene_boundaries
    : Array.isArray(state.scene_boundaries)
      ? state.scene_boundaries
      : [];
  const chapterTriggerBySceneIndex = new Map(
    (Array.isArray(audioIntelligence?.chapter_triggers) ? audioIntelligence.chapter_triggers : [])
      .map((trigger) => [Number(trigger.scene_index || 0), trigger])
  );
  const safeDuration = Math.max(1, Number(audioDuration || state.duration_seconds || 0) || 1);
  const starts = normalizeBoundaryStarts({ scenes, sceneBoundaries, audioDuration: safeDuration });

  const microBlocks = scenes.map((scene, index) => {
    const role = scene.role || inferSceneRole({ scene, index, totalScenes: scenes.length });
    const narrativeFunction = inferNarrativeFunction({ scene, role, index, totalScenes: scenes.length });
    const blockText = `${scene.title || ""} ${scene.narration_excerpt || ""} ${(scene.keywords || []).join(" ")}`;
    const location = detectLocation(blockText, scene.location);
    const landmarks = detectLandmarks(blockText, scene.landmarks);
    const subtheme = detectSubtheme(blockText);
    const startSec = starts[index] || 0;
    const endSec = index === scenes.length - 1 ? safeDuration : starts[index + 1];
    const hasExplicitLocation = Boolean(location.city);
    const macroTopic = hasExplicitLocation ? location.city : role === "intro" ? "Introducao" : role === "outro" ? "Fechamento" : (state.topic || "Tema geral");
    const keywords = buildBlockKeywords(scene, location, subtheme);
    const blockId = buildBlockId(macroTopic, index);
    const visualIntent = inferVisualIntent({
      scene: { ...scene, role },
      block: { label: scene.title || macroTopic, topic: macroTopic, subtheme: subtheme.subtheme, subtheme_label: subtheme.label, block_keywords: keywords, role },
      topic: state.topic || "",
    });

    return {
      id: `micro_${String(index + 1).padStart(3, "0")}`,
      level: "micro",
      block_id: blockId,
      scene_index: Number(scene.scene_index || index + 1),
      scene_order: index + 1,
      role,
      label: scene.title || macroTopic,
      topic: scene.title || macroTopic,
      macro_topic: macroTopic,
      block_label: macroTopic,
      type: hasExplicitLocation ? "city" : "general",
      topic_type: hasExplicitLocation ? "city" : "general",
      subtheme: subtheme.subtheme,
      subtheme_label: subtheme.label,
      start_sec: round3(startSec),
      end_sec: round3(Math.max(startSec + 0.25, endSec)),
      duration_sec: round3(Math.max(0.25, endSec - startSec)),
      start_seconds: round3(startSec),
      end_seconds: round3(Math.max(startSec + 0.25, endSec)),
      narration_excerpt: scene.narration_excerpt || "",
      script_excerpt: scene.narration_excerpt || "",
      keywords,
      block_keywords: keywords,
      landmarks,
      location,
      visual_requirements: buildVisualRequirements({ role, subtheme, location, keywords }),
      narrative_function: narrativeFunction,
      generic_tolerance: scene.generic_tolerance || (role === "intro" || role === "outro" ? "low" : "medium"),
      requires_visual_proof: scene.requires_visual_proof === true || narrativeFunction === "hook" || narrativeFunction === "proof" || narrativeFunction === "closing",
      slot_criticality: scene.slot_criticality || (role === "intro" || role === "outro" || index === 0 ? "high" : "medium"),
      probable_shot_role: scene.probable_shot_role || (narrativeFunction === "closing" ? "closing_payoff" : narrativeFunction === "hook" ? "hook_exact" : "proof_exact"),
      visual_intent: visualIntent.visual_intent,
      visual_intent_source: visualIntent.visual_intent_source,
      required_visual_evidence: visualIntent.required_visual_evidence,
      allowed_visual_categories: visualIntent.allowed_visual_categories,
      forbidden_visual_categories: visualIntent.forbidden_visual_categories,
      generic_asset_allowed: visualIntent.generic_asset_allowed,
      generic_asset_allowed_reason: visualIntent.generic_asset_allowed_reason,
      max_generic_establishing_seconds: visualIntent.max_generic_establishing_seconds,
      allowed_locations: hasExplicitLocation ? unique([location.city, ...((CITY_ALIASES.find((entry) => entry.city === location.city) || {}).aliases || [])]) : [],
      negative_keywords: [],
      forbidden_locations: [],
      hard_boundary: false,
      boundary_id: "",
      transition_type: "soft",
      expected_location: location.city || "",
      expected_visual_start_sec: round3(startSec),
      chapter_trigger: null,
      chapter_card_required: false,
      block_intro_asset: null,
      overlay_title: scene.overlay_title || "",
    };
  });

  const macroBlocks = [];
  let current = null;

  microBlocks.forEach((micro, index) => {
    const previous = microBlocks[index - 1];
    const isTopicChange = !previous || !isSameLocation(previous.macro_topic, micro.macro_topic);

    if (!current || isTopicChange) {
      const blockIndex = macroBlocks.length + 1;
      const macroHardBoundary = blockIndex > 1;
      current = {
        id: `macro_${String(blockIndex).padStart(3, "0")}`,
        block_id: buildBlockId(micro.macro_topic, blockIndex - 1),
        block_index: blockIndex,
        level: "macro",
        label: micro.macro_topic,
        topic: micro.macro_topic,
        type: micro.topic_type,
        topic_type: micro.topic_type,
        start_sec: micro.start_sec,
        end_sec: micro.end_sec,
        start_seconds: micro.start_sec,
        end_seconds: micro.end_sec,
        hard_boundary: macroHardBoundary,
        boundary_id: macroHardBoundary ? buildBoundaryId({ sceneOrder: micro.scene_order, topic: micro.macro_topic }) : "",
        transition_type: macroHardBoundary ? "hard" : "soft",
        expected_location: micro.location?.city || "",
        expected_visual_start_sec: round3(micro.start_sec),
        chapter_trigger: null,
        chapter_card_required: macroHardBoundary,
        block_intro_asset: macroHardBoundary
          ? {
              required: true,
              location: micro.location?.city || micro.macro_topic || "",
              query_hint: `${micro.location?.city || micro.macro_topic || "destination"} ${micro.subtheme_label || micro.subtheme || "city"} intro`,
            }
          : null,
        allowed_locations: [...micro.allowed_locations],
        forbidden_locations: [],
        keywords: [...micro.keywords],
        negative_keywords: [],
        overlay_title: `${blockIndex}. ${micro.macro_topic}`,
        children: [],
      };
      macroBlocks.push(current);
    }

    micro.parent_id = current.id;
    micro.parent_topic = current.topic;
    micro.block_id = current.block_id;
    micro.block_index = current.block_index;
    micro.block_label = current.label;
    micro.block_type = current.type;
    micro.overlay_title = micro.overlay_title || current.overlay_title;
    micro.hard_boundary = isTopicChange;
    micro.transition_type = isTopicChange ? "hard" : "soft";
    micro.boundary_id = isTopicChange ? buildBoundaryId({ sceneOrder: micro.scene_order, topic: micro.macro_topic }) : "";
    micro.expected_location = micro.location?.city || (micro.topic_type === "city" ? micro.macro_topic : "");
    micro.expected_visual_start_sec = round3(micro.start_sec);
    const sceneChapterTrigger = chapterTriggerBySceneIndex.get(Number(micro.scene_index || 0));
    micro.chapter_trigger = isTopicChange
      ? {
          detected: true,
          source: sceneChapterTrigger?.source || "topic_change",
          confidence: Number(sceneChapterTrigger?.confidence || 0.9),
          timestamp_sec: round3(sceneChapterTrigger?.timestamp_sec ?? micro.start_sec),
          anchor_word: sceneChapterTrigger?.anchor_word || "",
        }
      : null;
    micro.chapter_card_required = Boolean(isTopicChange);
    micro.block_intro_asset = isTopicChange
      ? {
          required: true,
          location: micro.expected_location || micro.macro_topic || "",
          query_hint: `${micro.expected_location || micro.macro_topic || "destination"} ${micro.subtheme_label || micro.subtheme || "city"} intro`,
        }
      : null;

    if (micro.hard_boundary) {
      current.boundary_id = micro.boundary_id;
      current.transition_type = "hard";
      current.expected_location = micro.expected_location;
      current.expected_visual_start_sec = micro.expected_visual_start_sec;
      current.chapter_trigger = micro.chapter_trigger;
      current.chapter_card_required = micro.chapter_card_required;
      current.block_intro_asset = micro.block_intro_asset;
    }

    current.children.push(micro);
    current.end_sec = micro.end_sec;
    current.end_seconds = micro.end_sec;
    current.allowed_locations = unique([...current.allowed_locations, ...micro.allowed_locations]);
    current.keywords = unique([...current.keywords, ...micro.keywords]).slice(0, 16);
  });

  // ===== País esperado: cada bloco herda o país da sua cidade; blocos sem
  // cidade herdam o país dominante do vídeo (para "Portugal", o vídeo
  // inteiro). Usado pelo gate geográfico fail-closed. =====
  const countryVotes = new Map();
  microBlocks.forEach((micro) => {
    const country = micro.location?.country || "";
    if (country) countryVotes.set(country, (countryVotes.get(country) || 0) + 1);
  });
  const dominantCountry = [...countryVotes.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";

  microBlocks.forEach((micro) => {
    micro.expected_country = micro.location?.country || dominantCountry;
  });
  macroBlocks.forEach((macro) => {
    macro.expected_country = macro.children[0]?.expected_country || dominantCountry;
  });

  // ===== Capítulos/overlays: numerar APÓS consolidação, apenas blocos de
  // cidade, com cap por duração. Tópicos genéricos ("Introducao",
  // "Fechamento", tema geral) não geram capítulo — elimina "5. Introducao"/
  // "8. Introducao" e numeração 17+ em vídeos curtos. =====
  const GENERIC_CHAPTER_TOPICS = new Set(["introducao", "fechamento", "tema geral", "geral", ""]);
  let chapterNumber = 0;

  macroBlocks.forEach((macro) => {
    const isGenericTopic = macro.topic_type !== "city" || GENERIC_CHAPTER_TOPICS.has(normalizeLabel(macro.topic));

    if (isGenericTopic) {
      // Suprime apenas o texto do overlay; mantém a estrutura de boundary
      // (chapter_card_required) para o pipeline continuar tratando como
      // mudança de tópico — só não desenhamos o card "X. Introducao".
      macro.overlay_title = "";
      macro.children.forEach((child) => {
        child.overlay_title = "";
      });
      return;
    }

    chapterNumber += 1;
    macro.overlay_title = `${chapterNumber}. ${macro.topic}`;
    macro.chapter_number = chapterNumber;
    macro.children.forEach((child) => {
      child.overlay_title = macro.overlay_title;
      child.chapter_number = chapterNumber;
    });
  });

  const cityTopics = macroBlocks.filter((item) => item.topic_type === "city").map((item) => item.topic);
  macroBlocks.forEach((macro) => {
    const otherTopics = cityTopics.filter((topic) => !isSameLocation(topic, macro.topic));
    macro.forbidden_locations = unique(otherTopics);
    macro.negative_keywords = unique(otherTopics.flatMap((topic) => {
      const cityEntry = CITY_ALIASES.find((entry) => isSameLocation(entry.city, topic));
      return [topic, ...(cityEntry?.aliases || [])];
    }));
    macro.children.forEach((child) => {
      child.forbidden_locations = unique(otherTopics);
      child.negative_keywords = unique([
        ...macro.negative_keywords,
        ...otherTopics,
      ]);
    });
  });

  return { macroBlocks, microBlocks };
};

const enrichVisualPlan = ({ topic = "", visualPlan = [], audioIntelligence = null, audioDuration = 0 }) => {
  const state = { topic, visual_plan: visualPlan, duration_seconds: audioDuration };
  const { macroBlocks, microBlocks } = buildNarrativeBlocks({ state, audioIntelligence, audioDuration });
  const bySceneIndex = new Map(microBlocks.map((block) => [Number(block.scene_index || 0), block]));

  return {
    visualPlan: visualPlan.map((scene) => {
      const block = bySceneIndex.get(Number(scene.scene_index || 0));
      if (!block) return scene;
      return {
        ...scene,
        block_id: block.block_id,
        block_index: block.block_index,
        block_label: block.block_label,
        block_type: block.block_type,
        block_keywords: block.block_keywords,
        negative_keywords: block.negative_keywords,
        overlay_title: block.overlay_title,
        visual_requirements: block.visual_requirements,
        narrative_function: block.narrative_function,
        generic_tolerance: block.generic_tolerance,
        requires_visual_proof: block.requires_visual_proof,
        slot_criticality: block.slot_criticality,
        probable_shot_role: block.probable_shot_role,
        role: block.role,
        scene_order: block.scene_order,
        location: block.location,
        landmarks: block.landmarks,
        subtheme: block.subtheme,
        visual_intent: block.visual_intent,
        visual_intent_source: block.visual_intent_source,
        required_visual_evidence: block.required_visual_evidence,
        allowed_visual_categories: block.allowed_visual_categories,
        forbidden_visual_categories: block.forbidden_visual_categories,
        generic_asset_allowed: block.generic_asset_allowed,
        generic_asset_allowed_reason: block.generic_asset_allowed_reason,
        max_generic_establishing_seconds: block.max_generic_establishing_seconds,
        hard_boundary: block.hard_boundary,
        boundary_id: block.boundary_id,
        transition_type: block.transition_type,
        expected_location: block.expected_location,
        expected_country: block.expected_country || "",
        expected_visual_start_sec: block.expected_visual_start_sec,
        chapter_trigger: block.chapter_trigger,
        chapter_card_required: block.chapter_card_required,
        block_intro_asset: block.block_intro_asset,
      };
    }),
    macroBlocks,
    microBlocks,
  };
};

module.exports = {
  CITY_ALIASES,
  LANDMARK_ALIASES,
  buildSemanticTerms,
  buildNarrativeBlocks,
  detectLandmarks,
  detectLocation,
  detectSubtheme,
  enrichVisualPlan,
  inferSceneRole,
  isSameLocation,
  belongsToTopic,
  normalizeLabel,
  sceneBoundariesAreUsable,
  buildWeightedBoundaryStarts,
  __test__: {
    buildNarrativeBlocks,
    detectLandmarks,
    detectLocation,
    detectSubtheme,
    enrichVisualPlan,
    inferSceneRole,
    isSameLocation,
    belongsToTopic,
    normalizeLabel,
    sceneBoundariesAreUsable,
    buildWeightedBoundaryStarts,
  },
};
