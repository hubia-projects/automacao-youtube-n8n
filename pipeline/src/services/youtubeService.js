const fs = require("fs");
const { google } = require("googleapis");
const { config } = require("../config/env");
const { loadState, updateState } = require("./stateService");
const { sendWorkflowStatus } = require("./telegramService");

const YOUTUBE_CAPTION_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const YOUTUBE_PARTNER_SCOPE = "https://www.googleapis.com/auth/youtubepartner";

const createYoutubeOAuthClient = () => {
  const oauth2Client = new google.auth.OAuth2(
    config.YOUTUBE_CLIENT_ID,
    config.YOUTUBE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );

  oauth2Client.setCredentials({
    refresh_token: config.YOUTUBE_REFRESH_TOKEN,
  });

  return oauth2Client;
};

const getYoutubeScopes = async (oauth2Client) => {
  try {
    const accessTokenResponse = await oauth2Client.getAccessToken();
    const accessToken = accessTokenResponse?.token || accessTokenResponse;

    if (!accessToken) {
      return [];
    }

    const tokenInfo = await oauth2Client.getTokenInfo(accessToken);
    return Array.isArray(tokenInfo?.scopes) ? tokenInfo.scopes : [];
  } catch {
    return [];
  }
};

const hasCaptionUploadScope = (scopes = []) =>
  scopes.includes(YOUTUBE_CAPTION_SCOPE) || scopes.includes(YOUTUBE_PARTNER_SCOPE);

const resolveCaptionUploadSource = (state) => {
  if (state.caption_path_srt && fs.existsSync(state.caption_path_srt)) {
    return {
      filePath: state.caption_path_srt,
      format: "srt",
    };
  }

  if (state.caption_path_vtt && fs.existsSync(state.caption_path_vtt)) {
    return {
      filePath: state.caption_path_vtt,
      format: "vtt",
    };
  }

  return null;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForYoutubeVideoReady = async ({ youtube, youtubeId, attempts = 6, intervalMs = 10000 }) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await youtube.videos.list({
        part: ["processingDetails", "status"],
        id: [youtubeId],
      });

      const item = response.data?.items?.[0];
      const processingStatus = item?.processingDetails?.processingStatus || "";
      const uploadStatus = item?.status?.uploadStatus || "";

      if (processingStatus === "failed" || uploadStatus === "rejected") {
        return {
          ready: false,
          failed: true,
          processingStatus,
          uploadStatus,
        };
      }

      if (
        processingStatus === "succeeded" ||
        uploadStatus === "processed"
      ) {
        return {
          ready: true,
          processingStatus,
          uploadStatus,
        };
      }
    } catch {
      return {
        ready: true,
        processingStatus: "",
        uploadStatus: "",
      };
    }

    if (attempt < attempts) {
      await wait(intervalMs);
    }
  }

  return {
    ready: true,
    processingStatus: "timeout",
    uploadStatus: "",
  };
};

const buildCaptionUploadResult = ({
  trackId = "",
  status = "",
  format = "",
  errorMessage = "",
  message = "",
}) => ({
  message,
  statePatch: {
    youtube_caption_track_id: trackId,
    youtube_caption_language: format ? config.YOUTUBE_CAPTION_LANGUAGE : "",
    youtube_caption_format: format,
    youtube_caption_status: status,
    youtube_caption_error_message: errorMessage,
  },
});

const uploadCaptionTrack = async ({ youtube, oauth2Client, state, youtubeId }) => {
  const captionSource = resolveCaptionUploadSource(state);

  if (!captionSource) {
    return buildCaptionUploadResult({
      status: "skipped_no_caption",
      message: "Nenhuma legenda SRT/VTT encontrada para anexar ao YouTube.",
    });
  }

  const scopes = await getYoutubeScopes(oauth2Client);
  if (scopes.length > 0 && !hasCaptionUploadScope(scopes)) {
    return buildCaptionUploadResult({
      status: "skipped_missing_scope",
      format: captionSource.format,
      errorMessage: `YOUTUBE_REFRESH_TOKEN sem escopo ${YOUTUBE_CAPTION_SCOPE}.`,
      message: `Legenda não enviada: renove o token com ${YOUTUBE_CAPTION_SCOPE}.`,
    });
  }

  const readiness = await waitForYoutubeVideoReady({ youtube, youtubeId });
  if (readiness.failed) {
    return buildCaptionUploadResult({
      status: "failed_video_processing",
      format: captionSource.format,
      errorMessage: `Vídeo não ficou pronto para legenda (${readiness.processingStatus || readiness.uploadStatus || "estado_desconhecido"}).`,
      message: "Legenda não enviada: o vídeo ainda não ficou pronto para receber a trilha.",
    });
  }

  try {
    const response = await youtube.captions.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          videoId: youtubeId,
          language: config.YOUTUBE_CAPTION_LANGUAGE,
          name: config.YOUTUBE_CAPTION_NAME,
          isDraft: false,
        },
      },
      media: {
        body: fs.createReadStream(captionSource.filePath),
      },
    });

    return buildCaptionUploadResult({
      trackId: response.data?.id || "",
      status: "uploaded",
      format: captionSource.format,
      message: `Legenda ${captionSource.format.toUpperCase()} anexada ao player do YouTube.`,
    });
  } catch (error) {
    return buildCaptionUploadResult({
      status: "failed",
      format: captionSource.format,
      errorMessage: error.message,
      message: `Legenda não enviada: ${error.message}.`,
    });
  }
};

const hasYoutubeCredentials = () =>
  Boolean(
    config.YOUTUBE_CLIENT_ID &&
      config.YOUTUBE_CLIENT_SECRET &&
      config.YOUTUBE_REFRESH_TOKEN
  );

const uploadToYoutube = async ({ videoId, mockMode = false, privacyStatus = config.YOUTUBE_DEFAULT_PRIVACY }) => {
  const state = await loadState(videoId);

  if (!state.approved) {
    throw new Error("Upload bloqueado: aprovação final não foi confirmada.");
  }

  if (!state.render_path || !fs.existsSync(state.render_path)) {
    throw new Error("Arquivo de vídeo final não encontrado para upload.");
  }

  if (mockMode || !hasYoutubeCredentials()) {
    const fakeId = `mock_${videoId.slice(0, 8)}`;
    const mockCaptionSource = resolveCaptionUploadSource(state);
    const nextState = await updateState(
      videoId,
      {
        youtube_video_id: fakeId,
        youtube_url: `https://youtube.com/watch?v=${fakeId}`,
        youtube_privacy_status: privacyStatus || config.YOUTUBE_DEFAULT_PRIVACY,
        youtube_caption_track_id: mockCaptionSource ? `mock_caption_${videoId.slice(0, 8)}` : "",
        youtube_caption_language: mockCaptionSource ? config.YOUTUBE_CAPTION_LANGUAGE : "",
        youtube_caption_format: mockCaptionSource?.format || "",
        youtube_caption_status: mockCaptionSource ? "uploaded_mock" : "skipped_no_caption",
        youtube_caption_error_message: "",
        error_message: "",
      },
      {
        currentStep: "youtube_uploaded",
        status: "youtube_uploaded_mock",
      }
    );

    await sendWorkflowStatus({
      videoId,
      title: "Upload concluído",
      icon: "📺",
      lines: [
        `Modo mock ativo. URL gerada: ${nextState.youtube_url}`,
        mockCaptionSource ? `Legenda ${mockCaptionSource.format.toUpperCase()} simulada no player.` : null,
      ],
    }).catch(() => null);

    return {
      mocked: true,
      video_id: videoId,
      youtube_video_id: nextState.youtube_video_id,
      youtube_url: nextState.youtube_url,
      youtube_privacy_status: nextState.youtube_privacy_status,
      youtube_caption_status: nextState.youtube_caption_status,
      youtube_caption_track_id: nextState.youtube_caption_track_id,
      state_path: nextState.state_path,
    };
  }

  const oauth2Client = createYoutubeOAuthClient();
  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: state.youtube_title || state.topic,
        description: state.youtube_description || "",
        tags: state.youtube_tags || [],
        categoryId: "19",
      },
      status: {
        privacyStatus,
      },
    },
    media: {
      body: fs.createReadStream(state.render_path),
    },
  });

  const youtubeId = response.data?.id;
  const youtubeUrl = youtubeId ? `https://youtube.com/watch?v=${youtubeId}` : "";
  const captionUpload = youtubeId
    ? await uploadCaptionTrack({
        youtube,
        oauth2Client,
        state,
        youtubeId,
      })
    : buildCaptionUploadResult({
        status: "failed",
        errorMessage: "Upload do vídeo não retornou youtube_video_id.",
        message: "Legenda não enviada: o YouTube não retornou o ID do vídeo.",
      });

  const nextState = await updateState(
    videoId,
    {
      youtube_video_id: youtubeId || "",
      youtube_url: youtubeUrl,
      youtube_privacy_status: privacyStatus || config.YOUTUBE_DEFAULT_PRIVACY,
      ...captionUpload.statePatch,
      error_message: "",
    },
    {
      currentStep: "youtube_uploaded",
      status: "youtube_uploaded",
    }
  );

  await sendWorkflowStatus({
    videoId,
    title: "Upload concluído",
    icon: "📺",
    lines: [
      nextState.youtube_url || "Vídeo enviado ao YouTube com sucesso.",
      nextState.youtube_caption_status !== "skipped_no_caption" ? captionUpload.message : null,
    ].filter(Boolean),
  }).catch(() => null);

  return {
    mocked: false,
    video_id: videoId,
    youtube_video_id: nextState.youtube_video_id,
    youtube_url: nextState.youtube_url,
    youtube_privacy_status: nextState.youtube_privacy_status,
    youtube_caption_status: nextState.youtube_caption_status,
    youtube_caption_track_id: nextState.youtube_caption_track_id,
    state_path: nextState.state_path,
  };
};

const basicYoutubeHealthcheck = async () => {
  if (!hasYoutubeCredentials()) {
    return {
      configured: false,
      ok: false,
      message: "Credenciais YouTube ausentes (client_id/client_secret/refresh_token)",
    };
  }

  try {
    const oauth2Client = createYoutubeOAuthClient();
    const scopes = await getYoutubeScopes(oauth2Client);

    if (!scopes.length) {
      throw new Error("Não foi possível obter scopes do access token do YouTube.");
    }

    const captionScopePresent = hasCaptionUploadScope(scopes);

    return {
      configured: true,
      ok: true,
      captions_ok: captionScopePresent,
      required_caption_scope: YOUTUBE_CAPTION_SCOPE,
      message: scopes.length
        ? captionScopePresent
          ? `OAuth refresh OK. Scopes: ${scopes.slice(0, 4).join(", ")}`
          : `OAuth refresh OK, mas captions.insert exige ${YOUTUBE_CAPTION_SCOPE}. Scopes atuais: ${scopes.slice(0, 4).join(", ")}`
        : "OAuth refresh OK.",
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      message: error.message,
    };
  }
};

module.exports = {
  uploadToYoutube,
  basicYoutubeHealthcheck,
};