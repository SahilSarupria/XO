import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TestServer, withTempDir } from './test-helpers.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

interface SourceWire {
  readonly sourceId: string;
}
interface CompilationWire {
  readonly compilationId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
}
interface CapabilityWire {
  readonly capabilityId: string;
  readonly status: string;
  readonly executionClass?: string;
  readonly approved: boolean;
}
interface ApprovalWire {
  readonly compilationId: string;
  readonly capabilityId: string;
  readonly workspaceId: string;
  readonly identityId: string;
  readonly status: 'approved';
  readonly approvedAt: string;
  readonly approverIdentityId: string;
}
interface ExecutionWire {
  readonly executionId: string;
  readonly workspaceId: string;
  readonly identityId: string;
  readonly compilationId: string;
  readonly capabilityId: string;
  readonly status: 'succeeded' | 'failed' | 'waiting_for_human';
  readonly requestedAt: string;
  readonly completedAt?: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly graphHash?: string;
  readonly contractContentHash?: string;
}

const OBLIGATION_MARKDOWN =
  '# Vendor Agreement\n\n' +
  'Acme Corp shall send a confirmation email to the Client upon completion of each milestone.\n\n' +
  'The team shall generate a summary report weekly and deliver it to the Client.\n' +
  'The team shall notify the Client of any delay within 24 hours.\n';

// Real, checked-in fixture, proven (see this milestone's own audit) to
// discover 30 capabilities from this exact compiler build: 18
// deterministic_rule, 11 unresolved, 1 human_in_the_loop — enough to
// exercise all three execution classes from a single compilation.
const COMMERCIAL_PROPERTY_PDF = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));
const DETERMINISTIC_CAPABILITY_ID = 'cap_rule_0f731679e7120779542267faaabe10ff'; // "Both Manager Approval And Loss-adjuster Assessment Are Required" — requires { claim_amount: number, loss: string }
const HITL_CAPABILITY_ID = 'cap_ce5ac3d1b7e3d22d184b1d089f8c3522'; // "Review not covered under standard rule"

async function createWorkspace(server: TestServer, extraHeaders?: Readonly<Record<string, string>>): Promise<WorkspaceRecord> {
  return (await server.request('POST', '/workspaces', {}, extraHeaders)).json<WorkspaceRecord>();
}

async function uploadAndCompile(server: TestServer, workspaceId: string, filename: string, bytes: Buffer, extraHeaders?: Readonly<Record<string, string>>): Promise<{ sourceId: string; compilationId: string }> {
  const source = (await server.request('POST', `/workspaces/${workspaceId}/sources?filename=${filename}`, bytes, extraHeaders)).json<SourceWire>();
  const compiled = (await server.request('POST', `/workspaces/${workspaceId}/sources/${source.sourceId}/compile`, undefined, extraHeaders)).json<CompilationWire>();
  assert.equal(compiled.status, 'succeeded', 'test fixture setup: expected compilation to succeed');
  return { sourceId: source.sourceId, compilationId: compiled.compilationId };
}

test('full customer-value demo: workspace -> upload -> compile -> capabilities -> approve -> reject unapproved execution -> execute approved deterministic capability -> real result + persisted record', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      // 1. Create workspace.
      const workspace = await createWorkspace(server);

      // 2-3. Upload source, start compilation.
      const pdfBytes = await readFile(COMMERCIAL_PROPERTY_PDF);
      const { compilationId } = await uploadAndCompile(server, workspace.workspaceId, 'policy.pdf', pdfBytes);

      // 4. Retrieve discovered capabilities.
      const capsRes = await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities`);
      assert.equal(capsRes.status, 200);
      const caps = capsRes.json<{ capabilities: readonly CapabilityWire[] }>().capabilities;
      const deterministic = caps.find((c) => c.capabilityId === DETERMINISTIC_CAPABILITY_ID);
      const another = caps.find((c) => c.capabilityId !== DETERMINISTIC_CAPABILITY_ID && c.status === 'resolved');
      assert.ok(deterministic, 'expected the pinned deterministic capability to be discovered');
      assert.ok(another, 'expected at least one other resolved capability to exist for the unapproved-rejection step');
      assert.equal(deterministic.executionClass, 'deterministic_rule');
      assert.equal(deterministic.approved, false);
      // Explicitly report which execution class this demo exercises, per the milestone brief's requirement.
      console.log(`[P0.5 demo] selected capability "${DETERMINISTIC_CAPABILITY_ID}" is classified: ${deterministic.executionClass}`);

      // 5. Approve one capability.
      const approveRes = await server.request('POST', `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities/${DETERMINISTIC_CAPABILITY_ID}/approve`);
      assert.equal(approveRes.status, 200);
      const approval = approveRes.json<ApprovalWire>();
      assert.equal(approval.capabilityId, DETERMINISTIC_CAPABILITY_ID);
      assert.equal(approval.status, 'approved');
      assert.equal(approval.approverIdentityId, server.identityId);

      // 6. Attempt execution before approval for another (unapproved) capability — must be rejected.
      const rejectedRes = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions`, { compilationId, capabilityId: another!.capabilityId, input: {} });
      assert.equal(rejectedRes.status, 403);

      // 7. Execute the approved deterministic capability.
      const execRes = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions`, { compilationId, capabilityId: DETERMINISTIC_CAPABILITY_ID, input: { claim_amount: 15000, loss: 'fire' } });
      assert.equal(execRes.status, 201);
      const execution = execRes.json<ExecutionWire>();
      assert.equal(execution.status, 'succeeded');
      assert.equal(execution.capabilityId, DETERMINISTIC_CAPABILITY_ID);
      assert.equal(execution.workspaceId, workspace.workspaceId);
      assert.equal(execution.identityId, server.identityId);
      // 8. Confirm the real result (not fabricated) and the persisted execution record.
      // P0.9B: the record names the exact graph and contract content that ran.
      assert.match(execution.graphHash ?? '', /^sha256:[0-9a-f]{64}$/);
      assert.match(execution.contractContentHash ?? '', /^sha256:[0-9a-f]{64}$/);
      assert.deepEqual(execution.output, { matched: false }); // real rule evaluation against real input — pinned to this fixture's actual current behavior, not invented
      assert.ok(execution.completedAt);

      const fetchedExecution = await server.request('GET', `/workspaces/${workspace.workspaceId}/executions/${execution.executionId}`);
      assert.equal(fetchedExecution.status, 200);
      assert.deepEqual(fetchedExecution.json<ExecutionWire>(), execution);

      const listedExecutions = await server.request('GET', `/workspaces/${workspace.workspaceId}/executions`);
      const ids = listedExecutions.json<{ executions: readonly ExecutionWire[] }>().executions.map((e) => e.executionId);
      assert.ok(ids.includes(execution.executionId));
    } finally {
      await server.stop();
    }
  });
});

test('HITL capability execution returns an honest waiting_for_human status, never a fabricated success', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const pdfBytes = await readFile(COMMERCIAL_PROPERTY_PDF);
      const { compilationId } = await uploadAndCompile(server, workspace.workspaceId, 'policy.pdf', pdfBytes);

      await server.request('POST', `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities/${HITL_CAPABILITY_ID}/approve`);
      const execRes = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions`, { compilationId, capabilityId: HITL_CAPABILITY_ID, input: {} });

      assert.equal(execRes.status, 201);
      const execution = execRes.json<ExecutionWire>();
      assert.equal(execution.status, 'waiting_for_human');
      assert.equal((execution.output as { status?: string } | undefined)?.status, 'escalation_required');
      // Never claim completion for a HITL step — no success/failure error code either.
      assert.equal(execution.errorCode, undefined);
    } finally {
      await server.stop();
    }
  });
});

test('input contract validation is enforced: a missing required field is rejected before execution, as a structured failed execution record', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir });
    try {
      const workspace = await createWorkspace(server);
      const pdfBytes = await readFile(COMMERCIAL_PROPERTY_PDF);
      const { compilationId } = await uploadAndCompile(server, workspace.workspaceId, 'policy.pdf', pdfBytes);
      await server.request('POST', `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities/${DETERMINISTIC_CAPABILITY_ID}/approve`);

      // Missing required "loss" field.
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions`, { compilationId, capabilityId: DETERMINISTIC_CAPABILITY_ID, input: { claim_amount: 15000 } });
      assert.equal(res.status, 200); // a failed execution is still a normal, successful HTTP response about that failure
      const execution = res.json<ExecutionWire>();
      assert.equal(execution.status, 'failed');
      assert.equal(execution.errorCode, 'XO_RUNTIME_CAPABILITY_INPUT_INVALID');
      assert.match(execution.errorMessage ?? '', /loss/);
      assert.equal(execution.output, undefined);
    } finally {
      await server.stop();
    }
  });
});

test('unresolved capability cannot execute: rejected with a structured error, never silently routed through a deterministic path', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const { compilationId } = await uploadAndCompile(server, workspace.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));

    const capsRes = await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities`);
    const unresolved = capsRes.json<{ capabilities: readonly CapabilityWire[] }>().capabilities.find((c) => c.status === 'unresolved');
    assert.ok(unresolved, 'test fixture setup: expected an unresolved capability from obligation-language markdown');

    // Approve it anyway — approval doesn't require executability; the execution route itself must independently refuse to run it.
    const approveRes = await server.request('POST', `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities/${unresolved!.capabilityId}/approve`);
    assert.equal(approveRes.status, 200);

    const execRes = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions`, { compilationId, capabilityId: unresolved!.capabilityId, input: {} });
    assert.equal(execRes.status, 200);
    const execution = execRes.json<ExecutionWire>();
    assert.equal(execution.status, 'failed');
    assert.equal(execution.errorCode, 'XO_BINDING_UNRESOLVED');
  } finally {
    await server.stop();
  }
});

test('unapproved capability execution is rejected (403) and no execution record is created for it', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const { compilationId } = await uploadAndCompile(server, workspace.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));
    const capsRes = await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities`);
    const anyCapability = capsRes.json<{ capabilities: readonly CapabilityWire[] }>().capabilities[0]!;

    const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions`, { compilationId, capabilityId: anyCapability.capabilityId, input: {} });
    assert.equal(res.status, 403);

    const listed = await server.request('GET', `/workspaces/${workspace.workspaceId}/executions`);
    assert.deepEqual(listed.json<{ executions: readonly ExecutionWire[] }>().executions, []);
  } finally {
    await server.stop();
  }
});

test('approval persists after a fresh server instance starts against the same workspacesDir/workspaceDataDir', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    await withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const identityId = 'restart-identity';
      const server1 = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir }, identityId);
      let workspaceId: string;
      let compilationId: string;
      let capabilityId: string;
      try {
        const workspace = await createWorkspace(server1);
        workspaceId = workspace.workspaceId;
        const result = await uploadAndCompile(server1, workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));
        compilationId = result.compilationId;
        const capsRes = await server1.request('GET', `/workspaces/${workspaceId}/compilations/${compilationId}/capabilities`);
        capabilityId = capsRes.json<{ capabilities: readonly CapabilityWire[] }>().capabilities[0]!.capabilityId;
        const approveRes = await server1.request('POST', `/workspaces/${workspaceId}/compilations/${compilationId}/capabilities/${capabilityId}/approve`);
        assert.equal(approveRes.status, 200);
      } finally {
        await server1.stop();
      }

      const server2 = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir }, identityId);
      try {
        const capsRes = await server2.request('GET', `/workspaces/${workspaceId}/compilations/${compilationId}/capabilities`);
        const capability = capsRes.json<{ capabilities: readonly CapabilityWire[] }>().capabilities.find((c) => c.capabilityId === capabilityId);
        assert.equal(capability?.approved, true);
      } finally {
        await server2.stop();
      }
    });
  });
});

test('execution records persist after a fresh server instance starts', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    await withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const identityId = 'restart-identity-2';
      const server1 = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir }, identityId);
      let workspaceId: string;
      let executionId: string;
      try {
        const workspace = await createWorkspace(server1);
        workspaceId = workspace.workspaceId;
        const { compilationId } = await uploadAndCompile(server1, workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));
        const capsRes = await server1.request('GET', `/workspaces/${workspaceId}/compilations/${compilationId}/capabilities`);
        const capabilityId = capsRes.json<{ capabilities: readonly CapabilityWire[] }>().capabilities[0]!.capabilityId;
        await server1.request('POST', `/workspaces/${workspaceId}/compilations/${compilationId}/capabilities/${capabilityId}/approve`);
        const execRes = await server1.request('POST', `/workspaces/${workspaceId}/executions`, { compilationId, capabilityId, input: {} });
        executionId = execRes.json<ExecutionWire>().executionId;
      } finally {
        await server1.stop();
      }

      const server2 = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir }, identityId);
      try {
        const res = await server2.request('GET', `/workspaces/${workspaceId}/executions/${executionId}`);
        assert.equal(res.status, 200);
        assert.equal(res.json<ExecutionWire>().executionId, executionId);
      } finally {
        await server2.stop();
      }
    });
  });
});

test('unknown workspace returns 404 on approval and execution routes', async () => {
  const server = await TestServer.start();
  try {
    const unknownId = 'ws_ffffffffffffffffffffffffffffffff';
    assert.equal((await server.request('POST', `/workspaces/${unknownId}/compilations/cmp_ffffffffffffffffffffffffffffffff/capabilities/cap_x/approve`)).status, 404);
    assert.equal((await server.request('POST', `/workspaces/${unknownId}/executions`, { compilationId: 'cmp_x', capabilityId: 'cap_x', input: {} })).status, 404);
    assert.equal((await server.request('GET', `/workspaces/${unknownId}/executions`)).status, 404);
    assert.equal((await server.request('GET', `/workspaces/${unknownId}/executions/exe_ffffffffffffffffffffffffffffffff`)).status, 404);
  } finally {
    await server.stop();
  }
});

test('cross-identity workspace access returns 404 on approval and execution routes', async () => {
  const server = await TestServer.start();
  try {
    const owner = await createWorkspace(server);
    const { compilationId } = await uploadAndCompile(server, owner.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));
    const capsRes = await server.request('GET', `/workspaces/${owner.workspaceId}/compilations/${compilationId}/capabilities`);
    const capabilityId = capsRes.json<{ capabilities: readonly CapabilityWire[] }>().capabilities[0]!.capabilityId;
    await server.request('POST', `/workspaces/${owner.workspaceId}/compilations/${compilationId}/capabilities/${capabilityId}/approve`);
    const execution = (await server.request('POST', `/workspaces/${owner.workspaceId}/executions`, { compilationId, capabilityId, input: {} })).json<ExecutionWire>();

    const other = await server.issueAdditionalIdentity('identity-b');
    const asOther = TestServer.authHeader(other.apiKey);

    assert.equal((await server.request('POST', `/workspaces/${owner.workspaceId}/compilations/${compilationId}/capabilities/${capabilityId}/approve`, undefined, asOther)).status, 404);
    assert.equal((await server.request('POST', `/workspaces/${owner.workspaceId}/executions`, { compilationId, capabilityId, input: {} }, asOther)).status, 404);
    assert.equal((await server.request('GET', `/workspaces/${owner.workspaceId}/executions`, undefined, asOther)).status, 404);
    assert.equal((await server.request('GET', `/workspaces/${owner.workspaceId}/executions/${execution.executionId}`, undefined, asOther)).status, 404);
  } finally {
    await server.stop();
  }
});

test('cross-workspace compilation/capability access returns 404: a capability from workspace A cannot be approved or executed through workspace B', async () => {
  const server = await TestServer.start();
  try {
    const workspaceA = await createWorkspace(server);
    const workspaceB = await createWorkspace(server);
    const { compilationId } = await uploadAndCompile(server, workspaceA.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));
    const capsRes = await server.request('GET', `/workspaces/${workspaceA.workspaceId}/compilations/${compilationId}/capabilities`);
    const capabilityId = capsRes.json<{ capabilities: readonly CapabilityWire[] }>().capabilities[0]!.capabilityId;

    const approveThroughB = await server.request('POST', `/workspaces/${workspaceB.workspaceId}/compilations/${compilationId}/capabilities/${capabilityId}/approve`);
    assert.equal(approveThroughB.status, 404);

    const execThroughB = await server.request('POST', `/workspaces/${workspaceB.workspaceId}/executions`, { compilationId, capabilityId, input: {} });
    assert.equal(execThroughB.status, 404);
  } finally {
    await server.stop();
  }
});

test('a client cannot override identity, workspace, capability, execution class, or runtime declaration via the request body', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const { compilationId } = await uploadAndCompile(server, workspace.workspaceId, 'agreement.md', Buffer.from(OBLIGATION_MARKDOWN));
    const capsRes = await server.request('GET', `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities`);
    const capabilityId = capsRes.json<{ capabilities: readonly CapabilityWire[] }>().capabilities[0]!.capabilityId;
    await server.request('POST', `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities/${capabilityId}/approve`);

    const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions`, {
      compilationId,
      capabilityId,
      input: {},
      identityId: 'someone-else',
      workspaceId: 'ws_00000000000000000000000000000000',
      executionClass: 'deterministic_rule',
      runtimeDeclaration: { id: capabilityId, execution: { mode: 'deterministic_rule' }, evaluate: 'ignored' },
    });
    assert.equal(res.status, 200); // this capability is unresolved — a genuine, honest rejection, not a fabricated success from the smuggled fields
    const execution = res.json<ExecutionWire>();
    assert.equal(execution.identityId, server.identityId);
    assert.equal(execution.workspaceId, workspace.workspaceId);
    assert.notEqual(execution.status, 'succeeded');
    assert.equal(execution.errorCode, 'XO_BINDING_UNRESOLVED'); // proves the server re-derived the binding itself rather than trusting the smuggled "deterministic_rule" claim
  } finally {
    await server.stop();
  }
});

test('unauthenticated requests to approval and execution routes are rejected (401)', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const calls: readonly [string, string][] = [
      ['POST', `/workspaces/${workspace.workspaceId}/compilations/cmp_ffffffffffffffffffffffffffffffff/capabilities/cap_x/approve`],
      ['POST', `/workspaces/${workspace.workspaceId}/executions`],
      ['GET', `/workspaces/${workspace.workspaceId}/executions`],
      ['GET', `/workspaces/${workspace.workspaceId}/executions/exe_ffffffffffffffffffffffffffffffff`],
    ];
    for (const [method, path] of calls) {
      const res = await server.request(method, path, method === 'POST' ? {} : undefined, {}, { skipAuth: true });
      assert.equal(res.status, 401, `expected 401 for unauthenticated ${method} ${path}`);
    }
  } finally {
    await server.stop();
  }
});
