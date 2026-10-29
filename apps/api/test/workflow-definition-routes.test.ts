import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, withTempDir } from './test-helpers.js';
import { analyzeDefinition, parseDefinitionInput } from '../src/workflow-definitions/definition.js';

const as = (k: { apiKey: string }) => TestServer.authHeader(k.apiKey);

// The shape of the PDF's claims-triage editor: trigger -> compile -> validate -> confidence branch -> eligibility | human review.
const triage = () => ({
  name: 'claims-triage',
  nodes: [
    { id: 'claim_pdf', kind: 'trigger', label: 'Claim PDF', config: { type: 'document_dropped' } },
    { id: 'compile', kind: 'compile', config: {} },
    { id: 'validate', kind: 'validate', config: {} },
    { id: 'confidence', kind: 'branch', config: { metric: 'confidence', threshold: 0.9 } },
    {
      id: 'eligibility',
      kind: 'capability',
      config: { packageName: 'burglary-policy', capabilityId: 'evaluateEligibility', memoryScope: 'none' },
    },
    { id: 'human', kind: 'human_review', config: {} },
  ],
  edges: [
    { from: 'claim_pdf', to: 'compile' },
    { from: 'compile', to: 'validate' },
    { from: 'validate', to: 'confidence' },
    { from: 'confidence', to: 'eligibility', when: 'gte' },
    { from: 'confidence', to: 'human', when: 'lt' },
  ],
});

async function withWs<T>(fn: (c: { server: TestServer; base: string }) => Promise<T>): Promise<T> {
  return withTempDir('xo-api-data-', async (dataDir) =>
    withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        return await fn({ server, base: `/workspaces/${ws}/workflow-definitions` });
      } finally {
        await server.stop();
      }
    }),
  );
}

test('save, load, list: a triage graph round-trips with branch threshold, node kinds and memory scope intact', async () => {
  await withWs(async ({ server, base }) => {
    const res = await server.request('POST', base, triage());
    assert.equal(res.status, 201, res.bodyText);
    const d = res.json<{
      definitionId: string;
      revision: number;
      status: string;
      analysis: { wellFormed: boolean; runnable: boolean; errors: unknown[] };
    }>();
    assert.equal(d.revision, 1);
    assert.equal(d.status, 'draft');
    assert.equal(d.analysis.wellFormed, true);
    assert.equal(d.analysis.errors.length, 0);
    assert.equal(d.analysis.runnable, false);

    const got = (await server.request('GET', `${base}/${d.definitionId}`)).json<{
      nodes: { id: string; config: Record<string, unknown> }[];
      edges: { when?: string }[];
    }>();
    assert.equal(got.nodes.find((n) => n.id === 'confidence')?.config['threshold'], 0.9);
    assert.equal(got.nodes.find((n) => n.id === 'eligibility')?.config['memoryScope'], 'none');
    assert.deepEqual(
      got.edges
        .map((e) => e.when)
        .filter(Boolean)
        .sort(),
      ['gte', 'lt'],
    );
    const list = (await server.request('GET', base)).json<{ definitions: { definitionId: string; nodeCount: number }[] }>();
    assert.deepEqual(
      list.definitions.map((x) => [x.definitionId, x.nodeCount]),
      [[d.definitionId, 6]],
    );
  });
});

test('Save is guarded by revision: a stale editor gets 412 and the newer draft survives', async () => {
  await withWs(async ({ server, base }) => {
    const id = (await server.request('POST', base, triage())).json<{ definitionId: string }>().definitionId;
    const v2 = await server.request('PUT', `${base}/${id}`, { ...triage(), name: 'renamed', expectedRevision: 1 });
    assert.equal(v2.status, 200);
    assert.equal(v2.json<{ revision: number }>().revision, 2);
    const stale = await server.request('PUT', `${base}/${id}`, { ...triage(), name: 'stale write', expectedRevision: 1 });
    assert.equal(stale.status, 412);
    assert.equal((await server.request('GET', `${base}/${id}`)).json<{ name: string }>().name, 'renamed');
    assert.equal((await server.request('PUT', `${base}/wfd_${'0'.repeat(32)}`, triage())).status, 404);
  });
});

test('structural problems are reported (not thrown) and never make a draft runnable', () => {
  const t = triage();
  const cyc = analyzeDefinition(parseDefinitionInput({ ...t, edges: [...t.edges, { from: 'human', to: 'compile' }] }));
  assert.ok(cyc.errors.some((e) => /loop/.test(e.message)));
  const oneSided = analyzeDefinition(parseDefinitionInput({ ...t, edges: t.edges.filter((e) => e.when !== 'lt') }));
  assert.ok(oneSided.errors.some((e) => e.nodeId === 'confidence' && /exactly two/.test(e.message)));
  assert.ok(oneSided.errors.some((e) => e.nodeId === 'human' && /not connected/.test(e.message)));
  const noTrigger = analyzeDefinition(parseDefinitionInput({ name: 'x', nodes: [{ id: 'a', kind: 'compile', config: {} }], edges: [] }));
  assert.ok(noTrigger.errors.some((e) => /at least one trigger/.test(e.message)));
  const stray = analyzeDefinition(
    parseDefinitionInput({ ...t, edges: t.edges.map((e) => (e.from === 'compile' ? { ...e, when: 'gte' } : e)) }),
  );
  assert.ok(stray.errors.some((e) => e.nodeId === 'compile' && /only valid on connections leaving a branch/.test(e.message)));
  for (const a of [cyc, oneSided, noTrigger, stray]) assert.equal(a.wellFormed, false);
});

test('blockers say exactly why a well-formed graph still cannot run here', () => {
  const t = triage();
  const withExtras = parseDefinitionInput({
    ...t,
    nodes: [
      ...t.nodes.map((n) =>
        n.id === 'claim_pdf'
          ? { ...n, config: { type: 'schedule' } }
          : n.id === 'eligibility'
            ? { ...n, config: { ...n.config, memoryScope: 'workflow' } }
            : n,
      ),
      { id: 'notify', kind: 'action', config: { type: 'email' } },
    ],
    edges: [...t.edges, { from: 'human', to: 'notify' }],
  });
  const a = analyzeDefinition(withExtras);
  assert.equal(a.wellFormed, true);
  const text = a.blockers.map((b) => b.message).join(' | ');
  assert.doesNotMatch(text, /no executor/, 'the blanket "no executor" blocker is gone; only concrete reasons remain');
  assert.equal(a.runnable, false);
  assert.match(text, /no scheduler/);
  assert.match(text, /no email delivery/);
  assert.match(text, /memory scopes are not part of the runtime/);
});

test('input validation rejects unknown fields, bad enums, bad thresholds, duplicate ids, dangling edges and oversize graphs', async () => {
  await withWs(async ({ server, base }) => {
    const post = (b: unknown) => server.request('POST', base, b);
    const t = triage();
    assert.equal((await post({ ...t, surprise: 1 })).status, 400);
    assert.equal((await post({ ...t, name: '' })).status, 400);
    assert.equal((await post({ ...t, nodes: [] })).status, 400);
    assert.equal((await post({ ...t, nodes: [...t.nodes, { id: 'compile', kind: 'compile', config: {} }] })).status, 400, 'duplicate id');
    assert.equal(
      (
        await post({
          ...t,
          nodes: t.nodes.map((n) => (n.id === 'confidence' ? { ...n, config: { metric: 'confidence', threshold: 1.5 } } : n)),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post({
          ...t,
          nodes: t.nodes.map((n) => (n.id === 'confidence' ? { ...n, config: { metric: 'sentiment', threshold: 0.5 } } : n)),
        })
      ).status,
      400,
    );
    assert.equal((await post({ ...t, nodes: t.nodes.map((n) => (n.id === 'compile' ? { ...n, kind: 'shell' } : n)) })).status, 400);
    assert.equal(
      (await post({ ...t, nodes: t.nodes.map((n) => (n.id === 'compile' ? { ...n, config: { command: 'rm -rf /' } } : n)) })).status,
      400,
      'no free-form config on fixed nodes',
    );
    assert.equal((await post({ ...t, edges: [...t.edges, { from: 'compile', to: 'ghost' }] })).status, 400);
    assert.equal((await post({ ...t, edges: [{ from: 'compile', to: 'compile' }] })).status, 400);
    assert.equal((await post({ ...t, nodes: t.nodes.map((n) => (n.id === 'eligibility' ? { ...n, id: 'bad id!' } : n)) })).status, 400);
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `n${i}`, kind: 'compile', config: {} }));
    assert.equal((await post({ name: 'big', nodes: many, edges: [] })).status, 400);
    assert.equal(
      (await server.request('GET', base)).json<{ definitions: unknown[] }>().definitions.length,
      0,
      'nothing was stored by the rejected requests',
    );
  });
});

test('validate endpoint does not save; run is an honest 501 with the reasons', async () => {
  await withWs(async ({ server, base }) => {
    const v = await server.request('POST', `${base}/validate`, triage());
    assert.equal(v.status, 200);
    assert.equal(v.json<{ wellFormed: boolean }>().wellFormed, true);
    assert.equal((await server.request('GET', base)).json<{ definitions: unknown[] }>().definitions.length, 0);

    const id = (await server.request('POST', base, triage())).json<{ definitionId: string }>().definitionId;
    const run = await server.request('POST', `${base}/${id}/run`, {});
    assert.equal(run.status, 501);
    assert.ok(run.json<{ analysis: { blockers: unknown[] } }>().analysis.blockers.length > 0);
  });
});

test('permissions, deletion and audit', async () => {
  await withWs(async ({ server, base }) => {
    const viewer = await server.issueAdditionalIdentity('v');
    const wsBase = base.replace('/workflow-definitions', '');
    await server.request('POST', `${wsBase}/members`, { identityId: 'v', role: 'viewer' });
    assert.equal((await server.request('POST', base, triage(), as(viewer))).status, 403);
    const id = (await server.request('POST', base, triage())).json<{ definitionId: string }>().definitionId;
    assert.equal((await server.request('GET', `${base}/${id}`, undefined, as(viewer))).status, 200, 'viewers can open a workflow');
    assert.equal((await server.request('DELETE', `${base}/${id}`, undefined, as(viewer))).status, 403);
    assert.equal((await server.request('DELETE', `${base}/${id}`)).status, 200);
    assert.equal((await server.request('GET', `${base}/${id}`)).status, 404);
    const events = (await server.request('GET', `${wsBase}/audit/events`))
      .json<{ events: { event: string }[] }>()
      .events.map((e) => e.event);
    assert.ok(events.includes('workflow.definition_saved') && events.includes('workflow.definition_deleted'));
  });
});
