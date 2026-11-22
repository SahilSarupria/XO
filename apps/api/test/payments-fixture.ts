/** A workspace with one bound `payments` connector and a certified `forEach` generated workflow; shared by the RX-1 API tests. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { ExternalToolAdapter, ExternalToolResult } from '@xo/adapters';
import { NonProductionAuditSink } from '@xo/audit';
import type { ServerDeps } from '../src/server.js';
import { TestServer, withTempDir } from './test-helpers.js';

export const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const OPENAPI = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Payments', version: '1' },
  paths: {
    '/payments': {
      post: {
        operationId: 'createPayment',
        requestBody: {
          content: {
            'application/json': { schema: { type: 'object', properties: { amount: { type: 'number' }, account: { type: 'string' } } } },
          },
        },
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', properties: { paymentId: { type: 'string' } } } } },
          },
        },
      },
    },
  },
});
const BINDING = {
  capability: 'createPayment',
  connector: 'payments',
  kind: 'http',
  operation: 'create_payment',
  sideEffect: 'write',
  adapter: 'payments-adapter',
};

export interface Effect {
  step: string;
  state: string;
  reconciledBy?: string;
}
export interface RunView {
  runId: string;
  state: string;
  outputs?: Record<string, unknown>;
  escalation?: { code: string };
  effects: Effect[];
  cancellation?: { by: string; applied: boolean };
  cancelRecorded?: boolean;
}

export function payments() {
  const calls: { dispatchKey: string; account: string }[] = [];
  let onCall: (n: number, account: string) => Promise<ExternalToolResult> | ExternalToolResult = (n) =>
    ({ kind: 'confirmed_success', output: { paymentId: `pay_${n}` } }) as ExternalToolResult;
  const adapter = {
    id: 'payments-adapter',
    approvalMode: 'capability',
    invoke: async (r: { dispatchKey: string; input: { account?: string } }) => {
      calls.push({ dispatchKey: r.dispatchKey, account: String(r.input.account) });
      return onCall(calls.length, String(r.input.account));
    },
  } as unknown as ExternalToolAdapter;
  return { adapter, calls, behave: (f: typeof onCall) => (onCall = f) };
}

export async function env(
  fn: (e: {
    server: TestServer;
    pay: ReturnType<typeof payments>;
    ws: string;
    defId: string;
    certId: string;
    audit: NonProductionAuditSink;
    data: string;
    reviewer: Record<string, string>;
  }) => Promise<void>,
  extra: ServerDeps = {},
) {
  await withTempDir('xo-api-estop-', async (dir) => {
    const pay = payments();
    const audit = new NonProductionAuditSink();

    const server = await TestServer.start({
      auditSink: audit,
      workspaceDataDir: join(dir, 'd'),
      workspacesDir: join(dir, 'w'),
      ...NO_OCR,
      connectorAdapters: new Map([['payments-adapter', pay.adapter]]),
      ...extra,
    });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=payments.json`, Buffer.from(OPENAPI))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      assert.equal((await server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [BINDING] })).status, 200);
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { capabilityId: string; effect: { class: string }; outputSchema: { typed: boolean } }[] };
      }>().inventory;
      assert.deepEqual(
        inv.capabilities.map((c) => c.effect.class),
        ['write'],
        'the inventory records the effect class from the binding',
      );
      for (const c of inv.capabilities)
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
      const def = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, {
          goal: { text: 'create a payment', forEach: 'payment' },
        })
      ).json<{ definition: { definitionId: string } }>().definition;
      const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/readiness`, {})).json<{
        certificateId: string;
        status: string;
      }>();
      assert.equal(cert.status, 'READY');
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'reviewer-1', role: 'reviewer' })).status, 201);
      const reviewer = TestServer.authHeader((await server.issueAdditionalIdentity('reviewer-1')).apiKey);
      await fn({ server, pay, ws, defId: def.definitionId, certId: cert.certificateId, audit, data: join(dir, 'd'), reviewer });
    } finally {
      await server.stop();
    }
  });
}

export const items = (n: number) => Array.from({ length: n }, (_, i) => ({ amount: 1, account: `acct-${i}` }));
