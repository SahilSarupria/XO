import { readdir } from 'node:fs/promises';
import type { AuditAnchorSink } from '../audit/anchor.js';
import { openWorkspaceAuditLog } from '../audit/workspace-audit-log.js';
import { LocalFsBlobStore } from '@xo/storage';
import { establishAuthenticatedPrincipal, type PermissionManager } from '@xo/permissions';
import type { PackageTrustPolicy } from '@xo/package-sdk';
import { newCorrelationId, type AuditService } from '../audit/audit-service.js';
import { startWorkflowAudited } from '../routes/workflow-routes.js';
import { FsWorkspaceStore } from '../workspace/fs-workspace-store.js';
import { workspaceStateStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import { isValidWorkspaceId, type WorkspaceStore } from '../workspace/workspace.js';
import { makeRunnerContext } from '../workflows/workflow-views.js';
import { FsControlsStore } from './fs-controls-store.js';
import { scheduleDue } from './model.js';
import { startGated, StartRefusedError } from './service.js';

/**
 * Starts runs for workflows that have an "every N minutes" schedule and are practising or live.
 *
 * What it does and does not promise (stated here and in the docs, because "scheduler" invites assumptions):
 *  - It runs inside ONE API process while that process is up. A second API process on the same data directory would
 *    start the same run twice: run one.
 *  - It does not catch up. If the server was off for a day, the next tick starts ONE run, not a day's worth.
 *  - Timing is "at least N minutes since the last slot", checked every tick (default 30 s), not wall-clock cron.
 *  - A scheduled run starts with the fixed input stored on the schedule (empty if none). A workflow whose required
 *    fields are missing cannot start; that is recorded as `could not start` (`lastOutcome`), never retried in a loop.
 *  - Every start goes through the same gate as a manual one: the workspace pause, the workflow's pause and its daily
 *    limit all apply. A refused slot is skipped and recorded, not queued.
 */
export interface SchedulerDeps {
  readonly workspaceStore: WorkspaceStore;
  readonly dataConfig: WorkspaceDataConfig;
  /** The SAME kind of policy decision point the API uses. A scheduled run is initiated by the `trigger-schedule` service principal and is authorized per step; with the default deny-all policy a step that declares permissions is refused. */
  readonly permissionManager: PermissionManager;
  /** Audit service for the run's start/step/completion evidence. */
  readonly audit: AuditService;
  readonly log?: (line: string) => void;
}

export async function runDueSchedules(deps: SchedulerDeps, now: Date): Promise<{ started: number; skipped: number }> {
  let started = 0;
  let skipped = 0;
  let dirs: string[];
  try {
    dirs = (await readdir(deps.dataConfig.dataRootDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { started, skipped }; // no data yet
  }
  const principalResult = establishAuthenticatedPrincipal({ kind: 'service', id: 'trigger-schedule' });
  if (!principalResult.ok) throw principalResult.error;
  for (const id of dirs.filter(isValidWorkspaceId)) {
    const ws = await deps.workspaceStore.get(id);
    if (!ws.ok) continue;
    const store = new FsControlsStore(workspaceStateStore(ws.value, deps.dataConfig), id);
    let due;
    try {
      due = (await store.listDeployments()).filter((d) => scheduleDue(d, now));
    } catch (cause) {
      deps.log?.(`scheduler: cannot read controls for ${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    for (const d of due) {
      const ctx = makeRunnerContext(ws.value, principalResult.value, deps.dataConfig, deps.permissionManager);
      let outcome: string;
      let result: 'succeeded' | 'failed' | 'denied' = 'succeeded';
      let runId: string | undefined;
      try {
        const { record } = await startGated(
          store,
          ctx,
          { compilationId: d.compilationId, workflowId: d.workflowId, input: d.triggers.schedule?.input ?? {} },
          'schedule',
          now,
          (gated) =>
            startWorkflowAudited(
              { dataConfig: deps.dataConfig, audit: deps.audit },
              { workspace: ws.value, ctx, correlationId: newCorrelationId(), idempotencyKey: undefined, request: gated },
            ),
        );
        runId = record.workflowExecutionId;
        outcome = record.status === 'failed' ? 'started, but the run failed (check its input)' : 'started';
        if (record.status === 'failed') result = 'failed';
        started += 1;
      } catch (cause) {
        skipped += 1;
        result = cause instanceof StartRefusedError ? 'denied' : 'failed';
        outcome =
          cause instanceof StartRefusedError
            ? `skipped: ${cause.reason}`
            : `could not start: ${(cause instanceof Error ? cause.message : 'unknown error').slice(0, 120)}`;
      }
      try {
        await store.mutate(d.compilationId, d.workflowId, 'trigger-schedule', now.toISOString(), (cur) =>
          cur.triggers.schedule === undefined
            ? cur
            : {
                ...cur,
                triggers: { ...cur.triggers, schedule: { ...cur.triggers.schedule, lastFiredAt: now.toISOString(), lastOutcome: outcome } },
              },
        );
        await openWorkspaceAuditLog(ws.value, deps.dataConfig).append({
          event: 'workflow.triggered',
          actor: { identityId: 'trigger-schedule', kind: 'system' },
          result,
          target: { kind: runId !== undefined ? 'workflow_run' : 'workflow', id: runId ?? d.workflowId },
          detail: { compilationId: d.compilationId, trigger: 'schedule', outcome },
        });
      } catch (cause) {
        deps.log?.(`scheduler: could not record slot for ${id}/${d.workflowId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
  return { started, skipped };
}

/** Checks on an interval until stopped. A failed tick is logged and the timer carries on. */
export function startScheduler(deps: SchedulerDeps, intervalMs = 30_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // never overlap two ticks
    running = true;
    runDueSchedules(deps, new Date())
      .catch((cause) => deps.log?.(`scheduler tick failed: ${cause instanceof Error ? cause.message : String(cause)}`))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function schedulerDepsFrom(
  workspacesDir: string,
  dataRootDir: string,
  enforcement: {
    readonly permissionManager: PermissionManager;
    readonly audit: AuditService;
    readonly packageTrustPolicy: PackageTrustPolicy;
    readonly auditAnchor?: AuditAnchorSink;
  },
  log?: (line: string) => void,
): SchedulerDeps {
  return {
    workspaceStore: new FsWorkspaceStore(new LocalFsBlobStore(workspacesDir)),
    dataConfig: {
      dataRootDir,
      packageTrustPolicy: enforcement.packageTrustPolicy,
      ...(enforcement.auditAnchor !== undefined ? { auditAnchor: enforcement.auditAnchor } : {}),
    },
    permissionManager: enforcement.permissionManager,
    audit: enforcement.audit,
    ...(log !== undefined ? { log } : {}),
  };
}
