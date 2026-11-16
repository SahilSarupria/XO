/**
 * UW-7 (ADR 0033) — effect class and typed outputs are derived from the contract (and, for an external capability, the operator's
 * binding), fail closed, and never change a contract's content hash.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeContractContentHash,
  contractEffectOf,
  contractOutputSchema,
  mayChangeTheWorld,
  type SemanticCapabilityContract,
} from '../src/index.js';

const base: SemanticCapabilityContract = {
  id: 'cap:1',
  name: 'Check eligibility',
  description: 'd',
  inputs: [{ name: 'amount', description: '', semanticType: 'number', required: true, derivedFrom: 'declared' }],
  outputs: [{ name: 'eligible', description: '', semanticType: 'boolean', derivedFrom: 'declared' }],
  requiredPermissions: [],
  determinism: 'deterministic',
  rules: [{ sourceNodeId: 'n1', kind: 'constraint', condition: 'amount <= 1000', exceptionConditions: [], confidence: 0.9 }],
  actionKnowledgeRefs: [],
  confidence: 0.9,
  sourceRefs: [],
  sourceXoirNodeIds: [],
};

describe('effect class', () => {
  it('rules only: none; a human task: human; a binding decides for an external capability', () => {
    assert.equal(contractEffectOf(base).class, 'none');
    const human = {
      ...base,
      rules: [],
      humanTask: {
        origin: 'procedure-step',
        instruction: 'Sign',
        actorRole: { value: 'clerk', derivation: 'stated' },
        requiredInputs: [],
        outcomeSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
      },
    } as unknown as SemanticCapabilityContract;
    assert.equal(contractEffectOf(human).class, 'human');
    const bound = contractEffectOf({ ...base, rules: [] }, { sideEffect: 'irreversible', connector: 'mail', operation: 'send' });
    assert.deepEqual([bound.class, bound.derivation], ['irreversible', 'binding']);
    assert.match(bound.reason, /mail\.send/);
  });

  it('an action described in prose with no binding is unknown, and unknown counts as a write', () => {
    const prose = { ...base, rules: [], actionKnowledgeRefs: [{ sourceNodeId: 'a', subtype: 'notify' }] } as SemanticCapabilityContract;
    assert.equal(contractEffectOf(prose).class, 'unknown');
    assert.equal(contractEffectOf({ ...base, rules: [] }).class, 'unknown');
    assert.equal(mayChangeTheWorld('unknown'), true);
    assert.equal(mayChangeTheWorld('write'), true);
    assert.equal(mayChangeTheWorld('none'), false);
    assert.equal(mayChangeTheWorld('read'), false);
    assert.equal(mayChangeTheWorld('human'), false);
  });

  it('is derived, so the content hash is unchanged', () => {
    const before = computeContractContentHash(base);
    contractEffectOf(base);
    contractOutputSchema(base);
    assert.equal(computeContractContentHash(base), before);
  });
});

describe('typed outputs', () => {
  it('declared outputs keep their type; untyped ones are named, not guessed', () => {
    const s = contractOutputSchema({
      ...base,
      outputs: [...base.outputs, { name: 'note', description: '', derivedFrom: 'inferred' }],
    });
    assert.deepEqual(s.properties, { eligible: { type: 'boolean' }, note: { type: 'unknown' } });
    assert.equal(s.typed, false);
    assert.deepEqual(s.untyped, ['note']);
  });

  it("a human task's outcome schema is part of the outputs; a contradiction is unknown", () => {
    const s = contractOutputSchema({
      ...base,
      outputs: [{ name: 'done', description: '', semanticType: 'string', derivedFrom: 'declared' }],
      humanTask: {
        origin: 'procedure-step',
        instruction: 'Sign',
        actorRole: { value: 'clerk', derivation: 'stated' },
        requiredInputs: [],
        outcomeSchema: { type: 'object', properties: { done: { type: 'boolean' }, comment: { type: 'string' } }, required: ['done'] },
      },
    } as unknown as SemanticCapabilityContract);
    assert.deepEqual(s.properties, { comment: { type: 'string' }, done: { type: 'unknown' } });
    assert.deepEqual(s.required, ['done']);
    assert.equal(contractOutputSchema(base).typed, true);
  });
});
