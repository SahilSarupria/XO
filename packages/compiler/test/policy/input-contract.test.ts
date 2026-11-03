import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInputContract, bindWithMapping, mappingQuestions, suggestMapping, type PolicyProgram } from '../../src/policy/index.js';

const src = { rule: '', section: '', sentence: 'A claim with 2 or more prior claims goes to SIU.' };
const program: PolicyProgram = {
  title: 't',
  facts: [
    { name: 'prior_claims', type: 'boolean', description: 'true if the policyholder has 2 or more prior claims' },
    { name: 'claim_type', type: 'string', enum: ['collision', 'glass'], description: 'type of claim' },
    { name: 'days_to_report', type: 'number', description: 'days after the loss', derivable: true },
    { name: 'deductible', type: 'number', description: 'defined by a step, not an input' },
  ],
  steps: [
    {
      id: 'g1',
      order: 1,
      kind: 'gate',
      when: 'prior_claims == true',
      outcome: { decision: 'escalate', target: 'SIU', reason: 'R' },
      note: '',
      source: src,
      origin: 'pattern',
    },
    {
      id: 'a1',
      order: 2,
      kind: 'assign',
      set: { deductible: "claim_type == 'glass' ? 250 : 500" },
      note: '',
      source: src,
      origin: 'pattern',
    },
    {
      id: 'g2',
      order: 3,
      kind: 'gate',
      when: 'days_to_report > 30',
      outcome: { decision: 'deny', reason: 'LATE' },
      note: '',
      source: src,
      origin: 'pattern',
    },
  ],
  kinds: [],
  invariants: [],
  prohibitions: [],
  reviewOrder: [],
};

test('contract lists exactly the inputs the rules read, with how each is obtained', () => {
  const c = buildInputContract(program);
  assert.deepEqual(
    c.inputs.map((i) => [i.name, i.how]),
    [
      ['prior_claims', 'case_field'],
      ['claim_type', 'classified'],
      ['days_to_report', 'derived_from_text'],
    ],
  );
  assert.ok(c.inputs[0]!.usedBy[0]!.includes('SIU'));
});

test('binding follows the operator mapping only; wrong types and disallowed values are reported, never coerced', () => {
  const c = buildInputContract(program);
  const map = {
    prior_claims: { field: 'claims_12m', transform: { atLeast: 2 } },
    claim_type: { field: 'type', transform: 'lowercase' as const },
    days_to_report: { field: 'days', transform: 'number' as const },
  };
  const ok = bindWithMapping(c, map, { claims_12m: 3, type: 'GLASS', days: '12' });
  assert.deepEqual(ok.facts, { prior_claims: true, claim_type: 'glass', days_to_report: 12 });
  const bad = bindWithMapping(c, map, { claims_12m: 0, type: 'boat', days: 'soon' });
  assert.deepEqual(
    bad.invalid.map((i) => i.input),
    ['claim_type'],
  );
  assert.deepEqual(bad.missing, ['days_to_report']);
  assert.equal(bindWithMapping(c, {}, { claims_12m: 3 }).missing.length, 3);
});

test('unmapped inputs become blocking questions with a suggested field a person must confirm', () => {
  const c = buildInputContract(program);
  const sug = suggestMapping(c, ['claim_type', 'days_to_report_loss', 'policy_number']);
  assert.ok(sug.some((s) => s.input === 'claim_type' && s.field === 'claim_type'));
  const qs = mappingQuestions(c, { claim_type: { field: 'claim_type' } }, sug);
  assert.deepEqual(
    qs.map((q) => q.subject),
    ['prior_claims', 'days_to_report'],
  );
  assert.ok(qs.every((q) => q.blocking && q.kind === 'map_input'));
});
