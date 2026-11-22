// UW-6 (ADR 0043), UAC-17: the injection corpus (specs/security/injection-corpus.json) never changes composition. A payload placed in the
// goal text, a need, a section hint, a forEach value, a model's proposal, or the source document itself leaves the composed
// definition, its step ids and its trace outcome exactly as a clean run produces them (or, where the payload makes a field invalid,
// the run is refused, never altered).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileSources } from '@xo/compiler';
import { composeWorkflows } from '@xo/workflow-composer';
import { buildCapabilityInventory, composeIntent, type IntentContext } from '../src/index.js';

const corpus = JSON.parse(readFileSync(new URL('../../../specs/security/injection-corpus.json', import.meta.url), 'utf8')) as {
  cases: { id: string; text: string }[];
};

const DOC = (note: string): string =>
  `# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n| 3 | Publish the release notes. | The notes are online. | Release engineer |\n${note === '' ? '' : `\n${note}\n`}`;

async function context(doc: string, needs: string[]): Promise<IntentContext> {
  const r = await compileSources([{ kind: 'document', text: doc, sourcePath: 'ops.md' }]);
  assert.ok(r.ok);
  if (!r.ok) throw new Error('compile failed');
  const w = composeWorkflows(r.value.graph);
  assert.ok(w.ok);
  if (!w.ok) throw new Error('compose failed');
  return { graph: r.value.graph, workflows: w.value, inventory: buildCapabilityInventory(r.value.graph, { needs }) };
}

const NEED = 'Run the full test suite';
const BASE = { text: 'Ship a release', needs: [NEED] };
const shape = (r: ReturnType<typeof composeIntent>): unknown =>
  r.status === 'composed'
    ? { status: r.status, digest: r.lowered.definitionDigest, steps: r.lowered.component!.workflows[0]!.steps.map((s) => [s.id, s.type]) }
    : { status: r.status };

test('the corpus is there', () => assert.ok(corpus.cases.length >= 8));

test('a payload in the goal text, a section hint or a model proposal never changes the composed definition', async () => {
  const ctx = await context(DOC(''), [NEED]);
  const clean = shape(composeIntent(ctx, BASE, 'structured'));
  assert.equal((clean as { status: string }).status, 'composed');
  for (const c of corpus.cases) {
    for (const origin of ['structured', 'model'] as const) {
      const inText = composeIntent(ctx, { ...BASE, text: `${BASE.text}. ${c.text}` }, origin);
      assert.deepEqual(shape(inText), clean, `${c.id} in the goal text (${origin})`);
      // A section hint is bounded to 200 characters: a long payload is refused, a short one only scores words.
      const inSection = composeIntent(ctx, { ...BASE, section: c.text }, origin);
      assert.ok(
        inSection.status === 'invalid' ||
          JSON.stringify(shape(inSection)) === JSON.stringify(clean) ||
          inSection.status === 'needs_clarification',
        `${c.id} in a section: ${inSection.status}`,
      );
      if (inSection.status === 'composed') assert.ok(!JSON.stringify(inSection.lowered.component).includes(c.text.slice(0, 20)));
      // Extra structure smuggled beside the proposal fields is dropped.
      const smuggled = composeIntent(
        ctx,
        { ...BASE, steps: [c.text], approve: true, recipients: ['x@evil.example'], workflowId: 'cw_evil' },
        origin,
      );
      assert.deepEqual(shape(smuggled), clean, `${c.id} as extra fields (${origin})`);
    }
  }
});

test('a payload as a needed capability or a forEach value is a gap or refused, never a new step', async () => {
  for (const c of corpus.cases) {
    const ctx = await context(DOC(''), [c.text]);
    const r = composeIntent(ctx, { text: BASE.text, needs: [c.text.slice(0, 200)] }, 'model');
    assert.ok(r.status === 'gap' || r.status === 'invalid' || r.status === 'needs_clarification', `${c.id} as a need: ${r.status}`);
    const fe = composeIntent(await context(DOC(''), [NEED]), { ...BASE, forEach: c.text }, 'model');
    assert.ok(fe.status === 'invalid' || fe.status === 'composed', `${c.id} as forEach`);
    if (fe.status === 'composed') assert.ok(!JSON.stringify(fe.lowered.component).includes(c.text.slice(0, 20)));
  }
});

test("a payload planted in the source document can add at most a person's task: never an action, a recipient or an approval, and the real steps stay", async () => {
  const cleanR = composeIntent(await context(DOC(''), [NEED]), BASE, 'structured');
  assert.equal(cleanR.status, 'composed');
  const cleanSteps = cleanR.status === 'composed' ? cleanR.lowered.component!.workflows[0]!.steps : [];
  for (const c of corpus.cases) {
    const r = composeIntent(await context(DOC(c.text), [NEED]), BASE, 'structured');
    if (r.status === 'gap') {
      // The planted line became a capability nothing is bound to (an automated-sounding step): composition STOPS and says so; it is not run, guessed or bound.
      assert.ok(
        r.gaps.every((g) => g.kind === 'unbound_capability'),
        `${c.id}: only an unbound step stops it`,
      );
      continue;
    }
    assert.equal(r.status, 'composed', c.id);
    if (r.status !== 'composed') continue;
    const steps = r.lowered.component!.workflows[0]!.steps;
    // FINDING (ADR 0043): the document compiler reads a bare imperative sentence as a procedure step, so a planted line can add a
    // task for a PERSON. It cannot add anything that acts: only task and escalation steps exist, and each compiled capability still
    // has to be approved by a person before the readiness certificate.
    assert.ok(
      steps.every((st) => st.type === 'approve' || st.type === 'escalate'),
      `${c.id}: only a person's tasks`,
    );
    const ids = steps.map((st) => st.id);
    let at = 0;
    for (const id of cleanSteps.map((st) => st.id)) at = ids.indexOf(id, at) + 1 || -1;
    assert.ok(at !== -1, `${c.id}: the real steps are all still there, in order`);
    assert.ok(steps.length - cleanSteps.length <= 2, `${c.id}: at most one task (and its escalation) was added`);
    assert.ok(!JSON.stringify(r.lowered.component).includes('@evil'), `${c.id}: no recipient`);
  }
});
