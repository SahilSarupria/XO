import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Permissions, RuleBasedPolicy, type PermissionPolicy, type PolicyRule } from '@xo/permissions';
import { NonProductionAuditSink, type AuditEventDraft } from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import { FsCompilationStore } from '../src/compilations/fs-compilation-store.js';
import { compilationLoaderFromStore } from '../src/procedures/registry-validation.js';
import { workspaceCompilationsStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

// P1.1 M3 REVIEW FINDING 1 (non-independent review, 2026-10-23): resuming a paused procedure execution after its approval record became
// missing or malformed must fail closed. ADDITIVE test file; FIXTURE: the hand-built P0.8 fallback graph.

const grant = (id: string, permission: string): PolicyRule => ({
  id,
  effect: 'ALLOW',
  match: { permission: permission as never, principalId: 'test-identity' },
});
const GRANTS: readonly PolicyRule[] = [
  grant('author', Permissions.procedure.author),
  grant('approve', Permissions.procedure.approve),
  grant('read', Permissions.procedure.read),
  grant('execute', Permissions.procedure.execute),
];
const WITH_FILE: readonly PolicyRule[] = [...GRANTS, grant('file', Permissions.filesystem.read)];

/** A policy whose rule set can be swapped between steps (models "permission removed / policy changed while running"). */
class SwitchPolicy implements PermissionPolicy {
  current: PermissionPolicy;
  constructor(rules: readonly PolicyRule[]) {
    this.current = new RuleBasedPolicy([...rules]);
  }
  set(rules: readonly PolicyRule[]): void {
    this.current = new RuleBasedPolicy([...rules]);
  }
  evaluate(request: Parameters<PermissionPolicy['evaluate']>[0]): ReturnType<PermissionPolicy['evaluate']> {
    return this.current.evaluate(request);
  }
}

/** Non-production sink with deterministic seams: refuse chosen event types, or run a hook BEFORE an event is appended. */
class HookSink extends NonProductionAuditSink {
  readonly refuse = new Set<string>();
  beforeAppend: ((draft: AuditEventDraft) => Promise<void> | void) | undefined;
  override async append(draft: AuditEventDraft): ReturnType<NonProductionAuditSink['append']> {
    if (this.beforeAppend !== undefined) await this.beforeAppend(draft);
    if (this.refuse.has(draft.type)) return { ok: false, error: new Error('audit sink down'), indeterminate: false } as never;
    return super.append(draft);
  }
}

interface Env {
  readonly server: TestServer;
  readonly sink: HookSink;
  readonly policy: SwitchPolicy;
  readonly dataDir: string;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
  readonly graphHash: string;
}
const CAPS = [IDS.xsegA, IDS.xsegH, IDS.xsegC, IDS.flowB, IDS.perm];

async function withEnv(
  fn: (env: Env) => Promise<void>,
  rules: readonly PolicyRule[] = WITH_FILE,
  serverOptions: { procedureStepTimeoutMs?: number; testBeforeStepExecute?: () => Promise<void> } = {},
): Promise<void> {
  await withTempDir('xo-m3c-data-', async (dataDir) => {
    await withTempDir('xo-m3c-ws-', async (workspacesDir) => {
      const sink = new HookSink();
      const policy = new SwitchPolicy(rules);
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: sink,
        permissionPolicy: policy,
        ...serverOptions,
      });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        const loaded = await compilationLoaderFromStore(
          new FsCompilationStore(workspaceCompilationsStore(workspace, { dataRootDir: dataDir })),
        )(compilationId);
        assert.ok(loaded);
        const env: Env = { server, sink, policy, dataDir, workspace, compilationId, graphHash: loaded.graphHash };
        for (const cap of CAPS) {
          const res = await server.request('POST', `${base(env)}/compilations/${compilationId}/capabilities/${cap}/approve`);
          assert.ok(res.status === 200 || res.status === 201, `approve ${cap} -> ${res.status} ${res.bodyText}`);
        }
        await fn(env);
      } finally {
        await server.stop();
      }
    });
  });
}

const base = (env: Pick<Env, 'workspace'>): string => `/workspaces/${env.workspace.workspaceId}`;

/** xsegA -> d(matched?) -> h(human) -> c(settle) | x(flowB). Mirrors the M3 vertical (hand-built fallback fixture). */
function vertical(env: Env, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'xo.procedure/1',
    procedureId: 'intake-review',
    version: 1,
    compilationRef: { compilationId: env.compilationId, graphHash: env.graphHash },
    steps: [
      {
        id: 'a',
        kind: 'capability',
        capabilityId: IDS.xsegA,
        basis: 'source_proven',
        next: 'd',
        inputBindings: [{ param: 'intake score', from: { input: 'intake_score' }, bindingStatus: 'proven' }],
      },
      { id: 'd', kind: 'decision', condition: { path: 'steps.a.output.matched', op: 'eq', value: true }, then: 'h', else: 'x' },
      { id: 'h', kind: 'capability', capabilityId: IDS.xsegH, basis: 'source_proven', next: 'c' },
      {
        id: 'c',
        kind: 'capability',
        capabilityId: IDS.xsegC,
        basis: 'source_proven',
        inputBindings: [
          { param: 'matched', from: { step: 'a', output: 'matched' }, bindingStatus: 'proven' },
          { param: 'review amount', from: { input: 'review_amount' }, bindingStatus: 'proven' },
        ],
      },
      {
        id: 'x',
        kind: 'capability',
        capabilityId: IDS.flowB,
        basis: 'source_proven',
        inputBindings: [
          { param: 'matched', from: { step: 'a', output: 'matched' }, bindingStatus: 'proven' },
          { param: 'payout amount', from: { input: 'payout_amount' }, bindingStatus: 'proven' },
        ],
      },
    ],
    ...over,
  };
}
const INPUT = { intake_score: 80, review_amount: 900, payout_amount: 100 };

async function put(env: Env, doc: Record<string, unknown>): Promise<{ status: number; bodyText: string }> {
  return env.server.request('PUT', `${base(env)}/procedures/${doc['procedureId'] as string}/versions/${doc['version'] as number}`, doc);
}
async function approve(env: Env, id: string, v = 1): Promise<{ status: number; bodyText: string }> {
  return env.server.request('POST', `${base(env)}/procedures/${id}/versions/${v}/approve`);
}
async function publish(env: Env, doc: Record<string, unknown>): Promise<void> {
  const p = await put(env, doc);
  assert.equal(p.status, 201, p.bodyText);
  const a = await approve(env, doc['procedureId'] as string, doc['version'] as number);
  assert.equal(a.status, 200, a.bodyText);
}
const start = (env: Env, input: unknown = INPUT, headers: Record<string, string> = {}, id = 'intake-review', v = 1) =>
  env.server.request('POST', `${base(env)}/procedures/${id}/versions/${v}/executions`, { input }, headers);
const resume = (env: Env, id: string, body: unknown) => env.server.request('POST', `${base(env)}/procedure-executions/${id}/resume`, body);
interface ExecWire {
  procedureExecutionId: string;
  status: string;
  revision: number;
  steps: { stepId: string; status: string; executionId?: string; failureClass?: string }[];
  waitingFor?: { stepId: string; executionId: string };
  failure?: { class: string; code: string };
}
const getExec = async (env: Env, id: string): Promise<ExecWire> => {
  const res = await env.server.request('GET', `${base(env)}/procedure-executions/${id}`);
  assert.equal(res.status, 200, res.bodyText);
  return res.json<ExecWire>();
};
const statuses = (e: ExecWire): string => e.steps.map((s) => `${s.stepId}:${s.status}`).join(',');

const approvalFile = (env: Env): string =>
  join(env.dataDir, env.workspace.workspaceId, 'procedures', 'intake-review', 'v1', 'approval.json');

for (const damage of ['missing', 'malformed'] as const) {
  test(`REVIEW-1 resume fails closed when the procedure approval is ${damage}: 403, nothing resumed, the human task and revision are untouched`, async () => {
    await withEnv(async (env) => {
      await publish(env, vertical(env));
      const waiting = (await start(env)).json<ExecWire>();
      assert.equal(waiting.status, 'waiting_for_human');
      if (damage === 'missing') await rm(approvalFile(env));
      else await writeFile(approvalFile(env), '{"not":"an approval"}');

      const res = await resume(env, waiting.procedureExecutionId, { decision: 'approve' });
      assert.equal(res.status, 403, res.bodyText);
      const same = await getExec(env, waiting.procedureExecutionId);
      assert.equal(same.status, 'waiting_for_human', 'nothing was resumed');
      assert.equal(same.revision, waiting.revision, 'revision did not advance');
      assert.equal(statuses(same), statuses(waiting));
    });
  });
}
