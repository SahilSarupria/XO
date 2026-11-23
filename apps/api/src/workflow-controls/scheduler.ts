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
import { FsWorkspaceStore } from '../workspace/fs-workspace-store.js';
import { workspaceStateStore, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import { isValidWorkspaceId, type WorkspaceStore } from '../workspace/workspace.js';
import { FsControlsStore } from './fs-controls-store.js';
import { scheduleDue } from './model.js';
import { StartRefusedError } from './service.js';
import {
  AutomationEngine,
  EngineLockedError,
  SqliteLeaseStore,
  TickTrigger,
  missedSlotPlan,
  type LeaseStore,
  type MissedSlotPolicy,
} from '@xo/automation';
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
    const fires: ScheduleFire[] = [];
    for (const d of due) {
      // UW-15: slots that passed unfired. `run_latest` runs the latest recent one (its slot is the idempotency key); the rest are recorded.
      const everyMs = (d.triggers.schedule?.everyMinutes ?? 1) * 60_000;
      const plan = missedSlotPlan({
        lastFiredMs: Date.parse(d.triggers.schedule?.lastFiredAt ?? ''),
        nowMs: now.getTime(),
        everyMs,
        policy: deps.missedSlots ?? 'run_latest',
      });
      fires.push({
        workspaceId: id,
        compilationId: d.compilationId,
        workflowId: d.workflowId,
        everyMinutes: d.triggers.schedule?.everyMinutes ?? 1,
        // null: only missed slots to record, nothing to run.
        slot: plan.skipped.length > 0 && plan.run === undefined ? null : (plan.run ?? Math.floor(now.getTime() / everyMs)),
        skippedSlots: plan.skipped.length,
        at: now.toISOString(),
      });
    }
    if (fires.length === 0) continue;
    // UW-15 (ADR 0044 amended): every due slot is an event in the automation engine: at most once per key (across restarts, from its
    // ledger), recorded in its hash-chained ledger, bounded, and recovered if the process stopped mid-fire.
    const entry = await engineFor(deps);
    if (entry === undefined) {
      deps.log?.('scheduler: another process holds the schedule engine; nothing fired');
      return { started, skipped };
    }
    const keys = fires.map(
      (f) =>
        `${f.workspaceId}/${f.compilationId}/${f.workflowId}@${f.everyMinutes}m:${f.slot ?? `missed-${Math.floor(now.getTime() / (f.everyMinutes * 60_000))}`}`,
    );
    const emitted = await entry.trigger.fire(
      fires.map((f, i) => ({ source: 'schedule' as const, idempotencyKey: keys[i]!, receivedAt: f.at, payload: f })),
    );
    await entry.engine.idle();
    for (const [i, key] of keys.entries()) {
      const r = entry.results.get(key);
      entry.results.delete(key);
      if (emitted[i]?.accepted !== true) {
        if (emitted[i]?.duplicate !== true)
          deps.log?.(`scheduler: slot not accepted (${emitted[i]?.reason ?? 'unknown'}); it is offered again next tick`);
        continue;
      }
      if (r === 'started') started += 1;
      else if (r === 'skipped') skipped += 1;
    }
  }
  return { started, skipped };
}

/** One due slot, as the engine records it: ids and counts only. */
interface ScheduleFire {
  readonly workspaceId: string;
  readonly compilationId: string;
  readonly workflowId: string;
  readonly everyMinutes: number;
  /** The slot to run (its idempotency key), or null when only missed slots are recorded. */
  readonly slot: number | null;
  readonly skippedSlots: number;
  readonly at: string;
}

interface EngineEntry {
  readonly engine: AutomationEngine;
  readonly trigger: TickTrigger;
  /** The latest caller's dependencies: a slot recovered after a restart fires with the current ones. */
  deps: SchedulerDeps;
  readonly results: Map<string, 'started' | 'skipped' | 'none'>;
}

const engines = new Map<string, EngineEntry>();
const engineDir = (deps: SchedulerDeps): string => join(deps.dataConfig.dataRootDir, 'automation', 'schedules');

/** The engine for this data directory, started on first use. Undefined when another live process holds its directory lock. */
async function engineFor(deps: SchedulerDeps): Promise<EngineEntry | undefined> {
  const dir = engineDir(deps);
  const existing = engines.get(dir);
  if (existing !== undefined) {
    existing.deps = deps;
    return existing;
  }
  const trigger = new TickTrigger('api-schedules');
  const results = new Map<string, 'started' | 'skipped' | 'none'>();
  const entry: EngineEntry = {
    trigger,
    deps,
    results,
    engine: new AutomationEngine({
      dir,
      outbox: false, // outcomes are recorded on the deployment and in the workspace audit log
      concurrency: 1, // one slot at a time, in order, as before
      workflows: [
        {
          id: 'schedule',
          triggers: [trigger],
          maxAttempts: 1, // a failed start is recorded, never retried in a loop
          run: async (event) => {
            const r = await fireScheduled(entry.deps, event.payload as ScheduleFire);
            results.set(event.idempotencyKey, r);
            return { disposition: 'completed', lane: 'schedule', summary: r };
          },
        },
      ],
    }),
  };
  engines.set(dir, entry);
  try {
    await entry.engine.start();
  } catch (cause) {
    engines.delete(dir);
    if (cause instanceof EngineLockedError) return undefined;
    throw cause;
  }
  return entry;
}

/** Stops this data directory's engine (in-flight slots finish first) and frees its lock for another process. */
export async function releaseEngine(deps: SchedulerDeps): Promise<void> {
  const dir = engineDir(deps);
  const entry = engines.get(dir);
  if (entry === undefined) return;
  engines.delete(dir);
  await entry.engine.stop();
}

/** Fires one due slot: records missed slots, or starts the run through the same gates as a manual start. */
async function fireScheduled(deps: SchedulerDeps, f: ScheduleFire): Promise<'started' | 'skipped' | 'none'> {
  const id = f.workspaceId;
  const now = new Date(f.at);
  const ws = await deps.workspaceStore.get(id);
  if (!ws.ok) return 'none';
  const principalResult = establishAuthenticatedPrincipal({ kind: 'service', id: 'trigger-schedule' });
  if (!principalResult.ok) throw principalResult.error;
  const store = new FsControlsStore(workspaceStateStore(ws.value, deps.dataConfig), id);
  const d = (await store.listDeployments()).find((x) => x.compilationId === f.compilationId && x.workflowId === f.workflowId);
  if (d === undefined || d.triggers.schedule === undefined) return 'none'; // removed since the slot was accepted
  const plan = { skipped: { length: f.skippedSlots }, run: f.slot ?? undefined };
  const slot = f.slot;
  if (plan.skipped.length > 0 && plan.run === undefined) {
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
    return 'skipped';
  }
  let outcome: string;
  let result: 'succeeded' | 'failed' | 'denied' = 'succeeded';
  let fired = false;
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
          ...(sched.items !== undefined ? { items: sched.items } : {}),
          slotKey: `schedule:${sched.everyMinutes}:${slot}`,
          ...(sched.standingApprovalId !== undefined ? { standingApprovalId: sched.standingApprovalId } : {}),
        },
      );
      runId = typeof r.body['runId'] === 'string' ? r.body['runId'] : undefined;
      const state = String(r.body['state'] ?? '');
      outcome =
        r.body['fallback'] === true
          ? typeof r.body['previewId'] === 'string'
            ? `fell back to a batch approval (${(r.body['reasons'] as string[]).join(', ')}): preview ${r.body['previewId']} waits in the Inbox`
            : `nothing to do under the standing approval (${(r.body['reasons'] as string[]).join(', ')})`
          : r.body['preview'] === true
            ? r.body['created'] === false
              ? `preview already prepared (${String(r.body['previewId'])}): waits for approval in the Inbox`
              : `preview prepared (${String(r.body['previewId'])}): waits for approval in the Inbox`
            : state === 'failed'
              ? 'started on the workflow runtime, but the run failed (check its input)'
              : 'started on the workflow runtime';
      if (plan.skipped.length > 0)
        outcome += `; skipped: missed ${plan.skipped.length} earlier slot${plan.skipped.length === 1 ? '' : 's'}`;
      if (state === 'failed') result = 'failed';
    } else {
      // ADR 0052: the composed runner is removed; a schedule with no certificate (one set before it was removed) has nowhere to run.
      result = 'denied';
      outcome = 'skipped: this schedule needs a readiness certificate';
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
        target: { kind: 'workflow', id: d.workflowId },
        detail: { compilationId: d.compilationId, trigger: 'schedule', outcome },
      });
      return 'skipped';
    }
    fired = true;
  } catch (cause) {
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
  return fired ? 'started' : 'skipped';
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
  if (held === undefined) {
    await releaseEngine(deps); // not the holder: free the engine's directory for the process that is
    return undefined;
  }
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
    void releaseEngine(withLease)
      .catch(() => undefined)
      .finally(() => lease.store.release('scheduler', lease.holder).catch(() => undefined));
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
    /** UW-16a: the configuration the API runs with, when the scheduler shares its process (adapters, certificate and approval policy). */
    readonly dataConfig?: SchedulerDeps['dataConfig'];
  },
  log?: (line: string) => void,
): SchedulerDeps {
  return {
    workspaceStore: new FsWorkspaceStore(new LocalFsBlobStore(workspacesDir)),
    dataConfig: enforcement.dataConfig ?? {
      dataRootDir,
      packageTrustPolicy: enforcement.packageTrustPolicy,
      ...(enforcement.auditAnchor !== undefined ? { auditAnchor: enforcement.auditAnchor } : {}),
    },
    permissionManager: enforcement.permissionManager,
    audit: enforcement.audit,
    ...(log !== undefined ? { log } : {}),
  };
}
