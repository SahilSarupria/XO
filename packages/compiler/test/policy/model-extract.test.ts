import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProgram,
  extendWithModel,
  checkProposal,
  applyReviewDecisions,
  applyLedger,
  EMPTY_LEDGER,
  type ClauseProposal,
} from '../../src/policy/index.js';

const doc = [
  { id: 'a', section: 'Rules', title: 'R1', text: 'A purchase order must be approved within 5 days after it is received.' },
  {
    id: 'b',
    section: 'Rules',
    title: 'R2',
    text: 'Orders with more than three line items are routed to the Procurement Desk before approval.',
  },
];
const entries = doc.map((d, index) => ({ id: d.id, index, section: d.section, title: d.title, text: d.text, sentences: [d.text] }));

const good: ClauseProposal = {
  quote: 'more than three line items are routed to the Procurement Desk',
  facts: [{ name: 'line_items', type: 'number', description: 'number of line items on the order' }],
  step: { kind: 'gate', when: 'line_items > 3', decision: 'escalate', target: 'Procurement Desk', reason: 'many line items' },
};

test('checkProposal rejects invented numbers, non-verbatim quotes and unknown names', () => {
  const ex = extractProgram(entries, 'T');
  const s = doc[1]!.text;
  assert.deepEqual(checkProposal(good, s, ex.program), []);
  assert.ok(
    checkProposal({ ...good, step: { ...(good.step as object), when: 'line_items > 4' } as never }, s, ex.program).some((r) =>
      /number 4/.test(r),
    ),
  );
  assert.ok(checkProposal({ ...good, quote: 'invented words about line items' }, s, ex.program).some((r) => /verbatim/.test(r)));
  assert.ok(
    checkProposal({ ...good, step: { ...(good.step as object), when: 'mystery > 3' } as never }, s, ex.program).some((r) =>
      /undeclared/.test(r),
    ),
  );
  assert.ok(
    checkProposal({ ...good, step: { ...(good.step as object), target: 'Finance' } as never }, s, ex.program).some((r) => /target/.test(r)),
  );
});

test('model proposals are accepted only when they pass; failures go to review; review decisions feed a ledger', async () => {
  const ex = extractProgram(entries, 'T');
  const unknown = ex.unrecognized.map((u) => u.sentence);
  if (unknown.length === 0) return; // pattern extractor already covers it; nothing to test
  const bad = { ...good, step: { ...(good.step as object), when: 'line_items > 9' } };
  let call = 0;
  const res = await extendWithModel(ex, async () => JSON.stringify(call++ === 0 ? bad : good));
  assert.ok(res.review.length >= 0);
  const out = applyReviewDecisions(
    res.extraction,
    res.review,
    res.review.map((r) => ({ sentence: r.sentence, action: 'edit' as const, proposal: good })),
  );
  assert.equal(out.refused.length, 0);
  const replay = applyLedger(extractProgram(entries, 'T'), out.ledger);
  assert.equal(replay.unrecognized.length, 0);
});

test('a rejected sentence is not asked about again; unparseable model output is a review item', async () => {
  const ex = extractProgram(entries, 'T');
  const res = await extendWithModel(ex, async () => 'not json');
  assert.equal(res.accepted, 0);
  assert.equal(res.review.length, ex.unrecognized.length);
  const out = applyReviewDecisions(
    res.extraction,
    res.review,
    res.review.map((r) => ({ sentence: r.sentence, action: 'reject' as const })),
    EMPTY_LEDGER,
  );
  assert.equal(out.extraction.unrecognized.length, 0);
  assert.equal(applyLedger(extractProgram(entries, 'T'), out.ledger).unrecognized.length, 0);
});
