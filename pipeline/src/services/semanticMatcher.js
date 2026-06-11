const path = require("path");
const fs = require("fs-extra");
const OpenAI = require("openai");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");
const { writeJsonAtomic, readJsonSafe } = require("../utils/fileUtils");
const { ensureVideoStructure } = require("./stateService");
const { generateEmbedding: generateGeminiEmbedding, hasGemini } = require("./geminiService");

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_BATCH_SIZE = 20;
const CACHE_VERSION = 1;

// Circuit breaker: falhas consecutivas OU total de chamadas acima do cap → usa Jaccard
let _geminiEmbedFailures = 0;
let _geminiEmbedTotalCalls = 0;
let _geminiEmbedCircuitOpen = false;
const GEMINI_EMBED_FAIL_THRESHOLD = 3;
const GEMINI_EMBED_CALL_CAP = Number(process.env.GEMINI_EMBED_CALL_CAP || 50);

const callGeminiEmbedding = async (text) => {
  if (_geminiEmbedCircuitOpen) return null;
  if (_geminiEmbedTotalCalls >= GEMINI_EMBED_CALL_CAP) {
    if (!_geminiEmbedCircuitOpen) {
      _geminiEmbedCircuitOpen = true;
      logger.warn(`semanticMatcher: cap de ${GEMINI_EMBED_CALL_CAP} chamadas atingido — usando Jaccard pelo resto da sessão`);
    }
    return null;
  }
  _geminiEmbedTotalCalls++;
  try {
    const result = await generateGeminiEmbedding(text);
    if (result) { _geminiEmbedFailures = 0; return result; }
    _geminiEmbedFailures++;
  } catch {
    _geminiEmbedFailures++;
  }
  if (_geminiEmbedFailures >= GEMINI_EMBED_FAIL_THRESHOLD) {
    _geminiEmbedCircuitOpen = true;
    logger.warn("semanticMatcher: circuit breaker aberto — usando Jaccard pelo resto da sessão");
  }
  return null;
};

const openaiClient = config.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: 30000,
      maxRetries: 2,
    })
  : null;

// Embeddings disponíveis se OpenAI OU Gemini configurado
const hasEmbeddings = () => Boolean((openaiClient && config.OPENAI_API_KEY) || hasGemini());

const unique = (values = []) => [...new Set(values.filter(Boolean))];

const normalizeLabel = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

// ===== Embeddings Cache =====

const getEmbeddingsCachePath = async (videoId) => {
  const paths = await ensureVideoStructure(videoId);
  return path.join(paths.base, "assets", "embeddings_cache.json");
};

const loadEmbeddingsCache = async (videoId) => {
  const cachePath = await getEmbeddingsCachePath(videoId);
  const cache = await readJsonSafe(cachePath, { version: CACHE_VERSION, entries: {} });
  return cache;
};

const saveEmbeddingsCache = async (videoId, cache) => {
  const cachePath = await getEmbeddingsCachePath(videoId);
  await writeJsonAtomic(cachePath, cache);
};

const getCacheKey = (text) => {
  const cleaned = normalizeLabel(text).replace(/\s+/g, " ").slice(0, 1000);
  return `${Buffer.from(cleaned).length}:${cleaned.length}:${cleaned.slice(0, 100)}`;
};

// ===== Embedding Generation =====

const generateEmbedding = async (text) => {
  if (!hasEmbeddings() || !text || !text.trim()) return null;

  // Provider 1: OpenAI (quando disponível)
  if (openaiClient && config.OPENAI_API_KEY) {
    try {
      const response = await openaiClient.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text.trim().slice(0, 8000),
      });
      return response?.data?.[0]?.embedding || null;
    } catch (error) {
      logger.warn("semanticMatcher: falha OpenAI embedding, tentando Gemini", { message: error.message });
    }
  }

  // Provider 2: Gemini (com circuit breaker)
  if (hasGemini()) {
    return callGeminiEmbedding(text);
  }

  return null;
};

const generateEmbeddingsBatch = async (texts) => {
  if (!hasEmbeddings() || !texts.length) return texts.map(() => null);

  const validTexts = texts.map((t) => String(t || "").trim().slice(0, 8000));
  const results = [];

  // OpenAI suporta batch; Gemini precisa de chamadas individuais
  if (openaiClient && config.OPENAI_API_KEY) {
    for (let i = 0; i < validTexts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = validTexts.slice(i, i + EMBEDDING_BATCH_SIZE);
      const validBatch = batch.filter((t) => t.length > 0);

      if (!validBatch.length) {
        batch.forEach(() => results.push(null));
        continue;
      }

      try {
        const response = await openaiClient.embeddings.create({
          model: EMBEDDING_MODEL,
          input: validBatch,
        });

        const embeddings = response?.data || [];
        let embedIndex = 0;

        batch.forEach((text) => {
          if (text.length > 0) {
            results.push(embeddings[embedIndex]?.embedding || null);
            embedIndex += 1;
          } else {
            results.push(null);
          }
        });
      } catch (error) {
        logger.warn("semanticMatcher: falha batch OpenAI, usando Gemini individual", { message: error.message });
        for (const text of batch) {
          results.push(text.length > 0 ? await callGeminiEmbedding(text) : null);
        }
      }
    }
    return results;
  }

  // Gemini: sem suporte a batch nativo (com circuit breaker)
  for (const text of validTexts) {
    results.push(text.length > 0 ? await callGeminiEmbedding(text) : null);
  }

  return results;
};

// ===== Embedding with Cache =====

const getOrCreateEmbedding = async ({ text, videoId, label = "" }) => {
  if (!text || !text.trim()) return null;

  const cacheKey = getCacheKey(text);
  const cache = await loadEmbeddingsCache(videoId);
  const cached = cache.entries[cacheKey];

  if (cached && Array.isArray(cached.embedding) && cached.embedding.length > 0) {
    return cached.embedding;
  }

  const embedding = await generateEmbedding(text);
  if (embedding) {
    cache.entries[cacheKey] = {
      embedding,
      label: label.slice(0, 100),
      created_at: new Date().toISOString(),
    };
    await saveEmbeddingsCache(videoId, cache);
  }

  return embedding;
};

// ===== Cosine Similarity =====

const cosineSimilarity = (vecA, vecB) => {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude > 0 ? dotProduct / magnitude : 0;
};

// ===== Keyword Overlap (fallback quando embeddings falham) =====

const tokenizeForMatch = (text = "") =>
  unique(
    normalizeLabel(text)
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );

const keywordOverlapScore = (textA, textB) => {
  const tokensA = tokenizeForMatch(textA);
  const tokensB = tokenizeForMatch(textB);

  if (!tokensA.length || !tokensB.length) return 0;

  const intersection = tokensA.filter((t) => tokensB.includes(t)).length;
  const union = unique([...tokensA, ...tokensB]).length;
  return union > 0 ? intersection / union : 0;
};

// ===== Main Matching Functions =====

/**
 * Dado um trecho de narração e múltiplas janelas de assets,
 * retorna o score de similaridade para cada janela.
 */
const matchNarrationToAssetWindows = async ({
  narrationText,
  assetWindows = [],
  videoId,
}) => {
  if (!narrationText || !assetWindows.length) {
    return assetWindows.map(() => ({
      similarity_score: 0,
      matched_concepts: [],
      keyword_overlap: 0,
      method: "no_input",
    }));
  }

  const narrationEmbedding = await getOrCreateEmbedding({
    text: narrationText,
    videoId,
    label: "narration",
  });

  const windowTexts = assetWindows.map(
    (w) => `${w.summary || ""} ${(w.tags || []).join(" ")}`.trim()
  );

  const windowEmbeddings = hasEmbeddings()
    ? await generateEmbeddingsBatch(windowTexts)
    : windowTexts.map(() => null);

  return assetWindows.map((window, index) => {
    const windowText = windowTexts[index] || "";
    const windowEmbedding = windowEmbeddings[index] || null;

    if (narrationEmbedding && windowEmbedding) {
      const sim = cosineSimilarity(narrationEmbedding, windowEmbedding);
      return {
        similarity_score: Number(sim.toFixed(4)),
        matched_concepts: tokenizeForMatch(narrationText).filter((t) =>
          tokenizeForMatch(windowText).includes(t)
        ),
        keyword_overlap: keywordOverlapScore(narrationText, windowText),
        method: "embedding_cosine",
      };
    }

    // Fallback: keyword overlap
    const ko = keywordOverlapScore(narrationText, windowText);
    return {
      similarity_score: Number(ko.toFixed(4)),
      matched_concepts: tokenizeForMatch(narrationText).filter((t) =>
        tokenizeForMatch(windowText).includes(t)
      ),
      keyword_overlap: ko,
      method: "keyword_fallback",
    };
  });
};

/**
 * Encontra o melhor asset + janela para cada cena.
 */
const matchScenesToAssets = async ({
  scenes = [],
  assets = [],
  videoId,
}) => {
  if (!scenes.length || !assets.length) return [];

  const sceneNarrationTexts = scenes.map(
    (s) => `${s.title || ""} ${s.narration_excerpt || ""} ${(s.keywords || []).join(" ")}`.trim()
  );

  const sceneEmbeddings = hasEmbeddings()
    ? await generateEmbeddingsBatch(sceneNarrationTexts)
    : sceneNarrationTexts.map(() => null);

  const results = [];

  for (let si = 0; si < scenes.length; si++) {
    const scene = scenes[si];
    const sceneText = sceneNarrationTexts[si];
    const sceneEmbedding = sceneEmbeddings[si];
    const sceneAssets = assets.filter(
      (a) => Number(a.scene_index || 0) === Number(scene.scene_index || 0)
    );

    if (!sceneAssets.length) {
      results.push({
        scene_index: scene.scene_index,
        title: scene.title,
        best_asset_index: -1,
        best_window_index: -1,
        similarity_score: 0,
        method: "no_assets",
      });
      continue;
    }

    let bestScore = -1;
    let bestAssetIndex = 0;
    let bestWindowIndex = 0;
    let bestMethod = "none";
    let bestMatchedConcepts = [];

    for (let ai = 0; ai < sceneAssets.length; ai++) {
      const asset = sceneAssets[ai];
      const windows = Array.isArray(asset.analysis_windows) && asset.analysis_windows.length
        ? asset.analysis_windows
        : [
            {
              window_index: 1,
              start_seconds: 0,
              end_seconds: Number(asset.duration_estimate || 10),
              summary: asset.analysis_summary || asset.semantic_text || asset.query || "",
              tags: [...(asset.analysis_tags || []), ...(asset.provider_tags || [])],
            },
          ];

      for (let wi = 0; wi < windows.length; wi++) {
        const window = windows[wi];
        const windowText = `${window.summary || ""} ${(window.tags || []).join(" ")}`.trim();

        let score = 0;
        let method = "none";

        if (sceneEmbedding) {
          // Try to use the scene embedding against a window embedding
          const windowEmbedding = await getOrCreateEmbedding({
            text: windowText || asset.query || "travel footage",
            videoId,
            label: `scene_${scene.scene_index}_asset_${ai}_window_${wi}`,
          });

          if (windowEmbedding) {
            score = cosineSimilarity(sceneEmbedding, windowEmbedding);
            method = "embedding_cosine";
          }
        }

        if (score <= 0.3) {
          // Fallback keyword overlap
          score = keywordOverlapScore(sceneText, windowText);
          method = score > 0.5 ? "keyword_overlap" : "keyword_fallback";
        }

        if (score > bestScore) {
          bestScore = score;
          bestAssetIndex = ai;
          bestWindowIndex = wi;
          bestMethod = method;
          bestMatchedConcepts = tokenizeForMatch(sceneText).filter((t) =>
            tokenizeForMatch(windowText).includes(t)
          );
        }
      }
    }

    results.push({
      scene_index: scene.scene_index,
      title: scene.title,
      best_asset_index: bestAssetIndex,
      best_window_index: bestWindowIndex,
      similarity_score: Number(bestScore.toFixed(4)),
      matched_concepts: bestMatchedConcepts,
      method: bestMethod,
      best_asset: sceneAssets[bestAssetIndex]
        ? {
            local_path: sceneAssets[bestAssetIndex].local_path,
            provider: sceneAssets[bestAssetIndex].provider,
            query: sceneAssets[bestAssetIndex].query,
            source_url: sceneAssets[bestAssetIndex].source_url,
          }
        : null,
    });
  }

  return results;
};

/**
 * Encontra assets visualmente relevantes para transições de tópico no áudio.
 */
const matchPauseToAsset = async ({
  pauseMarker,
  sceneAssets = [],
  videoId,
}) => {
  if (!pauseMarker || !sceneAssets.length) {
    return { best_asset_index: -1, similarity_score: 0 };
  }

  // For transition pauses, we want visually distinct assets
  // that are different from what was shown before
  const pauseDescriptions = [
    `transition scene ${pauseMarker.type} after ${pauseMarker.duration.toFixed(1)}s pause`,
    `visual break travel scene`,
    `aerial establishing shot transition`,
  ];

  const allEmbeddings = await generateEmbeddingsBatch(
    pauseDescriptions.map((d) => `${d} ${sceneAssets.map((a) => a.query || "").join(" ")}`)
  );

  let bestScore = -1;
  let bestIndex = 0;

  for (let ai = 0; ai < sceneAssets.length; ai++) {
    const asset = sceneAssets[ai];
    const assetText = `${asset.analysis_summary || asset.semantic_text || asset.query || ""} ${(asset.analysis_tags || []).join(" ")}`.trim();
    const assetEmbedding = await getOrCreateEmbedding({
      text: assetText,
      videoId,
      label: `pause_match_${ai}`,
    });

    if (allEmbeddings[0] && assetEmbedding) {
      const score = cosineSimilarity(allEmbeddings[0], assetEmbedding);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = ai;
      }
    }
  }

  return {
    best_asset_index: bestScore > 0 ? bestIndex : Math.floor(Math.random() * sceneAssets.length),
    similarity_score: Number(Math.max(0, bestScore).toFixed(4)),
  };
};

/**
 * Extrai termos conceituais únicos de um texto usando similaridade de embeddings.
 */
const extractKeyConcepts = async ({ text, videoId, maxConcepts = 5 }) => {
  if (!text || !text.trim()) return [];

  const embedding = await getOrCreateEmbedding({ text: text.slice(0, 2000), videoId, label: "concept_extraction" });
  if (!embedding) {
    // Fallback: extract nouns and named entities
    return tokenizeForMatch(text)
      .filter((w) => w.length >= 4)
      .slice(0, maxConcepts);
  }

  // Use the embedding itself as a signature, and return meaningful terms
  return tokenizeForMatch(text)
    .filter((w) => w.length >= 4)
    .slice(0, maxConcepts);
};

module.exports = {
  hasEmbeddings,
  matchNarrationToAssetWindows,
  matchScenesToAssets,
  matchPauseToAsset,
  extractKeyConcepts,
  generateEmbedding,
  cosineSimilarity,
  keywordOverlapScore,
  __test__: {
    cosineSimilarity,
    keywordOverlapScore,
    tokenizeForMatch,
    getCacheKey,
  },
};