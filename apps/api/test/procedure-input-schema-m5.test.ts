import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Permissions, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { NonProductionAuditSink } from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import { FsCompilationStore } from '../src/compilations/fs-compilation-store.js';
import { compilationLoaderFromStore } from '../src/procedures/registry-validation.js';
import { workspaceCompilationsStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

// P1.1 M5 — GET /procedures/:id reports the server-derived start-input schema of an APPROVED version (read-only metadata for the
// stdio MCP adapter). It is derived from the registry snapshot and compiled graph, never from client text, and it grants nothing.
// FIXTURE: the hand-built P0.8 XOIR graph (see procedure-execution.test.ts).

const grant = (id: string, permission: string): PolicyRule => ({
  id,
  effect: 'ALLOW',
  match: { permission: permission as never, principalId: 'test-identity' },
});
const GRANTS = [
  grant('author', Permissions.procedure.author),
  grant('approve', Permissions.procedure.approve),
  grant('read', Permissions.procedure.read),
  grant('execute', Permissions.procedure.execute),
];

interface Env {
  readonly server: TestServer;
  readonly sink: NonProductionAuditSink;
  readonly dataDir: string;
  readonly workspacesDir: string;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
  readonly graphHash: string;
}
const CAPS = [IDS.xsegA, IDS.xsegH, IDS.xsegC, IDS.flowB];

async function withEnv(fn: (env: Env) => Promise<void>, rules: readonly PolicyRule[] = GRANTS, approveCaps = true): Promise<void> {
  await withTempDir('xo-m5s-data-', async (dataDir) => {
    await withTempDir('xo-m5s-ws-', async (workspacesDir) => {
      const sink = new NonProductionAuditSink();
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: sink,
        permissionPolicy: new RuleBasedPolicy([...rules]),
      });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        const loaded = await compilationLoaderFromStore(
          new FsCompilationStore(workspaceCompilationsStore(workspace, { dataRootDir: dataDir })),
        )(compilationId);
        assert.ok(loaded);
        const env: Env = { server, sink, dataDir, workspacesDir, workspace, compilationId, graphHash: loaded.graphHash };
        if (approveCaps) for (const cap of CAPS) await approveCapability(env, cap);
        await fn(env);
      } finally {
        await server.stop();
      }
    });
  });
}

const base = (env: Env): string => `/workspaces/${env.workspace.workspaceId}`;
const approveCapability = async (env: Env, capabilityId: string): Promise<void> => {
  const res = await env.server.request('POST', `${base(env)}/compilations/${env.compilationId}/capabilities/${capabilityId}/approve`);
  assert.ok(res.status === 200 || res.status === 201, `approve ${capabilityId} -> ${res.status} ${res.bodyText}`);
};

/** a (xsegA) -> d (matched?) -> h (human review) -> c (settle) | x (flowB). All input-bound parameters are declared up front. */
function vertical(env: Env, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'xo.procedure/1',
    procedureId: 'intake-review',
    version: 1,
    compilationRef: { compilationId: env.compilationId, graphHash: env.graphHash },
    steps: [
      {
        id: 'a',
        kind: 'capability',
        capabilityId: IDS.xsegA,
        basis: 'source_proven',
        next: 'd',
        inputBindings: [{ param: 'intake score', from: { input: 'intake_score' }, bindingStatus: 'proven' }],
      },
      { id: 'd', kind: 'decision', condition: { path: 'steps.a.output.matched', op: 'eq', value: true }, then: 'h', else: 'x' },
      { id: 'h', kind: 'capability', capabilityId: IDS.xsegH, basis: 'source_proven', next: 'c' },
      {
        id: 'c',
        kind: 'capability',
        capabilityId: IDS.xsegC,
        basis: 'source_proven',
        inputBindings: [
          { param: 'matched', from: { step: 'a', output: 'matched' }, bindingStatus: 'proven' },
          { param: 'review amount', from: { input: 'review_amount' }, bindingStatus: 'proven' },
        ],
      },
      {
        id: 'x',
        kind: 'capability',
        capabilityId: IDS.flowB,
        basis: 'source_proven',
        inputBindings: [
          { param: 'matched', from: { step: 'a', output: 'matched' }, bindingStatus: 'proven' },
          { param: 'payout amount', from: { input: 'payout_amount' }, bindingStatus: 'proven' },
        ],
      },
    ],
    ...over,
  };
}

async function publish(env: Env, doc: Record<string, unknown>, ack?: string): Promise<void> {
  const id = doc['procedureId'] as string;
  const v = doc['version'] as number;
  const put = await env.server.request('PUT', `${base(env)}/procedures/${id}/versions/${v}`, doc);
  assert.equal(put.status, 201, put.bodyText);
  const ap = await env.server.request(
    'POST',
    `${base(env)}/procedures/${id}/versions/${v}/approve`,
    ack === undefined ? undefined : { acknowledgment: ack },
  );
  assert.equal(ap.status, 200, ap.bodyText);
}

const detail = async (env: Env, id: string, v: number): Promise<Record<string, unknown>> => {
  const res = await env.server.request('GET', `${base(env)}/procedures/${id}?version=${v}`);
  assert.equal(res.status, 200, res.bodyText);
  return res.json<Record<string, unknown>>();
};

test('M5: an APPROVED version reports a closed input schema derived from the registry; a DRAFT reports none', async () => {
  await withEnv(async (env) => {
    const draftDoc = { ...vertical(env), procedureId: 'draft-flow' };
    assert.equal((await env.server.request('PUT', `${base(env)}/procedures/draft-flow/versions/1`, draftDoc)).status, 201);
    await publish(env, vertical(env));
    const approved = await detail(env, 'intake-review', 1);
    assert.equal(approved['lifecycle'], 'approved');
    const schema = approved['inputSchema'] as {
      type: string;
      properties: Record<string, { type: string }>;
      required: string[];
      additionalProperties: boolean;
    };
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), ['intake_score', 'payout_amount', 'review_amount']);
    for (const p of Object.values(schema.properties)) assert.ok(['string', 'number', 'boolean'].includes(p.type));
    assert.ok(schema.required.every((r) => r in schema.properties));
    const draft = await detail(env, 'draft-flow', 1);
    assert.equal(draft['lifecycle'], 'draft');
    assert.equal('inputSchema' in draft, false, 'a draft is never advertised as callable');
  });
});

test('M5: the reported schema is exactly what start accepts (a value of each declared type starts the execution; an extra key does not)', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const schema = (await detail(env, 'intake-review', 1))['inputSchema'] as { properties: Record<string, { type: string }> };
    const sample: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties)) sample[k] = v.type === 'number' ? 1 : v.type === 'boolean' ? true : 'x';
    const ok = await env.server.request('POST', `${base(env)}/procedures/intake-review/versions/1/executions`, { input: sample });
    assert.ok(ok.status === 200 || ok.status === 201, ok.bodyText);
    const bad = await env.server.request('POST', `${base(env)}/procedures/intake-review/versions/1/executions`, {
      input: { ...sample, extra: 1 },
    });
    assert.equal(bad.status, 400);
  });
});

test('M5: the procedure listing never carries schemas (they are per-version detail metadata)', async () => {
  await withEnv(async (env) => {
    await publish(env, vertical(env));
    const listing = await env.server.request('GET', `${base(env)}/procedures`);
    assert.equal(listing.status, 200);
    assert.equal(listing.bodyText.includes('inputSchema'), false);
  });
});
