import { readdir } from 'node:fs/promises';
import { sweepTokenVaults } from '../protection/data-protection.js';
import { FsSourceConnectionStore } from '../source-connections/store.js';
import { readerFor } from '../source-connections/readers.js';
import { syncConnection } from '../source-connections/sync.js';
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
import { SqliteLeaseStore, missedSlotPlan, type LeaseStore, type MissedSlotPolicy } from '@xo/automation';
import { startCertifiedTrigger } from './certified-trigger.js';
import { ErrorCode, XoError } from '@xo/errors';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Starts runs for workflows that have an "every N minutes" schedule and are practising or live.
 *
 * What it does and does not promise (stated here and in the docs, because "scheduler" invites assumptions):
 *  - Only ONE API process ticks at a time: a lease in the data directory (UW-15, ADR 0044). A second process waits and takes over
 *    if the first stops renewing it. Each slot is also the run's idempotency key, so a takeover cannot start a slot twice.
 *  - After downtime it does not catch up a run per missed slot. `missedSlots` decides: `run_latest` (default) runs only the most
 *    recent missed slot, if it ended within 24 hours, and records the others as `skipped: missed`; `skip` runs none of them.
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
  /** Environment for the workflow runtime's connectors and signing (default: the process environment). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
  /** UW-15: what to do about slots that passed while nothing was running (default `run_latest`). */
  readonly missedSlots?: MissedSlotPolicy;
  /** UW-15: who may fire schedules. Absent: a lease in `<data directory>/scheduler-lease.sqlite`. */
  readonly lease?: { readonly store: LeaseStore; readonly holder: string; readonly ttlMs?: number };
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
    // UW-12a: source connections that sync on an interval are synced when due (a failure is recorded on the connection).
    try {
      for (const c of await new FsSourceConnectionStore(ws.value, deps.dataConfig).list()) {
        // An agent's folder is synced by the agent on that computer, never from here.
        if (c.retiredAt !== undefined || c.paused || c.sync.mode !== 'interval' || c.kind === 'agent_folder') continue;
        const last = c.lastSync !== undefined ? Date.parse(c.lastSync.at) : 0;
        if (now.getTime() - last < c.sync.everyMinutes * 60_000) continue;
        await syncConnection(
          {
            workspace: ws.value,
            dataConfig: deps.dataConfig,
            readerFor: (x) => readerFor({ workspace: ws.value, dataConfig: deps.dataConfig, env: deps.env ?? process.env }, x),
            actor: { identityId: 'source-sync', kind: 'system' },
          },
          c.connectionId,
          now,
        );
      }
    } catch (cause) {
      deps.log?.(`scheduler: cannot sync source connections in ${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    // UW-14d: token vaults past their retention are erased here, whether or not anything opens them again.
    try {
      const erased = await sweepTokenVaults(deps.dataConfig.dataRootDir, id, now);
      if (erased > 0) deps.log?.(`scheduler: erased ${erased} expired token vault(s) in ${id}`);
    } catch (cause) {
      deps.log?.(`scheduler: cannot sweep token vaults in ${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const store = new FsControlsStore(workspaceStateStore(ws.value, deps.dataConfig), id);
    let due;
    try {
      due = (await store.listDeployments()).filter((d) => scheduleDue(d, now));
    } catch (cause) {
      deps.log?.(`scheduler: cannot read controls for ${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    for (const d of due) {
      // UW-15: slots that passed unfired. `run_latest` runs the latest recent one (its slot is the idempotency key); the rest are recorded.
      const everyMs = (d.triggers.schedule?.everyMinutes ?? 1) * 60_000;
      const plan = missedSlotPlan({
        lastFiredMs: Date.parse(d.triggers.schedule?.lastFiredAt ?? ''),
        nowMs: now.getTime(),
        everyMs,
        policy: deps.missedSlots ?? 'run_latest',
      });
      if (plan.skipped.length > 0 && plan.run === undefined) {
        skipped += 1;
        const text = `skipped: missed ${plan.skipped.length} slot${plan.skipped.length === 1 ? '' : 's'} while nothing was running`;
        try {
          await store.mutate(d.compilationId, d.workflowId, 'trigger-schedule', now.toISOString(), (cur) =>
            cur.triggers.schedule === undefined
              ? cur
              : {
                  ...cur,
                  triggers: { ...cur.triggers, schedule: { ...cur.triggers.schedule, lastFiredAt: now.toISOString(), lastOutcome: text } },
                },
          );
          await openWorkspaceAuditLog(ws.value, deps.dataConfig).append({
            event: 'workflow.triggered',
            actor: { identityId: 'trigger-schedule', kind: 'system' },
            result: 'denied',
            target: { kind: 'workflow', id: d.workflowId },
            detail: { compilationId: d.compilationId, trigger: 'schedule', outcome: text, missedSlots: plan.skipped.length },
          });
        } catch (cause) {
          deps.log?.(
            `scheduler: could not record missed slots for ${id}/${d.workflowId}: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
        continue;
      }
      const slot = plan.run ?? Math.floor(now.getTime() / everyMs);
      const ctx = makeRunnerContext(ws.value, principalResult.value, deps.dataConfig, deps.permissionManager);
      let outcome: string;
      let result: 'succeeded' | 'failed' | 'denied' = 'succeeded';
      let runId: string | undefined;
      try {
        const sched = d.triggers.schedule;
        if (sched?.certificateId !== undefined && sched.startsAs !== undefined) {
          // ADR 0035: a certified schedule runs on the workflow runtime, as the person who set it (re-authorized at every
          // effect). The slot is the idempotency key, so two instances firing the same slot start one run.
          const as = establishAuthenticatedPrincipal({
            kind: sched.startsAs.kind === 'service' ? 'service' : 'human',
            id: sched.startsAs.id,
          });
          if (!as.ok) throw as.error;
          const r = await startCertifiedTrigger(
            {
              workspaceStore: deps.workspaceStore,
              dataConfig: deps.dataConfig,
              permissionManager: deps.permissionManager,
              env: deps.env ?? process.env,
              audit: deps.audit,
            },
            {
              workspace: ws.value,
              actor: as.value,
              compilationId: d.compilationId,
              workflowId: d.workflowId,
              certificateId: sched.certificateId,
              input: { ...(sched.input ?? {}) },
              idempotencyKey: `schedule:${sched.everyMinutes}:${slot}`,
              correlationId: newCorrelationId(),
              trigger: 'schedule',
              now,
            },
          );
          runId = typeof r.body['runId'] === 'string' ? r.body['runId'] : undefined;
          const state = String(r.body['state'] ?? '');
          outcome =
            state === 'failed'
              ? 'started on the workflow runtime, but the run failed (check its input)'
              : 'started on the workflow runtime';
          if (plan.skipped.length > 0)
            outcome += `; skipped: missed ${plan.skipped.length} earlier slot${plan.skipped.length === 1 ? '' : 's'}`;
          if (state === 'failed') result = 'failed';
        } else {
          const { record } = await startGated(
            store,
            ctx,
            { compilationId: d.compilationId, workflowId: d.workflowId, input: sched?.input ?? {} },
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
          if (plan.skipped.length > 0)
            outcome += `; skipped: missed ${plan.skipped.length} earlier slot${plan.skipped.length === 1 ? '' : 's'}`;
          if (record.status === 'failed') result = 'failed';
        }
        started += 1;
      } catch (cause) {
        skipped += 1;
        const refused =
          cause instanceof StartRefusedError ||
          (cause instanceof XoError &&
            (cause.code === ErrorCode.WORKFLOW_REQUIRES_IR_RUNTIME ||
              cause.code === ErrorCode.READINESS_CERTIFICATE_REFUSED ||
              cause.code === ErrorCode.READINESS_CERTIFICATE_REQUIRED));
        result = refused ? 'denied' : 'failed';
        outcome =
          cause instanceof StartRefusedError
            ? `skipped: ${cause.reason}`
            : refused && cause instanceof XoError
              ? `skipped: ${cause.code === ErrorCode.WORKFLOW_REQUIRES_IR_RUNTIME ? 'this workspace requires a readiness certificate; set one on the schedule' : cause.message.slice(0, 160)}`
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

/**
 * One tick, under the lease: only the holder fires. Returns undefined when another process holds the lease. The lease outlives a
 * tick (three times the interval by default) so a busy tick does not lose it; a stopped process stops renewing and another takes over.
 */
export async function tickWithLease(
  deps: SchedulerDeps,
  now: Date,
  intervalMs: number,
): Promise<{ started: number; skipped: number } | undefined> {
  const lease = deps.lease ?? defaultLease(deps);
  const held = await lease.store.acquire('scheduler', lease.holder, lease.ttlMs ?? intervalMs * 3, now.getTime());
  if (held === undefined) return undefined;
  return runDueSchedules(deps, now);
}

const defaultStores = new Map<string, LeaseStore>();
function defaultLease(deps: SchedulerDeps): NonNullable<SchedulerDeps['lease']> {
  const path = join(deps.dataConfig.dataRootDir, 'scheduler-lease.sqlite');
  let store = defaultStores.get(path);
  if (store === undefined) {
    store = new SqliteLeaseStore(path);
    defaultStores.set(path, store);
  }
  return { store, holder: `${process.pid}:${randomUUID().slice(0, 8)}` };
}

/** Checks on an interval until stopped. A failed tick is logged and the timer carries on. */
export function startScheduler(deps: SchedulerDeps, intervalMs = 30_000): () => void {
  const lease = deps.lease ?? defaultLease(deps);
  const withLease: SchedulerDeps = { ...deps, lease };
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // never overlap two ticks
    running = true;
    tickWithLease(withLease, new Date(), intervalMs)
      .catch((cause) => deps.log?.(`scheduler tick failed: ${cause instanceof Error ? cause.message : String(cause)}`))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    void lease.store.release('scheduler', lease.holder).catch(() => undefined);
  };
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
