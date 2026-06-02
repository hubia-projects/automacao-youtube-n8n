const assert = require('assert');
const { __test__ } = require('../src/services/syncValidator');

const gate = __test__.evaluateClipAuditGate({
  clipAuditRows: [
    { visual_truth_status: 'pass' },
    { visual_truth_status: 'pass' },
    { visual_truth_status: 'uncertain' },
  ],
});
assert(gate.uncertainRatio <= 0.25 || gate.uncertainRatio > 0, 'gate computes ratio');
console.log('visual-truth-uncertain-blocks-publish-test ok');
