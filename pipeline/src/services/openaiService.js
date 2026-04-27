const fs = require("fs");
const OpenAI = require("openai");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");

const openaiClient = config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;

const hasOpenAi = () => Boolean(openaiClient && config.OPENAI_API_KEY);

const safeJsonParse = (raw, fallback) => {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const generateIdeasWithOpenAI = async ({ count = 5 }) => {
  if (!hasOpenAi()) return null;

  const system = `Você é um estrategista de YouTube para conteúdo faceless de viagem. Gere ideias com alta retenção e risco factual baixo.`;
  const user = `Gere ${count} ideias para vídeos longos (10-15 min) no nicho viagem (países, cidades, rankings, curiosidades, custo de vida, destinos subestimados, lugares bonitos, conteúdo prático).\n\nRetorne JSON estrito no formato:\n{\n  "ideas": [\n    {\n      "idea_id": "string",\n      "topic": "string",\n      "angle": "string",\n      "scores": {\n        "search_demand": 0-100,\n        "evergreen": 0-100,\n        "retention": 0-100,\n        "monetization": 0-100,\n        "visual_assets": 0-100,\n        "factual_risk": 0-100\n      },\n      "notes": "string"\n    }\n  ]\n}`;

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
};

const generateScriptPackageWithOpenAI = async ({ topic, angle }) => {
  if (!hasOpenAi()) return null;

  const system = `Você é roteirista especialista em vídeos faceless para YouTube. Escreva em português do Brasil com alta retenção.`;
  const user = `Tema: ${topic}\nÂngulo: ${angle || "educativo/documental"}\n\nGere JSON estrito com:\n{\n  "video_objective": "",\n  "intro_hook": "",\n  "research_json": {"facts": [""], "risks": [""], "sources": [""]},\n  "outline_json": {"sections": [{"title": "", "objective": ""}]},\n  "script_text": "roteiro completo para 10-15 minutos",\n  "visual_suggestions": [{"section": "", "shots": [""]}],\n  "factual_notes": [""],\n  "seo_keywords": [""],\n  "youtube_title_options": [""],\n  "youtube_description": "",\n  "tags": [""],\n  "chapters": ["00:00 Introdução"]\n}`;

  const response = await openaiClient.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
  });

  return safeJsonParse(response.choices?.[0]?.message?.content || "{}", null);
};

const generateMetadataWithOpenAI = async ({ topic, scriptText }) => {
  if (!hasOpenAi()) return null;

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
};

const transcribeWithOpenAI = async ({ audioPath, format = "srt" }) => {
  if (!hasOpenAi()) return null;
  if (!fs.existsSync(audioPath)) return null;

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
};

const ttsWithOpenAI = async ({ text }) => {
  if (!hasOpenAi()) return null;
  try {
    const response = await openaiClient.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
      format: "mp3",
    });
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    logger.warn("OpenAI TTS fallback failed", { message: error.message });
    return null;
  }
};

const basicOpenAIHealthcheck = async () => {
  if (!hasOpenAi()) return { configured: false, ok: false, message: "OPENAI_API_KEY ausente" };
  try {
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
  generateMetadataWithOpenAI,
  transcribeWithOpenAI,
  ttsWithOpenAI,
  basicOpenAIHealthcheck,
};