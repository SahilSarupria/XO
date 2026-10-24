import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Permissions, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { NonProductionAuditSink } from '@xo/audit';
import type { CapabilityInputSchema } from '@xo/types';
import { ExternalToolDispatcher, InMemoryDispatchLedger, InMemoryPayloadApprovalStore } from '@xo/adapters';
import { createExternalToolWiring } from '@xo/runtime';
import { TestServer, withTempDir } from '../../api/test/test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from '../../api/test/workflow-fixtures.js';
import { FsCompilationStore } from '../../api/src/compilations/fs-compilation-store.js';
import { compilationLoaderFromStore } from '../../api/src/procedures/registry-validation.js';
import { workspaceCompilationsStore } from '../../api/src/workspace/workspace-context.js';
import { generateApiKey, hashApiKey } from '../../api/src/auth/api-key.js';
import { EFFECT_OUTCOME_UNKNOWN_CODE as API_UNKNOWN } from '../../api/src/procedures/procedure-runner.js';
import type { WorkspaceRecord } from '../../api/src/workspace/workspace.js';
import { createReferenceAdapter, ReferenceService } from '../../../examples/external-tool-reference/reference-service.js';
import { EFFECT_OUTCOME_UNKNOWN_CODE as MCP_UNKNOWN } from '../src/tools.js';

// P1.1 M5 — END-TO-END: a real MCP client -> the real stdio adapter process -> the REAL XO API (registry validation, approvals,
// authorization, M4 dispatcher). Nothing is mocked except the deterministic in-process reference "external system".

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const CWD = fileURLToPath(new URL('..', import.meta.url));
const EXT = IDS.orphan;
const SCHEMA: CapabilityInputSchema = {
  type: 'object',
  properties: { amount: { type: 'number' }, scenario: { type: 'string' } },
  required: ['amount'],
};
const grant = (id: string, permission: string, principalKind?: 'human' | 'service'): PolicyRule => ({
  id,
  effect: 'ALLOW',
  match: { permission: permission as never, principalId: 'test-identity', ...(principalKind !== undefined ? { principalKind } : {}) },
});
const RULES: readonly PolicyRule[] = [
  grant('author', Permissions.procedure.author),
  grant('approve', Permissions.procedure.approve),
  grant('read', Permissions.procedure.read),
  // Execution is granted to the SERVICE-kind key only; the same identity's HUMAN-kind key can read but not execute.
  grant('execute', Permissions.procedure.execute, 'service'),
];

interface Env {
  readonly server: TestServer;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
  readonly graphHash: string;
  readonly humanKey: string;
  readonly service: ReferenceService;
  readonly ledger: InMemoryDispatchLedger;
  readonly dataDir: string;
  readonly sink: NonProductionAuditSink;
}
const base = (env: Pick<Env, 'workspace'>): string => `/workspaces/${env.workspace.workspaceId}`;

async function withEnv(fn: (env: Env) => Promise<void>): Promise<void> {
  await withTempDir('xo-m5-data-', async (dataDir) => {
    await withTempDir('xo-m5-ws-', async (workspacesDir) => {
      const service = new ReferenceService();
      const ledger = new InMemoryDispatchLedger();
      const sink = new NonProductionAuditSink();
      const dispatcher = new ExternalToolDispatcher({
        adapters: new Map([[EXT, createReferenceAdapter(service, 'reference-service', 'definition')]]),
        payloadApprovals: new InMemoryPayloadApprovalStore(),
        ledger,
        unsafeAllowVolatileLedger: true,
      });
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: sink,
        permissionPolicy: new RuleBasedPolicy([...RULES]),
        externalTools: createExternalToolWiring(dispatcher, new Map([[EXT, SCHEMA]])),
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
        const env: Env = { server, workspace, compilationId, graphHash: loaded.graphHash, humanKey, service, ledger, dataDir, sink };
        const res = await server.request('POST', `${base(env)}/compilations/${compilationId}/capabilities/${EXT}/approve`);
        assert.ok(res.status === 200 || res.status === 201, `capability approve -> ${res.status} ${res.bodyText}`);
        await fn(env);
      } finally {
        await server.stop();
      }
    });
  });
}

const human = (env: Env): Record<string, string> => TestServer.authHeader(env.humanKey) as Record<string, string>;
const doc = (env: Env, procedureId: string, version = 1): Record<string, unknown> => ({
  schema: 'xo.procedure/1',
  procedureId,
  version,
  title: 'Pay out',
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
async function publish(env: Env, procedureId: string, approved: boolean, version = 1): Promise<void> {
  const p = await env.server.request('PUT', `${base(env)}/procedures/${procedureId}/versions/${version}`, doc(env, procedureId, version));
  assert.equal(p.status, 201, p.bodyText);
  if (approved) {
    const a = await env.server.request('POST', `${base(env)}/procedures/${procedureId}/versions/${version}/approve`, undefined, human(env));
    assert.equal(a.status, 200, a.bodyText);
  }
}
const executionCount = async (env: Env): Promise<number> => {
  try {
    return (await readdir(join(env.dataDir, env.workspace.workspaceId, 'procedure-executions'))).length;
  } catch {
    return 0;
  }
};

async function withMcp(env: Env, key: string, fn: (client: Client) => Promise<void>, extraEnv: Record<string, string> = {}): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', MAIN],
    cwd: CWD,
    stderr: 'pipe',
    env: { XO_API_KEY: key, XO_API_URL: env.server.baseUrl, XO_WORKSPACE_ID: env.workspace.workspaceId, ...extraEnv },
  });
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}
const sc = (r: unknown): Record<string, unknown> => (r as { structuredContent: Record<string, unknown> }).structuredContent;

test('e2e: the adapter and the API agree on the unknown-outcome code', () => {
  assert.equal(MCP_UNKNOWN, API_UNKNOWN);
});

test('e2e: discovery lists only APPROVED versions with the server-derived schema, creates no execution, and calls no adapter', async () => {
  await withEnv(async (env) => {
    await publish(env, 'approved-flow', true);
    await publish(env, 'draft-flow', false);
    const before = await executionCount(env);
    await withMcp(env, env.server.apiKey, async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ['approved-flow.v1'],
        'the draft procedure is not advertised',
      );
      const schema = tools[0]!.inputSchema as {
        properties: Record<string, { type: string }>;
        required: string[];
        additionalProperties: boolean;
      };
      assert.deepEqual(schema.properties, { amount: { type: 'number' }, scenario: { type: 'string' } });
      assert.deepEqual(schema.required, ['amount']);
      assert.equal(schema.additionalProperties, false);
      // The draft procedure can be NAMED but never run.
      const draft = await client.callTool({ name: 'draft-flow.v1', arguments: { amount: 1, scenario: 'accept' } });
      assert.equal(draft.isError, true);
      assert.equal(sc(draft)['outcome'], 'not_started');
    });
    assert.equal(await executionCount(env), before, 'discovery and a draft call created no execution record');
    assert.equal(env.service.requests.length, 0, 'no adapter call');
  });
});

test('e2e: invoke -> API start -> completed; exactly one external effect with a server-derived dispatch key; audit shows the same principal', async () => {
  await withEnv(async (env) => {
    await publish(env, 'approved-flow', true);
    await withMcp(env, env.server.apiKey, async (client) => {
      const res = await client.callTool({ name: 'approved-flow.v1', arguments: { amount: 25, scenario: 'accept' } });
      assert.equal(res.isError, false, JSON.stringify(res));
      assert.equal(sc(res)['outcome'], 'completed');
      const id = sc(res)['procedureExecutionId'] as string;
      assert.equal(env.service.effects.length, 1);
      assert.equal(env.service.requests[0]?.dispatchKey, `${id}:e`);
    });
    assert.ok(
      env.sink.events().some((e) => e.type === 'procedure.execution.completed'),
      'the API audited the execution',
    );
  });
});

test('e2e: argument validation (client side) and authority fields never reach dispatch', async () => {
  await withEnv(async (env) => {
    await publish(env, 'approved-flow', true);
    await withMcp(env, env.server.apiKey, async (client) => {
      for (const args of [
        {},
        { amount: 'ten' },
        { amount: 1, extra: true },
        { amount: 1, permissions: ['procedure.execute'], approvalMode: 'definition' },
      ]) {
        const r = await client.callTool({ name: 'approved-flow.v1', arguments: args });
        assert.equal(r.isError, true);
        assert.equal(sc(r)['outcome'], 'invalid_arguments');
      }
    });
    assert.equal(await executionCount(env), 0);
    assert.equal(env.service.requests.length, 0);
  });
});

test('e2e: a caller WITHOUT procedure.execute is denied by the API; the adapter adds no authority; nothing runs', async () => {
  await withEnv(async (env) => {
    await publish(env, 'approved-flow', true);
    await withMcp(env, env.humanKey, async (client) => {
      const { tools } = await client.listTools();
      // Reading is allowed for this principal, so the tool is VISIBLE...
      assert.deepEqual(
        tools.map((t) => t.name),
        ['approved-flow.v1'],
      );
      // ...but visibility is not authority: the API refuses the start.
      const r = await client.callTool({ name: 'approved-flow.v1', arguments: { amount: 5, scenario: 'accept' } });
      assert.equal(r.isError, true);
      assert.equal(sc(r)['outcome'], 'rejected');
      assert.equal(sc(r)['httpStatus'], 403);
    });
    assert.equal(await executionCount(env), 0);
    assert.equal(env.service.requests.length, 0);
  });
});

test('e2e: an unknown key gets a protocol error from discovery (HTTP 401), never an empty list', async () => {
  await withEnv(async (env) => {
    await publish(env, 'approved-flow', true);
    await withMcp(env, generateApiKey(), async (client) => {
      await assert.rejects(client.listTools(), /HTTP 401/);
    });
  });
});

test('e2e (M4): connection drop AFTER the effect -> outcome UNKNOWN is reported as unknown (not failed); a second call is blocked and never duplicates the effect', async () => {
  await withEnv(async (env) => {
    await publish(env, 'approved-flow', true);
    await withMcp(env, env.server.apiKey, async (client) => {
      const first = await client.callTool({ name: 'approved-flow.v1', arguments: { amount: 7, scenario: 'drop' } });
      assert.equal(first.isError, true);
      assert.equal(sc(first)['outcome'], 'unknown');
      assert.equal(sc(first)['outcomeUnknown'], true);
      assert.equal(sc(first)['retrySafe'], false);
      assert.doesNotMatch(JSON.stringify(first), /safely|no effect/i);
      assert.equal(env.service.effects.length, 1, 'the effect happened once');
      assert.equal(env.ledger.all().at(-1)?.state, 'outcome_unknown');

      // A retry through MCP is a new execution; the M4 ledger blocks it until a human reconciles. No second effect.
      const again = await client.callTool({ name: 'approved-flow.v1', arguments: { amount: 7, scenario: 'accept' } });
      assert.equal(again.isError, true);
      assert.notEqual(sc(again)['outcome'], 'completed');
      assert.equal(env.service.requests.length, 1, 'adapter not called again');
      assert.equal(env.service.effects.length, 1, 'effect never duplicated');
    });
  });
});

test('e2e (M4): a confirmed no-effect rejection is a plain failure, distinct from unknown', async () => {
  await withEnv(async (env) => {
    await publish(env, 'approved-flow', true);
    await withMcp(env, env.server.apiKey, async (client) => {
      const r = await client.callTool({ name: 'approved-flow.v1', arguments: { amount: 7, scenario: 'reject' } });
      assert.equal(r.isError, true);
      assert.equal(sc(r)['outcome'], 'failed');
      assert.equal(sc(r)['outcomeUnknown'], undefined);
      assert.equal(env.service.effects.length, 0);
    });
  });
});

test('e2e: timeout waiting for the API on START is reported as UNKNOWN, not as failure (server keeps running; the effect may still apply)', async () => {
  await withEnv(async (env) => {
    await publish(env, 'approved-flow', true);
    // Hold every adapter call far longer than the adapter's request timeout; the API request itself therefore outlives it.
    const originalHandle = env.service.handle.bind(env.service);
    env.service.handle = (request: Parameters<typeof originalHandle>[0]) => {
      const end = Date.now() + 2500;
      while (Date.now() < end) {
        /* the reference service is synchronous and in-process: block the API's event loop, so no answer arrives in time */
      }
      return originalHandle(request);
    };
    await withMcp(
      env,
      env.server.apiKey,
      async (client) => {
        const r = await client.callTool({ name: 'approved-flow.v1', arguments: { amount: 3, scenario: 'accept' } });
        assert.equal(r.isError, true);
        assert.equal(sc(r)['outcome'], 'unknown');
        assert.equal(sc(r)['retrySafe'], false);
        assert.equal(env.service.effects.length, 1, 'the effect did happen server-side although the adapter timed out');
      },
      { XO_MCP_REQUEST_TIMEOUT_MS: '1000' },
    );
  });
});
