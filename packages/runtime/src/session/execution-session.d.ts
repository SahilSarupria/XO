import type { ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionPlan } from '../execution/execution-plan.js';
import type { ExecutionReceipt, ExecutionReceiptPackageRecord } from './execution-receipt.js';
import { SessionId, type RequestId } from '../ids.js';
export type ExecutionStatus = 'pending' | 'planned' | 'plan_failed' | 'executing' | 'completed' | 'cancelled' | 'timed_out' | 'failed';
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
export declare function createSession(request: ExecutionRequest, now?: () => Date): ExecutionSession;
/** Records a plan's outcome onto the session: `planned` (with the selected package/capability) if the plan found a compatible candidate, `plan_failed` otherwise. */
export declare function withPlan(session: ExecutionSession, plan: ExecutionPlan, now?: () => Date): ExecutionSession;
export declare function withReceipt(session: ExecutionSession, receipt: ExecutionReceipt, now?: () => Date, options?: {
    readonly degraded?: boolean;
}): ExecutionSession;
/** Marks a planned session as actively running the AI Capability Layer call — the gap between `withPlan` and `withReceipt`/`withCancelled`/`withTimedOut`/`withFailed`. */
export declare function withExecuting(session: ExecutionSession, now?: () => Date): ExecutionSession;
export declare function withCancelled(session: ExecutionSession, now?: () => Date): ExecutionSession;
export declare function withTimedOut(session: ExecutionSession, now?: () => Date): ExecutionSession;
export declare function withFailed(session: ExecutionSession, now?: () => Date): ExecutionSession;
//# sourceMappingURL=execution-session.d.ts.map