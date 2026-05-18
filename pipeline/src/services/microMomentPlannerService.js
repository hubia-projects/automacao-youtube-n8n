const MIN_MICRO_SECONDS = 1.8;
const MAX_MICRO_SECONDS = 4.5;
const DEFAULT_MERGE_GAP_SECONDS = 0.35;
const PROOF_VISUAL_NEEDS = new Set([
  "market_stall",
  "vendor_interaction",
  "people_eating",
  "pastry_closeup",
  "food_closeup",
  "wine_pouring",
  "restaurant_table",
]);

const unique = (values = []) => [...new Set((values || []).filter(Boolean))];
const round3 = (value) => Number(Number(value || 0).toFixed(3));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalize = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const tokenize = (value = "") =>
  normalize(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3);

const ACTION_TOKENS = [
  "comer", "comendo", "eat", "eating", "provar", "provarmos", "taste", "tasting",
  "servir", "servindo", "serve", "serving", "comprar", "comprando", "buy", "buying",
  "cozinhar", "cozinhando", "cook", "cooking", "preparar", "preparing", "pour", "pouring",
  "caminhar", "walk", "walking", "mostrar", "show", "showing", "visitar", "visit", "visiting",
];

const ENTITY_NEED_RULES = [
  { need: "market_stall", pattern: /(mercado|market|banca|stall|feira|food hall)/i, roles: ["proof_exact", "context_regional"] },
  { need: "vendor_interaction", pattern: /(vendedor|vendor|atendente|atendimento|servindo|servir)/i, roles: ["proof_exact", "detail_cutaway"] },
  { need: "people_eating", pattern: /(pessoas comendo|people eating|a comer|degustando|tasting)/i, roles: ["proof_exact", "detail_cutaway"] },
  { need: "pastry_closeup", pattern: /(doces|pastel|pastry|sobremesa|dessert|confeitaria|bakery)/i, roles: ["proof_exact", "detail_cutaway"] },
  { need: "food_closeup", pattern: /(comida|food|prato|dish|ingrediente|fresco|fresh produce)/i, roles: ["proof_exact", "detail_cutaway"] },
  { need: "wine_pouring", pattern: /(vinho|wine|taça|glass|pour|pouring|brinde|toasting)/i, roles: ["proof_exact", "closing_payoff"] },
  { need: "restaurant_table", pattern: /(restaurante|restaurant|mesa|table|cafe|coffee shop)/i, roles: ["proof_exact", "detail_cutaway"] },
  { need: "street_level", pattern: /(rua|street|bairro|centro|downtown|walking)/i, roles: ["context_regional", "opening_establishing"] },
  { need: "landmark", pattern: /(ponte|bridge|torre|tower|rio|river|catedral|palacio|palace|landmark)/i, roles: ["opening_establishing", "context_regional"] },
];

const buildActionTokens = (text = "") => {
  const tokens = tokenize(text);
  return unique(tokens.filter((token) => ACTION_TOKENS.includes(token)));
};

const pickVisualNeed = ({ text = "", scene = {} }) => {
  const source = `${text} ${scene.visual_intent || ""} ${scene.subtheme || ""}`;
  for (const rule of ENTITY_NEED_RULES) {
    if (rule.pattern.test(source)) {
      return {
        visual_need: rule.need,
        target_roles: rule.roles,
      };
    }
  }

  const intent = normalize(scene.visual_intent || "");
  if (["gastronomy", "market", "pastry", "restaurant", "cafe", "street_food"].includes(intent)) {
    return { visual_need: "food_closeup", target_roles: ["proof_exact", "detail_cutaway"] };
  }
  if (intent === "wine") return { visual_need: "wine_pouring", target_roles: ["proof_exact", "closing_payoff"] };
  return { visual_need: "street_level", target_roles: ["context_regional", "detail_cutaway"] };
};

const isHardSemanticBoundary = ({ prev = null, next = null }) => {
  if (!prev || !next) return false;
  const prevText = normalize(prev.word || "");
  const nextText = normalize(next.word || "");
  if (!prevText || !nextText) return false;
  if (/[.!?:;]$/.test(String(prev.word || ""))) return true;
  const pivotWords = ["agora", "depois", "seguindo", "enquanto", "entao", "next", "now", "then"];
  if (pivotWords.includes(nextText)) return true;
  const actionShift = ACTION_TOKENS.includes(prevText) !== ACTION_TOKENS.includes(nextText);
  return actionShift;
};

const buildFallbackWordsFromSegments = (segments = []) =>
  (segments || []).flatMap((segment = {}) => {
    const text = String(segment.text || "").trim();
    if (!text) return [];
    const tokens = text.split(/\s+/).filter(Boolean);
    const start = Number(segment.start || 0);
    const end = Math.max(start + 0.1, Number(segment.end || start + 1));
    const step = (end - start) / Math.max(1, tokens.length);
    return tokens.map((word, index) => ({
      word,
      start: round3(start + (index * step)),
      end: round3(start + ((index + 1) * step)),
      confidence: Number(segment.confidence || 0.5),
      synthetic: true,
    }));
  });

const buildDerivedSceneBoundaries = ({ visualPlan = [], durationSeconds = 0 } = {}) => {
  if (!Array.isArray(visualPlan) || !visualPlan.length) return [];
  const safeDuration = Math.max(1, Number(durationSeconds || 0));
  const durations = visualPlan.map((scene = {}) =>
    Math.max(0.2, Number(scene.target_duration_seconds || scene.duration_seconds || 0))
  );
  const totalPlanned = durations.reduce((acc, value) => acc + value, 0);
  const normalized = totalPlanned > 0 ? durations : visualPlan.map(() => 1);
  const normalizedTotal = normalized.reduce((acc, value) => acc + value, 0);
  let cursor = 0;
  return visualPlan.map((scene = {}, index) => {
    const weight = Number(normalized[index] || 1) / Math.max(1, normalizedTotal);
    const slotDuration = index === visualPlan.length - 1
      ? Math.max(0.2, safeDuration - cursor)
      : Math.max(0.2, safeDuration * weight);
    const start = round3(cursor);
    const end = round3(Math.min(safeDuration, cursor + slotDuration));
    cursor = end;
    return {
      scene_index: Number(scene.scene_index || index + 1),
      audio_start_seconds: start,
      audio_end_seconds: end,
    };
  });
};

const buildMicroSegmentsFromAudio = ({
  words = [],
  segments = [],
  pauseMarkers = [],
  minSeconds = MIN_MICRO_SECONDS,
  maxSeconds = MAX_MICRO_SECONDS,
  mergeGapSeconds = DEFAULT_MERGE_GAP_SECONDS,
} = {}) => {
  const safeWords = Array.isArray(words) && words.length ? words : buildFallbackWordsFromSegments(segments);
  if (!safeWords.length) return [];

  const pauses = Array.isArray(pauseMarkers) ? pauseMarkers : [];
  const pauseStarts = pauses.map((pause) => Number(pause.start || 0));
  const micro = [];
  let cursor = 0;
  let microIndex = 0;

  const shouldBreakAtIndex = (index = 0, startSec = 0) => {
    if (index <= cursor) return false;
    const current = safeWords[index];
    const previous = safeWords[index - 1];
    const span = Number(current.end || current.start || 0) - Number(startSec || 0);
    if (span < minSeconds) return false;
    if (span >= maxSeconds) return true;
    const nearPause = pauseStarts.some((pauseStart) => Math.abs(Number(current.end || 0) - pauseStart) <= 0.25);
    if (nearPause) return true;
    return isHardSemanticBoundary({ prev: previous, next: current });
  };

  while (cursor < safeWords.length) {
    const startWord = safeWords[cursor];
    const startSec = Number(startWord.start || 0);
    let endIndex = Math.min(safeWords.length - 1, cursor + 1);

    while (endIndex < safeWords.length - 1 && !shouldBreakAtIndex(endIndex, startSec)) {
      endIndex += 1;
    }

    const chunkWords = safeWords.slice(cursor, endIndex + 1);
    const endSec = Number(chunkWords[chunkWords.length - 1]?.end || startSec + minSeconds);
    const text = chunkWords.map((item) => item.word).filter(Boolean).join(" ").trim();
    const actionTokens = buildActionTokens(text);
    const tokenSet = tokenize(text);

    microIndex += 1;
    micro.push({
      micro_id: `mic_${String(microIndex).padStart(4, "0")}`,
      start_sec: round3(startSec),
      end_sec: round3(Math.max(startSec + 0.2, endSec)),
      duration_sec: round3(Math.max(0.2, endSec - startSec)),
      text_excerpt: text,
      action_tokens: actionTokens,
      semantic_tokens: tokenSet.slice(0, 12),
      boundary_reason: actionTokens.length ? "semantic_action_shift" : "pause_or_duration",
    });

    cursor = endIndex + 1;
  }

  const merged = [];
  for (const segment of micro) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push(segment);
      continue;
    }
    const gap = Number(segment.start_sec || 0) - Number(previous.end_sec || 0);
    const mergedDuration = Number(segment.end_sec || 0) - Number(previous.start_sec || 0);
    if ((gap <= mergeGapSeconds && previous.duration_sec < minSeconds) || mergedDuration < minSeconds) {
      previous.end_sec = round3(Math.max(previous.end_sec, segment.end_sec));
      previous.duration_sec = round3(previous.end_sec - previous.start_sec);
      previous.text_excerpt = `${previous.text_excerpt} ${segment.text_excerpt}`.trim();
      previous.action_tokens = unique([...(previous.action_tokens || []), ...(segment.action_tokens || [])]);
      previous.semantic_tokens = unique([...(previous.semantic_tokens || []), ...(segment.semantic_tokens || [])]).slice(0, 16);
      continue;
    }
    merged.push(segment);
  }

  return merged.map((segment, index) => ({
    ...segment,
    micro_id: `mic_${String(index + 1).padStart(4, "0")}`,
    start_sec: round3(segment.start_sec),
    end_sec: round3(segment.end_sec),
    duration_sec: round3(Math.max(0.2, Number(segment.end_sec || 0) - Number(segment.start_sec || 0))),
  }));
};

const findSceneForMicro = ({ microSegment = {}, sceneBoundaries = [], visualPlan = [] }) => {
  const midpoint = (Number(microSegment.start_sec || 0) + Number(microSegment.end_sec || 0)) / 2;
  const boundaryMatch = (sceneBoundaries || []).find((boundary) =>
    midpoint >= Number(boundary.audio_start_seconds || boundary.start_seconds || 0) - 0.001
    && midpoint < Number(boundary.audio_end_seconds || boundary.end_seconds || Number.MAX_SAFE_INTEGER)
  );
  if (boundaryMatch) {
    const sceneIndex = Number(boundaryMatch.scene_index || 0);
    const scene = (visualPlan || []).find((item) => Number(item.scene_index || 0) === sceneIndex);
    if (scene) return scene;
  }
  return (visualPlan || []).find((scene) =>
    midpoint >= Number(scene.audio_start_seconds || scene.start_seconds || 0) - 0.001
    && midpoint < Number(scene.audio_end_seconds || scene.end_seconds || Number.MAX_SAFE_INTEGER)
  ) || null;
};

const buildMicroVisualPlan = ({
  audioIntelligence = null,
  visualPlan = [],
  durationSeconds = 0,
} = {}) => {
  const sceneBoundaries = Array.isArray(audioIntelligence?.scene_boundaries) ? audioIntelligence.scene_boundaries : [];
  const baseSegments = Array.isArray(audioIntelligence?.micro_segments) && audioIntelligence.micro_segments.length
    ? audioIntelligence.micro_segments
    : buildMicroSegmentsFromAudio({
        words: audioIntelligence?.words || [],
        segments: audioIntelligence?.segments || [],
        pauseMarkers: audioIntelligence?.pause_markers || [],
      });

  const safeDuration = Math.max(1, Number(durationSeconds || audioIntelligence?.speaking_rate?.total_duration_seconds || 0));
  const derivedBoundaries = buildDerivedSceneBoundaries({
    visualPlan,
    durationSeconds: safeDuration,
  });
  const effectiveSceneBoundaries = sceneBoundaries.length ? sceneBoundaries : derivedBoundaries;
  const plan = [];
  baseSegments.forEach((segment, index) => {
    const startSec = clamp(Number(segment.start_sec || segment.start || 0), 0, safeDuration);
    const endSec = clamp(Number(segment.end_sec || segment.end || startSec + 0.5), startSec + 0.2, safeDuration);
    const scene = findSceneForMicro({
      microSegment: { ...segment, start_sec: startSec, end_sec: endSec },
      sceneBoundaries: effectiveSceneBoundaries,
      visualPlan,
    }) || visualPlan.find((item) => Number(item.scene_index || 0) === Number((visualPlan[0] || {}).scene_index || 1)) || {};
    const textExcerpt = String(segment.text_excerpt || segment.text || "").trim();
    const { visual_need: visualNeed, target_roles: targetRoles } = pickVisualNeed({ text: textExcerpt, scene });
    const roleRequiresProof = targetRoles.some((role) => ["proof_exact", "hook_exact", "closing_payoff"].includes(role));
    const needsVisualProof = Boolean(
      scene.requires_visual_proof === true
      || roleRequiresProof
      || PROOF_VISUAL_NEEDS.has(String(visualNeed || "").toLowerCase())
    );
    const criticality = (roleRequiresProof || ["intro", "outro"].includes(String(scene.role || "").toLowerCase())) ? "high" : "medium";
    const mustAvoidCategories = [
      ...(String(scene.visual_intent || "").toLowerCase() === "gastronomy"
        ? ["aerial_city", "bridge", "river", "coast", "generic_street"]
        : []),
    ];

    plan.push({
      micro_id: segment.micro_id || `mic_${String(index + 1).padStart(4, "0")}`,
      scene_index: Number(scene.scene_index || 0),
      block_id: scene.block_id || `scene_${Number(scene.scene_index || 0)}`,
      start_sec: round3(startSec),
      end_sec: round3(endSec),
      duration_sec: round3(Math.max(0.2, endSec - startSec)),
      text_excerpt: textExcerpt,
      visual_need: visualNeed,
      needs_visual_proof: needsVisualProof,
      criticality,
      fallback_policy: needsVisualProof ? "repair_then_degrade" : "degrade_allowed",
      target_narrative_roles: targetRoles,
      must_avoid_categories: unique(mustAvoidCategories),
      action_tokens: unique(segment.action_tokens || []),
      semantic_tokens: unique(segment.semantic_tokens || []).slice(0, 14),
    });
  });

  return plan;
};

module.exports = {
  MIN_MICRO_SECONDS,
  MAX_MICRO_SECONDS,
  buildMicroSegmentsFromAudio,
  buildMicroVisualPlan,
  __test__: {
    tokenize,
    buildActionTokens,
    pickVisualNeed,
    findSceneForMicro,
  },
};
