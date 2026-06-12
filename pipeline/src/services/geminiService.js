const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_CHAT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash-lite";
const GEMINI_FLASH_MODEL = process.env.GEMINI_VISION_MODEL_LITE || "gemini-2.5-flash-lite";
const GEMINI_EMBED_MODEL = "gemini-embedding-001";

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

const generateContent = async ({ prompt, imageParts = [], model = GEMINI_CHAT_MODEL, responseFormat = "text", timeoutMs = 90000, temperature = 0.5 }) => {
  if (!hasGemini()) return null;

  const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts: [...imageParts, { text: prompt }] }],
    generationConfig: {
      temperature,
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
    });
    return null;
  }
};

const fileToInlinePart = async (filePath, mimeType = "image/jpeg") => {
  const data = await fs.readFile(filePath);
  return { inlineData: { mimeType, data: data.toString("base64") } };
};

/**
 * Descreve imagens com Gemini Flash. Mesma interface lógica de
 * describeImagesWithOpenAI: recebe prompt + caminhos de imagem, retorna JSON.
 */
const describeImagesWithGemini = async ({ prompt, imagePaths = [] }) => {
  if (!hasGemini() || !imagePaths.length) return null;

  const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
  const imageParts = await Promise.all(
    imagePaths.map((imagePath) =>
      fileToInlinePart(imagePath, mimeMap[path.extname(imagePath).toLowerCase()] || "image/jpeg")
    )
  );

  return generateContent({
    prompt,
    imageParts,
    model: GEMINI_FLASH_MODEL,
    responseFormat: "json",
    timeoutMs: 45000,
    temperature: 0.1,
  });
};

const generateScriptPackageWithGemini = async ({ topic, angle, targetWords = 1400 }) => {
  if (!hasGemini()) return null;

  const targetMinutes = Math.round(targetWords / 130);
  const prompt = `Você é roteirista especialista em vídeos faceless para YouTube. Escreva em português do Brasil com alta retenção.

Tema: ${topic}
Ângulo: ${angle || "educativo/documental"}

IMPORTANTE: O campo "script_text" deve ter EXATAMENTE no mínimo ${targetWords} palavras (roteiro para ${targetMinutes}-${targetMinutes + 3} minutos). Escreva narração completa, detalhada e extensa — não resuma.

Gere JSON estrito com:
{
  "video_objective": "",
  "intro_hook": "",
  "research_json": {"facts": [""], "risks": [""], "sources": [""]},
  "outline_json": {"sections": [{"title": "", "objective": ""}]},
  "script_text": "narração completa com no mínimo ${targetWords} palavras",
  "visual_suggestions": [{"section": "", "shots": [""]}],
  "factual_notes": [""],
  "seo_keywords": [""],
  "youtube_title_options": [""],
  "youtube_description": "",
  "tags": [""],
  "chapters": ["00:00 Introdução"]
}`;

  return generateContent({ prompt, responseFormat: "json", timeoutMs: 180000 });
};

const basicGeminiHealthcheck = async () => {
  if (!hasGemini()) return { configured: false, ok: false, message: "GEMINI_API_KEY ausente" };

  try {
    const result = await generateContent({
      prompt: "Responda apenas: ok",
      model: GEMINI_FLASH_MODEL,
      timeoutMs: 15000,
    });
    const ok = typeof result === "string" && result.toLowerCase().includes("ok");
    return { configured: true, ok, message: ok ? "Gemini operacional" : "Resposta inesperada" };
  } catch (error) {
    return { configured: true, ok: false, message: error.message };
  }
};

const generateIdeasWithGemini = async ({ count = 5, videoId = "" }) => {
  if (!hasGemini()) return null;
  const prompt = `Gere ${count} ideias criativas para vídeos do YouTube sobre viagens e turismo em Portugal.
Responda em JSON com o seguinte formato exato (sem campos extras):
[
  {
    "topic": "título atraente do vídeo em português brasileiro",
    "angle": "ângulo narrativo único (ex: 'guia prático para famílias', 'roteiro em 5 dias')",
    "notes": "gancho de abertura para prender o espectador nos primeiros 10 segundos",
    "scores": {
      "search_demand": 75,
      "evergreen": 80,
      "retention": 78,
      "monetization": 72,
      "visual_assets": 85,
      "factual_risk": 10
    }
  }
]
Gere exatamente ${count} ideias diferentes. Tópicos devem ser específicos e acionáveis, não genéricos.`;
  try {
    const result = await generateContent({ prompt, responseFormat: "json", temperature: 0.8 });
    const parsed = safeJsonParse(result, []);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    logger.warn("geminiService: generateIdeasWithGemini falhou", { message: error.message, videoId });
    return null;
  }
};

module.exports = {
  hasGemini,
  generateContent,
  generateEmbedding,
  describeImagesWithGemini,
  generateScriptPackageWithGemini,
  generateIdeasWithGemini,
  basicGeminiHealthcheck,
};
