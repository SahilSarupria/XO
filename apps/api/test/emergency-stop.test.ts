/**
 * RX-1a and RX-1b (ADR 0048) through the API: scoped emergency stops (who may set them, admission, a batch held mid-flight and carried
 * on after release, mandatory scenario 20), the instance-wide stop, and a run's manifest and signed audit bundle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { ExternalToolAdapter, ExternalToolResult } from '@xo/adapters';
import { NonProductionAuditSink } from '@xo/audit';
import { engageInstanceStop, releaseInstanceStop } from '@xo/instance';
import { engageStop } from '../src/workflow-controls/emergency-stops.js';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
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

interface Effect {
  step: string;
  state: string;
  reconciledBy?: string;
}
interface RunView {
  runId: string;
  state: string;
  outputs?: Record<string, unknown>;
  escalation?: { code: string };
  effects: Effect[];
  cancellation?: { by: string; applied: boolean };
  cancelRecorded?: boolean;
}

function payments() {
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

async function env(
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

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ amount: 1, account: `acct-${i}` }));

test('RX-1a: engaging a stop needs the manage role and a real target; it is listed and audited', async () => {
  await env(async ({ server, ws, reviewer, audit }) => {
    const at = `/workspaces/${ws}/emergency-stops`;
    assert.equal((await server.request('POST', at, { scope: 'connector', target: 'payments' }, reviewer)).status, 403, 'reviewer');
    assert.equal((await server.request('POST', at, { scope: 'everything', target: 'x' })).status, 400);
    const unknown = await server.request('POST', at, { scope: 'connector', target: 'mail' });
    assert.equal(unknown.status, 404, 'a stop on a connector that is not bound would hold nothing');
    assert.equal((await server.request('POST', at, { scope: 'capability', target: 'payments.refund' })).status, 404);
    const on = await server.request('POST', at, { scope: 'capability', target: 'payments.create_payment', reason: 'duplicates reported' });
    assert.equal(on.status, 201, on.bodyText);
    const listed = (await server.request('GET', at, undefined, reviewer)).json<{
      instance: unknown;
      workspacePaused: boolean;
      stops: { scope: string; target: string; reason: string; by: string }[];
    }>();
    assert.equal(listed.instance, null);
    assert.equal(listed.workspacePaused, false);
    assert.deepEqual(
      listed.stops.map((s) => [s.scope, s.target, s.reason]),
      [['capability', 'payments.create_payment', 'duplicates reported']],
    );
    const off = await server.request('POST', `${at}/release`, { scope: 'capability', target: 'payments.create_payment' });
    assert.equal(off.json<{ released: boolean }>().released, true);
    assert.deepEqual(
      audit
        .events()
        .filter((e) => e.type.startsWith('emergency-stop.'))
        .map((e) => [e.type, (e.metadata as { target: string }).target]),
      [
        ['emergency-stop.engaged', 'payments.create_payment'],
        ['emergency-stop.released', 'payments.create_payment'],
      ],
    );
  });
});

test('RX-1a: a stop on the connector, the workflow or the instance refuses the start and the preview before anything exists', async () => {
  await env(async ({ server, pay, ws, defId, certId, data, audit }) => {
    const runs = `/workspaces/${ws}/generated-workflows/${defId}`;
    const start = () => server.request('POST', `${runs}/runs`, { input: { payment_items: items(2) }, certificateId: certId });
    for (const stop of [
      { scope: 'connector', target: 'payments' },
      { scope: 'workflow', target: defId },
    ]) {
      assert.equal((await server.request('POST', `/workspaces/${ws}/emergency-stops`, stop)).status, 201);
      const refused = await start();
      assert.equal(refused.status, 412, refused.bodyText);
      assert.match(refused.bodyText, /emergency_stop/);
      assert.ok(refused.json<{ error: { message: string } }>().error.message.includes(`emergency stop on ${stop.scope} "${stop.target}"`));
      const preview = await server.request('POST', `${runs}/previews`, { input: { payment_items: items(2) }, certificateId: certId });
      assert.equal(preview.status, 412);
      assert.equal((await server.request('POST', `/workspaces/${ws}/emergency-stops/release`, stop)).status, 200);
    }
    await engageInstanceStop(data, { by: 'operator:test', reason: 'incident 42' });
    const held = await start();
    assert.equal(held.status, 412);
    assert.match(held.bodyText, /instance-wide emergency stop is engaged \(incident 42\)/);
    assert.equal(
      (await server.request('GET', `/workspaces/${ws}/emergency-stops`)).json<{ instance: { reason: string } }>().instance.reason,
      'incident 42',
    );
    await releaseInstanceStop(data);
    assert.equal(pay.calls.length, 0, 'nothing was sent while stopped');
    assert.equal(audit.events().filter((e) => e.type === 'emergency-stop.refused').length, 5, 'three starts and two previews');
    const ok = await start();
    assert.ok(ok.status === 201 || ok.status === 200, ok.bodyText);
    assert.equal(pay.calls.length, 2);
  });
});

test('Scenario 20: a stop engaged mid-batch starts no further call, the call in flight completes, and after release every item is sent exactly once', async () => {
  await env(async ({ server, pay, ws, defId, certId, data }) => {
    const runs = `/workspaces/${ws}/generated-workflows/${defId}/runs`;
    pay.behave(async (n) => {
      // The operator engages a stop on the connector while the third call is in flight.
      if (n === 3) await engageStop(data, ws, { scope: 'connector', target: 'payments', by: 'ops', at: new Date().toISOString() });
      return { kind: 'confirmed_success', output: { paymentId: `pay_${n}` } } as ExternalToolResult;
    });
    const started = await server.request('POST', runs, { input: { payment_items: items(40) }, certificateId: certId });
    assert.ok(started.status === 201 || started.status === 200, started.bodyText);
    const runId = started.json<RunView>().runId;
    assert.ok(['running', 'waiting'].includes(started.json<RunView>().state), started.bodyText);
    const sentWhileStopped = pay.calls.length;
    assert.ok(sentWhileStopped >= 3 && sentWhileStopped < 40, `${sentWhileStopped} calls`);
    // Reading the run while the stop is engaged sends nothing more, and says why it is held.
    const read = (await server.request('GET', `${runs}/${runId}`)).json<RunView & { held?: string }>();
    assert.match(read.held ?? '', /emergency stop on connector "payments"/);
    assert.equal(pay.calls.length, sentWhileStopped);

    const off = await server.request('POST', `/workspaces/${ws}/emergency-stops/release`, { scope: 'connector', target: 'payments' });
    assert.equal(off.status, 200);
    const after = (await server.request('GET', `${runs}/${runId}`)).json<RunView>();
    assert.equal(after.state, 'completed', JSON.stringify(after.escalation));
    assert.equal(pay.calls.length, 40);
    assert.equal(new Set(pay.calls.map((c) => c.account)).size, 40, 'every item exactly once');
    assert.equal(new Set(pay.calls.map((c) => c.dispatchKey)).size, 40);
  });
});

test('RX-1b: a run has a manifest of what it was bound to, and a signed audit bundle that verifies, and fails once altered', async () => {
  await env(async ({ server, ws, defId, certId, reviewer }) => {
    const runs = `/workspaces/${ws}/generated-workflows/${defId}/runs`;
    const started = await server.request('POST', runs, { input: { payment_items: items(3) }, certificateId: certId });
    const runId = started.json<RunView>().runId;
    const m = (await server.request('GET', `${runs}/${runId}/manifest`)).json<{
      manifest: {
        runId: string;
        definitionId: string;
        certificate: { certificateId: string };
        bindings: Record<string, string>;
        inputDigest: string;
        componentSha256: string;
      };
      digest: string;
      digestOk: boolean;
    }>();
    assert.equal(m.digestOk, true);
    assert.equal(m.manifest.runId, runId);
    assert.equal(m.manifest.definitionId, defId);
    assert.equal(m.manifest.certificate.certificateId, certId);
    assert.deepEqual(Object.keys(m.manifest.bindings), ['payments']);
    assert.match(m.manifest.inputDigest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(m).includes('acct-0'), 'the manifest holds digests, never the input');

    const bundleRes = await server.request('GET', `${runs}/${runId}/audit-bundle`, undefined, reviewer);
    assert.equal(bundleRes.status, 200, bundleRes.bodyText);
    const bundle = bundleRes.json<{
      runs: { runId: string; entries: { data: Record<string, unknown> }[] }[];
      manifest: { digest: string };
    }>();
    assert.equal(bundle.runs.length, 4, 'the batch and its three items');
    assert.equal(bundle.manifest.digest, m.digest);
    const verify = (b: unknown) => server.request('POST', `/workspaces/${ws}/audit-bundles/verify`, b);
    const good = (await verify(bundle)).json<{ ok: boolean; signerKnown: boolean; runs: number; manifest: { digestOk: boolean } }>();
    assert.deepEqual([good.ok, good.signerKnown, good.runs, good.manifest.digestOk], [true, true, 4, true]);

    const altered = structuredClone(bundle);
    altered.runs[1]!.entries[0]!.data['index'] = 99;
    const bad = (await verify(altered)).json<{ ok: boolean; problems: string[] }>();
    assert.equal(bad.ok, false);
    assert.ok(
      bad.problems.some((p) => /chain breaks|signature/.test(p)),
      bad.problems.join('; '),
    );
    assert.equal((await verify({ hello: 1 })).json<{ ok: boolean }>().ok, false);
    assert.equal((await server.request('GET', `${runs}/run_${'0'.repeat(32)}/audit-bundle`)).status, 404);
  });
});
