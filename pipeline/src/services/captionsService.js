const { ensureVideoStructure, updateState, loadState } = require("./stateService");
const { writeTextAtomic, readJsonSafe } = require("../utils/fileUtils");
const { transcribeWithGemini } = require("./geminiService");
const { getCachedAudioIntelligence } = require("./audioIntelligence");
const { sendWorkflowStatus } = require("./telegramService");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");

const DEFAULT_MAX_CHARS_PER_LINE = 42;
const DEFAULT_MAX_LINES_PER_CUE = 2;
const DEFAULT_MAX_CUE_DURATION_SEC = 4;
const DEFAULT_MIN_CUE_DURATION_SEC = 1.0;

const toTimestamp = (totalSeconds) => {
  const safe = Math.max(0, Number(totalSeconds || 0));
  const hours = String(Math.floor(safe / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
  const seconds = String(Math.floor(safe % 60)).padStart(2, "0");
  const millis = String(Math.round((safe % 1) * 1000)).padStart(3, "0");
  return { srt: `${hours}:${minutes}:${seconds},${millis}`, vtt: `${hours}:${minutes}:${seconds}.${millis}` };
};

// Quebra uma string em ≤maxLinesPerCue linhas de até maxCharsPerLine caracteres cada,
// preservando palavras inteiras. Retorna { lines, droppedWords } para o caller poder
// signalizar overflow e iniciar nova cue com as palavras não incluídas.
const wrapTextIntoLines = (text = "", maxCharsPerLine = DEFAULT_MAX_CHARS_PER_LINE, maxLinesPerCue = DEFAULT_MAX_LINES_PER_CUE) => {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [], droppedWords: [] };

  const lines = [];
  let currentLine = "";
  let consumedUpTo = -1;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      currentLine = candidate;
      consumedUpTo = i;
      continue;
    }
    // Flush currentLine (se cheia) para nova linha
    if (currentLine) {
      lines.push(currentLine);
      currentLine = "";
      if (lines.length >= maxLinesPerCue) {
        consumedUpTo = i - 1;
        break;
      }
    }
    // Palavra única maior que maxCharsPerLine: aceita isolated na próxima linha
    if (word.length > maxCharsPerLine) {
      lines.push(word);
      consumedUpTo = i;
      if (lines.length >= maxLinesPerCue) {
        consumedUpTo = i;
        break;
      }
      currentLine = "";
      continue;
    }
    currentLine = word;
    consumedUpTo = i;
  }
  if (currentLine && lines.length < maxLinesPerCue) {
    lines.push(currentLine);
    consumedUpTo = words.length - 1;
  }

  const droppedWords = consumedUpTo >= 0 ? words.slice(consumedUpTo + 1) : words.slice(0);
  return { lines: lines.slice(0, maxLinesPerCue), droppedWords };
};

// Constrói cues SRT/VTT a partir de audio_intelligence.words/segments.
// Respeita:
//   - maxCharsPerLine (42)
//   - maxLinesPerCue (2)
//   - maxCueDurationSec (4)
//   - minCueDurationSec (1.0)
// Filtra duration < 0.05s fundindo com palavra anterior.
const buildCaptionsFromAudioIntelligence = ({
  words = [],
  segments = [],
  options = {},
}) => {
  const maxCharsPerLine = Number(options.maxCharsPerLine || DEFAULT_MAX_CHARS_PER_LINE);
  const maxLinesPerCue = Number(options.maxLinesPerCue || DEFAULT_MAX_LINES_PER_CUE);
  const maxCueDurationSec = Number(options.maxCueDurationSec || DEFAULT_MAX_CUE_DURATION_SEC);
  const minCueDurationSec = Number(options.minCueDurationSec || DEFAULT_MIN_CUE_DURATION_SEC);
  const maxCharsPerCue = maxCharsPerLine * maxLinesPerCue;

  const cleanedWords = (Array.isArray(words) ? words : [])
    .filter((w) => w && w.word)
    .map((w) => ({
      word: String(w.word || "").replace(/\s+/g, " ").trim(),
      start: Math.max(0, Number(w.start || 0)),
      end: Math.max(0, Number(w.end || w.start || 0)),
    }))
    .filter((w) => w.word && w.end >= w.start && (w.end - w.start) >= 0.05);

  if (!cleanedWords.length) return { cues: [], lines_count: 0, segments_count: 0 };

  const lastCleanedEnd = cleanedWords[cleanedWords.length - 1].end;
  const cues = [];
  let currentText = "";
  let currentStart = cleanedWords[0].start;
  let currentEnd = cleanedWords[0].end;
  let consumedCursorIndex = 0;

  const flushCue = ({ start, end, text }) => {
    const wrapped = wrapTextIntoLines(text, maxCharsPerLine, maxLinesPerCue);
    if (!wrapped.lines.length) return { dropped: wrapped.droppedWords };
    const safeStart = Math.max(0, Number(start.toFixed(3)));
    const safeEnd = Math.max(safeStart + 0.5, Number(end.toFixed(3)));
    cues.push({
      start: safeStart,
      end: safeEnd,
      duration_sec: Number((safeEnd - safeStart).toFixed(3)),
      text,
      lines: wrapped.lines,
    });
    return { dropped: wrapped.droppedWords };
  };

  for (let cursorIndex = 0; cursorIndex < cleanedWords.length; cursorIndex += 1) {
    const w = cleanedWords[cursorIndex];
    const wDuration = w.end - w.start;
    const tentativeDuration = w.end - currentStart;
    const tentativeChars = (currentText ? currentText.length + 1 : 0) + w.word.length;

    const exceedsDuration = tentativeDuration > maxCueDurationSec && currentText;
    const exceedsChars = tentativeChars > maxCharsPerCue && currentText;

    if (exceedsDuration || exceedsChars) {
      let cueEnd = Math.max(currentEnd, currentStart + minCueDurationSec);
      if (cueEnd - currentStart > maxCueDurationSec) cueEnd = currentStart + maxCueDurationSec;
      const flushResult = flushCue({ start: currentStart, end: cueEnd, text: currentText });
      const leftover = flushResult.dropped || [];
      // Cada leftover word vira cue própria para preservar timestamps individuais.
      // Usamos findIndex por equality (left-over words vêm de wrapTextIntoLines
      // chamado sobre currentText, que é o texto construído das cleanedWords em
      // ordem cronológica — então o lwWord correspondente está sempre em
      // cleanedWords em start >= currentStart; findIndex devolve o primeiro match
      // em ordem de leitura).
      for (let lwi = 0; lwi < leftover.length; lwi += 1) {
        const lwText = leftover[lwi];
        const lwIndex = cleanedWords.findIndex(
          (cw) => cw.start >= currentStart && cw.word === lwText
        );
        if (lwIndex < 0) continue;
        const lwWord = cleanedWords[lwIndex];
        const lwStart = Math.max(cueEnd, lwWord.start);
        const lwEnd = Math.max(lwStart + 0.5, Math.min(lastCleanedEnd + 1, lwWord.end + 0.2));
        if (lwEnd - lwStart < 0.5) continue;
        cues.push({
          start: Number(lwStart.toFixed(3)),
          end: Number(lwEnd.toFixed(3)),
          duration_sec: Number((lwEnd - lwStart).toFixed(3)),
          text: lwText,
          lines: [lwText],
        });
      }
      consumedCursorIndex = cursorIndex;
      currentText = w.word;
      currentStart = w.start;
      currentEnd = w.end;
    } else {
      currentText = currentText ? `${currentText} ${w.word}` : w.word;
      currentEnd = w.end;
      consumedCursorIndex = cursorIndex;
    }
  }

  if (currentText) {
    let cueEnd = Math.max(currentEnd, currentStart + minCueDurationSec);
    if (cueEnd - currentStart > maxCueDurationSec) cueEnd = currentStart + maxCueDurationSec;
    flushCue({ start: currentStart, end: cueEnd, text: currentText });
  }

  // Garantir não-overlap (cues ordenados cronologicamente)
  for (let i = 1; i < cues.length; i += 1) {
    const prev = cues[i - 1];
    const curr = cues[i];
    if (curr.start < prev.end) {
      const midpoint = Number(((prev.end + curr.start) / 2).toFixed(3));
      prev.end = midpoint;
      prev.duration_sec = Number((prev.end - prev.start).toFixed(3));
      curr.start = midpoint;
      curr.duration_sec = Number((curr.end - curr.start).toFixed(3));
    }
  }

  // Ignorar cues com duration < 0.5s (YouTube rejeita)
  const filteredCues = cues.filter((cue) => cue.duration_sec >= 0.5);

  return {
    cues: filteredCues,
    lines_count: filteredCues.length,
    segments_count: Array.isArray(segments) ? segments.length : 0,
    source_word_count: cleanedWords.length,
  };
};

// Helper: retorna o end da última palavra (ou 0 se vazio)
const safeEndOfAudio = (words = []) => {
  const last = Array.isArray(words) ? words[words.length - 1] : null;
  return last ? Number(last.end || 0) : 0;
};

// Formata cues em SRT e VTT
const formatCaptionsToSrtVtt = ({ cues = [] }) => {
  const srt = [];
  const vtt = ["WEBVTT", ""];

  cues.forEach((cue, idx) => {
    const start = toTimestamp(cue.start);
    const end = toTimestamp(cue.end);
    const text = (Array.isArray(cue.lines) ? cue.lines.join("\n") : String(cue.text || ""));
    srt.push(`${idx + 1}\n${start.srt} --> ${end.srt}\n${text}\n`);
    vtt.push(`${start.vtt} --> ${end.vtt}\n${text}\n`);
  });

  return {
    srt: srt.join("\n"),
    vtt: vtt.join("\n"),
  };
};

// Fallback proporcional baseado em script_text (sem audio_intelligence real).
// Substitui o buildLocalCaptions com slice(0,12) por uma versão que gera
// 35-70 linhas para vídeos de 3 min, com chunkWordsBudget para garantir cues legíveis.
const buildFallbackProportionalCaptions = ({
  scriptText = "",
  durationSeconds = 0,
  options = {},
}) => {
  const maxCharsPerLine = Number(options.maxCharsPerLine || DEFAULT_MAX_CHARS_PER_LINE);
  const maxLinesPerCue = Number(options.maxLinesPerCue || DEFAULT_MAX_LINES_PER_CUE);
  const targetCueDurationSec = Number(options.targetCueDurationSec || DEFAULT_MAX_CUE_DURATION_SEC);
  const targetWps = Number(options.targetWps || 2.4);
  const safeDuration = Math.max(30, Number(durationSeconds || 0) || (scriptText.split(/\s+/).length / targetWps));
  const avgCharsPerWord = 6;
  const maxCharsPerCue = maxCharsPerLine * maxLinesPerCue;
  const chunkWordsBudget = Math.max(4, Math.ceil(maxCharsPerCue / avgCharsPerWord));

  const text = String(scriptText || "").replace(/\s+/g, " ").trim();
  const sentences = (text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text]).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) sentences.push(text);

  const expectedCueCount = Math.max(35, Math.min(70, Math.round(safeDuration / targetCueDurationSec)));
  const cueDuration = Math.max(1.0, safeDuration / expectedCueCount);

  const fallbackWords = text.split(/\s+/).filter(Boolean);
  const avgWps = fallbackWords.length / safeDuration;
  let computedCursor = 0;
  const wordTimings = fallbackWords.map((word) => {
    const wDur = Math.max(0.1, 1 / Math.max(0.1, avgWps));
    const start = computedCursor;
    const end = start + wDur;
    computedCursor = end;
    return { word, start, end };
  });

  // Split sentences em micro-chunks respeitando chunkWordsBudget, sem quebrar palavras em sentences
  const microChunks = [];
  for (const sentence of sentences) {
    const sWords = sentence.split(/\s+/).filter(Boolean);
    for (let i = 0; i < sWords.length; i += chunkWordsBudget) {
      const slice = sWords.slice(i, i + chunkWordsBudget).join(" ").trim();
      if (slice) microChunks.push(slice);
    }
  }
  if (!microChunks.length) microChunks.push(text);

  const cues = [];
  let cursorIndex = 0;
  for (let i = 0; i < microChunks.length; i += 1) {
    const chunk = microChunks[i];
    const startTime = cursorIndex < wordTimings.length
      ? wordTimings[cursorIndex].start
      : (i / microChunks.length) * safeDuration;
    const endTime = Math.min(safeDuration, startTime + cueDuration);
    const wrapped = wrapTextIntoLines(chunk, maxCharsPerLine, maxLinesPerCue);
    if (!wrapped.lines.length) {
      cursorIndex = Math.min(wordTimings.length, cursorIndex + chunk.split(/\s+/).length);
      if (cues.length >= 70) break;
      continue;
    }
    cues.push({
      start: Number(startTime.toFixed(3)),
      end: Number(endTime.toFixed(3)),
      duration_sec: Number((endTime - startTime).toFixed(3)),
      text: chunk,
      lines: wrapped.lines,
    });
    cursorIndex = Math.min(wordTimings.length, cursorIndex + chunk.split(/\s+/).length);
    if (cues.length >= 70) break;
  }

  return {
    cues,
    lines_count: cues.length,
    source_word_count: fallbackWords.length,
    proportional_estimation: true,
  };
};

const generateCaptions = async ({ videoId, mockMode = false }) => {
  const state = await loadState(videoId);
  if (!state.audio_path) {
    throw new Error("Áudio não encontrado. Gere áudio antes das legendas.");
  }

  const paths = await ensureVideoStructure(videoId);
  const requireRealCaptions = Boolean(config.REQUIRE_REAL_CAPTIONS) && !mockMode;
  const cachedAi = await getCachedAudioIntelligence({ videoId }).catch(() => null);
  const audioIntelligenceWords = (cachedAi?.words && cachedAi.words.length) || [];

  let srt = null;
  let vtt = null;
  let provider = "local_fallback";
  let captionQuality = "estimated";
  let needsManualReview = Boolean(requireRealCaptions);

  // Path 1: real captions de audio_intelligence.words (Whisper/ffmpeg-derived)
  if (audioIntelligenceWords.length) {
    const fromAi = buildCaptionsFromAudioIntelligence({
      words: audioIntelligenceWords,
      segments: cachedAi?.segments || state?.audio_intelligence?.segments || [],
    });
    if (fromAi.lines_count > 0) {
      const formatted = formatCaptionsToSrtVtt({ cues: fromAi.cues });
      srt = formatted.srt;
      vtt = formatted.vtt;
      provider = "audio_intelligence_words";
      captionQuality = "real";
      needsManualReview = false;
    }
  }

  // Path 2: try Gemini real transcription (não usa words/segments — apenas texto), depois gerar fallback
  if (!srt && !mockMode) {
    try {
      const transcriptionText = await transcribeWithGemini({
        audioPath: state.audio_path,
        format: "text",
        videoId,
      });
      if (transcriptionText && transcriptionText.length >= 50) {
        const fallback = buildFallbackProportionalCaptions({
          scriptText: transcriptionText,
          durationSeconds: Number(state.duration_seconds || 95),
        });
        if (fallback.lines_count > 0) {
          const formatted = formatCaptionsToSrtVtt({ cues: fallback.cues });
          srt = formatted.srt;
          vtt = formatted.vtt;
          provider = "gemini_transcription_proportional";
          captionQuality = "estimated";
        }
      }
    } catch (err) {
      logger.warn("captionsService: Gemini transcription falhou, fallback local", { message: err.message });
    }
  }

  // Path 3: fallback proporcional determinístico do script_text local
  if (!srt) {
    const fallback = buildFallbackProportionalCaptions({
      scriptText: state.script_text || "",
      durationSeconds: Number(state.duration_seconds || 95),
    });
    if (fallback.lines_count > 0) {
      const formatted = formatCaptionsToSrtVtt({ cues: fallback.cues });
      srt = formatted.srt;
      vtt = formatted.vtt;
      provider = "script_proportional_local";
      captionQuality = "estimated";
    }
  }

  if (!srt || !vtt) {
    // Em último recurso: 1 linha dummy
    const start = toTimestamp(0);
    const end = toTimestamp(Number(state.duration_seconds || 5));
    const text = "Este vídeo foi gerado em modo de teste.";
    srt = `1\n${start.srt} --> ${end.srt}\n${text}\n`;
    vtt = `WEBVTT\n\n${start.vtt} --> ${end.vtt}\n${text}\n`;
    provider = "fallback_minimal";
    captionQuality = "estimated";
  }

  await Promise.all([
    writeTextAtomic(paths.captionSrtPath, srt),
    writeTextAtomic(paths.captionVttPath, vtt),
  ]);

  const linesCount = srt.split(/\n\s*\n/).length;

  const nextState = await updateState(
    videoId,
    {
      caption_path_srt: paths.captionSrtPath,
      caption_path_vtt: paths.captionVttPath,
      caption_provider: provider,
      caption_quality: captionQuality,
      caption_lines_count: linesCount,
      caption_generated_at: new Date().toISOString(),
      needs_manual_review: needsManualReview ? true : Boolean(state.needs_manual_review || false),
      error_message: "",
    },
    {
      currentStep: "captions_generated",
      status: needsManualReview ? "captions_generated_needs_manual_review" : "captions_generated",
    }
  );

  await sendWorkflowStatus({
    videoId,
    title: "Legendas geradas",
    icon: "💬",
    lines: [
      `Provider: ${provider}.`,
      `Quality: ${captionQuality}.`,
    ],
  }).catch(() => null);

  logger.info("captionsService: legendagem concluída", {
    provider,
    captionQuality,
    linesCount,
    requireRealCaptions,
  });

  return {
    video_id: videoId,
    caption_path_srt: nextState.caption_path_srt,
    caption_path_vtt: nextState.caption_path_vtt,
    provider,
    caption_quality: captionQuality,
    lines_count: linesCount,
    needs_manual_review: needsManualReview,
    state_path: nextState.state_path,
  };
};

module.exports = {
  generateCaptions,
  buildCaptionsFromAudioIntelligence,
  buildFallbackProportionalCaptions,
  formatCaptionsToSrtVtt,
  wrapTextIntoLines,
  __test__: {
    buildCaptionsFromAudioIntelligence,
    buildFallbackProportionalCaptions,
    formatCaptionsToSrtVtt,
    wrapTextIntoLines,
  },
};
