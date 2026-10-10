import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  establishAuthenticatedPrincipal,
  PermissionManager,
  Permissions,
  RuleBasedPolicy,
  type AuthenticatedPrincipal,
  type PermissionPolicy,
  type PolicyRule,
} from '@xo/permissions';
import { STANDARD_BINDING_RESOLVERS, type BindingResolver } from '@xo/capability-contract';
import { toJson } from '@xo/xoir';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, buildFixtureGraph, storeFixtureCompilation } from './workflow-fixtures.js';
import { executeApprovedCapability, preflightCapabilityAuthorization } from '../src/executions/execute-capability.js';
import { FsExecutionStore } from '../src/executions/fs-execution-store.js';
import { workspaceExecutionsStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

// P1.0 M2 remediation — Finding A: the direct `POST /workspaces/:id/executions` route must
// reach its authorization decision BEFORE any persistent execution record exists.

interface ErrorWire {
  readonly error: { readonly code: string; readonly message: string };
}
const FILE = Permissions.filesystem.read;
const grant = (principalId: string): PolicyRule => ({
  id: `grant-${principalId}`,
  effect: 'ALLOW',
  match: { permission: FILE, principalId },
});

interface Env {
  readonly server: TestServer;
  readonly dataDir: string;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
}

async function withEnv(
  policy: PermissionPolicy | undefined,
  graphMutator: ((props: Record<string, unknown>) => void) | undefined,
  fn: (env: Env) => Promise<void>,
): Promise<void> {
  await withTempDir('xo-m2r-data-', async (dataDir) => {
    await withTempDir('xo-m2r-ws-', async (workspacesDir) => {
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        ...(policy !== undefined ? { permissionPolicy: policy } : {}),
      });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        let override: ReturnType<typeof toJson> | undefined;
        if (graphMutator !== undefined) {
          const json = JSON.parse(JSON.stringify(toJson(buildFixtureGraph()))) as {
            nodes: { id: string; properties: Record<string, unknown> }[];
          };
          const node = json.nodes.find((n) => n.id === IDS.perm);
          assert.ok(node);
          graphMutator(node.properties);
          override = json as unknown as ReturnType<typeof toJson>;
        }
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir, override);
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
const execute = (env: Env, capabilityId: string, input: Record<string, unknown>) =>
  env.server.request('POST', ws(env, '/executions'), { compilationId: env.compilationId, capabilityId, input });

/** Reads the execution store DIRECTLY (not through the API) so a record created and then hidden by the route cannot go unnoticed. */
async function storedExecutions(env: Env) {
  const store = new FsExecutionStore(workspaceExecutionsStore(env.workspace, { dataRootDir: env.dataDir }));
  const listed = await store.list();
  assert.ok(listed.ok);
  return listed.value;
}

test('A1: an unauthorized direct execution is denied (403) and NO execution record is created', async () => {
  await withEnv(undefined, undefined, async (env) => {
    await approve(env, IDS.perm);
    const before = await storedExecutions(env);
    const res = await execute(env, IDS.perm, { file_size: 50 });
    assert.equal(res.status, 403, res.bodyText);
    assert.equal(res.json<ErrorWire>().error.code, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.deepEqual(await storedExecutions(env), before, 'execution store must be unchanged by a denied attempt');
    assert.equal(before.length, 0);
  });
});

test('A2: repeated denied attempts never grow the store (no storage-exhaustion vector)', async () => {
  await withEnv(new RuleBasedPolicy([grant('someone-else')]), undefined, async (env) => {
    await approve(env, IDS.perm);
    for (let i = 0; i < 5; i++) assert.equal((await execute(env, IDS.perm, { file_size: 50 })).status, 403);
    assert.equal((await storedExecutions(env)).length, 0);
  });
});

test('A3: a denied attempt is denied even with invalid input — authorization is decided before input validation can persist anything', async () => {
  await withEnv(undefined, undefined, async (env) => {
    await approve(env, IDS.perm);
    const res = await execute(env, IDS.perm, { file_size: 'not-a-number' });
    assert.equal(res.status, 403, res.bodyText);
    assert.equal((await storedExecutions(env)).length, 0);
  });
});

test('A4: an authorized execution still creates and completes its normal record', async () => {
  await withEnv(new RuleBasedPolicy([grant('test-identity')]), undefined, async (env) => {
    await approve(env, IDS.perm);
    const res = await execute(env, IDS.perm, { file_size: 50 });
    assert.ok(res.status === 200 || res.status === 201, res.bodyText);
    const rec = res.json<{ executionId: string; status: string; initiator?: { id: string } }>();
    assert.equal(rec.status, 'succeeded');
    assert.equal(rec.initiator?.id, 'test-identity');
    const stored = await storedExecutions(env);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.executionId, rec.executionId);
    assert.equal(stored[0]?.status, 'succeeded');
  });
});

test('A4b: a permission-free capability still executes for an authenticated principal and records normally', async () => {
  await withEnv(undefined, undefined, async (env) => {
    await approve(env, IDS.flowA);
    const res = await execute(env, IDS.flowA, { claim_amount: 15000 });
    assert.ok(res.status === 200 || res.status === 201, res.bodyText);
    assert.equal(res.json<{ status: string }>().status, 'succeeded');
    assert.equal((await storedExecutions(env)).length, 1);
  });
});

test('A5: missing / null / malformed authoritative requiredPermissions fail closed BEFORE any record, even under an allow-all policy', async () => {
  const variants: [string, (p: Record<string, unknown>) => void][] = [
    ['missing', (p) => void delete p['requiredPermissions']],
    ['null', (p) => void (p['requiredPermissions'] = null)],
    ['string', (p) => void (p['requiredPermissions'] = 'filesystem.read')],
    ['non-string entry', (p) => void (p['requiredPermissions'] = [1])],
    ['invalid id', (p) => void (p['requiredPermissions'] = ['NOT A PERMISSION'])],
  ];
  for (const [label, mutate] of variants) {
    await withEnv(new RuleBasedPolicy([{ id: 'all', effect: 'ALLOW', match: {} }]), mutate, async (env) => {
      await approve(env, IDS.perm);
      const res = await execute(env, IDS.perm, { file_size: 50 });
      assert.equal(res.status, 403, `${label}: ${res.bodyText}`);
      assert.equal((await storedExecutions(env)).length, 0, label);
    });
  }
});

// ── Handler non-invocation, lower-level bypass attempts, TOCTOU, preflight/execution agreement ──

/**
 * Wraps every standard resolver so each binding's `evaluate` (the capability handler's actual work) is counted.
 * Test-only: mutates the shared resolver list for the duration of `fn` and restores it in `finally`.
 */
async function countingHandlers(fn: (evaluations: () => number) => Promise<void>): Promise<void> {
  const list = STANDARD_BINDING_RESOLVERS as BindingResolver[];
  const originals = [...list];
  let evaluations = 0;
  list.splice(
    0,
    list.length,
    ...originals.map<BindingResolver>((resolver) => ({
      name: resolver.name,
      resolve(contract) {
        const outcome = resolver.resolve(contract);
        if (outcome === undefined || outcome.status !== 'resolved' || outcome.binding.evaluate === undefined) return outcome;
        const inner = outcome.binding.evaluate;
        return { status: 'resolved', binding: { ...outcome.binding, evaluate: (input) => (evaluations++, inner(input)) } };
      },
    })),
  );
  try {
    await fn(() => evaluations);
  } finally {
    list.splice(0, list.length, ...originals);
  }
}

const principalOf = (id: string): AuthenticatedPrincipal => {
  const r = establishAuthenticatedPrincipal({ kind: 'human', id });
  if (!r.ok) throw r.error;
  return r.value;
};
const authzFor = (rules: readonly PolicyRule[], id = 'alice') => ({
  subject: principalOf(id),
  permissionManager: new PermissionManager({ policy: new RuleBasedPolicy(rules) }),
});

test('A6: a denied direct API execution never invokes the capability handler (counted at the real evaluate), while an authorized one does exactly once', async () => {
  await countingHandlers(async (evaluations) => {
    await withEnv(undefined, undefined, async (env) => {
      await approve(env, IDS.perm);
      assert.equal((await execute(env, IDS.perm, { file_size: 50 })).status, 403);
      assert.equal(evaluations(), 0, 'handler ran for a denied attempt');
    });
    await withEnv(new RuleBasedPolicy([grant('test-identity')]), undefined, async (env) => {
      await approve(env, IDS.perm);
      const res = await execute(env, IDS.perm, { file_size: 50 });
      assert.ok(res.status === 200 || res.status === 201, res.bodyText);
      assert.equal(evaluations(), 1);
    });
  });
});

test('A7: the lower-level boundary re-authorizes on its own — calling executeApprovedCapability directly (no route, no preflight) cannot bypass authorization', async () => {
  await countingHandlers(async (evaluations) => {
    const graph = toJson(buildFixtureGraph());
    const denied = await executeApprovedCapability(graph, IDS.perm, { file_size: 50 }, authzFor([]));
    assert.equal(denied.kind, 'error');
    if (denied.kind === 'error') assert.equal(denied.errorCode, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.equal(evaluations(), 0);
    // an `authorized` preflight for one principal grants nothing to a different principal's later direct call
    const preflight = await preflightCapabilityAuthorization(graph, IDS.perm, authzFor([grant('alice')]));
    assert.equal(preflight.kind, 'authorized');
    const other = await executeApprovedCapability(graph, IDS.perm, { file_size: 50 }, authzFor([grant('alice')], 'mallory'));
    assert.equal(other.kind, 'error');
    assert.equal(evaluations(), 0);
  });
});

test('A8: TOCTOU — execution refuses a different graph than the one authorized, and re-derives the declaration from the graph it runs', async () => {
  await countingHandlers(async (evaluations) => {
    const original = toJson(buildFixtureGraph());
    const authz = authzFor([grant('alice')]);
    const preflight = await preflightCapabilityAuthorization(original, IDS.perm, authz);
    assert.equal(preflight.kind, 'authorized');
    if (preflight.kind !== 'authorized') return;

    // (1) a genuinely DIFFERENT graph (different node hashes) is refused by the hash tie, before anything runs
    const different = JSON.parse(JSON.stringify(original)) as { edges: unknown[] };
    different.edges.pop(); // still a loadable graph, but with different edge hashes
    const refused = await executeApprovedCapability(different, IDS.perm, { file_size: 50 }, authz, {
      preflightGraphHash: preflight.graphHash,
    });
    assert.equal(refused.kind, 'error');
    if (refused.kind === 'error') assert.match(refused.errorMessage, /changed between/);
    assert.equal(evaluations(), 0);

    // (2) a stricter declaration on the graph that is actually executed is enforced EVEN WHEN the hash tie cannot see it
    //     (`fromJson` trusts stored node hashes, so editing properties alone leaves `contentHash()` unchanged) — the boundary re-derives.
    const stricter = JSON.parse(JSON.stringify(original)) as { nodes: { id: string; properties: Record<string, unknown> }[] };
    stricter.nodes.find((n) => n.id === IDS.perm)!.properties['requiredPermissions'] = ['filesystem.read', 'network.connect'];
    const rederived = await executeApprovedCapability(stricter, IDS.perm, { file_size: 50 }, authz, {
      preflightGraphHash: preflight.graphHash,
    });
    assert.equal(rederived.kind, 'error');
    if (rederived.kind === 'error') assert.equal(rederived.errorCode, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.equal(evaluations(), 0);

    // (3) the unchanged graph with the matching hash still executes
    const ok = await executeApprovedCapability(original, IDS.perm, { file_size: 50 }, authz, { preflightGraphHash: preflight.graphHash });
    assert.equal(ok.kind, 'succeeded');
    assert.equal(evaluations(), 1);
  });
});

test('A9: preflight and the execution boundary reach the SAME decision across policies and graph metadata (one shared implementation, no drift)', async () => {
  const base = toJson(buildFixtureGraph());
  const variantGraph = (mutate: (p: Record<string, unknown>) => void) => {
    const json = JSON.parse(JSON.stringify(base)) as { nodes: { id: string; properties: Record<string, unknown> }[] };
    mutate(json.nodes.find((n) => n.id === IDS.perm)!.properties);
    return json;
  };
  const graphs: [string, unknown][] = [
    ['declared filesystem.read', base],
    ['missing', variantGraph((p) => void delete p['requiredPermissions'])],
    ['malformed', variantGraph((p) => void (p['requiredPermissions'] = [1]))],
    ['permission-free', variantGraph((p) => void (p['requiredPermissions'] = []))],
  ];
  const policies: [string, PolicyRule[]][] = [
    ['deny-all', []],
    ['alice granted', [grant('alice')]],
    ['other granted', [grant('bob')]],
    ['allow-all', [{ id: 'all', effect: 'ALLOW', match: {} }]],
  ];
  for (const [graphLabel, graph] of graphs) {
    for (const [policyLabel, rules] of policies) {
      const pre = await preflightCapabilityAuthorization(graph, IDS.perm, authzFor(rules));
      const exec = await executeApprovedCapability(graph, IDS.perm, { file_size: 50 }, authzFor(rules));
      const preAllowed = pre.kind === 'authorized';
      const execAllowed = exec.kind === 'succeeded';
      assert.equal(preAllowed, execAllowed, `${graphLabel} / ${policyLabel}: preflight=${pre.kind} execution=${exec.kind}`);
    }
  }
});

test('A10: a workflow start with missing authoritative metadata on a step is denied before any execution or workflow record (path stays protected)', async () => {
  await withEnv(
    new RuleBasedPolicy([{ id: 'all', effect: 'ALLOW', match: {} }]),
    (p) => void delete p['requiredPermissions'],
    async (env) => {
      await approve(env, IDS.perm);
      const list = (await env.server.request('GET', ws(env, '/workflows'))).json<{
        workflows: { workflowId: string; steps: { capabilityId: string }[] }[];
      }>().workflows;
      const wf = list.find((w) => w.steps[0]?.capabilityId === IDS.perm);
      assert.ok(wf, 'the workflow must exist so this test is not vacuous');
      const res = await env.server.request('POST', ws(env, `/workflows/${wf.workflowId}/executions`), {
        compilationId: env.compilationId,
        input: { file_size: 50 },
      });
      assert.ok(res.status === 400 || res.status === 403 || res.status === 422, `${res.status} ${res.bodyText}`);
      assert.equal((await storedExecutions(env)).length, 0);
    },
  );
});
