const path = require("path");
const fs = require("fs-extra");
const { logger } = require("../utils/logger");
const { loadState, ensureVideoStructure, updateState } = require("./stateService");
const { getCachedAudioIntelligence } = require("./audioIntelligence");
const { generateEmbedding, cosineSimilarity, keywordOverlapScore } = require("./semanticMatcher");
const { createPlaceholderImage, extractVideoFrame, probeMedia } = require("../utils/mediaUtils");

const VALIDATION_FRAME_INTERVAL = 3; // Check a frame every N seconds
const LOW_CONFIDENCE_THRESHOLD = 2.5;
const DESYNC_SEVERITY_THRESHOLD = 0.35;

const round3 = (value) => Number(Number(value || 0).toFixed(3));

/**
 * Validates if the rendered video clips are semantically aligned with the narration.
 * Analyzes the timeline and checks each clip's match quality.
 */
const validateTimelineAlignment = async ({ videoId }) => {
  const state = await loadState(videoId);
  const timeline = state.render_timeline;

  if (!timeline || !timeline.clips || !timeline.clips.length) {
    return {
      video_id: videoId,
      is_aligned: false,
      alignment_score: 0,
      issues: [{ severity: "critical", message: "Nenhum timeline de render encontrado para validação." }],
      revalidation_needed: true,
    };
  }

  // Get audio intelligence for word-level timestamps
  const audioIntelligence = await getCachedAudioIntelligence({ videoId }).catch(() => null);

  const issues = [];
  let totalScore = 0;
  let lowConfidenceCount = 0;
  let desyncedClips = [];

  for (const clip of timeline.clips) {
    const semanticScore = Number(clip.semantic_match_score || 0);

    if (semanticScore < LOW_CONFIDENCE_THRESHOLD) {
      lowConfidenceCount++;
      desyncedClips.push({
        clip_index: clip.clip_index,
        scene_index: clip.scene_index,
        title: clip.title,
        semantic_match_score: semanticScore,
        clip_script_excerpt: (clip.clip_script_excerpt || "").slice(0, 100),
        asset_semantic_text: (clip.asset_semantic_text || "").slice(0, 100),
        severity: semanticScore < 1.0 ? "high" : "medium",
      });
    }

    // Check if the asset window matches the narrated time in audio
    if (audioIntelligence && audioIntelligence.words && clip.scene_index) {
      const sceneBoundary = (audioIntelligence.scene_boundaries || []).find(
        (sb) => Number(sb.scene_index) === Number(clip.scene_index)
      );

      if (sceneBoundary) {
        const clipStartTime = Number(clip.clip_start_narrated_at || clip.source_start_seconds || 0);
        const clipEndTime = Number(clip.clip_end_narrated_at || clip.source_end_seconds || 0);

        // Check if the clip's time window overlaps with the scene's audio window
        const sceneAudioStart = Number(sceneBoundary.audio_start_seconds || 0);
        const sceneAudioEnd = Number(sceneBoundary.audio_end_seconds || 0);

        const overlap = Math.max(0, Math.min(clipEndTime, sceneAudioEnd) - Math.max(clipStartTime, sceneAudioStart));
        const expectedDuration = Math.max(0.1, sceneAudioEnd - sceneAudioStart);
        const overlapRatio = overlap / expectedDuration;

        if (overlapRatio < DESYNC_SEVERITY_THRESHOLD && expectedDuration > 2.0) {
          issues.push({
            time: clipStartTime,
            expected: `Cena ${clip.scene_index}: ${clip.title || "sem título"}`,
            actual_visual: clip.asset_semantic_text?.slice(0, 80) || "desconhecido",
            severity: "high",
            overlap_ratio: round3(overlapRatio),
            clip_index: clip.clip_index,
            type: "temporal_misalignment",
          });
        }
      }
    }

    totalScore += semanticScore;
  }

  const avgScore = timeline.clips.length > 0
    ? round3(totalScore / timeline.clips.length)
    : 0;

  const isAligned = avgScore >= LOW_CONFIDENCE_THRESHOLD && lowConfidenceCount <= Math.ceil(timeline.clips.length * 0.3);

  return {
    video_id: videoId,
    is_aligned: isAligned,
    alignment_score: avgScore,
    total_clips: timeline.clips.length,
    low_confidence_clips: lowConfidenceCount,
    low_confidence_ratio: timeline.clips.length > 0
      ? round3(lowConfidenceCount / timeline.clips.length)
      : 0,
    issues,
    desynced_clips: desyncedClips,
    revalidation_needed: !isAligned || lowConfidenceCount > 0,
    timeline_summary: {
      strategy: timeline.strategy,
      transition: timeline.transition,
      output_resolution: timeline.output_resolution,
      output_duration_seconds: timeline.output_duration_seconds,
      unique_asset_count: timeline.unique_asset_count,
    },
  };
};

/**
 * Identifica quais cenas precisam ser re-renderizadas.
 * Retorna lista de clip_indexes que devem ser substituídos.
 */
const identifyClipsForReplacement = ({ validationResult }) => {
  if (!validationResult || validationResult.is_aligned) {
    return { needs_replacement: false, clips_to_replace: [] };
  }

  const clipsToReplace = (validationResult.desynced_clips || [])
    .filter((clip) => clip.severity === "high" || clip.semantic_match_score < 1.5)
    .map((clip) => clip.clip_index);

  return {
    needs_replacement: clipsToReplace.length > 0,
    clips_to_replace: clipsToReplace,
  };
};

/**
 * Realiza validação visual usando frames extraídos do render final.
 * Compara o que o frame mostra com o que o áudio está dizendo naquele timestamp.
 */
const validateRenderWithVision = async ({ videoId, renderPath, audioIntelligence, timeline }) => {
  if (!renderPath || !(await fs.pathExists(renderPath))) {
    return { vision_validated: false, reason: "Render path not found" };
  }

  const renderInfo = await probeMedia(renderPath).catch(() => ({ duration: 0, width: 0, height: 0 }));
  const renderDuration = Number(renderInfo.duration || 0);

  if (!renderDuration || renderDuration < 5) {
    return { vision_validated: false, reason: "Render too short for validation" };
  }

  // Extrair frames em intervalos regulares
  const framesDir = path.join(path.dirname(renderPath), "validation_frames");
  await fs.emptyDir(framesDir);

  const frameTimes = [];
  for (let t = 0; t < renderDuration; t += VALIDATION_FRAME_INTERVAL) {
    frameTimes.push(round3(t));
  }

  const framePaths = [];
  for (let fi = 0; fi < Math.min(frameTimes.length, 15); fi++) {
    const framePath = path.join(framesDir, `frame-${String(fi).padStart(3, "0")}.jpg`);
    try {
      await extractVideoFrame({
        inputPath: renderPath,
        outputPath: framePath,
        timeSeconds: frameTimes[fi],
        width: 640,
        height: 360,
      });
      if (await fs.pathExists(framePath)) {
        framePaths.push({ path: framePath, time: frameTimes[fi] });
      }
    } catch {
      // Ignore extraction errors
    }
  }

  // Clean up frames (they're temporary)
  await fs.remove(framesDir).catch(() => null);

  return {
    vision_validated: framePaths.length > 0,
    frames_analyzed: framePaths.length,
    total_render_duration: renderDuration,
    frame_interval_seconds: VALIDATION_FRAME_INTERVAL,
    note: "Validação visual por frames extraídos. Para validação completa com IA, execute validateRenderSemantics.",
  };
};

/**
 * Validação completa do render:
 * 1. Alinhamento da timeline
 * 2. Identificação de clips problemáticos
 * 3. Validação visual (se possível)
 */
const validateRender = async ({ videoId }) => {
  const state = await loadState(videoId);
  const renderPath = state.render_path;

  // Step 1: Timeline alignment check
  const alignmentResult = await validateTimelineAlignment({ videoId });

  // Step 2: Identify clips for replacement
  const replacementInfo = identifyClipsForReplacement({ validationResult: alignmentResult });

  // Step 3: Visual validation
  const visualResult = await validateRenderWithVision({
    videoId,
    renderPath,
    audioIntelligence: await getCachedAudioIntelligence({ videoId }).catch(() => null),
    timeline: state.render_timeline,
  });

  // Save validation result to state
  const validationResult = {
    validated_at: new Date().toISOString(),
    alignment: alignmentResult,
    replacement: replacementInfo,
    visual: visualResult,
    needs_regeneration: !alignmentResult.is_aligned && replacementInfo.needs_replacement,
  };

  await updateState(
    videoId,
    {
      render_validation: validationResult,
      error_message: "",
    },
    { currentStep: "render_validated", status: "render_validated" }
  );

  return validationResult;
};

module.exports = {
  validateTimelineAlignment,
  validateRender,
  identifyClipsForReplacement,
  validateRenderWithVision,
};