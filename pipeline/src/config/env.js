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
  OUTPUT_ROOT,
  N8N_BASE_URL: process.env.N8N_BASE_URL || "http://n8n:5678",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
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