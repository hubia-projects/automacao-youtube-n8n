const fs = require("fs-extra");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const axios = require("axios");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");

const execFileAsync = promisify(execFile);

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_CHAT_MODEL = "gemini-1.5-pro";
const GEMINI_FLASH_MODEL = "gemini-1.5-flash";
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

// ===== Media Analysis for Library Auto-Indexing =====

const extractVideoFrames = async (videoPath, frameCount = 4) => {
  const ffprobeBin = require("ffprobe-static").path;
  const ffmpegBin = require("ffmpeg-static");
  const tmpDir = require("os").tmpdir();
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const frameDir = path.join(tmpDir, `gemini_frames_${Date.now()}_${baseName}`);
  await fs.ensureDir(frameDir);

  try {
    // Get video duration
    const probeResult = await execFileAsync(ffprobeBin, [
      "-v", "quiet", "-print_format", "json", "-show_format", videoPath,
    ]);
    const probeData = JSON.parse(probeResult.stdout);
    const duration = parseFloat(probeData.format?.duration || "10");

    // Extract evenly-spaced frames
    const interval = Math.max(1, Math.floor(duration / (frameCount + 1)));
    const framePromises = [];
    for (let i = 1; i <= frameCount; i++) {
      const timestamp = Math.min(i * interval, duration - 1);
      const framePath = path.join(frameDir, `frame_${i}.jpg`);
      framePromises.push(
        execFileAsync(ffmpegBin, [
          "-ss", String(timestamp), "-i", videoPath,
          "-vframes", "1", "-q:v", "5", "-vf", "scale=640:-1",
          "-y", framePath,
        ]).then(() => framePath).catch(() => null)
      );
    }

    const framePaths = (await Promise.all(framePromises)).filter(Boolean);
    return { framePaths, frameDir };
  } catch (error) {
    logger.warn("geminiService: falha ao extrair frames", { message: error.message, videoPath });
    return { framePaths: [], frameDir };
  }
};

const fileToBase64Part = async (filePath, mimeType = "image/jpeg") => {
  const data = await fs.readFile(filePath);
  return { inlineData: { mimeType, data: data.toString("base64") } };
};

const ANALYZE_PROMPT = `Analise este(s) quadro(s) de mídia e responda em JSON estrito sem comentários:
{
  "description": "Descrição objetiva em português do conteúdo visual (máx 150 caracteres)",
  "tags": ["lista", "de", "tags", "descritivas", "em", "português", "minúsculas"],
  "location": {
    "city": "nome da cidade em português se identificável, senão vazio",
    "country": "nome do país em português se identificável, senão vazio"
  },
  "type_hint": "landscape|people|urban|nature|interior|abstract|food|transport|other"
}

Regras:
- tags: 5 a 12 palavras-chave descritivas sobre o conteúdo visual
- location: identifique apenas se houver sinais claros (arquitetura, placa, paisagem característica)
- description: objetivo, sem adjetivos subjetivos como "bonito" ou "incrível"`;

/**
 * Analisa uma imagem ou vídeo com Gemini Flash e retorna metadados estruturados.
 * Para vídeos, extrai frames representativos; para imagens, envia direto.
 */
const analyzeMediaFile = async (filePath) => {
  if (!hasGemini()) return null;

  const ext = path.extname(filePath).toLowerCase();
  const isVideo = [".mp4", ".mov", ".mkv", ".webm", ".avi"].includes(ext);
  const isImage = [".jpg", ".jpeg", ".png", ".webp"].includes(ext);

  if (!isVideo && !isImage) return null;

  const url = `${GEMINI_BASE}/models/${GEMINI_FLASH_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;
  let frameDir = null;

  try {
    let imageParts = [];

    if (isImage) {
      const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
      imageParts.push(await fileToBase64Part(filePath, mimeMap[ext] || "image/jpeg"));
    } else {
      const { framePaths, frameDir: fd } = await extractVideoFrames(filePath, 4);
      frameDir = fd;
      if (!framePaths.length) return null;
      imageParts = await Promise.all(framePaths.map((fp) => fileToBase64Part(fp)));
    }

    const body = {
      contents: [{
        parts: [
          ...imageParts,
          { text: ANALYZE_PROMPT },
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
      },
    };

    const response = await axios.post(url, body, {
      timeout: 30000,
      headers: { "Content-Type": "application/json" },
    });

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const result = safeJsonParse(text, null);

    if (!result || typeof result.description !== "string") return null;

    return {
      description: result.description || "",
      tags: Array.isArray(result.tags) ? result.tags.map((t) => String(t).toLowerCase().trim()) : [],
      location: {
        city: String(result.location?.city || "").trim(),
        country: String(result.location?.country || "").trim(),
      },
      type_hint: result.type_hint || "other",
      analyzed_at: new Date().toISOString(),
      analyzed_by: "gemini-flash",
    };
  } catch (error) {
    logger.warn("geminiService: falha ao analisar mídia", { message: error.message, filePath });
    return null;
  } finally {
    if (frameDir) await fs.remove(frameDir).catch(() => null);
  }
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
  analyzeMediaFile,
  basicGeminiHealthcheck,
};
