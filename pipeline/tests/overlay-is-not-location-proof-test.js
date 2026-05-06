const assert = require('assert');
const { __test__ } = require('../src/services/syncValidator');

const gate = __test__.evaluateClipAuditGate({
  clipAuditRows: [
    { visual_truth_status: 'fail', out_of_domain_asset: false, is_hard_boundary_first_clip: false },
  ],
});
assert(gate.hardBoundaryInvalid === false, 'overlay/text is not used as location proof in clip gate');
console.log('overlay-is-not-location-proof-test ok');
