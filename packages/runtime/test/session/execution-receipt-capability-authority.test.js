import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestId, PlanId } from '../../src/ids.js';
import { buildCapabilityAuthorityReceipt } from '../../src/session/execution-receipt.js';
test('builds a receipt with the capability-authority provenance fields set, and no package/component fields', () => {
    const receipt = buildCapabilityAuthorityReceipt({
        requestId: RequestId('req_1'),
        planId: PlanId('plan_1'),
        capabilityId: 'capability:claim-evaluation',
        contractId: 'capability:claim-evaluation',
        bindingId: 'binding_capability:claim-evaluation_structured-comparison-resolver',
        sourceXoirNodeIds: ['capability:claim-evaluation', 'decision:deny-large-claim'],
        executionDurationMs: 3,
    });
    assert.equal(receipt.contractId, 'capability:claim-evaluation');
    assert.equal(receipt.bindingId, 'binding_capability:claim-evaluation_structured-comparison-resolver');
    assert.deepEqual(receipt.sourceXoirNodeIds, ['capability:claim-evaluation', 'decision:deny-large-claim']);
    assert.deepEqual(receipt.packagesUsed, []);
    assert.deepEqual(receipt.componentHashes, []);
    assert.deepEqual(receipt.capabilitiesInvoked, ['capability:claim-evaluation']);
    assert.equal(receipt.validationResults.valid, true);
    assert.deepEqual(receipt.validationResults.issues, []);
});
test('estimatedCost/degraded (the Stage 2 fields) are absent on a capability-authority receipt', () => {
    const receipt = buildCapabilityAuthorityReceipt({
        requestId: RequestId('req_1'),
        planId: PlanId('plan_1'),
        capabilityId: 'c',
        contractId: 'c',
        bindingId: 'b',
        sourceXoirNodeIds: [],
        executionDurationMs: 1,
    });
    assert.equal(receipt.estimatedCost, undefined);
    assert.equal(receipt.degraded, undefined);
});
test('errors default to an empty array and are carried through when provided', () => {
    const receipt = buildCapabilityAuthorityReceipt({
        requestId: RequestId('req_1'),
        planId: PlanId('plan_1'),
        capabilityId: 'c',
        contractId: 'c',
        bindingId: 'b',
        sourceXoirNodeIds: [],
        executionDurationMs: 1,
        errors: ['something noteworthy but non-fatal'],
    });
    assert.deepEqual(receipt.errors, ['something noteworthy but non-fatal']);
});
//# sourceMappingURL=execution-receipt-capability-authority.test.js.map