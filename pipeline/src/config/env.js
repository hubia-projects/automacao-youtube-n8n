const path = require("path");
const fs = require("fs-extra");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(process.cwd(), ".env") });

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
};

const OUTPUT_ROOT = process.env.OUTPUT_ROOT || path.join(process.cwd(), "output");

const config = {
  APP_PORT: Number(process.env.APP_PORT || 8080),
  MOCK_MODE: toBool(process.env.MOCK_MODE, false),
  ALLOW_PLACEHOLDER_ASSETS: toBool(process.env.ALLOW_PLACEHOLDER_ASSETS, false),
  OUTPUT_ROOT,
  N8N_BASE_URL: process.env.N8N_BASE_URL || "http://n8n:5678",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  LOCAL_ASSET_LIBRARY_PATH: process.env.LOCAL_ASSET_LIBRARY_PATH || "",
  MULTIVOZES_BR_ENGINE:
    process.env.MULTIVOZES_BR_ENGINE || process.env.MULTIVOZEZ_BR_ENGINE || "",
  MULTIVOZES_BR_BASE_URL: process.env.MULTIVOZES_BR_BASE_URL || "http://host.docker.internal:5050/v1",
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || "",
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
  PEXELS_API_KEY: process.env.PEXELS_API_KEY || "",
  PIXABAY_API_KEY: process.env.PIXABAY_API_KEY || "",
  UNSPLASH_ACCESS_KEY: process.env.UNSPLASH_ACCESS_KEY || "",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  TELEGRAM_POLL_INTERVAL_MS: Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 3000),
  TELEGRAM_VERBOSE_STATUS: toBool(process.env.TELEGRAM_VERBOSE_STATUS, true),
  SEMANTIC_SYNC_MODE: process.env.SEMANTIC_SYNC_MODE || "cost-efficient",
  SEMANTIC_SYNC_MAX_LATENCY_SEC: Number(process.env.SEMANTIC_SYNC_MAX_LATENCY_SEC || 1),
  SEMANTIC_SYNC_QA_MIN_SCORE: Number(process.env.SEMANTIC_SYNC_QA_MIN_SCORE || 0.78),
  SEMANTIC_SYNC_QA_SAMPLE_INTERVAL_SEC: Number(process.env.SEMANTIC_SYNC_QA_SAMPLE_INTERVAL_SEC || 2),
  HARD_BOUNDARY_ENABLED: toBool(process.env.HARD_BOUNDARY_ENABLED, true),
  HARD_BOUNDARY_MAX_LAG_SEC: Number(process.env.HARD_BOUNDARY_MAX_LAG_SEC || 0.5),
  HARD_BOUNDARY_FORBID_NEUTRAL_FIRST_CLIP: toBool(process.env.HARD_BOUNDARY_FORBID_NEUTRAL_FIRST_CLIP, true),
  HARD_BOUNDARY_REQUIRE_LOCATION: toBool(process.env.HARD_BOUNDARY_REQUIRE_LOCATION, true),
  HARD_BOUNDARY_REQUIRE_CHAPTER_OVERLAY: toBool(process.env.HARD_BOUNDARY_REQUIRE_CHAPTER_OVERLAY, true),
  HARD_BOUNDARY_FAIL_ON_MISS: toBool(process.env.HARD_BOUNDARY_FAIL_ON_MISS, true),
  LOCAL_VIDEO_UNDERSTANDING_ENABLED: toBool(process.env.LOCAL_VIDEO_UNDERSTANDING_ENABLED, false),
  LOCAL_VIDEO_UNDERSTANDING_MODE: process.env.LOCAL_VIDEO_UNDERSTANDING_MODE || "frames",
  LOCAL_VIDEO_UNDERSTANDING_WINDOW_SECONDS: Number(process.env.LOCAL_VIDEO_UNDERSTANDING_WINDOW_SECONDS || 8),
  LOCAL_VIDEO_UNDERSTANDING_MAX_WINDOWS: Number(process.env.LOCAL_VIDEO_UNDERSTANDING_MAX_WINDOWS || 20),
  LOCAL_VIDEO_UNDERSTANDING_PYTHON: process.env.LOCAL_VIDEO_UNDERSTANDING_PYTHON || "python",
  LOCAL_VIDEO_UNDERSTANDING_SCRIPT: process.env.LOCAL_VIDEO_UNDERSTANDING_SCRIPT || "tools/video-understanding/analyze_video.py",
  ASSET_SEARCH_RESULTS_PER_QUERY: Number(process.env.ASSET_SEARCH_RESULTS_PER_QUERY || 12),
  ASSET_CANDIDATE_POOL_PER_SCENE: Number(process.env.ASSET_CANDIDATE_POOL_PER_SCENE || 30),
  ASSET_DOWNLOAD_TOP_PER_SCENE: Number(process.env.ASSET_DOWNLOAD_TOP_PER_SCENE || 6),
  MIN_SPECIFIC_ASSETS_PER_SCENE: Number(process.env.MIN_SPECIFIC_ASSETS_PER_SCENE || 2),
  ENABLE_BLOCK_OVERLAYS: toBool(process.env.ENABLE_BLOCK_OVERLAYS, true),
  OUTPUT_WIDTH: Number(process.env.OUTPUT_WIDTH || 1920),
  OUTPUT_HEIGHT: Number(process.env.OUTPUT_HEIGHT || 1080),
  OUTPUT_FPS: Number(process.env.OUTPUT_FPS || 30),
  VIDEO_BITRATE: process.env.VIDEO_BITRATE || "6M",
  MAX_VIDEO_BITRATE: process.env.MAX_VIDEO_BITRATE || "8M",
  N8N_IDEA_APPROVAL_WEBHOOK_PATH: process.env.N8N_IDEA_APPROVAL_WEBHOOK_PATH || "idea-approval",
  N8N_FINAL_APPROVAL_WEBHOOK_PATH:
    process.env.N8N_FINAL_APPROVAL_WEBHOOK_PATH || "final-approval",
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID || "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET || "",
  GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN || process.env.YOUTUBE_REFRESH_TOKEN || "",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "",
  REVIEW_DRIVE_FOLDER_ID: process.env.REVIEW_DRIVE_FOLDER_ID || "",
  REVIEW_SPREADSHEET_ID: process.env.REVIEW_SPREADSHEET_ID || "",
  REVIEW_SHEET_NAME: process.env.REVIEW_SHEET_NAME || "Revisoes",
  REVIEW_DRIVE_PUBLIC: toBool(process.env.REVIEW_DRIVE_PUBLIC, true),
  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID || "",
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET || "",
  YOUTUBE_REFRESH_TOKEN: process.env.YOUTUBE_REFRESH_TOKEN || "",
  YOUTUBE_DEFAULT_PRIVACY: process.env.YOUTUBE_DEFAULT_PRIVACY || "private",
  YOUTUBE_CAPTION_LANGUAGE: process.env.YOUTUBE_CAPTION_LANGUAGE || "pt-BR",
  YOUTUBE_CAPTION_NAME: process.env.YOUTUBE_CAPTION_NAME || "Português (Brasil)",
  N8N_WORKFLOW_2_WEBHOOK: process.env.N8N_WORKFLOW_2_WEBHOOK || "",
  N8N_WORKFLOW_3_WEBHOOK: process.env.N8N_WORKFLOW_3_WEBHOOK || "",
};

fs.ensureDirSync(config.OUTPUT_ROOT);
fs.ensureDirSync(path.join(config.OUTPUT_ROOT, "draft"));

module.exports = { config };
