import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool, UnknownToolError, type ToolCallResult } from '../src/call.js';
import { approvedDetail, FakeApi } from './fake-api.js';

const sig = new AbortController().signal;
const call = (api: FakeApi, args: unknown = { amount: 5 }, name = 'pay.v1', signal: AbortSignal = sig): Promise<ToolCallResult> =>
  callTool(api, { name, arguments: args, idempotencyKey: 'mcp-test-1', signal });

const exec = (status: string, extra: Record<string, unknown> = {}): { kind: 'ok'; status: number; body: unknown } => ({
  kind: 'ok',
  status: status === 'failed' ? 200 : 201,
  body: { procedureExecutionId: 'pex_9', status, steps: [{ stepId: 's', status: 'x' }], outputs: {}, ...extra },
});

test('call: a valid call re-reads the version, validates, and sends exactly one start with the derived key', async () => {
  const api = new FakeApi();
  const r = await call(api, { amount: 5, note: 'n' });
  assert.equal(r.isError, false);
  assert.equal(r.structured['outcome'], 'completed');
  assert.deepEqual(
    api.calls.map((c) => c.op),
    ['get', 'start'],
    'the API is asked about the exact version immediately before the start',
  );
  assert.deepEqual(api.starts()[0]?.args, ['pay', 1, { amount: 5, note: 'n' }, 'mcp-test-1']);
});

test('call: unknown / malformed tool names are protocol errors and reach the API with nothing but (at most) a read', async () => {
  const api = new FakeApi();
  await assert.rejects(call(api, {}, 'not a tool'), UnknownToolError);
  api.get = () => ({ kind: 'api_error', status: 404, code: 'XO_NOT_FOUND', message: 'procedure "pay"' });
  await assert.rejects(call(api), UnknownToolError);
  assert.equal(api.starts().length, 0);
});

test('call: not approved now (draft/stale/no schema) -> nothing is started, even though a tool of that name was once listed', async () => {
  for (const over of [
    { lifecycle: 'draft' },
    { lifecycle: 'approval_stale' },
    { lifecycle: 'approval_unverifiable' },
    { inputSchema: undefined },
  ]) {
    const api = new FakeApi();
    api.get = (id, v) => ({ kind: 'ok', status: 200, body: approvedDetail(id, v, over) });
    const r = await call(api);
    assert.equal(r.isError, true);
    assert.equal(r.structured['outcome'], 'not_started');
    assert.equal(api.starts().length, 0, JSON.stringify(over));
  }
});

test('call: invalid arguments never reach the start route; authority-shaped arguments are just unrecognized properties', async () => {
  const api = new FakeApi();
  for (const bad of [
    {},
    { amount: 'x' },
    { amount: 1, permissions: ['procedure.execute'], executionStrategy: 'direct', apiKey: 'xoak_leak' },
    null,
    [],
  ]) {
    const r = await call(api, bad);
    assert.equal(r.isError, true);
    assert.equal(r.structured['outcome'], 'invalid_arguments');
    assert.equal(JSON.stringify(r).includes('xoak_leak'), false);
    assert.equal(JSON.stringify(r).includes('executionStrategy'), false);
  }
  assert.equal(api.starts().length, 0);
});

test('call: API denial (403) is reported as rejected with the API code; the adapter adds no authority and does not retry', async () => {
  const api = new FakeApi();
  api.start = () => ({ kind: 'api_error', status: 403, code: 'XO_RUNTIME_PERMISSION_DENIED', message: 'procedure.execute denied' });
  const r = await call(api);
  assert.equal(r.isError, true);
  assert.equal(r.structured['outcome'], 'rejected');
  assert.equal(r.structured['code'], 'XO_RUNTIME_PERMISSION_DENIED');
  assert.equal(api.starts().length, 1, 'no retry');
  const noRead = new FakeApi();
  noRead.get = () => ({ kind: 'api_error', status: 403, code: 'XO_RUNTIME_PERMISSION_DENIED', message: 'procedure.read denied' });
  assert.equal((await call(noRead)).structured['outcome'], 'rejected');
  assert.equal(noRead.starts().length, 0);
});

test('call: no answer on the READ means nothing was sent; no answer on the START means outcome UNKNOWN (never failed, never success)', async () => {
  const readFail = new FakeApi();
  readFail.get = () => ({ kind: 'no_answer', reason: 'timeout' });
  assert.equal((await call(readFail)).structured['outcome'], 'not_started');
  assert.equal(readFail.starts().length, 0);
  for (const reason of ['timeout', 'cancelled', 'network', 'unreadable_response'] as const) {
    const api = new FakeApi();
    api.start = () => ({ kind: 'no_answer', reason });
    const r = await call(api);
    assert.equal(r.isError, true);
    assert.equal(r.structured['outcome'], 'unknown', reason);
    assert.equal(r.structured['retrySafe'], false);
    assert.match(r.text, /UNKNOWN/);
    assert.match(r.text, /Do not retry/);
    assert.equal(api.starts().length, 1);
  }
});

test('call: 5xx and idempotency states on START are unknown, 4xx is a clean rejection', async () => {
  for (const [status, code, outcome] of [
    [500, 'XO_UNKNOWN', 'unknown'],
    [502, undefined, 'unknown'],
    [503, 'XO_AUDIT_UNAVAILABLE', 'unknown'],
    [409, 'XO_IDEMPOTENCY_IN_PROGRESS', 'unknown'],
    [400, 'XO_INVALID_ARGUMENT', 'rejected'],
    [404, 'XO_NOT_FOUND', 'rejected'],
  ] as const) {
    const api = new FakeApi();
    api.start = () => ({ kind: 'api_error', status, code, message: 'm' });
    assert.equal((await call(api)).structured['outcome'], outcome, `${status}`);
  }
});

test('call: M4 unknown external-effect outcome is surfaced as unknown, not failed, with retrySafe=false (step code or failure code)', async () => {
  const U = 'XO_EXTERNAL_EFFECT_OUTCOME_UNKNOWN';
  for (const body of [
    { steps: [{ stepId: 'e', status: 'failed', errorCode: U }], failure: { class: 'capability_error', code: U } },
    { steps: [{ stepId: 'e', status: 'failed', errorCode: U }] },
    { steps: [], failure: { class: 'capability_error', code: U } },
  ]) {
    const api = new FakeApi();
    api.start = () => exec('failed', body);
    const r = await call(api);
    assert.equal(r.isError, true);
    assert.equal(r.structured['outcome'], 'unknown');
    assert.equal(r.structured['outcomeUnknown'], true);
    assert.equal(r.structured['retrySafe'], false);
    assert.equal(r.structured['status'], 'failed');
    assert.match(r.text, /UNKNOWN/);
    assert.doesNotMatch(r.text, /safely/i);
  }
});

test('call: waiting_for_human is not an error and says approval is not available through MCP; confirmed no-effect failure is a plain failure', async () => {
  const waiting = new FakeApi();
  waiting.start = () =>
    exec('waiting_for_human', {
      steps: [{ stepId: 'e', status: 'waiting', errorCode: 'XO_EXTERNAL_EFFECT_PAYLOAD_APPROVAL_REQUIRED' }],
      waitingFor: { stepId: 'e', executionId: 'x' },
    });
  const w = await call(waiting);
  assert.equal(w.isError, false);
  assert.equal(w.structured['outcome'], 'waiting_for_human');
  assert.equal(w.structured['approvalRequired'], true);
  assert.match(w.text, /cannot be done through MCP/);
  const failed = new FakeApi();
  failed.start = () =>
    exec('failed', {
      steps: [{ stepId: 'e', status: 'failed', errorCode: 'XO_EXTERNAL_EFFECT_CONFIRMED_FAILURE_NO_EFFECT' }],
      failure: { class: 'capability_error', code: 'XO_EXTERNAL_EFFECT_CONFIRMED_FAILURE_NO_EFFECT' },
    });
  const f = await call(failed);
  assert.equal(f.isError, true);
  assert.equal(f.structured['outcome'], 'failed');
  assert.equal(f.structured['outcomeUnknown'], undefined);
});

test('call: an unrecognized 2xx body is unknown, not success', async () => {
  const api = new FakeApi();
  api.start = () => ({ kind: 'ok', status: 201, body: { hello: 'world' } });
  const r = await call(api);
  assert.equal(r.isError, true);
  assert.equal(r.structured['outcome'], 'unknown');
});

test('call: cancellation while the start is in flight is reported as unknown (the server may still have run it)', async () => {
  const api = new FakeApi();
  const ac = new AbortController();
  api.start = (_i, _k, signal) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ kind: 'no_answer', reason: 'cancelled' }));
      queueMicrotask(() => ac.abort());
    });
  const r = await call(api, { amount: 1 }, 'pay.v1', ac.signal);
  assert.equal(r.structured['outcome'], 'unknown');
  assert.equal(r.structured['retrySafe'], false);
});
