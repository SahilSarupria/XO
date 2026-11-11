import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { parseEffectiveDate } from '../../src/pipeline/cross-document.js';

// Domain-neutral wording. Conflicts are surfaced; they are resolved ONLY by an explicit precedence policy.
const doc = (text: string, sourcePath: string) => ({ kind: 'document' as const, text: `# Rules\n${text}\n`, sourcePath });

async function analyze(sources: ReturnType<typeof doc>[], options = {}) {
  const r = await compileSources(sources, options);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('compile failed');
  return r.value;
}

test('the same condition with different outcomes across two sources is a definite conflict, unresolved without a policy', async () => {
  const v = await analyze([
    doc('If the widget count exceeds 10, the request must be rejected.', 'base.md'),
    doc('If the widget count exceeds 10, manager approval is required.', 'addendum.md'),
  ]);
  const c = v.crossDocument!.conflicts;
  assert.equal(c.length, 1);
  assert.equal(c[0]!.kind, 'identical-condition');
  assert.equal(c[0]!.scope, 'cross-source');
  assert.equal(c[0]!.resolution.status, 'unresolved');
  assert.ok(v.diagnostics.some((d) => d.code === 'crossdoc/conflict' && d.severity === 'warning'));
});

test('an explicit precedence order resolves the conflict and names the winner; it never silently picks otherwise', async () => {
  const sources = [
    doc('If the widget count exceeds 10, the request must be rejected.', 'base.md'),
    doc('If the widget count exceeds 10, manager approval is required.', 'addendum.md'),
  ];
  const v = await analyze(sources, { precedence: { order: ['addendum.md', 'base.md'] } });
  const r = v.crossDocument!.conflicts[0]!.resolution;
  assert.equal(r.status, 'resolved-by-precedence');
  assert.equal(r.status === 'resolved-by-precedence' ? r.winner : '', 'addendum.md');
  assert.equal(v.diagnostics.some((d) => d.code === 'crossdoc/conflict' && d.severity === 'warning'), false);
});

test('overlapping numeric ranges on the same field with different outcomes are flagged as a potential conflict', async () => {
  const v = await analyze([
    doc('If the widget count exceeds 5, approve the request.', 'a.md'),
    doc('If the widget count exceeds 8, the request must be rejected.', 'b.md'),
  ]);
  assert.ok(v.crossDocument!.conflicts.some((c) => c.kind === 'overlapping-range'));
});

test('disjoint ranges, or identical outcomes, are not conflicts', async () => {
  const disjoint = await analyze([
    doc('If the widget count is less than 5, approve the request.', 'a.md'),
    doc('If the widget count exceeds 8, the request must be rejected.', 'b.md'),
  ]);
  assert.equal(disjoint.crossDocument!.conflicts.length, 0);
  const same = await analyze([
    doc('If the widget count exceeds 5, the request must be rejected.', 'a.md'),
    doc('If the widget count exceeds 8, the request must be rejected.', 'b.md'),
  ]);
  assert.equal(same.crossDocument!.conflicts.length, 0);
});

test('different fields never conflict, even with overlapping numbers', async () => {
  const v = await analyze([doc('If the widget count exceeds 5, approve the request.', 'a.md'), doc('If the gadget count exceeds 5, the request must be rejected.', 'b.md')]);
  assert.equal(v.crossDocument!.conflicts.length, 0);
});

test('a conflict inside ONE source is reported with scope within-source', async () => {
  const v = await analyze([doc('If the widget count exceeds 10, approve the request.\nIf the widget count exceeds 10, the request must be rejected.', 'one.md')]);
  assert.equal(v.crossDocument!.conflicts[0]?.scope, 'within-source');
});

test('supersession / amendment wording is detected with its cue and effective date', async () => {
  const v = await analyze([doc('This addendum supersedes clause 4.2 of the base agreement, effective from 1 March 2026.\nThe operator must log each event.', 'add.md')]);
  const a = v.crossDocument!.amendments;
  assert.equal(a.length, 1);
  assert.equal(a[0]!.cue, 'supersedes');
  assert.equal(a[0]!.effectiveDate, '2026-03-01');
  assert.ok(v.diagnostics.some((d) => d.code === 'crossdoc/amendment'));
});

test('effective-date parsing handles common forms and refuses anything ambiguous', () => {
  assert.equal(parseEffectiveDate('effective from 1 March 2026'), '2026-03-01');
  assert.equal(parseEffectiveDate('with effect from March 1, 2026'), '2026-03-01');
  assert.equal(parseEffectiveDate('effective on 2026-03-01'), '2026-03-01');
  assert.equal(parseEffectiveDate('effective as of 31 December 2026.'), '2026-12-31');
  assert.equal(parseEffectiveDate('effective 03/04/2026'), undefined); // dd/mm vs mm/dd is ambiguous: never guessed
  assert.equal(parseEffectiveDate('effective from 31 February 2026'), undefined); // not a real date
  assert.equal(parseEffectiveDate('the policy is effective'), undefined);
});

test('conflicts and amendments reach the review queue; single clean sources produce neither', async () => {
  const v = await analyze([doc('If the widget count exceeds 10, the request must be rejected.', 'a.md'), doc('If the widget count exceeds 10, manager approval is required.', 'b.md')]);
  assert.ok(v.reviewQueue!.items.some((i) => i.kind === 'conflict' && i.priority === 1));
  const clean = await analyze([doc('If the widget count exceeds 10, the operator must log the event.', 'a.md')]);
  assert.equal(clean.crossDocument!.conflicts.length + clean.crossDocument!.amendments.length, 0);
});
