import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { diffPrograms, ledgerStatus, manualRevision, staleRulingQuestions } from '../../src/policy/index.js';

const v1 = `# Desk

## Rules

**R1.** Any claim in which someone was hurt is referred to the Casualty Unit.

**R2.** A claim above $5,000 needs Director approval.

**R3.** Anyone with 3 or more rejected reports in the last 90 days is referred to the Finance Manager.
`;
const v2 = v1
  .replace('$5,000', '$7,500')
  .replace('Casualty Unit', 'Casualty Team')
  .replace(/\*\*R3\.\*\*.*\n/, '');

async function program(text: string) {
  const r = await compileSources([{ kind: 'document', text, title: 'Desk', sourcePath: 'd.md' }], {});
  if (!r.ok || r.value.policy === undefined) throw new Error('compile failed');
  return r.value.policy.program;
}

test('a revised manual shows changed numbers, changed targets and removed rules — not a silent recompile', async () => {
  const d = diffPrograms(await program(v1), await program(v2));
  assert.equal(d.behaviourChanged, true);
  const money = d.changes.find((c) => c.numbers?.length);
  assert.ok(money && money.numbers![0]!.includes('$5,000') && money.numbers![0]!.includes('$7,500'));
  assert.ok(d.changes.some((c) => c.kind === 'removed' && /rejected reports/.test(c.before ?? '')));
  assert.ok(d.changes.some((c) => c.before?.includes('Casualty Unit') && c.after?.includes('Casualty Team')));
});

test('an unchanged manual diffs to nothing, and the revision id is whitespace-insensitive', async () => {
  const p = await program(v1);
  const d = diffPrograms(p, p);
  assert.deepEqual([d.changes.length, d.behaviourChanged], [0, false]);
  assert.equal(manualRevision(v1), manualRevision(v1.replace(/\n\n/g, '\n\n\n')));
  assert.notEqual(manualRevision(v1), manualRevision(v2));
});

test('rulings on sentences that changed become re-confirmation questions; others carry over', () => {
  const ledger = {
    accepted: [
      {
        sentence: 'A claim above $5,000 needs Director approval.',
        proposal: { quote: 'x', facts: [], step: { kind: 'assign' as const, set: {} } },
      },
      { sentence: 'Alcohol is never reimbursable.', proposal: { quote: 'y', facts: [], step: { kind: 'assign' as const, set: {} } } },
    ],
    rejected: [{ sentence: 'Internal use only.' }],
  };
  const st = ledgerStatus(ledger, [
    'A claim above $7,500 needs Director approval.',
    'Alcohol is never reimbursable.',
    'Internal use only.',
  ]);
  assert.deepEqual(
    st.current.accepted.map((a) => a.sentence),
    ['Alcohol is never reimbursable.'],
  );
  assert.equal(st.current.rejected.length, 1);
  assert.equal(st.stale.length, 1);
  assert.equal(st.stale[0]!.nearest, 'A claim above $7,500 needs Director approval.');
  const qs = staleRulingQuestions(st);
  assert.match(qs[0]!.prompt, /previously ruled/);
});
