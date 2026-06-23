const fs = require("fs");
const { google } = require("googleapis");
const { config } = require("../config/env");
const { loadState, updateState } = require("./stateService");
const { sendWorkflowStatus } = require("./telegramService");
const {
  consumeExternalCallBudget,
  isProviderDisabledInLocalTest,
  getExternalApiStats,
} = require("./externalApiControlService");
const { runFfmpeg, probeMedia } = require("../utils/mediaUtils");

const YOUTUBE_CAPTION_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const YOUTUBE_PARTNER_SCOPE = "https://www.googleapis.com/auth/youtubepartner";
const unique = (values = []) => [...new Set((values || []).filter(Boolean))];
const getMinimumVideoDurationSeconds = () => Math.max(0, Number(config.MIN_VIDEO_DURATION_SECONDS || 480));

const getRenderDurationSnapshot = async (renderPath = "") => {
  const resolvedRenderPath = String(renderPath || "").trim();
  const minVideoDurationSeconds = getMinimumVideoDurationSeconds();
  if (!resolvedRenderPath || !fs.existsSync(resolvedRenderPath)) {
    return {
      has_render_file: false,
      render_duration_seconds: 0,
      render_duration_pass: false,
      min_video_duration_seconds: minVideoDurationSeconds,
    };
  }

  const info = await probeMedia(resolvedRenderPath).catch(() => ({ duration: 0 }));
  const renderDurationSeconds = Number(info.duration || 0);
  return {
    has_render_file: true,
    render_duration_seconds: renderDurationSeconds,
    render_duration_pass: renderDurationSeconds >= minVideoDurationSeconds,
    min_video_duration_seconds: minVideoDurationSeconds,
  };
};

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

const getYoutubeScopesInfo = async (oauth2Client) => {
  try {
    const accessTokenResponse = await oauth2Client.getAccessToken();
    const accessToken = accessTokenResponse?.token || accessTokenResponse;

    if (!accessToken) {
      return {
        scopes: [],
        errorMessage: "Access token do YouTube nao retornado a partir do refresh token.",
      };
    }

    const tokenInfo = await oauth2Client.getTokenInfo(accessToken);
    return {
      scopes: Array.isArray(tokenInfo?.scopes) ? tokenInfo.scopes : [],
      errorMessage: "",
    };
  } catch (error) {
    return {
      scopes: [],
      errorMessage: error?.message || "Falha ao renovar access token do YouTube.",
    };
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

  const { scopes, errorMessage } = await getYoutubeScopesInfo(oauth2Client);
  if (!scopes.length && errorMessage) {
    return buildCaptionUploadResult({
      status: "skipped_oauth_error",
      format: captionSource.format,
      errorMessage,
      message: `Legenda nao enviada: OAuth YouTube falhou (${errorMessage}).`,
    });
  }

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

const hasProviderCredentials = () =>
  Boolean(config.PEXELS_API_KEY || config.PIXABAY_API_KEY);

const resolveEffectiveRenderValidation = (renderValidation = {}) => {
  const hasActualIsPublishable = typeof renderValidation.actual_is_publishable === "boolean";
  const hasActualNeedsRegeneration = typeof renderValidation.actual_needs_regeneration === "boolean";
  const hasActualNeedsManualReview = typeof renderValidation.actual_needs_manual_review === "boolean";

  return {
    is_publishable: hasActualIsPublishable
      ? renderValidation.actual_is_publishable === true
      : renderValidation.is_publishable === true,
    needs_regeneration: hasActualNeedsRegeneration
      ? renderValidation.actual_needs_regeneration === true
      : renderValidation.needs_regeneration === true,
    needs_manual_review: hasActualNeedsManualReview
      ? renderValidation.actual_needs_manual_review === true
      : renderValidation.needs_manual_review === true,
    hard_boundary_status: String(
      renderValidation.actual_hard_boundary_status
      || renderValidation.final_hard_boundary_status
      || renderValidation.hard_boundary_status
      || "unknown"
    ),
    max_visual_lag_sec: Number(renderValidation.max_visual_lag_sec || 0),
  };
};

const getProductionPreflightStatus = async ({ videoId = "", mockMode = false } = {}) => {
  const state = videoId ? await loadState(videoId).catch(() => null) : null;
  const effectiveValidation = resolveEffectiveRenderValidation(state?.render_validation || {});
  const renderDuration = await getRenderDurationSnapshot(state?.render_path || "");
  const runtimeProfile = String(
    state?.render_validation?.qa_runtime_profile
    || (mockMode ? config.QA_RUNTIME_PROFILE_MOCK : config.QA_RUNTIME_PROFILE_PROD)
    || "prod_strict"
  ).toLowerCase();
  const strictRuntimeProfile = runtimeProfile !== "mock_relaxed";
  const checks = {
    has_youtube_credentials: hasYoutubeCredentials(),
    has_provider_credentials: hasProviderCredentials(),
    has_gemini_key: Boolean(config.GEMINI_API_KEY),
    has_render_validation: Boolean(state?.render_validation),
    render_publishable: effectiveValidation.is_publishable === true,
    editorial_blocked: Boolean(state?.render_validation?.publish_blocked),
    hard_boundary_pass: effectiveValidation.hard_boundary_status === "pass",
    has_render_file: renderDuration.has_render_file === true,
    render_duration_seconds: Number(renderDuration.render_duration_seconds || 0),
    min_video_duration_seconds: Number(renderDuration.min_video_duration_seconds || getMinimumVideoDurationSeconds()),
    render_duration_pass: renderDuration.render_duration_pass === true,
  };
  const missing = [];
  if (!checks.has_provider_credentials) missing.push("PROVIDER_CREDENTIALS_MISSING");
  if (!checks.has_gemini_key) missing.push("GEMINI_API_KEY_MISSING");
  if (strictRuntimeProfile && !checks.has_youtube_credentials) missing.push("YOUTUBE_CREDENTIALS_MISSING");
  if (strictRuntimeProfile && !checks.has_render_validation) missing.push("RENDER_VALIDATION_MISSING");
  if (strictRuntimeProfile && !checks.has_render_file) missing.push("RENDER_FILE_MISSING");
  if (strictRuntimeProfile && checks.has_render_file && !checks.render_duration_pass) missing.push("VIDEO_DURATION_BELOW_MINIMUM");
  if (strictRuntimeProfile && !checks.render_publishable) missing.push("RENDER_NOT_PUBLISHABLE");
  if (strictRuntimeProfile && checks.editorial_blocked) missing.push("EDITORIAL_BLOCKED");
  if (strictRuntimeProfile && !checks.hard_boundary_pass) missing.push("HARD_BOUNDARY_NOT_PASS");

  // Alinha o preflight com runPreUploadQA: executa o M8 real e inclui o
  // resultado para que ready_for_real_publish reflita o gate completo.
  let m8Result = { ok: false, error: "m8_not_run" };
  if (checks.has_render_file && state?.render_path) {
    try {
      await runPreUploadQA({ renderPath: state.render_path, state });
      m8Result = { ok: true };
    } catch (m8Error) {
      m8Result = { ok: false, error: String(m8Error?.message || m8Error || "m8_unknown_error") };
      if (strictRuntimeProfile) missing.push("M8_PRE_UPLOAD_QA_FAILED");
    }
  }

  return {
    video_id: videoId || "",
    qa_runtime_profile: runtimeProfile,
    strict_runtime_profile: strictRuntimeProfile,
    checks,
    m8_pre_upload_qa: m8Result,
    ready_for_real_publish: missing.length === 0,
    blocking_codes: unique(missing),
    publish_blocked_codes: unique([
      ...(state?.render_validation?.publish_blocked_codes || []),
      ...(state?.render_validation?.editorial_failure_codes || []),
    ]),
  };
};

/**
 * M8 — Pre-upload QA checks.
 * Throws on hard failures (duration < 480s, black frames > 2s).
 * Logs warning for soft issues (duplicate consecutive clips).
 */
const runPreUploadQA = async ({ renderPath, state = {} }) => {
  const { logger } = require("../utils/logger");
  const minVideoDurationSeconds = getMinimumVideoDurationSeconds();

  // 1. Duration check
  const info = await probeMedia(renderPath).catch(() => ({ duration: 0 }));
  const duration = Number(info.duration || 0);
  if (duration < minVideoDurationSeconds) {
    throw new Error(`[M8] QA FAIL: duração ${duration.toFixed(1)}s < ${minVideoDurationSeconds}s mínimos`);
  }

  // 2. Black frames check (segments > 2s)
  let blackStderr = "";
  try {
    await runFfmpeg([
      "-hide_banner", "-loglevel", "info",
      "-i", renderPath,
      "-vf", "blackdetect=d=2:pix_th=0.10",
      "-an", "-f", "null", "-",
    ]);
  } catch (e) {
    blackStderr = String(e?.stderr || e?.message || "");
  }
  const blackSegments = [];
  const blackRegex = /black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)/g;
  let bMatch;
  while ((bMatch = blackRegex.exec(blackStderr)) !== null) {
    blackSegments.push({ start: parseFloat(bMatch[1]), end: parseFloat(bMatch[2]), duration: parseFloat(bMatch[3]) });
  }
  const longBlacks = blackSegments.filter((seg) => seg.duration >= 2);
  if (longBlacks.length > 0) {
    throw new Error(`[M8] QA FAIL: ${longBlacks.length} segmento(s) preto(s) > 2s encontrado(s)`);
  }

  // 3. Duplicate consecutive clips (soft warning)
  const clips = Array.isArray(state.render_timeline?.clips) ? state.render_timeline.clips : [];
  let consecutiveCount = 1;
  for (let i = 1; i < clips.length; i++) {
    const prevPath = clips[i - 1]?.asset?.local_path || clips[i - 1]?.local_path || "";
    const currPath = clips[i]?.asset?.local_path || clips[i]?.local_path || "";
    if (prevPath && prevPath === currPath) {
      consecutiveCount++;
      if (consecutiveCount > 2) {
        logger.warn(`[M8] WARN: asset repetido > 2 vezes consecutivas na posição ${i}`, {
          path: String(currPath).slice(-60),
        });
      }
    } else {
      consecutiveCount = 1;
    }
  }
};

const ensureRenderIsPublishableForUpload = (state = {}) => {
  const renderValidation = state.render_validation || {};
  const effectiveValidation = resolveEffectiveRenderValidation(renderValidation);
  const isPublishable = effectiveValidation.is_publishable === true;
  const needsRegeneration = effectiveValidation.needs_regeneration === true;
  const needsManualReview = effectiveValidation.needs_manual_review === true;
  const hardBoundaryStatus = effectiveValidation.hard_boundary_status || "unknown";
  const maxVisualLagSec = effectiveValidation.max_visual_lag_sec;
  const maxAllowedLagSec = Number(config.HARD_BOUNDARY_MAX_LAG_SEC || 0.5);
  const editorialFailureCodes = Array.isArray(renderValidation.editorial_failure_codes)
    ? renderValidation.editorial_failure_codes
    : [];
  const publishBlockedCodes = Array.isArray(renderValidation.publish_blocked_codes)
    ? renderValidation.publish_blocked_codes
    : [];

  if (!isPublishable || needsRegeneration || needsManualReview) {
    throw new Error(
      "Upload bloqueado: render reprovado no QA ou pendente de regeneracao/revisao manual."
    );
  }
  if (editorialFailureCodes.length || publishBlockedCodes.length || renderValidation.publish_blocked === true) {
    throw new Error(`Upload bloqueado: falha editorial contratual (${[...new Set([...editorialFailureCodes, ...publishBlockedCodes])].join(", ")}).`);
  }

  if (hardBoundaryStatus !== "pass") {
    throw new Error("Upload bloqueado: hard boundary QA reprovado.");
  }

  if (maxVisualLagSec > maxAllowedLagSec) {
    throw new Error("Upload bloqueado: max_visual_lag_sec acima do limite permitido.");
  }
};

const uploadToYoutube = async ({ videoId, mockMode = false, privacyStatus = config.YOUTUBE_DEFAULT_PRIVACY }) => {
  let state = await loadState(videoId);
  const forceLocalMock = isProviderDisabledInLocalTest("youtube");
  const effectiveMockMode = mockMode || forceLocalMock;

  if (!state.approved && config.AUTO_APPROVE_FOR_TESTING) {
    state = await updateState(videoId, {
      approved: true,
      error_message: "",
    });
  }

  if (!state.approved) {
    throw new Error("Upload bloqueado: aprovação final não foi confirmada.");
  }

  ensureRenderIsPublishableForUpload(state);

  if (!state.render_path || !fs.existsSync(state.render_path)) {
    throw new Error("Arquivo de vídeo final não encontrado para upload.");
  }

  // M8 — Pre-upload QA (runs for all uploads — mock and real)
  const preUploadQaResult = { ok: false, checked_at: new Date().toISOString(), mock: Boolean(effectiveMockMode) };
  try {
    await runPreUploadQA({ renderPath: state.render_path, state });
    preUploadQaResult.ok = true;
  } catch (qaErr) {
    preUploadQaResult.error = qaErr.message;
    if (!effectiveMockMode) throw qaErr;
    console.warn(`[M8] QA falhou em modo mock (continuando): ${qaErr.message}`);
  }

  if (effectiveMockMode || !hasYoutubeCredentials()) {
    const fakeId = `mock_${videoId.slice(0, 8)}`;
    const mockCaptionSource = resolveCaptionUploadSource(state);
    const nextState = await updateState(
      videoId,
      {
        pre_upload_qa: preUploadQaResult,
        youtube_video_id: fakeId,
        youtube_url: `https://youtube.com/watch?v=${fakeId}`,
        youtube_privacy_status: privacyStatus || config.YOUTUBE_DEFAULT_PRIVACY,
        youtube_caption_track_id: mockCaptionSource ? `mock_caption_${videoId.slice(0, 8)}` : "",
        youtube_caption_language: mockCaptionSource ? config.YOUTUBE_CAPTION_LANGUAGE : "",
        youtube_caption_format: mockCaptionSource?.format || "",
        youtube_caption_status: mockCaptionSource ? "uploaded_mock" : "skipped_no_caption",
        youtube_caption_error_message: "",
        external_api_stats: getExternalApiStats({ videoId }),
        error_message: "",
      },
      {
        currentStep: "youtube_uploaded",
        status: forceLocalMock ? "youtube_uploaded_local_test_mock" : "youtube_uploaded_mock",
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
  const budget = consumeExternalCallBudget({
    provider: "youtube",
    videoId,
    operation: "upload_video",
  });
  if (!budget.allowed) {
    throw new Error(`Upload bloqueado pelo circuit breaker: ${budget.reason}.`);
  }

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
      pre_upload_qa: preUploadQaResult,
      youtube_video_id: youtubeId || "",
      youtube_url: youtubeUrl,
      youtube_privacy_status: privacyStatus || config.YOUTUBE_DEFAULT_PRIVACY,
      ...captionUpload.statePatch,
      external_api_stats: getExternalApiStats({ videoId }),
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
  if (isProviderDisabledInLocalTest("youtube")) {
    return {
      configured: true,
      ok: true,
      message: "YouTube desativado em LOCAL_TEST_MODE",
    };
  }
  if (!hasYoutubeCredentials()) {
    return {
      configured: false,
      ok: false,
      message: "Credenciais YouTube ausentes (client_id/client_secret/refresh_token)",
    };
  }

  try {
    const budget = consumeExternalCallBudget({
      provider: "youtube",
      videoId: "",
      operation: "healthcheck",
    });
    if (!budget.allowed) {
      return {
        configured: true,
        ok: true,
        message: "YouTube bloqueado pelo circuit breaker",
      };
    }
    const oauth2Client = createYoutubeOAuthClient();
    const { scopes, errorMessage } = await getYoutubeScopesInfo(oauth2Client);

    if (!scopes.length) {
      throw new Error(errorMessage || "Nao foi possivel obter scopes do access token do YouTube.");
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
  getProductionPreflightStatus,
  __test__: {
    getMinimumVideoDurationSeconds,
    ensureRenderIsPublishableForUpload,
    getRenderDurationSnapshot,
    runPreUploadQA,
  },
};
