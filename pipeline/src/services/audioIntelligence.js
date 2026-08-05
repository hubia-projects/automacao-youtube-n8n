const path = require("path");
const { execSync } = require("child_process");
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

// Cálculo determinístico (sem Math.random) de duração por palavra.
// Fórmula: base + len*coeff + first/last penalty + punctuation terminal penalty.
// Determinístico garante que o mesmo input → mesmo output em todas as execuções.
const computeDeterministicWordDuration = ({ word = "", wordsPerSecond = 2.4, isFirst = false, isLast = false }) => {
  const base = 1 / Math.max(0.1, wordsPerSecond);
  const lengthPenalty = Math.min(0.4, Math.max(0, String(word || "").length - 4) * 0.02);
  const boundaryPenalty = (isFirst || isLast) ? 0.08 : 0;
  const endsWithPunctuation = /[.!?]\s*$/.test(String(word || ""));
  const punctuationPenalty = endsWithPunctuation ? 0.15 : 0;
  const nonWordNoise = /^[^\\p{L}\\p{N}]+$/u.test(String(word || "").trim()) ? -0.05 : 0;
  return Math.max(0.12, base + lengthPenalty + boundaryPenalty + punctuationPenalty + nonWordNoise);
};

const buildFallbackWordTiming = ({ scriptText = "", audioDuration = 0, seed = "deterministic" }) => {
  const words = extractOriginalScriptWords(scriptText);
  const safeDuration = Math.max(5, Number(audioDuration || 0) || words.length / (FALLBACK_WPM / 60));
  const wordsPerSecond = words.length / safeDuration;

  // Primeira passagem: durações deterministicas
  const computed = words.map((word, index) => {
    const isFirst = index === 0;
    const isLast = index === words.length - 1;
    return {
      word,
      rawDuration: computeDeterministicWordDuration({ word, wordsPerSecond, isFirst, isLast }),
    };
  });

  // Segunda passagem: ajuste proporcional para fechar exatamente safeDuration
  const totalRaw = computed.reduce((acc, item) => acc + item.rawDuration, 0) || 1;
  const scale = safeDuration / totalRaw;

  let cursor = 0;
  const wordTimings = computed.map((item, index) => {
    const wordDuration = Math.max(0.1, item.rawDuration * scale);
    const start = Math.max(0, cursor);
    const end = Math.min(safeDuration, start + wordDuration);
    cursor = end;
    return {
      word: item.word,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      synthetic: true,
      deterministic: true,
      seed,
    };
  });

  // Filtrar durações <0.05s fundindo com vizinha anterior para evitar cue-flicker
  for (let i = wordTimings.length - 1; i >= 1; i -= 1) {
    const duration = wordTimings[i].end - wordTimings[i].start;
    if (duration < 0.05) {
      wordTimings[i - 1].end = wordTimings[i].end;
      wordTimings.splice(i, 1);
    }
  }

  const segments = [];
  const segmentCount = Math.max(1, Math.ceil(safeDuration / 12));
  const targetWordsPerSegment = Math.max(3, Math.ceil(words.length / segmentCount));
  for (let i = 0; i < wordTimings.length; i += targetWordsPerSegment) {
    const segmentWords = wordTimings.slice(i, i + targetWordsPerSegment);
    if (!segmentWords.length) continue;
    segments.push({
      text: segmentWords.map((w) => w.word).join(" "),
      start: segmentWords[0].start,
      end: segmentWords[segmentWords.length - 1].end,
      confidence: 0.5,
      words: segmentWords,
    });
  }

  const pauseMarkers = [];
  for (let i = 1; i < wordTimings.length; i += 1) {
    const isSentenceEnd = /[.!?]\s*$/.test(wordTimings[i - 1]?.word || "");
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
    provider: "fallback_proportional_deterministic",
    timing_estimated: true,
    seed,
  };
};

// Constrói scene boundaries a partir dos silêncios FFmpeg reais.
// Quando n_silences ≈ n_scenes, cada intervalo de fala entre silêncios corresponde a uma cena.
const buildSceneBoundariesFromSilences = ({ scenes, ffmpegMarkers, audioDuration }) => {
  if (!ffmpegMarkers.length || !scenes.length) return null;

  const sorted = [...ffmpegMarkers].sort((a, b) => a.start - b.start);
  const nScenes = scenes.length;
  const nSilences = sorted.length;

  // Só usa este método quando n_silences está próximo de n_scenes (±20%)
  if (nSilences < nScenes * 0.7 || nSilences > nScenes * 1.5) return null;

  // Constrói segmentos de fala: [0, sil[0].start], [sil[0].end, sil[1].start], ...
  const segments = [];
  let prevEnd = 0;
  for (const sil of sorted) {
    if (sil.start > prevEnd + 0.05) {
      segments.push({ start: prevEnd, end: sil.start });
    }
    prevEnd = sil.end;
  }
  if (prevEnd < audioDuration - 0.1) {
    segments.push({ start: prevEnd, end: audioDuration });
  }

  // Se há mais segmentos que cenas, mescla os menores com o anterior
  while (segments.length > nScenes && segments.length > 1) {
    let minIdx = 0;
    for (let i = 1; i < segments.length; i++) {
      if ((segments[i].end - segments[i].start) < (segments[minIdx].end - segments[minIdx].start)) minIdx = i;
    }
    const mergeWith = minIdx === 0 ? 1 : minIdx - 1;
    const lo = Math.min(minIdx, mergeWith);
    const hi = Math.max(minIdx, mergeWith);
    segments.splice(lo, 2, { start: segments[lo].start, end: segments[hi].end });
  }

  // Mapeia scenes para segmentos
  return scenes.map((scene, i) => {
    const seg = segments[i] || segments[segments.length - 1];
    return {
      ...scene,
      audio_start_seconds: Number(seg.start.toFixed(3)),
      audio_end_seconds: Number(seg.end.toFixed(3)),
      audio_span_seconds: Number((seg.end - seg.start).toFixed(3)),
      boundary_confidence: 0.92,
      boundary_source: "ffmpeg_silence",
    };
  });
};

const buildSemanticSceneBoundaries = async ({ scenes = [], audioIntelligence, ffmpegMarkers = [] }) => {
  // Prioridade 1: boundaries baseados em silêncios reais do FFmpeg
  const audioDuration = audioIntelligence?.speaking_rate?.total_duration_seconds || 0;
  if (ffmpegMarkers.length > 0 && audioDuration > 0) {
    const ffmpegBoundaries = buildSceneBoundariesFromSilences({ scenes, ffmpegMarkers, audioDuration });
    if (ffmpegBoundaries) {
      return ffmpegBoundaries;
    }
  }
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

// Detecta pausas reais no áudio usando FFmpeg (>= 0.35s = entre frases; >= 1.5s = transição de tópico)
const detectSilenceWithFFmpeg = ({ audioPath }) => {
  try {
    const output = execSync(
      `ffmpeg -i "${audioPath}" -af silencedetect=noise=-30dB:d=0.35 -f null - 2>&1`,
      { timeout: 60000, encoding: "utf8" }
    );
    const markers = [];
    const startRe = /silence_start:\s*([\d.]+)/g;
    const endRe = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g;
    const starts = [...output.matchAll(startRe)].map((m) => Number(m[1]));
    const ends = [...output.matchAll(endRe)].map((m) => ({ end: Number(m[1]), duration: Number(m[2]) }));
    for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
      markers.push({
        start: starts[i],
        end: ends[i].end,
        duration: ends[i].duration,
        type: ends[i].duration >= 1.5 ? "topic_transition" : "sentence_break",
        source: "ffmpeg_silencedetect",
      });
    }
    return markers;
  } catch {
    return [];
  }
};

const mergeWithFFmpegPauses = ({ pauseMarkers, ffmpegMarkers }) => {
  if (!ffmpegMarkers.length) return pauseMarkers;
  const merged = [...ffmpegMarkers];
  for (const pm of pauseMarkers) {
    const overlaps = ffmpegMarkers.some((fm) => Math.abs(fm.start - pm.start) < 0.5);
    if (!overlaps) merged.push(pm);
  }
  return merged.sort((a, b) => a.start - b.start);
};

const analyzeAudio = async ({ videoId }) => {
  const state = await loadState(videoId);
  const paths = await ensureVideoStructure(videoId);
  if (!state.audio_path) throw new Error("Áudio não encontrado para análise de timestamps.");

  logger.info(`audioIntelligence: iniciando análise de áudio para video ${videoId}`);
  let audioIntelligence = null;
  let provider = "none";

  // Primary: OpenAI Whisper com word-level timestamps reais
  try {
    const whisperResult = await transcribeWithWordTimestamps({ audioPath: state.audio_path, videoId });
    if (whisperResult && whisperResult.words && whisperResult.words.length > 0) {
      audioIntelligence = whisperResult;
      provider = "whisper_word_timestamps";
      logger.info(`audioIntelligence: Whisper concluído — ${audioIntelligence.words.length} palavras, ${audioIntelligence.pause_markers.length} pausas reais`);
    }
  } catch (error) {
    logger.warn("audioIntelligence: Whisper falhou, tentando fallback", { message: error.message });
  }

  // Fallback: timing proporcional baseado no script
  if (!audioIntelligence) {
    const audioDuration = Math.max(10, Number(state.duration_seconds || 0));
    audioIntelligence = buildFallbackWordTiming({ scriptText: state.script_text || state.topic || "roteiro", audioDuration });
    provider = "fallback_proportional";
    logger.info(`audioIntelligence: usando timing proporcional com ${audioIntelligence.words.length} palavras`);
  }

  // Garantir que total_duration_seconds reflita duração real do áudio
  const realAudioDuration = Math.max(10, Number(state.duration_seconds || 0));
  if (audioIntelligence.speaking_rate && realAudioDuration > audioIntelligence.speaking_rate.total_duration_seconds) {
    audioIntelligence.speaking_rate.total_duration_seconds = realAudioDuration;
  }

  // Suplemento: pausas reais via FFmpeg silencedetect (independente do provider)
  const ffmpegMarkers = detectSilenceWithFFmpeg({ audioPath: state.audio_path });
  if (ffmpegMarkers.length > 0) {
    audioIntelligence.pause_markers = mergeWithFFmpegPauses({
      pauseMarkers: audioIntelligence.pause_markers || [],
      ffmpegMarkers,
    });
    logger.info(`audioIntelligence: FFmpeg detectou ${ffmpegMarkers.length} silêncios reais — total pausas: ${audioIntelligence.pause_markers.length}`);
  }

  const scenes = Array.isArray(state.visual_plan) && state.visual_plan.length ? state.visual_plan : [];
  const sceneBoundaries = scenes.length
    ? await buildSemanticSceneBoundaries({ scenes, audioIntelligence, ffmpegMarkers })
    : [];
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

  const isTimingEstimated = audioIntelligence.timing_estimated === true
    || provider === "fallback_proportional"
    || provider === "fallback_proportional_deterministic";

  const nextState = await updateState(videoId, {
    audio_intelligence_path: audioIntelligencePath,
    scene_boundaries: sceneBoundaries,
    chapter_triggers: chapterTriggers,
    audio_intelligence_provider: provider,
    audio_intelligence_timing_estimated: isTimingEstimated,
    caption_quality_expected: isTimingEstimated ? "estimated" : "real",
    error_message: "",
  }, { currentStep: "audio_intelligence_ready", status: "audio_intelligence_ready" });

  return {
    video_id: videoId,
    audio_intelligence_path: audioIntelligencePath,
    scene_boundaries: sceneBoundaries,
    provider,
    timing_estimated: isTimingEstimated,
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
