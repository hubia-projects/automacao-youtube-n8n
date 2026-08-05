const { config } = require("../config/env");
const { normalizeLabel } = require("./visualIntentService");
const { loadState, updateState } = require("./stateService");
const { logger } = require("../utils/logger");

const unique = (values = []) => [...new Set(values.filter(Boolean))];
const round3 = (value) => Number(Number(value || 0).toFixed(3));

// ─── Fontes de evidência fraca ──────────────────────────────────────────────

const WEAK_EVIDENCE_SOURCES = new Set([
  "metadata_fallback",
  "weak_fallback",
  "disabled",
  "script_missing",
  "local_video_understanding_fallback",
]);

const EVIDENCE_SOURCE_PRIORITY = {
  ai_generated_scene_alignment: 5,
  openai_vision: 4,
  gemini_vision: 4,
  real_vision: 4,
  clip_library: 3,
  metadata_fallback: 0,
  weak_fallback: 0,
  disabled: 0,
};

// ─── Classificação de verdade visual ────────────────────────────────────────

const classifyVisualTruth = ({ asset = {}, window = {}, scene = {} } = {}) => {
  const evidenceSource = String(
    window.visual_evidence_source
    || window.method
    || asset.analysis_provider
    || "metadata_fallback"
  ).toLowerCase();

  const isWeakSource = WEAK_EVIDENCE_SOURCES.has(evidenceSource);
  const requiredEvidence = unique(scene.required_visual_evidence || []);
  const requiredEvidenceFound = unique(window.required_evidence_found || []);
  const missingEvidence = requiredEvidence.filter((e) => !requiredEvidenceFound.includes(e));
  const detectedCategories = unique(window.detected_visual_categories || []);
  const forbiddenCategories = unique(scene.forbidden_visual_categories || []);
  const hasForbiddenCategory = forbiddenCategories.some((fc) =>
    detectedCategories.some((dc) => normalizeLabel(dc) === normalizeLabel(fc))
  );

  const visualIntent = String(scene.visual_intent || "").toLowerCase();
  const isFoodIntent = ["gastronomy", "market", "wine", "pastry", "restaurant", "cafe", "street_food"].includes(visualIntent);

  // Regra 1: metadata_fallback nunca aprova slot crítico
  if (isWeakSource && scene.criticality === "critical") {
    return {
      visual_truth_status: "unknown",
      editorial_confidence: 0.1,
      reason: "weak_evidence_source_for_critical_slot",
      weak_source: evidenceSource,
    };
  }

  // Regra 2: forbidden categories = reprovação
  if (hasForbiddenCategory) {
    return {
      visual_truth_status: "wrong",
      editorial_confidence: 0.1,
      reason: "forbidden_visual_category_detected",
      forbidden_categories: forbiddenCategories.filter((fc) =>
        detectedCategories.some((dc) => normalizeLabel(dc) === normalizeLabel(fc))
      ),
    };
  }

  // Regra 3: exact = evidência forte + todas as required evidence encontradas
  const allRequiredFound = requiredEvidence.length > 0
    ? requiredEvidence.every((e) => requiredEvidenceFound.includes(e))
    : detectedCategories.length >= 3;

  if (allRequiredFound && !isWeakSource && !hasForbiddenCategory) {
    return {
      visual_truth_status: "exact",
      editorial_confidence: 0.92,
      reason: "all_required_evidence_found_real_vision",
    };
  }

  // Regra 4: regional = evidência parcial mas fonte real
  const partialRequiredFound = requiredEvidence.length > 0
    ? requiredEvidenceFound.length >= Math.ceil(requiredEvidence.length / 2)
    : detectedCategories.length >= 2;

  if (partialRequiredFound && !isWeakSource && !hasForbiddenCategory) {
    return {
      visual_truth_status: "regional",
      editorial_confidence: 0.72,
      reason: "partial_required_evidence_found_real_vision",
    };
  }

  // Regra 5: generic = sem evidência forte mas fonte real
  if (!isWeakSource && detectedCategories.length > 0 && !hasForbiddenCategory) {
    return {
      visual_truth_status: "generic",
      editorial_confidence: 0.45,
      reason: "real_vision_but_no_required_evidence",
    };
  }

  // Regra 6: weak source sem evidência = unknown
  if (isWeakSource) {
    return {
      visual_truth_status: "unknown",
      editorial_confidence: 0.15,
      reason: "weak_evidence_source_no_evidence",
      weak_source: evidenceSource,
    };
  }

  // Regra 7: fallback
  return {
    visual_truth_status: "unknown",
    editorial_confidence: 0.1,
    reason: "insufficient_evidence_or_fallback",
  };
};

// ─── Aprovação de assets ────────────────────────────────────────────────────

const approveVisualEvidence = async ({ videoId }) => {
  const state = await loadState(videoId);
  const visualContract = state.visual_contract || null;
  const assets = Array.isArray(state.assets_json?.items)
    ? state.assets_json.items
    : [];
  const visualPlan = Array.isArray(state.visual_plan) ? state.visual_plan : [];

  if (!visualContract) {
    logger.warn("visualEvidenceApprovalService: sem visual_contract — a aprovar sem contrato", { videoId });
  }

  const microMoments = visualContract?.micro_moments || [];
  const approvedPool = [];
  const rejectedPool = [];
  const needsManualReview = [];

  // Para cada micro_moment do contrato, avaliar cada asset
  microMoments.forEach((moment, momentIndex) => {
    // Usar scene_index do micro_moment ou do índice (fallback)
    const momentSceneIndex = Number(moment.scene_index || momentIndex + 1);
    
    const momentAssets = assets.filter((asset) => {
      const assetSceneIndex = Number(asset.scene_index || 0);
      // Matching: mesmo scene_index OU primeiro micro_moment (índice 0) aceita todos
      return assetSceneIndex === momentSceneIndex || momentIndex === 0;
    });

    if (!momentAssets.length) {
      needsManualReview.push({
        micro_moment_id: moment.id,
        narration_excerpt: moment.narration_excerpt,
        required_visual_evidence: moment.required_visual_evidence,
        missing_evidence: moment.required_visual_evidence,
        attempted_queries: [],
        why_rejected: "no_assets_found_for_micro_moment",
      });
      return;
    }

    momentAssets.forEach((asset) => {
      const windows = Array.isArray(asset.analysis_windows) && asset.analysis_windows.length
        ? asset.analysis_windows
        : [
            {
              window_index: 1,
              summary: asset.analysis_summary || asset.semantic_text || asset.query || "",
              tags: unique([...(asset.analysis_tags || []), ...(asset.provider_tags || [])]),
              detected_visual_categories: asset.detected_visual_categories || [],
              detected_objects: asset.detected_objects || [],
              required_evidence_found: asset.required_evidence_found || [],
              visual_evidence_source: asset.analysis_provider || "metadata_fallback",
            },
          ];

      windows.forEach((window) => {
        const truthResult = classifyVisualTruth({
          asset,
          window,
          scene: moment,
        });

        const semanticRelevance = Number(window.semantic_relevance_score || 0.5);
        const editorialEvidence = Number(window.editorial_evidence_score || truthResult.editorial_confidence);
        const semanticRisk = Number(window.semantic_risk_score || 0.5);

        const approvedForSlots = [];

        // Determinar para que tipos de slot este asset/janela pode ser usado
        if (truthResult.visual_truth_status === "exact") {
          approvedForSlots.push("critical", "proof_exact", "hook_exact", "opening_establishing", "context_regional", "detail_cutaway", "closing_payoff", "bridge_neutral_short");
        } else if (truthResult.visual_truth_status === "regional") {
          approvedForSlots.push("context_regional", "detail_cutaway", "bridge_neutral_short", "opening_establishing");
          if (moment.criticality !== "critical") {
            approvedForSlots.push("proof_exact");
          }
        } else if (truthResult.visual_truth_status === "generic") {
          approvedForSlots.push("bridge_neutral_short", "transition_only");
        } else {
          // unknown/wrong: não aprovado para nenhum slot
          if (moment.criticality === "critical") {
            needsManualReview.push({
              micro_moment_id: moment.id,
              narration_excerpt: moment.narration_excerpt,
              required_visual_evidence: moment.required_visual_evidence,
              missing_evidence: moment.required_visual_evidence.filter(
                (e) => !(window.required_evidence_found || []).includes(e)
              ),
              attempted_queries: [asset.query || ""],
              why_rejected: `visual_truth_status_${truthResult.visual_truth_status}`,
            });
          }
        }

        const entry = {
          asset_id: asset.asset_id || asset.local_path || `asset_${approvedPool.length}`,
          local_path: asset.local_path || "",
          source_url: asset.source_url || "",
          provider: asset.provider || "unknown",
          scene_index: asset.scene_index || moment.scene_index || 0,
          micro_moment_id: moment.id,
          visual_truth_status: truthResult.visual_truth_status,
          editorial_confidence: round3(truthResult.editorial_confidence),
          semantic_relevance_score: round3(semanticRelevance),
          editorial_evidence_score: round3(editorialEvidence),
          semantic_risk_score: round3(semanticRisk),
          required_evidence_found: unique(window.required_evidence_found || []),
          missing_required_visual_evidence: unique(
            (moment.required_visual_evidence || []).filter(
              (e) => !(window.required_evidence_found || []).includes(e)
            )
          ),
          detected_visual_categories: unique(window.detected_visual_categories || []),
          visual_family: asset.visual_family || "",
          landmark_id: asset.landmark_id || "",
          location: window.location || asset.location || { city: moment.city, country: moment.country },
          approved_for_slots: approvedForSlots,
          evidence_source: window.visual_evidence_source || asset.analysis_provider || "metadata_fallback",
          asset,
          window,
        };

        // Só aprovar se tem evidência real (não metadata_fallback)
        const hasRealEvidence = !WEAK_EVIDENCE_SOURCES.has(
          String(entry.evidence_source || "").toLowerCase()
        );

        if (hasRealEvidence && approvedForSlots.length > 0) {
          approvedPool.push(entry);
        } else if (approvedForSlots.length > 0) {
          // metadata_fallback com algum slot permitido → degraded
          rejectedPool.push({
            ...entry,
            rejection_reason: "metadata_fallback_or_weak_evidence",
          });
        } else {
          rejectedPool.push({
            ...entry,
            rejection_reason: `no_slots_approved_status_${truthResult.visual_truth_status}`,
          });
        }
      });
    });
  });

  // Deduplicar needsManualReview por micro_moment_id antes de calcular cobertura.
  // O loop interno (moment → assets → windows) pode empurrar o mesmo moment N vezes
  // se vários assets/windows reprovam para ele — bug de contagem cumulativa que
  // inflava o número de unmet moments (vimos 330 quando o real era 8).
  // Preservamos a primeira ocorrência (que tem info da janela específica que falhou).
  const dedupedSeen = new Map();
  for (const entry of needsManualReview) {
    if (!entry?.micro_moment_id) {
      logger.warn("visualEvidenceApprovalService: entrada sem micro_moment_id descartada na dedup", {
        micro_moment_id: null,
        attempted_queries: entry?.attempted_queries || [],
      });
      continue;
    }
    if (dedupedSeen.has(entry.micro_moment_id)) continue;
    dedupedSeen.set(entry.micro_moment_id, entry);
  }
  const dedupedNeedsManualReview = Array.from(dedupedSeen.values());
  needsManualReview.length = 0;
  needsManualReview.push(...dedupedNeedsManualReview);

  // Verificar cobertura do contrato visual
  const contractCovered = needsManualReview.length === 0;
  const totalCriticalMoments = microMoments.filter((m) => m.criticality === "critical").length;
  const coveredCriticalMoments = totalCriticalMoments - needsManualReview.filter((m) => {
    const moment = microMoments.find((mm) => mm.id === m.micro_moment_id);
    return moment?.criticality === "critical";
  }).length;

  const result = {
    video_id: videoId,
    approved_visual_evidence_pool: approvedPool,
    rejected_pool: rejectedPool,
    needs_manual_review: needsManualReview,
    contract_covered: contractCovered,
    total_micro_moments: microMoments.length,
    critical_moments_covered: coveredCriticalMoments,
    critical_moments_total: totalCriticalMoments,
    coverage_ratio: totalCriticalMoments > 0
      ? round3(coveredCriticalMoments / totalCriticalMoments)
      : 1,
    visual_contract_not_covered: !contractCovered,
  };

  const updated = await updateState(videoId, {
    approved_visual_evidence_pool: approvedPool,
    visual_evidence_approval: result,
  });

  if (!contractCovered) {
    logger.warn("visualEvidenceApprovalService: contrato visual NÃO coberto", {
      videoId,
      missing_moments: needsManualReview.length,
      critical_missing: needsManualReview.filter((m) => {
        const moment = microMoments.find((mm) => mm.id === m.micro_moment_id);
        return moment?.criticality === "critical";
      }).length,
    });
  }

  return result;
};

const getApprovedPool = async (videoId) => {
  const state = await loadState(videoId);
  return state.approved_visual_evidence_pool || [];
};

module.exports = {
  approveVisualEvidence,
  getApprovedPool,
  classifyVisualTruth,
  WEAK_EVIDENCE_SOURCES,
  __test__: {
    classifyVisualTruth,
    WEAK_EVIDENCE_SOURCES,
  },
};
