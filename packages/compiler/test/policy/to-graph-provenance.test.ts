// UW-1: a policy rule whose sentence cannot be located in any source unit must not be given invented evidence. Before UW-1 it was
// attributed to the first unit of the first document, page 1, at confidence 0.9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnresolvedProvenance, policyReasoningNodes } from '../../src/policy/to-graph.js';
import type { PolicyProgram } from '../../src/policy/program.js';
import type { ExperienceDocument } from '../../src/semantic/types.js';

function doc(path: string, unitId: string, content: string): ExperienceDocument {
  return {
    documentPath: path,
    documentTitle: undefined,
    units: [{ id: unitId, title: 't', content, provenance: { documentPath: path, pages: [3], sectionPath: ['Claims'] } }],
    relationshipGraph: { nodes: [], edges: [] },
  } as unknown as ExperienceDocument;
}

function program(sentence: string): PolicyProgram {
  return {
    title: 'Refund policy',
    facts: [],
    kinds: [],
    invariants: [],
    prohibitions: [],
    reviewOrder: [],
    steps: [
      {
        id: 's1',
        order: 1,
        note: '',
        kind: 'gate',
        when: 'amount > 500',
        outcome: { decision: 'escalate', target: 'finance', reason: 'large refund' },
        source: { sentence, rule: 'R1', section: 'Claims' },
        origin: 'extracted',
      },
    ],
  } as unknown as PolicyProgram;
}

const RULE = 'Refunds above 500 must be escalated to finance before payment.';

test('a located rule keeps its real unit, pages and section', () => {
  const docs = [doc('policy.pdf', 'unit-7', `Intro. ${RULE} Other text.`)];
  const [n] = policyReasoningNodes(program(RULE), docs);
  assert.ok(n);
  const p = n.provenance[0]!;
  assert.equal(p.experienceUnitId, 'unit-7');
  assert.deepEqual(p.pages, [3]);
  assert.equal(isUnresolvedProvenance(p), false);
  assert.equal(n.metadata['evidenceResolution'], undefined);
  assert.equal(n.metadata['evidence'], RULE, 'the evidence sentence is kept');
});

test('an unlocated rule is marked unresolved: no invented unit, no invented page, source confidence 0', () => {
  const docs = [doc('a.pdf', 'unit-1', 'Something unrelated.'), doc('b.pdf', 'unit-2', 'Also unrelated.')];
  const [n] = policyReasoningNodes(program(RULE), docs);
  assert.ok(n);
  const p = n.provenance[0]!;
  assert.ok(isUnresolvedProvenance(p));
  assert.notEqual(p.experienceUnitId, 'unit-1', 'not attributed to the first unit of the first document');
  assert.deepEqual(p.pages, [], 'no invented page');
  assert.equal(p.confidence, 0);
  assert.equal(p.documentPath, 'unresolved', 'with several documents the source document is unknown');
  assert.equal(n.metadata['evidenceResolution'], 'unresolved', 'the node is flagged for review');
  assert.equal(n.metadata['evidence'], RULE, 'the sentence text is not overwritten by the flag');
});

test('with a single source document, an unlocated rule names that document but still no unit or page', () => {
  const [n] = policyReasoningNodes(program(RULE), [doc('only.pdf', 'unit-1', 'Unrelated.')]);
  const p = n!.provenance[0]!;
  assert.equal(p.documentPath, 'only.pdf');
  assert.ok(isUnresolvedProvenance(p));
  assert.deepEqual(p.pages, []);
});
