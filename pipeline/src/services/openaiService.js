const fs = require("fs");
const https = require("https");
const http = require("http");
const path = require("path");
const OpenAI = require("openai");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");
const { consumeExternalCallBudget, isProviderDisabledInLocalTest } = require("./externalApiControlService");

const OPENAI_REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS || 45000);
const OPENAI_TTS_TIMEOUT_MS = Number(process.env.OPENAI_TTS_TIMEOUT_MS || 90000);

const openaiClient = config.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: OPENAI_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    })
  : null;

const hasOpenAi = () =>
  Boolean(openaiClient && config.OPENAI_API_KEY) && !isProviderDisabledInLocalTest("openai");

const safeJsonParse = (raw, fallback) => {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const warnAndReturnNull = (scope, error) => {
  logger.warn(`${scope} unavailable, using fallback`, { message: error.message });
  return null;
};

const withTimeout = (promise, timeoutMs, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });

const imageMimeByExtension = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const imagePathToDataUrl = (imagePath) => {
  const extension = path.extname(imagePath || "").toLowerCase();
  const mimeType = imageMimeByExtension[extension] || "image/jpeg";
  const fileBuffer = fs.readFileSync(imagePath);
  return `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
};

const transcribeWithWordTimestamps = async ({ audioPath, videoId = "" }) => {
  if (!hasOpenAi()) return null;
  if (!fs.existsSync(audioPath)) return null;
  const budget = consumeExternalCallBudget({
    provider: "openai",
    videoId,
    operation: "transcribe_with_word_timestamps",
  });
  if (!budget.allowed) return null;

  try {
    const file = fs.createReadStream(audioPath);
    const transcription = await openaiClient.audio.transcriptions.create({
      file,
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
      language: "pt",
    });

    const words = (transcription?.words || []).map((word) => ({
      word: word.word || "",
      start: Number(word.start || 0),
      end: Number(word.end || 0),
      confidence: 1.0,
    }));

    const segments = (transcription?.segments || []).map((seg) => ({
      text: seg.text || "",
      start: Number(seg.start || 0),
      end: Number(seg.end || 0),
      confidence: Number(seg.confidence || 0),
      words: words.filter((w) => w.start >= Number(seg.start || 0) && w.end <= Number(seg.end || 0)),
    }));

    if (!words.length && !segments.length) return null;

    const pauseMarkers = [];
    for (let i = 1; i < words.length; i++) {
      const gap = words[i].start - words[i - 1].end;
      if (gap >= 0.8) {
        pauseMarkers.push({
          start: words[i - 1].end,
          end: words[i].start,
          duration: gap,
          type: gap >= 2.0 ? "topic_transition" : "sentence_break",
        });
      }
    }

    const totalDuration = segments.length ? segments[segments.length - 1].end : (words.length ? words[words.length - 1].end : 0);
    const totalWordSeconds = words.reduce((acc, w) => acc + (w.end - w.start), 0);
    const averageWps = totalDuration > 0 && words.length > 0 ? words.length / totalDuration : 0;

    return {
      words,
      segments,
      pause_markers: pauseMarkers,
      speaking_rate: {
        average_wps: Number(averageWps.toFixed(2)),
        total_duration_seconds: Number(totalDuration.toFixed(3)),
        total_words: words.length,
        total_segments: segments.length,
      },
    };
  } catch (error) {
    return warnAndReturnNull("OpenAI word-level transcription", error);
  }
};

const generateIdeasWithOpenAI = async ({ count = 5, videoId = "" }) => {
  if (!hasOpenAi()) return null;
  const budget = consumeExternalCallBudget({
    provider: "openai",
    videoId,
    operation: "generate_ideas",
  });
  if (!budget.allowed) return null;

  const system = `Você é um estrategista de YouTube para conteúdo faceless de viagem. Gere ideias com alta retenção e risco factual baixo.`;
  const user = `Gere ${count} ideias para vídeos longos (10-15 min) no nicho viagem (países, cidades, rankings, curiosidades, custo de vida, destinos subestimados, lugares bonitos, conteúdo prático).\n\nRetorne JSON estrito no formato:\n{\n  "ideas": [\n    {\n      "idea_id": "string",\n      "topic": "string",\n      "angle": "string",\n      "scores": {\n        "search_demand": 0-100,\n        "evergreen": 0-100,\n        "retention": 0-100,\n        "monetization": 0-100,\n        "visual_assets": 0-100,\n        "factual_risk": 0-100\n      },\n      "notes": "string"\n    }\n  ]\n}`;

  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const payload = safeJsonParse(response.choices?.[0]?.message?.content || "{}", null);
    return payload?.ideas || null;
  } catch (error) {
    return warnAndReturnNull("OpenAI ideas generation", error);
  }
};

const buildScriptDurationHint = (targetDurationSeconds = 0) => {
  const numericTarget = Number(targetDurationSeconds || 0);
  if (!(numericTarget > 0)) {
    return {
      scriptRequirement: "roteiro completo para 10-15 minutos",
      durationInstruction: "",
    };
  }

  const minutes = numericTarget % 60 === 0
    ? String(Math.round(numericTarget / 60))
    : (numericTarget / 60).toFixed(1);
  const targetWords = Math.max(180, Math.round(numericTarget * 2.3));
  const minWords = Math.max(160, targetWords - 40);
  const maxWords = targetWords + 40;

  return {
    scriptRequirement: `roteiro completo para aproximadamente ${minutes} minutos (${minWords} a ${maxWords} palavras de narracao)`,
    durationInstruction: `Duracao alvo: aproximadamente ${minutes} minutos. O campo script_text deve ter entre ${minWords} e ${maxWords} palavras de narracao corrida. Nunca entregue menos de ${minWords} palavras no script_text. Se precisar, expanda exemplos concretos, transicoes e detalhes visuais para atingir essa faixa sem enrolacao.`,
  };
};

// M7 — Zod schema for structured script package validation
const { z } = require("zod");

const StructuredBlockSchema = z.object({
  block_id: z.string().min(1),
  text: z.string().min(1),
  duration_estimate: z.number().positive(),
  visual_type: z.enum(["specific", "generic"]),
  visual_description: z.string(),
  keywords: z.array(z.string()),
});

const ScriptPackageSchema = z.object({
  video_objective: z.string(),
  intro_hook: z.string(),
  research_json: z.object({
    facts: z.array(z.string()),
    risks: z.array(z.string()),
    sources: z.array(z.string()),
  }),
  outline_json: z.object({
    sections: z.array(z.object({ title: z.string(), objective: z.string() })),
  }),
  script_text: z.string().min(100),
  visual_suggestions: z.array(z.any()),
  factual_notes: z.array(z.string()),
  seo_keywords: z.array(z.string()),
  youtube_title_options: z.array(z.string()),
  youtube_description: z.string(),
  tags: z.array(z.string()),
  chapters: z.array(z.string()),
  structured_blocks: z.array(StructuredBlockSchema).optional(),
});

const validateScriptPackage = (pkg) => {
  const result = ScriptPackageSchema.safeParse(pkg);
  if (!result.success) {
    logger.warn("[M7] Script package Zod validation failed", { errors: result.error.flatten() });
  }
  return result.success;
};

const generateScriptPackageWithOpenAI = async ({
  topic,
  angle,
  targetDurationSeconds = 0,
  videoId = "",
}) => {
  if (!hasOpenAi()) return null;
  const budget = consumeExternalCallBudget({
    provider: "openai",
    videoId,
    operation: "generate_script_package",
  });
  if (!budget.allowed) return null;

  const system = `Você é roteirista especialista em vídeos faceless para YouTube. Escreva em português do Brasil com alta retenção.`;
  const durationHint = buildScriptDurationHint(targetDurationSeconds);
  const structuredBlocksInstruction = `O array structured_blocks deve cobrir toda a narração em blocos sequenciais de 30–60s. visual_type deve ser "specific" quando a cena precisa de exatidão (prato específico, monumento real, pessoa real), ou "generic" para b-roll genérico.`;
  const user = `Tema: ${topic}\nÂngulo: ${angle || "educativo/documental"}\n${durationHint.durationInstruction ? `\n${durationHint.durationInstruction}` : ""}\n\n${structuredBlocksInstruction}\n\nGere JSON estrito com:\n{\n  "video_objective": "",\n  "intro_hook": "",\n  "research_json": {"facts": [""], "risks": [""], "sources": [""]},\n  "outline_json": {"sections": [{"title": "", "objective": ""}]},\n  "script_text": "${durationHint.scriptRequirement}",\n  "visual_suggestions": [{"section": "", "shots": [""]}],\n  "factual_notes": [""],\n  "seo_keywords": [""],\n  "youtube_title_options": [""],\n  "youtube_description": "",\n  "tags": [""],\n  "chapters": ["00:00 Introdução"],\n  "structured_blocks": [{"block_id": "b01", "text": "", "duration_estimate": 45, "visual_type": "generic", "visual_description": "", "keywords": [""]}]\n}`;

  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.5,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const parsed = safeJsonParse(response.choices?.[0]?.message?.content || "{}", null);
    if (parsed) {
      const valid = validateScriptPackage(parsed);
      if (!valid) logger.warn("[M7] structured_blocks ausente ou inválido, continuando sem validação M7");
    }
    return parsed;
  } catch (error) {
    return warnAndReturnNull("OpenAI script generation", error);
  }
};

const generateMetadataWithOpenAI = async ({ topic, scriptText, videoId = "" }) => {
  if (!hasOpenAi()) return null;
  const budget = consumeExternalCallBudget({
    provider: "openai",
    videoId,
    operation: "generate_metadata",
  });
  if (!budget.allowed) return null;

  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content:
            "Você é especialista em SEO para YouTube no nicho de viagem. Responda SOMENTE JSON válido.",
        },
        {
          role: "user",
          content: `Tema: ${topic}\n\nRoteiro:\n${scriptText?.slice(0, 7000) || ""}\n\nRetorne: {"title":"", "description":"", "tags":[], "chapters":[], "thumbnail_prompt":""}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    return safeJsonParse(response.choices?.[0]?.message?.content || "{}", null);
  } catch (error) {
    return warnAndReturnNull("OpenAI metadata generation", error);
  }
};

const transcribeWithOpenAI = async ({ audioPath, format = "srt", videoId = "" }) => {
  if (!hasOpenAi()) return null;
  if (!fs.existsSync(audioPath)) return null;
  const budget = consumeExternalCallBudget({
    provider: "openai",
    videoId,
    operation: "transcribe_audio",
  });
  if (!budget.allowed) return null;

  try {
    const file = fs.createReadStream(audioPath);
    const transcription = await openaiClient.audio.transcriptions.create({
      file,
      model: "gpt-4o-mini-transcribe",
      response_format: format,
      language: "pt",
    });

    if (typeof transcription === "string") return transcription;
    if (transcription?.text) return transcription.text;
    return null;
  } catch (error) {
    return warnAndReturnNull("OpenAI transcription", error);
  }
};

const ttsWithOpenAI = async ({ text, videoId = "" }) => {
  if (!hasOpenAi()) return null;
  const budget = consumeExternalCallBudget({
    provider: "openai",
    videoId,
    operation: "tts",
  });
  if (!budget.allowed) return null;
  try {
    logger.info("OpenAI TTS: iniciando síntese", {
      text_length: String(text || "").length,
      timeout_ms: OPENAI_TTS_TIMEOUT_MS,
    });

    const response = await withTimeout(
      openaiClient.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: text,
        format: "mp3",
      }),
      OPENAI_TTS_TIMEOUT_MS,
      "OpenAI TTS request"
    );
    const audioBuffer = Buffer.from(
      await withTimeout(response.arrayBuffer(), OPENAI_TTS_TIMEOUT_MS, "OpenAI TTS stream read")
    );

    logger.info("OpenAI TTS: síntese concluída", {
      bytes: audioBuffer.length,
    });

    return audioBuffer;
  } catch (error) {
    logger.warn("OpenAI TTS fallback failed", { message: error.message });
    return null;
  }
};

const describeImagesWithOpenAI = async ({
  prompt,
  imagePaths = [],
  detail = "low",
  videoId = "",
}) => {
  if (!hasOpenAi()) return null;
  if (!Array.isArray(imagePaths) || !imagePaths.length) return null;
  const budget = consumeExternalCallBudget({
    provider: "openai",
    videoId,
    operation: "describe_images",
  });
  if (!budget.allowed) return null;

  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: "Voce analisa imagens e responde somente com JSON valido.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...imagePaths.map((imagePath) => ({
              type: "image_url",
              image_url: {
                url: imagePathToDataUrl(imagePath),
                detail,
              },
            })),
          ],
        },
      ],
      response_format: { type: "json_object" },
    });

    return safeJsonParse(response.choices?.[0]?.message?.content || "{}", null);
  } catch (error) {
    return warnAndReturnNull("OpenAI image description", error);
  }
};

/**
 * M3 — Generate an image via DALL-E 3 and save it to outputPath.
 * Returns outputPath on success, null on failure.
 */
const generateImageWithDallE3 = async ({ prompt, videoId = "", outputPath }) => {
  if (!hasOpenAi()) return null;
  const budget = consumeExternalCallBudget({ provider: "openai", videoId, operation: "generate_image_dalle3" });
  if (!budget.allowed) return null;

  try {
    logger.info(`[M3] DALL-E 3: gerando imagem para prompt: "${String(prompt || "").slice(0, 80)}..."`, { videoId });
    const response = await openaiClient.images.generate({
      model: "dall-e-3",
      prompt: String(prompt || "").slice(0, 4000),
      n: 1,
      size: "1792x1024",
    });

    const imageUrl = response.data?.[0]?.url;
    if (!imageUrl) return null;

    await new Promise((resolve, reject) => {
      const fsStream = fs.createWriteStream(outputPath);
      const transport = imageUrl.startsWith("https") ? https : http;
      transport.get(imageUrl, (res) => {
        res.pipe(fsStream);
        fsStream.on("finish", () => { fsStream.close(); resolve(); });
        fsStream.on("error", reject);
      }).on("error", reject);
    });

    logger.info(`[M3] DALL-E 3: imagem salva em ${outputPath}`, { videoId });
    return outputPath;
  } catch (error) {
    return warnAndReturnNull("DALL-E 3 image generation", error);
  }
};

const basicOpenAIHealthcheck = async () => {
  if (isProviderDisabledInLocalTest("openai")) {
    return {
      configured: true,
      ok: true,
      message: "OpenAI desativado em LOCAL_TEST_MODE",
    };
  }
  if (!hasOpenAi()) return { configured: false, ok: false, message: "OPENAI_API_KEY ausente" };
  try {
    const budget = consumeExternalCallBudget({
      provider: "openai",
      videoId: "",
      operation: "healthcheck",
    });
    if (!budget.allowed) {
      return { configured: true, ok: true, message: "OpenAI bloqueado pelo circuit breaker" };
    }
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Responda apenas: ok" }],
      max_tokens: 5,
    });
    return {
      configured: true,
      ok: true,
      message: response.choices?.[0]?.message?.content || "ok",
    };
  } catch (error) {
    return { configured: true, ok: false, message: error.message };
  }
};

module.exports = {
  hasOpenAi,
  generateIdeasWithOpenAI,
  generateScriptPackageWithOpenAI,
  validateScriptPackage,
  generateImageWithDallE3,
  generateMetadataWithOpenAI,
  transcribeWithOpenAI,
  transcribeWithWordTimestamps,
  ttsWithOpenAI,
  describeImagesWithOpenAI,
  basicOpenAIHealthcheck,
};
