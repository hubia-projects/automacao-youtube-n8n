const fs = require("fs-extra");
const { loadState, ensureVideoStructure, updateState } = require("./stateService");
const { generateMetadataWithOpenAI } = require("./openaiService");
const { sendTelegramMessage, buildFinalReviewMessage } = require("./telegramService");

const buildMockMetadata = ({ topic }) => ({
  title: `${topic} em 2026: Guia Completo para Viajar Melhor`,
  description: `Vídeo completo sobre ${topic} com custos, curiosidades, dicas práticas e roteiro otimizado para quem quer viajar melhor.`,
  tags: [topic, "viagem", "dicas de viagem", "custo de vida", "destinos"],
  chapters: [
    "00:00 Introdução",
    "00:45 Panorama",
    "03:00 Custos",
    "06:00 Ranking",
    "09:00 Conclusão",
  ],
  thumbnail_prompt: `Thumbnail cinematográfica sobre ${topic}, cores vibrantes, alto contraste, texto curto e chamativo`,
});

const createSimpleThumbnail = async (thumbnailPath) => {
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+f4kAAAAASUVORK5CYII=";
  await fs.writeFile(thumbnailPath, Buffer.from(pngBase64, "base64"));
  return thumbnailPath;
};

const generateMetadata = async ({ videoId, mockMode = false }) => {
  const state = await loadState(videoId);
  const paths = await ensureVideoStructure(videoId);

  const metadata = !mockMode
    ?
        (await generateMetadataWithOpenAI({
          topic: state.topic,
          scriptText: state.script_text,
        })) || buildMockMetadata({ topic: state.topic })
    : buildMockMetadata({ topic: state.topic });

  await createSimpleThumbnail(paths.thumbnailPath);

  const nextState = await updateState(
    videoId,
    {
      thumbnail_path: paths.thumbnailPath,
      youtube_title: metadata.title || state.youtube_title,
      youtube_description: metadata.description || state.youtube_description,
      youtube_tags: metadata.tags || state.youtube_tags || [],
      youtube_chapters: metadata.chapters || state.youtube_chapters || [],
      error_message: "",
    },
    {
      currentStep: "metadata_generated",
      status: "awaiting_final_approval",
    }
  );

  const telegramResult = await sendTelegramMessage({
    text: buildFinalReviewMessage({
      videoId,
      title: nextState.youtube_title,
      renderPath: nextState.render_path,
      tags: nextState.youtube_tags,
    }),
  }).catch((error) => ({ sent: false, error: error.message }));

  return {
    video_id: videoId,
    youtube_title: nextState.youtube_title,
    youtube_description: nextState.youtube_description,
    youtube_tags: nextState.youtube_tags,
    youtube_chapters: nextState.youtube_chapters,
    thumbnail_path: nextState.thumbnail_path,
    telegram: telegramResult,
    state_path: nextState.state_path,
  };
};

module.exports = {
  generateMetadata,
};
