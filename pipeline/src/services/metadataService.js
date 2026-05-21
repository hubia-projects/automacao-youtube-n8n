const fs = require("fs-extra");
const { loadState, ensureVideoStructure, updateState } = require("./stateService");
const { generateMetadataWithOpenAI } = require("./openaiService");
const { sendTelegramMessage, buildFinalReviewMessage } = require("./telegramService");
const { publishReviewDraft } = require("./reviewPublishingService");
const { config } = require("../config/env");

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
          videoId,
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
      currentStep: "awaiting_final_approval",
      status: "awaiting_final_approval",
    }
  );

  const reviewPublication = await publishReviewDraft({
    videoId,
    state: nextState,
  }).catch(() => ({ published: false, state: nextState }));

  const stateForReview = reviewPublication.state || nextState;
  const reviewVersion = stateForReview.review?.draft_version || 1;
  const alreadySentSameVersion =
    Number(stateForReview.telegram?.final_review_version || 0) === Number(reviewVersion) &&
    Boolean(stateForReview.telegram?.final_review_message_id);

  const telegramResult = alreadySentSameVersion
    ? {
        configured: true,
        sent: false,
        skipped: true,
        reason: "duplicate_final_review_version",
        telegram_message_id: stateForReview.telegram?.final_review_message_id || null,
      }
    : await sendTelegramMessage({
        text: buildFinalReviewMessage({
          videoId,
          title: stateForReview.youtube_title,
          renderPath: stateForReview.render_path,
          tags: stateForReview.youtube_tags,
          reviewVersion,
          reviewUrl: stateForReview.review?.drive_view_url || "",
          sheetUrl: stateForReview.review?.sheet_url || "",
        }),
        parseMode: null,
      }).catch((error) => ({ sent: false, error: error.message }));

  const persistedState = telegramResult.telegram_message_id
    ? await updateState(videoId, {
        telegram: {
          chat_id: String(config.TELEGRAM_CHAT_ID || ""),
          final_review_message_id: telegramResult.telegram_message_id,
          final_review_version: reviewVersion,
          final_review_message_sent_at: new Date().toISOString(),
        },
      })
    : stateForReview;

  return {
    video_id: videoId,
    youtube_title: persistedState.youtube_title,
    youtube_description: persistedState.youtube_description,
    youtube_tags: persistedState.youtube_tags,
    youtube_chapters: persistedState.youtube_chapters,
    thumbnail_path: persistedState.thumbnail_path,
    telegram: telegramResult,
    state_path: persistedState.state_path,
  };
};

module.exports = {
  generateMetadata,
};
