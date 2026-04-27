const path = require("path");
const fs = require("fs-extra");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const { ensureVideoStructure, loadState, updateState } = require("./stateService");
const { escapeSubtitlePath } = require("../utils/fileUtils");

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const isVideoFile = (filePath = "") => /\.(mp4|mov|webm|mkv|avi)$/i.test(filePath);
const isImageFile = (filePath = "") => /\.(jpg|jpeg|png|webp)$/i.test(filePath);

const createFallbackImage = async (outputPath) => {
  await fs.ensureDir(path.dirname(outputPath));
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+f4kAAAAASUVORK5CYII=";
  await fs.writeFile(outputPath, Buffer.from(pngBase64, "base64"));
  return outputPath;
};

const renderVideo = async ({ videoId, mockMode = false, backgroundMusicPath = "" }) => {
  const state = await loadState(videoId);
  const paths = await ensureVideoStructure(videoId);

  if (!state.audio_path || !(await fs.pathExists(state.audio_path))) {
    throw new Error("Áudio não encontrado para renderização.");
  }

  const firstAsset = (state.assets_json?.items || []).find((item) => item.local_path && fs.existsSync(item.local_path));

  let visualInputPath = firstAsset?.local_path || "";
  if (!visualInputPath) {
    visualInputPath = path.join(paths.base, "assets", "raw", "fallback-background.png");
    await createFallbackImage(visualInputPath);
  }

  if (!isImageFile(visualInputPath) && !isVideoFile(visualInputPath)) {
    visualInputPath = path.join(paths.base, "assets", "raw", "fallback-background.png");
    await createFallbackImage(visualInputPath);
  }

  const subtitlePath = state.caption_path_srt && (await fs.pathExists(state.caption_path_srt)) ? state.caption_path_srt : "";
  const renderPath = paths.renderPath;
  const duration = Math.max(10, Number(state.duration_seconds || 95));

  await new Promise((resolve, reject) => {
    const command = ffmpeg();

    if (isVideoFile(visualInputPath)) {
      command.input(visualInputPath).inputOptions(["-stream_loop -1"]);
    } else {
      command.input(visualInputPath).inputOptions(["-loop 1", "-framerate 30"]);
    }

    command.input(state.audio_path);

    const vf = ["scale=1280:720:force_original_aspect_ratio=increase", "crop=1280:720"];
    if (subtitlePath) {
      vf.push(`subtitles='${escapeSubtitlePath(subtitlePath)}':force_style='Fontsize=22,BorderStyle=3,Outline=1,Shadow=0,PrimaryColour=&Hffffff&,BackColour=&H80000000'`);
    }

    command
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions([
        `-vf ${vf.join(",")}`,
        "-preset veryfast",
        "-pix_fmt yuv420p",
        `-t ${duration}`,
        "-shortest",
      ])
      .on("end", resolve)
      .on("error", reject)
      .save(renderPath);
  }).catch(async () => {
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(visualInputPath)
        .inputOptions(["-loop 1", "-framerate 30"])
        .input(state.audio_path)
        .videoCodec("libx264")
        .audioCodec("aac")
        .outputOptions(["-pix_fmt yuv420p", `-t ${duration}`, "-shortest"])
        .save(renderPath)
        .on("end", resolve)
        .on("error", reject);
    });
  });

  if (backgroundMusicPath && !mockMode) {
    // Optional stage reserved for future mix implementation
  }

  const nextState = await updateState(
    videoId,
    {
      render_path: renderPath,
      error_message: "",
    },
    { currentStep: "render_generated", status: "render_generated" }
  );

  return {
    video_id: videoId,
    render_path: nextState.render_path,
    state_path: nextState.state_path,
  };
};

module.exports = {
  renderVideo,
};
