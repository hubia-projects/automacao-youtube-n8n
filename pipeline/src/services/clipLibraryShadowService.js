const path = require("path");
const fs = require("fs-extra");
const { config } = require("../config/env");
const { probeMedia } = require("../utils/mediaUtils");
const { indexAsset } = require("./sceneIndexService");
const {
  bulkUpdateStatusByAssetAndWindow,
  searchApprovedClips,
  summarizeClipLibrary,
} = require("./clipLibraryService");

const round3 = (value) => Number(Number(value || 0).toFixed(3));

const buildWindowsFromDuration = ({ durationSec = 0, windowSec = 3 }) => {
  const windows = [];
  const safeDuration = Math.max(1, Number(durationSec || 0));
  const step = Math.max(1, Number(windowSec || 3));
  let cursor = 0;
  while (cursor < safeDuration) {
    const end = Math.min(safeDuration, cursor + step);
    windows.push({
      start_seconds: round3(cursor),
      end_seconds: round3(Math.max(cursor + 0.3, end)),
      summary: "shadow decupagem window",
      tags: ["shadow", "decupagem", "window"],
      detected_visual_categories: ["city_landmark"],
      confidence: 0.82,
      visual_intent: "city_landmark",
    });
    if (end >= safeDuration) break;
    cursor += step;
  }
  return windows;
};

const runClipLibraryShadow = async ({
  videoPath = "",
  videoId = "",
  sceneIndex = 1,
  blockId = "shadow_block_001",
  windowSec = 3,
}) => {
  if (!videoPath || !(await fs.pathExists(videoPath))) {
    throw new Error("clipLibraryShadowService: videoPath inválido para shadow run.");
  }

  const media = await probeMedia(videoPath).catch(() => ({ duration: 0 }));
  const windows = buildWindowsFromDuration({
    durationSec: Number(media.duration || 0),
    windowSec,
  });
  const asset = {
    asset_id: `${videoId}_shadow_asset`,
    local_path: videoPath,
    source_url: `shadow://${videoId}`,
    asset_type: "video",
    provider: "shadow_local",
    analysis_provider: "shadow_local",
  };
  const scene = {
    scene_index: Number(sceneIndex || 1),
    block_id: String(blockId || "shadow_block_001"),
    visual_intent: "city_landmark",
    required_visual_evidence: [],
    forbidden_visual_categories: [],
  };

  const indexed = await indexAsset({
    videoId,
    asset,
    scene,
    windows,
    policyVersion: config.CLIP_LIBRARY_POLICY_VERSION || "v1",
    generatePhysicalClips: true,
  });

  for (const window of windows) {
    await bulkUpdateStatusByAssetAndWindow({
      assetId: asset.asset_id,
      sourceStartSec: Number(window.start_seconds || 0),
      sourceEndSec: Number(window.end_seconds || 0),
      sourceVideoPath: videoPath,
      status: "approved",
      policyVersion: config.CLIP_LIBRARY_POLICY_VERSION || "v1",
      approvalContext: {
        stage: "shadow_promote",
      },
    });
  }

  const timelineMockCandidates = await searchApprovedClips({
    sceneIndex: Number(scene.scene_index || 0),
    blockId: String(scene.block_id || ""),
    visualIntent: String(scene.visual_intent || ""),
    keywords: ["shadow", "decupagem"],
    limit: 50,
  });
  const summary = await summarizeClipLibrary({ videoId });

  const report = {
    video_id: videoId,
    shadow_input_video_path: videoPath,
    shadow_generated_at: new Date().toISOString(),
    decupagem_windows: windows.length,
    generated_clip_ids: indexed.generated_clip_ids || [],
    timeline_mock_candidates_count: timelineMockCandidates.length,
    clip_library_summary: summary,
    metrics: {
      coverage_ratio: windows.length
        ? Number((timelineMockCandidates.length / windows.length).toFixed(3))
        : 0,
      reuse_ratio: Number(summary.clip_reuse_ratio || 0),
    },
  };

  await fs.ensureDir(config.CLIP_LIBRARY_SHADOW_REPORT_DIR);
  const reportPath = path.join(
    config.CLIP_LIBRARY_SHADOW_REPORT_DIR,
    `${videoId}-clip-library-shadow-report.json`
  );
  await fs.writeJson(reportPath, report, { spaces: 2 });

  return {
    ...report,
    report_path: reportPath,
  };
};

module.exports = {
  runClipLibraryShadow,
  __test__: {
    buildWindowsFromDuration,
  },
};

