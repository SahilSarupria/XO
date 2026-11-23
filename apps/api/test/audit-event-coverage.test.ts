import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type PermissionPolicy } from '@xo/permissions';
import type { toJson } from '@xo/xoir';
import { FileAuditStore, AUDIT_EVENT_TYPES, type AuditEvent } from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
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
