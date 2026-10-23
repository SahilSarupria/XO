import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Permissions, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { NonProductionAuditSink } from '@xo/audit';
import type { CapabilityInputSchema } from '@xo/types';
import { ExternalToolDispatcher, InMemoryDispatchLedger } from '@xo/adapters';
import { createExternalToolWiring, type ExternalToolWiring } from '@xo/runtime';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import { FsCompilationStore } from '../src/compilations/fs-compilation-store.js';
import { compilationLoaderFromStore } from '../src/procedures/registry-validation.js';
import { workspaceCompilationsStore } from '../src/workspace/workspace-context.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { createReferenceAdapter, ReferenceService } from '../../../examples/external-tool-reference/reference-service.js';

// P1.1 M4 -- END-TO-END procedure path for a configured external_tool step, through the real HTTP routes, registry validation, approval,
// per-step authorization, schema validation, the capability-authority binding and the dispatcher. ADDITIVE test file.
// FIXTURE: the hand-built P0.8 graph; the external capability is IDS.orphan (no rule/action evidence, so no standard resolver binds it).
// The "external system" is the deterministic in-process reference service: no network, no clock, no credentials.

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
const RULES: readonly PolicyRule[] = [
  grant('author', Permissions.procedure.author),
  grant('approve', Permissions.procedure.approve),
  grant('read', Permissions.procedure.read),
  grant('execute', Permissions.procedure.execute),
];

interface Env {
  readonly server: TestServer;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
  readonly graphHash: string;
  readonly humanKey: string;
  readonly service: ReferenceService;
  readonly ledger: InMemoryDispatchLedger;
}
const base = (env: Pick<Env, 'workspace'>): string => `/workspaces/${env.workspace.workspaceId}`;

function wiringFor(service: ReferenceService, ledger: InMemoryDispatchLedger, schema: CapabilityInputSchema = SCHEMA): ExternalToolWiring {
  const dispatcher = new ExternalToolDispatcher({
    adapters: new Map([[EXT, createReferenceAdapter(service)]]),
    ledger,
    unsafeAllowVolatileLedger: true,
  });
  return createExternalToolWiring(dispatcher, new Map([[EXT, schema]]));
}

async function withEnv(fn: (env: Env) => Promise<void>, options: { wired?: boolean; approveCapability?: boolean } = {}): Promise<void> {
  const { wired = true, approveCapability = true } = options;
  await withTempDir('xo-m4e-data-', async (dataDir) => {
    await withTempDir('xo-m4e-ws-', async (workspacesDir) => {
      const service = new ReferenceService();
      const ledger = new InMemoryDispatchLedger();
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: new NonProductionAuditSink(),
        permissionPolicy: new RuleBasedPolicy([...RULES]),
        ...(wired ? { externalTools: wiringFor(service, ledger) } : {}),
      });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        const loaded = await compilationLoaderFromStore(
          new FsCompilationStore(workspaceCompilationsStore(workspace, { dataRootDir: dataDir })),
        )(compilationId);
        assert.ok(loaded);
        const humanKey = generateApiKey();
        const created = await server.apiKeyStore.create({
          keyHash: hashApiKey(humanKey),
          identityId: server.identityId,
          principalKind: 'human',
          createdAt: new Date().toISOString(),
        });
        assert.ok(created.ok);
        const env: Env = { server, workspace, compilationId, graphHash: loaded.graphHash, humanKey, service, ledger };
        if (approveCapability) {
          const res = await server.request('POST', `${base(env)}/compilations/${compilationId}/capabilities/${EXT}/approve`);
          assert.ok(res.status === 200 || res.status === 201, `capability approve -> ${res.status} ${res.bodyText}`);
        }
        await fn(env);
      } finally {
        await server.stop();
      }
    });
  });
}

const human = (env: Env): Record<string, string> => TestServer.authHeader(env.humanKey) as Record<string, string>;
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
const put = (env: Env, body: Record<string, unknown>) =>
  env.server.request('PUT', `${base(env)}/procedures/ext-flow/versions/${body['version'] as number}`, body);
const approve = (env: Env, version = 1, headers: Record<string, string> = {}) =>
  env.server.request('POST', `${base(env)}/procedures/ext-flow/versions/${version}/approve`, undefined, headers);
const start = (env: Env, input: unknown, version = 1) =>
  env.server.request('POST', `${base(env)}/procedures/ext-flow/versions/${version}/executions`, { input });
interface ExecWire {
  procedureExecutionId: string;
  status: string;
  steps: { stepId: string; status: string; errorCode?: string; failureClass?: string }[];
  failure?: { class: string; code: string };
}
const getExec = async (env: Env, id: string): Promise<ExecWire> => {
  const res = await env.server.request('GET', `${base(env)}/procedure-executions/${id}`);
  assert.equal(res.status, 200, res.bodyText);
  return res.json<ExecWire>();
};
const publish = async (env: Env, version = 1): Promise<void> => {
  const p = await put(env, doc(env, version));
  assert.equal(p.status, 201, p.bodyText);
  const a = await approve(env, version, human(env));
  assert.equal(a.status, 200, a.bodyText);
};

test('M4 e2e: author -> human approval -> start -> authorization + schema validation -> exactly one adapter call -> step success recorded', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const res = await start(env, { amount: 25, scenario: 'accept' });
    assert.equal(res.status, 201, res.bodyText);
    const exec = await getExec(env, res.json<ExecWire>().procedureExecutionId);
    assert.equal(exec.status, 'completed');
    assert.equal(exec.steps[0]?.status, 'succeeded');
    assert.equal(env.service.effects.length, 1, 'exactly one external effect');
    assert.equal(env.service.requests.length, 1, 'exactly one adapter call');
    assert.match(env.service.requests[0]!.dispatchKey, new RegExp(`^${exec.procedureExecutionId}:e$`), 'dispatch key is server-derived');
    assert.deepEqual(
      env.ledger.all().map((e) => e.state),
      ['dispatch_attempted', 'confirmed_success'],
    );
  });
});

test('M4 e2e: effectful procedure — a SERVICE principal cannot approve it (presumed effectful), a human can', async () => {
  await withEnv(async (env) => {
    assert.equal((await put(env, doc(env))).status, 201);
    assert.equal((await approve(env)).status, 403, 'service principal refused');
    assert.equal((await approve(env, 1, human(env))).status, 200);
    assert.equal(env.service.requests.length, 0, 'approval never calls the adapter');
  });
});

test('M4 e2e: ambiguous outcome (connection drops AFTER the effect) -> step failed with the unknown-outcome code, procedure failed, never success; no duplicate effect on any further attempt', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const res = await start(env, { amount: 7, scenario: 'drop' });
    assert.ok(res.status === 200 || res.status === 201, res.bodyText);
    const exec = await getExec(env, res.json<ExecWire>().procedureExecutionId);
    assert.equal(exec.status, 'failed');
    assert.equal(exec.steps[0]?.status, 'failed');
    assert.equal(exec.steps[0]?.errorCode, 'XO_EXTERNAL_EFFECT_OUTCOME_UNKNOWN');
    assert.notEqual(exec.status, 'completed');
    assert.equal(env.service.effects.length, 1, 'the effect was applied once (outcome unknown to XO)');
    assert.equal(env.ledger.all().at(-1)?.state, 'outcome_unknown');

    // Re-reading the execution never replays the dispatch, and a NEW execution is refused while the earlier dispatch is unreconciled.
    await getExec(env, exec.procedureExecutionId);
    assert.equal(env.service.requests.length, 1, 'no automatic retry of the failed dispatch');
    const again = await start(env, { amount: 7, scenario: 'accept' });
    const secondExec = await getExec(env, again.json<ExecWire>().procedureExecutionId);
    assert.equal(secondExec.status, 'failed');
    assert.equal(secondExec.steps[0]?.status, 'failed');
    assert.notEqual(secondExec.steps[0]?.errorCode, undefined);
    assert.equal(env.service.requests.length, 1, 'reconciliation is required before another dispatch: the adapter was not called again');
    assert.equal(env.service.effects.length, 1, 'the external action was never duplicated');
  });
});

test('M4 e2e: confirmed rejection (no effect) is a distinct failure code and applies nothing', async () => {
  await withEnv(async (env) => {
    await publish(env);
    const exec = await getExec(env, (await start(env, { amount: 7, scenario: 'reject' })).json<ExecWire>().procedureExecutionId);
    assert.equal(exec.status, 'failed');
    assert.equal(exec.steps[0]?.errorCode, 'XO_EXTERNAL_EFFECT_CONFIRMED_FAILURE_NO_EFFECT');
    assert.equal(env.service.effects.length, 0);
  });
});

test('M4 e2e: invalid input is refused at start (400-class) before any dispatch; zero adapter calls', async () => {
  await withEnv(async (env) => {
    await publish(env);
    for (const bad of [{ scenario: 'accept' }, { amount: 'ten', scenario: 'accept' }, { amount: 1, scenario: 'accept', extra: true }]) {
      const res = await start(env, bad);
      assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(bad)} -> ${res.status}`);
    }
    assert.equal(env.service.requests.length, 0);
  });
});

test('M4 e2e: without the explicit adapter configuration an external step can be drafted but never approved or started; nothing is dispatched', async () => {
  await withEnv(
    async (env) => {
      assert.equal((await put(env, doc(env))).status, 201, 'drafting needs only M1 validity');
      const res = await approve(env, 1, human(env));
      assert.equal(res.status, 400, res.bodyText);
      assert.match(res.bodyText, /PROC_UNRESOLVED_CAPABILITY/);
      assert.ok((await start(env, { amount: 1, scenario: 'accept' })).status >= 400);
      assert.equal(env.service.requests.length, 0);
    },
    { wired: false, approveCapability: false },
  );
});

test('M4 e2e: adapter configuration is part of what is approved — changing the input schema after approval makes the approval stale (nothing dispatched)', async () => {
  await withTempDir('xo-m4e2-data-', async (dataDir) => {
    await withTempDir('xo-m4e2-ws-', async (workspacesDir) => {
      const service = new ReferenceService();
      const ledger = new InMemoryDispatchLedger();
      // Same data directory, two servers with DIFFERENT adapter configuration (same adapter id, different input schema).
      const boot = (schema: CapabilityInputSchema) =>
        TestServer.start({
          workspaceDataDir: dataDir,
          workspacesDir,
          auditSink: new NonProductionAuditSink(),
          permissionPolicy: new RuleBasedPolicy([...RULES]),
          externalTools: wiringFor(service, ledger, schema),
        });
      const first = await boot(SCHEMA);
      let env: Env;
      try {
        const workspace = (await first.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        const loaded = await compilationLoaderFromStore(
          new FsCompilationStore(workspaceCompilationsStore(workspace, { dataRootDir: dataDir })),
        )(compilationId);
        assert.ok(loaded);
        const humanKey = generateApiKey();
        await first.apiKeyStore.create({
          keyHash: hashApiKey(humanKey),
          identityId: first.identityId,
          principalKind: 'human',
          createdAt: new Date().toISOString(),
        });
        env = { server: first, workspace, compilationId, graphHash: loaded.graphHash, humanKey, service, ledger };
        assert.ok(
          [200, 201].includes(
            (await first.request('POST', `${base(env)}/compilations/${compilationId}/capabilities/${EXT}/approve`)).status,
          ),
        );
        await publish(env);
      } finally {
        await first.stop();
      }
      const changed: CapabilityInputSchema = { ...SCHEMA, properties: { ...SCHEMA.properties, note: { type: 'string' } } };
      const second = await boot(changed);
      try {
        const res = await second.request('POST', `${base(env)}/procedures/ext-flow/versions/1/executions`, {
          input: { amount: 1, scenario: 'accept' },
        });
        assert.equal(res.status, 403, res.bodyText);
        assert.equal(service.requests.length, 0, 'a changed adapter configuration invalidated the approval before any dispatch');
      } finally {
        await second.stop();
      }
    });
  });
});
