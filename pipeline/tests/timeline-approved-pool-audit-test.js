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
console.log("timeline-approved-pool-audit-test ok");
