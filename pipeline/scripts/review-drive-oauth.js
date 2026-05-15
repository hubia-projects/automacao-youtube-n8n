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

const clientId = process.env.GOOGLE_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID || "";
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET || "";
const redirectUri = "https://developers.google.com/oauthplayground";
const requestedScopes = ["https://www.googleapis.com/auth/drive.file"];

const command = process.argv[2] || "url";
const code = process.argv[3] || "";

if (!clientId || !clientSecret) {
  console.error("OAuth client_id/client_secret ausentes. Configure YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET ou GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.");
  process.exit(1);
}

const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const printUsage = () => {
  console.log("Uso:");
  console.log("  node scripts/review-drive-oauth.js url");
  console.log("  node scripts/review-drive-oauth.js exchange <authorization_code>");
};

const main = async () => {
  if (command === "url") {
    const url = auth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
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

    console.log(
      JSON.stringify(
        {
          has_refresh_token: Boolean(tokens.refresh_token),
          scope: tokens.scope || "",
          google_refresh_token: tokens.refresh_token || "",
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
