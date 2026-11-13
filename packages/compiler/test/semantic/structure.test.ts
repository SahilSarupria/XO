/**
 * UW-3b (C, D) — document-kind routing: procedures, guidelines, checklists and forms read by structure, and policy text
 * left exactly to the existing extractors. Ends with the TaskTest.pdf definition-of-done checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileSources } from '../../src/pipeline/compile-sources.js';
import { DocumentSourceFrontend } from '../../src/sources/document-frontend.js';
import { chunkDocument } from '../../src/semantic/semantic-chunker.js';
import { cleanHeading, guidelineOf, stepColumns } from '../../src/semantic/structure.js';
import type { ExperienceDocument } from '../../src/semantic/types.js';
import type { XoirGraph } from '@xo/xoir';

async function chunk(text: string): Promise<ExperienceDocument> {
  const ingested = new DocumentSourceFrontend().ingest({ kind: 'document', text, sourcePath: 'doc.md' });
  assert.ok(ingested.ok);
  assert.ok(ingested.value.content.kind === 'document');
  return chunkDocument(ingested.value.content.parsed, 'doc.md', undefined);
}

async function compile(text: string): Promise<XoirGraph> {
  const r = await compileSources([{ kind: 'document', text, sourcePath: 'doc.md' }], { now: () => '2026-01-01T00:00:00.000Z' });
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r.value.graph;
}

const caps = (g: XoirGraph): Record<string, unknown>[] =>
  g
    .allNodes()
    .filter((n) => n.kind === 'capability')
    .map((n) => n.properties as Record<string, unknown>);
const constraints = (g: XoirGraph): Record<string, unknown>[] =>
  g
    .allNodes()
    .filter((n) => n.kind === 'constraint')
    .map((n) => ({ ...(n.properties as Record<string, unknown>), subtype: n.metadata.subtype }));

test('helpers: step-table columns, heading numbers, and the directive of a titled item', () => {
  assert.deepEqual(stepColumns(['#', 'Step', 'What to do', 'Done when']), { ordinal: 0, label: 1, action: 2, doneWhen: 3 });
  assert.deepEqual(stepColumns(['Step', 'Owner', 'Expected result']), { action: 0, doneWhen: 2, owner: 1 });
  assert.equal(stepColumns(['Coverage', 'Limit', 'Excess']), undefined);
  assert.equal(cleanHeading('3. Step-by-Step Workflow'), 'Step-by-Step Workflow');
  assert.equal(cleanHeading('4. Definition of Done (checklist)'), 'Definition of Done');
  assert.deepEqual(guidelineOf('One task, one purpose. Do not mix changes.', 'One task, one purpose', 'Do not mix changes.'), {
    directive: 'Do not mix changes.',
    title: 'One task, one purpose',
    modality: 'prohibition',
    polarity: 'negative',
  });
});

test('a numbered list of instructions is a procedure: one step capability each, in order', async () => {
  const g = await compile(
    '# Valve check\n\n## Procedure\n\n1. Open the inlet valve.\n2. Check the pressure gauge.\n3. Record the reading in the log.\n',
  );
  const steps = caps(g).filter((c) => (c['metadata'] as Record<string, string> | undefined)?.['structure.role'] === 'procedure-step');
  assert.deepEqual(steps.map((s) => s['name']).sort(), [
    'Check the pressure gauge',
    'Open the inlet valve',
    'Record the reading in the log',
  ]);
  const byId = new Map(g.allNodes().map((n) => [n.id as string, n]));
  const order = g
    .allEdges()
    .filter((e) => e.kind === 'custom:sequence')
    .map(
      (e) =>
        `${(byId.get(e.fromId as string)!.properties as Record<string, unknown>)['name']} -> ${(byId.get(e.toId as string)!.properties as Record<string, unknown>)['name']}`,
    )
    .sort();
  assert.deepEqual(order, [
    'Check the pressure gauge -> Record the reading in the log',
    'Open the inlet valve -> Check the pressure gauge',
  ]);
  assert.equal(caps(g).length, 3, 'one capability per step and nothing else');
});

test('a markdown step table becomes ordered steps with their done-when criteria', async () => {
  const g = await compile(
    '## Release workflow\n\n| # | Step | What to do | Done when |\n|---|---|---|---|\n| 1 | Prepare | Freeze the branch. Tag the build. | Tag exists |\n| 2 | Ship | Deploy the tag to production. | Smoke test passes |\n',
  );
  const steps = caps(g).filter((c) => (c['metadata'] as Record<string, string> | undefined)?.['structure.role'] === 'procedure-step');
  assert.deepEqual(
    steps
      .map((s) => [
        s['name'],
        s['description'],
        (s['metadata'] as Record<string, string>)['step.doneWhen'],
        (s['metadata'] as Record<string, string>)['step.ordinal'],
      ])
      .sort(),
    [
      ['Prepare', 'Freeze the branch. Tag the build.', 'Tag exists', '1'],
      ['Ship', 'Deploy the tag to production.', 'Smoke test passes', '2'],
    ],
  );
});

test('guidelines become constraints with modality and polarity from the language; prohibitions are blocking', async () => {
  const g = await compile(
    '## Security rules\n\n- **Never share passwords.** Use the team vault instead.\n- Always lock your screen when you leave.\n- You should rotate keys every quarter.\n',
  );
  const byRule = new Map(constraints(g).map((c) => [c['rule'], c]));
  assert.equal(byRule.get('Never share passwords')?.['modality'], 'prohibition');
  assert.equal(byRule.get('Never share passwords')?.['polarity'], 'negative');
  assert.equal(byRule.get('Never share passwords')?.['severity'], 'blocking');
  assert.equal(byRule.get('Never share passwords')?.['rationale'], 'Use the team vault instead.');
  assert.equal(byRule.get('Always lock your screen when you leave')?.['modality'], 'obligation');
  assert.equal(byRule.get('You should rotate keys every quarter')?.['modality'], 'advisory');
  assert.equal(caps(g).length, 0, 'a rule is not a capability');
});

test('checklist items become acceptance criteria (constraints), with their tick state', async () => {
  const g = await compile('## Release checklist\n\n- [ ] All tests pass\n- [x] Changelog updated\n- [ ] No debug logs left\n');
  const criteria = constraints(g).filter((c) => c['subtype'] === 'acceptance_criterion');
  assert.deepEqual(criteria.map((c) => c['rule']).sort(), ['All tests pass', 'Changelog updated', 'No debug logs left']);
  assert.ok(criteria.every((c) => c['modality'] === 'obligation'));
  assert.equal(criteria.find((c) => c['rule'] === 'No debug logs left')?.['polarity'], 'negative');
});

test('policy text is not routed: conditional rules keep the existing extractors exactly', async () => {
  const doc = await chunk(
    '## Claim assessment\n\nIf the claim amount exceeds 10000, then deny the claim.\n\nThe insurer shall notify the insured within 5 days.\n',
  );
  assert.ok(
    doc.units.every((u) => u.structure === undefined),
    'no unit of a policy section gets a structural role',
  );
  assert.equal(doc.structure?.sections.find((s) => s.sectionPath.includes('Claim assessment'))?.routed, false);
});

test('fail closed: a bulleted list of plain facts is not routed', async () => {
  const doc = await chunk('## Offices\n\n- The head office is in Pune.\n- The branch office is in Mumbai.\n');
  assert.ok(doc.units.every((u) => u.structure === undefined));
});

test('the document-level kind is a proposal with evidence', async () => {
  const doc = await chunk('## Procedure\n\n1. Open the valve.\n2. Close the valve.\n');
  assert.equal(doc.structure?.status, 'proposed');
  assert.equal(doc.structure?.kind, 'procedure');
  assert.ok((doc.structure?.sections[0]?.evidence.length ?? 0) > 0);
});

// ── TaskTest.pdf: the UW-3b definition of done ───────────────────────────────────────────────────────────────────────

test('TaskTest.pdf: clean step names, the 8 ground rules with modality, 8 ordered steps with done-when, no uncovered sentence', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('../../../../examples/vertical-test/TaskTest.pdf', import.meta.url)));
  const r = await compileSources([{ kind: 'pdf', bytes, sourcePath: 'TaskTest.pdf' }], { now: () => '2026-01-01T00:00:00.000Z' });
  assert.ok(r.ok);
  const g = r.value.graph;

  // No capability name or description mixes text from two columns or carries a leaked row number.
  const cellTexts = [
    'Goal is clear',
    'Subtask list exists',
    'Clean branch',
    'Each subtask works',
    'All tests pass',
    'Diff is clean',
    'Change is live',
    'Short retro note',
  ];
  for (const c of caps(g)) {
    const text = `${String(c['name'])} ${String(c['description'])}`;
    assert.ok(!/^\s*\d+\s/.test(String(c['name'])) && !/^\s*\d+\s/.test(String(c['description'])), `leaked row number in ${text}`);
    if ((c['metadata'] as Record<string, string> | undefined)?.['structure.role'] === 'procedure-step') {
      for (const cell of cellTexts) assert.ok(!text.includes(cell), `"done when" text leaked into a step: ${text}`);
    }
  }

  // The 8 ground rules, with their modality; "Never commit secrets" is a prohibition.
  const rules = constraints(g).filter((c) => c['subtype'] === 'prohibition' || c['subtype'] === 'policy');
  const rule = (needle: string): Record<string, unknown> | undefined =>
    rules.find((c) => String(c['rule']).includes(needle) || String(c['rationale'] ?? '').includes(needle));
  for (const needle of [
    'One task, one purpose',
    'Understand before you build',
    'Work in small steps',
    'Never commit secrets',
    'Test your own work',
    'Keep it readable',
    'Do not break existing behavior',
    'Ask for review',
  ]) {
    assert.ok(rule(needle), `ground rule "${needle}" is a constraint`);
  }
  assert.equal(rule('Never commit secrets')?.['modality'], 'prohibition');
  assert.equal(rule('Never commit secrets')?.['severity'], 'blocking');
  assert.equal(rule('Do not break existing behavior')?.['modality'], 'prohibition');
  assert.equal(rule('Ask for review')?.['modality'], 'obligation');

  // The 8 workflow steps, ordered, each with its done-when.
  const steps = caps(g)
    .filter((c) => (c['metadata'] as Record<string, string> | undefined)?.['structure.role'] === 'procedure-step')
    .map((c) => c['metadata'] as Record<string, string>)
    .sort((a, b) => Number(a['step.ordinal']) - Number(b['step.ordinal']));
  assert.deepEqual(
    steps.map((s) => [s['step.ordinal'], s['step.label'], s['step.doneWhen']]),
    [
      ['1', 'Understand', 'Goal is clear and written down'],
      ['2', 'Plan', 'Subtask list exists'],
      ['3', 'Set up', 'Clean branch, app runs'],
      ['4', 'Build', 'Each subtask works on its own'],
      ['5', 'Test', 'All tests pass'],
      ['6', 'Review', 'Diff is clean, feedback addressed'],
      ['7', 'Deliver', 'Change is live and communicated'],
      ['8', 'Reflect', 'Short retro note saved'],
    ],
  );
  assert.equal(g.allEdges().filter((e) => e.kind === 'custom:sequence').length, 7);

  // The definition of done is attached to the procedure; the form's fields are the first step's inputs.
  const criteria = constraints(g).filter((c) => c['subtype'] === 'acceptance_criterion');
  assert.equal(criteria.length, 9);
  assert.ok(criteria.every((c) => c['appliesTo'] === 'Step-by-Step Workflow' && c['checkbox'] === 'unchecked'));
  const first = caps(g).find((c) => c['name'] === 'Understand');
  // XOIR writes a parameter as "name: hint" when the form printed a hint for it.
  assert.deepEqual(first?.['inputs'], [
    'Task title',
    'Task type: Feature / Bug fix / Refactor / Docs / Other',
    'Owner',
    'Deadline',
    'Goal: What should be true when this is done?',
    'Out of scope: What will NOT be done in this task?',
  ]);
  assert.equal(caps(g).length, 8, 'the 8 steps are the only capabilities');

  // No sentence was lost, and the two form prompts are no longer read as rules.
  const queue = r.value.reviewQueue!;
  assert.equal(queue.items.filter((i) => i.kind === 'uncovered-sentence').length, 0);
  assert.ok(!constraints(g).some((c) => String(c['rule']).includes('What will NOT be done')));
});
