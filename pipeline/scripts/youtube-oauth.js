const { google } = require("googleapis");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

const pipelineRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(pipelineRoot, "..");
[
  path.join(repoRoot, ".env"),
  path.join(repoRoot, ".env.local"),
  path.join(pipelineRoot, ".env"),
  path.join(process.cwd(), ".env"),
].forEach((candidatePath) => {
  if (fs.existsSync(candidatePath)) {
    dotenv.config({ path: candidatePath, override: false });
  }
});

const clientId = process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "";
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "";
const redirectUri = "https://developers.google.com/oauthplayground";
const requestedScopes = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.upload",
];
const uploadScope = "https://www.googleapis.com/auth/youtube.upload";
const captionScope = "https://www.googleapis.com/auth/youtube.force-ssl";

const command = process.argv[2] || "url";
const code = process.argv[3] || "";

if (!clientId || !clientSecret) {
  console.error("OAuth client_id/client_secret ausentes. Configure YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET.");
  process.exit(1);
}

const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const printUsage = () => {
  console.log("Uso:");
  console.log("  node scripts/youtube-oauth.js url");
  console.log("  node scripts/youtube-oauth.js exchange <authorization_code>");
};

const main = async () => {
  if (command === "url") {
    const url = auth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: false,
      scope: requestedScopes,
    });

    console.log(url);
    return;
  }

  if (command === "exchange") {
    if (!code) {
      printUsage();
      process.exit(1);
    }

    const { tokens } = await auth.getToken(code);
    const scopeList = String(tokens.scope || "")
      .split(/\s+/)
      .filter(Boolean);
    const warnings = [];

    if (!tokens.refresh_token) {
      warnings.push("Google nao retornou refresh_token. Refaca a autorizacao com prompt=consent.");
    }

    if (!scopeList.includes(uploadScope)) {
      warnings.push(`Token retornado sem escopo obrigatorio de upload: ${uploadScope}`);
    }

    if (!scopeList.includes(captionScope)) {
      warnings.push(`Token retornado sem escopo de legenda: ${captionScope}`);
    }

    if (tokens.refresh_token_expires_in) {
      warnings.push(
        `refresh_token com expiracao reportada pelo Google (${tokens.refresh_token_expires_in}s). Se isso vier como ~604800s, o app OAuth provavelmente esta em Testing no Google Auth Platform.`
      );
    }

    console.log(
      JSON.stringify(
        {
          has_refresh_token: Boolean(tokens.refresh_token),
          scope: tokens.scope || "",
          refresh_token_expires_in: tokens.refresh_token_expires_in || 0,
          has_upload_scope: scopeList.includes(uploadScope),
          has_caption_scope: scopeList.includes(captionScope),
          warnings,
          youtube_refresh_token: tokens.refresh_token || "",
        },
        null,
        2
      )
    );
    return;
  }

  printUsage();
  process.exit(1);
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
