import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateAgainstBundle, validateWorkflowComponent } from '@xo/workflow-ir';
import { compileSources, packageXoirGraph } from '../../src/index.js';
import { emitPolicyWorkflows, synthesizePolicyArtifacts } from '../../src/policy/index.js';

/**
 * A policy written for this test and NOT used to tune the extractor (the tuning corpus is test/corpus/*).
 * It states five rules the extractor recognizes, two it does not, and one discretionary clause.
 */
const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/warranty-desk-policy.md', import.meta.url)), 'utf8');

async function compiled(
  text = FIXTURE,
  policy?: Parameters<typeof compileSources>[1] extends infer O ? (O extends { policy?: infer P } ? P : never) : never,
) {
  const r = await compileSources(
    [{ kind: 'document', text, title: 'Warranty', sourcePath: 'w.md' }],
    policy !== undefined ? { policy } : {},
  );
  assert.ok(r.ok, 'compile failed');
  return r.value;
}

test('emits a structured (model-free) and a from-text workflow that pass both validators', async () => {
  const { policy } = await compiled();
  assert.ok(policy?.workflows, `no workflows: ${policy?.workflowProblems?.join('; ')}`);
  const c = policy.workflows.component;
  assert.deepEqual(
    validateWorkflowComponent(JSON.parse(JSON.stringify(c))).issues.filter((i) => i.severity === 'error'),
    [],
  );
  assert.deepEqual(validateAgainstBundle(c, { decisionTrees: { trees: policy.trees } }).issues, []);
  assert.deepEqual(
    c.workflows.map((w) => w.id.replace(/^.*_(structured|from_text)$/, '$1')),
    ['structured', 'from_text'],
  );
});

test('"needs a model" comes from runtime negotiation: the structured workflow needs none, the text workflow does', async () => {
  const { policy } = await compiled();
  const [s, t] = policy!.workflows!.report.workflows;
  assert.equal(s!.path, 'structured');
  assert.equal(s!.needsModel, false);
  assert.equal(s!.counts.model_assisted, 0);
  assert.equal(t!.path, 'text');
  assert.equal(t!.needsModel, true);
  assert.equal(t!.counts.model_assisted, 1);
});

test('the report is labelled declared-not-measured and counts match the steps', async () => {
  const { policy } = await compiled();
  const rep = policy!.workflows!.report;
  assert.equal(rep.label, 'declared, not measured');
  for (const w of rep.workflows) {
    const total = w.counts.deterministic + w.counts.model_assisted + w.counts.human;
    assert.equal(total, w.steps.length);
    assert.equal(w.ratio, w.counts.deterministic / total);
    assert.equal(w.label, 'declared, not measured');
  }
});

test('every step that carries content from the document carries provenance (source sentences)', async () => {
  const { policy } = await compiled();
  for (const w of policy!.workflows!.component.workflows)
    for (const s of w.steps) {
      if (['extract_facts', 'decide_case', 'escalate_to_human'].includes(s.id))
        assert.ok((s.provenance ?? []).length > 0, `${w.id}/${s.id} has no provenance`);
      for (const p of s.provenance ?? []) assert.ok(p.length <= 300);
    }
  const decide = policy!.workflows!.component.workflows[0]!.steps.find((s) => s.id === 'decide_case')!;
  assert.ok(
    (decide.provenance ?? []).some((p) => p.includes('proof of purchase')),
    'rule sentence not carried into provenance',
  );
});

test('unrecognized sentences become review items with an exact reason and fail closed; discretion is reported but not blocking', async () => {
  const { policy } = await compiled();
  const rep = policy!.workflows!.report;
  const unrec = rep.reviewItems.filter((r) => r.kind === 'unrecognized_rule');
  assert.equal(unrec.length, 3);
  assert.ok(unrec.some((r) => r.sentence.includes('365 days')));
  // a bare "... is rejected." used to be invisible to review (no modal verb); it is now surfaced
  assert.ok(unrec.some((r) => r.sentence.includes('Anything submitted later is rejected')));
  assert.ok(unrec.every((r) => r.reason.length > 0 && r.effect.includes('UNFORMALIZED_RULE')));
  const judgement = rep.reviewItems.filter((r) => r.kind === 'judgement_call');
  assert.ok(judgement.some((r) => r.sentence.includes('discretion')));
  const nd = rep.workflows[0]!.nonDeterministic;
  assert.ok(nd.filter((n) => n.cause === 'unrecognized_rule').every((n) => n.blocking && n.provenance.length === 1));
  assert.ok(nd.filter((n) => n.cause === 'judgement_call').every((n) => !n.blocking));
  // every non-deterministic step in the declared counts has a finding naming it
  const stepsNonDet = rep.workflows[1]!.steps.filter((s) => s.class !== 'deterministic').map((s) => s.step);
  for (const id of stepsNonDet)
    assert.ok(
      rep.workflows[1]!.nonDeterministic.some((n) => n.step === id),
      `no finding for ${id}`,
    );
  // the tree escalates on the unrecognized rules rather than guessing
  assert.deepEqual(policy!.review.failClosedPaths, ['decision']);
});

test('per-capability report: rule coverage is recognized/decision sentences, and states that no approving outcome is reachable', async () => {
  const { policy } = await compiled();
  const rep = policy!.workflows!.report;
  const cap = rep.capabilities[0]!;
  assert.equal(cap.decisionSentences, 8);
  assert.equal(cap.recognizedSentences, 5);
  assert.equal(cap.ruleCoverage, 5 / 8);
  assert.deepEqual([...cap.outcomes].sort(), ['deny', 'escalate']);
  assert.ok(rep.limits.some((l) => l.includes('reaches no approving outcome')));
  assert.ok(rep.limits.some((l) => l.includes('not measurements')));
});

test('emission is deterministic and is skipped on request', async () => {
  const a = await compiled();
  const b = await compiled();
  assert.equal(JSON.stringify(a.policy!.workflows), JSON.stringify(b.policy!.workflows));
  const off = await compiled(FIXTURE, { workflows: false });
  assert.equal(off.policy!.workflows, undefined);
  assert.equal(off.policy!.workflowProblems, undefined);
});

test('a policy with no decidable rules emits nothing and says why when asked directly', () => {
  const art = synthesizePolicyArtifacts([{ text: '# Notes\n\nThe office is on the second floor.', title: 'Notes' }], {});
  assert.equal(art.workflows, undefined);
  assert.equal(emitPolicyWorkflows(art).emission, undefined);
  assert.match(emitPolicyWorkflows(art).problems[0] ?? '', /no executable decision tree/);
});

test('the packaged bundle carries the workflows component, hashed with the rest', async () => {
  const c = await compiled();
  const pkg = packageXoirGraph(c.graph, {
    identity: { name: 'warranty', version: '1.0.0', creatorDid: 'did:xo:test' },
    metadata: { domain: 'support', description: 'd', scope: [], limitations: [], tags: [] },
    upstreamDiagnostics: c.diagnostics,
    policy: c.policy!,
  });
  assert.ok(pkg.ok, pkg.ok ? '' : pkg.error.message);
  const comp = pkg.value.bundle.manifest.components['workflows'];
  assert.ok(comp, 'no workflows component in manifest');
  assert.equal(comp.path, 'workflows/workflows.json');
  assert.equal(comp.required, false);
  const input = pkg.value.bundle.components.find((x) => x.path === 'workflows/workflows.json');
  assert.ok(input, 'component bytes missing from the bundle');
  assert.equal(
    JSON.stringify(JSON.parse(Buffer.from(input.data as Uint8Array).toString('utf8'))),
    JSON.stringify(c.policy!.workflows!.component),
  );
  assert.ok(comp.hash.startsWith('sha256:'));
});

test('a credential-lookalike inside a rule sentence is withheld from the component AND the report', () => {
  const secret = 'AKIAABCDEFGHIJKLMNOP';
  const text = [
    '# Key Desk Policy',
    '',
    '## Rules',
    '',
    `**K1 Escalation.** A request over $500 is referred to the Security Lead (account ${secret}).`,
  ].join('\n');
  const art = synthesizePolicyArtifacts([{ text, title: 'Key Desk Policy' }], {});
  assert.ok(art.workflows, `no workflows: ${art.workflowProblems?.join('; ')}`);
  assert.equal(JSON.stringify(art.workflows.component).includes(secret), false, 'secret reached the portable component');
  assert.equal(JSON.stringify(art.workflows.report).includes(secret), false, 'secret reached the report');
  assert.ok(JSON.stringify(art.workflows.component).includes('withheld'), 'nothing marks the withheld sentence');
});
