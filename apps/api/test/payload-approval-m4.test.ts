import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Permissions, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { NonProductionAuditSink } from '@xo/audit';
import { LocalFsBlobStore } from '@xo/storage';
import { err } from '@xo/types';
import { ErrorCode, StorageError } from '@xo/errors';
import type { CapabilityInputSchema } from '@xo/types';
import { BlobDispatchLedger, type DispatchEvidence } from '@xo/adapters';
import { createDurableExternalToolWiring, type ExternalToolWiring } from '@xo/runtime';
import { TestServer } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import { FsCompilationStore } from '../src/compilations/fs-compilation-store.js';
import { compilationLoaderFromStore } from '../src/procedures/registry-validation.js';
import { workspaceCompilationsStore } from '../src/workspace/workspace-context.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { createReferenceAdapter, ReferenceService } from '../../../examples/external-tool-reference/reference-service.js';

// P1.1 M4 PAYLOAD-LEVEL APPROVAL (host-declared interim policy; not an O-2 compliance claim) -- END-TO-END through the real HTTP routes, the real dispatcher and a REAL on-disk
// ledger (BlobDispatchLedger over LocalFsBlobStore). A "restart" boots a brand-new server, ledger, dispatcher and reference service
// over the same directories (no shared memory). The external system is the deterministic in-process reference service.

const EXT = IDS.orphan;
const SCHEMA: CapabilityInputSchema = {
  type: 'object',
  properties: { amount: { type: 'number' }, scenario: { type: 'string' } },
  required: ['amount'],
};
const grant = (id: string, permission: string): PolicyRule => ({
  id,
  effect: 'ALLOW',
  match: { permission: permission as never, principalId: 'test-identity' },
});
const ALL_RULES: readonly PolicyRule[] = [
  grant('author', Permissions.procedure.author),
  grant('approve', Permissions.procedure.approve),
  grant('read', Permissions.procedure.read),
  grant('execute', Permissions.procedure.execute),
  grant('reconcile', Permissions.effect.reconcile),
  grant('payload', Permissions.effect.payloadApprove),
];
/** Holds procedure.approve + execute (and everything else) but NOT effect.payload-approve. */
const NO_PAYLOAD_APPROVE = ALL_RULES.filter((r) => r.id !== 'payload');
/** Holds effect.payload-approve and read, but NOT procedure.approve / author / execute. */
const PAYLOAD_APPROVE_ONLY = ALL_RULES.filter((r) => r.id === 'payload' || r.id === 'read');

class RefusingSink extends NonProductionAuditSink {
  readonly refuse = new Set<string>();
  /** Refuse only events with these outcomes (e.g. the completion record, not the attempt precondition). */
  readonly refuseOutcomes = new Set<string>();
  override async append(draft: Parameters<NonProductionAuditSink['append']>[0]): ReturnType<NonProductionAuditSink['append']> {
    if (this.refuse.has(draft.type) || this.refuseOutcomes.has(draft.outcome))
      return { ok: false, error: new Error('audit sink down'), indeterminate: false } as never;
    return super.append(draft);
  }
}

class FlakyStore extends LocalFsBlobStore {
  failPutIfAbsent: (key: string) => boolean = () => false;
  override async putIfAbsent(key: string, data: Uint8Array | string, options?: { readonly contentType?: string }) {
    if (this.failPutIfAbsent(key)) return err(new StorageError(ErrorCode.STORAGE_WRITE_FAILED, 'injected store failure'));
    return super.putIfAbsent(key, data, options);
  }
}

interface Dirs {
  readonly data: string;
  readonly workspaces: string;
  readonly ledger: string;
}
interface Node {
  readonly server: TestServer;
  readonly humanKey: string;
  readonly service: ReferenceService;
  readonly sink: RefusingSink;
  readonly store: FlakyStore;
  readonly ledger: BlobDispatchLedger;
}
interface Env {
  readonly dirs: Dirs;
  node: Node;
  workspace: WorkspaceRecord;
  compilationId: string;
  graphHash: string;
  readonly nodes: Node[];
}

async function bootNode(dirs: Dirs, rules: readonly PolicyRule[] = ALL_RULES): Promise<Node> {
  const service = new ReferenceService();
  const store = new FlakyStore(dirs.ledger);
  // The SUPPORTED host construction path: durable by construction (no in-memory ledger is reachable from here).
  const ledger = new BlobDispatchLedger(store); // a second view over the same store, for tests that seed or inspect evidence
  const externalTools: ExternalToolWiring = createDurableExternalToolWiring({
    adapters: new Map([[EXT, createReferenceAdapter(service, 'reference-service', 'payload')]]),
    inputSchemas: new Map([[EXT, SCHEMA]]),
    evidenceStore: store,
  });
  assert.equal(externalTools.ledgerDurability, 'durable');
  const sink = new RefusingSink();
  const server = await TestServer.start({
    workspaceDataDir: dirs.data,
    workspacesDir: dirs.workspaces,
    auditSink: sink,
    permissionPolicy: new RuleBasedPolicy([...rules]),
    externalTools,
  });
  const humanKey = generateApiKey();
  const created = await server.apiKeyStore.create({
    keyHash: hashApiKey(humanKey),
    identityId: server.identityId,
    principalKind: 'human',
    createdAt: new Date().toISOString(),
  });
  assert.ok(created.ok);
  return { server, humanKey, service, sink, store, ledger };
}

async function withEnv(fn: (env: Env) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'xo-m4-durable-'));
  const dirs: Dirs = { data: join(root, 'data'), workspaces: join(root, 'ws'), ledger: join(root, 'ledger') };
  const nodes: Node[] = [];
  try {
    const node = await bootNode(dirs);
    nodes.push(node);
    const workspace = (await node.server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
    const { compilationId } = await storeFixtureCompilation(workspace, dirs.data);
    const loaded = await compilationLoaderFromStore(
      new FsCompilationStore(workspaceCompilationsStore(workspace, { dataRootDir: dirs.data })),
    )(compilationId);
    assert.ok(loaded);
    const env: Env = { dirs, node, workspace, compilationId, graphHash: loaded.graphHash, nodes };
    const res = await node.server.request('POST', `${base(env)}/compilations/${compilationId}/capabilities/${EXT}/approve`);
    assert.ok(res.status === 200 || res.status === 201, res.bodyText);
    await fn(env);
  } finally {
    for (const n of nodes) await n.server.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}
/** Simulates a process restart: stops the current server and boots a fresh one (new memory, same disk). */
async function restart(env: Env, rules?: readonly PolicyRule[]): Promise<Node> {
  await env.node.server.stop();
  const node = await bootNode(env.dirs, rules);
  env.nodes.push(node);
  env.node = node;
  return node;
}

const base = (env: Pick<Env, 'workspace'>): string => `/workspaces/${env.workspace.workspaceId}`;
const human = (n: Node): Record<string, string> => TestServer.authHeader(n.humanKey) as Record<string, string>;
const doc = (env: Env, version = 1): Record<string, unknown> => ({
  schema: 'xo.procedure/1',
  procedureId: 'ext-flow',
  version,
  compilationRef: { compilationId: env.compilationId, graphHash: env.graphHash },
  steps: [
    {
      id: 'e',
      kind: 'capability',
      capabilityId: EXT,
      basis: 'source_proven',
      inputBindings: [
        { param: 'amount', from: { input: 'amount' }, bindingStatus: 'proven' },
        { param: 'scenario', from: { input: 'scenario' }, bindingStatus: 'proven' },
      ],
    },
  ],
});
async function publish(env: Env): Promise<void> {
  const p = await env.node.server.request('PUT', `${base(env)}/procedures/ext-flow/versions/1`, doc(env));
  assert.equal(p.status, 201, p.bodyText);
  const a = await env.node.server.request('POST', `${base(env)}/procedures/ext-flow/versions/1/approve`, undefined, human(env.node));
  assert.equal(a.status, 200, a.bodyText);
}
interface ExecWire {
  procedureExecutionId: string;
  status: string;
  steps: { stepId: string; status: string; errorCode?: string }[];
}
async function startExec(env: Env, input: unknown): Promise<ExecWire> {
  const res = await env.node.server.request('POST', `${base(env)}/procedures/ext-flow/versions/1/executions`, { input });
  assert.ok(res.status === 200 || res.status === 201, res.bodyText);
  const id = res.json<ExecWire>().procedureExecutionId;
  const got = await env.node.server.request('GET', `${base(env)}/procedure-executions/${id}`);
  assert.equal(got.status, 200, got.bodyText);
  return got.json<ExecWire>();
}
const effectPath = (env: Env, exec: ExecWire, suffix = ''): string =>
  `${base(env)}/procedure-executions/${exec.procedureExecutionId}/steps/e/external-effect${suffix}`;
interface EvidenceWire {
  dispatched: boolean;
  effectiveState?: string;
  requiresReconciliation?: boolean;
  entries: DispatchEvidence[];
}
const evidence = async (env: Env, exec: ExecWire): Promise<EvidenceWire> => {
  const res = await env.node.server.request('GET', effectPath(env, exec));
  assert.equal(res.status, 200, res.bodyText);
  return res.json<EvidenceWire>();
};
const payloadPath = (env: Env, exec: ExecWire, suffix = ''): string =>
  `${base(env)}/procedure-executions/${exec.procedureExecutionId}/steps/e/payload-approval${suffix}`;
interface PreviewWire {
  awaitingApproval: boolean;
  actionDigest?: string;
  actionSummary?: string;
  approvals: { approvalId: string; approver: { kind: string; id: string }; consumed: boolean }[];
}
const preview = async (env: Env, exec: ExecWire, headers = human(env.node)): Promise<PreviewWire> => {
  const res = await env.node.server.request('GET', payloadPath(env, exec), undefined, headers);
  assert.equal(res.status, 200, res.bodyText);
  return res.json<PreviewWire>();
};
const approveExact = async (env: Env, exec: ExecWire, headers = human(env.node)) => {
  const p = await preview(env, exec);
  return env.node.server.request('POST', payloadPath(env, exec), { inputDigest: p.actionDigest, actionSummary: p.actionSummary }, headers);
};
const proceed = (env: Env, exec: ExecWire) => env.node.server.request('POST', payloadPath(env, exec, '/continue'), {}, human(env.node));
const execView = async (env: Env, exec: ExecWire): Promise<ExecWire> =>
  (await env.node.server.request('GET', `${base(env)}/procedure-executions/${exec.procedureExecutionId}`)).json<ExecWire>();

test('payload e2e: the step PAUSES with nothing dispatched; a human approves the exact digest+summary; the initiator continues; exactly one dispatch; approval is spent; no input values in audit', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 4242, scenario: 'accept' });
    assert.equal(exec.status, 'waiting_for_human');
    assert.equal(env.node.service.requests.length, 0, 'nothing was dispatched while waiting');
    assert.equal((await evidence(env, exec)).entries.length, 0, 'no write-ahead claim either');
    const p = await preview(env, exec);
    assert.equal(p.awaitingApproval, true);
    assert.ok(p.actionDigest && p.actionSummary && !p.actionSummary.includes('4242'), 'the default summary carries no input value');
    // Continuing without an approval changes nothing (still waiting, still nothing dispatched) — and is repeatable.
    for (let i = 0; i < 2; i++) {
      const early = await proceed(env, exec);
      assert.equal(early.status, 200, early.bodyText);
      assert.equal((await execView(env, exec)).status, 'waiting_for_human');
    }
    assert.equal(env.node.service.requests.length, 0);
    const granted = await approveExact(env, exec);
    assert.equal(granted.status, 201, granted.bodyText);
    const g = granted.json<{ approvalId: string; auditCorrelationId: string; auditCompletion: string }>();
    assert.equal(g.auditCompletion, 'recorded');
    const done = await proceed(env, exec);
    assert.equal(done.status, 200, done.bodyText);
    assert.equal((await execView(env, exec)).status, 'completed');
    assert.equal(env.node.service.effects.length, 1);
    const entries = (await evidence(env, exec)).entries;
    assert.deepEqual(
      entries.map((e) => e.state),
      ['dispatch_attempted', 'confirmed_success'],
    );
    assert.equal(entries[0]!.approvalMode, 'payload');
    assert.equal(entries[0]!.payloadApprovalId, g.approvalId, 'the dispatch references the approval it consumed');
    const after = await preview(env, exec);
    assert.deepEqual(
      after.approvals.map((a) => [a.approvalId, a.consumed, a.approver.id]),
      [[g.approvalId, true, 'test-identity']],
    );
    // Audit: attempt + completion of the approval share the correlation id; digest PREFIX only; no input values anywhere in audit.
    const events = env.node.sink.events().filter((e) => e.correlationId === g.auditCorrelationId);
    assert.deepEqual(
      events.map((e) => `${e.type}/${e.outcome}`),
      ['procedure.attempted/attempted', 'procedure.attempted/completed'],
    );
    assert.equal(String(events[0]!.metadata?.['digestPrefix']).length, 12);
    assert.ok(!JSON.stringify(env.node.sink.events()).includes('4242'), 'no input value reached the audit trail');
    // A second continue cannot dispatch again.
    assert.equal((await proceed(env, exec)).status, 409);
    assert.equal(env.node.service.effects.length, 1);
  });
});

test('payload e2e: a wrong digest or summary approves nothing (400); an approval cannot be granted in advance (409)', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 7, scenario: 'accept' });
    const p = await preview(env, exec);
    const post = (body: unknown) => env.node.server.request('POST', payloadPath(env, exec), body, human(env.node));
    assert.equal((await post({ inputDigest: 'f'.repeat(64), actionSummary: p.actionSummary })).status, 400);
    assert.equal((await post({ inputDigest: p.actionDigest, actionSummary: 'Pay somebody else' })).status, 400);
    assert.equal((await post({ inputDigest: p.actionDigest })).status, 400, 'a missing field is rejected');
    assert.equal(
      (await post({ inputDigest: p.actionDigest, actionSummary: p.actionSummary, approver: 'mallory' })).status,
      400,
      'the body cannot name an approver',
    );
    assert.deepEqual((await preview(env, exec)).approvals, []);
    assert.equal((await proceed(env, exec)).status, 200);
    assert.equal(env.node.service.requests.length, 0, 'still nothing dispatched');
    // After the run completes there is nothing to approve in advance.
    assert.equal((await approveExact(env, exec)).status, 201);
    assert.equal((await proceed(env, exec)).status, 200);
    assert.equal((await post({ inputDigest: 'a', actionSummary: 'b' })).status, 409, 'a finished step cannot take another approval');
  });
});

test('payload e2e: authority — service principals, procedure.approve alone, and an unprivileged human cannot approve; approval confers no execute authority; denials are audited', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 7, scenario: 'accept' });
    const p = await preview(env, exec);
    const body = { inputDigest: p.actionDigest, actionSummary: p.actionSummary };
    // A service principal (the server's default key) never approves — and cannot even read the pending action.
    assert.equal((await env.node.server.request('POST', payloadPath(env, exec), body, {})).status, 403);
    assert.equal((await env.node.server.request('GET', payloadPath(env, exec), undefined, {})).status, 403);
    // A human WITH procedure.approve (+ execute) but WITHOUT effect.payload-approve is refused.
    const strict = await restart(env, NO_PAYLOAD_APPROVE);
    assert.equal((await env.node.server.request('POST', payloadPath(env, exec), body, human(strict))).status, 403);
    assert.equal((await env.node.server.request('GET', payloadPath(env, exec), undefined, human(strict))).status, 403);
    assert.deepEqual((await restart(env)).humanKey.length > 0, true);
    assert.deepEqual((await preview(env, exec)).approvals, [], 'nothing was granted by any refused request');
    // effect.payload-approve alone: may approve, but cannot continue the run (procedure.execute is a different authority).
    await restart(env, PAYLOAD_APPROVE_ONLY);
    assert.equal((await approveExact(env, exec)).status, 201);
    assert.equal((await proceed(env, exec)).status, 403);
    assert.equal(env.node.service.requests.length, 0);
    const denied = env.node.sink.events().filter((e) => e.outcome === 'denied' && /external-payload/.test(e.action));
    assert.ok(denied.length >= 1, 'denied attempts are audited');
    // No credentials / another owner.
    assert.equal((await env.node.server.request('POST', payloadPath(env, exec), body, {}, { skipAuth: true })).status, 401);
  });
});

test('payload e2e: an approval is bound to its execution — a second execution of the same input waits for its own approval', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const one = await startExec(env, { amount: 7, scenario: 'accept' });
    await approveExact(env, one);
    const two = await startExec(env, { amount: 7, scenario: 'accept' });
    assert.equal(two.status, 'waiting_for_human', "the first execution's approval does not carry over");
    assert.deepEqual((await preview(env, two)).approvals, []);
    assert.equal((await proceed(env, one)).status, 200);
    assert.equal((await execView(env, one)).status, 'completed');
    assert.equal((await proceed(env, two)).status, 200);
    assert.equal((await execView(env, two)).status, 'waiting_for_human');
    assert.equal(env.node.service.effects.length, 1);
  });
});

test('payload e2e: concurrent continues consume the approval once — exactly one dispatch', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 7, scenario: 'accept' });
    assert.equal((await approveExact(env, exec)).status, 201);
    await Promise.all(Array.from({ length: 6 }, () => proceed(env, exec)));
    assert.equal(env.node.service.effects.length, 1);
    assert.equal((await evidence(env, exec)).entries.filter((e) => e.state === 'dispatch_attempted').length, 1);
  });
});

test('payload e2e: after a confirmed no-effect failure a new execution needs a fresh payload approval bound to it; the new attempt references the old one', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const one = await startExec(env, { amount: 7, scenario: 'reject' });
    assert.equal((await approveExact(env, one)).status, 201);
    await proceed(env, one);
    const failed = await execView(env, one);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.steps[0]?.errorCode, 'XO_EXTERNAL_EFFECT_CONFIRMED_FAILURE_NO_EFFECT');
    await new Promise((r) => setTimeout(r, 8));
    const two = await startExec(env, { amount: 7, scenario: 'accept' });
    assert.equal(two.status, 'waiting_for_human', 'a retry cannot run on definition-level approval alone');
    assert.equal(env.node.service.requests.length, 1, 'only the first attempt ever reached the service');
    assert.equal((await approveExact(env, two)).status, 201);
    await proceed(env, two);
    assert.equal((await execView(env, two)).status, 'completed');
    const entries = (await evidence(env, two)).entries;
    assert.deepEqual(entries[0]!.follows, { dispatchKey: `${one.procedureExecutionId}:e`, outcome: 'confirmed_failure_no_effect' });
    assert.notEqual(`${two.procedureExecutionId}:e`, `${one.procedureExecutionId}:e`);
  });
});

test('payload e2e: an unknown outcome stays blocked — a later execution fails closed (it does not wait for an approval that could not help), and no approval can be granted for it', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const one = await startExec(env, { amount: 7, scenario: 'drop' });
    await approveExact(env, one);
    await proceed(env, one);
    assert.equal((await evidence(env, one)).effectiveState, 'outcome_unknown');
    const two = await startExec(env, { amount: 7, scenario: 'accept' });
    assert.equal(two.status, 'failed');
    assert.equal(env.node.service.requests.length, 1);
    assert.equal(
      (await env.node.server.request('POST', payloadPath(env, two), { inputDigest: 'a', actionSummary: 'b' }, human(env.node))).status,
      409,
      'not waiting, so an approval cannot be granted',
    );
    // Even a stale grant for the old key is refused (it already has evidence).
    assert.equal((await evidence(env, one)).entries.length, 2);
  });
});
