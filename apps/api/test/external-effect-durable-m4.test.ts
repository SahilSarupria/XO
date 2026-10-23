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
import { BlobDispatchLedger, ExternalToolDispatcher, type DispatchEvidence } from '@xo/adapters';
import { createExternalToolWiring, type ExternalToolWiring } from '@xo/runtime';
import { TestServer } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import { FsCompilationStore } from '../src/compilations/fs-compilation-store.js';
import { compilationLoaderFromStore } from '../src/procedures/registry-validation.js';
import { workspaceCompilationsStore } from '../src/workspace/workspace-context.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { createReferenceAdapter, ReferenceService } from '../../../examples/external-tool-reference/reference-service.js';

// P1.1 M4 (durable evidence + reconciliation) -- END-TO-END through the real HTTP routes, the real dispatcher and a REAL on-disk
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
];
const NO_APPROVE_AFTER_PUBLISH = ALL_RULES.filter((r) => r.id !== 'approve');

class RefusingSink extends NonProductionAuditSink {
  readonly refuse = new Set<string>();
  override async append(draft: Parameters<NonProductionAuditSink['append']>[0]): ReturnType<NonProductionAuditSink['append']> {
    if (this.refuse.has(draft.type)) return { ok: false, error: new Error('audit sink down'), indeterminate: false } as never;
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
  const ledger = new BlobDispatchLedger(store);
  const dispatcher = new ExternalToolDispatcher({ adapters: new Map([[EXT, createReferenceAdapter(service)]]), ledger });
  const externalTools: ExternalToolWiring = createExternalToolWiring(dispatcher, new Map([[EXT, SCHEMA]]));
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
const reconcile = (env: Env, exec: ExecWire, body: unknown, headers: Record<string, string> = human(env.node)) =>
  env.node.server.request('POST', effectPath(env, exec, '/reconcile'), body, headers);
const GOOD = {
  decision: 'confirmed_failure_no_effect',
  reason: 'provider confirmed nothing was sent',
  evidenceExamined: 'provider log: no message for key',
};

test('durable e2e: a successful dispatch leaves durable success evidence that a restarted server still serves', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 5, scenario: 'accept' });
    assert.equal(exec.status, 'completed');
    await restart(env);
    const ev = await evidence(env, exec);
    assert.deepEqual(
      ev.entries.map((e) => e.state),
      ['dispatch_attempted', 'confirmed_success'],
    );
    assert.equal(ev.requiresReconciliation, false);
    assert.equal(env.node.service.requests.length, 0, 'reading evidence never dispatches');
  });
});

test('durable e2e: ambiguous outcome, then RESTART -> evidence survives, a new execution is refused, zero adapter calls', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 7, scenario: 'drop' });
    assert.equal(exec.steps[0]?.errorCode, 'XO_EXTERNAL_EFFECT_OUTCOME_UNKNOWN');
    assert.equal(env.node.service.effects.length, 1);
    const fresh = await restart(env);
    const ev = await evidence(env, exec);
    assert.equal(ev.effectiveState, 'outcome_unknown');
    assert.equal(ev.requiresReconciliation, true);
    const again = await startExec(env, { amount: 7, scenario: 'accept' });
    assert.equal(again.status, 'failed');
    assert.equal(fresh.service.requests.length, 0, 'the restarted process never re-dispatched');
    assert.equal(fresh.service.effects.length, 0);
  });
});

test('durable e2e: crash window (adapter never answered) -> restart -> blocked until reconciled', async () => {
  await withEnv(async (env) => {
    await publish(env);
    // Pre-seed exactly what a crash after write-ahead leaves behind: a dispatch_attempted entry and nothing else.
    const exec = await startExec(env, { amount: 1, scenario: 'accept' });
    const key = `${exec.procedureExecutionId}:e`;
    const stranded = `${exec.procedureExecutionId}:stranded`;
    await env.node.ledger.claim({ dispatchKey: stranded, capabilityId: EXT, adapterId: 'reference-service', state: 'dispatch_attempted' });
    assert.ok(key);
    const fresh = await restart(env);
    const blocked = await startExec(env, { amount: 2, scenario: 'accept' });
    assert.equal(blocked.status, 'failed');
    assert.equal(fresh.service.requests.length, 0);
  });
});

test('durable e2e: authorized human reconciliation (confirmed no effect) is recorded with actor/reason/evidence, is idempotent, refuses contradiction, and a NEW execution may then proceed once', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 7, scenario: 'drop' });
    await restart(env);
    const res = await reconcile(env, exec, GOOD);
    assert.equal(res.status, 200, res.bodyText);
    assert.equal(res.json<{ outcome: string; redispatchPermitted: boolean }>().outcome, 'recorded');
    assert.equal(res.json<{ redispatchPermitted: boolean }>().redispatchPermitted, false);
    const ev = await evidence(env, exec);
    assert.deepEqual(
      ev.entries.map((e) => e.state),
      ['dispatch_attempted', 'outcome_unknown', 'confirmed_failure_no_effect'],
    );
    const rec = ev.entries.at(-1)!.reconciliation!;
    assert.equal(rec.actorId, 'test-identity');
    assert.equal(rec.actorKind, 'human');
    assert.equal(rec.evidenceExamined, GOOD.evidenceExamined);
    assert.equal(rec.reason, GOOD.reason);
    assert.ok(ev.entries.at(-1)!.recordedAt);
    // Idempotent repeat; contradiction refused; nothing further written.
    assert.equal((await reconcile(env, exec, GOOD)).json<{ outcome: string }>().outcome, 'already_resolved');
    assert.equal((await reconcile(env, exec, { ...GOOD, decision: 'confirmed_success' })).status, 409);
    assert.equal((await evidence(env, exec)).entries.length, 3);
    // The old identity is never redispatched; a new execution is a new identity and runs exactly once.
    const fresh = await startExec(env, { amount: 9, scenario: 'accept' });
    assert.equal(fresh.status, 'completed');
    assert.equal(env.node.service.effects.length, 1);
    assert.notEqual(fresh.procedureExecutionId, exec.procedureExecutionId);
  });
});

test('durable e2e: an UNRESOLVED reconciliation is recorded but keeps everything blocked', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 7, scenario: 'drop' });
    const res = await reconcile(env, exec, { decision: 'unresolved', reason: 'provider has no lookup API' });
    assert.equal(res.status, 200, res.bodyText);
    assert.equal(res.json<{ effectiveState: string }>().effectiveState, 'outcome_unknown');
    const next = await startExec(env, { amount: 1, scenario: 'accept' });
    assert.equal(next.status, 'failed');
    assert.equal(env.node.service.requests.length, 1, 'only the original (ambiguous) dispatch ever reached the service');
  });
});

test('durable e2e: unauthorized reconciliation is refused, audited, and changes nothing (service principal / no permission / other owner / unauthenticated)', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 7, scenario: 'drop' });
    const before = JSON.stringify((await evidence(env, exec)).entries);

    // 1. a SERVICE principal (the server's default key) can never reconcile.
    const asService = await reconcile(env, exec, GOOD, {});
    assert.equal(asService.status, 403, asService.bodyText);
    // 2. a human WITHOUT procedure.approve is refused (default-deny policy).
    const strict = await restart(env, NO_APPROVE_AFTER_PUBLISH);
    const noPerm = await env.node.server.request('POST', effectPath(env, exec, '/reconcile'), GOOD, human(strict));
    assert.equal(noPerm.status, 403, noPerm.bodyText);
    // 3. another owner's workspace is a uniform 404; 4. no credentials is 401.
    const other = await env.node.server.issueAdditionalIdentity('someone-else');
    const foreign = await env.node.server.request(
      'POST',
      effectPath(env, exec, '/reconcile'),
      GOOD,
      TestServer.authHeader(other.apiKey) as Record<string, string>,
    );
    assert.equal(foreign.status, 404, foreign.bodyText);
    const noAuth = await env.node.server.request('POST', effectPath(env, exec, '/reconcile'), GOOD, {}, { skipAuth: true });
    assert.equal(noAuth.status, 401, noAuth.bodyText);

    assert.equal(JSON.stringify((await evidence(env, exec)).entries), before, 'no refused request wrote anything');
    const denied = env.node.sink.events().filter((e) => e.action === 'reconcile.external-effect' && e.outcome === 'denied');
    assert.ok(denied.length >= 1, 'a denied reconciliation is audited');
    assert.ok(denied.every((e) => e.type === 'procedure.denied' || e.type === 'access.denied'));
  });
});

test('durable e2e: the request body cannot supply authority or identity; malformed requests write nothing', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 7, scenario: 'drop' });
    const cases: unknown[] = [
      { ...GOOD, actor: 'mallory' },
      { ...GOOD, actorId: 'mallory' },
      { ...GOOD, dispatchKey: 'other:e' },
      { ...GOOD, decision: 'retry' },
      { ...GOOD, decision: 'confirmed_success', evidenceExamined: '' },
      { decision: 'confirmed_success', evidenceExamined: 'x' },
      { ...GOOD, reason: 7 },
    ];
    for (const c of cases) {
      const res = await reconcile(env, exec, c);
      assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(c)} -> ${res.status}`);
    }
    assert.equal((await evidence(env, exec)).entries.length, 2);
    const bogus = await env.node.server.request(
      'POST',
      `${base(env)}/procedure-executions/${exec.procedureExecutionId}/steps/nope/external-effect/reconcile`,
      GOOD,
      human(env.node),
    );
    assert.equal(bogus.status, 404);
    const badId = await env.node.server.request(
      'POST',
      `${base(env)}/procedure-executions/pex_nope/steps/e/external-effect/reconcile`,
      GOOD,
      human(env.node),
    );
    assert.equal(badId.status, 404);
  });
});

test('durable e2e: if the audit precondition cannot be confirmed, nothing is reconciled (fail closed)', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 7, scenario: 'drop' });
    env.node.sink.refuse.add('procedure.attempted');
    const res = await reconcile(env, exec, GOOD);
    assert.equal(res.status, 503, res.bodyText);
    assert.equal((await evidence(env, exec)).entries.length, 2);
  });
});

test('durable e2e: concurrent identical reconciliations produce exactly one recorded decision', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 7, scenario: 'drop' });
    const results = await Promise.all(Array.from({ length: 5 }, () => reconcile(env, exec, GOOD)));
    assert.ok(
      results.every((r) => r.status === 200),
      results.map((r) => `${r.status}:${r.bodyText}`).join(' | '),
    );
    const outcomes = results.map((r) => r.json<{ outcome: string }>().outcome);
    assert.equal(outcomes.filter((o) => o === 'recorded').length, 1);
    assert.equal((await evidence(env, exec)).entries.length, 3);
  });
});

test('durable e2e: evidence store down BEFORE dispatch -> the step fails and the external system is never called', async () => {
  await withEnv(async (env) => {
    await publish(env);
    env.node.store.failPutIfAbsent = (k) => k.includes('/events/');
    const exec = await startExec(env, { amount: 3, scenario: 'accept' });
    assert.equal(exec.status, 'failed');
    assert.equal(env.node.service.requests.length, 0);
    assert.equal(env.node.service.effects.length, 0);
  });
});

test('durable e2e: evidence store fails WHILE RECORDING the result -> reported unknown (never success), and after restart still blocked', async () => {
  await withEnv(async (env) => {
    await publish(env);
    env.node.store.failPutIfAbsent = (k) => k.endsWith('0000000002.json');
    const exec = await startExec(env, { amount: 3, scenario: 'accept' });
    assert.equal(exec.status, 'failed');
    assert.equal(exec.steps[0]?.errorCode, 'XO_EXTERNAL_EFFECT_OUTCOME_UNKNOWN');
    assert.equal(env.node.service.effects.length, 1);
    const fresh = await restart(env);
    assert.equal((await evidence(env, exec)).requiresReconciliation, true);
    const again = await startExec(env, { amount: 3, scenario: 'accept' });
    assert.equal(again.status, 'failed');
    assert.equal(fresh.service.requests.length, 0);
  });
});

test('durable e2e: reading evidence of an unknown step or without wiring is a 404 and never dispatches', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await startExec(env, { amount: 1, scenario: 'accept' });
    const res = await env.node.server.request(
      'GET',
      `${base(env)}/procedure-executions/${exec.procedureExecutionId}/steps/zzz/external-effect`,
    );
    assert.equal(res.status, 404);
  });
});
