const axios = require("axios");
const { config } = require("../src/config/env");
const { runIntegrationHealthchecks } = require("../src/services/integrationHealthService");
const { basicTelegramHealthcheck } = require("../src/services/telegramService");
const { basicYoutubeHealthcheck } = require("../src/services/youtubeService");
const { basicPexelsHealthcheck, basicPixabayHealthcheck } = require("../src/services/assetsService");
const { loadState, updateState } = require("../src/services/stateService");
const { pickRandomMultivozesVoice } = require("../src/services/ttsService");

const client = axios.create({
  baseURL: `http://127.0.0.1:${config.APP_PORT}/api`,
  timeout: 600000,
});

const summarizeChecks = (checks) =>
  Object.fromEntries(
    Object.entries(checks).map(([name, value]) => [
      name,
      {
        configured: Boolean(value?.configured),
        ok: Boolean(value?.ok),
        message: value?.message || "",
      },
    ])
  );

const simplifyAxiosError = (error) => ({
  message: error?.response?.data?.error || error?.message || String(error),
  status: error?.response?.status || null,
  payload: error?.response?.data || null,
});

const results = [];

const runStep = async (step, fn) => {
  try {
    const details = await fn();
    results.push({ step, ok: true, details });
    return details;
  } catch (error) {
    const details = simplifyAxiosError(error);
    results.push({ step, ok: false, details });
    return null;
  }
};

const run = async () => {
  const validationVideoId = `validation_${Date.now()}`;

  await runStep("1.integrations_health", async () => {
    const payload = await runIntegrationHealthchecks();
    const failedConfigured = Object.entries(payload.checks).filter(
      ([, value]) => value?.configured && !value?.ok
    );

    if (failedConfigured.length > 0) {
      throw new Error(
        `Integrações configuradas com falha: ${failedConfigured
          .map(([name, value]) => `${name}=${value.message}`)
          .join("; ")}`
      );
    }

    return {
      mock_mode: payload.mock_mode,
      strict_ok: payload.strict_ok,
      configured_count: payload.configured_count,
      ok_count: payload.ok_count,
      checks: summarizeChecks(payload.checks),
    };
  });

  await runStep("2.telegram", async () => {
    const result = await basicTelegramHealthcheck();
    if (!result.ok) throw new Error(result.message);
    return result;
  });

  await runStep("3.openai_ideas", async () => {
    const response = await client.post("/videos/ideas/generate", {
      count: 3,
      mock_mode: false,
    });

    if (!Array.isArray(response.data?.ideas) || !response.data.ideas.length) {
      throw new Error("Nenhuma ideia retornada pelo backend.");
    }

    return {
      video_id: response.data.video_id,
      ideas: response.data.ideas.slice(0, 3).map((idea) => ({
        topic: idea.topic,
        angle: idea.angle,
        total_score: idea.total_score,
      })),
      telegram_sent: Boolean(response.data.telegram?.sent),
    };
  });

  await runStep("4.multivozes_voice", async () => {
    if (!config.MULTIVOZES_BR_ENGINE) {
      throw new Error("MULTIVOZES_BR_ENGINE ausente.");
    }

    const voice = pickRandomMultivozesVoice();
    const response = await axios.post(
      `${config.MULTIVOZES_BR_BASE_URL.replace(/\/+$/, "")}/audio/speech`,
      {
        model: "tts-1",
        input: `Validação híbrida do pipeline em ${new Date().toISOString()}.`,
        voice,
        response_format: "mp3",
      },
      {
        headers: {
          Authorization: `Bearer ${config.MULTIVOZES_BR_ENGINE}`,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
        timeout: 120000,
      }
    );

    const bytes = Buffer.from(response.data).length;
    if (bytes < 1024) {
      throw new Error(`Áudio do Multivozes muito pequeno (${bytes} bytes).`);
    }

    return { voice, bytes };
  });

  await runStep("5.assets_search", async () => {
    const [pexels, pixabay] = await Promise.all([
      basicPexelsHealthcheck(),
      basicPixabayHealthcheck(),
    ]);

    if (!pexels.ok) throw new Error(`Pexels: ${pexels.message}`);
    if (!pixabay.ok) throw new Error(`Pixabay: ${pixabay.message}`);

    await updateState(
      validationVideoId,
      {
        topic: "Portugal barato em 2026",
        angle: "guia curto de validação híbrida",
        script_text:
          "Portugal segue como um dos destinos mais buscados por brasileiros. Neste teste híbrido, vamos validar assets reais de viagem usando cenas urbanas, paisagens, custo de vida e transporte.",
        approved: false,
        error_message: "",
      },
      {
        currentStep: "script_generated",
        status: "script_generated",
      }
    );

    const response = await client.post("/videos/assets/search", {
      video_id: validationVideoId,
      mock_mode: false,
      max_assets: 6,
    });

    const providers = [...new Set((response.data.assets_json?.items || []).map((item) => item.provider))];
    if (response.data.missing_assets || !providers.some((provider) => provider !== "mock")) {
      throw new Error("Busca de assets caiu para fallback mock.");
    }

    return {
      video_id: validationVideoId,
      assets_count: response.data.assets_count,
      providers,
      search_queries: response.data.assets_json?.search_queries || [],
      health: {
        pexels: pexels.message,
        pixabay: pixabay.message,
      },
    };
  });

  await runStep("6.youtube_oauth", async () => {
    const result = await basicYoutubeHealthcheck();
    if (!result.ok) throw new Error(result.message);
    return result;
  });

  await runStep("7.e2e_upload_blocked", async () => {
    await updateState(
      validationVideoId,
      {
        topic: "Portugal barato em 2026",
        angle: "guia curto de validação híbrida",
        script_text:
          "Portugal segue como um dos destinos mais buscados por brasileiros. Este roteiro curto existe apenas para validar TTS, legendas, assets, render e o bloqueio de upload por aprovação final.",
        approved: false,
        error_message: "",
      },
      {
        currentStep: "script_generated",
        status: "script_generated",
      }
    );

    await client.post("/videos/assets/search", {
      video_id: validationVideoId,
      mock_mode: false,
      max_assets: 6,
    });

    const audio = await client.post("/videos/audio/generate", {
      video_id: validationVideoId,
      mock_mode: false,
      provider: "multivozes",
    });

    if (audio.data.provider !== "multivozes") {
      throw new Error(`Áudio não saiu pelo provider primário. Provider usado: ${audio.data.provider}`);
    }

    await client.post("/videos/captions/generate", {
      video_id: validationVideoId,
      mock_mode: false,
    });

    const render = await client.post(
      "/videos/render",
      {
        video_id: validationVideoId,
        mock_mode: false,
      },
      { timeout: 600000 }
    );

    await client.post("/videos/metadata/generate", {
      video_id: validationVideoId,
      mock_mode: false,
    });

    let blockedError = null;
    try {
      await client.post("/videos/youtube/upload", {
        video_id: validationVideoId,
        mock_mode: false,
        privacy_status: "private",
      });
    } catch (error) {
      blockedError = simplifyAxiosError(error);
    }

    if (!blockedError || !String(blockedError.message).includes("aprovação final")) {
      throw new Error("Upload não foi bloqueado pela aprovação final.");
    }

    const finalState = await loadState(validationVideoId);

    return {
      video_id: validationVideoId,
      audio_provider: audio.data.provider,
      audio_voice: audio.data.voice,
      render_path: render.data.render_path,
      current_step: finalState.current_step,
      status: finalState.status,
      upload_blocked_message: blockedError.message,
      youtube_default_privacy: config.YOUTUBE_DEFAULT_PRIVACY,
    };
  });

  const summary = {
    ok: results.every((result) => result.ok),
    results,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.ok) {
    process.exit(1);
  }
};

run().catch((error) => {
  console.error(JSON.stringify({ ok: false, fatal: error.message, results }, null, 2));
  process.exit(1);
});