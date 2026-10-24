import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverTools, MAX_TOOLS, parseToolName, readDetail, readInputSchema, toolNameOf, validateArguments } from '../src/tools.js';
import { approvedDetail, FakeApi } from './fake-api.js';

const sig = new AbortController().signal;

test('tool names are lookup keys: strict grammar round-trips and rejects everything else', () => {
  assert.deepEqual(parseToolName('pay.v3'), { procedureId: 'pay', version: 3 });
  assert.equal(toolNameOf({ procedureId: 'a-b_c', version: 12 }), 'a-b_c.v12');
  for (const bad of [
    'pay',
    'pay.v0',
    'pay.v01',
    '.v1',
    'pay.v1x',
    'pay v1',
    '1pay.v1',
    'pay.v1\n',
    '__proto__.v1',
    'constructor.v1',
    `${'a'.repeat(200)}.v1`,
    '../x.v1',
  ]) {
    assert.equal(parseToolName(bad), undefined, bad);
  }
});

test('input schema from the API is re-checked strictly; anything unexpected is not callable', () => {
  const good = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
  assert.ok(readInputSchema(good));
  for (const bad of [
    undefined,
    null,
    [],
    { ...good, additionalProperties: true },
    { ...good, type: 'array' },
    { ...good, properties: { a: { type: 'object' } } },
    { ...good, properties: { a: 'string' } },
    { ...good, required: ['missing'] },
    { ...good, required: [1] },
    { type: 'object', properties: {}, additionalProperties: false },
  ]) {
    assert.equal(readInputSchema(bad), undefined, JSON.stringify(bad));
  }
});

test('readDetail only accepts the exact approved version it asked about', () => {
  const ref = { procedureId: 'pay', version: 1 };
  assert.ok(readDetail(ref, approvedDetail('pay', 1)));
  assert.equal(readDetail(ref, approvedDetail('pay', 2)), undefined);
  assert.equal(readDetail(ref, approvedDetail('other', 1)), undefined);
  assert.equal(readDetail(ref, approvedDetail('pay', 1, { lifecycle: 'draft' })), undefined);
  assert.equal(readDetail(ref, approvedDetail('pay', 1, { lifecycle: 'approval_stale' })), undefined);
  assert.equal(readDetail(ref, approvedDetail('pay', 1, { inputSchema: undefined })), undefined);
});

test('argument validation is closed, typed, and never echoes values or unrecognized property names', () => {
  const schema = readInputSchema((approvedDetail() as { inputSchema: unknown }).inputSchema)!;
  assert.deepEqual(validateArguments(schema, { amount: 5 }), []);
  assert.deepEqual(validateArguments(schema, { amount: 5, note: 'x' }), []);
  const missing = validateArguments(schema, {});
  assert.equal(missing[0]?.property, 'amount');
  const wrong = validateArguments(schema, { amount: 'SECRET-VALUE' });
  assert.equal(wrong[0]?.property, 'amount');
  assert.equal(JSON.stringify(wrong).includes('SECRET-VALUE'), false);
  const extra = validateArguments(schema, { amount: 1, XO_API_KEY: 'xoak_leak', permissions: ['admin'], executionStrategy: 'direct' });
  assert.equal(extra.length, 3);
  assert.ok(extra.every((p) => p.property === '(unrecognized property)'));
  assert.equal(JSON.stringify(extra).includes('xoak_leak'), false);
  assert.equal(JSON.stringify(extra).includes('permissions'), false);
  for (const notObject of [null, 'x', 5, [], true]) assert.equal(validateArguments(schema, notObject).length, 1);
});

test('discovery lists ONLY approved versions with a usable schema, and issues no start request', async () => {
  const api = new FakeApi();
  api.list = {
    kind: 'ok',
    status: 200,
    body: {
      procedures: [
        {
          procedureId: 'pay',
          versions: [
            { version: 1, lifecycle: 'draft' },
            { version: 2, lifecycle: 'approved' },
            { version: 3, lifecycle: 'approval_stale' },
          ],
        },
        { procedureId: 'noschema', versions: [{ version: 1, lifecycle: 'approved' }] },
        { procedureId: 'liar', versions: [{ version: 1, lifecycle: 'approved' }] },
      ],
    },
  };
  api.get = (id, v) => {
    if (id === 'noschema') return { kind: 'ok', status: 200, body: approvedDetail(id, v, { inputSchema: undefined }) };
    if (id === 'liar') return { kind: 'ok', status: 200, body: approvedDetail(id, v, { lifecycle: 'draft' }) }; // list said approved; the re-read says no
    return { kind: 'ok', status: 200, body: approvedDetail(id, v) };
  };
  const found = await discoverTools(api, sig);
  assert.equal(found.kind, 'ok');
  assert.deepEqual(found.kind === 'ok' ? found.tools.map((t) => t.name) : [], ['pay.v2']);
  assert.equal(api.starts().length, 0, 'discovery never starts anything');
});

test('discovery: API refusal or no answer is a failure, never an empty list; a bound caps tool count', async () => {
  const api = new FakeApi();
  api.list = { kind: 'api_error', status: 403, code: 'XO_RUNTIME_PERMISSION_DENIED', message: 'denied' };
  assert.equal((await discoverTools(api, sig)).kind, 'failed');
  api.list = { kind: 'no_answer', reason: 'timeout' };
  assert.equal((await discoverTools(api, sig)).kind, 'failed');
  api.list = {
    kind: 'ok',
    status: 200,
    body: {
      procedures: [
        { procedureId: 'p', versions: Array.from({ length: MAX_TOOLS + 5 }, (_, i) => ({ version: i + 1, lifecycle: 'approved' })) },
      ],
    },
  };
  const capped = await discoverTools(api, sig);
  assert.ok(capped.kind === 'ok' && capped.tools.length === MAX_TOOLS && capped.truncated);
});
