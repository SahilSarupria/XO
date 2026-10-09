import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuredComparisonBindingResolver } from '../src/structured-comparison-resolver.js';
import { resolveCapabilityBinding } from '../src/resolve-binding.js';
function makeRule(overrides = {}) {
    return {
        sourceNodeId: 'decision:1',
        kind: 'decision_node',
        condition: 'the claimed loss amount exceeds 10000',
        outcome: 'deny the claim',
        exceptionConditions: [],
        confidence: 0.9,
        ...overrides,
    };
}
function makeContract(overrides = {}) {
    return {
        id: 'capability:claim-evaluation',
        name: 'Evaluate Claim',
        description: 'd',
        inputs: [],
        outputs: [],
        requiredPermissions: [],
        determinism: 'deterministic',
        rules: [makeRule()],
        confidence: 0.9,
        sourceRefs: [],
        sourceXoirNodeIds: ['capability:claim-evaluation', 'decision:1'],
        ...overrides,
    };
}
test('resolves a single-rule contract to a deterministic_rule binding', () => {
    const resolver = new StructuredComparisonBindingResolver();
    const outcome = resolver.resolve(makeContract());
    assert.equal(outcome?.status, 'resolved');
    if (outcome?.status !== 'resolved')
        return;
    assert.equal(outcome.binding.implementationClass, 'deterministic_rule');
});
test('the resolved evaluator matches the rule and returns its outcome verbatim', () => {
    const resolver = new StructuredComparisonBindingResolver();
    const outcome = resolver.resolve(makeContract());
    assert.equal(outcome?.status, 'resolved');
    if (outcome?.status !== 'resolved' || !outcome.binding.evaluate)
        return;
    const result = outcome.binding.evaluate({ claimed_loss_amount: 15000 });
    assert.equal(result.ok, true);
    if (!result.ok)
        return;
    assert.deepEqual(result.value, { matched: true, ruleSourceNodeId: 'decision:1', outcome: 'deny the claim' });
});
test('the resolved evaluator reports no match when no rule fires', () => {
    const resolver = new StructuredComparisonBindingResolver();
    const outcome = resolver.resolve(makeContract());
    assert.equal(outcome?.status, 'resolved');
    if (outcome?.status !== 'resolved' || !outcome.binding.evaluate)
        return;
    const result = outcome.binding.evaluate({ claimed_loss_amount: 500 });
    assert.equal(result.ok, true);
    if (!result.ok)
        return;
    assert.deepEqual(result.value, { matched: false, outcome: undefined });
});
test('the resolved evaluator errors on a missing/non-numeric input field', () => {
    const resolver = new StructuredComparisonBindingResolver();
    const outcome = resolver.resolve(makeContract());
    assert.equal(outcome?.status, 'resolved');
    if (outcome?.status !== 'resolved' || !outcome.binding.evaluate)
        return;
    const result = outcome.binding.evaluate({});
    assert.equal(result.ok, false);
});
test('resolution is deterministic: resolving twice yields the same derivation', () => {
    const resolver = new StructuredComparisonBindingResolver();
    const first = resolver.resolve(makeContract());
    const second = resolver.resolve(makeContract());
    assert.equal(first?.status, 'resolved');
    assert.equal(second?.status, 'resolved');
    if (first?.status !== 'resolved' || second?.status !== 'resolved')
        return;
    assert.deepEqual(first.binding.derivation, second.binding.derivation);
});
test('a rule with an exception clause makes the whole contract unresolved, not partially resolved', () => {
    const resolver = new StructuredComparisonBindingResolver();
    const contract = makeContract({ rules: [makeRule({ exceptionConditions: ['the claimant is a first responder'] })] });
    const outcome = resolver.resolve(contract);
    assert.equal(outcome?.status, 'unresolved');
});
test('a rule whose condition does not match the grammar is unresolved', () => {
    const resolver = new StructuredComparisonBindingResolver();
    const contract = makeContract({ rules: [makeRule({ condition: 'the claim was filed in good faith' })] });
    const outcome = resolver.resolve(contract);
    assert.equal(outcome?.status, 'unresolved');
});
test('a contract with no rules is unresolved', () => {
    const resolver = new StructuredComparisonBindingResolver();
    const outcome = resolver.resolve(makeContract({ rules: [] }));
    assert.equal(outcome?.status, 'unresolved');
});
test('a contract explicitly marked non_deterministic is denied, not silently attempted', () => {
    const resolver = new StructuredComparisonBindingResolver();
    const outcome = resolver.resolve(makeContract({ determinism: 'non_deterministic' }));
    assert.equal(outcome?.status, 'denied');
});
test('a declared input restricts field-phrase matching to that exact input', () => {
    const resolver = new StructuredComparisonBindingResolver();
    const contract = makeContract({ inputs: [{ name: 'claimed loss amount', description: 'USD amount claimed' }] });
    const outcome = resolver.resolve(contract);
    assert.equal(outcome?.status, 'resolved');
});
test('a rule field phrase not matching any declared input is unresolved', () => {
    const resolver = new StructuredComparisonBindingResolver();
    const contract = makeContract({ inputs: [{ name: 'policy number', description: 'the policy id' }] });
    const outcome = resolver.resolve(contract);
    assert.equal(outcome?.status, 'unresolved');
});
test('resolveCapabilityBinding returns unresolved with no resolvers configured', () => {
    const outcome = resolveCapabilityBinding(makeContract(), []);
    assert.equal(outcome.status, 'unresolved');
});
test('resolveCapabilityBinding delegates to the configured resolver', () => {
    const outcome = resolveCapabilityBinding(makeContract(), [new StructuredComparisonBindingResolver()]);
    assert.equal(outcome.status, 'resolved');
});
//# sourceMappingURL=binding-resolution.test.js.map