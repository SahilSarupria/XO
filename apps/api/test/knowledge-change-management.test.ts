/**
 * UW-11a (ADR 0050): knowledge change management over HTTP — preview before approval, rollback, separation of duties, the knowledge
 * state on the run's record, and certificates that depend only on the knowledge drawn from their own sources.
 */
import { test } from 'node:test';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { TestServer } from './test-helpers.js';
import { env, items, type RunView } from './payments-fixture.js';

const TEXT = '# Refunds\n\nAcme Corp handles refunds.\n\nIf the refund amount exceeds 500, the refund must be denied.\n';

interface Proposal {
  changeSet: { changeSetId: string; status: string; origin: { kind: string }; findings: { code: string; severity: string }[] } | null;
}

async function compilationOf(server: TestServer, ws: string, defId: string): Promise<string> {
  const def = (await server.request('GET', `/workspaces/${ws}/generated-workflows/${defId}`)).json<{
    compilationId?: string;
    definition?: { compilationId: string };
  }>();
  return def.compilationId ?? def.definition!.compilationId;
}

async function approveNewSource(
  server: TestServer,
  ws: string,
  filename: string,
  text: string,
  headers?: Record<string, string>,
): Promise<string> {
  const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=${filename}`, Buffer.from(text))).json<{
    sourceId: string;
  }>();
  const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
    .compilationId;
  const p = (await server.request('POST', `/workspaces/${ws}/compilations/${cid}/knowledge-change-sets`)).json<Proposal>();
  assert.ok(p.changeSet !== null, 'the compilation proposes knowledge');
  const a = await server.request(
    'POST',
    `/workspaces/${ws}/knowledge/change-sets/${p.changeSet.changeSetId}/approve`,
    { reason: 'ok' },
    headers,
  );
  assert.equal(a.status, 200, a.bodyText);
  return p.changeSet.changeSetId;
}

test('UW-11a: approving unrelated knowledge leaves a running workflow certificate current; a schedule slot still starts', async () => {
  await env(async ({ server, ws, defId, certId }) => {
    await approveNewSource(server, ws, 'refunds.md', TEXT);
    const runs = `/workspaces/${ws}/generated-workflows/${defId}/runs`;
    const started = await server.request('POST', runs, { input: { payment_items: items(1) }, certificateId: certId });
    assert.ok(started.status === 201 || started.status === 200, started.bodyText);
    const v = await server.request('GET', `/workspaces/${ws}/readiness-certificates/${certId}/verify`);
    assert.equal(v.json<{ startAllowed: boolean }>().startAllowed, true, v.bodyText);
  });
});

test('UW-11a: the change-set preview lists the affected certified workflows and moves nothing', async () => {
  await env(async ({ server, ws, defId, certId }) => {
    const cid = await compilationOf(server, ws, defId);
    const before = (await server.request('GET', `/workspaces/${ws}/knowledge/state`)).json<{ stateId: string }>();
    const p = (await server.request('POST', `/workspaces/${ws}/compilations/${cid}/knowledge-change-sets`)).json<Proposal>();
    assert.ok(p.changeSet !== null, 'the payments compilation proposes knowledge');
    const pv = await server.request('GET', `/workspaces/${ws}/knowledge/change-sets/${p.changeSet.changeSetId}/preview`);
    assert.equal(pv.status, 200, pv.bodyText);
    const body = pv.json<{
      preview: { stale: boolean; diff: { added: string[] } };
      affected: { count: number; certificates: { certificateId: string }[] };
    }>();
    assert.equal(body.preview.stale, false);
    assert.ok(body.preview.diff.added.length > 0);
    assert.equal(body.affected.count, 1);
    assert.equal(body.affected.certificates[0]!.certificateId, certId);
    assert.equal((await server.request('GET', `/workspaces/${ws}/knowledge/state`)).json<{ stateId: string }>().stateId, before.stateId);
  });
});

test('UW-11a: a rollback is proposed by an author and cannot be approved by its proposer when separation is required', async () => {
  await env(
    async ({ server, ws, reviewer }) => {
      const root = (await server.request('GET', `/workspaces/${ws}/knowledge/state`)).json<{ stateId: string }>().stateId;
      await approveNewSource(server, ws, 'refunds.md', TEXT);
      const rb = await server.request('POST', `/workspaces/${ws}/knowledge/rollbacks`, { toStateId: root, reason: 'wrong policy' });
      assert.equal(rb.status, 201, rb.bodyText);
      const cs = rb.json<Proposal>().changeSet!;
      assert.equal(cs.origin.kind, 'rollback');
      const own = await server.request('POST', `/workspaces/${ws}/knowledge/change-sets/${cs.changeSetId}/approve`, { reason: 'mine' });
      assert.equal(own.status, 409, own.bodyText);
      assert.equal(own.json<{ error: { code: string; context?: { reason?: string } } }>().error.code, 'XO_KNOWLEDGE_APPROVAL_REFUSED');
      const other = await server.request(
        'POST',
        `/workspaces/${ws}/knowledge/change-sets/${cs.changeSetId}/approve`,
        { reason: 'ok' },
        reviewer,
      );
      assert.equal(other.status, 200, other.bodyText);
      const states = (await server.request('GET', `/workspaces/${ws}/knowledge/states?size=10`)).json<{
        states: { stateId: string }[];
        total: number;
      }>();
      assert.equal(states.total, 3, 'root, the approval, and the rollback: history is never rewritten');
      assert.equal(states.states.length, 3);
    },
    { approvalSeparation: 'required' },
  );
});

test('UW-11a: the run manifest records the knowledge state; replay says when that state is missing', async () => {
  await env(async ({ server, ws, defId, data }) => {
    await approveNewSource(server, ws, 'refunds.md', TEXT);
    const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${defId}/readiness`, {})).json<{
      certificateId: string;
    }>();
    const runs = `/workspaces/${ws}/generated-workflows/${defId}/runs`;
    const started = await server.request('POST', runs, { input: { payment_items: items(1) }, certificateId: cert.certificateId });
    assert.ok(started.status === 201 || started.status === 200, started.bodyText);
    const runId = started.json<RunView>().runId;
    const head = (await server.request('GET', `/workspaces/${ws}/knowledge/state`)).json<{ stateId: string }>().stateId;
    const m = (await server.request('GET', `${runs}/${runId}/manifest`)).json<{
      manifest: { knowledge?: { stateId: string; dependencyRoot?: string } };
    }>();
    assert.equal(m.manifest.knowledge?.stateId, head);
    assert.ok(m.manifest.knowledge?.dependencyRoot !== undefined);
    type Replay = { reproducible: boolean; reasons: string[] };
    assert.equal((await server.request('GET', `${runs}/${runId}/replay`)).json<Replay>().reproducible, true);
    // The state file is lost (SQLite holds states by default, so remove the manifest's state by pointing it at a state that does not exist).
    const { readFile, writeFile } = await import('node:fs/promises');
    const file = join(data, ws, 'generated-runs', defId, 'manifests', `${runId}.json`);
    const stored = JSON.parse(await readFile(file, 'utf8')) as { manifest: { knowledge: { stateId: string } }; digest: string };
    const { digestOfJson } = await import('../src/approvals/batch-approval.js');
    stored.manifest.knowledge.stateId = `ks_${'0'.repeat(24)}`;
    stored.digest = digestOfJson(stored.manifest);
    await writeFile(file, JSON.stringify(stored));
    const lost = (await server.request('GET', `${runs}/${runId}/replay`)).json<Replay>();
    assert.equal(lost.reproducible, false);
    assert.ok(lost.reasons.includes('the knowledge state the run was certified against is missing'), lost.reasons.join('; '));
  });
});

test('UW-11a: a viewer cannot propose a rollback (403) and another workspace gets 404', async () => {
  await env(async ({ server, ws }) => {
    assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'viewer-1', role: 'viewer' })).status, 201);
    const viewer = TestServer.authHeader((await server.issueAdditionalIdentity('viewer-1')).apiKey);
    const root = (await server.request('GET', `/workspaces/${ws}/knowledge/state`)).json<{ stateId: string }>().stateId;
    const denied = await server.request('POST', `/workspaces/${ws}/knowledge/rollbacks`, { toStateId: root, reason: 'x' }, viewer);
    assert.equal(denied.status, 403, denied.bodyText);
    const outsider = TestServer.authHeader((await server.issueAdditionalIdentity('outsider-1')).apiKey);
    assert.equal(
      (await server.request('POST', `/workspaces/${ws}/knowledge/rollbacks`, { toStateId: root, reason: 'x' }, outsider)).status,
      404,
    );
    assert.equal((await server.request('GET', `/workspaces/${ws}/knowledge/states`, undefined, outsider)).status, 404);
  });
});
