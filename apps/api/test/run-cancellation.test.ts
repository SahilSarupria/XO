/**
 * UW-7 (ADR 0024, ADR 0033) through the API: cancelling a 300-item batch while another request drives it (UAC-31), a 300-item
 * batch that loses its connection mid-way (UAC-8), the effect report (UAC-9), reconciliation by a person, and the Workflow entity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { ExternalToolAdapter, ExternalToolResult } from '@xo/adapters';
import { NonProductionAuditSink } from '@xo/audit';
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
  }) => Promise<void>,
) {
  await withTempDir('xo-api-cancel-', async (dir) => {
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
      await fn({ server, pay, ws, defId: def.definitionId, certId: cert.certificateId, audit });
    } finally {
      await server.stop();
    }
  });
}

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ amount: 1, account: `acct-${i}` }));

test('UAC-31: cancelling a 300-item batch while another request drives it: nothing starts after the cancel, settled items stand, a repeat is harmless, all audited', async () => {
  await env(async ({ server, pay, ws, defId, certId, audit }) => {
    const runs = `/workspaces/${ws}/generated-workflows/${defId}/runs`;
    let runId: string | undefined;
    let cancelResponse: Promise<{ status: number; bodyText: string }> | undefined;
    let callsWhenCancelled = 0;
    pay.behave(async (n) => {
      // Mid-batch, someone else cancels it through the API: a second request, its own runner, while this one holds the lease.
      if (n === 60)
        cancelResponse = server
          .request('GET', runs)
          .then((r) => {
            runId = r.json<{ runs: { runId: string; state: string }[] }>().runs.find((x) => x.runId.startsWith('run_'))?.runId;
            return server.request('POST', `${runs}/${runId}/cancel`, { reason: 'wrong attachment' });
          })
          .then((r) => {
            callsWhenCancelled = pay.calls.length;
            return r;
          });
      return { kind: 'confirmed_success', output: { paymentId: `pay_${n}` } } as ExternalToolResult;
    });

    const started = await server.request('POST', runs, { input: { payment_items: items(300) }, certificateId: certId });
    assert.ok(started.status === 201 || started.status === 200, started.bodyText);
    const cancelled = await cancelResponse;
    assert.ok(cancelled !== undefined, 'the cancel was sent mid-batch');
    assert.equal(cancelled!.status, 200, cancelled!.bodyText);
    const asked = JSON.parse(cancelled!.bodyText) as RunView;
    assert.equal(asked.runId, runId, 'the cancel named the running batch');
    assert.equal(asked.cancelRecorded, true);
    const done = started.json<RunView>();
    assert.equal(done.state, 'cancelled', JSON.stringify(done.escalation));
    const sent = pay.calls.length;
    // Items run one at a time here, so at most the call already under way when the cancel was recorded finishes.
    assert.ok(sent >= 60 && sent <= callsWhenCancelled + 1, `${sent} sent, ${callsWhenCancelled} when the cancel was recorded`);
    const summary = done.outputs as { completed: number; cancelledItems: number; notStarted: number; escalated: number };
    assert.equal(summary.completed, sent, 'every item that sent stands as completed');
    assert.equal(summary.completed + summary.cancelledItems + summary.notStarted, 300);
    assert.equal(new Set(pay.calls.map((c) => c.dispatchKey)).size, sent, 'no item was sent twice');

    // A repeat is harmless; the view says who cancelled and that it was applied.
    const again = await server.request('POST', `${runs}/${runId}/cancel`, {});
    assert.equal(again.status, 200);
    const rv = again.json<RunView>();
    assert.equal(rv.cancelRecorded, false);
    assert.equal(rv.state, 'cancelled');
    assert.equal(rv.cancellation?.by, 'test-identity');
    assert.equal(pay.calls.length, sent);

    const events = audit.events().filter((e) => e.type === 'generated-workflow.run.cancelled');
    assert.deepEqual(events.map((e) => (e.metadata as { recorded: boolean }).recorded).sort(), [false, true], 'both requests are audited');
  });
});

test('UAC-8 / UAC-9: a 300-item batch that loses its connection mid-way never re-sends; unknown outcomes block until a person reconciles them', async () => {
  await env(async ({ server, pay, ws, defId, certId, audit }) => {
    const runs = `/workspaces/${ws}/generated-workflows/${defId}/runs`;
    // Calls 100 to 104 are sent and no answer comes back (the connection dropped); then the connection recovers.
    pay.behave((n) =>
      n >= 100 && n <= 104
        ? ({ kind: 'outcome_unknown', reason: 'connection reset after the request was written' } as ExternalToolResult)
        : ({ kind: 'confirmed_success', output: { paymentId: `pay_${n}` } } as ExternalToolResult),
    );
    const started = await server.request('POST', runs, { input: { payment_items: items(300) }, certificateId: certId });
    assert.ok(started.status === 201 || started.status === 200, started.bodyText);
    const batch = started.json<RunView>();
    assert.equal(batch.state, 'escalated');
    assert.equal(batch.escalation?.code, 'ITEMS_NEED_ATTENTION');
    const summary = batch.outputs as { completed: number; escalated: number; items: { runId: string; state: string }[] };
    // Items 1 to 99 went through. Items 100 to 104 were sent and got no answer: each is blocked for a person, never re-sent.
    // After five failures in a row the connector's circuit opens, so the remaining items stop WITHOUT being sent and go to a
    // person (CIRCUIT_OPEN); none of them is guessed to have succeeded, and none is sent later on its own.
    assert.equal(summary.completed, 99);
    assert.equal(summary.escalated, 201);
    const codes = new Map<string, number>();
    for (const i of summary.items as { escalation?: { code: string } }[])
      if (i.escalation !== undefined) codes.set(i.escalation.code, (codes.get(i.escalation.code) ?? 0) + 1);
    assert.deepEqual(Object.fromEntries(codes), { EFFECT_UNKNOWN: 5, CIRCUIT_OPEN: 196 });
    const perKey = new Map<string, number>();
    for (const c of pay.calls) perKey.set(c.dispatchKey, (perKey.get(c.dispatchKey) ?? 0) + 1);
    assert.equal(pay.calls.length, 104, 'one send per item that was sent: nothing was re-sent blindly');
    assert.ok([...perKey.values()].every((n) => n === 1));
    const unsent = (summary.items as { runId: string; escalation?: { code: string } }[]).find(
      (i) => i.escalation?.code === 'CIRCUIT_OPEN',
    )!;
    assert.deepEqual((await server.request('GET', `${runs}/${unsent.runId}`)).json<RunView>().effects, [], 'an unsent item made no call');

    const blocked = (summary.items as { runId: string; escalation?: { code: string } }[]).filter(
      (i) => i.escalation?.code === 'EFFECT_UNKNOWN',
    );
    const item = (await server.request('GET', `${runs}/${blocked[0]!.runId}`)).json<RunView>();
    assert.deepEqual(
      item.effects.map((e) => e.state),
      ['outcome_unknown'],
      'the run report says the outcome is unknown',
    );
    const fine = summary.items.find((i) => i.state === 'completed')!;
    assert.deepEqual(
      (await server.request('GET', `${runs}/${fine.runId}`)).json<RunView>().effects.map((e) => e.state),
      ['confirmed_success'],
    );

    // UW-12b: the inbox lists the five unknown outcomes, each named by its batch and item, for a person to reconcile.
    const attentionOf = async () =>
      (await server.request('GET', `/workspaces/${ws}/control/inbox`)).json<{
        attention: { runId: string; parentRunId?: string; item?: number; state: string; definitionId: string }[];
      }>().attention;
    const waiting = await attentionOf();
    assert.equal(waiting.length, 5);
    assert.deepEqual(new Set(waiting.map((a) => a.parentRunId)), new Set([batch.runId]));
    assert.deepEqual(waiting.map((a) => a.runId).sort(), blocked.map((b) => b.runId).sort());
    assert.ok(waiting.every((a) => a.state === 'outcome_unknown' && a.definitionId === defId && typeof a.item === 'number'));

    // A person checks the destination and records what happened. Nothing is sent.
    const step = item.effects[0]!.step;
    const at = `${runs}/${blocked[0]!.runId}/effects/${step}/reconciliation`;
    assert.equal((await server.request('POST', at, { decision: 'maybe', reason: 'x' })).status, 400);
    assert.equal((await server.request('POST', at, { decision: 'confirmed_success' })).status, 400, 'a reason is required');
    const rec = await server.request('POST', at, {
      decision: 'confirmed_success',
      reason: 'payment pay_100 is in the provider dashboard',
      evidenceExamined: 'provider dashboard, 16 Nov',
    });
    assert.equal(rec.status, 200, rec.bodyText);
    assert.equal(rec.json<{ effect: Effect }>().effect.state, 'confirmed_success');
    assert.equal((await server.request('POST', at, { decision: 'confirmed_success', reason: 'again' })).status, 412, 'already settled');
    assert.equal(pay.calls.length, 104, 'reconciling never re-sends');
    assert.equal((await attentionOf()).length, 4, 'a reconciled call leaves the inbox');
    const reconciled = audit.events().filter((e) => e.type === 'generated-workflow.effect.reconciled');
    assert.deepEqual(
      reconciled.map((e) => (e.metadata as { decision: string }).decision),
      ['confirmed_success'],
    );
  });
});

test('Workflow entity: cancel and reconcile through the workflow; another workflow cannot reach its runs; the lifecycle follows', async () => {
  await env(async ({ server, pay, ws, defId }) => {
    const base = `/workspaces/${ws}/workflow-entities`;
    const wf = (await server.request('POST', base, { definitionId: defId })).json<{ workflow: { workflowId: string } }>().workflow;
    const other = (await server.request('POST', base, { definitionId: defId, name: 'other' })).json<{ workflow: { workflowId: string } }>()
      .workflow;
    await server.request('POST', `${base}/${wf.workflowId}/readiness`, {});
    pay.behave((n) =>
      n === 2
        ? ({ kind: 'outcome_unknown', reason: 'timeout' } as ExternalToolResult)
        : ({ kind: 'confirmed_success', output: { paymentId: `p${n}` } } as ExternalToolResult),
    );
    const startedRun = await server.request('POST', `${base}/${wf.workflowId}/runs`, { input: { payment_items: items(3) } });
    const run = startedRun.json<RunView & { outputs: { items: { runId: string; state: string }[] } }>();
    assert.equal(run.state, 'escalated');
    const lifecycle = async () => (await server.request('GET', `${base}/${wf.workflowId}`)).json<{ lifecycle: string }>().lifecycle;
    assert.equal(await lifecycle(), 'needs_attention');
    const unknownItem = run.outputs.items.find((i) => i.state === 'escalated')!;
    const step = (await server.request('GET', `${base}/${wf.workflowId}/runs/${unknownItem.runId}`)).json<RunView>().effects[0]?.step;
    // The run belongs to wf, not to other.
    assert.equal(
      (
        await server.request('POST', `${base}/${other.workflowId}/runs/${unknownItem.runId}/effects/${step}/reconciliation`, {
          decision: 'confirmed_failure_no_effect',
          reason: 'x',
        })
      ).status,
      404,
    );
    assert.equal((await server.request('POST', `${base}/${other.workflowId}/runs/${run.runId}/cancel`, {})).status, 404);
    const rec = await server.request('POST', `${base}/${wf.workflowId}/runs/${unknownItem.runId}/effects/${step}/reconciliation`, {
      decision: 'confirmed_failure_no_effect',
      reason: 'not in the provider dashboard',
    });
    assert.equal(rec.status, 200, rec.bodyText);
    // Cancelling a run that has finished changes nothing and is still recorded and audited.
    const c = await server.request('POST', `${base}/${wf.workflowId}/runs/${run.runId}/cancel`, { reason: 'late' });
    assert.equal(c.status, 200, c.bodyText);
    assert.equal(c.json<RunView>().state, 'escalated');
    assert.equal(c.json<RunView>().cancellation?.applied, false);
    assert.equal((await server.request('POST', `${base}/${wf.workflowId}/runs/${run.runId}/cancel`, { bogus: 1 })).status, 400);
  });
});
