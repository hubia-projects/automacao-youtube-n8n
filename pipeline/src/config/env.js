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
  MOCK_MODE: toBool(process.env.MOCK_MODE, true),
  OUTPUT_ROOT,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || "",
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
  PEXELS_API_KEY: process.env.PEXELS_API_KEY || "",
  PIXABAY_API_KEY: process.env.PIXABAY_API_KEY || "",
  UNSPLASH_ACCESS_KEY: process.env.UNSPLASH_ACCESS_KEY || "",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID || "",
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET || "",
  YOUTUBE_REFRESH_TOKEN: process.env.YOUTUBE_REFRESH_TOKEN || "",
  YOUTUBE_DEFAULT_PRIVACY: process.env.YOUTUBE_DEFAULT_PRIVACY || "private",
  N8N_WORKFLOW_2_WEBHOOK: process.env.N8N_WORKFLOW_2_WEBHOOK || "",
  N8N_WORKFLOW_3_WEBHOOK: process.env.N8N_WORKFLOW_3_WEBHOOK || "",
};

fs.ensureDirSync(config.OUTPUT_ROOT);
fs.ensureDirSync(path.join(config.OUTPUT_ROOT, "draft"));

module.exports = { config };