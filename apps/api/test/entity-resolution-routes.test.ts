/** UW-5 (ADR 0040) — entity resolution over HTTP: author-gated, strict body, claims proposed (not applied), no names in audit. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NonProductionAuditSink } from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';

const schema = { relationship: 'recipient-document', cardinality: 'one_to_one', strongSchemes: { email: 'email' } };
const subjects = [
  { ref: 'r1', name: 'Zubin Marchetti', identifiers: [{ scheme: 'email', value: 'zm@example.org' }] },
  { ref: 'r2', name: 'Qadir Holloway' },
];
const candidates = [
  { ref: 'd1', name: 'Zubin Marchetti.pdf' },
  { ref: 'd2', name: 'Qadir Holloway.pdf' },
];
const ev = { sourceDigestSha256: 'b'.repeat(64), sourceName: 'sheet', locator: { row: 2 } };

test('resolve, propose as claims, approve; unknown fields and viewers are refused; audit holds no names', async () => {
  await withTempDir('xo-api-er-', async (dataDir) => {
    const sink = new NonProductionAuditSink();
    const server = await TestServer.start({ workspaceDataDir: dataDir, auditSink: sink });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const base = `/workspaces/${ws}/entity-resolutions`;
      const r = await server.request('POST', base, { schema, subjects, candidates });
      assert.equal(r.status, 200, r.bodyText);
      const rep = r.json<{ report: { results: { subject: string; outcome: string }[]; unmatchedCandidates: string[]; clean: boolean } }>()
        .report;
      assert.deepEqual(
        rep.results.map((x) => x.outcome),
        ['resolved', 'resolved'],
      );
      assert.equal(rep.clean, true);

      assert.equal((await server.request('POST', base, { schema, subjects, candidates, extra: 1 })).status, 400);
      assert.equal((await server.request('POST', base, { schema: { ...schema, cardinality: 'many' }, subjects, candidates })).status, 400);

      const prop = await server.request('POST', `${base}/proposals`, {
        schema,
        subjects,
        candidates,
        evidence: { r1: ev, d1: ev, r2: ev },
      });
      assert.equal(prop.status, 201, prop.bodyText);
      const p = prop.json<{ changeSet: { changeSetId: string; status: string }; proposed: number }>();
      assert.equal(p.changeSet.status, 'proposed');
      assert.equal(p.proposed, 1, 'only the pair with evidence on both sides becomes a claim');
      const state0 = (await server.request('GET', `/workspaces/${ws}/knowledge/state`)).json<{ entries: unknown[] }>();
      assert.equal(state0.entries.length, 0, 'nothing applied until a reviewer approves');
      const ok = await server.request('POST', `/workspaces/${ws}/knowledge/change-sets/${p.changeSet.changeSetId}/approve`, {
        reason: 'checked',
      });
      assert.equal(ok.status, 200, ok.bodyText);

      const viewer = await server.issueAdditionalIdentity('viewer-er');
      await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'viewer-er', role: 'viewer' });
      const denied = await server.request('POST', base, { schema, subjects, candidates }, TestServer.authHeader(viewer.apiKey));
      assert.equal(denied.status, 403);

      const logs = JSON.stringify(sink.events()) + (await server.request('GET', `/workspaces/${ws}/audit/events`)).bodyText;
      assert.ok(
        sink.events().some((e) => e.type === 'resolution.computed'),
        'the run is audited',
      );
      assert.ok(!/Zubin|Marchetti|Qadir|Holloway|zm@example/.test(logs), 'no names or identifier values in audit');
    } finally {
      await server.stop();
    }
  });
});
