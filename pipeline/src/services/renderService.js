const path = require("path");
const fs = require("fs-extra");
const { ensureVideoStructure, loadState, updateState } = require("./stateService");
const { sendWorkflowStatus } = require("./telegramService");
const { createPlaceholderImage, probeMedia, runFfmpeg } = require("../utils/mediaUtils");
const { isPlaceholderAsset, shouldAllowPlaceholderAssets } = require("./assetReadinessService");
const { buildTimeline, chooseOutputResolution } = require("./timelinePlanner");
const { analyzeAudio } = require("./audioIntelligence");
const { applyOverlaysToVideo, buildBlockOverlays } = require("./overlayService");
const { config } = require("../config/env");
const { logger } = require("../utils/logger");

const isVideoFile = (filePath = "") => /\.(mp4|mov|webm|mkv|avi)$/i.test(filePath);
const isImageFile = (filePath = "") => /\.(jpg|jpeg|png|webp)$/i.test(filePath);

const MIN_OUTPUT = { width: 1280, height: 720 };
const PREFERRED_OUTPUT = { width: Number(config.OUTPUT_WIDTH || 1920), height: Number(config.OUTPUT_HEIGHT || 1080) };
const VIDEO_BITRATE = String(config.VIDEO_BITRATE || "6M");
const MAX_VIDEO_BITRATE = String(config.MAX_VIDEO_BITRATE || "8M");
const AUDIO_BITRATE = "192k";
const TRANSITION_DURATION = 0.45;
const TARGET_AVERAGE_CLIP_DURATION = 6;
const MIN_CLIP_DURATION = 3;
const MAX_CLIP_DURATION = 10;
const OUTPUT_FPS = Number(config.OUTPUT_FPS || 30);
const SCRIPT_TERM_STOPWORDS = new Set([
  "a",
  "ao",
  "aos",
  "as",
  "com",
  "como",
  "da",
  "das",
  "de",
  "do",
  "dos",
  "e",
  "em",
  "foco",
  "local",
  "no",
  "nos",
  "o",
  "os",
  "para",
  "por",
  "travel",
  "video",
  "visual",
]);
const SEMANTIC_ALIAS_GROUPS = [
  ["lisboa", "lisbon"],
  ["porto", "oporto"],
  ["sintra"],
  ["miradouro", "miradouros", "viewpoint", "viewpoints", "overlook", "overlooks", "panorama", "panoramic", "skyline"],
  ["eletrico", "eletricos", "tram", "trams", "streetcar", "streetcars"],
  ["bonde", "bondes", "tram", "trams", "streetcar", "streetcars"],
  ["azulejo", "azulejos", "tile", "tiles", "facade", "facades"],
  ["rua", "ruas", "street", "streets", "alley", "alleys"],
  ["douro", "river", "riverside", "waterfront"],
  ["rio", "river", "riverside", "waterfront"],
  ["ponte", "pontes", "bridge", "bridges"],
  ["palacio", "palacios", "palace", "palaces"],
  ["castelo", "castelos", "castle", "castles"],
  ["mata", "matas", "forest", "forests", "woods", "woodland"],
  ["floresta", "florestas", "forest", "forests", "woods", "woodland"],
  ["litoral", "costa", "coast", "coastline", "shore", "shoreline", "coastal"],
  ["praia", "praias", "beach", "beaches", "seaside"],
  ["mar", "mares", "sea", "ocean", "waters"],
  ["falesia", "falesias", "cliff", "cliffs"],
  ["mercado", "mercados", "market", "markets"],
  ["gastronomia", "culinaria", "food", "foods", "gastronomy", "culinary"],
  ["comida", "prato", "pratos", "food", "dish", "dishes", "meal", "meals"],
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round3 = (value) => Number(Number(value || 0).toFixed(3));
const sumValues = (values = []) => round3(values.reduce((acc, value) => acc + Number(value || 0), 0));
const unique = (values = []) => [...new Set(values.filter(Boolean))];
const normalizeLabel = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
const tokenizeNormalizedWords = (value = "") =>
  normalizeLabel(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
const semanticAliasMap = SEMANTIC_ALIAS_GROUPS.reduce((map, group) => {
  const normalizedGroup = unique(group.map((term) => normalizeLabel(term)));
  normalizedGroup.forEach((term) => map.set(term, normalizedGroup));
  return map;
}, new Map());
const buildSemanticTerms = (values = []) =>
  unique(
    tokenizeNormalizedWords(values.filter(Boolean).join(" "))
      .flatMap((term) => semanticAliasMap.get(term) || [term])
      .filter((term) => term.length >= 3 && !SCRIPT_TERM_STOPWORDS.has(term))
  );

const rotate = (items, offset = 0) => {
  if (!items.length) return [];
  const normalizedOffset = ((offset % items.length) + items.length) % items.length;
  return items.slice(normalizedOffset).concat(items.slice(0, normalizedOffset));
};

const createFallbackImage = async (outputPath, seed = 1) =>
  createPlaceholderImage({ outputPath, width: PREFERRED_OUTPUT.width, height: PREFERRED_OUTPUT.height, seed });

const getDraftVersion = (state) => Math.max(1, Number(state.review?.draft_version || 1));
const getAssetDuration = (asset = {}) => Number(asset.source_duration_seconds || asset.duration_estimate || 0);
const isVideoAsset = (asset = {}) => (asset.asset_type || asset.type || "") === "video" || isVideoFile(asset.local_path || "");

const getAssetResolution = (asset = {}) => ({
  width: Number(asset.resolution?.width || 0),
  height: Number(asset.resolution?.height || 0),
});

const buildSceneAssetMap = (items = []) => {
  const map = new Map();

  items.forEach((item, index) => {
    const sceneIndex = Number(item.scene_index || index + 1);
    const list = map.get(sceneIndex) || [];
    list.push(item);
    map.set(sceneIndex, list);
  });

  return map;
};

const normalizeScenes = (state) => {
  if (Array.isArray(state.visual_plan) && state.visual_plan.length) {
    return state.visual_plan;
  }

  const items = state.assets_json?.items || [];
  if (items.length) {
    return items.map((item, index) => ({
      scene_index: Number(item.scene_index || index + 1),
      title: `Cena ${index + 1}`,
      narration_excerpt: state.topic || "Fallback visual",
      keywords: [item.query || "travel destination"],
      target_duration_seconds: clamp(Number(item.duration_estimate || 6), MIN_CLIP_DURATION, MAX_CLIP_DURATION),
    }));
  }

  return [
    {
      scene_index: 1,
      title: "Fallback visual",
      narration_excerpt: state.topic || "Fallback visual",
      keywords: ["travel destination"],
      target_duration_seconds: 6,
    },
  ];
};


  
const chooseClipCount = ({ audioDuration, sceneCount }) => {
  const safeDuration = Math.max(8, Number(audioDuration || 0));
  const minCount = Math.max(1, Math.ceil(safeDuration / MAX_CLIP_DURATION));
  const maxCount = Math.max(minCount, Math.floor(safeDuration / MIN_CLIP_DURATION));
  const idealCount = Math.max(sceneCount || 1, Math.round(safeDuration / TARGET_AVERAGE_CLIP_DURATION));
  return clamp(idealCount, minCount, maxCount);
};

const inferSceneRole = ({ scene, index, totalScenes }) => {
  const label = normalizeLabel(`${scene.title || ""} ${scene.narration_excerpt || ""}`);

  if (/abertura|intro|hook|visao geral|opening|overview/.test(label)) {
    return "intro";
  }

  if (/fechamento|encerramento|cta|sintese final|closing|outro|final/.test(label)) {
    return "outro";
  }

  return "body";
};

const describeScenes = ({ scenes, sceneAssetMap }) =>
  scenes.map((scene, index) => ({
    ...scene,
    scene_order: index,
    total_scenes: scenes.length,
    role: inferSceneRole({ scene, index, totalScenes: scenes.length }),
    asset_count: (sceneAssetMap.get(scene.scene_index) || []).length,
  }));

const buildSceneScriptTerms = (scene = {}) =>
  buildSemanticTerms([
    scene.title,
    scene.narration_excerpt,
    ...(scene.keywords || []),
  ]);

const average = (values = []) => values.reduce((acc, value) => acc + value, 0) / Math.max(1, values.length);

const findSceneAnchorWordIndexes = ({ scenes, scriptWords = [] }) => {
  const hints = new Map();
  let previousAnchor = -1;

  scenes.forEach((scene, index) => {
    const terms = buildSceneScriptTerms(scene);
    const matchingIndexes = [];

    terms.forEach((term) => {
      const nextIndex = scriptWords.findIndex((word, wordIndex) => wordIndex > previousAnchor && word === term);
      if (nextIndex >= 0) {
        matchingIndexes.push(nextIndex);
      }
    });

    let anchorIndex;

    if (matchingIndexes.length) {
      anchorIndex = Math.round(average(matchingIndexes));
    } else if (scriptWords.length) {
      anchorIndex = Math.round(((index + 0.5) * scriptWords.length) / Math.max(1, scenes.length)) - 1;
    } else {
      anchorIndex = index;
    }

    anchorIndex = Math.max(previousAnchor + 1, anchorIndex);
    anchorIndex = Math.min(anchorIndex, Math.max(0, scriptWords.length - 1));
    previousAnchor = anchorIndex;

    hints.set(scene.scene_index, {
      scene_index: scene.scene_index,
      anchor_word_index: anchorIndex,
    });
  });

  return hints;
};

const buildSceneScriptTimingHints = ({ scenes, scriptText = "", audioDuration = 0, audioIntelligence = null }) => {
  const scriptWords = tokenizeNormalizedWords(scriptText);
  if (!scriptWords.length || !scenes.length) {
    return new Map();
  }

  // Use audio intelligence timestamps if available for precise sync
  const useWordTimestamps = audioIntelligence?.words && audioIntelligence.words.length > 0;
  const wordTimestamps = useWordTimestamps ? audioIntelligence.words : null;

  const anchorHints = findSceneAnchorWordIndexes({ scenes, scriptWords });
  const totalWords = scriptWords.length;

  return new Map(
    scenes.map((scene, index) => {
      const currentAnchor = anchorHints.get(scene.scene_index)?.anchor_word_index ?? index;
      const previousSceneAnchor = index === 0
        ? 0
        : anchorHints.get(scenes[index - 1].scene_index)?.anchor_word_index ?? 0;
      const nextSceneAnchor = index === scenes.length - 1
        ? totalWords
        : anchorHints.get(scenes[index + 1].scene_index)?.anchor_word_index ?? totalWords;
      const previousAnchor = index === 0
        ? 0
        : Math.floor((previousSceneAnchor + currentAnchor) / 2);
      const nextAnchor = index === scenes.length - 1
        ? totalWords
        : Math.floor((currentAnchor + nextSceneAnchor) / 2);
      const role = inferSceneRole({ scene, index, totalScenes: scenes.length });

      let startWordIndex = Math.max(0, previousAnchor);
      let endWordIndex = Math.max(startWordIndex + 1, Math.min(totalWords, nextAnchor));

      // When the first/last scene is a concrete topic instead of an explicit intro/outro,
      // avoid absorbing the generic opening/closing text into that topic block.
      if (index === 0 && role !== "intro" && scenes.length > 1) {
        const leadingMargin = Math.max(1, Math.ceil((nextSceneAnchor - currentAnchor) / 2));
        startWordIndex = Math.max(0, currentAnchor - leadingMargin);
      }

      if (index === scenes.length - 1 && role !== "outro" && scenes.length > 1) {
        const trailingMargin = Math.max(1, Math.ceil((currentAnchor - previousSceneAnchor) / 2));
        endWordIndex = Math.min(totalWords, currentAnchor + trailingMargin);
      }

      endWordIndex = Math.max(startWordIndex + 1, endWordIndex);
      const displayStartWordIndex = startWordIndex;
      const displayEndWordIndex = endWordIndex;
      const spanWords = Math.max(1, endWordIndex - startWordIndex);
      const displaySpanWords = Math.max(1, displayEndWordIndex - displayStartWordIndex);

      // Calculate actual timestamps if word timestamps are available
      let scriptStartSeconds = 0;
      let scriptEndSeconds = 0;
      let scriptDisplayStartSeconds = 0;
      let scriptDisplayEndSeconds = 0;

      if (useWordTimestamps && wordTimestamps[startWordIndex] && wordTimestamps[endWordIndex - 1]) {
        // Use actual word timestamps for precise sync
        scriptStartSeconds = round3(wordTimestamps[startWordIndex].start || 0);
        scriptEndSeconds = round3(wordTimestamps[endWordIndex - 1].end || audioDuration);
        scriptDisplayStartSeconds = round3(wordTimestamps[displayStartWordIndex].start || 0);
        scriptDisplayEndSeconds = round3(wordTimestamps[displayEndWordIndex - 1].end || audioDuration);
      } else {
        // Fallback to proportional timing
        scriptStartSeconds = round3((Number(audioDuration || 0) * startWordIndex) / totalWords);
        scriptEndSeconds = round3((Number(audioDuration || 0) * endWordIndex) / totalWords);
        scriptDisplayStartSeconds = round3((Number(audioDuration || 0) * displayStartWordIndex) / totalWords);
        scriptDisplayEndSeconds = round3((Number(audioDuration || 0) * displayEndWordIndex) / totalWords);
      }

      const scriptTargetDurationSeconds = round3(scriptEndSeconds - scriptStartSeconds);
      const scriptDisplayTargetDurationSeconds = round3(scriptDisplayEndSeconds - scriptDisplayStartSeconds);

      return [
        scene.scene_index,
        {
          anchor_word_index: currentAnchor,
          start_word_index: startWordIndex,
          end_word_index: endWordIndex,
          span_words: spanWords,
          display_start_word_index: displayStartWordIndex,
          display_end_word_index: displayEndWordIndex,
          display_span_words: displaySpanWords,
          script_start_seconds: scriptStartSeconds,
          script_end_seconds: scriptEndSeconds,
          script_display_start_seconds: scriptDisplayStartSeconds,
          script_display_end_seconds: scriptDisplayEndSeconds,
          script_target_duration_seconds: scriptTargetDurationSeconds,
          script_display_target_duration_seconds: scriptDisplayTargetDurationSeconds,
          script_anchor_seconds: round3((Number(audioDuration || 0) * currentAnchor) / totalWords),
        },
      ];
    })
  );
};

const mergeSceneTimingHints = ({ scenes, sceneTimingHints = new Map() }) =>
  scenes.map((scene) => ({
    ...scene,
    ...(sceneTimingHints.get(scene.scene_index) || {}),
  }));

const applyDisplayWindowToScene = ({ scene, displayStartWordIndex, displayEndWordIndex, audioDuration = 0, totalWords = 1 }) => {
  const safeStartWordIndex = clamp(Number(displayStartWordIndex || 0), 0, Math.max(0, totalWords - 1));
  const safeEndWordIndex = clamp(Number(displayEndWordIndex || 0), safeStartWordIndex + 1, totalWords);
  const displaySpanWords = Math.max(1, safeEndWordIndex - safeStartWordIndex);

  return {
    ...scene,
    display_start_word_index: safeStartWordIndex,
    display_end_word_index: safeEndWordIndex,
    display_span_words: displaySpanWords,
    script_display_start_seconds: round3((Number(audioDuration || 0) * safeStartWordIndex) / Math.max(1, totalWords)),
    script_display_end_seconds: round3((Number(audioDuration || 0) * safeEndWordIndex) / Math.max(1, totalWords)),
    script_display_target_duration_seconds: round3((Number(audioDuration || 0) * displaySpanWords) / Math.max(1, totalWords)),
  };
};

const createBridgeScene = ({
  sceneIndex,
  role,
  title,
  excerpt,
  keywords = [],
  startWordIndex,
  endWordIndex,
  audioDuration,
  totalWords,
  assetCount,
}) => {
  const baseScene = {
    scene_index: sceneIndex,
    title,
    narration_excerpt: excerpt || title,
    keywords: unique(keywords.filter(Boolean)).slice(0, 5),
    target_duration_seconds: round3((Number(audioDuration || 0) * Math.max(1, endWordIndex - startWordIndex)) / Math.max(1, totalWords)),
    role,
    synthetic_scene: true,
    asset_count: assetCount,
    start_word_index: startWordIndex,
    end_word_index: endWordIndex,
    span_words: Math.max(1, endWordIndex - startWordIndex),
    script_start_seconds: round3((Number(audioDuration || 0) * startWordIndex) / Math.max(1, totalWords)),
    script_end_seconds: round3((Number(audioDuration || 0) * endWordIndex) / Math.max(1, totalWords)),
    script_target_duration_seconds: round3((Number(audioDuration || 0) * Math.max(1, endWordIndex - startWordIndex)) / Math.max(1, totalWords)),
  };

  return applyDisplayWindowToScene({
    scene: baseScene,
    displayStartWordIndex: startWordIndex,
    displayEndWordIndex: endWordIndex,
    audioDuration,
    totalWords,
  });
};

const injectBridgeScenes = ({ scenes = [], state, audioDuration = 0, sceneAssetMap = new Map() }) => {
  if (!scenes.length) {
    return scenes;
  }

  const scriptWords = extractOriginalScriptWords(state.script_text);
  const totalWords = Math.max(1, scriptWords.length);
  const allAssets = state.assets_json?.items || [];
  const minBridgeWords = 14;
  const minBridgeSeconds = 6;
  const firstScene = scenes[0];
  const lastScene = scenes[scenes.length - 1];
  const leadingWords = Math.max(0, Number(firstScene.start_word_index || 0));
  const trailingWords = Math.max(0, totalWords - Number(lastScene.end_word_index || totalWords));
  const leadingSeconds = round3((Number(audioDuration || 0) * leadingWords) / totalWords);
  const trailingSeconds = round3((Number(audioDuration || 0) * trailingWords) / totalWords);

  const decoratedScenes = scenes.map((scene) =>
    applyDisplayWindowToScene({
      scene,
      displayStartWordIndex: Number(scene.start_word_index || 0),
      displayEndWordIndex: Number(scene.end_word_index || 0),
      audioDuration,
      totalWords,
    })
  );
  const bridgeScenes = [];

  if (leadingWords > 0) {
    if (leadingWords >= minBridgeWords || leadingSeconds >= minBridgeSeconds) {
      bridgeScenes.push(
        createBridgeScene({
          sceneIndex: 0,
          role: "intro",
          title: `${state.topic || "Destino"} - abertura geral`,
          excerpt: scriptWords.slice(0, leadingWords).join(" "),
          keywords: [state.topic, "travel montage", "destination overview", ...(firstScene.keywords || [])],
          startWordIndex: 0,
          endWordIndex: leadingWords,
          audioDuration,
          totalWords,
          assetCount: allAssets.length,
        })
      );
    } else {
      decoratedScenes[0] = applyDisplayWindowToScene({
        scene: decoratedScenes[0],
        displayStartWordIndex: 0,
        displayEndWordIndex: Number(decoratedScenes[0].end_word_index || decoratedScenes[0].display_end_word_index || 1),
        audioDuration,
        totalWords,
      });
    }
  }

  if (trailingWords > 0) {
    if (trailingWords >= minBridgeWords || trailingSeconds >= minBridgeSeconds) {
      bridgeScenes.push(
        createBridgeScene({
          sceneIndex: Math.max(...decoratedScenes.map((scene) => Number(scene.scene_index || 0))) + 1,
          role: "outro",
          title: `${state.topic || "Destino"} - fechamento visual`,
          excerpt: scriptWords.slice(Number(lastScene.end_word_index || totalWords), totalWords).join(" "),
          keywords: [state.topic, "travel montage", "destination overview", ...(lastScene.keywords || [])],
          startWordIndex: Number(lastScene.end_word_index || totalWords - 1),
          endWordIndex: totalWords,
          audioDuration,
          totalWords,
          assetCount: allAssets.length,
        })
      );
    } else {
      const lastIndex = decoratedScenes.length - 1;
      decoratedScenes[lastIndex] = applyDisplayWindowToScene({
        scene: decoratedScenes[lastIndex],
        displayStartWordIndex: Number(decoratedScenes[lastIndex].start_word_index || 0),
        displayEndWordIndex: totalWords,
        audioDuration,
        totalWords,
      });
    }
  }

  const combinedScenes = [
    ...bridgeScenes.filter((scene) => scene.role === "intro"),
    ...decoratedScenes,
    ...bridgeScenes.filter((scene) => scene.role === "outro"),
  ];

  return combinedScenes.map((scene, index) => ({
    ...scene,
    role: scene.role || inferSceneRole({ scene, index, totalScenes: combinedScenes.length }),
    scene_order: index,
    total_scenes: combinedScenes.length,
    asset_count: scene.synthetic_scene ? allAssets.length : (sceneAssetMap.get(scene.scene_index) || []).length,
  }));
};

const buildSceneWeight = (scene) => {
  let weight = Math.max(
    MIN_CLIP_DURATION,
    Number(scene.script_target_duration_seconds || scene.target_duration_seconds || TARGET_AVERAGE_CLIP_DURATION)
  );

  if (scene.role === "intro") {
    weight *= 1.22;
  } else if (scene.role === "outro") {
    weight *= 1.14;
  } else {
    weight *= 1.02;
  }

  if (scene.asset_count > 1) {
    weight *= 1.08;
  }

  return round3(weight);
};

const selectNarrativeScenes = ({ scenes, targetClipCount }) => {
  if (scenes.length <= targetClipCount) {
    return scenes;
  }

  if (targetClipCount <= 1) {
    return [scenes[0]];
  }

  const selectedIndexes = [];
  for (let slot = 0; slot < targetClipCount; slot += 1) {
    const index = Math.round((slot * (scenes.length - 1)) / (targetClipCount - 1));
    if (!selectedIndexes.includes(index)) {
      selectedIndexes.push(index);
    }
  }

  for (let index = 0; selectedIndexes.length < targetClipCount && index < scenes.length; index += 1) {
    if (!selectedIndexes.includes(index)) {
      selectedIndexes.push(index);
    }
  }

  return selectedIndexes
    .sort((left, right) => left - right)
    .slice(0, targetClipCount)
    .map((index) => scenes[index]);
};

const allocateByWeights = ({ targetTotal, minDurations, maxDurations, priorityWeights }) => {
  const durations = [...minDurations];
  let remaining = round3(targetTotal - sumValues(durations));

  while (remaining > 0.001) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    durations.forEach((currentDuration, index) => {
      const room = round3(Number(maxDurations[index] || 0) - currentDuration);
      if (room <= 0) return;

      const score = Number(priorityWeights[index] || 1) / Math.pow(currentDuration + 0.5, 1.08);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    if (bestIndex === -1) {
      break;
    }

    const addition = round3(Math.min(0.25, remaining, Number(maxDurations[bestIndex] || 0) - durations[bestIndex]));
    if (addition <= 0) {
      break;
    }

    durations[bestIndex] = round3(durations[bestIndex] + addition);
    remaining = round3(remaining - addition);
  }

  const diff = round3(targetTotal - sumValues(durations));
  if (Math.abs(diff) > 0.001) {
    const direction = diff > 0 ? 1 : -1;
    const candidates = durations
      .map((duration, index) => ({
        index,
        duration,
        room:
          direction > 0
            ? round3(Number(maxDurations[index] || 0) - duration)
            : round3(duration - Number(minDurations[index] || 0)),
      }))
      .filter((item) => item.room > 0)
      .sort((left, right) => right.room - left.room);

    if (candidates.length) {
      const targetIndex = candidates[0].index;
      durations[targetIndex] = round3(durations[targetIndex] + diff);
    }
  }

  return durations;
};

const getSceneTransitionCredits = ({ clipCount = 1, isLastScene = false }) =>
  Math.max(0, Number(clipCount || 0) - (isLastScene ? 1 : 0));

const buildSceneDisplayedDuration = (scene = {}) =>
  Math.max(
    1.25,
    Number(
      scene.script_display_target_duration_seconds ||
      scene.script_target_duration_seconds ||
      scene.target_duration_seconds ||
      TARGET_AVERAGE_CLIP_DURATION
    )
  );

const buildSceneDisplayedDurationBounds = ({ clipCount = 1, isLastScene = false }) => {
  const transitionCredits = getSceneTransitionCredits({ clipCount, isLastScene });
  return {
    min: round3(Math.max(0.5, clipCount * MIN_CLIP_DURATION - transitionCredits * TRANSITION_DURATION)),
    max: round3(clipCount * MAX_CLIP_DURATION - transitionCredits * TRANSITION_DURATION),
  };
};

const buildSceneClipCountBounds = ({ scene, isLastScene = false }) => {
  const targetVisibleDuration = buildSceneDisplayedDuration(scene);
  const hardCap = Math.max(
    1,
    Math.ceil((targetVisibleDuration + TRANSITION_DURATION * 2) / Math.max(0.5, MIN_CLIP_DURATION - TRANSITION_DURATION)) + 2
  );

  let minCount = 1;
  while (
    minCount < hardCap &&
    buildSceneDisplayedDurationBounds({ clipCount: minCount, isLastScene }).max + 0.001 < targetVisibleDuration
  ) {
    minCount += 1;
  }

  let maxCount = minCount;
  while (
    maxCount < hardCap &&
    buildSceneDisplayedDurationBounds({ clipCount: maxCount + 1, isLastScene }).min <= targetVisibleDuration + 0.001
  ) {
    maxCount += 1;
  }

  let normalizedMaxCount = Math.max(minCount, maxCount);

  if (scene.synthetic_scene) {
    const syntheticClipCap = scene.role === "intro" ? 2 : scene.role === "outro" ? 3 : 2;
    normalizedMaxCount = Math.min(normalizedMaxCount, syntheticClipCap);
    minCount = Math.min(minCount, normalizedMaxCount);
  }

  return {
    minCount,
    maxCount: normalizedMaxCount,
  };
};

const scaleDurationsToTarget = (durations = [], targetTotal = 0) => {
  const safeTargetTotal = round3(Number(targetTotal || 0));
  const currentTotal = sumValues(durations);

  if (!durations.length) {
    return [];
  }

  if (currentTotal <= 0) {
    const evenDuration = round3(safeTargetTotal / durations.length);
    return durations.map(() => evenDuration);
  }

  const scale = safeTargetTotal / currentTotal;
  return durations.map((duration) => round3(Number(duration || 0) * scale));
};

const fitPreferredDurationsToTarget = ({
  preferredDurations,
  targetTotal,
  minDurations,
  maxDurations,
  priorityWeights,
}) => {
  const scaledPreferred = scaleDurationsToTarget(preferredDurations, targetTotal);
  const durations = scaledPreferred.map((duration, index) =>
    round3(clamp(duration, Number(minDurations[index] || 0), Number(maxDurations[index] || 0)))
  );

  const pickCandidateIndex = (direction) =>
    durations
      .map((duration, index) => {
        const room = direction > 0
          ? round3(Number(maxDurations[index] || 0) - duration)
          : round3(duration - Number(minDurations[index] || 0));

        if (room <= 0) {
          return null;
        }

        const preferredGap = direction > 0
          ? round3(Number(scaledPreferred[index] || 0) - duration)
          : round3(duration - Number(scaledPreferred[index] || 0));
        const priorityWeight = Math.max(0.35, Number(priorityWeights[index] || 1));
        const score = direction > 0
          ? round3((room + 0.1) * (priorityWeight + Math.max(0, preferredGap) * 2))
          : round3((room + 0.1) * (Math.max(0.5, Math.max(0, preferredGap) + 0.5)) / priorityWeight);

        return { index, score };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score)[0]?.index ?? -1;

  let diff = round3(Number(targetTotal || 0) - sumValues(durations));

  while (Math.abs(diff) > 0.001) {
    const direction = diff > 0 ? 1 : -1;
    const targetIndex = pickCandidateIndex(direction);
    if (targetIndex === -1) {
      break;
    }

    const room = direction > 0
      ? round3(Number(maxDurations[targetIndex] || 0) - durations[targetIndex])
      : round3(durations[targetIndex] - Number(minDurations[targetIndex] || 0));
    const delta = round3(Math.min(0.25, Math.abs(diff), room));

    if (delta <= 0) {
      break;
    }

    durations[targetIndex] = round3(durations[targetIndex] + (direction > 0 ? delta : -delta));
    diff = round3(Number(targetTotal || 0) - sumValues(durations));
  }

  return durations;
};

const allocateSceneClipCounts = ({ scenes, targetClipCount }) => {
  const clipCountBounds = scenes.map((scene, index) =>
    buildSceneClipCountBounds({ scene, isLastScene: index === scenes.length - 1 })
  );
  const clipCounts = clipCountBounds.map((bounds) => bounds.minCount);
  const weights = scenes.map((scene) => buildSceneWeight(scene) * (scene.synthetic_scene ? 0.45 : 1));
  const minTotal = clipCountBounds.reduce((acc, bounds) => acc + bounds.minCount, 0);
  const maxTotal = clipCountBounds.reduce((acc, bounds) => acc + bounds.maxCount, 0);
  const normalizedTargetClipCount = clamp(Number(targetClipCount || minTotal), minTotal, maxTotal);
  let remaining = Math.max(0, normalizedTargetClipCount - minTotal);

  while (remaining > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    clipCounts.forEach((count, index) => {
      if (count >= clipCountBounds[index].maxCount) {
        return;
      }

      const score = (weights[index] * Math.max(1, buildSceneDisplayedDuration(scenes[index]) / TARGET_AVERAGE_CLIP_DURATION)) /
        Math.pow(count + (scenes[index].role === "body" ? 0.9 : 0.7), 1.35);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    clipCounts[bestIndex] += 1;
    remaining -= 1;
  }

  return clipCounts;
};

const allocateSceneDurations = ({ scenes, clipCounts, totalDuration }) => {
  const totalClipCount = clipCounts.reduce((acc, count) => acc + count, 0);
  const totalVisibleDuration = round3(totalDuration - Math.max(0, totalClipCount - 1) * TRANSITION_DURATION);
  const preferredVisibleDurations = scenes.map((scene) => buildSceneDisplayedDuration(scene));
  const minVisibleDurations = clipCounts.map((count, index) =>
    buildSceneDisplayedDurationBounds({ clipCount: count, isLastScene: index === scenes.length - 1 }).min
  );
  const maxVisibleDurations = clipCounts.map((count, index) =>
    buildSceneDisplayedDurationBounds({ clipCount: count, isLastScene: index === scenes.length - 1 }).max
  );
  const priorityWeights = scenes.map(
    (scene, index) => round3(buildSceneWeight(scene) * (1 + Math.max(0, clipCounts[index] - 1) * 0.14))
  );
  const visibleDurations = fitPreferredDurationsToTarget({
    preferredDurations: preferredVisibleDurations,
    targetTotal: totalVisibleDuration,
    minDurations: minVisibleDurations,
    maxDurations: maxVisibleDurations,
    priorityWeights,
  });

  return visibleDurations.map((duration, index) =>
    round3(duration + getSceneTransitionCredits({ clipCount: clipCounts[index], isLastScene: index === scenes.length - 1 }) * TRANSITION_DURATION)
  );
};

const buildClipBiases = ({ clipCount, role, sceneIndex, draftVersion }) => {
  const biases = Array.from({ length: clipCount }, () => 1);

  if (role === "intro") {
    biases[0] += 0.45;
  } else if (role === "outro") {
    biases[clipCount - 1] += 0.45;
  } else {
    const emphasisIndex = clipCount === 1 ? 0 : (sceneIndex + draftVersion - 1) % clipCount;
    biases[emphasisIndex] += 0.25;
  }

  if (clipCount > 2) {
    biases[Math.floor(clipCount / 2)] += 0.1;
  }

  return biases;
};

const splitSceneDurationIntoClips = ({ sceneTotalDuration, clipCount, role, sceneIndex, draftVersion }) => {
  if (clipCount <= 1) {
    return [round3(sceneTotalDuration)];
  }

  return allocateByWeights({
    targetTotal: sceneTotalDuration,
    minDurations: Array.from({ length: clipCount }, () => MIN_CLIP_DURATION),
    maxDurations: Array.from({ length: clipCount }, () => MAX_CLIP_DURATION),
    priorityWeights: buildClipBiases({ clipCount, role, sceneIndex, draftVersion }),
  });
};

const extractOriginalScriptWords = (value = "") =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => word.trim())
    .filter(Boolean);

const buildSceneClipNarrationExcerpts = ({ scene, clipDurations = [], scriptWords = [] }) => {
  const fallbackExcerpt = scene.narration_excerpt || scene.title || "travel visual";

  if (!clipDurations.length) {
    return [];
  }

  const startWordIndex = Number(scene.display_start_word_index ?? scene.start_word_index);
  const endWordIndex = Number(scene.display_end_word_index ?? scene.end_word_index);
  const sceneWords = Number.isFinite(startWordIndex) && Number.isFinite(endWordIndex) && endWordIndex > startWordIndex
    ? scriptWords.slice(startWordIndex, endWordIndex)
    : [];

  if (!sceneWords.length) {
    return clipDurations.map(() => fallbackExcerpt);
  }

  let cursor = 0;
  let remainingDuration = sumValues(clipDurations);

  return clipDurations.map((clipDuration, index) => {
    const remainingClips = clipDurations.length - index;
    const remainingWords = sceneWords.length - cursor;

    if (remainingWords <= 0) {
      return fallbackExcerpt;
    }

    if (remainingClips === 1) {
      const excerpt = sceneWords.slice(cursor).join(" ");
      cursor = sceneWords.length;
      return excerpt || fallbackExcerpt;
    }

    const proportionalCount = Math.round((remainingWords * Number(clipDuration || 0)) / Math.max(0.001, remainingDuration));
    const wordsForClip = clamp(proportionalCount || 1, 1, Math.max(1, remainingWords - (remainingClips - 1)));
    const nextCursor = Math.min(sceneWords.length, cursor + wordsForClip);
    const excerpt = sceneWords.slice(cursor, nextCursor).join(" ");

    cursor = nextCursor;
    remainingDuration = round3(remainingDuration - Number(clipDuration || 0));
    return excerpt || fallbackExcerpt;
  }).map((excerpt) => excerpt.trim() || fallbackExcerpt);
};

const buildSceneClipRefs = ({ scenes, clipCounts, draftVersion }) => {
  return scenes.flatMap((scene, index) => {
    const refs = Array.from({ length: clipCounts[index] }, (_, occurrenceIndex) => ({ scene, occurrenceIndex }));

    if (refs.length <= 1) {
      return refs;
    }

    if (draftVersion >= 3 && draftVersion % 3 === 0) {
      return [...refs].reverse();
    }

    if (draftVersion > 1) {
      return rotate(refs, draftVersion - 1);
    }

    return refs;
  });
};

const getSceneAssets = ({ scene, state, sceneAssetMap }) => {
  if (scene.synthetic_scene) {
    return state.assets_json?.items || [];
  }

  return sceneAssetMap.get(scene.scene_index) || [];
};

const buildAssetSemanticTerms = (asset = {}) =>
  buildSemanticTerms([
    asset.query,
    asset.analysis_summary,
    ...(asset.analysis_tags || []),
    asset.semantic_text,
    asset.provider_title,
    ...(asset.provider_tags || []),
  ]);

const normalizeAssetAnalysisWindows = (asset = {}) => {
  const assetDuration = round3(getAssetDuration(asset));
  const fallbackEndSeconds = assetDuration || MAX_CLIP_DURATION;
  const rawWindows = Array.isArray(asset.analysis_windows) && asset.analysis_windows.length
    ? asset.analysis_windows
    : [
        {
          window_index: 1,
          start_seconds: 0,
          end_seconds: fallbackEndSeconds,
          summary: asset.analysis_summary || asset.semantic_text || asset.query || "",
          tags: unique([...(asset.analysis_tags || []), ...(asset.provider_tags || [])]),
        },
      ];

  return rawWindows.map((window, index) => {
    const startSeconds = round3(Math.max(0, Number(window.start_seconds || 0)));
    const endSeconds = round3(Math.max(startSeconds + 0.5, Math.min(fallbackEndSeconds, Number(window.end_seconds || fallbackEndSeconds))));

    return {
      window_index: Number(window.window_index || index + 1),
      start_seconds: startSeconds,
      end_seconds: endSeconds,
      summary: window.summary || window.semantic_text || asset.analysis_summary || asset.semantic_text || asset.query || "",
      tags: unique([...(window.tags || []), ...(asset.analysis_tags || []), ...(asset.provider_tags || [])]).slice(0, 12),
      confidence: Number(window.confidence || 0),
    };
  });
};

const buildWindowSemanticTerms = ({ asset = {}, window = {} }) =>
  buildSemanticTerms([
    window.summary,
    ...(window.tags || []),
    asset.analysis_summary,
    ...(asset.analysis_tags || []),
    asset.query,
    asset.semantic_text,
    asset.provider_title,
    ...(asset.provider_tags || []),
  ]);

const buildSemanticSignature = (terms = []) => unique(terms).sort().slice(0, 8).join("|");

const countSharedTerms = (leftTerms = [], rightTerms = []) =>
  leftTerms.reduce((count, term) => count + (rightTerms.includes(term) ? 1 : 0), 0);

const pickSceneAsset = ({
  sceneAssets = [],
  scene,
  sceneIndex,
  occurrenceIndex,
  draftVersion,
  fallbackAsset,
  clipScriptExcerpt = "",
  usageByAssetKey = new Map(),
  usageByWindowKey = new Map(),
  usageBySemanticKey = new Map(),
  recentLocations = [],
}) => {
  if (!sceneAssets.length) {
    return {
      asset: fallbackAsset,
      semanticMatchScore: 0,
      semanticMatchedTerms: [],
      assetSemanticText: fallbackAsset?.semantic_text || fallbackAsset?.query || "",
      assetReuseIndex: 0,
      selectedWindow: null,
      windowKey: "",
      semanticKey: "",
    };
  }

  const baselineIndex = (draftVersion - 1 + occurrenceIndex) % sceneAssets.length;
  const clipTerms = buildSemanticTerms([
    clipScriptExcerpt,
    scene?.title,
    scene?.narration_excerpt,
    ...(scene?.keywords || []),
  ]);
  const sceneTerms = buildSceneScriptTerms(scene);

  // Extract location from asset query/tags for diversity tracking
  const extractLocation = (asset) => {
    const locationTerms = buildSemanticTerms([
      asset.query,
      ...(asset.provider_tags || []),
      asset.semantic_text,
    ]);
    // Filter for common location indicators
    const locationIndicators = new Set([
      "lisboa", "lisbon", "porto", "oporto", "sintra", "coimbra", "faro",
      "portugal", "spain", "france", "italy", "germany", "uk", "london",
      "paris", "rome", "berlin", "madrid", "barcelona", "amsterdam",
      "city", "beach", "mountain", "river", "coast", "island", "castle",
    ]);
    return locationTerms.filter(t => locationIndicators.has(t) || t.length >= 4)[0] || "unknown";
  };

  const rankedAssets = sceneAssets.flatMap((asset, assetIndex) => {
    const assetKey = asset?.local_path || `${sceneIndex}:${assetIndex}`;
    const assetReuseIndex = usageByAssetKey.get(assetKey) || 0;
    const assetTerms = buildAssetSemanticTerms(asset);
    const queryTerms = buildSemanticTerms([asset.query]);
    const analysisWindows = normalizeAssetAnalysisWindows(asset);

    return analysisWindows.map((window, windowIndex) => {
      const windowKey = `${assetKey}:window:${window.window_index || windowIndex + 1}`;
      const windowReuseIndex = usageByWindowKey.get(windowKey) || 0;
      const windowTerms = buildWindowSemanticTerms({ asset, window });
      const sharedWithClip = countSharedTerms(windowTerms, clipTerms);
      const sharedWithScene = countSharedTerms(windowTerms, sceneTerms);
      const queryOverlap = countSharedTerms(queryTerms, clipTerms);
      const semanticKey = buildSemanticSignature(windowTerms);
      const semanticReuseIndex = semanticKey ? usageBySemanticKey.get(semanticKey) || 0 : 0;

      // Location diversity penalty
      const assetLocation = extractLocation(asset);
      const recentLocationCount = recentLocations.filter(loc => loc === assetLocation).length;
      const locationPenalty = recentLocationCount > 1 ? recentLocationCount * 1.8 : 0;

      const score = round3(
        sharedWithClip * 5 +
        queryOverlap * 1.8 +
        sharedWithScene * 1.45 +
        Math.min(1.25, window.confidence || 0) +
        (asset.analysis_windows?.length ? 1.1 : 0) +
        (assetIndex === baselineIndex ? 0.35 : 0) +
        (isVideoAsset(asset) ? 0.2 : 0) -
        assetReuseIndex * 2.0 -
        windowReuseIndex * 2 -
        semanticReuseIndex * 1.35 -
        locationPenalty -
        (asset.is_fallback ? 3 : 0)
      );

      return {
        asset,
        assetIndex,
        assetKey,
        assetReuseIndex,
        selectedWindow: window,
        windowKey,
        semanticKey,
        windowReuseIndex,
        semanticReuseIndex,
        assetSemanticText: window.summary || asset.analysis_summary || asset.semantic_text || asset.query || "",
        matchedTerms: unique(windowTerms.filter((term) => clipTerms.includes(term))).slice(0, 8),
        score,
      };
    });
  }).sort((left, right) =>
    right.score - left.score ||
    left.windowReuseIndex - right.windowReuseIndex ||
    left.semanticReuseIndex - right.semanticReuseIndex ||
    left.assetReuseIndex - right.assetReuseIndex ||
    Math.abs(left.assetIndex - baselineIndex) - Math.abs(right.assetIndex - baselineIndex)
  );

  const bestMatch = rankedAssets[0];

  return {
    asset: bestMatch?.asset || fallbackAsset,
    semanticMatchScore: bestMatch?.score || 0,
    semanticMatchedTerms: bestMatch?.matchedTerms || [],
    assetSemanticText: bestMatch?.assetSemanticText || bestMatch?.asset?.query || "",
    assetReuseIndex: bestMatch?.assetReuseIndex || 0,
    selectedWindow: bestMatch?.selectedWindow || null,
    windowKey: bestMatch?.windowKey || "",
    semanticKey: bestMatch?.semanticKey || "",
  };
};

const buildVideoSourceWindow = ({
  asset,
  clipDuration,
  assetReuseIndex = 0,
  clipIndex = 1,
  sceneRole = "body",
  draftVersion = 1,
  preferredWindow = null,
}) => {
  const assetDuration = getAssetDuration(asset);
  const safeClipDuration = round3(Number(clipDuration || MIN_CLIP_DURATION));

  if (!assetDuration || assetDuration <= safeClipDuration + 0.75) {
    return {
      source_start_seconds: 0,
      source_end_seconds: round3(safeClipDuration),
      asset_duration_seconds: round3(assetDuration),
    };
  }

  if (preferredWindow) {
    const preferredStart = round3(clamp(Number(preferredWindow.start_seconds || 0), 0, Math.max(0, assetDuration - safeClipDuration)));
    const preferredEnd = round3(clamp(Number(preferredWindow.end_seconds || assetDuration), preferredStart + 0.5, assetDuration));
    const preferredDuration = Math.max(0.5, preferredEnd - preferredStart);

    if (preferredDuration <= safeClipDuration + 0.25) {
      return {
        source_start_seconds: preferredStart,
        source_end_seconds: round3(Math.min(assetDuration, preferredStart + safeClipDuration)),
        asset_duration_seconds: round3(assetDuration),
      };
    }

    const localTravel = Math.max(0, preferredDuration - safeClipDuration);
    const localVariation = ((assetReuseIndex * 0.23) + ((clipIndex - 1) * 0.09) + (draftVersion * 0.13)) % 1;
    const localStart = round3(preferredStart + localTravel * localVariation);

    return {
      source_start_seconds: localStart,
      source_end_seconds: round3(Math.min(assetDuration, localStart + safeClipDuration)),
      asset_duration_seconds: round3(assetDuration),
    };
  }

  const edgePadding = Math.min(0.9, Math.max(0.25, assetDuration * 0.04));
  const availableTravel = Math.max(0, assetDuration - safeClipDuration - edgePadding * 2);
  const anchor = sceneRole === "intro" ? 0.12 : sceneRole === "outro" ? 0.78 : 0.46;
  const variation = ((assetReuseIndex * 0.31) + ((clipIndex - 1) * 0.11) + (draftVersion * 0.17)) % 1;
  const ratio = Math.min(1, Math.max(0, anchor * 0.55 + variation * 0.45));
  const start = round3(edgePadding + availableTravel * ratio);

  return {
    source_start_seconds: start,
    source_end_seconds: round3(start + safeClipDuration),
    asset_duration_seconds: round3(assetDuration),
  };
};

const buildClipPlan = async ({ state, audioDuration, draftVersion, fallbackAsset }) => {
  const scenes = normalizeScenes(state);
  const sceneAssetMap = buildSceneAssetMap(state.assets_json?.items || []);
  const scriptWords = extractOriginalScriptWords(state.script_text);

  // Load audio intelligence for precise word-level sync
  let audioIntelligence = null;
  if (state.audio_intelligence_path) {
    try {
      const { getCachedAudioIntelligence } = require("./audioIntelligence");
      audioIntelligence = await getCachedAudioIntelligence({ videoId: state.video_id });
    } catch (error) {
      // Fallback to word-index based timing if audio intelligence fails to load
    }
  }

  const sceneTimingHints = buildSceneScriptTimingHints({
    scenes,
    scriptText: state.script_text,
    audioDuration,
    audioIntelligence,
  });
  const describedScenes = mergeSceneTimingHints({
    scenes: describeScenes({ scenes, sceneAssetMap }),
    sceneTimingHints,
  });
  const narrativeScenes = injectBridgeScenes({
    scenes: describedScenes,
    state,
    audioDuration,
    sceneAssetMap,
  });
  const targetClipCount = chooseClipCount({ audioDuration, sceneCount: narrativeScenes.length });
  const selectedScenes = selectNarrativeScenes({ scenes: narrativeScenes, targetClipCount });
  const clipCounts = allocateSceneClipCounts({ scenes: selectedScenes, targetClipCount });
  const totalClipCount = clipCounts.reduce((acc, count) => acc + count, 0);
  const timelineTargetDuration = audioDuration + Math.max(0, totalClipCount - 1) * TRANSITION_DURATION;
  const sceneDurations = allocateSceneDurations({
    scenes: selectedScenes,
    clipCounts,
    totalDuration: timelineTargetDuration,
  });
  const clipDurationsByScene = new Map(
    selectedScenes.map((scene, index) => [
      scene.scene_index,
      splitSceneDurationIntoClips({
        sceneTotalDuration: sceneDurations[index],
        clipCount: clipCounts[index],
        role: scene.role,
        sceneIndex: scene.scene_index,
        draftVersion,
      }),
    ])
  );
  const clipNarrationExcerptsByScene = new Map(
    selectedScenes.map((scene) => [
      scene.scene_index,
      buildSceneClipNarrationExcerpts({
        scene,
        clipDurations: clipDurationsByScene.get(scene.scene_index) || [],
        scriptWords,
      }),
    ])
  );
  const sceneRefs = buildSceneClipRefs({ scenes: selectedScenes, clipCounts, draftVersion });
  const usageByAssetKey = new Map();
  const usageByWindowKey = new Map();
  const usageBySemanticKey = new Map();
  const recentLocations = [];
  const MAX_RECENT_LOCATIONS = 3;

  return sceneRefs.map((ref, index) => {
    const scene = ref.scene;
    const occurrenceIndex = ref.occurrenceIndex;
    const clipScriptExcerpt = clipNarrationExcerptsByScene.get(scene.scene_index)?.[occurrenceIndex] || scene.narration_excerpt || scene.title;
    const pickedAsset = pickSceneAsset({
      sceneAssets: getSceneAssets({ scene, state, sceneAssetMap }),
      scene,
      sceneIndex: scene.scene_index,
      occurrenceIndex,
      draftVersion,
      fallbackAsset,
      clipScriptExcerpt,
      usageByAssetKey,
      usageByWindowKey,
      usageBySemanticKey,
      recentLocations,
    });
    const asset = pickedAsset.asset;
    const assetKey = asset?.local_path || `${scene.scene_index}:${occurrenceIndex}`;
    const assetReuseIndex = pickedAsset.assetReuseIndex;
    usageByAssetKey.set(assetKey, assetReuseIndex + 1);
    if (pickedAsset.windowKey) {
      usageByWindowKey.set(pickedAsset.windowKey, (usageByWindowKey.get(pickedAsset.windowKey) || 0) + 1);
    }
    if (pickedAsset.semanticKey) {
      usageBySemanticKey.set(pickedAsset.semanticKey, (usageBySemanticKey.get(pickedAsset.semanticKey) || 0) + 1);
    }

    // Update recent locations for diversity tracking
    const assetLocation = buildSemanticTerms([
      asset.query,
      ...(asset.provider_tags || []),
      asset.semantic_text,
    ]).filter(t => t.length >= 4)[0] || "unknown";
    recentLocations.push(assetLocation);
    if (recentLocations.length > MAX_RECENT_LOCATIONS) {
      recentLocations.shift();
    }

    const clipDurationSeconds = clipDurationsByScene.get(scene.scene_index)?.[occurrenceIndex] || MIN_CLIP_DURATION;
    const sourceWindow = isVideoAsset(asset)
      ? buildVideoSourceWindow({
          asset,
          clipDuration: clipDurationSeconds,
          assetReuseIndex,
          clipIndex: index + 1,
          sceneRole: scene.role,
          draftVersion,
          preferredWindow: pickedAsset.selectedWindow,
        })
      : {
          source_start_seconds: 0,
          source_end_seconds: round3(clipDurationSeconds),
          asset_duration_seconds: round3(getAssetDuration(asset)),
        };

    return {
      clip_index: index + 1,
      scene_index: scene.scene_index,
      scene_role: scene.role,
      scene_order: scene.scene_order + 1,
      title: scene.title,
      narration_excerpt: scene.narration_excerpt,
      clip_script_excerpt: clipScriptExcerpt,
      clip_duration_seconds: clipDurationSeconds,
      source_start_seconds: sourceWindow.source_start_seconds,
      source_end_seconds: sourceWindow.source_end_seconds,
      asset_duration_seconds: sourceWindow.asset_duration_seconds,
      semantic_match_score: pickedAsset.semanticMatchScore,
      semantic_match_terms: pickedAsset.semanticMatchedTerms,
      asset_semantic_text: pickedAsset.assetSemanticText,
      asset_window_summary: pickedAsset.selectedWindow?.summary || "",
      asset_window_start_seconds: Number(pickedAsset.selectedWindow?.start_seconds || 0),
      asset_window_end_seconds: Number(pickedAsset.selectedWindow?.end_seconds || 0),
      asset,
    };
  });
};

const buildVideoFilter = ({ width, height }) =>
  [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
    `fps=${OUTPUT_FPS}`,
    "format=yuv420p",
  ].join(",");

const buildZoompanFilter = ({ width, height, duration }) => {
  const paddedWidth = Math.round(width * 1.15);
  const paddedHeight = Math.round(height * 1.15);
  const frames = Math.max(1, Math.round(Number(duration || 0) * 30));

  return [
    `scale=${paddedWidth}:${paddedHeight}:force_original_aspect_ratio=increase`,
    `crop=${paddedWidth}:${paddedHeight}`,
    `zoompan=z='min(zoom+0.00035,1.04)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${OUTPUT_FPS}`,
    "setsar=1",
    "format=yuv420p",
  ].join(",");
};

const renderClipSegment = async ({ asset, outputPath, duration, width, height, seed, sourceStartSeconds = 0, assetDurationSeconds = 0 }) => {
  const sourcePath = asset?.local_path && (await fs.pathExists(asset.local_path)) ? asset.local_path : outputPath.replace(/\.mp4$/i, ".png");

  if (!(asset?.local_path && (await fs.pathExists(asset.local_path)))) {
    await createFallbackImage(sourcePath, seed);
  }

  if (isVideoFile(sourcePath)) {
    const knownDuration = Number(assetDurationSeconds || getAssetDuration(asset));
    const requiresLoop = knownDuration > 0 && knownDuration + 0.15 < Number(duration || 0);
    const safeStart = requiresLoop ? 0 : round3(Math.max(0, Number(sourceStartSeconds || 0)));
    const args = ["-y"];

    if (safeStart > 0) {
      args.push("-ss", safeStart.toString());
    }

    if (requiresLoop) {
      args.push("-stream_loop", "-1");
    }

    args.push(
      "-i",
      sourcePath,
      "-t",
      round3(duration).toString(),
      "-vf",
      buildVideoFilter({ width, height }),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(OUTPUT_FPS),
      "-b:v",
      VIDEO_BITRATE,
      "-maxrate",
      MAX_VIDEO_BITRATE,
      "-bufsize",
      "8M",
      outputPath
    );

    await runFfmpeg(args);
    return;
  }

  await runFfmpeg([
    "-y",
    "-loop",
    "1",
    "-i",
    sourcePath,
    "-t",
    round3(duration).toString(),
    "-vf",
    buildZoompanFilter({ width, height, duration }),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(OUTPUT_FPS),
    "-b:v",
    VIDEO_BITRATE,
    "-maxrate",
    MAX_VIDEO_BITRATE,
    "-bufsize",
    "8M",
    outputPath,
  ]);
};

const muxSingleSegment = async ({ segmentPath, audioPath, renderPath }) => {
  await runFfmpeg([
    "-y",
    "-i",
    segmentPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    VIDEO_BITRATE,
    "-maxrate",
    MAX_VIDEO_BITRATE,
    "-bufsize",
    "8M",
    "-c:a",
    "aac",
    "-b:a",
    AUDIO_BITRATE,
    "-shortest",
    "-movflags",
    "+faststart",
    renderPath,
  ]);
};

const renderWithXfade = async ({ segmentPaths, durations, audioPath, renderPath }) => {
  if (segmentPaths.length === 1) {
    await muxSingleSegment({ segmentPath: segmentPaths[0], audioPath, renderPath });
    return;
  }

  const filterParts = [];
  let cumulativeDuration = durations[0];

  for (let index = 1; index < segmentPaths.length; index += 1) {
    const previousLabel = index === 1 ? "0:v" : `v${index - 1}`;
    const outputLabel = `v${index}`;
    const offset = round3(cumulativeDuration - TRANSITION_DURATION * index);
    filterParts.push(
      `[${previousLabel}][${index}:v]xfade=transition=fade:duration=${TRANSITION_DURATION}:offset=${offset}[${outputLabel}]`
    );
    cumulativeDuration += durations[index];
  }

  const args = ["-y"];
  segmentPaths.forEach((segmentPath) => {
    args.push("-i", segmentPath);
  });
  args.push(
    "-i",
    audioPath,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    `[v${segmentPaths.length - 1}]`,
    "-map",
    `${segmentPaths.length}:a:0`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    VIDEO_BITRATE,
    "-maxrate",
    MAX_VIDEO_BITRATE,
    "-bufsize",
    "8M",
    "-c:a",
    "aac",
    "-b:a",
    AUDIO_BITRATE,
    "-shortest",
    "-movflags",
    "+faststart",
    renderPath
  );

  await runFfmpeg(args);
};

const renderWithConcat = async ({ segmentPaths, audioPath, renderPath, listPath }) => {
  const concatContent = segmentPaths
    .map((segmentPath) => `file '${segmentPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");

  await fs.writeFile(listPath, concatContent, "utf8");
  await runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    VIDEO_BITRATE,
    "-maxrate",
    MAX_VIDEO_BITRATE,
    "-bufsize",
    "8M",
    "-c:a",
    "aac",
    "-b:a",
    AUDIO_BITRATE,
    "-shortest",
    "-movflags",
    "+faststart",
    renderPath,
  ]);
};

const renderUltimateFallback = async ({ renderPath, audioPath, fallbackImagePath, audioDuration }) => {
  await runFfmpeg([
    "-y",
    "-loop",
    "1",
    "-i",
    fallbackImagePath,
    "-i",
    audioPath,
    "-t",
    round3(audioDuration).toString(),
    "-vf",
    buildZoompanFilter({ width: MIN_OUTPUT.width, height: MIN_OUTPUT.height, duration: audioDuration }),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    VIDEO_BITRATE,
    "-maxrate",
    MAX_VIDEO_BITRATE,
    "-bufsize",
    "8M",
    "-c:a",
    "aac",
    "-b:a",
    AUDIO_BITRATE,
    "-shortest",
    renderPath,
  ]);
};

const ensureAudioIntelligenceReady = async ({ videoId, state }) => {
  const hasPath = state.audio_intelligence_path;
  const exists = hasPath && await fs.pathExists(hasPath);
  if (!exists) {
    await analyzeAudio({ videoId });
    return loadState(videoId);
  }
  return state;
};

const renderVideo = async ({ videoId, mockMode = false, backgroundMusicPath = "" }) => {
  let state = await loadState(videoId);
  const paths = await ensureVideoStructure(videoId);
  const draftVersion = getDraftVersion(state);
  const allowPlaceholderAssets = shouldAllowPlaceholderAssets({ mockMode });

  if (!state.audio_path || !(await fs.pathExists(state.audio_path))) {
    throw new Error("Áudio não encontrado para renderização.");
  }

  const renderPath = paths.renderPath;
  const fallbackImagePath = path.join(paths.base, "assets", "raw", "render-fallback.png");
  if (allowPlaceholderAssets) {
    await createFallbackImage(fallbackImagePath, draftVersion);
  }

  const audioInfo = await probeMedia(state.audio_path).catch(() => ({ duration: 0 }));
  const audioDuration = Math.max(10, Number(audioInfo.duration || state.duration_seconds || 95));
  const fallbackAsset = allowPlaceholderAssets
    ? {
        scene_index: 0,
        provider: "render_fallback",
        asset_type: "image",
        local_path: fallbackImagePath,
        resolution: {
          width: PREFERRED_OUTPUT.width,
          height: PREFERRED_OUTPUT.height,
          label: "Full HD",
        },
        duration_estimate: 6,
      }
    : null;

  state = await ensureAudioIntelligenceReady({ videoId, state });

  // Use the new timeline planner (audio intelligence + semantic matching)
  logger.info("renderService: construindo timeline", {
    videoId,
    draft_version: draftVersion,
    audio_duration_seconds: audioDuration,
  });

  const timelineResult = await buildTimeline({
    state,
    audioDuration,
    draftVersion,
    fallbackAsset,
    allowPlaceholderFallback: allowPlaceholderAssets,
  });

  const clipPlan = timelineResult.clipPlan || timelineResult.clips || [];

  if (!allowPlaceholderAssets && clipPlan.some((clip) => isPlaceholderAsset(clip.asset))) {
    throw new Error("Render blocked: placeholder asset detected in clip plan.");
  }

  logger.info("renderService: timeline pronta, preparando render", {
    videoId,
    total_clips: clipPlan.length,
    draft_version: draftVersion,
    audio_duration_seconds: audioDuration,
  });

  const outputResolution = chooseOutputResolution(clipPlan);
  const segmentsDir = path.join(paths.base, "render", "segments");
  await fs.emptyDir(segmentsDir);

  const segmentPaths = [];
  for (const clip of clipPlan) {
    logger.info("renderService: renderizando segmento", {
      videoId,
      clip_index: clip.clip_index,
      total_clips: clipPlan.length,
      scene_index: clip.scene_index,
      title: clip.title,
    });

    const segmentPath = path.join(segmentsDir, `clip-${String(clip.clip_index).padStart(3, "0")}.mp4`);
    try {
      await renderClipSegment({
        asset: clip.asset,
        outputPath: segmentPath,
        duration: clip.clip_duration_seconds,
        width: outputResolution.width,
        height: outputResolution.height,
        seed: clip.scene_index + draftVersion,
        sourceStartSeconds: clip.source_start_seconds,
        assetDurationSeconds: clip.asset_duration_seconds,
      });
    } catch {
      if (!allowPlaceholderAssets) {
        throw new Error(`Render blocked: segment fallback disabled for scene ${clip.scene_index}.`);
      }

      await createFallbackImage(segmentPath.replace(/\.mp4$/i, ".png"), clip.scene_index + draftVersion);
      await renderClipSegment({
        asset: {
          asset_type: "image",
          local_path: segmentPath.replace(/\.mp4$/i, ".png"),
        },
        outputPath: segmentPath,
        duration: clip.clip_duration_seconds,
        width: outputResolution.width,
        height: outputResolution.height,
        seed: clip.scene_index + draftVersion,
        sourceStartSeconds: 0,
        assetDurationSeconds: clip.asset_duration_seconds,
      });
    }
    segmentPaths.push(segmentPath);
  }

  const requiresExactSync = Boolean(timelineResult.requiresExactSync || timelineResult.renderStrategy === "concat");
  let renderStrategy = requiresExactSync ? "concat" : "xfade";
  let transition = requiresExactSync ? "none" : "fade";
  logger.info("renderService: segmentos prontos, iniciando composicao final", {
    videoId,
    total_clips: clipPlan.length,
    strategy: renderStrategy,
  });
  try {
    if (requiresExactSync) {
      const concatListPath = path.join(paths.base, "render", "segments", "segments.txt");
      await renderWithConcat({
        segmentPaths,
        audioPath: state.audio_path,
        renderPath,
        listPath: concatListPath,
      });
    } else {
      await renderWithXfade({
        segmentPaths,
        durations: clipPlan.map((clip) => clip.clip_duration_seconds),
        audioPath: state.audio_path,
        renderPath,
      });
    }
  } catch {
    renderStrategy = requiresExactSync ? "xfade_fallback" : "concat";
    transition = requiresExactSync ? "fade_fallback" : "none";
    try {
      if (requiresExactSync) {
        await renderWithXfade({
          segmentPaths,
          durations: clipPlan.map((clip) => clip.clip_duration_seconds),
          audioPath: state.audio_path,
          renderPath,
        });
      } else {
        const concatListPath = path.join(paths.base, "render", "segments", "segments.txt");
        await renderWithConcat({
          segmentPaths,
          audioPath: state.audio_path,
          renderPath,
          listPath: concatListPath,
        });
      }
    } catch {
      renderStrategy = "single_fallback";
      transition = "none";
      if (!allowPlaceholderAssets) {
        throw new Error("Render blocked: final composition fallback disabled in production.");
      }
      await renderUltimateFallback({
        renderPath,
        audioPath: state.audio_path,
        fallbackImagePath,
        audioDuration,
      });
    }
  }

  const musicPath = backgroundMusicPath || config.BACKGROUND_MUSIC_PATH || "";
  if (musicPath && !mockMode && (await fs.pathExists(musicPath))) {
    // Mixa trilha em loop sob a narração (ducking fixo) + loudnorm para
    // o alvo do YouTube (-14 LUFS).
    const mixedPath = path.join(paths.base, "render", "final-with-music.mp4");
    const musicVolume = Math.max(0.02, Math.min(0.5, Number(config.BACKGROUND_MUSIC_VOLUME || 0.12)));
    try {
      await runFfmpeg([
        "-y",
        "-i", renderPath,
        "-stream_loop", "-1",
        "-i", musicPath,
        "-filter_complex",
        `[1:a]volume=${musicVolume}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`,
        "-map", "0:v:0",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        mixedPath,
      ]);
      await fs.move(mixedPath, renderPath, { overwrite: true });
    } catch (error) {
      logger.warn("renderService: falha ao mixar música de fundo — seguindo sem", { message: error.message });
    }
  }

  const overlays = buildBlockOverlays({
    narrativeBlocks: timelineResult.narrativeBlocks || [],
    clips: clipPlan,
    enabled: config.ENABLE_BLOCK_OVERLAYS,
    requireChapterOverlay: Boolean(config.HARD_BOUNDARY_REQUIRE_CHAPTER_OVERLAY),
  });
  const subtitlePath = config.BURN_CAPTIONS && state.caption_path_srt && (await fs.pathExists(state.caption_path_srt))
    ? state.caption_path_srt
    : "";
  let finalRenderPath = renderPath;
  if (overlays.length || subtitlePath) {
    const overlayPath = path.join(paths.base, "render", "final-with-overlays.mp4");
    try {
      await applyOverlaysToVideo({
        inputPath: renderPath,
        outputPath: overlayPath,
        overlays,
        subtitlePath,
        fps: OUTPUT_FPS,
        videoBitrate: VIDEO_BITRATE,
        maxVideoBitrate: MAX_VIDEO_BITRATE,
      });
      finalRenderPath = overlayPath;
    } catch {
      finalRenderPath = renderPath;
    }
  }

  logger.info("renderService: render concluido", {
    videoId,
    render_path: finalRenderPath,
    strategy: renderStrategy,
    transition,
  });

  const outputInfo = await probeMedia(finalRenderPath).catch(() => ({ width: 0, height: 0, duration: audioDuration }));
  const uniqueAssetCount = new Set(clipPlan.map((clip) => clip.asset?.local_path).filter(Boolean)).size;
  const semanticScores = clipPlan.map((clip) => Number((clip.timeline_score ?? clip.composite_score ?? clip.semantic_match_score) || 0));

  const nextState = await updateState(
    videoId,
    {
      render_path: finalRenderPath,
      overlays,
      render_timeline: {
        strategy: renderStrategy,
        transition,
        output_resolution: `${outputInfo.width || outputResolution.width}x${outputInfo.height || outputResolution.height}`,
        output_duration_seconds: round3(outputInfo.duration || audioDuration),
        total_clips: clipPlan.length,
        unique_asset_count: uniqueAssetCount,
        semantic_alignment_score_average: round3(average(semanticScores)),
        low_confidence_clip_count: semanticScores.filter((score) => score < 0).length,
        sync_policy: timelineResult.syncPolicy || {},
        hard_boundary_policy: timelineResult.hardBoundaryPolicy || {},
        narrative_blocks: timelineResult.narrativeBlocks || [],
        timeline_sync_metrics: timelineResult.timelineSyncMetrics || {},
        hard_boundary_status: timelineResult.timelineSyncMetrics?.hard_boundary_status || "unknown",
        max_visual_lag_sec: Number(timelineResult.timelineSyncMetrics?.max_visual_lag_sec || 0),
        asset_windows_count: Array.isArray(timelineResult.assetWindows) ? timelineResult.assetWindows.length : 0,
        clips: clipPlan.map((clip) => ({
          clip_index: clip.clip_index,
          scene_index: clip.scene_index,
          scene_role: clip.scene_role,
          scene_order: clip.scene_order,
          title: clip.title,
          clip_duration_seconds: clip.clip_duration_seconds,
          timeline_start_sec: clip.timeline_start_sec,
          timeline_end_sec: clip.timeline_end_sec,
          clip_start_narrated_at: clip.clip_start_narrated_at,
          clip_end_narrated_at: clip.clip_end_narrated_at,
          clip_script_excerpt: clip.clip_script_excerpt,
          clip_script_source: clip.clip_script_source,
          cut_reason: clip.cut_reason,
          source_start_seconds: clip.source_start_seconds,
          source_end_seconds: clip.source_end_seconds,
          asset_duration_seconds: clip.asset_duration_seconds,
          semantic_match_score: clip.semantic_match_score,
          block_match_score: clip.block_match_score,
          entity_match_score: clip.entity_match_score,
          visual_specificity_score: clip.visual_specificity_score,
          reuse_penalty: clip.reuse_penalty,
          timeline_score: clip.timeline_score,
          composite_score: clip.composite_score,
          semantic_match_terms: clip.semantic_match_terms,
          semantic_match_method: clip.semantic_match_method,
          selection_reason: clip.selection_reason,
          rejected_candidates_count: clip.rejected_candidates_count,
          candidate_debug: clip.candidate_debug,
          score_features: clip.score_features,
          visual_intent: clip.visual_intent,
          required_visual_evidence: clip.required_visual_evidence,
          allowed_visual_categories: clip.allowed_visual_categories,
          forbidden_visual_categories: clip.forbidden_visual_categories,
          asset_semantic_text: clip.asset_semantic_text,
          asset_window_id: clip.asset_window_id,
          asset_window_key: clip.asset_window_key,
          asset_window_summary: clip.asset_window_summary,
          asset_window_start_seconds: clip.asset_window_start_seconds,
          asset_window_end_seconds: clip.asset_window_end_seconds,
          asset_analysis_provider: clip.asset_analysis_provider,
          detected_visual_categories: clip.detected_visual_categories,
          detected_objects: clip.detected_objects,
          visual_intent_match: clip.visual_intent_match,
          query_used: clip.query_used,
          macro_block_id: clip.macro_block_id,
          micro_block_id: clip.micro_block_id,
          block_id: clip.block_id,
          macro_topic: clip.macro_topic,
          micro_topic: clip.micro_topic,
          subtheme: clip.subtheme,
          topic_type: clip.topic_type,
          hard_boundary: clip.hard_boundary,
          detected_location: clip.detected_location,
          detected_landmarks: clip.detected_landmarks,
          neutral_fallback: clip.neutral_fallback,
          visual_signature: clip.visual_signature,
          transition: clip.transition,
          rejection_warnings: clip.score_features?.rejectionWarnings || [],
          local_path: clip.asset?.local_path || fallbackImagePath,
          provider: clip.asset?.provider || "render_fallback",
          asset_type: clip.asset?.asset_type || clip.asset?.type || (isVideoFile(clip.asset?.local_path || "") ? "video" : "image"),
          resolution: clip.asset?.resolution || {
            width: outputResolution.width,
            height: outputResolution.height,
            label: outputResolution.width >= 1920 ? "Full HD" : "HD",
          },
        })),
      },
      error_message: "",
    },
    { currentStep: "render_generated", status: "render_generated" }
  );

  await sendWorkflowStatus({
    videoId,
    title: `Render v${draftVersion} gerado`,
    icon: "🎞️",
    lines: ["Preparando metadata e publicação do link de revisão online."],
  }).catch(() => null);

  return {
    video_id: videoId,
      render_path: nextState.render_path,
    state_path: nextState.state_path,
  };
};

module.exports = {
  renderVideo,
  __test__: {
    buildClipPlan,
    buildSceneScriptTimingHints,
    buildVideoSourceWindow,
  },
};
