const assert = require("assert");
const fs = require("fs-extra");
const { __test__: { writeVisualTruthFinalReport } } = require("../src/services/syncValidator");

const baseValidation = {
  render_path: "pipeline/output/example/render/final.mp4",
  upload_source_path: "pipeline/output/example/render/final.mp4",
  youtube_video_id: "",
  ffprobe_width: 1920,
  ffprobe_height: 1080,
  ffprobe_duration: 42,
  state_output_resolution: "1920x1080",
  metadata_boundary_status: "pass",
  visual_frame_boundary_status: "pass",
  final_hard_boundary_status: "pass",
  contact_sheet_path: "pipeline/test_reports/contact-sheet.jpg",
  visual_audit_json_path: "pipeline/test_reports/visual-audit.json",
  visual_alignment: {
    boundary_visual_audit: [],
  },
  clip_audit: [],
};

const run = async () => {
  const firstPath = await writeVisualTruthFinalReport({ videoId: "video_alpha", validation: baseValidation });
  const secondPath = await writeVisualTruthFinalReport({ videoId: "video_beta", validation: baseValidation });

  assert.notStrictEqual(firstPath, secondPath, "cada relatório final deve ter caminho próprio");
  assert(firstPath.includes("visual-truth-video_alpha-") || firstPath.includes("visual-truth-video-alpha-"), "relatório deve carregar o video_id no nome do arquivo");
  assert(secondPath.includes("visual-truth-video_beta-") || secondPath.includes("visual-truth-video-beta-"), "relatório deve carregar o video_id no nome do arquivo");
  assert(await fs.pathExists(firstPath), "primeiro relatório deve ser gravado no disco");
  assert(await fs.pathExists(secondPath), "segundo relatório deve ser gravado no disco");

  console.log("visual truth final report path ok");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});