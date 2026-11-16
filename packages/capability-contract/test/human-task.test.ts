/** PX-5 — one human-task contract rule for procedure steps and prose actions (ADR 0029 decision 11, gap PX-G17). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionEscalationBindingResolver,
  computeContractContentHash,
  humanTaskContractOf,
  procedureStepHumanTask,
  type SemanticCapabilityContract,
} from '../src/index.js';

const base: SemanticCapabilityContract = {
  id: 'cap_1',
  name: 'Pull latest code',
  description: 'Pull the latest code from the main branch.',
  inputs: [{ name: 'branch', description: '', derivedFrom: 'declared' }],
  outputs: [{ name: 'commit', description: '', derivedFrom: 'declared' }],
  requiredPermissions: [],
  determinism: 'unknown',
  rules: [],
  actionKnowledgeRefs: [],
  confidence: 0.8,
  sourceRefs: [],
  sourceXoirNodeIds: ['cap_1'],
};
const stepMeta = {
  understanding: 'manual-step',
  'step.actions': 'Pull the latest code from the main branch.',
  'step.doneWhen': 'The build is green.',
  'step.owner': 'Release engineer',
};

test('a procedure step and a prose action with the same evidence both resolve to a human task; neither without one', () => {
  const resolver = new ActionEscalationBindingResolver();
  const step = { ...base, humanTask: procedureStepHumanTask(stepMeta, base.description, base.inputs, base.outputs)! };
  const prose = { ...base, actionKnowledgeRefs: [{ sourceNodeId: 'concept_1', subtype: 'action' }] };
  for (const c of [step, prose]) {
    const outcome = resolver.resolve(c);
    assert.equal(outcome?.status, 'resolved');
    if (outcome?.status === 'resolved') assert.equal(outcome.binding.implementationClass, 'human_in_the_loop');
  }
  assert.equal(resolver.resolve(base), undefined, 'no task contract: not resolved by this rule');
  assert.equal(humanTaskContractOf(base), undefined);
});

test('the procedure step contract carries the instruction, done-when, stated role, inputs and an outcome schema', () => {
  const t = procedureStepHumanTask(stepMeta, base.description, base.inputs, base.outputs)!;
  assert.equal(t.origin, 'procedure-step');
  assert.equal(t.instruction, 'Pull the latest code from the main branch.');
  assert.equal(t.doneWhen, 'The build is green.');
  assert.deepEqual(t.actorRole, { value: 'Release engineer', derivation: 'stated' });
  assert.deepEqual(t.requiredInputs, ['branch']);
  assert.deepEqual(t.outcomeSchema, {
    type: 'object',
    properties: { completed: { type: 'boolean' }, commit: { type: 'string' } },
    required: ['completed'],
  });
  const prose = humanTaskContractOf({ ...base, actionKnowledgeRefs: [{ sourceNodeId: 'c', subtype: 'process' }] })!;
  assert.deepEqual(prose.actorRole, { value: 'unassigned', derivation: 'unassigned' });
});

test('no task contract for a non-step, a suspected extraction error, an empty instruction, or a contract with rules', () => {
  assert.equal(procedureStepHumanTask(undefined, 'x', [], []), undefined);
  assert.equal(procedureStepHumanTask({ understanding: 'other' }, 'x', [], []), undefined);
  assert.equal(procedureStepHumanTask({ ...stepMeta, 'quality.review': 'possible-extraction-error' }, 'x', [], []), undefined);
  assert.equal(procedureStepHumanTask({ understanding: 'manual-step' }, '  ', [], []), undefined);
  const withRule = {
    ...base,
    humanTask: procedureStepHumanTask(stepMeta, base.description, [], [])!,
    rules: [{ sourceNodeId: 'r', kind: 'heuristic' as const, condition: 'x > 1', outcome: 'deny', exceptionConditions: [], confidence: 1 }],
  };
  assert.equal(humanTaskContractOf(withRule), undefined);
});

test('the content hash changes only when a human task contract is present', () => {
  const plain = computeContractContentHash(base);
  assert.equal(computeContractContentHash({ ...base }), plain);
  assert.notEqual(computeContractContentHash({ ...base, humanTask: procedureStepHumanTask(stepMeta, base.description, [], [])! }), plain);
});
