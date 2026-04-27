const fs = require("fs");
const { google } = require("googleapis");
const { config } = require("../config/env");
const { loadState, updateState } = require("./stateService");

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
    const nextState = await updateState(
      videoId,
      {
        youtube_video_id: fakeId,
        youtube_url: `https://youtube.com/watch?v=${fakeId}`,
        error_message: "",
      },
      {
        currentStep: "youtube_uploaded",
        status: "youtube_uploaded_mock",
      }
    );

    return {
      mocked: true,
      video_id: videoId,
      youtube_video_id: nextState.youtube_video_id,
      youtube_url: nextState.youtube_url,
      state_path: nextState.state_path,
    };
  }

  const oauth2Client = new google.auth.OAuth2(
    config.YOUTUBE_CLIENT_ID,
    config.YOUTUBE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );

  oauth2Client.setCredentials({
    refresh_token: config.YOUTUBE_REFRESH_TOKEN,
  });

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

  const nextState = await updateState(
    videoId,
    {
      youtube_video_id: youtubeId || "",
      youtube_url: youtubeUrl,
      error_message: "",
    },
    {
      currentStep: "youtube_uploaded",
      status: "youtube_uploaded",
    }
  );

  return {
    mocked: false,
    video_id: videoId,
    youtube_video_id: nextState.youtube_video_id,
    youtube_url: nextState.youtube_url,
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
    const oauth2Client = new google.auth.OAuth2(
      config.YOUTUBE_CLIENT_ID,
      config.YOUTUBE_CLIENT_SECRET,
      "https://developers.google.com/oauthplayground"
    );

    oauth2Client.setCredentials({
      refresh_token: config.YOUTUBE_REFRESH_TOKEN,
    });

    const youtube = google.youtube({ version: "v3", auth: oauth2Client });
    const channelResponse = await youtube.channels.list({
      part: ["id", "snippet"],
      mine: true,
      maxResults: 1,
    });

    const channel = channelResponse.data?.items?.[0];
    return {
      configured: true,
      ok: true,
      message: `Canal conectado: ${channel?.snippet?.title || "desconhecido"}`,
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