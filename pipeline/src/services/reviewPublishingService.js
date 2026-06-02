const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { config } = require("../config/env");
const { loadState, updateState } = require("./stateService");
const { logger } = require("../utils/logger");

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
];

const hasExplicitGoogleRefreshToken = () => Boolean(process.env.GOOGLE_REFRESH_TOKEN);

const hasServiceAccount = () =>
  Boolean(config.GOOGLE_SERVICE_ACCOUNT_EMAIL && config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);

const hasGoogleOAuth = () =>
  Boolean(hasExplicitGoogleRefreshToken() && config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);

const hasReviewPublishing = () =>
  Boolean((hasServiceAccount() || hasGoogleOAuth()) && (config.REVIEW_SPREADSHEET_ID || config.REVIEW_DRIVE_FOLDER_ID));

const getGoogleAuth = async () => {
  if (hasGoogleOAuth()) {
    const auth = new google.auth.OAuth2(
      config.GOOGLE_CLIENT_ID,
      config.GOOGLE_CLIENT_SECRET,
      "https://developers.google.com/oauthplayground"
    );

    auth.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    await auth.getAccessToken();
    return auth;
  }

  if (hasServiceAccount()) {
    const auth = new google.auth.JWT({
      email: config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: GOOGLE_SCOPES,
    });
    await auth.authorize();
    return auth;
  }

  return null;
};

const ensureSheetExists = async (sheets, spreadsheetId, sheetName) => {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheet = (spreadsheet.data?.sheets || []).find(
    (sheet) => sheet.properties?.title === sheetName
  );

  if (existingSheet) {
    return existingSheet.properties?.title || sheetName;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: sheetName } } }],
    },
  });

  return sheetName;
};

const buildDriveFileName = (state) => {
  const version = Math.max(1, Number(state.review?.draft_version || 1));
  const safeTopic = (state.topic || "video")
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

  return `${state.video_id}-v${version}-${safeTopic || "review"}.mp4`;
};

const uploadReviewFileToDrive = async ({ auth, state }) => {
  const drive = google.drive({ version: "v3", auth });
  const requestBody = {
    name: buildDriveFileName(state),
  };

  if (config.REVIEW_DRIVE_FOLDER_ID) {
    requestBody.parents = [config.REVIEW_DRIVE_FOLDER_ID];
  }

  const created = await drive.files.create({
    supportsAllDrives: true,
    requestBody,
    media: {
      mimeType: "video/mp4",
      body: fs.createReadStream(state.render_path),
    },
    fields: "id,webViewLink,webContentLink",
  });

  const fileId = created.data?.id;
  if (!fileId) {
    throw new Error("Falha ao criar o arquivo de revisão no Google Drive.");
  }

  if (config.REVIEW_DRIVE_PUBLIC) {
    await drive.permissions.create({
      fileId,
      supportsAllDrives: true,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
    });
  }

  const fileMeta = await drive.files.get({
    fileId,
    supportsAllDrives: true,
    fields: "id,webViewLink,webContentLink",
  });

  return {
    drive_file_id: fileId,
    drive_view_url:
      fileMeta.data?.webViewLink || `https://drive.google.com/file/d/${fileId}/view?usp=sharing`,
    drive_download_url:
      fileMeta.data?.webContentLink || `https://drive.google.com/uc?id=${fileId}&export=download`,
  };
};

const appendReviewRowToSheet = async ({ auth, state, reviewInfo }) => {
  if (!config.REVIEW_SPREADSHEET_ID) {
    return {
      sheet_url: "",
      sheet_name: "",
    };
  }

  const sheets = google.sheets({ version: "v4", auth });
  const sheetName = await ensureSheetExists(sheets, config.REVIEW_SPREADSHEET_ID, config.REVIEW_SHEET_NAME);

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.REVIEW_SPREADSHEET_ID,
    range: `${sheetName}!A:J`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          new Date().toISOString(),
          state.video_id,
          `v${Math.max(1, Number(state.review?.draft_version || 1))}`,
          state.status,
          state.topic || "",
          state.youtube_title || "",
          reviewInfo.drive_view_url || "",
          reviewInfo.drive_download_url || "",
          (state.youtube_tags || []).join(", "),
          path.basename(state.render_path || ""),
        ],
      ],
    },
  });

  return {
    sheet_url: `https://docs.google.com/spreadsheets/d/${config.REVIEW_SPREADSHEET_ID}/edit`,
    sheet_name: sheetName,
  };
};

const publishReviewDraft = async ({ videoId, state: providedState = null }) => {
  const state = providedState || (await loadState(videoId));

  if (!state.render_path || !fs.existsSync(state.render_path)) {
    return {
      configured: false,
      published: false,
      state,
      message: "Render ainda não existe para publicação de revisão.",
    };
  }

  if (!hasReviewPublishing()) {
    return {
      configured: false,
      published: false,
      state,
      message: "Google Drive/Sheets não configurados para revisão online.",
    };
  }

  const auth = await getGoogleAuth();
  if (!auth) {
    return {
      configured: false,
      published: false,
      state,
      message: "Credenciais Google não disponíveis para revisão online.",
    };
  }

  try {
    const reviewInfo = await uploadReviewFileToDrive({ auth, state });
    const sheetInfo = await appendReviewRowToSheet({ auth, state, reviewInfo });

    const nextState = await updateState(
      videoId,
      {
        review: {
          ...state.review,
          ...reviewInfo,
          ...sheetInfo,
          last_published_at: new Date().toISOString(),
        },
      },
      {
        currentStep: state.current_step,
        status: state.status,
      }
    );

    return {
      configured: true,
      published: true,
      state: nextState,
      drive_view_url: nextState.review?.drive_view_url || "",
      sheet_url: nextState.review?.sheet_url || "",
    };
  } catch (error) {
    logger.warn("Review publishing failed", { video_id: videoId, message: error.message });
    return {
      configured: true,
      published: false,
      state,
      message: error.message,
    };
  }
};

module.exports = {
  publishReviewDraft,
};
