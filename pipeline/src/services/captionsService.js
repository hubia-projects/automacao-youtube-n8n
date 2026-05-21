const { ensureVideoStructure, updateState, loadState } = require("./stateService");
const { writeTextAtomic } = require("../utils/fileUtils");
const { transcribeWithOpenAI } = require("./openaiService");
const { sendWorkflowStatus } = require("./telegramService");

const toTimestamp = (totalSeconds) => {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(Math.floor(totalSeconds % 60)).padStart(2, "0");
  const millis = String(Math.round((totalSeconds % 1) * 1000)).padStart(3, "0");
  return { srt: `${hours}:${minutes}:${seconds},${millis}`, vtt: `${hours}:${minutes}:${seconds}.${millis}` };
};

const buildLocalCaptions = ({ scriptText, durationSeconds = 90 }) => {
  const lines = (scriptText || "")
    .replace(/\n+/g, " ")
    .split(/[.!?]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);

  const safeLines = lines.length ? lines : ["Este vídeo foi gerado em modo de teste."];
  const segment = Math.max(3, durationSeconds / safeLines.length);

  const srt = [];
  const vtt = ["WEBVTT", ""];

  safeLines.forEach((line, index) => {
    const start = toTimestamp(index * segment);
    const end = toTimestamp((index + 1) * segment);

    srt.push(`${index + 1}\n${start.srt} --> ${end.srt}\n${line}\n`);
    vtt.push(`${start.vtt} --> ${end.vtt}\n${line}\n`);
  });

  return {
    srt: srt.join("\n"),
    vtt: vtt.join("\n"),
  };
};

const generateCaptions = async ({ videoId, mockMode = false }) => {
  const state = await loadState(videoId);
  if (!state.audio_path) {
    throw new Error("Áudio não encontrado. Gere áudio antes das legendas.");
  }

  const paths = await ensureVideoStructure(videoId);

  let srt = null;
  let vtt = null;
  let provider = "local_fallback";

  if (!mockMode) {
    try {
      const transcriptionText = await transcribeWithOpenAI({
        audioPath: state.audio_path,
        format: "text",
        videoId,
      });

      if (transcriptionText) {
        const generated = buildLocalCaptions({
          scriptText: transcriptionText,
          durationSeconds: Number(state.duration_seconds || 95),
        });
        srt = generated.srt;
        vtt = generated.vtt;
        provider = "openai_transcription_local_segments";
      }
    } catch {
      provider = "local_fallback";
    }
  }

  if (!srt || !vtt) {
    const local = buildLocalCaptions({
      scriptText: state.script_text,
      durationSeconds: Number(state.duration_seconds || 95),
    });
    srt = local.srt;
    vtt = local.vtt;
  }

  await Promise.all([
    writeTextAtomic(paths.captionSrtPath, srt),
    writeTextAtomic(paths.captionVttPath, vtt),
  ]);

  const nextState = await updateState(
    videoId,
    {
      caption_path_srt: paths.captionSrtPath,
      caption_path_vtt: paths.captionVttPath,
      error_message: "",
    },
    {
      currentStep: "captions_generated",
      status: "captions_generated",
    }
  );

  await sendWorkflowStatus({
    videoId,
    title: "Legendas geradas",
    icon: "💬",
    lines: [`Provider usado: ${provider}.`],
  }).catch(() => null);

  return {
    video_id: videoId,
    caption_path_srt: nextState.caption_path_srt,
    caption_path_vtt: nextState.caption_path_vtt,
    provider,
    state_path: nextState.state_path,
  };
};

module.exports = {
  generateCaptions,
};
