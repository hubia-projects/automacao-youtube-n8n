const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_CHAT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const GEMINI_FLASH_MODEL = process.env.GEMINI_VISION_MODEL_LITE || "gemini-2.5-flash";
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

const generateContent = async ({ prompt, imageParts = [], model = GEMINI_CHAT_MODEL, responseFormat = "text", timeoutMs = 90000, temperature = 0.5, maxOutputTokens = 8192 }) => {
  if (!hasGemini()) return null;

  const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${config.GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts: [...imageParts, { text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
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

const generateScriptPackageWithGemini = async ({ topic, angle, targetWords = 1400, videoDurationSeconds = 0, wordCountRetry = false, previousWordCount = 0 } = {}) => {
  if (!hasGemini()) return null;

  const shortModeWindow = 240;
  const isShortMode = Number(videoDurationSeconds || 0) > 0 && Number(videoDurationSeconds) <= shortModeWindow;
  const minWordsShort = Number(process.env.TARGET_SCRIPT_WORDS_MIN || config.TARGET_SCRIPT_WORDS_MIN || 380);
  const maxWordsShort = Number(process.env.TARGET_SCRIPT_WORDS_MAX || config.TARGET_SCRIPT_WORDS_MAX || 520);
  const targetMinutes = Math.round(targetWords / 130);
  const shortBlockCount = Math.min(12, Math.max(8, Math.round(Number(videoDurationSeconds || 0) / 20)));
  const shortBlockSeconds = isShortMode ? Math.min(25, Math.max(12, Math.round(Number(videoDurationSeconds || 180) / shortBlockCount))) : 30;

  let prompt;

  if (isShortMode) {
    prompt = `Você é roteirista especialista em vídeos faceless curtos para YouTube (modo MVP). Escreva em português do Brasil com alta retenção.

Tema: ${topic}
Ângulo: ${angle || "educativo/documental"}
Duração alvo: ${videoDurationSeconds}s (curto, MVP 3 min)

IMPORTANTE (MODO CURTO):
- O campo "script_text" deve ter entre ${minWordsShort} e ${maxWordsShort} palavras de narração corrida (equivalente a ~${videoDurationSeconds}s @ 2.4 wps).
- Não escreva mais do que ${maxWordsShort} palavras; seja direto e use vocabulário específico.
- NÃO é um vídeo longo. Seja conciso; cada bloco deve ter substância visual.

Gere ${shortBlockCount} blocos visuais pequenos (8–12) em array structured_blocks, cada um com 12–25s. Cada bloco precisa ter intenção visual clara: city_landmark | gastronomy | restaurant | market | pastry | wine | street | generic_transition.

Gere JSON estrito com:
{
  "video_objective": "",
  "intro_hook": "",
  "research_json": {"facts": [""], "risks": [""], "sources": [""]},
  "outline_json": {"sections": [{"title": "", "objective": ""}]},
  "script_text": "narração completa entre ${minWordsShort} e ${maxWordsShort} palavras",
  "visual_suggestions": [{"section": "", "shots": [""]}],
  "factual_notes": [""],
  "seo_keywords": [""],
  "youtube_title_options": [""],
  "youtube_description": "",
  "tags": [""],
  "chapters": ["00:00 Introdução"],
  "structured_blocks": [
    {
      "block_id": "b01",
      "order": 1,
      "text": "trecho exato da narração deste bloco",
      "duration_estimate": ${shortBlockSeconds},
      "visual_intent": "city_landmark|gastronomy|restaurant|market|pastry|wine|street|generic_transition",
      "expected_location": "Lisboa|Porto|Sintra|Portugal|vazio se genérico",
      "expected_country": "Portugal",
      "required_visual_evidence": ["pastel de nata","food closeup","Porto","Douro"],
      "forbidden_visual_categories": ["wrong_city","generic_landmark","unrelated_city_square"],
      "asset_query_hints": ["porto francesinha restaurant","pastel de nata cafe portugal"],
      "generic_asset_allowed": false
    }
  ]
}`;
  } else {
    prompt = `Você é roteirista especialista em vídeos faceless para YouTube. Escreva em português do Brasil com alta retenção.

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
  }

  const maxOutputTokens = isShortMode ? (wordCountRetry ? Math.round(4096 * 1.3) : 4096) : 8192;
  let promptWithShortHint = isShortMode ? `${prompt}\n\nNUNCA escreva mais que ${maxWordsShort} palavras no script_text. Se atingir o limite, pare de narrar imediatamente — não invente conteúdo extra.` : prompt;
  if (isShortMode && wordCountRetry && previousWordCount > 0) {
    promptWithShortHint += `\n\n⚠️ RETRY OBRIGATÓRIO: O rascunho anterior tinha apenas ${previousWordCount} palavras — abaixo do mínimo de ${minWordsShort}. Desta vez o campo "script_text" DEVE ter no mínimo ${minWordsShort} palavras. Expanda cada bloco com detalhes concretos, exemplos reais e contexto histórico ou cultural. Não encurte a narração; escreva até atingir o mínimo de palavras exigido.`;
  }

  return generateContent({ prompt: promptWithShortHint, responseFormat: "json", timeoutMs: 180000, model: GEMINI_CHAT_MODEL, maxOutputTokens });
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

const transcribeWithGemini = async ({ audioPath, videoId = "" }) => {
  if (!hasGemini()) return null;
  try {
    if (!fs.existsSync(audioPath)) return null;
    const audioBuffer = await fs.readFile(audioPath);
    const audioBase64 = audioBuffer.toString("base64");
    const ext = path.extname(audioPath).toLowerCase();
    const mimeType = ext === ".mp3" ? "audio/mpeg" : ext === ".wav" ? "audio/wav" : "audio/mpeg";
    const url = `${GEMINI_BASE}/models/${GEMINI_FLASH_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;
    const body = {
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: audioBase64 } },
          { text: "Transcreva este áudio em português do Brasil. Retorne apenas o texto transcrito, sem comentários." },
        ],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 8192 },
    };
    const response = await axios.post(url, body, {
      timeout: 180000,
      headers: { "Content-Type": "application/json" },
    });
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return text.trim() || null;
  } catch (error) {
    logger.warn("geminiService: transcribeWithGemini falhou", { message: error.message, videoId });
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
  transcribeWithGemini,
};
