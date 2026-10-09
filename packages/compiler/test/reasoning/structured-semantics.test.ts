import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStructuredSemantics } from '../../src/reasoning/structured-semantics.js';

// --- Per-nodeType source-text selection (mirrors reasoning-to-xoir.ts#buildProperties) ---

test('a "rule"/"prerequisite" node structures condition from `condition` and action from `action` (heuristic dispatch)', () => {
  const result = buildStructuredSemantics({
    nodeType: 'rule',
    condition: 'the deductible is at least 250',
    action: 'apply a penalty fee',
    exceptionConditions: [],
  });
  assert.deepEqual(result.structuredCondition, { type: 'comparison', field: 'the deductible', operator: '>=', value: 250 });
  assert.deepEqual(result.structuredAction, { type: 'action', action: 'apply', target: 'a penalty fee' });
});

test('a "decision" node structures condition from `condition` and action from `outcome` (decision_node dispatch)', () => {
  const result = buildStructuredSemantics({
    nodeType: 'decision',
    condition: 'the claim assessment amount exceeds 10000',
    outcome: 'deny the claim',
    exceptionConditions: [],
  });
  assert.deepEqual(result.structuredCondition, { type: 'comparison', field: 'the claim assessment amount', operator: '>', value: 10000 });
  assert.deepEqual(result.structuredAction, { type: 'action', action: 'deny', target: 'the claim' });
});

test('a "prohibition"/"policy" node structures condition from `action` (constraint dispatch — no separate action slot), never from an unset `outcome`', () => {
  const result = buildStructuredSemantics({
    nodeType: 'prohibition',
    action: 'Terrorism cover is excluded',
    exceptionConditions: [],
  });
  assert.deepEqual(result.structuredCondition, { type: 'categorical', field: 'Terrorism cover', operator: '==', value: 'excluded' });
  assert.equal(result.structuredAction, undefined);
});

test('a "prerequisite"/"policy" constraint node falls back to `condition` when `action` is absent, matching buildProperties\' `node.action ?? node.condition` precedence exactly', () => {
  const result = buildStructuredSemantics({
    nodeType: 'policy',
    condition: 'the policy is not active',
    exceptionConditions: [],
  });
  assert.deepEqual(result.structuredCondition, { type: 'categorical', field: 'the policy', operator: '!=', value: 'active' });
});

test('an "exception" node (maps to heuristic, per canonicalKindForReasoningNodeType) structures the same way as "rule"', () => {
  const result = buildStructuredSemantics({
    nodeType: 'exception',
    condition: 'the claim status is approved',
    action: 'waive the deductible',
    exceptionConditions: [],
  });
  assert.deepEqual(result.structuredCondition, { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' });
  assert.deepEqual(result.structuredAction, { type: 'action', action: 'waive', target: 'the deductible' });
});

test('an out-of-scope canonical kind (justification/escalation/risk_threshold) never structures — no XOIR slot exists for these kinds', () => {
  const justification = buildStructuredSemantics({ nodeType: 'justification', condition: 'the claim status is approved', exceptionConditions: [] });
  assert.deepEqual(justification, {});

  const escalation = buildStructuredSemantics({ nodeType: 'escalation', condition: 'the claim amount exceeds 50000', exceptionConditions: [] });
  assert.deepEqual(escalation, {});

  const risk = buildStructuredSemantics({ nodeType: 'risk_threshold', condition: 'the risk score exceeds 80', exceptionConditions: [] });
  assert.deepEqual(risk, {});
});

// --- Precision: unresolved text never invents structure ---

test('text with no supported shape produces no structuredCondition/structuredAction at all — object stays empty, never a partial guess', () => {
  const result = buildStructuredSemantics({
    nodeType: 'policy',
    action: 'there is 24 hours security in the premises',
    exceptionConditions: [],
  });
  assert.deepEqual(result, {});
});

test('a real burglary-policy.pdf extraction artifact ("valid" as a standalone action) is left unstructured, condition still structures independently', () => {
  const result = buildStructuredSemantics({
    nodeType: 'rule',
    condition: 'any of the information provided is incorrect',
    action: 'valid',
    exceptionConditions: [],
  });
  assert.deepEqual(result.structuredCondition, { type: 'categorical', field: 'any of the information provided', operator: '==', value: 'incorrect' });
  assert.equal(result.structuredAction, undefined);
});

// --- Exceptions ---

test('exceptionConditions are structured best-effort, one entry per raw exception, in order', () => {
  const result = buildStructuredSemantics({
    nodeType: 'rule',
    condition: 'cancel the order',
    action: 'cancel the order',
    exceptionConditions: ['the customer has a premium subscription', 'the claim status is approved'],
  });
  assert.deepEqual(result.structuredExceptions, [
    { raw: 'the customer has a premium subscription' }, // "premium subscription" is out of the closed categorical vocabulary — correctly left unresolved
    { raw: 'the claim status is approved', condition: { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' } },
  ]);
});

test('no exceptionConditions means structuredExceptions is absent entirely, never an empty array', () => {
  const result = buildStructuredSemantics({ nodeType: 'rule', condition: 'the claim status is approved', exceptionConditions: [] });
  assert.equal(result.structuredExceptions, undefined);
});
