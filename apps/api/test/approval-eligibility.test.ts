import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalFsBlobStore } from '@xo/storage';
import { ErrorCode } from '@xo/errors';
import { TestServer, withTempDir } from './test-helpers.js';
import { FsApprovalStore } from '../src/approvals/fs-approval-store.js';
import { approvalBlockedCode } from '../src/approvals/approval-eligibility.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

/**
 * WP2-A: an approval is an acknowledgement about a capability the platform can actually carry
 * out. It must not be recordable for a capability whose binding is not `resolved`, and — as
 * defence in depth — execution must keep refusing such a capability even if an approval
 * record for it already exists (e.g. written before this check existed).
 *
 * These go through the real HTTP routes and the real execution boundary, on the real
 * Commercial Property fixture (20 resolved, 13 unresolved capabilities at time of writing).
 */

interface CapabilityWire {
  readonly capabilityId: string;
  readonly status: string;
  readonly executionClass?: string;
  readonly approved: boolean;
}
interface ErrorWire {
  readonly error: { readonly code: string; readonly message: string };
}

const PDF = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));

async function setup(server: TestServer) {
  const { readFile } = await import('node:fs/promises');
  const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
  const source = (
    await server.request('POST', `/workspaces/${workspace.workspaceId}/sources?filename=policy.pdf`, await readFile(PDF))
  ).json<{ sourceId: string }>();
  const compiled = (await server.request('POST', `/workspaces/${workspace.workspaceId}/sources/${source.sourceId}/compile`)).json<{
    compilationId: string;
    status: string;
  }>();
  assert.equal(compiled.status, 'succeeded', 'fixture setup: compilation must succeed');
  const caps = (
    await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations/${compiled.compilationId}/capabilities`)
  ).json<{ capabilities: readonly CapabilityWire[] }>().capabilities;
  const unresolved = caps.find((c) => c.status === 'unresolved');
  const resolved = caps.find((c) => c.status === 'resolved' && c.executionClass === 'deterministic_rule');
  assert.ok(unresolved && resolved, 'fixture setup: need one unresolved and one resolved capability');
  return { workspaceId: workspace.workspaceId, compilationId: compiled.compilationId, unresolved, resolved };
}

const approvePath = (w: string, c: string, cap: string) => `/workspaces/${w}/compilations/${c}/capabilities/${cap}/approve`;

test('NEGATIVE: approving an unresolved capability is refused, nothing is recorded, and it stays unapproved and unexecutable', async () => {
  const server = await TestServer.start();
  try {
    const { workspaceId, compilationId, unresolved } = await setup(server);

    const res = await server.request('POST', approvePath(workspaceId, compilationId, unresolved.capabilityId));
    assert.equal(res.status, 422);
    assert.equal(res.json<ErrorWire>().error.code, ErrorCode.BINDING_UNRESOLVED);
    assert.match(res.json<ErrorWire>().error.message, /cannot be approved/);

    // no approval record was created
    const caps = (await server.request('GET', `/workspaces/${workspaceId}/compilations/${compilationId}/capabilities`)).json<{
      capabilities: readonly CapabilityWire[];
    }>().capabilities;
    assert.equal(caps.find((c) => c.capabilityId === unresolved.capabilityId)?.approved, false);

    // and execution is refused as "not approved" (403) with no execution record
    const exec = await server.request('POST', `/workspaces/${workspaceId}/executions`, {
      compilationId,
      capabilityId: unresolved.capabilityId,
      input: {},
    });
    assert.equal(exec.status, 403);
    const listed = await server.request('GET', `/workspaces/${workspaceId}/executions`);
    assert.deepEqual(listed.json<{ executions: readonly unknown[] }>().executions, []);
  } finally {
    await server.stop();
  }
});

test('POSITIVE CONTROL: approving a resolved capability still works, is recorded, and approval alone does not execute anything', async () => {
  const server = await TestServer.start();
  try {
    const { workspaceId, compilationId, resolved } = await setup(server);

    const res = await server.request('POST', approvePath(workspaceId, compilationId, resolved.capabilityId));
    assert.equal(res.status, 200);
    assert.equal(res.json<{ status: string }>().status, 'approved');

    const caps = (await server.request('GET', `/workspaces/${workspaceId}/compilations/${compilationId}/capabilities`)).json<{
      capabilities: readonly CapabilityWire[];
    }>().capabilities;
    assert.equal(caps.find((c) => c.capabilityId === resolved.capabilityId)?.approved, true);

    // approval and execution are separate actions: nothing ran
    const listed = await server.request('GET', `/workspaces/${workspaceId}/executions`);
    assert.deepEqual(listed.json<{ executions: readonly unknown[] }>().executions, []);
  } finally {
    await server.stop();
  }
});

test('DEFENCE IN DEPTH: a pre-existing approval record for an unresolved capability still cannot execute (binding is re-derived at execution)', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const { workspaceId, compilationId, unresolved } = await setup(server);

      // Simulate a record written before the approve route enforced eligibility.
      const store = new FsApprovalStore(new LocalFsBlobStore(join(dataDir, workspaceId, 'approvals')));
      const seeded = await store.approve(compilationId, unresolved.capabilityId, workspaceId, server.identityId);
      assert.ok(seeded.ok);

      // The projection reports the legacy record truthfully ...
      const caps = (await server.request('GET', `/workspaces/${workspaceId}/compilations/${compilationId}/capabilities`)).json<{
        capabilities: readonly CapabilityWire[];
      }>().capabilities;
      const cap = caps.find((c) => c.capabilityId === unresolved.capabilityId);
      assert.equal(cap?.approved, true);
      assert.equal(cap?.status, 'unresolved');

      // ... but execution independently refuses it.
      const exec = await server.request('POST', `/workspaces/${workspaceId}/executions`, {
        compilationId,
        capabilityId: unresolved.capabilityId,
        input: {},
      });
      assert.equal(exec.status, 200);
      const record = exec.json<{ status: string; errorCode?: string }>();
      assert.equal(record.status, 'failed');
      assert.equal(record.errorCode, ErrorCode.BINDING_UNRESOLVED);
    } finally {
      await server.stop();
    }
  });
});

test('unknown capability and cross-workspace approval remain 404 (eligibility check does not change existing ordering)', async () => {
  const server = await TestServer.start();
  try {
    const { workspaceId, compilationId } = await setup(server);
    const res = await server.request('POST', approvePath(workspaceId, compilationId, 'cap_does_not_exist'));
    assert.equal(res.status, 404);
  } finally {
    await server.stop();
  }
});

test('approvalBlockedCode maps every non-resolved binding status to the same code execution reports, and resolved to none', () => {
  assert.equal(approvalBlockedCode('resolved'), undefined);
  assert.equal(approvalBlockedCode('unresolved'), ErrorCode.BINDING_UNRESOLVED);
  assert.equal(approvalBlockedCode('ambiguous'), ErrorCode.BINDING_AMBIGUOUS);
  assert.equal(approvalBlockedCode('denied'), ErrorCode.BINDING_DENIED);
  // an unrecognised status must fail closed, not be treated as approvable
  assert.equal(approvalBlockedCode('something_new'), ErrorCode.BINDING_UNRESOLVED);
});
