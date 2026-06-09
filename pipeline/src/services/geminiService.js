const axios = require("axios");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_CHAT_MODEL = "gemini-1.5-pro";
const GEMINI_EMBED_MODEL = "text-embedding-004";

const hasGemini = () => Boolean(config.GEMINI_API_KEY);

const safeJsonParse = (raw, fallback) => {
  try {
    if (typeof raw !== "string") return raw || fallback;
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
};

const generateContent = async ({ prompt, model = GEMINI_CHAT_MODEL, responseFormat = "text", timeoutMs = 90000 }) => {
  if (!hasGemini()) return null;

  const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 8192,
    },
  };

  if (responseFormat === "json") {
    body.generationConfig.responseMimeType = "application/json";
  }

  try {
    const response = await axios.post(url, body, {
      timeout: timeoutMs,
      headers: { "Content-Type": "application/json" },
    });

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (responseFormat === "json") return safeJsonParse(text, null);
    return text;
  } catch (error) {
    logger.warn("geminiService: falha na geração de conteúdo", {
      message: error.message,
      status: error.response?.status,
      model,
    });
    return null;
  }
};

const generateEmbedding = async (text) => {
  if (!hasGemini() || !text || !text.trim()) return null;

  const url = `${GEMINI_BASE}/models/${GEMINI_EMBED_MODEL}:embedContent?key=${config.GEMINI_API_KEY}`;

  try {
    const response = await axios.post(
      url,
      {
        model: `models/${GEMINI_EMBED_MODEL}`,
        content: { parts: [{ text: text.trim().slice(0, 8000) }] },
      },
      { timeout: 15000, headers: { "Content-Type": "application/json" } }
    );

    const embedding = response.data?.embedding?.values;
    if (!Array.isArray(embedding) || embedding.length === 0) return null;
    return embedding;
  } catch (error) {
    logger.warn("geminiService: falha ao gerar embedding", {
      message: error.message,
      status: error.response?.status,
      textLength: text.length,
    });
    return null;
  }
};

const generateScriptPackageWithGemini = async ({ topic, angle }) => {
  if (!hasGemini()) return null;

  const prompt = `Você é roteirista especialista em vídeos faceless para YouTube. Escreva em português do Brasil com alta retenção.

Tema: ${topic}
Ângulo: ${angle || "educativo/documental"}

Gere JSON estrito com:
{
  "video_objective": "",
  "intro_hook": "",
  "research_json": {"facts": [""], "risks": [""], "sources": [""]},
  "outline_json": {"sections": [{"title": "", "objective": ""}]},
  "script_text": "roteiro completo para 10-15 minutos",
  "visual_suggestions": [{"section": "", "shots": [""]}],
  "factual_notes": [""],
  "seo_keywords": [""],
  "youtube_title_options": [""],
  "youtube_description": "",
  "tags": [""],
  "chapters": ["00:00 Introdução"]
}`;

  return generateContent({ prompt, responseFormat: "json", timeoutMs: 120000 });
};

const basicGeminiHealthcheck = async () => {
  if (!hasGemini()) return { configured: false, ok: false, message: "GEMINI_API_KEY ausente" };

  try {
    const result = await generateContent({
      prompt: "Responda apenas: ok",
      model: "gemini-1.5-flash",
      timeoutMs: 15000,
    });
    const ok = typeof result === "string" && result.toLowerCase().includes("ok");
    return { configured: true, ok, message: ok ? "Gemini operacional" : "Resposta inesperada" };
  } catch (error) {
    return { configured: true, ok: false, message: error.message };
  }
};

module.exports = {
  hasGemini,
  generateContent,
  generateEmbedding,
  generateScriptPackageWithGemini,
  basicGeminiHealthcheck,
};
