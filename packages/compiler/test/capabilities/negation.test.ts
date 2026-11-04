import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleBasedCapabilityExtractor } from '../../src/capabilities/rule-based-extractor.js';
import { candidateIsNegated, extractProhibitions, isNegatedAt } from '../../src/capabilities/negation.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';
import type { KnowledgeGraph } from '../../src/knowledge/types.js';

const unit = (content: string): ExperienceUnit =>
  ({
    id: 'u' as ExperienceUnit['id'],
    title: 'Untitled',
    headingTitle: undefined,
    semanticType: 'general',
    content,
    provenance: { documentPath: 'd.pdf', pages: [1], sectionPath: ['S'], blockProvenance: [], blockIndexRange: [0, 0] },
    hierarchy: { depth: 0, parentUnitId: undefined, siblingUnitIds: [] },
    confidence: 0.9,
    relationships: [],
    documentReferences: [],
    metadata: {},
  }) as ExperienceUnit;
const graph: KnowledgeGraph = { nodes: [], edges: [] };
const names = async (text: string): Promise<string[]> => {
  const r = await new RuleBasedCapabilityExtractor().extract(unit(text), graph);
  assert.ok(r.ok);
  return r.ok ? r.value.capabilities.map((c) => c.name) : [];
};

test('P0.9A: "Do not … create a missing receipt" is not read as the capability "Create a missing receipt"', async () => {
  const got = await names('Do not accept a claim form that is incomplete or create a missing receipt on the customer’s behalf.');
  assert.ok(!got.some((n) => /^Create\b/i.test(n)), JSON.stringify(got));
});

test('P0.9A: "Never promise what the policy or insurer has not confirmed" yields no "Confirm" capability', async () => {
  const got = await names('Never promise what the policy or insurer has not confirmed.');
  assert.ok(!got.some((n) => /^Confirm\b/i.test(n)), JSON.stringify(got));
});

test('affirmative instructions are unchanged', async () => {
  assert.ok((await names('Send the notice to all parties within five days.')).some((n) => /^Send\b/.test(n)));
  assert.ok((await names('The Receiving Party shall notify the Disclosing Party immediately.')).some((n) => /^Notify\b/.test(n)));
});

test('a negator ends at the clause break: the instruction after "; instead," is still an action', async () => {
  const got = await names('Do not create a missing receipt; instead notify the claimant immediately.');
  assert.ok(!got.some((n) => /^Create\b/.test(n)));
  assert.ok(
    got.some((n) => /^Notify\b/.test(n)),
    JSON.stringify(got),
  );
});

test('negation scope', () => {
  const w = 'Do not create or edit receipts, but send the form'.split(' ');
  assert.equal(isNegatedAt(w, 2), true); // create
  assert.equal(isNegatedAt(w, 4), true); // edit — "or" does not end the clause
  assert.equal(isNegatedAt(w, 8), false); // send — after the comma and "but"
  assert.equal(isNegatedAt("Don't send the form".split(' '), 1), true);
});

test('model-proposed candidates are checked against the sentence they came from', () => {
  assert.equal(candidateIsNegated('Never promise what the policy has not confirmed', 'Confirm Action'), true);
  assert.equal(candidateIsNegated('Confirm the claim number with the claimant', 'Confirm claim number'), false);
});

test('prohibitions are extracted verbatim so they can be kept as safety constraints', () => {
  const p = extractProhibitions(['Do not create a missing receipt.', 'Send the form.', 'Staff must not disclose the fraud screen result.']);
  assert.deepEqual(
    p.map((x) => x.predicate),
    ['create a missing receipt', 'disclose the fraud screen result'],
  );
});
