/**
 * ADR 0030 — generated workflows run as Workflow IR through @xo/workflow-runtime: the certified definition is the one that
 * runs. Human steps wait for a person (review role) and the platform signs the decision as theirs; act steps reach the
 * host adapter bound by the workspace, with a server-derived idempotency key; no run starts without a current certificate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExternalToolAdapter } from '@xo/adapters';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const PROCEDURE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';
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

interface Run {
  runId: string;
  state: string;
  pendingApprovals: { approvalId: string; step: string; summary: string }[];
}

async function prepare(server: TestServer, ws: string, filename: string, text: string, goal: object) {
  const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=${filename}`, Buffer.from(text))).json<{
    sourceId: string;
  }>();
  const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
    .compilationId;
  return { cid, goal };
}

test('a procedure runs as Workflow IR: certificate required, each step waits for a person, decisions are recorded', async () => {
  await withTempDir('xo-api-irrun-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const { cid } = await prepare(server, ws, 'release.md', PROCEDURE, {});
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { capabilityId: string }[] };
      }>().inventory;
      for (const c of inv.capabilities)
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
      const def = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, {
          goal: { text: 'Ship a release', needs: ['Run the full test suite'] },
        })
      ).json<{
        definition: { definitionId: string };
      }>().definition;
      const runs = `/workspaces/${ws}/generated-workflows/${def.definitionId}/runs`;

      const noCert = await server.request('POST', runs, { input: {} });
      assert.equal(noCert.status, 409);
      assert.equal(noCert.json<{ error: { code: string } }>().error.code, 'XO_READINESS_CERTIFICATE_REQUIRED');

      const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/readiness`, {})).json<{
        certificateId: string;
        status: string;
      }>();
      assert.equal(cert.status, 'READY');
      const started = await server.request('POST', runs, { input: {}, certificateId: cert.certificateId });
      assert.equal(started.status, 201, started.bodyText);
      const run = started.json<Run>();
      assert.equal(run.state, 'waiting');
      assert.equal(run.pendingApprovals.length, 1);
      assert.match(run.pendingApprovals[0]!.summary, /Pull the latest code/);

      const decide = (r: Run, action: string) =>
        server.request('POST', `${runs}/${r.runId}/approvals/${r.pendingApprovals[0]!.approvalId}`, { action });
      const second = (await decide(run, 'approve')).json<Run>();
      assert.equal(second.pendingApprovals.length, 1);
      assert.match(second.pendingApprovals[0]!.summary, /Run the full test suite/);
      const done = (await decide(second, 'approve')).json<Run>();
      assert.equal(done.state, 'completed');
      assert.equal(done.pendingApprovals.length, 0);

      const listed = (await server.request('GET', runs)).json<{ runs: { runId: string; state: string }[] }>().runs;
      assert.deepEqual(
        listed.map((r) => r.state),
        ['completed'],
      );
      assert.equal((await server.request('POST', `${runs}/${run.runId}/approvals/nope`, { action: 'approve' })).status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('a declared operation runs through the adapter the workspace bound, with a server-derived idempotency key', async () => {
  await withTempDir('xo-api-irrun-', async (dataDir) => {
    const calls: { capabilityId: string; dispatchKey: string; input: unknown }[] = [];
    const adapter: ExternalToolAdapter = {
      id: 'payments-adapter',
      approvalMode: 'capability',
      invoke: async (r) => {
        calls.push(r);
        return { kind: 'confirmed_success', output: { paymentId: 'pay_1' } };
      },
    } as ExternalToolAdapter;
    const server = await TestServer.start({
      workspaceDataDir: dataDir,
      ...NO_OCR,
      connectorAdapters: new Map([['payments-adapter', adapter]]),
    });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const { cid } = await prepare(server, ws, 'payments.json', OPENAPI, {});
      const unbound = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, { goal: { text: 'create a payment' } })
      ).json<{
        definition: { lowered: { complete: boolean } };
      }>();
      assert.equal(unbound.definition.lowered.complete, false, 'no binding: the act step is reported, not invented');

      const bad = await server.request('PUT', `/workspaces/${ws}/connector-bindings`, {
        bindings: [
          { capability: 'createPayment', connector: 'Payments!', kind: 'http', operation: 'create', sideEffect: 'write', adapter: 'x' },
        ],
      });
      assert.equal(bad.status, 400);
      const put = await server.request('PUT', `/workspaces/${ws}/connector-bindings`, {
        bindings: [
          {
            capability: 'createPayment',
            connector: 'payments',
            kind: 'http',
            operation: 'create_payment',
            sideEffect: 'write',
            compensation: { operation: 'void_payment', sideEffect: 'write' },
            adapter: 'payments-adapter',
          },
        ],
      });
      assert.equal(put.status, 200, put.bodyText);
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { capabilityId: string; name: string; readiness: { bound: { strategy?: string } } }[] };
      }>().inventory;
      const op = inv.capabilities.find((c) => c.name === 'createPayment')!;
      assert.equal(op.readiness.bound.strategy, 'external_tool');
      assert.equal(
        (await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(op.capabilityId)}/approve`))
          .status,
        200,
      );

      const def = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, { goal: { text: 'create a payment' } })
      ).json<{
        definition: {
          definitionId: string;
          lowered: { complete: boolean; issues: unknown[]; component: { workflows: { steps: { type: string }[] }[] } };
        };
      }>().definition;
      assert.equal(def.lowered.complete, true, JSON.stringify(def.lowered.issues));
      assert.deepEqual(
        def.lowered.component.workflows[0]!.steps.map((s) => s.type),
        ['act', 'compensate'],
      );
      const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/readiness`, {})).json<{
        certificateId: string;
        status: string;
        gates: unknown;
      }>();
      assert.equal(cert.status, 'READY', JSON.stringify(cert.gates.filter((g) => g.status !== 'pass')));
      const run = await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/runs`, {
        input: { amount: 25, account: 'acc-1' },
        certificateId: cert.certificateId,
      });
      assert.equal(run.status, 201, run.bodyText);
      assert.equal(run.json<Run>().state, 'completed', run.bodyText);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.capabilityId, 'payments.create_payment');
      assert.deepEqual(calls[0]!.input, { amount: 25, account: 'acc-1' });
      assert.ok(calls[0]!.dispatchKey.length > 10);

      // Changing the bindings makes the certificate stale.
      await server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [] });
      const stale = await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/runs`, {
        input: { amount: 1, account: 'a' },
        certificateId: cert.certificateId,
      });
      assert.equal(stale.status, 409);
    } finally {
      await server.stop();
    }
  });
});
