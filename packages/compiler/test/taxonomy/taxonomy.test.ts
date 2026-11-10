import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { buildCases } from './cases.js';
import { TARGETS, type Target } from './targets.js';
import { measureCase, textLayerTier, type CaseResult } from './harness.js';
import { renderReport } from './report.js';

const results: CaseResult[] = [];

function meets(r: CaseResult, t: Target): string[] {
  const misses: string[] = [];
  const wantOpen = t.refusedWith === undefined && t.opened !== false;
  if (wantOpen && !r.opened) misses.push(`did not open (${r.errorCode ?? 'no error code'})`);
  if (!wantOpen && t.opened === false && r.opened) misses.push('opened but was expected to fail');
  if (t.refusedWith !== undefined) {
    if (r.opened) misses.push('opened but was expected to be refused');
    else if (r.errorCode !== t.refusedWith) misses.push(`refused with ${r.errorCode}, expected ${t.refusedWith}`);
  }
  if (t.minWordF1 !== undefined && (r.wordF1 ?? 0) < t.minWordF1) misses.push(`wordF1 ${r.wordF1 ?? 0} < ${t.minWordF1}`);
  if (t.minSequence !== undefined && r.sequenceScore !== undefined && r.sequenceScore < t.minSequence)
    misses.push(`sequence ${r.sequenceScore} < ${t.minSequence}`);
  if (t.allPagesFlagged === true && !(r.opened && r.pagesFlaggedForRecovery === r.pages && r.pages > 0))
    misses.push(`flagged ${r.pagesFlaggedForRecovery}/${r.pages} pages for recovery`);
  if (t.minPagesWithText !== undefined && r.pagesWithText < t.minPagesWithText)
    misses.push(`${r.pagesWithText} pages with text < ${t.minPagesWithText}`);
  if (t.maxUnaccounted !== undefined && r.unaccountedPages > t.maxUnaccounted)
    misses.push(`${r.unaccountedPages} unaccounted pages > ${t.maxUnaccounted}`);
  if (t.maxMs !== undefined && r.ms > t.maxMs) misses.push(`${Math.round(r.ms)} ms > ${t.maxMs} ms`);
  return misses;
}

const cases = buildCases();

test('taxonomy: every case has a target and a unique id', () => {
  const ids = new Set<string>();
  for (const c of cases) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.ok(TARGETS[c.id] !== undefined, `case ${c.id} has no target`);
  }
  for (const id of Object.keys(TARGETS)) assert.ok(ids.has(id), `target ${id} has no case`);
  assert.ok(cases.length >= 40, `taxonomy has ${cases.length} cases`);
});

for (const c of cases) {
  test(`taxonomy[text-layer]: ${c.id}`, { timeout: 120_000 }, async () => {
    const bytes = c.build();
    assert.deepEqual(Buffer.from(c.build()), Buffer.from(bytes), 'generator is deterministic');
    const r = await measureCase(c, textLayerTier, bytes);
    results.push(r);
    // Invariants that hold for EVERY case, with no exceptions and no knownGap escape hatch.
    assert.equal(r.forbiddenLeak, false, 'inert content must never reach extracted text');
    assert.equal(r.silentGarbage, false, 'unreadable text must be flagged, never returned as ordinary text');
    const target = TARGETS[c.id]!;
    const misses = meets(r, target);
    if (target.knownGap !== undefined) {
      assert.ok(misses.length > 0, `KNOWN GAP FIXED: remove knownGap from ${c.id} (${target.knownGap})`);
    } else {
      assert.deepEqual(misses, [], `${c.id} missed its target`);
    }
  });
}

test('taxonomy: write report when XO_TAXONOMY_REPORT is set', () => {
  const out = process.env.XO_TAXONOMY_REPORT;
  if (out === undefined || out === '') return;
  writeFileSync(
    out,
    renderReport(
      results.sort((a, b) => a.id.localeCompare(b.id)),
      TARGETS,
    ),
  );
});
