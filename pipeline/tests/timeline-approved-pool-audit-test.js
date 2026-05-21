const assert = require("assert");
const { __test__: syncValidatorTest } = require("../src/services/syncValidator");

const state = {
  assets_json: {
    approved_windows: [
      { approved_window_id: "asset_1:w01" },
      { approved_window_id: "asset_2:w01" },
    ],
  },
};

const timeline = {
  clips: [
    { clip_index: 1, approved_window_id: "asset_1:w01" },
    { clip_index: 2, approved_window_id: "asset_2:w01" },
  ],
};

const okAudit = syncValidatorTest.evaluateApprovedPoolAudit({ state, timeline });
assert.strictEqual(okAudit.timeline_uses_approved_pool_only, true, "timeline deveria usar somente pool aprovado");

const invalidAudit = syncValidatorTest.evaluateApprovedPoolAudit({
  state,
  timeline: {
    clips: [
      { clip_index: 1, approved_window_id: "asset_1:w01" },
      { clip_index: 2, approved_window_id: "asset_9:w01" },
    ],
  },
});
assert.strictEqual(invalidAudit.timeline_uses_approved_pool_only, false, "clip fora do pool aprovado deveria falhar");

const clipLibraryState = {
  assets_json: {
    approved_windows: [
      { approved_window_id: "asset_1:w01" },
      { approved_window_id: "asset_2:w01" },
    ],
    clip_library: {
      approved_clip_ids: ["clip_ok_1"],
    },
  },
};

const clipLibraryApprovedAudit = syncValidatorTest.evaluateApprovedPoolAudit({
  state: clipLibraryState,
  timeline: {
    clips: [
      {
        clip_index: 1,
        approved_window_id: "cliplib:clip_ok_1",
        clip_library_id: "clip_ok_1",
        approval_provenance: {
          origin_approved_window_id: "asset_1:w01",
        },
      },
    ],
  },
});
assert.strictEqual(
  clipLibraryApprovedAudit.timeline_uses_approved_pool_only,
  true,
  "clip da biblioteca aprovado com origem rastreavel deve passar no audit"
);
assert.strictEqual(
  clipLibraryApprovedAudit.valid_clip_library_count,
  1,
  "deve contabilizar cliplib valido"
);

const clipLibraryInvalidAudit = syncValidatorTest.evaluateApprovedPoolAudit({
  state: clipLibraryState,
  timeline: {
    clips: [
      {
        clip_index: 1,
        approved_window_id: "cliplib:clip_bad_1",
        clip_library_id: "clip_bad_1",
        approval_provenance: {
          origin_approved_window_id: "asset_1:w01",
        },
      },
    ],
  },
});
assert.strictEqual(
  clipLibraryInvalidAudit.timeline_uses_approved_pool_only,
  false,
  "cliplib nao aprovado deve falhar"
);
assert.strictEqual(
  clipLibraryInvalidAudit.invalid_rows_by_reason.clip_library_id_not_approved,
  1,
  "deve apontar razao clip_library_id_not_approved"
);

const clipLibraryMissingOriginAudit = syncValidatorTest.evaluateApprovedPoolAudit({
  state: clipLibraryState,
  timeline: {
    clips: [
      {
        clip_index: 1,
        approved_window_id: "cliplib:clip_ok_1",
        clip_library_id: "clip_ok_1",
        approval_provenance: {},
      },
    ],
  },
});
assert.strictEqual(
  clipLibraryMissingOriginAudit.timeline_uses_approved_pool_only,
  false,
  "cliplib aprovado sem origem rastreavel deve falhar"
);
assert.strictEqual(
  clipLibraryMissingOriginAudit.invalid_rows_by_reason.clip_library_origin_not_tracked,
  1,
  "deve apontar razao clip_library_origin_not_tracked"
);
console.log("timeline-approved-pool-audit-test ok");
