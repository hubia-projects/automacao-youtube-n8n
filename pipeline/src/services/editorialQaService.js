const { config } = require("../config/env");
const { loadState, updateState, ensureVideoStructure } = require("./stateService");
const { probeMedia, runFfmpeg } = require("../utils/mediaUtils");
const { writeJsonAtomic } = require("../utils/fileUtils");
const { logger } = require("../utils/logger");
const path = require("path");
const fs = require("fs-extra");

const round3 = (value) => Number(Number(value || 0).toFixed(3));
const unique = (values = []) => [...new Set(values.filter(Boolean))];
const normalizeLabel = (value = "") =>
  String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

// ─── Categorias de gastronomia vs não-gastronomia ───────────────────────────

const GASTRONOMY_CATEGORIES = new Set([
  "food", "local_food", "market", "wine", "pastry", "restaurant",
  "cafe", "street_food", "people_eating",
]);

const NON_GASTRONOMY_CATEGORIES = new Set([
  "city_landmark", "aerial_city", "bridge", "river", "coast",
  "generic_street", "clouds", "landscape", "historic_street",
]);

// ─── Funções de auditoria visual ────────────────────────────────────────────

const getExpectedMomentAt = (microMoments = [], timestampSec = 0) => {
  return microMoments.find(
    (m) => Number(m.start_sec || 0) <= timestampSec && Number(m.end_sec || 0) >= timestampSec
  ) || null;
};

const detectCategoriesFromClip = (clip = {}) => {
  return unique([
    ...(clip.detected_visual_categories || []),
    ...(clip.score_features?.detectedVisualCategories || []),
  ]);
};

const classifyGastronomyCoverage = (categories = []) => {
  const hasGastronomy = categories.some((c) => GASTRONOMY_CATEGORIES.has(normalizeLabel(c)));
  const hasNonGastronomy = categories.some((c) => NON_GASTRONOMY_CATEGORIES.has(normalizeLabel(c)));
  if (hasGastronomy && !hasNonGastronomy) return "gastronomy_evidence";
  if (hasGastronomy && hasNonGastronomy) return "mixed";
  if (!hasGastronomy && hasNonGastronomy) return "non_gastronomy";
  return "unclassified";
};

// ─── Construção do audit visual ─────────────────────────────────────────────

const buildVisualAudit = ({ clips = [], microMoments = [], visualContract = null }) => {
  const audit = [];
  const sampleInterval = 5; // segundos

  clips.forEach((clip) => {
    const clipStart = Number(clip.timeline_start_sec || 0);
    const clipEnd = Number(clip.timeline_end_sec || clipStart + (clip.clip_duration_seconds || 4));
    const midpoint = (clipStart + clipEnd) / 2;

    // Amostras a cada 5 segundos dentro do clip
    for (let t = clipStart; t < clipEnd; t += sampleInterval) {
      const expectedMoment = microMoments.length
        ? getExpectedMomentAt(microMoments, t)
        : null;
      const expectedVisualIntent = expectedMoment?.visual_intent || clip.visual_intent || "";
      const expectedNarration = expectedMoment?.narration_excerpt || clip.clip_script_excerpt || "";
      const requiredEvidence = expectedMoment?.required_visual_evidence || clip.required_visual_evidence || [];
      const detectedCategories = detectCategoriesFromClip(clip);
      const gastronomyClass = classifyGastronomyCoverage(detectedCategories);
      const visualTruthStatus = clip.visual_truth_status || clip.score_features?.visualTruthStatus || "regional";

      const isMatch = expectedVisualIntent
        ? (GASTRONOMY_CATEGORIES.has(normalizeLabel(expectedVisualIntent))
            ? gastronomyClass === "gastronomy_evidence"
            : gastronomyClass !== "gastronomy_evidence" || expectedVisualIntent === clip.visual_intent)
        : true;

      const mismatchReason = !isMatch
        ? (gastronomyClass === "non_gastronomy" && GASTRONOMY_CATEGORIES.has(normalizeLabel(expectedVisualIntent))
            ? "expected_gastronomy_got_non_gastronomy"
            : `expected_${expectedVisualIntent}_got_${gastronomyClass}`)
        : "";

      const repeatedAsset = (clip.score_features?.reusePenalty || 0) > 2;
      const repeatedVisualFamily = (clip.score_features?.rejectionWarnings || [])
        .some((w) => /repeat_visual_family|visual_family_overuse/i.test(String(w)));

      audit.push({
        timestamp_sec: round3(t),
        expected_micro_moment_id: expectedMoment?.id || "",
        expected_narration_excerpt: expectedNarration.slice(0, 120),
        expected_visual_intent: expectedVisualIntent,
        required_visual_evidence: requiredEvidence.slice(0, 5),
        clip_index: clip.clip_index || 0,
        asset_id: clip.asset_id || clip.asset_window_id || "",
        source_url: clip.source_url || clip.asset?.source_url || "",
        query_used: clip.query_used || "",
        detected_visual_categories: detectedCategories.slice(0, 6),
        visual_truth_status: visualTruthStatus,
        editorial_confidence: round3(clip.editorial_confidence || clip.confidence || 0),
        is_match: isMatch,
        mismatch_reason: mismatchReason,
        repeated_asset: repeatedAsset,
        repeated_visual_family: repeatedVisualFamily,
        location_match: clip.detected_location?.city
          ? clip.detected_location.city === (expectedMoment?.city || "")
          : null,
        caption_visible: Boolean(clip.captions_burned),
        overlay_visible: Boolean(clip.overlays_applied),
      });
    }

    // Midpoint de cada clip
    const midpointMoment = microMoments.length
      ? getExpectedMomentAt(microMoments, midpoint)
      : null;
    const midpointCategories = detectCategoriesFromClip(clip);
    const midpointGastronomyClass = classifyGastronomyCoverage(midpointCategories);

    audit.push({
      timestamp_sec: round3(midpoint),
      expected_micro_moment_id: midpointMoment?.id || "",
      expected_narration_excerpt: (midpointMoment?.narration_excerpt || clip.clip_script_excerpt || "").slice(0, 120),
      expected_visual_intent: midpointMoment?.visual_intent || clip.visual_intent || "",
      required_visual_evidence: (midpointMoment?.required_visual_evidence || clip.required_visual_evidence || []).slice(0, 5),
      clip_index: clip.clip_index || 0,
      asset_id: clip.asset_id || "",
      source_url: clip.source_url || "",
      query_used: clip.query_used || "",
      detected_visual_categories: midpointCategories.slice(0, 6),
      visual_truth_status: clip.visual_truth_status || "regional",
      editorial_confidence: round3(clip.editorial_confidence || 0),
      is_match: midpointMoment?.visual_intent
        ? GASTRONOMY_CATEGORIES.has(normalizeLabel(midpointMoment.visual_intent))
          ? midpointGastronomyClass === "gastronomy_evidence"
          : true
        : true,
      mismatch_reason: "",
      repeated_asset: false,
      repeated_visual_family: false,
      location_match: null,
      caption_visible: Boolean(clip.captions_burned),
      overlay_visible: Boolean(clip.overlays_applied),
      is_midpoint: true,
    });
  });

  return audit;
};

// ─── Relatório de cobertura ─────────────────────────────────────────────────

const buildCoverageReport = ({ clips = [], microMoments = [], visualContract = null }) => {
  const totalClips = clips.length;
  const gastronomyClips = clips.filter((clip) => {
    const categories = detectCategoriesFromClip(clip);
    return classifyGastronomyCoverage(categories) === "gastronomy_evidence";
  });
  const nonGastronomyClips = clips.filter((clip) => {
    const categories = detectCategoriesFromClip(clip);
    return classifyGastronomyCoverage(categories) === "non_gastronomy";
  });
  const mixedClips = clips.filter((clip) => {
    const categories = detectCategoriesFromClip(clip);
    return classifyGastronomyCoverage(categories) === "mixed";
  });

  const landmarkClips = clips.filter((clip) => {
    const categories = detectCategoriesFromClip(clip);
    return categories.some((c) => ["city_landmark", "aerial_city"].includes(normalizeLabel(c)));
  });

  const bridgeRiverClips = clips.filter((clip) => {
    const categories = detectCategoriesFromClip(clip);
    return categories.some((c) => ["bridge", "river"].includes(normalizeLabel(c)));
  });

  const gastronomyRatio = round3(gastronomyClips.length / Math.max(1, totalClips));
  const landmarkAerialRatio = round3(landmarkClips.length / Math.max(1, totalClips));
  const bridgeRiverRatio = round3(bridgeRiverClips.length / Math.max(1, totalClips));

  // Detectar repetições
  const sourceUrlCounts = new Map();
  const visualFamilyCounts = new Map();
  const landmarkIdCounts = new Map();

  clips.forEach((clip) => {
    const url = clip.source_url || clip.asset?.source_url || "";
    const family = clip.visual_family || clip.visual_signature || "";
    const landmark = clip.landmark_id || "";

    if (url) sourceUrlCounts.set(url, (sourceUrlCounts.get(url) || 0) + 1);
    if (family) visualFamilyCounts.set(family, (visualFamilyCounts.get(family) || 0) + 1);
    if (landmark) landmarkIdCounts.set(landmark, (landmarkIdCounts.get(landmark) || 0) + 1);
  });

  const repeatedSourceUrls = [...sourceUrlCounts.entries()].filter(([, count]) => count > 1);
  const repeatedVisualFamilies = [...visualFamilyCounts.entries()].filter(([, count]) => count > 2);
  const repeatedLandmarks = [...landmarkIdCounts.entries()].filter(([, count]) => count > 2);

  // Contar clips consecutivos da mesma visual_family
  let consecutiveRepeatCount = 0;
  for (let i = 1; i < clips.length; i++) {
    const prevFamily = clips[i - 1].visual_family || "";
    const currFamily = clips[i].visual_family || "";
    if (prevFamily && currFamily && prevFamily === currFamily) {
      consecutiveRepeatCount++;
    }
  }

  // Cobertura por cidade
  const coverageByCity = {};
  if (visualContract?.cities) {
    visualContract.cities.forEach((city) => {
      const cityClips = clips.filter((clip) => {
        const city = clip.detected_location?.city || clip.location?.city || "";
        return normalizeLabel(city) === normalizeLabel(city);
      });
      const cityGastronomyClips = cityClips.filter((clip) => {
        const categories = detectCategoriesFromClip(clip);
        return classifyGastronomyCoverage(categories) === "gastronomy_evidence";
      });
      coverageByCity[city] = {
        total_clips: cityClips.length,
        gastronomy_clips: cityGastronomyClips.length,
        gastronomy_ratio: round3(cityGastronomyClips.length / Math.max(1, cityClips.length)),
      };
    });
  }

  return {
    total_clips: totalClips,
    gastronomy_clips: gastronomyClips.length,
    non_gastronomy_clips: nonGastronomyClips.length,
    mixed_clips: mixedClips.length,
    gastronomy_coverage_ratio: gastronomyRatio,
    landmark_aerial_ratio: landmarkAerialRatio,
    bridge_river_ratio: bridgeRiverRatio,
    non_gastronomy_combined_ratio: round3(landmarkAerialRatio + bridgeRiverRatio),
    repeated_source_urls: repeatedSourceUrls.length,
    repeated_visual_families: repeatedVisualFamilies.length,
    repeated_landmarks: repeatedLandmarks.length,
    consecutive_visual_family_repeats: consecutiveRepeatCount,
    coverage_by_city: coverageByCity,
    max_global_coverage: visualContract?.max_global_coverage || {},
    required_global_coverage: visualContract?.required_global_coverage || {},
  };
};

// ─── Decisão QA ─────────────────────────────────────────────────────────────

const buildQaDecision = ({ coverageReport, visualAudit = [], state = {} }) => {
  const failures = [];
  const warnings = [];

  const isGastronomy = state.visual_contract?.dominant_theme === "gastronomy"
    || /gastronom/i.test(state.visual_contract?.video_topic || "");

  // Regra 1: gastronomy_coverage < 0.70
  if (isGastronomy && coverageReport.gastronomy_coverage_ratio < 0.70) {
    failures.push({
      rule: "gastronomy_coverage_minimum",
      detail: `gastronomy_coverage ${round3(coverageReport.gastronomy_coverage_ratio * 100)}% < 70% required`,
    });
  }

  // Regra 2: city_landmark + aerial + bridge + river > 0.25
  if (isGastronomy && coverageReport.non_gastronomy_combined_ratio > 0.25) {
    failures.push({
      rule: "max_non_gastronomy_coverage",
      detail: `non_gastronomy ${round3(coverageReport.non_gastronomy_combined_ratio * 100)}% > 25% max`,
    });
  }

  // Regra 3: Mais de 2 clips consecutivos da mesma visual_family
  if (coverageReport.consecutive_visual_family_repeats > 2) {
    failures.push({
      rule: "max_consecutive_visual_family",
      detail: `${coverageReport.consecutive_visual_family_repeats} consecutive visual_family repeats > 2 max`,
    });
  }

  // Regra 4: Mesmo source_url repetido
  if (coverageReport.repeated_source_urls > 0) {
    failures.push({
      rule: "no_source_url_repetition",
      detail: `${coverageReport.repeated_source_urls} source_urls repeated`,
    });
  }

  // Regra 5: Metadata fallback em slot crítico
  const metadataFallbackInCriticalSlot = visualAudit.some((row) =>
    row.visual_truth_status === "unknown" && row.clip_index > 0
  );
  if (metadataFallbackInCriticalSlot) {
    warnings.push({
      rule: "metadata_fallback_in_slot",
      detail: "metadata_fallback or unknown evidence detected in timeline",
    });
  }

  // Regra 6: Legendas ausentes se BURN_CAPTIONS=true
  if (config.BURN_CAPTIONS && state.caption_path_srt) {
    const captionsMissing = visualAudit.some((row) => row.caption_visible === false);
    if (captionsMissing) {
      failures.push({
        rule: "captions_required_but_missing",
        detail: "BURN_CAPTIONS=true but captions not visible in audit",
      });
    }
  }

  // Regra 7: Output diferente de 1920x1080
  const resolution = state.render_timeline?.output_resolution || "";
  if (config.OUTPUT_WIDTH === 1920 && config.OUTPUT_HEIGHT === 1080 && !resolution.includes("1920x1080")) {
    failures.push({
      rule: "incorrect_output_resolution",
      detail: `Output ${resolution} != 1920x1080`,
    });
  }

  // Regra 8: visual_contract não existe
  if (!state.visual_contract) {
    failures.push({
      rule: "missing_visual_contract",
      detail: "visual_contract not found in state",
    });
  }

  // Regra 9: approved_visual_evidence_pool não existe
  const approvedPool = state.approved_visual_evidence_pool || [];
  if (!approvedPool.length) {
    warnings.push({
      rule: "missing_approved_evidence_pool",
      detail: "approved_visual_evidence_pool empty or missing",
    });
  }

  // Regra 10: Cobertura por cidade
  if (isGastronomy && coverageReport.coverage_by_city) {
    Object.entries(coverageReport.coverage_by_city).forEach(([city, data]) => {
      if (data.gastronomy_ratio < 0.50) {
        failures.push({
          rule: "city_gastronomy_coverage",
          detail: `${city}: gastronomy ${round3(data.gastronomy_ratio * 100)}% < 50%`,
        });
      }
    });
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
    total_checks: failures.length + warnings.length,
    qa_timestamp: new Date().toISOString(),
  };
};

// ─── Geração de contact sheet (placeholder) ─────────────────────────────────

const generateContactSheet = async ({ renderPath, outputDir, videoId }) => {
  const contactSheetPath = path.join(outputDir, "contact_sheet.jpg");
  try {
    // Extrair frames a cada 30 segundos para contact sheet
    const framesDir = path.join(outputDir, "qa_frames");
    await fs.ensureDir(framesDir);

    await runFfmpeg([
      "-y",
      "-i", renderPath,
      "-vf", "fps=1/30,scale=320:180",
      path.join(framesDir, "frame_%03d.jpg"),
    ]);

    // Montar contact sheet 4xN com FFmpeg
    const frameFiles = (await fs.readdir(framesDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .slice(0, 20);

    if (frameFiles.length > 0) {
      // Montar tile com FFmpeg
      const tileWidth = Math.ceil(Math.sqrt(frameFiles.length));
      const inputs = frameFiles.map((f) => path.join(framesDir, f));
      const concatFile = path.join(framesDir, "frames.txt");
      const fileList = inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
      await fs.writeFile(concatFile, fileList, "utf8");

      await runFfmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatFile,
        "-vf", `tile=${tileWidth}x${Math.ceil(frameFiles.length / tileWidth)}:padding=4:color=black`,
        "-frames:v", "1",
        contactSheetPath,
      ]);

      logger.info("editorialQaService: contact sheet gerada", { videoId, frames: frameFiles.length });
    }
  } catch (error) {
    logger.warn("editorialQaService: contact sheet falhou", { videoId, message: error.message });
  }

  return contactSheetPath;
};

// ─── Endpoint principal ─────────────────────────────────────────────────────

const runEditorialQa = async ({ videoId }) => {
  const state = await loadState(videoId);
  const paths = await ensureVideoStructure(videoId);
  const reportsDir = path.join(paths.base, "reports");
  await fs.ensureDir(reportsDir);

  const clips = Array.isArray(state.render_timeline?.clips)
    ? state.render_timeline.clips
    : [];
  const microMoments = state.visual_contract?.micro_moments || [];
  const visualContract = state.visual_contract || null;

  if (!clips.length) {
    logger.warn("editorialQaService: sem clips na timeline", { videoId });
    return {
      video_id: videoId,
      passed: false,
      error: "no_clips_in_timeline",
    };
  }

  // 1. Visual Audit
  const visualAudit = buildVisualAudit({ clips, microMoments, visualContract });
  const auditPath = path.join(reportsDir, "visual_audit.json");
  await writeJsonAtomic(auditPath, visualAudit);

  // 2. Coverage Report
  const coverageReport = buildCoverageReport({ clips, microMoments, visualContract });
  const coveragePath = path.join(reportsDir, "coverage_report.json");
  await writeJsonAtomic(coveragePath, coverageReport);

  // 3. Contact Sheet
  const renderPath = state.render_path || paths.renderPath;
  const contactSheetPath = await generateContactSheet({
    renderPath,
    outputDir: reportsDir,
    videoId,
  });

  // 4. QA Decision
  const qaDecision = buildQaDecision({ coverageReport, visualAudit, state });
  const decisionPath = path.join(reportsDir, "qa_decision.json");
  await writeJsonAtomic(decisionPath, qaDecision);

  // 5. CSV audit
  try {
    const csvLines = [
      "timestamp_sec,expected_micro_moment_id,expected_visual_intent,clip_index,asset_id,visual_truth_status,is_match,mismatch_reason,repeated_asset,repeated_visual_family,caption_visible",
    ];
    visualAudit.forEach((row) => {
      csvLines.push([
        row.timestamp_sec,
        row.expected_micro_moment_id,
        row.expected_visual_intent,
        row.clip_index,
        row.asset_id,
        row.visual_truth_status,
        row.is_match,
        row.mismatch_reason,
        row.repeated_asset,
        row.repeated_visual_family,
        row.caption_visible,
      ].join(","));
    });
    await fs.writeFile(path.join(reportsDir, "visual_audit.csv"), csvLines.join("\n"), "utf8");
  } catch (error) {
    logger.warn("editorialQaService: CSV falhou", { message: error.message });
  }

  const updated = await updateState(videoId, {
    editorial_qa: {
      passed: qaDecision.passed,
      failures: qaDecision.failures,
      warnings: qaDecision.warnings,
      coverage_report: coverageReport,
      qa_decision: qaDecision,
      reports_dir: reportsDir,
    },
  });

  logger.info("editorialQaService: QA editorial concluído", {
    videoId,
    passed: qaDecision.passed,
    failures: qaDecision.failures.length,
    warnings: qaDecision.warnings.length,
  });

  return {
    video_id: videoId,
    passed: qaDecision.passed,
    failures: qaDecision.failures,
    warnings: qaDecision.warnings,
    reports: {
      visual_audit: auditPath,
      coverage_report: coveragePath,
      contact_sheet: contactSheetPath,
      qa_decision: decisionPath,
      visual_audit_csv: path.join(reportsDir, "visual_audit.csv"),
    },
  };
};

module.exports = {
  runEditorialQa,
  buildVisualAudit,
  buildCoverageReport,
  buildQaDecision,
  classifyGastronomyCoverage,
  GASTRONOMY_CATEGORIES,
  NON_GASTRONOMY_CATEGORIES,
  __test__: {
    buildVisualAudit,
    buildCoverageReport,
    buildQaDecision,
    classifyGastronomyCoverage,
  },
};
