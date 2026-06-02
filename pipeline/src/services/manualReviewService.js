const { loadState, updateState } = require("./stateService");
const { publishReviewDraft } = require("./reviewPublishingService");
const { sendWorkflowStatus } = require("./telegramService");

const summarizeIssues = (issues = []) =>
  (Array.isArray(issues) ? issues : [])
    .slice(0, 4)
    .map((issue) => issue?.message || issue?.type || "issue")
    .filter(Boolean)
    .join(" | ");

const markNeedsManualReview = async ({ videoId, note = "", source = "workflow3_post_fix_validation" }) => {
  const state = await loadState(videoId);
  const currentValidation = state.render_validation || {};
  const issueSummary = summarizeIssues(currentValidation.issues);
  const manualReviewReason = note || issueSummary || "QA pós-fix continuou reprovando o render.";

  const nextState = await updateState(
    videoId,
    {
      approved: false,
      render_validation: {
        ...currentValidation,
        is_publishable: false,
        needs_regeneration: true,
        needs_manual_review: true,
      },
      review: {
        ...state.review,
        manual_review_requested_at: new Date().toISOString(),
        manual_review_reason: manualReviewReason,
        manual_review_source: source,
      },
      error_message: manualReviewReason,
    },
    {
      currentStep: "needs_manual_review",
      status: "needs_manual_review",
    }
  );

  const reviewPublication = await publishReviewDraft({
    videoId,
    state: nextState,
  }).catch(() => ({ configured: false, published: false, state: nextState }));

  const finalState = reviewPublication.state || nextState;
  await sendWorkflowStatus({
    videoId,
    title: "Revisão manual necessária",
    icon: "⚠️",
    stageKey: `manual_review:${source}:${finalState.review?.draft_version || 1}`,
    lines: [
      manualReviewReason,
      finalState.review?.drive_view_url ? `Revisão online: ${finalState.review.drive_view_url}` : null,
      finalState.render_path ? `Render local: ${finalState.render_path}` : null,
    ],
  }).catch(() => null);

  return {
    video_id: videoId,
    needs_manual_review: true,
    reason: manualReviewReason,
    source,
    review_url: finalState.review?.drive_view_url || "",
    state_path: finalState.state_path,
  };
};

module.exports = {
  markNeedsManualReview,
};