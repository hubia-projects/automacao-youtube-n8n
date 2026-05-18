const { config } = require("../config/env");

const COVERAGE_STATUS = {
  STRONG: "strong",
  PARTIAL: "partial",
  INSUFFICIENT: "insufficient",
};

const unique = (values = []) => [...new Set((values || []).filter(Boolean))];
const round3 = (value) => Number(Number(value || 0).toFixed(3));
const normalize = (value = "") => String(value || "").toLowerCase().trim();

const getBlockSlots = (blockPackage = {}) => Array.isArray(blockPackage.slots) ? blockPackage.slots : [];
const getRequiredSlots = (blockPackage = {}) => getBlockSlots(blockPackage).filter((slot) => slot.required === true);
const getCriticalSlots = (blockPackage = {}) =>
  getRequiredSlots(blockPackage).filter((slot) =>
    slot.requires_visual_proof === true || ["high", "critical"].includes(normalize(slot.criticality || ""))
  );

const buildSlotCoverageIndex = (slotCoverageByBlock = []) =>
  (slotCoverageByBlock || []).reduce((acc, entry) => {
    const key = String(entry.block_id || "").trim();
    if (!key) return acc;
    acc[key] = entry;
    return acc;
  }, {});

const buildFunnelIndex = (blockCandidateFunnel = []) =>
  (blockCandidateFunnel || []).reduce((acc, entry) => {
    const key = String(entry.block_id || "").trim();
    if (!key) return acc;
    acc[key] = entry;
    return acc;
  }, {});

const buildCoverageSlotMap = (slotCoverageEntry = {}) =>
  (Array.isArray(slotCoverageEntry.slot_coverage) ? slotCoverageEntry.slot_coverage : [])
    .reduce((acc, slot) => {
      const key = String(slot.slot_id || "").trim();
      if (!key) return acc;
      acc[key] = slot;
      return acc;
    }, {});

const evaluateBlockCoverage = ({
  blockPackage = {},
  slotCoverageEntry = {},
  funnelEntry = {},
} = {}) => {
  const blockId = String(blockPackage.block_id || "").trim();
  const slots = getBlockSlots(blockPackage);
  const requiredSlots = getRequiredSlots(blockPackage);
  const criticalSlots = getCriticalSlots(blockPackage);
  const slotCoverageMap = buildCoverageSlotMap(slotCoverageEntry);

  const missingSlots = [];
  const weakOnlySlots = [];
  const coveredRequiredSlots = [];
  const coveredCriticalSlots = [];
  const missingVisualNeeds = [];
  const coverageGaps = [];
  const excessSlots = [];

  requiredSlots.forEach((slot) => {
    const slotId = String(slot.slot_id || "").trim();
    const covered = slotCoverageMap[slotId];
    const selectedCount = Number(covered?.selected_count || 0);
    const eligibleCount = Number(covered?.eligible_count || 0);
    const coverageCount = Number(covered?.coverage_count || 0);
    const minCount = Number(slot.min_count || covered?.min_count || 1);
    const requiresProof = slot.requires_visual_proof === true;
    const isCovered = coverageCount >= minCount;

    if (isCovered) {
      coveredRequiredSlots.push(slot.slot_type);
    } else {
      missingSlots.push(slot.slot_type);
      coverageGaps.push({
        slot_id: slot.slot_id,
        slot_type: slot.slot_type,
        min_count: minCount,
        selected_count: selectedCount,
        eligible_count: eligibleCount,
        coverage_count: coverageCount,
        requires_visual_proof: requiresProof,
      });
      missingVisualNeeds.push(slot.slot_type);
    }

    if (selectedCount > 0 && !isCovered) {
      weakOnlySlots.push(slot.slot_type);
    }
  });

  slots.forEach((slot) => {
    const slotId = String(slot.slot_id || "").trim();
    const covered = slotCoverageMap[slotId];
    const selectedCount = Number(covered?.selected_count || 0);
    const maxCount = Number(slot.max_count || covered?.max_count || 0);
    if (maxCount > 0 && selectedCount > maxCount) {
      excessSlots.push(slot.slot_type);
      coverageGaps.push({
        slot_id: slot.slot_id,
        slot_type: slot.slot_type,
        max_count: maxCount,
        selected_count: selectedCount,
        reason: "slot_max_exceeded",
      });
    }
  });

  criticalSlots.forEach((slot) => {
    const covered = slotCoverageMap[String(slot.slot_id || "").trim()];
    const coverageCount = Number(covered?.coverage_count || 0);
    if (coverageCount >= Number(slot.min_count || covered?.min_count || 1)) {
      coveredCriticalSlots.push(slot.slot_type);
    }
  });

  const requiredCoverageRatio = round3(coveredRequiredSlots.length / Math.max(1, requiredSlots.length));
  const criticalCoverageRatio = round3(coveredCriticalSlots.length / Math.max(1, criticalSlots.length));
  const distinctVisualFamilies = Number(funnelEntry.distinct_visual_families || 0);
  const approvedCount = Number(funnelEntry.approved_count || 0);
  const weakOnlyCount = weakOnlySlots.length;
  const missingCount = missingSlots.length;
  const minFamiliesTarget = Math.max(2, Math.min(4, requiredSlots.length + 1));

  let coverageStatus = COVERAGE_STATUS.INSUFFICIENT;
  if (
    requiredCoverageRatio >= 1
    && criticalCoverageRatio >= 1
    && weakOnlyCount === 0
    && excessSlots.length === 0
    && approvedCount >= Math.max(4, requiredSlots.length)
    && distinctVisualFamilies >= minFamiliesTarget
  ) {
    coverageStatus = COVERAGE_STATUS.STRONG;
  } else if (requiredCoverageRatio >= 0.5 || criticalCoverageRatio >= 0.5 || approvedCount > 0) {
    coverageStatus = COVERAGE_STATUS.PARTIAL;
  }

  const maxRepairRounds = Math.max(1, Number(config.COVERAGE_GATE_MAX_REPAIR_ROUNDS_PER_BLOCK || 2));
  const repairRoundsUsed = Number(funnelEntry.repair_rounds_used || 0);
  const needsRepair = coverageStatus !== COVERAGE_STATUS.STRONG && repairRoundsUsed < maxRepairRounds;
  const allowPartialAdvance = Boolean(config.COVERAGE_GATE_ALLOW_PARTIAL);
  const canAdvance = coverageStatus === COVERAGE_STATUS.STRONG
    || (coverageStatus === COVERAGE_STATUS.PARTIAL && allowPartialAdvance && !needsRepair);

  let advanceMode = "blocked";
  if (coverageStatus === COVERAGE_STATUS.STRONG) advanceMode = "strong";
  if (coverageStatus === COVERAGE_STATUS.PARTIAL && !needsRepair && allowPartialAdvance) advanceMode = "degraded_partial";
  if (needsRepair) advanceMode = "repair_required";

  return {
    block_id: blockId,
    package_id: blockPackage.package_id || "",
    intent: blockPackage.intent || "",
    scene_indexes: blockPackage.scene_indexes || [],
    coverage_status: coverageStatus,
    coverage_score: round3((requiredCoverageRatio * 0.6) + (criticalCoverageRatio * 0.4)),
    required_slots_total: requiredSlots.length,
    required_slots_covered: coveredRequiredSlots.length,
    critical_slots_total: criticalSlots.length,
    critical_slots_covered: coveredCriticalSlots.length,
    required_coverage_ratio: requiredCoverageRatio,
    critical_coverage_ratio: criticalCoverageRatio,
    approved_windows_count: approvedCount,
    distinct_visual_families: distinctVisualFamilies,
    weak_only_slots: unique(weakOnlySlots),
    excess_slots: unique(excessSlots),
    missing_slots: unique(missingSlots),
    missing_visual_needs: unique(missingVisualNeeds),
    coverage_gaps: coverageGaps,
    needs_repair: needsRepair,
    repair_rounds_used: repairRoundsUsed,
    max_repair_rounds: maxRepairRounds,
    can_advance: canAdvance,
    advance_mode: advanceMode,
  };
};

const evaluateCoverageGate = ({
  blockPackages = [],
  slotCoverageByBlock = [],
  blockCandidateFunnel = [],
} = {}) => {
  const slotCoverageIndex = buildSlotCoverageIndex(slotCoverageByBlock);
  const funnelIndex = buildFunnelIndex(blockCandidateFunnel);
  const blocks = (blockPackages || []).map((blockPackage) =>
    evaluateBlockCoverage({
      blockPackage,
      slotCoverageEntry: slotCoverageIndex[String(blockPackage.block_id || "").trim()] || {},
      funnelEntry: funnelIndex[String(blockPackage.block_id || "").trim()] || {},
    })
  );

  const counts = blocks.reduce((acc, block) => {
    acc.total += 1;
    if (block.coverage_status === COVERAGE_STATUS.STRONG) acc.strong += 1;
    if (block.coverage_status === COVERAGE_STATUS.PARTIAL) acc.partial += 1;
    if (block.coverage_status === COVERAGE_STATUS.INSUFFICIENT) acc.insufficient += 1;
    if (block.needs_repair) acc.repair_required += 1;
    if (block.can_advance) acc.advance_allowed += 1;
    return acc;
  }, {
    total: 0,
    strong: 0,
    partial: 0,
    insufficient: 0,
    repair_required: 0,
    advance_allowed: 0,
  });

  return {
    blocks,
    summary: {
      ...counts,
      strong_ratio: round3(counts.strong / Math.max(1, counts.total)),
      partial_ratio: round3(counts.partial / Math.max(1, counts.total)),
      insufficient_ratio: round3(counts.insufficient / Math.max(1, counts.total)),
      repair_required_ratio: round3(counts.repair_required / Math.max(1, counts.total)),
    },
  };
};

module.exports = {
  COVERAGE_STATUS,
  evaluateCoverageGate,
  __test__: {
    evaluateBlockCoverage,
    evaluateCoverageGate,
  },
};
