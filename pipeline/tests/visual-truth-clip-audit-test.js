const assert = require('assert');
const { __test__ } = require('../src/services/syncValidator');

const gate = __test__.evaluateClipAuditGate({
  clipAuditRows: [
    { visual_truth_status: 'pass' },
    { visual_truth_status: 'uncertain' },
    { visual_truth_status: 'uncertain' },
    { visual_truth_status: 'uncertain' },
  ],
});
assert(gate.uncertainRatio > 0.25, 'uncertain ratio should be greater than 25%');
console.log('visual-truth-clip-audit-test ok');
