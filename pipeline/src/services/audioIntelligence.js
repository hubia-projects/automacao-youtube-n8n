const path = require("path");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");
const { writeJsonAtomic, readJsonSafe } = require("../utils/fileUtils");
const { loadState, ensureVideoStructure, updateState } = require("./stateService");
const { transcribeWithWordTimestamps } = require("./openaiService");
const { buildMicroSegmentsFromAudio } = require("./microMomentPlannerService");

const FALLBACK_WPM = 144;
const unique = (values = []) => [...new Set(values.filter(Boolean))];
const CHAPTER_TRIGGER_PATTERN = /(agora|seguimos|vamos|depois|em seguida|partimos|proximo|next|chapter|capitulo)/i;

const normalizeLabel = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const tokenizeNormalizedWords = (value = "") =>
  normalizeLabel(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

const extractOriginalScriptWords = (value = "") =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => word.trim())
    .filter(Boolean);

const buildFallbackWordTiming = ({ scriptText = "", audioDuration = 0 }) => {
  const words = extractOriginalScriptWords(scriptText);
  const safeDuration = Math.max(5, Number(audioDuration || 0) || words.length / (FALLBACK_WPM / 60));
  const wordTimings = [];
  const wordsPerSecond = words.length / safeDuration;

  words.forEach((word, index) => {
    const wordDuration = (Math.random() * 0.08 + 0.33) / Math.max(0.1, wordsPerSecond);
    const start = Math.max(0, index / Math.max(1, wordsPerSecond) - wordDuration * 0.15);
    const end = Math.min(safeDuration, start + wordDuration);
    wordTimings.push({ word, start: Math.max(0, Number(start.toFixed(3))), end: Number(end.toFixed(3)), synthetic: true });
  });

  const segments = [];
  const segmentSize = Math.max(3, Math.ceil(words.length / Math.max(1, Math.ceil(safeDuration / 12))));
  for (let i = 0; i < wordTimings.length; i += segmentSize) {
    const segmentWords = wordTimings.slice(i, i + segmentSize);
    segments.push({
      text: segmentWords.map((w) => w.word).join(" "),
      start: segmentWords[0]?.start || 0,
      end: segmentWords[segmentWords.length - 1]?.end || safeDuration,
      confidence: 0.5,
      words: segmentWords,
    });
  }

  const pauseMarkers = [];
  for (let i = 1; i < wordTimings.length; i += 1) {
    const isSentenceEnd = /[.!?]$/.test(wordTimings[i - 1]?.word || "");
    if (isSentenceEnd) {
      pauseMarkers.push({
        start: wordTimings[i - 1].end,
        end: Math.min(safeDuration, wordTimings[i - 1].end + 0.3),
        duration: 0.3,
        type: "sentence_break",
      });
    }
  }

  return {
    words: wordTimings,
    segments,
    pause_markers: pauseMarkers,
    speaking_rate: {
      average_wps: Number(wordsPerSecond.toFixed(2)),
      total_duration_seconds: safeDuration,
      total_words: words.length,
      total_segments: segments.length,
    },
    provider: "fallback_estimation",
  };
};

const buildSemanticSceneBoundaries = async ({ scenes = [], audioIntelligence }) => {
  if (!audioIntelligence || !audioIntelligence.words || !audioIntelligence.words.length) {
    return scenes.map((scene, index) => {
      const totalScenes = scenes.length;
      const totalDuration = audioIntelligence?.speaking_rate?.total_duration_seconds || 0;
      const start = (index * totalDuration) / Math.max(1, totalScenes);
      const end = ((index + 1) * totalDuration) / Math.max(1, totalScenes);
      return {
        ...scene,
        audio_start_seconds: Number(start.toFixed(3)),
        audio_end_seconds: Number(end.toFixed(3)),
        audio_span_seconds: Number((end - start).toFixed(3)),
        boundary_confidence: 0.3,
      };
    });
  }

  const transcribedWords = audioIntelligence.words;
  const totalDuration = audioIntelligence.speaking_rate.total_duration_seconds;
  const boundaries = [];
  let lastWordIndex = -1;

  for (let si = 0; si < scenes.length; si += 1) {
    const scene = scenes[si];
    const spokenText = `${scene.title || ""} ${scene.narration_excerpt || ""} ${(scene.keywords || []).join(" ")}`;
    const sceneTerms = tokenizeNormalizedWords(spokenText);
    const uniqueTerms = unique(sceneTerms).filter((t) => t.length >= 3);

    if (!uniqueTerms.length) {
      const proportionalStart = lastWordIndex + 1 < transcribedWords.length
        ? transcribedWords[lastWordIndex + 1]?.start || 0
        : (si * totalDuration) / Math.max(1, scenes.length);
      const proportionalEnd = ((si + 1) * totalDuration) / Math.max(1, scenes.length);
      boundaries.push({
        scene_index: scene.scene_index,
        audio_start_seconds: Number(proportionalStart.toFixed(3)),
        audio_end_seconds: Number(proportionalEnd.toFixed(3)),
        audio_span_seconds: Number((proportionalEnd - proportionalStart).toFixed(3)),
        boundary_confidence: 0.2,
        anchor_word: "",
      });
      continue;
    }

    let firstMatchIndex = -1;
    for (let ti = Math.max(0, lastWordIndex); ti < transcribedWords.length; ti += 1) {
      const twNorm = normalizeLabel(transcribedWords[ti]?.word || "");
      if (uniqueTerms.includes(twNorm) || uniqueTerms.some((t) => twNorm.includes(t) || t.includes(twNorm))) {
        firstMatchIndex = ti;
        break;
      }
    }

    let lastMatchIndex = firstMatchIndex;
    if (firstMatchIndex >= 0) {
      const searchEnd = Math.min(transcribedWords.length, firstMatchIndex + Math.ceil(transcribedWords.length / scenes.length) * 2);
      for (let ti = firstMatchIndex + 1; ti < searchEnd; ti += 1) {
        const twNorm = normalizeLabel(transcribedWords[ti]?.word || "");
        if (uniqueTerms.includes(twNorm) || uniqueTerms.some((t) => twNorm.includes(t) || t.includes(twNorm))) {
          lastMatchIndex = ti;
        }
      }
    }

    const startTime = firstMatchIndex >= 0
      ? transcribedWords[firstMatchIndex].start
      : (lastWordIndex >= 0 && lastWordIndex < transcribedWords.length - 1
        ? (transcribedWords[lastWordIndex + 1]?.start || ((si * totalDuration) / Math.max(1, scenes.length)))
        : (si * totalDuration) / Math.max(1, scenes.length));
    const endTime = lastMatchIndex >= 0 && lastMatchIndex < transcribedWords.length
      ? transcribedWords[lastMatchIndex].end
      : (((si + 1) * totalDuration) / Math.max(1, scenes.length));

    boundaries.push({
      scene_index: scene.scene_index,
      audio_start_seconds: Number(startTime.toFixed(3)),
      audio_end_seconds: Number(endTime.toFixed(3)),
      audio_span_seconds: Number((endTime - startTime).toFixed(3)),
      boundary_confidence: firstMatchIndex >= 0 ? 0.85 : 0.3,
      anchor_word: firstMatchIndex >= 0 ? transcribedWords[firstMatchIndex].word : "",
    });

    lastWordIndex = lastMatchIndex >= 0 ? lastMatchIndex : lastWordIndex + Math.ceil(transcribedWords.length / scenes.length);
  }

  for (let i = 1; i < boundaries.length; i += 1) {
    const prev = boundaries[i - 1];
    const curr = boundaries[i];
    if (curr.audio_start_seconds < prev.audio_end_seconds) {
      const midpoint = (prev.audio_end_seconds + curr.audio_start_seconds) / 2;
      prev.audio_end_seconds = Number(midpoint.toFixed(3));
      prev.audio_span_seconds = Number((prev.audio_end_seconds - prev.audio_start_seconds).toFixed(3));
      curr.audio_start_seconds = Number(midpoint.toFixed(3));
      curr.audio_span_seconds = Number((curr.audio_end_seconds - curr.audio_start_seconds).toFixed(3));
    }
  }

  return scenes.map((scene) => ({ ...scene, ...(boundaries.find((item) => item.scene_index === scene.scene_index) || {}) }));
};

const buildChapterTriggers = ({ scenes = [], sceneBoundaries = [], words = [] }) => {
  if (!Array.isArray(sceneBoundaries) || !sceneBoundaries.length) return [];

  const wordsSafe = Array.isArray(words) ? words : [];
  return sceneBoundaries
    .filter((boundary) => Number(boundary.scene_index || 0) > 1)
    .map((boundary) => {
      const timestamp = Number(boundary.audio_start_seconds || 0);
      const nearWordIndex = wordsSafe.findIndex((word) => Number(word.start || 0) >= Math.max(0, timestamp - 0.25));
      const windowWords = nearWordIndex >= 0
        ? wordsSafe.slice(Math.max(0, nearWordIndex - 3), nearWordIndex + 4).map((word) => word.word).filter(Boolean)
        : [];
      const cueText = windowWords.join(" ");
      const hasCue = CHAPTER_TRIGGER_PATTERN.test(cueText);
      const boundaryConfidence = Number(boundary.boundary_confidence || 0.35);

      return {
        scene_index: Number(boundary.scene_index || 0),
        timestamp_sec: Number(timestamp.toFixed(3)),
        anchor_word: boundary.anchor_word || wordsSafe[nearWordIndex]?.word || "",
        cue_text: cueText,
        cue_detected: hasCue,
        confidence: Number(Math.max(boundaryConfidence, hasCue ? 0.85 : 0.55).toFixed(3)),
        source: hasCue ? "word_level_transition_cue" : "scene_boundary",
      };
    });
};

const analyzeAudio = async ({ videoId }) => {
  const state = await loadState(videoId);
  const paths = await ensureVideoStructure(videoId);
  if (!state.audio_path) throw new Error("Áudio não encontrado para análise de timestamps.");

  logger.info(`audioIntelligence: iniciando análise de áudio para video ${videoId}`);
  let audioIntelligence = null;
  let provider = "none";

  try {
    const whisperData = await transcribeWithWordTimestamps({ audioPath: state.audio_path });
    if (whisperData && whisperData.words && whisperData.words.length > 3) {
      audioIntelligence = whisperData;
      provider = "openai_whisper_word_timestamps";
      logger.info(`audioIntelligence: transcrição concluída com ${whisperData.words.length} palavras`);
    }
  } catch (error) {
    logger.warn("audioIntelligence: falha na transcrição word-level OpenAI, usando fallback", { message: error.message });
  }

  if (!audioIntelligence) {
    const audioDuration = Math.max(10, Number(state.duration_seconds || 0));
    audioIntelligence = buildFallbackWordTiming({ scriptText: state.script_text || state.topic || "roteiro", audioDuration });
    provider = "fallback_proportional";
  }

  const scenes = Array.isArray(state.visual_plan) && state.visual_plan.length ? state.visual_plan : [];
  const sceneBoundaries = scenes.length ? await buildSemanticSceneBoundaries({ scenes, audioIntelligence }) : [];
  const chapterTriggers = buildChapterTriggers({
    scenes,
    sceneBoundaries,
    words: audioIntelligence.words,
  });
  const microSegments = buildMicroSegmentsFromAudio({
    words: audioIntelligence.words,
    segments: audioIntelligence.segments,
    pauseMarkers: audioIntelligence.pause_markers,
  });
  const audioIntelligenceData = {
    video_id: videoId,
    provider,
    analyzed_at: new Date().toISOString(),
    audio_path: state.audio_path,
    ...audioIntelligence,
    micro_segments: microSegments,
    scene_boundaries: sceneBoundaries,
    chapter_triggers: chapterTriggers,
  };

  const audioIntelligencePath = path.join(paths.base, "audio", "audio_intelligence.json");
  await writeJsonAtomic(audioIntelligencePath, audioIntelligenceData);

  const nextState = await updateState(videoId, {
    audio_intelligence_path: audioIntelligencePath,
    scene_boundaries: sceneBoundaries,
    chapter_triggers: chapterTriggers,
    audio_intelligence_provider: provider,
    error_message: "",
  }, { currentStep: "audio_intelligence_ready", status: "audio_intelligence_ready" });

  return {
    video_id: videoId,
    audio_intelligence_path: audioIntelligencePath,
    scene_boundaries: sceneBoundaries,
    provider,
    words_count: audioIntelligence.words.length,
    pause_markers_count: audioIntelligence.pause_markers.length,
    micro_segments_count: microSegments.length,
    chapter_triggers_count: chapterTriggers.length,
    state_path: nextState.state_path,
  };
};

const getCachedAudioIntelligence = async ({ videoId }) => {
  const state = await loadState(videoId).catch(() => null);
  if (state?.audio_intelligence_path) {
    const payload = await readJsonSafe(state.audio_intelligence_path, null);
    if (payload?.words?.length) return payload;
  }
  const paths = await ensureVideoStructure(videoId);
  const audioIntelligencePath = path.join(paths.base, "audio", "audio_intelligence.json");
  return readJsonSafe(audioIntelligencePath, null);
};

module.exports = {
  analyzeAudio,
  getCachedAudioIntelligence,
  buildFallbackWordTiming,
  buildSemanticSceneBoundaries,
  buildChapterTriggers,
  __test__: {
    tokenizeNormalizedWords,
    extractOriginalScriptWords,
    buildFallbackWordTiming,
    buildChapterTriggers,
  },
};
