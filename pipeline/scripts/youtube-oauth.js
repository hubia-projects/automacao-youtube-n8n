const { google } = require("googleapis");
const dotenv = require("dotenv");

dotenv.config();

const clientId = process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "";
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "";
const redirectUri = "https://developers.google.com/oauthplayground";
const requestedScopes = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.upload",
];

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