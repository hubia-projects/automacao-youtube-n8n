const { FOOD_VISUAL_INTENTS } = require("../config/editorialPolicy");

const unique = (values = []) => [...new Set((values || []).filter(Boolean))];
const normalize = (value = "") => String(value || "").trim().toLowerCase();

const ECONOMIC_BUDGET_PROFILE = {
  raw_candidates_per_block: 60,
  cheap_shortlist_per_block: 20,
  vision_finalists_per_block: 8,
  max_repair_rounds_per_block: 1,
};

const SLOT_TEMPLATE_BY_INTENT = {
  gastronomy: [
    { slot_type: "food_closeup", required: true, min_count: 2, max_count: 3, target_roles: ["proof_exact", "detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 10, query_hints: ["food close up", "local dish close up", "authentic meal close up"] },
    { slot_type: "market_stall", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact", "context_regional"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 9, query_hints: ["market stall food", "local food market stall"] },
    { slot_type: "people_eating", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact", "detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 8, query_hints: ["people eating local food", "restaurant people eating"] },
    { slot_type: "chef_or_vendor", required: true, min_count: 1, max_count: 2, target_roles: ["detail_cutaway", "context_regional"], requires_visual_proof: true, generic_tolerance: "low", criticality: "medium", priority: 7, query_hints: ["chef cooking", "food vendor preparing"] },
    { slot_type: "city_context", required: false, min_count: 0, max_count: 1, target_roles: ["opening_establishing", "bridge_neutral_short"], requires_visual_proof: false, generic_tolerance: "medium", criticality: "low", priority: 3, query_hints: ["city street local market area"] },
    { slot_type: "transition_broll", required: false, min_count: 0, max_count: 1, target_roles: ["bridge_neutral_short"], requires_visual_proof: false, generic_tolerance: "high", criticality: "low", priority: 2, query_hints: ["cinematic transition broll"] },
    { slot_type: "fallback_safe", required: false, min_count: 0, max_count: 1, target_roles: ["detail_cutaway"], requires_visual_proof: false, generic_tolerance: "high", criticality: "low", priority: 1, query_hints: ["authentic local scene"] },
  ],
  market: [
    { slot_type: "market_stall", required: true, min_count: 2, max_count: 3, target_roles: ["proof_exact", "context_regional"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 10, query_hints: ["food market stall", "traditional market vendors"] },
    { slot_type: "local_product", required: true, min_count: 1, max_count: 2, target_roles: ["detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "medium", priority: 8, query_hints: ["local produce market close up", "fresh fish market close up"] },
    { slot_type: "people_eating", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact", "detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 8, query_hints: ["people eating market food"] },
    { slot_type: "city_context", required: false, min_count: 0, max_count: 1, target_roles: ["opening_establishing"], requires_visual_proof: false, generic_tolerance: "medium", criticality: "low", priority: 3, query_hints: ["market district street"] },
  ],
  wine: [
    { slot_type: "wine_pouring", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact", "detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 10, query_hints: ["wine pouring close up"] },
    { slot_type: "wine_tasting", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 9, query_hints: ["wine tasting people"] },
    { slot_type: "cellar_barrels", required: true, min_count: 1, max_count: 1, target_roles: ["context_regional"], requires_visual_proof: true, generic_tolerance: "low", criticality: "medium", priority: 7, query_hints: ["wine cellar barrels"] },
    { slot_type: "restaurant_wine_table", required: false, min_count: 0, max_count: 1, target_roles: ["closing_payoff", "detail_cutaway"], requires_visual_proof: false, generic_tolerance: "medium", criticality: "low", priority: 4, query_hints: ["restaurant wine table"] },
  ],
  pastry: [
    { slot_type: "food_closeup", required: true, min_count: 2, max_count: 3, target_roles: ["proof_exact", "detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 10, query_hints: ["pastry close up", "dessert close up"] },
    { slot_type: "chef_or_vendor", required: true, min_count: 1, max_count: 2, target_roles: ["detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "medium", priority: 7, query_hints: ["bakery chef", "pastry vendor"] },
    { slot_type: "people_eating", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact"], requires_visual_proof: true, generic_tolerance: "low", criticality: "medium", priority: 7, query_hints: ["people eating pastry"] },
    { slot_type: "city_context", required: false, min_count: 0, max_count: 1, target_roles: ["opening_establishing"], requires_visual_proof: false, generic_tolerance: "medium", criticality: "low", priority: 3, query_hints: ["traditional bakery street"] },
  ],
  restaurant: [
    { slot_type: "restaurant_table", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 9, query_hints: ["restaurant table local food"] },
    { slot_type: "food_closeup", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact", "detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 9, query_hints: ["restaurant food close up"] },
    { slot_type: "people_eating", required: true, min_count: 1, max_count: 2, target_roles: ["detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "medium", priority: 7, query_hints: ["people eating restaurant"] },
    { slot_type: "chef_or_vendor", required: false, min_count: 0, max_count: 1, target_roles: ["detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "low", priority: 5, query_hints: ["chef plating food"] },
  ],
  cafe: [
    { slot_type: "restaurant_table", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact", "detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 8, query_hints: ["cafe table pastry"] },
    { slot_type: "people_eating", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact"], requires_visual_proof: true, generic_tolerance: "low", criticality: "medium", priority: 7, query_hints: ["people drinking coffee cafe"] },
    { slot_type: "local_product", required: false, min_count: 0, max_count: 1, target_roles: ["detail_cutaway"], requires_visual_proof: true, generic_tolerance: "medium", criticality: "low", priority: 4, query_hints: ["coffee close up barista"] },
  ],
  street_food: [
    { slot_type: "market_stall", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 9, query_hints: ["street food stall"] },
    { slot_type: "people_eating", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact", "detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 8, query_hints: ["people eating street food"] },
    { slot_type: "food_closeup", required: true, min_count: 1, max_count: 2, target_roles: ["detail_cutaway"], requires_visual_proof: true, generic_tolerance: "low", criticality: "medium", priority: 7, query_hints: ["street food close up"] },
    { slot_type: "city_context", required: false, min_count: 0, max_count: 1, target_roles: ["opening_establishing"], requires_visual_proof: false, generic_tolerance: "medium", criticality: "low", priority: 3, query_hints: ["street market district"] },
  ],
  city_landmark: [
    { slot_type: "street_level", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact", "context_regional"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 8, query_hints: ["city street level"] },
    { slot_type: "landmark", required: true, min_count: 1, max_count: 2, target_roles: ["proof_exact", "opening_establishing"], requires_visual_proof: true, generic_tolerance: "low", criticality: "high", priority: 8, query_hints: ["city landmark"] },
    { slot_type: "people_walking", required: false, min_count: 0, max_count: 1, target_roles: ["detail_cutaway"], requires_visual_proof: false, generic_tolerance: "medium", criticality: "low", priority: 4, query_hints: ["people walking city"] },
    { slot_type: "wide_establishing", required: false, min_count: 0, max_count: 1, target_roles: ["opening_establishing"], requires_visual_proof: false, generic_tolerance: "medium", criticality: "low", priority: 3, query_hints: ["wide city establishing"] },
  ],
  generic_travel: [
    { slot_type: "street_level", required: true, min_count: 1, max_count: 2, target_roles: ["context_regional"], requires_visual_proof: false, generic_tolerance: "medium", criticality: "medium", priority: 6, query_hints: ["authentic local street"] },
    { slot_type: "people_walking", required: false, min_count: 0, max_count: 1, target_roles: ["detail_cutaway"], requires_visual_proof: false, generic_tolerance: "medium", criticality: "low", priority: 4, query_hints: ["people walking"] },
    { slot_type: "wide_establishing", required: false, min_count: 0, max_count: 1, target_roles: ["opening_establishing"], requires_visual_proof: false, generic_tolerance: "high", criticality: "low", priority: 3, query_hints: ["city establishing shot"] },
    { slot_type: "transition_broll", required: false, min_count: 0, max_count: 1, target_roles: ["bridge_neutral_short"], requires_visual_proof: false, generic_tolerance: "high", criticality: "low", priority: 2, query_hints: ["travel transition broll"] },
  ],
};

const getSlotsForIntent = (intent = "") => {
  const normalizedIntent = normalize(intent);
  if (SLOT_TEMPLATE_BY_INTENT[normalizedIntent]) return SLOT_TEMPLATE_BY_INTENT[normalizedIntent];
  if (FOOD_VISUAL_INTENTS.has(normalizedIntent)) return SLOT_TEMPLATE_BY_INTENT.gastronomy;
  return SLOT_TEMPLATE_BY_INTENT.generic_travel;
};

const buildBlockKey = (scene = {}) =>
  String(scene.block_id || `scene_${Number(scene.scene_index || 0)}`).trim();

const buildSlotId = ({ blockId, slotType, index }) =>
  `${blockId}:${slotType}:${String(index + 1).padStart(2, "0")}`;

const pickRepresentativeIntent = (scenes = []) => {
  const counts = new Map();
  scenes.forEach((scene) => {
    const intent = normalize(scene.visual_intent || "generic_travel");
    counts.set(intent, Number(counts.get(intent) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "generic_travel";
};

const buildTargetSceneHint = ({ scenes = [], targetRoles = [] }) => {
  const first = scenes[0];
  const last = scenes[scenes.length - 1];
  if (targetRoles.includes("hook_exact") || targetRoles.includes("opening_establishing")) return Number(first?.scene_index || 0);
  if (targetRoles.includes("closing_payoff")) return Number(last?.scene_index || 0);
  const proofScene = scenes.find((scene) => ["proof", "detail"].includes(String(scene.narrative_function || "").toLowerCase()));
  return Number(proofScene?.scene_index || first?.scene_index || 0);
};

const buildSlotQuotas = (slots = []) =>
  slots.reduce((acc, slot) => {
    acc[slot.slot_type] = {
      min_count: Number(slot.min_count || 0),
      max_count: Number(slot.max_count || 0),
      required: slot.required === true,
    };
    return acc;
  }, {});

const MICRO_NEED_SLOT_RULES = [
  {
    slot_type: "pastry_closeup",
    pattern: /(doce|doces|pastel|pastéis|pastry|dessert|sobremesa|confeitaria|bakery)/i,
    base: {
      required: true,
      min_count: 1,
      max_count: 2,
      target_roles: ["proof_exact", "detail_cutaway"],
      requires_visual_proof: true,
      generic_tolerance: "low",
      criticality: "high",
      priority: 11,
      query_hints: ["pastry close up", "traditional pastry market", "local dessert close up"],
    },
  },
  {
    slot_type: "vendor_interaction",
    pattern: /(vendedor|vendedores|vendor|servindo|servir|atendente|atendimento|banca)/i,
    base: {
      required: true,
      min_count: 1,
      max_count: 2,
      target_roles: ["proof_exact", "detail_cutaway"],
      requires_visual_proof: true,
      generic_tolerance: "low",
      criticality: "high",
      priority: 10,
      query_hints: ["vendor serving food", "market seller interaction", "food stall service close up"],
    },
  },
  {
    slot_type: "wine_tasting",
    pattern: /(vinho|vinhos|wine|degustação|degustacoes|taça|taças|brinde|tasting)/i,
    base: {
      required: true,
      min_count: 1,
      max_count: 2,
      target_roles: ["proof_exact", "closing_payoff"],
      requires_visual_proof: true,
      generic_tolerance: "low",
      criticality: "high",
      priority: 10,
      query_hints: ["wine tasting people", "wine tasting close up", "wine service restaurant table"],
    },
  },
];

const augmentSlotsFromNarrativeCues = ({ slots = [], scenes = [] }) => {
  const text = String(
    (scenes || [])
      .map((scene) => `${scene.narration_excerpt || ""} ${scene.topic || ""} ${scene.subtheme || ""}`)
      .join(" ")
  );
  if (!text.trim()) return slots;

  const byType = new Map((slots || []).map((slot) => [String(slot.slot_type || "").toLowerCase(), slot]));
  for (const rule of MICRO_NEED_SLOT_RULES) {
    if (!rule.pattern.test(text)) continue;
    const key = String(rule.slot_type || "").toLowerCase();
    if (byType.has(key)) {
      const current = byType.get(key);
      byType.set(key, {
        ...current,
        required: true,
        min_count: Math.max(Number(current.min_count || 0), Number(rule.base.min_count || 1)),
        max_count: Math.max(Number(current.max_count || 1), Number(rule.base.max_count || 1)),
        requires_visual_proof: current.requires_visual_proof === true || rule.base.requires_visual_proof === true,
        criticality: current.criticality === "critical" ? "critical" : rule.base.criticality || current.criticality,
        priority: Math.max(Number(current.priority || 1), Number(rule.base.priority || 1)),
        target_roles: unique([...(current.target_roles || []), ...(rule.base.target_roles || [])]),
        query_hints: unique([...(current.query_hints || []), ...(rule.base.query_hints || [])]),
      });
      continue;
    }
    byType.set(key, { slot_type: rule.slot_type, ...rule.base });
  }

  return [...byType.values()].sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0));
};

const buildBlockContentPackages = ({
  visualPlan = [],
  budgetProfile = ECONOMIC_BUDGET_PROFILE,
} = {}) => {
  const scenesByBlock = new Map();
  (visualPlan || []).forEach((scene) => {
    const blockId = buildBlockKey(scene);
    const scenes = scenesByBlock.get(blockId) || [];
    scenes.push(scene);
    scenesByBlock.set(blockId, scenes);
  });

  return [...scenesByBlock.entries()].map(([blockId, scenes], blockIndex) => {
    const sortedScenes = [...scenes].sort((a, b) => Number(a.scene_order || a.scene_index || 0) - Number(b.scene_order || b.scene_index || 0));
    const intent = pickRepresentativeIntent(sortedScenes);
    const blockLabel = sortedScenes[0]?.block_label || sortedScenes[0]?.title || blockId;
    const slotTemplates = augmentSlotsFromNarrativeCues({
      slots: getSlotsForIntent(intent),
      scenes: sortedScenes,
    });
    const slots = slotTemplates.map((slot, index) => ({
      slot_id: buildSlotId({ blockId, slotType: slot.slot_type, index }),
      slot_type: slot.slot_type,
      required: slot.required === true,
      min_count: Number(slot.min_count || 0),
      max_count: Number(slot.max_count || 1),
      target_roles: unique(slot.target_roles || []),
      requires_visual_proof: slot.requires_visual_proof === true,
      generic_tolerance: slot.generic_tolerance || "medium",
      criticality: slot.criticality || "medium",
      priority: Number(slot.priority || 1),
      query_hints: unique(slot.query_hints || []),
      scene_index_hint: buildTargetSceneHint({ scenes: sortedScenes, targetRoles: slot.target_roles || [] }),
    }));

    return {
      package_id: `pkg_${String(blockIndex + 1).padStart(3, "0")}_${blockId}`,
      block_id: blockId,
      block_label: blockLabel,
      intent,
      scene_indexes: sortedScenes.map((scene) => Number(scene.scene_index || 0)),
      slots_required: slots.filter((slot) => slot.required),
      slots_optional: slots.filter((slot) => !slot.required),
      slots,
      slot_quotas: buildSlotQuotas(slots),
      budget_profile: {
        ...ECONOMIC_BUDGET_PROFILE,
        ...(budgetProfile || {}),
      },
    };
  });
};

module.exports = {
  ECONOMIC_BUDGET_PROFILE,
  SLOT_TEMPLATE_BY_INTENT,
  buildBlockContentPackages,
  __test__: {
    buildBlockContentPackages,
    getSlotsForIntent,
  },
};
