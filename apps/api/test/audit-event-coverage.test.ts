import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Permissions, RuleBasedPolicy, type PermissionPolicy } from '@xo/permissions';
import { toJson } from '@xo/xoir';
import { FileAuditStore, AUDIT_EVENT_TYPES, type AuditEvent } from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, buildFixtureGraph, storeFixtureCompilation } from './workflow-fixtures.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

// P1.0 M4 acceptance evidence — direct assertions for audit event types that no other test names.
// Each test drives the real API with the real FileAuditStore and asserts type, outcome, reasonCode and actor
// (never prompts, inputs or other content) from the bytes on disk. No event semantics are changed or assumed.

interface Env {
  readonly server: TestServer;
  readonly dataDir: string;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
  readonly events: () => Promise<AuditEvent[]>;
}

async function withEnv(
  opts: { policy?: PermissionPolicy; graph?: ReturnType<typeof toJson> },
  fn: (env: Env) => Promise<void>,
): Promise<void> {
  await withTempDir('xo-audit-cov-', async (dir) => {
    const auditDir = join(dir, 'audit');
    const store = await FileAuditStore.open({
      dir: auditDir,
      retention: { defaultRetentionMs: 30 * 86_400_000, minimumRetentionMs: 86_400_000 },
    });
    const server = await TestServer.start({
      workspaceDataDir: dir,
      auditSink: store,
      ...(opts.policy !== undefined ? { permissionPolicy: opts.policy } : {}),
    });
    try {
      const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
      const { compilationId } = await storeFixtureCompilation(workspace, dir, opts.graph);
      const events = async (): Promise<AuditEvent[]> =>
        (await readFile(join(auditDir, 'audit.jsonl'), 'utf8'))
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as AuditEvent);
      await fn({ server, dataDir: dir, workspace, compilationId, events });
    } finally {
      await server.stop();
    }
  });
}

const ws = (env: Env, suffix: string): string => `/workspaces/${env.workspace.workspaceId}${suffix}`;
async function approve(env: Env, cap: string): Promise<void> {
  const r = await env.server.request('POST', ws(env, `/compilations/${env.compilationId}/capabilities/${cap}/approve`));
  assert.ok(r.status === 200 || r.status === 201, r.bodyText);
}
async function workflowIdFor(env: Env, first: string): Promise<string> {
  const list = (await env.server.request('GET', ws(env, '/workflows'))).json<{
    workflows: { workflowId: string; steps: { capabilityId: string }[] }[];
  }>().workflows;
  const found = list.find((w) => w.steps[0]?.capabilityId === first);
  assert.ok(found);
  return found.workflowId;
}
async function startWorkflow(env: Env, first: string, input: Record<string, unknown>) {
  return env.server.request('POST', ws(env, `/workflows/${await workflowIdFor(env, first)}/executions`), {
    compilationId: env.compilationId,
    input,
  });
}
const HITL_INPUT = { screening_score: 90, settlement_amount: 800 };
const FILE = Permissions.filesystem.read;

function graphWith(capabilityId: string, mutate: (props: Record<string, unknown>) => void): ReturnType<typeof toJson> {
  const json = JSON.parse(JSON.stringify(toJson(buildFixtureGraph()))) as { nodes: { id: string; properties: Record<string, unknown> }[] };
  const node = json.nodes.find((n) => n.id === capabilityId);
  assert.ok(node);
  mutate(node.properties);
  return json as unknown as ReturnType<typeof toJson>;
}

test('taxonomy accounting: event types with no emitter, and types with no direct acceptance test, are listed explicitly (found by source search, not assumed)', () => {
  const declared = AUDIT_EVENT_TYPES as readonly string[];
  // Declared in the schema but with NO emitter anywhere in apps/ or packages/ at this commit. Reserved names.
  const noEmitter = ['execution.attempted', 'workflow.started'];
  // Emitted, but no acceptance test reaches the emitting branch (see the M4 acceptance report):
  //  - authorization.denied: only on the authorization-preflight 'error' branch (stored graph unparseable / contract unbuildable AFTER approval
  //    verification succeeded); none of the graph defects tried reached it (a missing requiredPermissions yields execution.denied instead).
  //  - workflow.resumed: only the fallback arm of recordWorkflowOutcome for a status that is not succeeded/failed/rejected/interrupted/waiting_for_human.
  const noDirectTest = ['authorization.denied', 'workflow.resumed'];
  // Reserved: an emitting branch exists in human-task-routes.ts but cannot be reached (the 'error' outcome comes only from store
  // errors, never RUNTIME_PERMISSION_DENIED); a failed-resume denial is humantask.resolved/failed + reasonCode (F-1 Option A).
  // Kept declared because removing a type makes persisted lines of that type read back as corrupt. Documented in docs/audit-operations.md.
  const reservedUnreachable = ['humantask.denied'];
  for (const t of [...noEmitter, ...noDirectTest, ...reservedUnreachable]) assert.ok(declared.includes(t), `${t} is still declared`);
});

test('execution.failed: an authorized execution that ends failed is recorded as execution.failed (outcome failed) with the execution id, after execution.started', async () => {
  await withEnv({}, async (env) => {
    await approve(env, IDS.flowA);
    const res = await env.server.request('POST', ws(env, '/executions'), {
      compilationId: env.compilationId,
      capabilityId: IDS.flowA,
      input: {}, // required input absent: the run ends failed, but is still a real, persisted outcome
    });
    const body = res.json<{ executionId?: string; status?: string }>();
    assert.ok(body.executionId !== undefined, res.bodyText);
    assert.equal(body.status, 'failed');
    const all = await env.events();
    const types = all.filter((e) => e.executionId === body.executionId || e.type === 'execution.started').map((e) => e.type);
    assert.ok(types.includes('execution.failed'), types.join(','));
    const failed = all.find((e) => e.type === 'execution.failed') as AuditEvent;
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.executionId, body.executionId);
    assert.ok(all.findIndex((e) => e.type === 'execution.started') < all.findIndex((e) => e.type === 'execution.failed'));
    assert.ok(!all.some((e) => e.type === 'execution.completed'));
  });
});

test('workflow.denied: a workflow whose step needs a permission the principal lacks is recorded as workflow.denied after the durable attempt, and creates nothing', async () => {
  await withEnv({}, async (env) => {
    await approve(env, IDS.perm);
    const res = await startWorkflow(env, IDS.perm, { file_size: 50 });
    assert.equal(res.status, 403, res.bodyText);
    const wf = (await env.events()).filter((e) => e.action === 'start.workflow');
    assert.deepEqual(
      wf.map((e) => e.type),
      ['workflow.attempted', 'workflow.denied'],
    );
    const denied = wf[1] as AuditEvent;
    assert.equal(denied.outcome, 'denied');
    assert.equal(denied.reasonCode, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.equal(denied.actor.id, env.server.identityId);
    assert.equal(
      (await env.server.request('GET', ws(env, '/workflow-executions'))).json<{ workflowExecutions: unknown[] }>().workflowExecutions
        .length,
      0,
    );
  });
});

test('workflow.failed: a resume whose later step fails closed (approval revoked while paused) is recorded as workflow.failed with the workflow execution id', async () => {
  await withEnv({}, async (env) => {
    for (const id of [IDS.hitlA, IDS.hitlB, IDS.hitlC]) await approve(env, id);
    const started = await startWorkflow(env, IDS.hitlA, HITL_INPUT);
    assert.equal(started.status, 201, started.bodyText);
    const wf = started.json<{ workflowExecutionId: string; steps: { executionId?: string }[] }>();
    const bId = wf.steps[1]?.executionId as string;

    // Revoke C's approval on the real filesystem while the workflow is paused (same technique as workflow-executions.test.ts).
    const approvalsDir = join(env.dataDir, env.workspace.workspaceId, 'approvals');
    const files = (await readdir(approvalsDir, { recursive: true })).map(String).filter((f) => f.includes(IDS.hitlC));
    assert.ok(files.length > 0, 'found approval file(s) for step C');
    for (const f of files) await rm(join(approvalsDir, f), { force: true, recursive: true });

    const res = await env.server.request('POST', ws(env, `/workflow-executions/${wf.workflowExecutionId}/resume`), {
      decision: 'approve',
      expectedStepExecutionId: bId,
    });
    assert.equal(res.status, 200, res.bodyText);
    assert.equal(res.json<{ status: string }>().status, 'failed');
    const resume = (await env.events()).filter((e) => e.action === 'resume.workflow');
    assert.equal(resume[0]?.type, 'workflow.attempted');
    const last = resume[resume.length - 1] as AuditEvent;
    assert.equal(last.type, 'workflow.failed');
    assert.equal(last.outcome, 'failed');
    assert.equal(last.executionId, wf.workflowExecutionId);
    assert.ok(resume.some((e) => e.type === 'workflow.step.failed'));
    // P1.0 F-1: workflow.failed carries the stored workflow errorCode (code only).
    const stored = res.json<{ errorCode?: string; errorMessage?: string }>();
    assert.ok(stored.errorCode !== undefined, 'the workflow record carries its failure code');
    assert.equal(last.reasonCode, stored.errorCode);
    if (stored.errorMessage) assert.ok(!JSON.stringify(last).includes(stored.errorMessage), 'no message text in the event');
  });
});

test('humantask (F-1 Option A): a resolver whose grant was withdrawn gets 200; the task is consumed as resolved-with-failed-resume; audit records humantask.resolved/failed carrying the stored reasonCode (still not humantask.denied)', async () => {
  // Pins the current contract (HTTP 200, task consumed, failed execution) and, since F-1 Option A, the audit reasonCode.
  // humantask.denied stays reserved: this path does not and must not produce it.
  const graph = graphWith(IDS.hitlB, (p) => {
    p['requiredPermissions'] = [FILE];
  });
  const inner = new RuleBasedPolicy([{ id: 'starter', effect: 'ALLOW', match: { permission: FILE, principalId: 'test-identity' } }]);
  let revoked = false;
  const policy: PermissionPolicy = {
    evaluate: (r) => (revoked ? { effect: 'DENY', reason: 'grant withdrawn (test)' } : inner.evaluate(r)),
  };
  await withEnv({ graph, policy }, async (env) => {
    for (const id of [IDS.hitlA, IDS.hitlB, IDS.hitlC]) await approve(env, id);
    const started = await startWorkflow(env, IDS.hitlA, HITL_INPUT);
    assert.equal(started.status, 201, started.bodyText);
    const bId = started.json<{ steps: { executionId?: string }[] }>().steps[1]?.executionId as string;
    assert.ok(bId);

    revoked = true;
    const res = await env.server.request('POST', ws(env, `/executions/${bId}/resolve`), { decision: 'approve' });
    assert.equal(res.status, 200, res.bodyText);
    const rec = res.json<{ status: string; errorCode?: string; humanTask?: { status: string } }>();
    assert.equal(rec.status, 'failed');
    assert.equal(rec.errorCode, 'XO_RUNTIME_PERMISSION_DENIED', 'the denial is visible on the execution record');
    assert.equal(rec.humanTask?.status, 'resolved', 'the task is consumed');

    const ev = (await env.events()).filter((e) => e.action === 'resolve.human-task');
    assert.ok(ev.some((e) => e.type === 'humantask.attempted'));
    const done = ev.find((e) => e.type === 'humantask.resolved') as AuditEvent;
    assert.ok(done, ev.map((e) => e.type).join(','));
    assert.equal(done.outcome, 'failed');
    assert.ok(!ev.some((e) => e.type === 'humantask.denied'), 'humantask.denied is not what an unauthorized resolver produces today');
    assert.equal(done.reasonCode, 'XO_RUNTIME_PERMISSION_DENIED', 'the stored failure code is carried as reasonCode');
    assert.ok(!JSON.stringify(ev).includes('grant withdrawn'), 'the policy reason text (a message) never reaches the audit record');
  });
});
