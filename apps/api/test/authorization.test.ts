import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  establishAuthenticatedPrincipal,
  Permissions,
  RuleBasedPolicy,
  PermissionManager,
  type AuthenticatedPrincipal,
  type PermissionPolicy,
  type PolicyRule,
} from '@xo/permissions';
import { toJson } from '@xo/xoir';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, buildFixtureGraph, storeFixtureCompilation } from './workflow-fixtures.js';
import { executeApprovedCapability, resumeCapabilityExecution } from '../src/executions/execute-capability.js';
import { FsExecutionStore } from '../src/executions/fs-execution-store.js';
import { workspaceExecutionsStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

// P1.0 M2 — authorization on the API execution, workflow and human-task paths.

interface ErrorWire {
  readonly error: { readonly code: string; readonly message: string };
}
const FILE = Permissions.filesystem.read;

const principal = (id: string, kind: 'human' | 'service' = 'human'): AuthenticatedPrincipal => {
  const r = establishAuthenticatedPrincipal({ kind, id });
  if (!r.ok) throw r.error;
  return r.value;
};
const authz = (rules: readonly PolicyRule[], subject: AuthenticatedPrincipal = principal('alice')) => ({
  subject,
  permissionManager: new PermissionManager({ policy: new RuleBasedPolicy(rules) }),
});
const grant = (principalId: string, permission = FILE): PolicyRule => ({
  id: `grant-${principalId}-${permission}`,
  effect: 'ALLOW',
  match: { permission, principalId },
});

interface Env {
  readonly server: TestServer;
  readonly dataDir: string;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
}

async function withEnv(policy: PermissionPolicy | undefined, fn: (env: Env) => Promise<void>): Promise<void> {
  await withTempDir('xo-m2-data-', async (dataDir) => {
    await withTempDir('xo-m2-ws-', async (workspacesDir) => {
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        ...(policy !== undefined ? { permissionPolicy: policy } : {}),
      });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        await fn({ server, dataDir, workspace, compilationId });
      } finally {
        await server.stop();
      }
    });
  });
}

const ws = (env: Env, suffix: string) => `/workspaces/${env.workspace.workspaceId}${suffix}`;
async function approve(env: Env, cap: string) {
  const r = await env.server.request('POST', ws(env, `/compilations/${env.compilationId}/capabilities/${cap}/approve`));
  assert.ok(r.status === 200 || r.status === 201, r.bodyText);
}
async function workflowIdFor(env: Env, first: string): Promise<string> {
  const list = (await env.server.request('GET', ws(env, '/workflows'))).json<{
    workflows: { workflowId: string; steps: { capabilityId: string }[] }[];
  }>().workflows;
  const found = list.find((w) => w.steps[0]?.capabilityId === first);
  assert.ok(found);
  return found.workflowId;
}
const startWorkflow = async (
  env: Env,
  first: string,
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  env.server.request(
    'POST',
    ws(env, `/workflows/${await workflowIdFor(env, first)}/executions`),
    { compilationId: env.compilationId, input, ...extra },
    headers,
  );
const listExecutions = async (env: Env) =>
  (await env.server.request('GET', ws(env, '/executions'))).json<{ executions: unknown[] }>().executions;
const listWorkflowExecutions = async (env: Env) =>
  (await env.server.request('GET', ws(env, '/workflow-executions'))).json<{ workflowExecutions: unknown[] }>().workflowExecutions;

// ── Policy comes from the server; a principal alone grants nothing ──

test('API workflow: authenticated principal with no applicable rule is denied before anything is created', async () => {
  await withEnv(undefined, async (env) => {
    await approve(env, IDS.perm);
    const res = await startWorkflow(env, IDS.perm, { file_size: 50 });
    assert.equal(res.status, 403, res.bodyText);
    assert.equal(res.json<ErrorWire>().error.code, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.equal((await listExecutions(env)).length, 0);
    assert.equal((await listWorkflowExecutions(env)).length, 0);
  });
});

test('API workflow: a rule granting the declared permission to THIS principal authorizes the workflow', async () => {
  await withEnv(new RuleBasedPolicy([grant('test-identity')]), async (env) => {
    await approve(env, IDS.perm);
    const res = await startWorkflow(env, IDS.perm, { file_size: 50 });
    assert.ok(res.status === 200 || res.status === 201, res.bodyText);
    assert.ok((await listExecutions(env)).length >= 1);
  });
});

test('API workflow: a grant for a DIFFERENT principal, a different permission, or a different capability does not authorize', async () => {
  const cases: PolicyRule[] = [
    grant('someone-else'),
    grant('test-identity', Permissions.network.connect),
    { id: 'wrong-cap', effect: 'ALLOW', match: { permission: FILE, principalId: 'test-identity', capabilityId: 'cap_other' } },
  ];
  for (const rule of cases) {
    await withEnv(new RuleBasedPolicy([rule]), async (env) => {
      await approve(env, IDS.perm);
      const res = await startWorkflow(env, IDS.perm, { file_size: 50 });
      assert.equal(res.status, 403, `${rule.id}: ${res.bodyText}`);
      assert.equal((await listExecutions(env)).length, 0);
    });
  }
});

test('API workflow: orgId is a label — a rule naming another principal never matches by org', async () => {
  await withEnv(new RuleBasedPolicy([grant('org.acme')]), async (env) => {
    await approve(env, IDS.perm);
    assert.equal((await startWorkflow(env, IDS.perm, { file_size: 50 })).status, 403);
  });
});

// ── Forgery: nothing the client sends is authority ──

test('API: forged identity / permission claims (body fields, headers) cannot elevate authority', async () => {
  await withEnv(undefined, async (env) => {
    await approve(env, IDS.perm);
    const forgedHeaders = { 'x-xo-principal': 'admin', 'x-xo-identity': 'admin', 'x-xo-permissions': FILE, 'x-xo-grant': FILE };
    for (const extra of [
      { permissions: [FILE] },
      { grant: [FILE] },
      { principal: { kind: 'service', id: 'admin' } },
      { requiredPermissions: [] },
      { identityId: 'admin' },
    ]) {
      const res = await startWorkflow(env, IDS.perm, { file_size: 50 }, extra, forgedHeaders);
      assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(extra)} -> ${res.status} ${res.bodyText}`);
    }
    assert.equal((await listExecutions(env)).length, 0);
    assert.equal((await listWorkflowExecutions(env)).length, 0);
  });
});

test('API execution route: forged body fields cannot grant a permission; permission-free capability still needs (and records) the authenticated principal', async () => {
  await withEnv(undefined, async (env) => {
    await approve(env, IDS.flowA);
    const res = await env.server.request(
      'POST',
      ws(env, '/executions'),
      {
        compilationId: env.compilationId,
        capabilityId: IDS.flowA,
        input: { claim_amount: 15000 },
        principal: { kind: 'human', id: 'admin' },
        permissions: [FILE],
        grant: [FILE],
      },
      { 'x-xo-principal': 'admin' },
    );
    assert.ok(res.status === 200 || res.status === 201, res.bodyText);
    const rec = res.json<{ initiator?: { id: string; kind: string }; status: string }>();
    assert.equal(rec.initiator?.id, 'test-identity');
    assert.equal(rec.status, 'succeeded');
  });
});

test('API execution route: an unauthenticated request never reaches execution', async () => {
  await withEnv(undefined, async (env) => {
    await approve(env, IDS.flowA);
    const res = await env.server.request(
      'POST',
      ws(env, '/executions'),
      { compilationId: env.compilationId, capabilityId: IDS.flowA, input: { claim_amount: 15000 } },
      {},
      { skipAuth: true },
    );
    assert.equal(res.status, 401);
    assert.equal((await listExecutions(env)).length, 0);
  });
});

test('API workspace isolation: another identity cannot start or see a permitted workflow (uniform 404), even with a grant of its own', async () => {
  await withEnv(new RuleBasedPolicy([grant('test-identity'), grant('intruder')]), async (env) => {
    await approve(env, IDS.perm);
    const other = await env.server.issueAdditionalIdentity('intruder');
    const wfId = await workflowIdFor(env, IDS.perm);
    const res = await env.server.request(
      'POST',
      ws(env, `/workflows/${wfId}/executions`),
      { compilationId: env.compilationId, input: { file_size: 50 } },
      TestServer.authHeader(other.apiKey),
    );
    assert.equal(res.status, 404, res.bodyText);
    assert.equal((await listExecutions(env)).length, 0);
  });
});

// ── Direct function-level boundary: declaration metadata and subject ──

function graphJsonWith(capabilityId: string, mutate: (props: Record<string, unknown>) => void): unknown {
  const json = JSON.parse(JSON.stringify(toJson(buildFixtureGraph()))) as { nodes: { id: string; properties: Record<string, unknown> }[] };
  const node = json.nodes.find((n) => n.id === capabilityId);
  assert.ok(node);
  mutate(node.properties);
  return json;
}

test('execute: explicit [] declaration + authenticated principal executes', async () => {
  const out = await executeApprovedCapability(toJson(buildFixtureGraph()), IDS.flowA, { claim_amount: 15000 }, authz([]));
  assert.equal(out.kind, 'succeeded');
});

test('execute: missing / null / malformed / unknown-id requiredPermissions on the node is denied, never treated as permission-free', async () => {
  const variants: [string, (p: Record<string, unknown>) => void][] = [
    [
      'missing',
      (p) => {
        delete p['requiredPermissions'];
      },
    ],
    [
      'null',
      (p) => {
        p['requiredPermissions'] = null;
      },
    ],
    [
      'string',
      (p) => {
        p['requiredPermissions'] = 'filesystem.read';
      },
    ],
    [
      'non-string entry',
      (p) => {
        p['requiredPermissions'] = [1];
      },
    ],
    [
      'invalid id',
      (p) => {
        p['requiredPermissions'] = ['NOT A PERMISSION'];
      },
    ],
  ];
  for (const [label, mutate] of variants) {
    // an allow-everything policy must not rescue an unresolved declaration
    const out = await executeApprovedCapability(
      graphJsonWith(IDS.flowA, mutate),
      IDS.flowA,
      { claim_amount: 15000 },
      authz([{ id: 'all', effect: 'ALLOW', match: {} }]),
    );
    assert.equal(out.kind, 'error', label);
    if (out.kind === 'error') assert.equal(out.errorCode, 'XO_RUNTIME_PERMISSION_DENIED', label);
  }
});

test('execute: declared permission — denied without a rule, allowed with a principal-scoped rule, denied for another principal', async () => {
  const graph = toJson(buildFixtureGraph());
  const input = { file_size: 50 };
  const denied = await executeApprovedCapability(graph, IDS.perm, input, authz([]));
  assert.equal(denied.kind, 'error');
  const allowed = await executeApprovedCapability(graph, IDS.perm, input, authz([grant('alice')]));
  assert.equal(allowed.kind, 'succeeded');
  const other = await executeApprovedCapability(graph, IDS.perm, input, authz([grant('alice')], principal('bob')));
  assert.equal(other.kind, 'error');
});

test('execute: a fabricated / deserialized / structurally-copied subject is denied (no principal => no execution)', async () => {
  const graph = toJson(buildFixtureGraph());
  const manager = new PermissionManager({ policy: new RuleBasedPolicy([{ id: 'all', effect: 'ALLOW', match: {} }]) });
  for (const subject of [
    undefined,
    { kind: 'human', id: 'alice' },
    { ...principal('alice') },
    JSON.parse(JSON.stringify(principal('alice'))),
    'alice',
  ]) {
    const out = await executeApprovedCapability(
      graph,
      IDS.flowA,
      { claim_amount: 15000 },
      { subject: subject as never, permissionManager: manager },
    );
    assert.equal(out.kind, 'error', JSON.stringify(subject));
    if (out.kind === 'error') assert.equal(out.errorCode, 'XO_RUNTIME_PERMISSION_DENIED');
  }
  const noManager = await executeApprovedCapability(
    graph,
    IDS.flowA,
    { claim_amount: 15000 },
    { subject: principal('alice'), permissionManager: undefined as never },
  );
  assert.equal(noManager.kind, 'error');
});

// ── Human-task resolution (resume): the RESOLVER is authorized, for approve and reject ──

test('resume: approve AND reject are authorized against the resolver; unauthorized resolver is denied (no outcome produced)', async () => {
  const guarded = graphJsonWith(IDS.hitlB, (p) => {
    p['requiredPermissions'] = [FILE];
  });
  for (const decision of ['approve', 'reject'] as const) {
    const denied = await resumeCapabilityExecution(guarded, IDS.hitlB, { amount: 1 }, decision, undefined, authz([]));
    assert.equal(denied.kind, 'error', decision);
    if (denied.kind === 'error') assert.equal(denied.errorCode, 'XO_RUNTIME_PERMISSION_DENIED');
    const wrong = await resumeCapabilityExecution(
      guarded,
      IDS.hitlB,
      { amount: 1 },
      decision,
      undefined,
      authz([grant('alice')], principal('bob')),
    );
    assert.equal(wrong.kind, 'error', decision);
    const ok = await resumeCapabilityExecution(
      guarded,
      IDS.hitlB,
      { amount: 1 },
      decision,
      undefined,
      authz([grant('bob')], principal('bob')),
    );
    assert.notEqual(ok.kind, 'error', decision);
  }
});

test('resume: missing declaration on the human-task capability is denied for approve and reject', async () => {
  const broken = graphJsonWith(IDS.hitlB, (p) => {
    delete p['requiredPermissions'];
  });
  for (const decision of ['approve', 'reject'] as const) {
    const out = await resumeCapabilityExecution(
      broken,
      IDS.hitlB,
      {},
      decision,
      undefined,
      authz([{ id: 'all', effect: 'ALLOW', match: {} }]),
    );
    assert.equal(out.kind, 'error', decision);
  }
});

test('workflow start + HITL resume: a permission-free chain runs under the authenticated principal; initiator is preserved across resume', async () => {
  await withEnv(undefined, async (env) => {
    for (const id of [IDS.hitlA, IDS.hitlB, IDS.hitlC]) await approve(env, id);
    const start = await startWorkflow(env, IDS.hitlA, { screening_score: 90, settlement_amount: 800 });
    assert.ok(start.status === 200 || start.status === 201, start.bodyText);
    const wf = start.json<{ workflowExecutionId: string; status: string; initiator?: { id: string }; steps: { executionId?: string }[] }>();
    assert.equal(wf.status, 'waiting_for_human');
    assert.equal(wf.initiator?.id, 'test-identity');
    const resumed = await env.server.request('POST', ws(env, `/workflow-executions/${wf.workflowExecutionId}/resume`), {
      decision: 'approve',
      expectedStepExecutionId: wf.steps[1]!.executionId,
    });
    assert.equal(resumed.status, 200, resumed.bodyText);
    assert.equal(resumed.json<{ initiator?: { id: string } }>().initiator?.id, 'test-identity');
  });
});

// ── AI path stays disabled regardless of authorization ──

test('AI execution stays disabled even for an authorized principal with an allow-all policy; provider headers/body are never consulted', async () => {
  await withEnv(new RuleBasedPolicy([{ id: 'all', effect: 'ALLOW', match: {} }]), async (env) => {
    const res = await env.server.request(
      'POST',
      ws(env, '/runtime/execute'),
      { capabilityId: IDS.flowA, input: 'hello', model: 'x', provider: 'anthropic', endpoint: 'http://127.0.0.1:1/', apiKey: 'sk-secret' },
      { 'x-provider-key': 'sk-secret', 'x-provider-endpoint': 'http://127.0.0.1:1/', 'x-xo-provider': 'anthropic' },
    );
    assert.equal(res.status, 501, res.bodyText);
    assert.doesNotMatch(res.bodyText, /sk-secret/);
  });
});

test('executions persisted by a permitted run carry the initiator and are attributable (M1 attribution intact)', async () => {
  await withEnv(undefined, async (env) => {
    await approve(env, IDS.flowA);
    const res = await env.server.request('POST', ws(env, '/executions'), {
      compilationId: env.compilationId,
      capabilityId: IDS.flowA,
      input: { claim_amount: 15000 },
    });
    const rec = res.json<{ executionId: string; initiator?: { id: string } }>();
    const store = new FsExecutionStore(workspaceExecutionsStore(env.workspace, { dataRootDir: env.dataDir }));
    const stored = await store.get(rec.executionId);
    assert.ok(stored.ok);
    assert.equal(stored.value.initiator?.id, 'test-identity');
  });
});

void (null as unknown as PermissionPolicy);
