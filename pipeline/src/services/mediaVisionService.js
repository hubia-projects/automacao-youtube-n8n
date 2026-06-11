const path = require("path");
const crypto = require("crypto");
const fs = require("fs-extra");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");
const { writeJsonAtomic, readJsonSafe } = require("../utils/fileUtils");
const { extractVideoFrame } = require("../utils/mediaUtils");
const { hasOpenAi, describeImagesWithOpenAI } = require("./openaiService");
const { hasGemini, describeImagesWithGemini } = require("./geminiService");

const SCHEMA_VERSION = 1;

const round3 = (value) => Number(Number(value || 0).toFixed(3));

const isVisionEnabled = () => Boolean(config.MEDIA_VISION_ENABLED) && (hasOpenAi() || hasGemini());

/**
 * Hash rápido do arquivo: tamanho + primeiro e último MB.
 * Suficiente para identificar o mesmo download sem ler GBs.
 */
const hashFile = async (filePath) => {
  const stat = await fs.stat(filePath);
  const hash = crypto.createHash("sha1");
  hash.update(String(stat.size));

  const chunkSize = 1024 * 1024;
  const fd = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(Math.min(chunkSize, stat.size));
    await fs.read(fd, head, 0, head.length, 0);
    hash.update(head);

    if (stat.size > chunkSize * 2) {
      const tail = Buffer.alloc(chunkSize);
      await fs.read(fd, tail, 0, tail.length, stat.size - chunkSize);
      hash.update(tail);
    }
  } finally {
    await fs.close(fd);
  }

  return hash.digest("hex");
};

const getVisionCachePath = (fileHash) =>
  path.join(config.OUTPUT_ROOT, "cache", "vision", `${fileHash}.json`);

/**
 * Prompt NEUTRO: nenhum contexto de cena/narração. O modelo descreve o que
 * vê; identifica cidade/país apenas com evidência visual (landmark,
 * arquitetura inequívoca). A comparação cena↔clip acontece no scoring.
 * Prompt independente de cena = cache reutilizável entre cenas e vídeos.
 */
const buildNeutralVisionPrompt = (windowBlueprints = []) => `Analise os frames em ordem. Cada frame é uma janela de tempo diferente do mesmo vídeo.

Regras:
- descreva APENAS o que está visível, de forma objetiva
- identifique cidade/país SOMENTE com evidência visual clara (landmark reconhecível, arquitetura inequívoca, placa legível); na dúvida deixe city e country vazios com confidence 0
- nomeie landmarks reconhecidos (ex: "Ponte Dom Luís", "Coliseu", "Torre Eiffel")
- se o conteúdo for genérico (céu, água, multidão sem contexto), marque generic_visual true
- não use nenhum conhecimento externo além dos pixels

Retorne JSON estrito:
{
  "overall_summary": "",
  "overall_tags": [""],
  "windows": [
    {
      "frame_index": 1,
      "summary": "",
      "tags": [""],
      "location": {"city": "", "country": "", "confidence": 0.0},
      "landmarks": [{"name": "", "confidence": 0.0}],
      "location_type": "",
      "generic_visual": false,
      "visual_features": {
        "shot_type": "wide|medium|detail|aerial|unknown",
        "camera_motion": "static|pan|tilt|drone|tracking|unknown",
        "dominant_colors": [""],
        "has_people": false,
        "has_water": false,
        "has_architecture": false
      },
      "quality": {"sharpness": 0.0, "stability": 0.0, "brightness": 0.0, "usable": true},
      "confidence": 0.0
    }
  ]
}

Os frames correspondem a ${windowBlueprints.map((window) => `frame ${window.window_index} = ${window.start_seconds}s até ${window.end_seconds}s`).join("; ")}.`;

const describeImages = async ({ prompt, imagePaths }) => {
  if (hasOpenAi()) {
    try {
      const response = await describeImagesWithOpenAI({ prompt, imagePaths, detail: "low" });
      if (response) return { response, provider: "openai_vision" };
    } catch (error) {
      logger.warn("mediaVisionService: falha OpenAI vision, tentando Gemini", { message: error.message });
    }
  }

  if (hasGemini()) {
    const response = await describeImagesWithGemini({ prompt, imagePaths });
    if (response) return { response, provider: "gemini_vision" };
  }

  return { response: null, provider: "" };
};

/**
 * Analisa um vídeo com visão LLM, cacheado por hash de arquivo.
 * O resultado é neutro (independente de cena) e reutilizável.
 *
 * @returns {object|null} { schema_version, file_hash, provider, windows: [...], overall_summary, overall_tags }
 */
const analyzeMediaCached = async ({ filePath, windowBlueprints = [] }) => {
  if (!isVisionEnabled() || !filePath || !windowBlueprints.length) return null;
  if (!(await fs.pathExists(filePath))) return null;

  let fileHash = "";
  try {
    fileHash = await hashFile(filePath);
  } catch (error) {
    logger.warn("mediaVisionService: falha ao calcular hash", { filePath, message: error.message });
    return null;
  }

  const cachePath = getVisionCachePath(fileHash);
  const cached = await readJsonSafe(cachePath, null);
  if (cached && cached.schema_version === SCHEMA_VERSION && Array.isArray(cached.windows)) {
    return cached;
  }

  const framesDir = path.join(config.OUTPUT_ROOT, "cache", "vision", `frames_${fileHash}`);

  try {
    await fs.ensureDir(framesDir);
    const framePaths = [];

    for (const windowBlueprint of windowBlueprints) {
      const framePath = path.join(framesDir, `window-${String(windowBlueprint.window_index).padStart(2, "0")}.jpg`);
      await extractVideoFrame({
        inputPath: filePath,
        outputPath: framePath,
        timeSeconds: windowBlueprint.sample_time_seconds,
      });
      framePaths.push(framePath);
    }

    const { response, provider } = await describeImages({
      prompt: buildNeutralVisionPrompt(windowBlueprints),
      imagePaths: framePaths,
    });

    if (!response) {
      logger.warn("mediaVisionService: visão LLM sem resposta", { filePath });
      return null;
    }

    const payload = {
      schema_version: SCHEMA_VERSION,
      file_hash: fileHash,
      provider,
      analyzed_at: new Date().toISOString(),
      overall_summary: response.overall_summary || response.summary || "",
      overall_tags: Array.isArray(response.overall_tags) ? response.overall_tags.slice(0, 16) : [],
      windows: (Array.isArray(response.windows) ? response.windows : []).map((window, index) => ({
        frame_index: Number(window.frame_index || index + 1),
        window_index: windowBlueprints[index]?.window_index || index + 1,
        start_seconds: round3(windowBlueprints[index]?.start_seconds || 0),
        end_seconds: round3(windowBlueprints[index]?.end_seconds || 0),
        sample_time_seconds: round3(windowBlueprints[index]?.sample_time_seconds || 0),
        summary: window.summary || window.description || "",
        tags: Array.isArray(window.tags) ? window.tags.slice(0, 12) : [],
        location: {
          city: String(window.location?.city || "").trim(),
          country: String(window.location?.country || "").trim(),
          confidence: Math.max(0, Math.min(1, Number(window.location?.confidence || 0))),
        },
        landmarks: (Array.isArray(window.landmarks) ? window.landmarks : [])
          .map((landmark) => ({
            name: String(landmark?.name || "").trim(),
            confidence: Math.max(0, Math.min(1, Number(landmark?.confidence || 0))),
          }))
          .filter((landmark) => landmark.name)
          .slice(0, 5),
        location_type: window.location_type || "",
        generic_visual: Boolean(window.generic_visual),
        visual_features: {
          shot_type: window.visual_features?.shot_type || "unknown",
          camera_motion: window.visual_features?.camera_motion || "unknown",
          dominant_colors: Array.isArray(window.visual_features?.dominant_colors) ? window.visual_features.dominant_colors.slice(0, 5) : [],
          has_people: Boolean(window.visual_features?.has_people),
          has_water: Boolean(window.visual_features?.has_water),
          has_architecture: Boolean(window.visual_features?.has_architecture),
        },
        quality: {
          sharpness: Math.max(0, Math.min(1, Number(window.quality?.sharpness ?? 0.7))),
          stability: Math.max(0, Math.min(1, Number(window.quality?.stability ?? 0.7))),
          brightness: Math.max(0, Math.min(1, Number(window.quality?.brightness ?? 0.7))),
          usable: window.quality?.usable !== false,
        },
        confidence: Math.max(0, Math.min(1, Number(window.confidence || 0.6))),
      })),
    };

    await fs.ensureDir(path.dirname(cachePath));
    await writeJsonAtomic(cachePath, payload);
    return payload;
  } catch (error) {
    logger.warn("mediaVisionService: falha na análise visual", { filePath, message: error.message });
    return null;
  } finally {
    await fs.remove(framesDir).catch(() => null);
  }
};

module.exports = {
  analyzeMediaCached,
  isVisionEnabled,
  __test__: {
    hashFile,
    buildNeutralVisionPrompt,
    getVisionCachePath,
  },
};
