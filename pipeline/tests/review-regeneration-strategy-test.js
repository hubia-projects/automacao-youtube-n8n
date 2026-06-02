const assert = require("assert");
const { __test__ } = require("../src/services/reviewRevisionService");

const buildScene = (sceneIndex, title) => ({
  scene_index: sceneIndex,
  title,
});

const buildClip = ({
  sceneIndex,
  score,
  localPath,
  sceneRole = "body",
  assetWindowStart = 0,
  assetWindowEnd = 6,
  assetWindowSummary = "",
}) => ({
  scene_index: sceneIndex,
  scene_role: sceneRole,
  semantic_match_score: score,
  local_path: localPath,
  asset_window_start_seconds: assetWindowStart,
  asset_window_end_seconds: assetWindowEnd,
  asset_window_summary: assetWindowSummary,
});

const stateWithWeakScenes = {
  visual_plan: [
    buildScene(1, "Lisboa"),
    buildScene(2, "Porto"),
    buildScene(3, "Sintra"),
    buildScene(4, "Litoral"),
  ],
  render_timeline: {
    clips: [
      buildClip({ sceneIndex: 1, score: 7.2, localPath: "scene-1-a.mp4", assetWindowSummary: "lisbon skyline" }),
      buildClip({ sceneIndex: 1, score: 6.8, localPath: "scene-1-b.mp4", assetWindowStart: 8, assetWindowEnd: 14, assetWindowSummary: "lisbon tram" }),
      buildClip({ sceneIndex: 2, score: 1.3, localPath: "scene-2-a.mp4", assetWindowSummary: "generic corridor" }),
      buildClip({ sceneIndex: 2, score: 1.8, localPath: "scene-2-a.mp4", assetWindowSummary: "generic corridor" }),
      buildClip({ sceneIndex: 3, score: 3.6, localPath: "scene-3-a.mp4", assetWindowSummary: "castle exterior" }),
      buildClip({ sceneIndex: 3, score: 3.4, localPath: "scene-3-a.mp4", assetWindowStart: 0, assetWindowEnd: 6, assetWindowSummary: "castle exterior" }),
      buildClip({ sceneIndex: 4, score: 5.9, localPath: "scene-4-a.mp4", assetWindowSummary: "coastline" }),
    ],
  },
};

const stateWithNoWeakFlags = {
  visual_plan: [
    buildScene(1, "Lisboa"),
    buildScene(2, "Porto"),
    buildScene(3, "Sintra"),
  ],
  render_timeline: {
    clips: [
      buildClip({ sceneIndex: 1, score: 6.4, localPath: "scene-1-a.mp4", assetWindowSummary: "lisbon" }),
      buildClip({ sceneIndex: 2, score: 4.2, localPath: "scene-2-a.mp4", assetWindowSummary: "porto" }),
      buildClip({ sceneIndex: 3, score: 4.5, localPath: "scene-3-a.mp4", assetWindowSummary: "sintra" }),
    ],
  },
};

const refreshedWeakScenes = __test__.chooseScenesForAssetRefresh({ state: stateWithWeakScenes });
assert.deepStrictEqual(refreshedWeakScenes, [2, 3], "a estrategia deveria priorizar a cena fraca e a cena com reuso pesado");

const refreshedFallbackScenes = __test__.chooseScenesForAssetRefresh({ state: stateWithNoWeakFlags });
assert.deepStrictEqual(refreshedFallbackScenes, [2, 3], "sem flags explicitas, a estrategia deveria pegar as duas cenas mais fracas");

console.log("estrategia de refresh de revisao validada com sucesso");