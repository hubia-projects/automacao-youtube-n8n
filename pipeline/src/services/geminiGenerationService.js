/**
 * Gemini fallback generator — cria imagem via Imagen 3 quando nenhum clip
 * de stock/biblioteca passa os gates geográficos ou de entidade nomeada.
 *
 * Fluxo:
 *  1. Constrói prompt fotográfico neutro e geo-ancorado a partir do bloco.
 *  2. Chama Imagen 3 (REST) → recebe PNG em base64.
 *  3. Salva PNG em disco (cache por hash do prompt).
 *  4. Aplica Ken Burns (zoompan FFmpeg) → MP4 de 5s.
 *  5. Retorna objeto de asset compatível com o pipeline.
 */

const path = require("path");
const fs = require("fs-extra");
const crypto = require("crypto");
const axios = require("axios");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");

const IMAGEN_MODEL = "imagen-3.0-generate-002";
const IMAGEN_BASE = "https://generativelanguage.googleapis.com/v1beta";

const isImagenEnabled = () => Boolean(config.GEMINI_API_KEY) && !config.DISABLE_GEMINI_GENERATION;

const getCacheDir = () => path.join(config.OUTPUT_ROOT || "output", "cache", "generated_assets");

const promptHash = (prompt) => crypto.createHash("sha1").update(prompt).digest("hex").slice(0, 16);

/**
 * Constrói um prompt fotográfico realista para o Imagen a partir do bloco narrativo.
 */
const buildImagePrompt = (block = {}) => {
  const city = block.location?.city || block.block_label || "";
  const country = block.expected_country || block.location?.country || "Portugal";
  const topic = block.topic || block.macro_topic || "";
  const subtheme = block.subtheme || "";
  const landmarks = (block.landmarks || []).map((l) => l.name).join(", ");

  const parts = [
    "Cinematic travel photograph,",
    "golden hour lighting,",
    "professional DSLR,",
    "sharp focus,",
    "8K resolution,",
    "no text,",
    "no watermark,",
  ];

  if (landmarks) parts.push(`featuring ${landmarks},`);
  if (city) parts.push(`in ${city},`);
  if (country) parts.push(`${country},`);
  if (topic) parts.push(`${topic},`);
  if (subtheme === "bridge") parts.push("iconic bridge over river,");
  else if (subtheme === "riverfront") parts.push("riverside waterfront, boats,");
  else if (subtheme === "beach") parts.push("sandy beach, clear ocean water,");
  else if (subtheme === "historic_center") parts.push("historic cobblestone streets, colorful facades,");
  else if (subtheme === "architecture") parts.push("impressive architecture, ornate details,");
  else if (subtheme === "viewpoint") parts.push("panoramic cityscape view from viewpoint,");
  else if (subtheme === "food") parts.push("authentic local food, traditional cuisine,");
  else parts.push("scenic travel destination,");

  parts.push("photorealistic, ultra-detailed.");

  return parts.join(" ");
};

/**
 * Chama Imagen 3 e retorna o buffer PNG (null em falha).
 */
const generateImageBuffer = async (prompt) => {
  if (!isImagenEnabled()) return null;

  const url = `${IMAGEN_BASE}/models/${IMAGEN_MODEL}:predict?key=${config.GEMINI_API_KEY}`;
  try {
    const response = await axios.post(
      url,
      {
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: "16:9", safetyFilterLevel: "block_only_high" },
      },
      { timeout: 60000, headers: { "Content-Type": "application/json" } }
    );

    const b64 = response.data?.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) return null;
    return Buffer.from(b64, "base64");
  } catch (error) {
    logger.warn("geminiGenerationService: Imagen call failed", {
      message: error.message,
      status: error.response?.status,
    });
    return null;
  }
};

/**
 * Aplica Ken Burns (zoom lento + pan suave) ao PNG → MP4 de durationSec segundos.
 * Usa zoompan do FFmpeg para aparência profissional.
 */
const resolveFfmpegPath = () => {
  try {
    const fromStatic = require("ffmpeg-static");
    // ffmpeg-static pode devolver um path cujo binário não existe (ex: install incompleto).
    // Validamos com fs.pathExistsSync antes de aceitar.
    if (fromStatic && typeof fromStatic === "string" && fs.pathExistsSync(fromStatic)) return fromStatic;
  } catch {
    // ignore — fallback abaixo
  }
  if (process.env.FFMPEG_BIN && fs.pathExistsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  const fallbacks = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"];
  for (const candidate of fallbacks) {
    if (fs.pathExistsSync(candidate)) return candidate;
  }
  return null;
};

const applyKenBurns = async (imagePath, outputPath, durationSec = 5, opts = {}) => {
  const { spawn } = require("child_process");
  const ffmpegPath = opts.ffmpegPath || resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("ffmpeg binary not found — set FFMPEG_BIN env or ensure ffmpeg-static is installed");
  }
  const fps = 25;
  const totalFrames = durationSec * fps;

  // Zoom de 1.0 → 1.08 com pan diagonal suave
  const zoompan = `zoompan=z='min(zoom+0.001,1.08)':x='iw/2-(iw/zoom/2)+sin(on/${totalFrames}*PI)*20':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1920x1080:fps=${fps}`;

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      "-loop", "1",
      "-i", imagePath,
      "-vf", zoompan,
      "-t", String(durationSec),
      "-c:v", "libx264",
      "-preset", "fast",
      "-pix_fmt", "yuv420p",
      "-an",
      "-y",
      outputPath,
    ]);

    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ken burns exited ${code}`))));
    proc.on("error", reject);
  });
};

/**
 * Ponto de entrada principal.
 * Retorna objeto de asset compatível com o pipeline, ou null em falha.
 *
 * @param {object} block  Bloco narrativo com location, topic, subtheme, landmarks
 * @param {string} videoId  ID do vídeo (para organizar cache)
 */
const generateFallbackAsset = async (block = {}, videoId = "generated") => {
  if (!isImagenEnabled()) return null;

  const prompt = buildImagePrompt(block);
  const hash = promptHash(prompt);
  const cacheDir = path.join(getCacheDir(), videoId);
  await fs.ensureDir(cacheDir);

  const imagePath = path.join(cacheDir, `${hash}.png`);
  const videoPath = path.join(cacheDir, `${hash}.mp4`);

  // Verificar cache em disco
  if (await fs.pathExists(videoPath)) {
    logger.info("geminiGenerationService: cache hit", { hash, videoPath });
    return buildAssetObject({ videoPath, imagePath, prompt, block, hash, cached: true });
  }

  logger.info("geminiGenerationService: gerando imagem para bloco", {
    topic: block.topic,
    city: block.location?.city,
    landmarks: (block.landmarks || []).map((l) => l.name),
  });

  const imageBuffer = await generateImageBuffer(prompt);
  if (!imageBuffer) {
    logger.warn("geminiGenerationService: Imagen retornou null", { topic: block.topic });
    return null;
  }

  await fs.writeFile(imagePath, imageBuffer);

  try {
    await applyKenBurns(imagePath, videoPath, 5);
  } catch (kbError) {
    logger.warn("geminiGenerationService: Ken Burns falhou", { message: kbError.message });
    return null;
  }

  logger.info("geminiGenerationService: asset gerado com sucesso", { videoPath });
  return buildAssetObject({ videoPath, imagePath, prompt, block, hash, cached: false });
};

const buildAssetObject = ({ videoPath, imagePath, prompt, block, hash, cached }) => ({
  asset_id: `generated_${hash}`,
  source_url: videoPath,
  local_path: videoPath,
  asset_type: "video",
  provider: "gemini_imagen",
  source: "gemini_generated",
  description: prompt.slice(0, 200),
  semantic_text: prompt.slice(0, 200),
  tags: ["generated", "gemini", "ken_burns"],
  location: {
    city: block.location?.city || "",
    country: block.expected_country || block.location?.country || "Portugal",
    confidence: 0.95,
  },
  landmarks: block.landmarks || [],
  duration_sec: 5,
  quality: { resolution_score: 0.9, brightness: 0.75 },
  visual_evidence_source: "gemini_generated",
  analysis_provider: "gemini_generated",
  neutral: false,
  generated: true,
  cached,
  generation_prompt: prompt,
});

module.exports = {
  isImagenEnabled,
  generateFallbackAsset,
  buildImagePrompt,
  applyKenBurns,
};
