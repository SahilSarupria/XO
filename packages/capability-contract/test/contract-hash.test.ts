import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeContractContentHash } from '../src/contract-hash.js';
import type { SemanticCapabilityContract, SemanticCapabilityRule, SemanticCapabilityParameter } from '../src/types.js';

/**
 * P0.9B Step 3 — contract content hash. Pins (a) which fields are and are
 * not part of the hash, and (b) the deterministic-serialization/ordering
 * behavior the hash relies on, before anything is allowed to depend on it.
 */

const rule = (over: Partial<SemanticCapabilityRule> = {}): SemanticCapabilityRule => ({
  sourceNodeId: 'decision:1',
  kind: 'decision_node',
  condition: 'the claimed loss amount exceeds 10000',
  outcome: 'deny the claim',
  exceptionConditions: [],
  confidence: 0.9,
  ...over,
});
const param = (name: string, over: Partial<SemanticCapabilityParameter> = {}): SemanticCapabilityParameter => ({ name, description: `${name} description`, semanticType: 'number', required: true, derivedFrom: 'declared', ...over });

const contract = (over: Partial<SemanticCapabilityContract> = {}): SemanticCapabilityContract => ({
  id: 'capability:claim-evaluation',
  name: 'Evaluate Claim',
  description: 'Evaluates a claim',
  category: 'claims',
  inputs: [param('claimed_loss_amount'), param('policy_limit')],
  outputs: [param('decision', { semanticType: 'string' })],
  requiredPermissions: ['runtime.execute', 'claims.read'],
  determinism: 'deterministic',
  rules: [rule({ sourceNodeId: 'decision:1' }), rule({ sourceNodeId: 'decision:2', condition: 'the policy is lapsed', outcome: 'deny the claim' })],
  actionKnowledgeRefs: [{ sourceNodeId: 'concept:a', subtype: 'action' }, { sourceNodeId: 'concept:b', subtype: 'process' }],
  confidence: 0.8,
  sourceRefs: [{ documentPath: 'policy.pdf' }],
  sourceXoirNodeIds: ['capability:claim-evaluation', 'decision:1', 'decision:2'],
  ...over,
});

// 1
test('identical contracts produce identical hashes, in the sha256:<hex> ContentHash shape', () => {
  const a = computeContractContentHash(contract());
  const b = computeContractContentHash(contract());
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

// 2
test('a change to any included semantic field changes the hash', () => {
  const base = computeContractContentHash(contract());
  const variants: Partial<SemanticCapabilityContract>[] = [
    { name: 'Evaluate Claim v2' },
    { description: 'Different description' },
    { category: 'underwriting' },
    { determinism: 'unknown' },
    { requiredPermissions: ['runtime.execute'] },
    { inputs: [param('claimed_loss_amount')] },
    { outputs: [param('decision', { semanticType: 'number' })] },
    { actionKnowledgeRefs: [{ sourceNodeId: 'concept:a', subtype: 'action' }] },
  ];
  for (const v of variants) {
    assert.notEqual(computeContractContentHash(contract(v)), base, `expected a hash change for ${JSON.stringify(Object.keys(v))}`);
  }
});

// 3
test('provenance-only changes (sourceRefs, sourceXoirNodeIds) do not change the hash', () => {
  const base = computeContractContentHash(contract());
  assert.equal(computeContractContentHash(contract({ sourceRefs: [{ documentPath: 'other.pdf', pages: [3] }] })), base);
  assert.equal(computeContractContentHash(contract({ sourceXoirNodeIds: ['capability:claim-evaluation'] })), base);
});

// 4
test('confidence-only changes (contract-level and rule-level) do not change the hash', () => {
  const base = computeContractContentHash(contract());
  assert.equal(computeContractContentHash(contract({ confidence: 0.1 })), base);
  const lowerRuleConfidence = contract().rules.map((r) => ({ ...r, confidence: 0.2 }));
  assert.equal(computeContractContentHash(contract({ rules: lowerRuleConfidence })), base);
});

test('XOIR node-id pointers nested in rules and action refs are provenance: renaming them does not change the hash, but subtype does', () => {
  const base = computeContractContentHash(contract());
  const renamedRules = contract().rules.map((r) => ({ ...r, sourceNodeId: `renamed:${r.sourceNodeId}` }));
  const renamedRefs = contract().actionKnowledgeRefs.map((r) => ({ ...r, sourceNodeId: `renamed:${r.sourceNodeId}` }));
  assert.equal(computeContractContentHash(contract({ rules: renamedRules, actionKnowledgeRefs: renamedRefs })), base);
  const otherSubtype = contract().actionKnowledgeRefs.map((r) => ({ ...r, subtype: 'other' }));
  assert.notEqual(computeContractContentHash(contract({ actionKnowledgeRefs: otherSubtype })), base);
});

test('the id is identity, not content: a different id with identical content hashes identically', () => {
  assert.equal(computeContractContentHash(contract({ id: 'capability:other' })), computeContractContentHash(contract()));
});

// 5 — ordering normalization, one collection at a time
test('irrelevant ordering does not change the hash: rules', () => {
  const c = contract();
  assert.equal(computeContractContentHash(contract({ rules: [...c.rules].reverse() })), computeContractContentHash(c));
});
test('irrelevant ordering does not change the hash: inputs and outputs', () => {
  const c = contract({ outputs: [param('decision'), param('reason')] });
  const shuffled = contract({ inputs: [...c.inputs].reverse(), outputs: [...c.outputs].reverse() });
  assert.equal(computeContractContentHash(shuffled), computeContractContentHash(contract({ outputs: [param('decision'), param('reason')] })));
});
test('irrelevant ordering does not change the hash: actionKnowledgeRefs and requiredPermissions', () => {
  const c = contract();
  const shuffled = contract({ actionKnowledgeRefs: [...c.actionKnowledgeRefs].reverse(), requiredPermissions: [...c.requiredPermissions].reverse() });
  assert.equal(computeContractContentHash(shuffled), computeContractContentHash(c));
});
test('irrelevant ordering does not change the hash: nested object key order', () => {
  const a = contract({ rules: [rule({ structuredCondition: { kind: 'comparison', inputKey: 'x', operator: '>', value: 1 } as never })] });
  const b = contract({ rules: [rule({ structuredCondition: { value: 1, operator: '>', inputKey: 'x', kind: 'comparison' } as never })] });
  assert.equal(computeContractContentHash(a), computeContractContentHash(b));
});
test('an explicitly-undefined optional field hashes the same as an absent one', () => {
  const withUndefined = contract({ rules: [rule({ outcome: undefined })] });
  const absent = contract({ rules: [(({ outcome: _o, ...rest }) => rest)(rule())] });
  assert.equal(computeContractContentHash(withUndefined), computeContractContentHash(absent));
});
test('a missing actionKnowledgeRefs (pre-Action-Binding embedded contract) hashes the same as an empty one', () => {
  const legacy = { ...contract({ actionKnowledgeRefs: [] }) } as Partial<SemanticCapabilityContract>;
  delete legacy.actionKnowledgeRefs;
  assert.equal(computeContractContentHash(legacy as SemanticCapabilityContract), computeContractContentHash(contract({ actionKnowledgeRefs: [] })));
});

// 6 — meaningful changes must still register
test('a meaningful rule change changes the hash (condition, outcome, kind, exception conditions)', () => {
  const base = computeContractContentHash(contract());
  const changed = (r: Partial<SemanticCapabilityRule>) => computeContractContentHash(contract({ rules: [rule({ sourceNodeId: 'decision:1', ...r }), contract().rules[1]!] }));
  assert.notEqual(changed({ condition: 'the claimed loss amount exceeds 20000' }), base);
  assert.notEqual(changed({ outcome: 'approve the claim' }), base);
  assert.notEqual(changed({ kind: 'heuristic' }), base);
  assert.notEqual(changed({ exceptionConditions: ['unless the claimant is a member'] }), base);
});
test('removing or adding a rule changes the hash', () => {
  const base = computeContractContentHash(contract());
  assert.notEqual(computeContractContentHash(contract({ rules: [contract().rules[0]!] })), base);
  assert.notEqual(computeContractContentHash(contract({ rules: [...contract().rules, rule({ sourceNodeId: 'decision:3', condition: 'a third rule' })] })), base);
});
test('a meaningful input/output change (name, type, requiredness) changes the hash', () => {
  const base = computeContractContentHash(contract());
  assert.notEqual(computeContractContentHash(contract({ inputs: [param('claimed_loss_amount', { required: false }), param('policy_limit')] })), base);
  assert.notEqual(computeContractContentHash(contract({ inputs: [param('claimed_loss_amount', { semanticType: 'string' }), param('policy_limit')] })), base);
  assert.notEqual(computeContractContentHash(contract({ inputs: [param('renamed'), param('policy_limit')] })), base);
});
test('order that IS data is preserved: exceptionConditions order within a rule changes the hash', () => {
  const a = contract({ rules: [rule({ exceptionConditions: ['first', 'second'] })] });
  const b = contract({ rules: [rule({ exceptionConditions: ['second', 'first'] })] });
  assert.notEqual(computeContractContentHash(a), computeContractContentHash(b));
});
