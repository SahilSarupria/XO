import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LocalFsBlobStore } from '@xo/storage';
import { establishAuthenticatedPrincipal, type AuthenticatedPrincipal } from '@xo/permissions';
import { TestServer, withTempDir } from './test-helpers.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { FsExecutionStore } from '../src/executions/fs-execution-store.js';
import { FsWorkflowExecutionStore } from '../src/workflows/fs-workflow-execution-store.js';
import { resolveHumanTaskExecution } from '../src/executions/resolve-human-task.js';
import { FsCompilationStore } from '../src/compilations/fs-compilation-store.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

// P1.0 M1 — principal & identity foundation: authentication mapping, override resistance,
// propagation into execution / workflow / HITL records, and fail-closed behaviour.

const PDF = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));
const DET = 'cap_rule_0f731679e7120779542267faaabe10ff';
const HITL = 'cap_ce5ac3d1b7e3d22d184b1d089f8c3522';

interface PrincipalWire { readonly kind: string; readonly id: string; readonly orgId?: string }
interface ExecWire {
  readonly executionId: string; readonly identityId: string; readonly capabilityId: string;
  readonly initiator?: PrincipalWire; readonly status: string;
  readonly humanTask?: { readonly status: string; readonly resolverIdentityId?: string; readonly resolver?: PrincipalWire };
}

function principal(kind: 'human' | 'service', id: string, orgId?: string): AuthenticatedPrincipal {
  const r = establishAuthenticatedPrincipal({ kind, id, ...(orgId !== undefined ? { orgId } : {}) });
  if (!r.ok) throw r.error;
  return r.value;
}

async function setup(server: TestServer): Promise<{ workspace: WorkspaceRecord; compilationId: string }> {
  const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
  const bytes = await readFile(PDF);
  const src = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=policy.pdf`, bytes)).json<{ sourceId: string }>();
  const comp = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/${src.sourceId}/compile`)).json<{ compilationId: string; status: string }>();
  assert.equal(comp.status, 'succeeded');
  return { workspace, compilationId: comp.compilationId };
}

async function approve(server: TestServer, ws: string, comp: string, cap: string): Promise<void> {
  const r = await server.request('POST', `/workspaces/${ws}/compilations/${comp}/capabilities/${cap}/approve`);
  assert.equal(r.status, 200);
}

// ---------- Authentication mapping ----------

test('a key bound to a principal authenticates; the execution is attributed to exactly that principal (kind, id, orgId)', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const key = generateApiKey();
      const created = await server.apiKeyStore.create({ keyHash: hashApiKey(key), identityId: 'alice', principalKind: 'human', orgId: 'org.acme', createdAt: new Date().toISOString() });
      assert.equal(created.ok, true);
      const h = TestServer.authHeader(key);
      const workspace = (await server.request('POST', '/workspaces', {}, h)).json<WorkspaceRecord>();
      const bytes = await readFile(PDF);
      const src = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=policy.pdf`, bytes, h)).json<{ sourceId: string }>();
      const comp = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/${src.sourceId}/compile`, undefined, h)).json<{ compilationId: string }>();
      await server.request('POST', `/workspaces/${workspace.workspaceId}/compilations/${comp.compilationId}/capabilities/${DET}/approve`, undefined, h);
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions`, { compilationId: comp.compilationId, capabilityId: DET, input: { claim_amount: 1, loss: 'fire' } }, h);
      assert.equal(res.status, 201);
      const rec = res.json<ExecWire>();
      assert.deepEqual(rec.initiator, { kind: 'human', id: 'alice', orgId: 'org.acme' });
      assert.equal(rec.identityId, 'alice');
      assert.notEqual(rec.initiator?.id, rec.capabilityId); // capability id is never the principal
      // persisted, and read back identically
      const got = (await server.request('GET', `/workspaces/${workspace.workspaceId}/executions/${rec.executionId}`, undefined, h)).json<ExecWire>();
      assert.deepEqual(got.initiator, rec.initiator);
    } finally {
      await server.stop();
    }
  });
});

test('a key record with no principal kind (legacy) fails closed with 401 and gains nothing; the error never contains the key', async () => {
  const server = await TestServer.start();
  try {
    const key = generateApiKey();
    await server.apiKeyStore.create({ keyHash: hashApiKey(key), identityId: 'legacy', createdAt: new Date().toISOString() });
    const res = await server.request('GET', '/workspaces', undefined, TestServer.authHeader(key));
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.bodyText, new RegExp(key));
    assert.match(res.bodyText, /principal/);
  } finally {
    await server.stop();
  }
});

test('a key record with an invalid principal (bad kind / malformed orgId / unsafe id) fails closed with 401', async () => {
  const server = await TestServer.start();
  try {
    const bad = [
      { identityId: 'x1', principalKind: 'admin' },
      { identityId: 'x2', principalKind: 'human', orgId: '../o' },
      { identityId: 'bad/id', principalKind: 'service' },
    ];
    for (const b of bad) {
      const key = generateApiKey();
      await server.apiKeyStore.create({ keyHash: hashApiKey(key), createdAt: new Date().toISOString(), ...b } as never);
      const res = await server.request('GET', '/workspaces', undefined, TestServer.authHeader(key));
      assert.equal(res.status, 401, JSON.stringify(b));
      assert.doesNotMatch(res.bodyText, new RegExp(key));
    }
  } finally {
    await server.stop();
  }
});

test('invalid, missing, and revoked credentials produce no principal (401) and do not echo the credential', async () => {
  const server = await TestServer.start();
  try {
    const bogus = generateApiKey();
    const invalid = await server.request('GET', '/workspaces', undefined, TestServer.authHeader(bogus));
    assert.equal(invalid.status, 401);
    assert.doesNotMatch(invalid.bodyText, new RegExp(bogus));
    assert.equal((await server.request('GET', '/workspaces', undefined, {}, { skipAuth: true })).status, 401);
    const extra = await server.issueAdditionalIdentity('to-revoke');
    assert.equal((await server.apiKeyStore.revokeByIdentity('to-revoke')).ok, true);
    const revoked = await server.request('GET', '/workspaces', undefined, TestServer.authHeader(extra.apiKey));
    assert.equal(revoked.status, 401);
    assert.doesNotMatch(revoked.bodyText, new RegExp(extra.apiKey));
  } finally {
    await server.stop();
  }
});

test('client-supplied identity (headers, query, body) cannot override the authenticated principal', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const { workspace, compilationId } = await setup(server);
      await approve(server, workspace.workspaceId, compilationId, DET);
      const forged = { 'x-xo-principal': 'mallory', 'x-xo-principal-id': 'mallory', 'x-xo-identity': 'mallory', 'x-xo-org-id': 'evil', 'x-xo-principal-kind': 'human', 'x-forwarded-user': 'mallory' };
      const res = await server.request(
        'POST',
        `/workspaces/${workspace.workspaceId}/executions?principal=mallory&identityId=mallory&orgId=evil`,
        { compilationId, capabilityId: DET, input: { claim_amount: 1, loss: 'fire' }, identityId: 'mallory', initiator: { kind: 'human', id: 'mallory', orgId: 'evil' }, principal: { kind: 'human', id: 'mallory' } },
        forged,
      );
      assert.equal(res.status, 201);
      const rec = res.json<ExecWire>();
      assert.deepEqual(rec.initiator, { kind: 'service', id: server.identityId });
      assert.equal(rec.identityId, server.identityId);
      assert.doesNotMatch(res.bodyText, /mallory/);
    } finally {
      await server.stop();
    }
  });
});

// ---------- Propagation ----------

test('HITL: initiator is preserved on resolve; the resolver is recorded separately and never replaces it', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const { workspace, compilationId } = await setup(server);
      await approve(server, workspace.workspaceId, compilationId, HITL);
      const exec = (await server.request('POST', `/workspaces/${workspace.workspaceId}/executions`, { compilationId, capabilityId: HITL, input: {} })).json<ExecWire>();
      assert.equal(exec.status, 'waiting_for_human');
      assert.deepEqual(exec.initiator, { kind: 'service', id: server.identityId });

      const resolved = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions/${exec.executionId}/resolve`, { decision: 'approve', data: {}, resolver: { kind: 'human', id: 'mallory' }, resolverIdentityId: 'mallory', initiator: { kind: 'human', id: 'mallory' } });
      assert.equal(resolved.status, 200);
      const rec = resolved.json<ExecWire>();
      assert.deepEqual(rec.initiator, { kind: 'service', id: server.identityId }); // unchanged
      assert.deepEqual(rec.humanTask?.resolver, { kind: 'service', id: server.identityId }); // from the authenticated request, not the body
      assert.equal(rec.humanTask?.resolverIdentityId, server.identityId);
      assert.doesNotMatch(resolved.bodyText, /mallory/);
    } finally {
      await server.stop();
    }
  });
});

test('HITL at the service layer: a different authenticated resolver is recorded as resolver; the original initiator survives', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const { workspace, compilationId } = await setup(server);
      await approve(server, workspace.workspaceId, compilationId, HITL);
      const exec = (await server.request('POST', `/workspaces/${workspace.workspaceId}/executions`, { compilationId, capabilityId: HITL, input: {} })).json<ExecWire>();
      const store = new FsExecutionStore(new LocalFsBlobStore(`${dataDir}/${workspace.workspaceId}/executions`));
      const comps = new FsCompilationStore(new LocalFsBlobStore(`${dataDir}/${workspace.workspaceId}/compilations`));

      // A fabricated / deserialized "principal" cannot resolve.
      await assert.rejects(resolveHumanTaskExecution(store, comps, exec.executionId, 'approve', {}, { kind: 'human', id: 'forged' } as unknown as AuthenticatedPrincipal));

      const out = await resolveHumanTaskExecution(store, comps, exec.executionId, 'approve', {}, principal('human', 'reviewer-bob', 'org.acme'));
      assert.equal(out.kind, 'resolved');
      if (out.kind === 'resolved') {
        assert.deepEqual({ ...out.record.initiator }, { kind: 'service', id: server.identityId });
        assert.deepEqual({ ...out.record.humanTask?.resolver }, { kind: 'human', id: 'reviewer-bob', orgId: 'org.acme' });
        assert.equal(out.record.identityId, server.identityId);
      }
    } finally {
      await server.stop();
    }
  });
});

test('stores refuse a non-authenticated principal (no fabricated identity, no default)', async () => {
  await withTempDir('xo-api-data-', async (dir) => {
    const exec = new FsExecutionStore(new LocalFsBlobStore(`${dir}/e`));
    const wf = new FsWorkflowExecutionStore(new LocalFsBlobStore(`${dir}/w`));
    const forged = { kind: 'human', id: 'x' } as unknown as AuthenticatedPrincipal;
    for (const bad of [forged, undefined as unknown as AuthenticatedPrincipal, 'ident_x' as unknown as AuthenticatedPrincipal]) {
      await assert.rejects(exec.create('ws', bad, { compilationId: 'c', capabilityId: 'k', input: {} }));
      await assert.rejects(wf.create('ws', bad, { workflowExecutionId: 'wfx_00000000000000000000000000000002', compilationId: 'c', workflowId: 'w', workflowName: 'w', input: {}, steps: [] } as never));
    }
    assert.equal((await exec.list()).ok && (await exec.list()).ok, true);
    const listed = await exec.list();
    assert.deepEqual(listed.ok ? listed.value : null, []);
  });
});

test('workflow record carries the initiating principal (snapshot, not authenticated)', async () => {
  await withTempDir('xo-api-data-', async (dir) => {
    const wf = new FsWorkflowExecutionStore(new LocalFsBlobStore(dir));
    const created = await wf.create('ws_x', principal('service', 'svc-1', 'org.acme'), { workflowExecutionId: 'wfx_00000000000000000000000000000001', compilationId: 'c', workflowId: 'w', workflowName: 'w', input: {}, steps: [{ stepId: 's#0', order: 0, capabilityId: 'cap_x', capabilityName: 'x' }] });
    assert.ok(created.ok);
    if (created.ok) {
      assert.deepEqual({ ...created.value.initiator }, { kind: 'service', id: 'svc-1', orgId: 'org.acme' });
      assert.equal(created.value.identityId, 'svc-1');
    }
  });
});

// ---------- Compatibility / security ----------

test('workspace isolation is intact: another authenticated principal still gets the uniform 404, and a principal confers no new permission', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const { workspace, compilationId } = await setup(server);
      const other = await server.issueAdditionalIdentity('identity-b');
      const h = TestServer.authHeader(other.apiKey);
      const ws = await server.request('GET', `/workspaces/${workspace.workspaceId}`, undefined, h);
      const missing = await server.request('GET', `/workspaces/ws_nope`, undefined, h);
      assert.equal(ws.status, 404);
      assert.equal(missing.status, 404);
      assert.equal(ws.bodyText.replace(workspace.workspaceId, 'X'), missing.bodyText.replace('ws_nope', 'X'));
      // Having a principal does not approve anything: unapproved execution is still refused.
      const refused = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions`, { compilationId, capabilityId: DET, input: {} });
      assert.equal(refused.status, 403);
    } finally {
      await server.stop();
    }
  });
});

test('AI execution stays disabled: /runtime/execute is 501 even for a fully authenticated principal', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/runtime/execute`, { input: 'x', query: 'q' }, { 'x-xo-provider': 'ollama', 'x-xo-model': 'm' });
      assert.equal(res.status, 501);
    } finally {
      await server.stop();
    }
  });
});
