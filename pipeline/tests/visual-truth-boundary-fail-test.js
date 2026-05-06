const assert = require('assert');
const { __test__ } = require('../src/services/syncValidator');

const gate = __test__.evaluateClipAuditGate({
  clipAuditRows: [
    { is_hard_boundary_first_clip: true, visual_truth_status: 'uncertain' },
    { visual_truth_status: 'pass' },
  ],
});
assert(gate.hardBoundaryInvalid === true, 'hard boundary first clip must require pass');
console.log('visual-truth-boundary-fail-test ok');
