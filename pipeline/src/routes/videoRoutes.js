const { Router } = require("express");
const { z } = require("zod");
const { v4: uuidv4 } = require("uuid");
const { generateIdeas, approveIdea } = require("../services/ideasService");
const { generateScript } = require("../services/scriptService");
const { generateAudio } = require("../services/ttsService");
const { generateCaptions } = require("../services/captionsService");
const { generateAssets } = require("../services/assetsService");
const { renderVideo } = require("../services/renderService");
const { analyzeAudio } = require("../services/audioIntelligence");
const { validateRender, fixRenderSync } = require("../services/syncValidator");
const { generateMetadata } = require("../services/metadataService");
const { uploadToYoutube } = require("../services/youtubeService");
const { markNeedsManualReview } = require("../services/manualReviewService");
const { loadState, updateState, setStateError } = require("../services/stateService");
const { triggerWorkflow2, triggerWorkflow3 } = require("../services/workflowHandoffService");
const { requestReviewRegeneration } = require("../services/reviewRevisionService");
const { config } = require("../config/env");

const router = Router();

const bodyWithVideoId = z.object({
  video_id: z.string().min(3),
  mock_mode: z.boolean().optional(),
});

const withDefaultMock = (input) => (input.mock_mode === undefined ? config.MOCK_MODE : input.mock_mode);

router.post("/videos/ideas/generate", async (req, res, next) => {
  try {
    const schema = z.object({
      video_id: z.string().optional(),
      count: z.number().min(3).max(5).optional(),
      mock_mode: z.boolean().optional(),
    });

    const parsed = schema.parse(req.body || {});
    const videoId = parsed.video_id || uuidv4();

    const result = await generateIdeas({
      videoId,
      count: parsed.count || 5,
      mockMode: withDefaultMock(parsed),
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/videos/ideas/approve", async (req, res, next) => {
  try {
    const schema = bodyWithVideoId.extend({
      idea_number: z.number().optional(),
      idea_id: z.string().optional(),
    });

    const parsed = schema.parse(req.body || {});
    if (!parsed.idea_number && !parsed.idea_id) {
      return res.status(400).json({
        ok: false,
        error: "Informe idea_number ou idea_id para aprovar.",
      });
    }

    const result = await approveIdea({
      videoId: parsed.video_id,
      ideaNumber: parsed.idea_number,
      ideaId: parsed.idea_id,
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/videos/script/generate", async (req, res, next) => {
  try {
    const schema = bodyWithVideoId.extend({
      topic: z.string().optional(),
      trigger_workflow_2: z.boolean().optional(),
    });

    const parsed = schema.parse(req.body || {});

    const result = await generateScript({
      videoId: parsed.video_id,
      topic: parsed.topic,
      mockMode: withDefaultMock(parsed),
    });

    const state = await loadState(parsed.video_id);

    let workflow2 = { triggered: false };
    if (parsed.trigger_workflow_2) {
      workflow2 = await triggerWorkflow2({
        video_id: state.video_id,
        topic: state.topic,
        script_text: state.script_text,
        state_path: state.state_path,
      });
    }

    res.json({
      ok: true,
      ...result,
      handoff_payload_workflow_2: {
        video_id: state.video_id,
        topic: state.topic,
        script_text: state.script_text,
        state_path: state.state_path,
      },
      workflow_2_trigger: workflow2,
    });
  } catch (error) {
    await setStateError(req.body?.video_id, error, "script_generation_failed").catch(() => null);
    next(error);
  }
});

router.post("/videos/audio/generate", async (req, res, next) => {
  try {
    const schema = bodyWithVideoId.extend({
      provider: z.enum(["multivozes", "openai", "elevenlabs"]).optional(),
    });

    const parsed = schema.parse(req.body || {});
    const result = await generateAudio({
      videoId: parsed.video_id,
      mockMode: withDefaultMock(parsed),
      provider: parsed.provider || "multivozes",
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    await setStateError(req.body?.video_id, error, "audio_generation_failed").catch(() => null);
    next(error);
  }
});

router.post("/videos/captions/generate", async (req, res, next) => {
  try {
    const parsed = bodyWithVideoId.parse(req.body || {});
    const result = await generateCaptions({
      videoId: parsed.video_id,
      mockMode: withDefaultMock(parsed),
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    await setStateError(req.body?.video_id, error, "captions_generation_failed").catch(() => null);
    next(error);
  }
});

router.post("/videos/assets/search", async (req, res, next) => {
  try {
    const schema = bodyWithVideoId.extend({
      max_assets: z.number().min(1).max(20).optional(),
      trigger_workflow_3: z.boolean().optional(),
    });

    const parsed = schema.parse(req.body || {});
    const result = await generateAssets({
      videoId: parsed.video_id,
      mockMode: withDefaultMock(parsed),
      maxAssets: parsed.max_assets || 8,
    });

    const state = await loadState(parsed.video_id);

    let workflow3 = { triggered: false };
    if (parsed.trigger_workflow_3) {
      workflow3 = await triggerWorkflow3({
        video_id: state.video_id,
        topic: state.topic,
        state_path: state.state_path,
        script_text: state.script_text,
        audio_path: state.audio_path,
        caption_path_srt: state.caption_path_srt,
        assets_json: state.assets_json,
      });
    }

    res.json({
      ok: true,
      ...result,
      handoff_payload_workflow_3: {
        video_id: state.video_id,
        topic: state.topic,
        state_path: state.state_path,
        script_text: state.script_text,
        audio_path: state.audio_path,
        caption_path_srt: state.caption_path_srt,
        assets_json: state.assets_json,
      },
      workflow_3_trigger: workflow3,
    });
  } catch (error) {
    await setStateError(req.body?.video_id, error, "assets_search_failed").catch(() => null);
    next(error);
  }
});

router.post("/videos/render", async (req, res, next) => {
  try {
    const schema = bodyWithVideoId.extend({
      background_music_path: z.string().optional(),
    });

    const parsed = schema.parse(req.body || {});

    const result = await renderVideo({
      videoId: parsed.video_id,
      mockMode: withDefaultMock(parsed),
      backgroundMusicPath: parsed.background_music_path,
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    await setStateError(req.body?.video_id, error, "render_failed").catch(() => null);
    next(error);
  }
});

router.post("/videos/audio/intelligence", async (req, res, next) => {
  try {
    const parsed = bodyWithVideoId.parse(req.body || {});
    const result = await analyzeAudio({
      videoId: parsed.video_id,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    await setStateError(req.body?.video_id, error, "audio_intelligence_failed").catch(() => null);
    next(error);
  }
});

router.post("/videos/render/validate", async (req, res, next) => {
  try {
    const parsed = bodyWithVideoId.parse(req.body || {});
    const result = await validateRender({
      videoId: parsed.video_id,
      mockMode: withDefaultMock(parsed),
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    await setStateError(req.body?.video_id, error, "render_validation_failed").catch(() => null);
    next(error);
  }
});

router.post("/videos/render/fix-sync", async (req, res, next) => {
  try {
    const parsed = bodyWithVideoId.parse(req.body || {});
    const result = await fixRenderSync({
      videoId: parsed.video_id,
      mockMode: withDefaultMock(parsed),
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    await setStateError(req.body?.video_id, error, "render_fix_sync_failed").catch(() => null);
    next(error);
  }
});

router.post("/videos/metadata/generate", async (req, res, next) => {
  try {
    const parsed = bodyWithVideoId.parse(req.body || {});

    const result = await generateMetadata({
      videoId: parsed.video_id,
      mockMode: withDefaultMock(parsed),
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    await setStateError(req.body?.video_id, error, "metadata_generation_failed").catch(() => null);
    next(error);
  }
});

router.post("/videos/final/approve", async (req, res, next) => {
  try {
    const schema = bodyWithVideoId.extend({
      approved: z.boolean(),
      note: z.string().optional(),
    });

    const parsed = schema.parse(req.body || {});

    const nextState = await updateState(
      parsed.video_id,
      {
        approved: parsed.approved,
        status: parsed.approved ? "final_approved" : "needs_revision",
        current_step: parsed.approved ? "final_approved" : "needs_revision",
        error_message: "",
      },
      {
        currentStep: parsed.approved ? "final_approved" : "needs_revision",
        status: parsed.approved ? "final_approved" : "needs_revision",
      }
    );

    res.json({
      ok: true,
      video_id: parsed.video_id,
      approved: nextState.approved,
      status: nextState.status,
      note: parsed.note || "",
      state_path: nextState.state_path,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/videos/review/regenerate", async (req, res, next) => {
  try {
    const schema = bodyWithVideoId.extend({
      note: z.string().optional(),
    });

    const parsed = schema.parse(req.body || {});

    const result = await requestReviewRegeneration({
      videoId: parsed.video_id,
      note: parsed.note,
      mockMode: withDefaultMock(parsed),
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    await setStateError(req.body?.video_id, error, "review_regeneration_failed").catch(() => null);
    next(error);
  }
});

router.post("/videos/review/mark-manual-review", async (req, res, next) => {
  try {
    const schema = bodyWithVideoId.extend({
      note: z.string().optional(),
      source: z.string().optional(),
    });

    const parsed = schema.parse(req.body || {});

    const result = await markNeedsManualReview({
      videoId: parsed.video_id,
      note: parsed.note,
      source: parsed.source,
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    await setStateError(req.body?.video_id, error, "manual_review_mark_failed").catch(() => null);
    next(error);
  }
});

router.post("/videos/youtube/upload", async (req, res, next) => {
  try {
    const schema = bodyWithVideoId.extend({
      privacy_status: z.enum(["private", "public", "unlisted"]).optional(),
    });

    const parsed = schema.parse(req.body || {});
    const state = await loadState(parsed.video_id);
    const requestedMockMode = withDefaultMock(parsed);
    const runtimeProfile = String(
      state?.render_validation?.qa_runtime_profile
      || (requestedMockMode ? config.QA_RUNTIME_PROFILE_MOCK : config.QA_RUNTIME_PROFILE_PROD)
      || "prod_strict"
    ).toLowerCase();
    const strictRuntimeProfile = runtimeProfile !== "mock_relaxed";
    const hardBoundaryStatus = state?.render_validation?.hard_boundary_status || "unknown";
    const maxVisualLagSec = Number(state?.render_validation?.max_visual_lag_sec || 0);
    const maxAllowedLagSec = Number(config.HARD_BOUNDARY_MAX_LAG_SEC || 0.5);

    if (strictRuntimeProfile && hardBoundaryStatus !== "pass") {
      return res.status(409).json({
        ok: false,
        error: "Upload bloqueado: hard boundary QA reprovado.",
        hard_boundary_status: hardBoundaryStatus,
        max_visual_lag_sec: maxVisualLagSec,
      });
    }

    if (strictRuntimeProfile && maxVisualLagSec > maxAllowedLagSec) {
      return res.status(409).json({
        ok: false,
        error: "Upload bloqueado: max_visual_lag_sec acima do limite configurado.",
        max_visual_lag_sec: maxVisualLagSec,
        hard_boundary_max_lag_sec: maxAllowedLagSec,
      });
    }

    const result = await uploadToYoutube({
      videoId: parsed.video_id,
      mockMode: requestedMockMode,
      privacyStatus: parsed.privacy_status,
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    await setStateError(req.body?.video_id, error, "youtube_upload_failed").catch(() => null);
    next(error);
  }
});

router.get("/videos/:video_id/state", async (req, res, next) => {
  try {
    const state = await loadState(req.params.video_id);
    res.json({ ok: true, state });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
