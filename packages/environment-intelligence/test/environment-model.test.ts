import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockClock } from '@xo/testing';
import {
  acquireSourceContent,
  buildEnvironmentModel,
  discoverSource,
  explainEnvironment,
  type Evidence,
  type EnvironmentModel,
  type FilesystemScope,
  type ModelOrigin,
  type Relationship,
} from '../src/index.js';
import { allowRoot, ctxFor, makeDeps, put, withSandbox } from './helpers.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'invoices');
const NOW = '2026-10-10T00:00:00.000Z';

async function modelFor(
  root: string,
  opts: { content: boolean; origin?: ModelOrigin; extra?: Partial<FilesystemScope> } = { content: true },
): Promise<{ model: EnvironmentModel; evidence: readonly Evidence[] }> {
  const deps = makeDeps();
  const scope: FilesystemScope = { kind: 'filesystem_root', root, ...(opts.extra ?? {}) };
  const auth = allowRoot(root, ['filesystem.list', 'filesystem.read']);
  const ctx = ctxFor(auth, new MockClock(NOW));
  const run = await discoverSource(deps, { sourceType: 'local_filesystem', scope }, ctx);
  assert.ok(run.ok);
  if (!run.ok) throw new Error('discovery failed');
  const evidence: Evidence[] = [...run.value.evidence];
  if (opts.content) {
    const keys = run.value.evidence
      .filter((e) => e.kind === 'resource_inventory' && e.payload['contentAcquirable'] === true)
      .map((e) => e.resourceKey);
    const acq = await acquireSourceContent(
      deps,
      { sourceId: run.value.record.source.sourceId, kind: 'document_content', resourceKeys: keys, scope },
      ctx,
    );
    assert.ok(acq.ok);
    if (acq.ok) evidence.push(...acq.value.evidence);
  }
  return {
    model: buildEnvironmentModel({ origin: opts.origin ?? 'test_fixture', generatedAt: NOW, inventory: deps.inventory, evidence }),
    evidence,
  };
}

const rel = (m: EnvironmentModel, kind: string, a: string, b: string): Relationship | undefined =>
  m.relationships.find(
    (r) =>
      r.kind === kind && ((r.from.resourceKey === a && r.to.resourceKey === b) || (r.from.resourceKey === b && r.to.resourceKey === a)),
  );

test('identical content is a directly observed relationship backed by digest evidence', async () => {
  await withSandbox(async ({ root }) => {
    await cp(FIXTURE_DIR, root, { recursive: true });
    const { model, evidence } = await modelFor(root);
    const r = rel(model, 'same_content', 'INV-1042-request.txt', 'copy-of-request.txt');
    assert.ok(r, 'expected a same_content relationship');
    assert.equal(r.status, 'directly_observed');
    assert.equal(r.strength, 'strong');
    assert.equal(r.validation, 'not_validated');
    assert.equal(r.humanReviewRequired, true);
    const ids = new Set(evidence.map((e) => e.id));
    for (const id of r.evidence) assert.ok(ids.has(id), 'every cited evidence id must exist');
    assert.ok(r.evidence.length >= 2);
  });
});

test('a shared identifier is corroborated only when two independent kinds of evidence tie BOTH files to it', async () => {
  await withSandbox(async ({ root }) => {
    await cp(FIXTURE_DIR, root, { recursive: true });
    const { model } = await modelFor(root);
    const strong = rel(model, 'shares_identifier', 'INV-1042-approval.txt', 'INV-1042-payment.csv');
    assert.ok(strong);
    assert.equal(strong.status, 'corroborated_inference');
    assert.deepEqual(strong.supportingKinds, ['content', 'filename']);
    assert.equal(strong.strength, 'moderate');
    // copy-of-request carries the id only in its content (its name has none): one kind -> candidate only
    const weak = rel(model, 'shares_identifier', 'INV-1042-request.txt', 'copy-of-request.txt');
    assert.ok(weak);
    assert.equal(weak.status, 'candidate_hypothesis');
    assert.equal(weak.strength, 'weak');
    assert.ok(weak.alternativeExplanations.length > 0);
    assert.ok(weak.missingEvidence.some((m) => /second, independent kind/.test(m)));
  });
});

test('without content acquisition, name-only evidence yields candidates and explicit unknowns — never corroboration', async () => {
  await withSandbox(async ({ root }) => {
    await cp(FIXTURE_DIR, root, { recursive: true });
    const { model } = await modelFor(root, { content: false });
    const shared = model.relationships.filter((r) => r.kind === 'shares_identifier');
    assert.ok(shared.length > 0);
    for (const r of shared) assert.equal(r.status, 'candidate_hypothesis');
    assert.equal(
      model.relationships.some((r) => r.kind === 'same_content'),
      false,
    );
    assert.ok(model.unknowns.some((u) => /only the file name was observed/i.test(u.reason)));
  });
});

test('nothing in the model can be "validated", executable, or granted: the types and values forbid it', async () => {
  await withSandbox(async ({ root }) => {
    await cp(FIXTURE_DIR, root, { recursive: true });
    const { model } = await modelFor(root);
    for (const r of model.relationships) {
      assert.equal(r.validation, 'not_validated');
      assert.equal(r.humanReviewRequired, true);
    }
    for (const p of model.processes) {
      assert.equal(p.validation, 'not_validated');
      assert.equal(p.status, 'candidate_hypothesis');
      assert.equal(p.humanReviewRequired, true);
      assert.equal(p.stepRelationship, 'observed_sequence_only');
      assert.equal(p.requiredCapabilities.status, 'unresolved');
      assert.equal('executable' in p, false);
      assert.equal('permissions' in p, false);
    }
    assert.deepEqual(model.xoirLinks, []);
    const sample: Relationship | undefined = model.relationships[0];
    if (sample) {
      // @ts-expect-error 'validated' is not a member of ValidationState
      const bad: Relationship = { ...sample, validation: 'validated' };
      assert.ok(bad);
    }
  });
});

test('a candidate process keeps per-step evidence, order basis, alternatives and missing evidence', async () => {
  await withSandbox(async ({ root }) => {
    await cp(FIXTURE_DIR, root, { recursive: true });
    // distinct, deliberately chosen timestamps so order is "suggested"
    const stamps: [string, string][] = [
      ['INV-1042-request.txt', '2026-01-01T00:00:00.000Z'],
      ['INV-1042-approval.txt', '2026-01-02T00:00:00.000Z'],
      ['INV-1042-payment.csv', '2026-01-03T00:00:00.000Z'],
      ['copy-of-request.txt', '2026-01-04T00:00:00.000Z'],
    ];
    for (const [name, iso] of stamps) await utimes(join(root, name), new Date(iso), new Date(iso));
    const { model, evidence } = await modelFor(root);
    const proc = model.processes.find((p) => p.anchorIdentifier === 'INV-1042');
    assert.ok(proc);
    assert.equal(proc.steps.length, 4);
    assert.equal(proc.order.established, true);
    assert.deepEqual(
      proc.steps.map((s) => s.label),
      ['INV-1042-request.txt', 'INV-1042-approval.txt', 'INV-1042-payment.csv', 'copy-of-request.txt'],
    );
    assert.deepEqual(
      proc.steps.slice(0, 3).map((s) => s.stageHint),
      ['request', 'approval', 'payment'],
    );
    const ids = new Set(evidence.map((e) => e.id));
    for (const s of proc.steps) {
      assert.ok(s.evidence.length > 0);
      for (const id of s.evidence) assert.ok(ids.has(id));
    }
    assert.ok(proc.alternativeExplanations.length >= 3);
    assert.ok(proc.missingEvidence.length >= 3);
    assert.equal(proc.order.basis, 'file_modified_time');
  });
});

test('identical timestamps mean the order is NOT established, and the process says so', async () => {
  await withSandbox(async ({ root }) => {
    await cp(FIXTURE_DIR, root, { recursive: true });
    const same = new Date('2026-02-02T00:00:00.000Z');
    for (const n of ['INV-1042-request.txt', 'INV-1042-approval.txt', 'INV-1042-payment.csv', 'copy-of-request.txt'])
      await utimes(join(root, n), same, same);
    const { model } = await modelFor(root);
    const proc = model.processes.find((p) => p.anchorIdentifier === 'INV-1042');
    assert.ok(proc);
    assert.equal(proc.order.established, false);
    assert.ok(proc.alternativeExplanations.some((a) => /identical timestamps/.test(a)));
  });
});

test('too little evidence proposes no process (two related files are not a process)', async () => {
  await withSandbox(async ({ root }) => {
    await put(join(root, 'INV-5000-a.txt'), 'INV-5000');
    await put(join(root, 'INV-5000-b.txt'), 'INV-5000');
    const { model } = await modelFor(root);
    assert.equal(model.processes.length, 0);
    assert.ok(model.relationships.length > 0);
  });
});

test('truncated content never produces a "same content" claim', async () => {
  await withSandbox(async ({ root }) => {
    const shared = 'z'.repeat(400);
    await put(join(root, 'one.txt'), `${shared} tail-one`);
    await put(join(root, 'two.txt'), `${shared} tail-two`);
    const { model } = await modelFor(root, { content: true, extra: { limits: { maxContentBytes: 100 } } });
    assert.equal(
      model.relationships.some((r) => r.kind === 'same_content'),
      false,
    );
  });
});

test('identifiers shared across two different sources are linked as candidates, with both sources cited', async () => {
  await withSandbox(async ({ root, outside }) => {
    await put(join(root, 'INV-8001-ledger.csv'), 'INV-8001,10');
    await put(join(outside, 'INV-8001-contract.txt'), 'contract for INV-8001');
    const deps = makeDeps();
    const evidence: Evidence[] = [];
    for (const r of [root, outside]) {
      const ctx = ctxFor(allowRoot(r, ['filesystem.list', 'filesystem.read']), new MockClock(NOW));
      const scope: FilesystemScope = { kind: 'filesystem_root', root: r };
      const run = await discoverSource(deps, { sourceType: 'local_filesystem', scope }, ctx);
      assert.ok(run.ok);
      if (!run.ok) return;
      evidence.push(...run.value.evidence);
      const keys = run.value.evidence.filter((e) => e.kind === 'resource_inventory').map((e) => e.resourceKey);
      const acq = await acquireSourceContent(
        deps,
        { sourceId: run.value.record.source.sourceId, kind: 'document_content', resourceKeys: keys, scope },
        ctx,
      );
      assert.ok(acq.ok);
      if (acq.ok) evidence.push(...acq.value.evidence);
    }
    const model = buildEnvironmentModel({ origin: 'test_fixture', generatedAt: NOW, inventory: deps.inventory, evidence });
    assert.equal(model.systems.length, 2);
    const cross = model.relationships.find((r) => r.kind === 'shares_identifier');
    assert.ok(cross);
    assert.notEqual(cross.from.sourceId, cross.to.sourceId);
    assert.equal(cross.status, 'corroborated_inference');
  });
});

test('provenance of every cited evidence id is reachable and names its authority', async () => {
  await withSandbox(async ({ root }) => {
    await cp(FIXTURE_DIR, root, { recursive: true });
    const { model, evidence } = await modelFor(root);
    const byId = new Map(evidence.map((e) => [e.id, e]));
    for (const r of model.relationships) {
      for (const id of r.evidence) {
        const e = byId.get(id);
        assert.ok(e);
        assert.equal(e.provenance.access.authority, 'development_unverified');
        assert.equal(e.provenance.connectorId, 'xo.connector.local-filesystem');
      }
    }
    assert.deepEqual(model.systems[0]?.evidenceAuthorities, ['development_unverified']);
    assert.ok(model.notices.some((n) => /DEVELOPMENT-ONLY/.test(n)));
  });
});

test('repeat discovery evidence is de-duplicated and the model is deterministic', async () => {
  await withSandbox(async ({ root }) => {
    await cp(FIXTURE_DIR, root, { recursive: true });
    const deps = makeDeps();
    const ctx = ctxFor(allowRoot(root), new MockClock(NOW));
    const scope: FilesystemScope = { kind: 'filesystem_root', root };
    const a = await discoverSource(deps, { sourceType: 'local_filesystem', scope }, ctx);
    const b = await discoverSource(deps, { sourceType: 'local_filesystem', scope }, ctx);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    const once = buildEnvironmentModel({ origin: 'test_fixture', generatedAt: NOW, inventory: deps.inventory, evidence: a.value.evidence });
    const twice = buildEnvironmentModel({
      origin: 'test_fixture',
      generatedAt: NOW,
      inventory: deps.inventory,
      evidence: [...a.value.evidence, ...b.value.evidence],
    });
    assert.equal(JSON.stringify(once), JSON.stringify(twice));
    assert.equal(once.evidenceCount, twice.evidenceCount);
  });
});

test('fixture-origin models say so, and live-origin models never claim validation; the explanation reports uncertainty', async () => {
  await withSandbox(async ({ root }) => {
    await cp(FIXTURE_DIR, root, { recursive: true });
    const fixture = await modelFor(root, { content: true, origin: 'test_fixture' });
    const live = await modelFor(root, { content: true, origin: 'live_discovery' });
    assert.ok(fixture.model.notices[0]?.startsWith('TEST FIXTURE'));
    assert.ok(!live.model.notices.some((n) => n.startsWith('TEST FIXTURE')));
    assert.ok(live.model.notices.some((n) => /not validated/i.test(n)));
    const text = explainEnvironment(fixture.model);
    assert.match(text, /TEST FIXTURE/);
    assert.match(text, /What XO is unsure about/);
    assert.match(text, /Not evaluated in this milestone/i);
    assert.match(text, /needs human review/);
    assert.match(text, /not validated/i);
  });
});
