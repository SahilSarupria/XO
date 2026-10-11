import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ErrorCode } from '@xo/errors';
import { TestServer } from './test-helpers.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

/**
 * WP2-B: the capability projection publishes the authoritative input contract (the lowered
 * declaration's `inputSchema`). These tests tie the PUBLISHED contract to what execution actually
 * ENFORCES, so the two cannot drift: a contract that only looked right would fail here.
 */

type Prop = { readonly type: 'string' | 'number' | 'boolean' };
interface Contract {
  readonly type: 'object';
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, Prop>>;
}
interface CapabilityWire {
  readonly capabilityId: string;
  readonly status: string;
  readonly executionClass?: string;
  readonly inputContract?: Contract;
}
interface ExecutionWire {
  readonly status: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

const PDF = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));
const sample = (t: Prop['type']): unknown => (t === 'string' ? 'x' : t === 'number' ? 1 : true);

async function compile(server: TestServer) {
  const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
  const source = (
    await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=policy.pdf`, await readFile(PDF))
  ).json<{ sourceId: string }>();
  const compiled = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/${source.sourceId}/compile`)).json<{
    compilationId: string;
    status: string;
  }>();
  assert.equal(compiled.status, 'succeeded');
  const caps = (
    await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations/${compiled.compilationId}/capabilities`)
  ).json<{ capabilities: readonly CapabilityWire[] }>().capabilities;
  return { workspaceId: workspace.workspaceId, compilationId: compiled.compilationId, caps };
}

async function approveAndRun(
  server: TestServer,
  ctx: { workspaceId: string; compilationId: string },
  capabilityId: string,
  input: unknown,
) {
  const approve = await server.request(
    'POST',
    `/workspaces/${ctx.workspaceId}/compilations/${ctx.compilationId}/capabilities/${capabilityId}/approve`,
  );
  assert.ok(approve.status === 200, `approve ${capabilityId}: ${approve.status}`);
  const res = await server.request('POST', `/workspaces/${ctx.workspaceId}/executions`, {
    compilationId: ctx.compilationId,
    capabilityId,
    input,
  });
  assert.ok(res.status === 200 || res.status === 201, `execute ${capabilityId}: ${res.status}`); // 201 = executed to success, 200 = persisted failure
  return res.json<ExecutionWire>();
}

test('every published contract is well-formed, and unresolved capabilities publish none', async () => {
  const server = await TestServer.start();
  try {
    const { caps } = await compile(server);
    const withContract = caps.filter((c) => c.inputContract !== undefined);
    assert.ok(withContract.length > 0, 'the real fixture must publish at least one contract');
    for (const c of withContract) {
      const k = c.inputContract!;
      assert.equal(k.type, 'object');
      assert.ok(Array.isArray(k.required));
      for (const r of k.required) assert.ok(r in k.properties, `${c.capabilityId}: required "${r}" must be a declared property`);
      for (const p of Object.values(k.properties)) assert.ok(['string', 'number', 'boolean'].includes(p.type));
    }
    for (const c of caps.filter((x) => x.status !== 'resolved'))
      assert.equal(c.inputContract, undefined, `${c.capabilityId} (${c.status}) must not publish a contract`);
  } finally {
    await server.stop();
  }
});

test('PUBLISHED = ENFORCED: omitting any required property is rejected by execution as INPUT_INVALID, naming that property', async () => {
  const server = await TestServer.start();
  try {
    const ctx = await compile(server);
    const target = ctx.caps.find(
      (c) => c.executionClass === 'deterministic_rule' && c.inputContract !== undefined && c.inputContract.required.length > 0,
    );
    assert.ok(target, 'need a deterministic capability with required properties');
    const k = target!.inputContract!;
    const full = Object.fromEntries(k.required.map((r) => [r, sample(k.properties[r]!.type)]));
    // first approval happens inside approveAndRun; later calls re-approve idempotently (200)
    for (const missing of k.required) {
      const partial = Object.fromEntries(Object.entries(full).filter(([key]) => key !== missing));
      const exec = await approveAndRun(server, ctx, target!.capabilityId, partial);
      assert.equal(exec.status, 'failed');
      assert.equal(exec.errorCode, ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID);
      assert.match(exec.errorMessage ?? '', new RegExp(`${missing}: missing required property`));
    }
  } finally {
    await server.stop();
  }
});

test('PUBLISHED = ENFORCED (positive control): input built exactly from the contract passes input validation', async () => {
  const server = await TestServer.start();
  try {
    const ctx = await compile(server);
    const checked: string[] = [];
    for (const c of ctx.caps.filter((x) => x.status === 'resolved' && x.inputContract !== undefined)) {
      const k = c.inputContract!;
      const input = Object.fromEntries(k.required.map((r) => [r, sample(k.properties[r]!.type)]));
      const exec = await approveAndRun(server, ctx, c.capabilityId, input);
      assert.notEqual(
        exec.errorCode,
        ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID,
        `${c.capabilityId}: contract-conformant input must not be rejected as invalid (${exec.errorMessage ?? ''})`,
      );
      checked.push(c.capabilityId);
    }
    assert.ok(checked.length > 0);
  } finally {
    await server.stop();
  }
});

test('a property the contract does not declare is rejected by execution (the contract is the complete accepted shape)', async () => {
  const server = await TestServer.start();
  try {
    const ctx = await compile(server);
    const target = ctx.caps.find((c) => c.executionClass === 'deterministic_rule' && c.inputContract !== undefined)!;
    const k = target.inputContract!;
    const input = { ...Object.fromEntries(k.required.map((r) => [r, sample(k.properties[r]!.type)])), definitely_not_declared: 'x' };
    const exec = await approveAndRun(server, ctx, target.capabilityId, input);
    assert.equal(exec.errorCode, ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID);
    assert.match(exec.errorMessage ?? '', /definitely_not_declared: unknown property/);
  } finally {
    await server.stop();
  }
});

test('a wrongly-typed value for a declared property is rejected as INPUT_INVALID', async () => {
  const server = await TestServer.start();
  try {
    const ctx = await compile(server);
    const target = ctx.caps.find(
      (c) => c.executionClass === 'deterministic_rule' && c.inputContract !== undefined && c.inputContract.required.length > 0,
    )!;
    const k = target.inputContract!;
    const first = k.required[0]!;
    const wrong = k.properties[first]!.type === 'number' ? 'not-a-number' : 12345;
    const input = { ...Object.fromEntries(k.required.map((r) => [r, sample(k.properties[r]!.type)])), [first]: wrong };
    const exec = await approveAndRun(server, ctx, target.capabilityId, input);
    assert.equal(exec.errorCode, ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID);
    assert.match(exec.errorMessage ?? '', new RegExp(`${first}: expected`));
  } finally {
    await server.stop();
  }
});
