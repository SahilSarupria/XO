/**
 * PX-5 — the capability inventory: statuses, the four independent readiness answers, the one human-task rule across
 * procedure steps and prose actions, duplicates (equivalent only), gaps, parameter derivation, determinism.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { compileSources } from '@xo/compiler';
import { buildCapabilityInventory, type CapabilityReport } from '../src/index.js';

const ref = (section: string) => [{ documentPath: 'src_doc', sectionPath: [section], pages: [1] }];

function graph(): XoirGraph {
  const g = XoirGraph.create(XoirGraphId('g'));
  const cap = (id: string, name: string, extra: Record<string, unknown> = {}, section = 'Ops') =>
    g.createAndAddNode({
      id: XoirNodeId(id),
      kind: 'capability',
      properties: { name, description: `${name}.`, ...extra },
      confidence: 0.8,
      sourceRefs: ref(section),
    });
  // A rule-bound capability (deterministic_rule).
  cap('cap_rule', 'Evaluate refund', { inputs: ['refund amount'] });
  g.createAndAddNode({
    id: XoirNodeId('rule_1'),
    kind: 'heuristic',
    properties: { condition: 'the refund amount exceeds 500', action: 'deny the refund', exceptionConditions: [] },
  });
  g.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('rule_1'), toId: XoirNodeId('cap_rule') });
  // A procedure step and a prose action with action knowledge: both human tasks.
  cap('cap_step', 'Pull latest code', {
    metadata: {
      understanding: 'manual-step',
      'step.actions': 'Pull the latest code.',
      'step.doneWhen': 'Main is checked out.',
      'step.owner': 'Release engineer',
    },
  });
  cap('cap_prose', 'Reconcile invoices');
  g.createAndAddNode({
    id: XoirNodeId('concept_a'),
    kind: 'concept',
    properties: { definition: 'reconcile invoices' },
    subtype: 'action',
    confidence: 0.8,
  });
  g.createAndAddEdge({ id: XoirEdgeId('e2'), kind: 'REQUIRES', fromId: XoirNodeId('cap_prose'), toId: XoirNodeId('concept_a') });
  // An ungrounded prose capability: no rules, no task contract.
  cap('cap_bare', 'Improve morale');
  // Two fully equivalent capabilities (a duplicate) and a variant that differs only in evidence.
  cap('cap_dup_a', 'Archive the file');
  cap('cap_dup_b', 'Archive the file');
  cap('cap_variant', 'Archive the file', {}, 'Elsewhere');
  return g;
}

const by = (caps: readonly CapabilityReport[], id: string): CapabilityReport => caps.find((c) => c.capabilityId === id)!;

test('statuses, the four answers and the human-task rule', () => {
  const inv = buildCapabilityInventory(graph(), { needs: ['Pull latest code', 'Deploy the release'] });
  const c = inv.capabilities;
  assert.equal(by(c, 'cap_rule').readiness.bound.strategy, 'deterministic_rule');
  assert.equal(by(c, 'cap_step').readiness.bound.strategy, 'human_in_the_loop');
  assert.equal(by(c, 'cap_prose').readiness.bound.strategy, 'human_in_the_loop');
  assert.equal(by(c, 'cap_step').humanTask?.origin, 'procedure-step');
  assert.equal(by(c, 'cap_prose').humanTask?.origin, 'action-knowledge');
  assert.equal(by(c, 'cap_step').status, 'explicit');
  assert.equal(by(c, 'cap_prose').status, 'inferred');
  assert.equal(by(c, 'cap_bare').status, 'unresolved');
  assert.equal(by(c, 'cap_bare').readiness.eligible.value, 'no');
  assert.equal(by(c, 'cap_bare').humanTask, undefined);
  // authorization is never assumed
  for (const r of c) {
    assert.equal(r.readiness.authorized.value, 'unknown');
    assert.equal(r.readiness.runnable, false);
  }
  assert.ok(by(c, 'cap_prose').readiness.conditions.includes('assign the role that performs this human task'));
  assert.ok(!by(c, 'cap_step').readiness.conditions.includes('assign the role that performs this human task'), 'the step states its owner');
  assert.deepEqual(
    inv.gaps.map((g) => g.need),
    ['Deploy the release'],
  );
});

test('only all four answers together make a capability runnable', () => {
  const yes = { value: 'yes' as const, reason: 'approved and permitted' };
  const all = buildCapabilityInventory(graph(), { authorize: () => yes });
  assert.equal(by(all.capabilities, 'cap_rule').readiness.runnable, true);
  assert.equal(by(all.capabilities, 'cap_step').readiness.runnable, true);
  assert.equal(by(all.capabilities, 'cap_bare').readiness.runnable, false);
  // bound but the runtime has no executor: unsupported, not runnable
  const noHuman = buildCapabilityInventory(graph(), { authorize: () => yes, runtimeSupport: new Set(['deterministic_rule']) });
  const step = by(noHuman.capabilities, 'cap_step');
  assert.equal(step.readiness.bound.value, 'yes');
  assert.equal(step.readiness.runtimeSupported.value, 'no');
  assert.equal(step.status, 'unsupported');
  assert.equal(step.readiness.runnable, false);
  // bound and supported but not authorized
  const denied = buildCapabilityInventory(graph(), { authorize: () => ({ value: 'no', reason: 'permission revoked' }) });
  assert.deepEqual(by(denied.capabilities, 'cap_rule').readiness.blockers, ['authorized: permission revoked']);
  assert.equal(all.counts.runnable, 3);
});

test('duplicates only when fully equivalent; variants stay distinct; reviewer decisions win', () => {
  const inv = buildCapabilityInventory(graph(), {
    decisions: new Map([
      ['cap_rule', 'accepted'],
      ['cap_prose', 'rejected'],
    ]),
  });
  assert.deepEqual(inv.duplicateGroups, [['cap_dup_a', 'cap_dup_b']]);
  assert.equal(by(inv.capabilities, 'cap_dup_b').status, 'duplicate');
  assert.equal(by(inv.capabilities, 'cap_dup_b').duplicateOf, 'cap_dup_a');
  assert.notEqual(by(inv.capabilities, 'cap_variant').status, 'duplicate');
  assert.equal(by(inv.capabilities, 'cap_rule').status, 'accepted');
  assert.equal(by(inv.capabilities, 'cap_prose').status, 'rejected');
  assert.equal(inv.counts.total, inv.capabilities.length);
  assert.equal(
    Object.entries(inv.counts)
      .filter(([k]) => k !== 'total' && k !== 'runnable')
      .reduce((n, [, v]) => n + v, 0),
    inv.counts.total,
  );
});

test('a gap is reported when every matching candidate is unusable', () => {
  const inv = buildCapabilityInventory(graph(), { needs: ['Reconcile invoices'], decisions: new Map([['cap_prose', 'rejected']]) });
  assert.deepEqual(inv.gaps, [
    {
      need: 'Reconcile invoices',
      reason: 'every matching capability is rejected, a duplicate or unsupported',
      unusableCandidates: ['cap_prose'],
    },
  ]);
});

test('parameters record their derivation; inferred required inputs need review', () => {
  const inv = buildCapabilityInventory(graph());
  const params = by(inv.capabilities, 'cap_rule').parameters;
  assert.deepEqual(
    params.map((p) => [p.name, p.derivation, p.needsReview]),
    [['refund amount', 'declared', false]],
  );
});

test('deterministic: the same graph gives the same inventory digest', () => {
  assert.equal(buildCapabilityInventory(graph()).digest, buildCapabilityInventory(graph()).digest);
});

test('compiled documents: procedure steps and prose actions resolve under one rule; numbered step columns are not names', async () => {
  const text =
    '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n\n# Refunds\n\nIf the refund amount exceeds 500, the refund must be denied.\n';
  const r = await compileSources([{ kind: 'document', text, sourcePath: 'p.md' }]);
  assert.ok(r.ok);
  if (!r.ok) return;
  const inv = buildCapabilityInventory(r.value.graph, { needs: ['Run the full test suite'] });
  const steps = inv.capabilities.filter((c) => c.origin === 'procedure-step');
  assert.deepEqual(steps.map((s) => s.name).sort(), ['Pull the latest code', 'Run the full test suite']);
  for (const s of steps) {
    assert.equal(s.readiness.bound.strategy, 'human_in_the_loop');
    assert.deepEqual(s.humanTask?.actorRole, { value: 'Release engineer', derivation: 'stated' });
  }
  assert.deepEqual(inv.gaps, []);
  const rule = inv.capabilities.find((c) => c.readiness.bound.strategy === 'deterministic_rule');
  assert.ok(rule !== undefined);
  assert.ok(rule.parameters.some((p) => p.derivation === 'inferred' && p.needsReview));
});
