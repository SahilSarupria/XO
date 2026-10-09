import type { ExecutionEnvironment, ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionPlan } from '../execution/execution-plan.js';
import type { ExecutionReceipt, ExecutionReceiptPackageRecord } from './execution-receipt.js';
import { SessionId, type RequestId } from '../ids.js';

export type ExecutionStatus =
  | 'pending'
  | 'planned'
  | 'plan_failed'
  | 'executing'
  | 'completed'
  | 'cancelled'
  | 'timed_out'
  | 'failed';

/**
 * Tracks one request's lifecycle end-to-end: request id, which mounted
 * packages/capabilities planning chose, the environment's token
 * budget/provider, current status, and every receipt produced so far.
 * Immutable — `withPlan`/`withReceipt`/`withStatus` each return a new
 * session; nothing here is ever mutated in place. Threading a session
 * through a request's lifecycle (rather than looking state up from
 * scattered plans/receipts) is what lets a caller answer "what happened
 * for request X" from one object.
 */
export interface ExecutionSession {
  readonly sessionId: SessionId;
  readonly requestId: RequestId;
  readonly mountedPackages: readonly ExecutionReceiptPackageRecord[];
  readonly chosenCapabilities: readonly string[];
  readonly tokenBudget?: number;
  readonly provider?: string;
  readonly status: ExecutionStatus;
  readonly receipts: readonly ExecutionReceipt[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Stage 2. Set once a completed execution had to fall back to a degraded path (e.g. an `L0` capability under `degrade_gracefully`, or a `SafetyPipeline` redaction) — see `graceful degradation` in the runtime README. Absent (not `false`) when nothing degraded, matching this codebase's existing "optional means 'not applicable'" convention (e.g. `MountedPackage` has no field at all for an unresolved value, rather than `null`). */
  readonly degraded?: boolean;
}

export function createSession(request: ExecutionRequest, now: () => Date = () => new Date()): ExecutionSession {
  const environment: ExecutionEnvironment = request.environment;
  const timestamp = now().toISOString();
  return Object.freeze({
    sessionId: SessionId(`session_${request.requestId}`),
    requestId: request.requestId,
    mountedPackages: [],
    chosenCapabilities: [],
    ...(environment.tokenBudget !== undefined ? { tokenBudget: environment.tokenBudget } : {}),
    ...(environment.provider !== undefined ? { provider: environment.provider } : {}),
    status: 'pending' as const,
    receipts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/** Records a plan's outcome onto the session: `planned` (with the selected package/capability) if the plan found a compatible candidate, `plan_failed` otherwise. */
export function withPlan(session: ExecutionSession, plan: ExecutionPlan, now: () => Date = () => new Date()): ExecutionSession {
  const selected = plan.selected;
  return Object.freeze({
    ...session,
    mountedPackages: selected ? [{ name: selected.capability.packageName, version: selected.capability.packageVersion }] : session.mountedPackages,
    chosenCapabilities: selected ? [selected.capability.declaration.id] : session.chosenCapabilities,
    status: (selected ? 'planned' : 'plan_failed') as ExecutionStatus,
    updatedAt: now().toISOString(),
  });
}

export function withReceipt(session: ExecutionSession, receipt: ExecutionReceipt, now: () => Date = () => new Date(), options: { readonly degraded?: boolean } = {}): ExecutionSession {
  return Object.freeze({
    ...session,
    receipts: [...session.receipts, receipt],
    status: 'completed' as ExecutionStatus,
    updatedAt: now().toISOString(),
    ...(options.degraded !== undefined ? { degraded: options.degraded } : {}),
  });
}

// --- Stage 2 transitions -----------------------------------------------
// `createSession`/`withPlan`/`withReceipt` above are unmodified in
// behavior for every argument list Stage 1 ever passed them (`withReceipt`
// only gained a new *optional* fourth parameter). Everything below is new.

/** Marks a planned session as actively running the AI Capability Layer call — the gap between `withPlan` and `withReceipt`/`withCancelled`/`withTimedOut`/`withFailed`. */
export function withExecuting(session: ExecutionSession, now: () => Date = () => new Date()): ExecutionSession {
  return Object.freeze({ ...session, status: 'executing' as ExecutionStatus, updatedAt: now().toISOString() });
}

export function withCancelled(session: ExecutionSession, now: () => Date = () => new Date()): ExecutionSession {
  return Object.freeze({ ...session, status: 'cancelled' as ExecutionStatus, updatedAt: now().toISOString() });
}

export function withTimedOut(session: ExecutionSession, now: () => Date = () => new Date()): ExecutionSession {
  return Object.freeze({ ...session, status: 'timed_out' as ExecutionStatus, updatedAt: now().toISOString() });
}

export function withFailed(session: ExecutionSession, now: () => Date = () => new Date()): ExecutionSession {
  return Object.freeze({ ...session, status: 'failed' as ExecutionStatus, updatedAt: now().toISOString() });
}
