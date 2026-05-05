const { updateState, loadState } = require("../src/services/stateService");
const { generateScript } = require("../src/services/scriptService");
const { generateAudio } = require("../src/services/ttsService");
const { analyzeAudio } = require("../src/services/audioIntelligence");
const { generateCaptions } = require("../src/services/captionsService");
const { generateAssets } = require("../src/services/assetsService");
const { renderVideo } = require("../src/services/renderService");
const { validateRender, fixRenderSync } = require("../src/services/syncValidator");
const { uploadToYoutube } = require("../src/services/youtubeService");

const topic = "5 melhores países da Europa para visitar no verão";
const angle = "ranking prático com praia, clima, cidades bonitas, vida noturna e custo-benefício";

const title = "5 Melhores Países da Europa Para Visitar no Verão";
const description = [
  "Teste geral do pipeline de vídeo com IA.",
  "Neste vídeo, o ranking destaca países europeus fortes para uma viagem de verão, equilibrando clima, paisagens, cidades e experiência turística.",
  "Upload enviado ao YouTube para validação completa do fluxo.",
].join(" ");

const tags = [
  "europa verão",
  "melhores países europa",
  "viagem europa verão",
  "destinos europa",
  "férias na europa",
  "summer europe travel",
];

const logStep = (message, extra = null) => {
  const prefix = `[summer-europe] ${new Date().toISOString()} ${message}`;
  if (extra) {
    console.log(prefix, extra);
    return;
  }
  console.log(prefix);
};

const run = async () => {
  const videoId = `summer_europe_${Date.now()}`;

  logStep("run iniciado", { videoId, topic });

  await updateState(
    videoId,
    {
      topic,
      angle,
      selected_idea: { topic, angle },
      approved: false,
      error_message: "",
    },
    {
      currentStep: "idea_approved",
      status: "idea_approved",
    }
  );
  logStep("estado inicial salvo");

  logStep("gerando roteiro");
  await generateScript({ videoId, mockMode: false, topic });
  logStep("roteiro gerado");

  await updateState(videoId, {
    youtube_title: title,
    youtube_description: description,
    youtube_tags: tags,
    youtube_chapters: [
      "00:00 Introdução",
      "00:40 Critérios do ranking",
      "02:00 País 5",
      "03:30 País 4",
      "05:00 País 3",
      "06:30 País 2",
      "08:00 País 1",
      "09:30 Conclusão",
    ],
  });
  logStep("metadata base preparada");

  logStep("gerando áudio via OpenAI TTS");
  const audio = await generateAudio({ videoId, mockMode: false, provider: "openai" });
  logStep("áudio gerado", { provider: audio.provider, voice: audio.voice });

  logStep("rodando audio intelligence");
  const audioIntelligence = await analyzeAudio({ videoId });
  logStep("audio intelligence concluída", { provider: audioIntelligence.provider });

  logStep("gerando captions");
  const captions = await generateCaptions({ videoId, mockMode: false });
  logStep("captions geradas", { srt: captions.caption_path_srt, vtt: captions.caption_path_vtt });

  logStep("buscando assets reais");
  const assets = await generateAssets({ videoId, mockMode: false, maxAssets: 5, minVideoDuration: 8 });
  logStep("assets concluídos", { total: assets.assets_json?.items?.length || assets.assets_count || 0 });

  logStep("renderizando vídeo");
  await renderVideo({ videoId, mockMode: false });
  logStep("render concluído");

  logStep("validando render");
  const validationBeforeFix = await validateRender({ videoId });
  let validationAfterFix = null;
  if (validationBeforeFix.needs_regeneration) {
    logStep("validação pediu fix-sync", {
      issues: (validationBeforeFix.issues || []).map((issue) => issue.type),
    });
    validationAfterFix = await fixRenderSync({ videoId, mockMode: false });
    logStep("fix-sync concluído", {
      issues: (validationAfterFix.issues || []).map((issue) => issue.type),
    });
  }

  const finalValidation = validationAfterFix || validationBeforeFix;
  logStep("validação final consolidada", {
    is_publishable: finalValidation.is_publishable,
    needs_regeneration: finalValidation.needs_regeneration,
    quality_score: finalValidation.quality_score,
  });

  if (finalValidation.needs_regeneration || !finalValidation.is_publishable) {
    throw new Error(
      `Validação final reprovou o vídeo antes do upload: ${JSON.stringify((finalValidation.issues || []).map((issue) => issue.type))}`
    );
  }

  await updateState(
    videoId,
    {
      approved: true,
      error_message: "",
    },
    {
      currentStep: "final_approved",
      status: "final_approved",
    }
  );
  logStep("estado aprovado para upload");

  logStep("iniciando upload no YouTube");
  const upload = await uploadToYoutube({
    videoId,
    mockMode: false,
    privacyStatus: "unlisted",
  });
  logStep("upload concluído", {
    youtube_url: upload.youtube_url,
    youtube_video_id: upload.youtube_video_id,
    youtube_privacy_status: upload.youtube_privacy_status,
  });

  const finalState = await loadState(videoId);

  console.log(
    JSON.stringify(
      {
        video_id: videoId,
        topic,
        youtube_title: finalState.youtube_title,
        youtube_url: upload.youtube_url,
        youtube_video_id: upload.youtube_video_id,
        youtube_privacy_status: upload.youtube_privacy_status,
        youtube_caption_status: upload.youtube_caption_status,
        state_path: finalState.state_path,
        audio_provider: audio.provider,
        audio_voice: audio.voice,
        audio_intelligence_provider: audioIntelligence.provider,
        captions: {
          srt: finalState.caption_path_srt,
          vtt: finalState.caption_path_vtt,
        },
        assets: {
          total: finalState.assets_json?.items?.length || 0,
          providers: [...new Set((finalState.assets_json?.items || []).map((item) => item.provider))],
        },
        render: {
          total_clips: finalState.render_timeline?.total_clips || 0,
          unique_asset_count: finalState.render_timeline?.unique_asset_count || 0,
          output_resolution: finalState.render_timeline?.output_resolution || "",
          output_duration_seconds: finalState.render_timeline?.output_duration_seconds || 0,
          semantic_alignment_score_average: finalState.render_timeline?.semantic_alignment_score_average || 0,
          low_confidence_clip_count: finalState.render_timeline?.low_confidence_clip_count || 0,
        },
        validation: {
          is_publishable: finalValidation.is_publishable,
          needs_regeneration: finalValidation.needs_regeneration,
          quality_score: finalValidation.quality_score,
          alignment_score: finalValidation.alignment_score,
          diversity_score: finalValidation.diversity_score,
          visual_intent_distribution: finalValidation.visual_intent_distribution,
          issues: (finalValidation.issues || []).map((issue) => ({
            type: issue.type,
            severity: issue.severity,
            message: issue.message || "",
          })),
        },
      },
      null,
      2
    )
  );
};

run().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: error.message,
        stack: error.stack,
      },
      null,
      2
    )
  );
  process.exit(1);
});