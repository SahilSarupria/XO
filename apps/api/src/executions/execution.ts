import type { Result } from '@xo/types';
import type { AuthenticatedPrincipal, Principal } from '@xo/permissions';
import type { NotFoundError, XoError } from '@xo/errors';

/**
 * `waiting_for_human` is what a `human_in_the_loop` binding's
 * `evaluate()` genuinely returns (an escalation record — see
 * `ActionEscalationBindingResolver`'s doc comment). As of P0.7, this is
 * no longer terminal: resolving a human task (see `HumanTaskInfo`)
 * genuinely transitions `status` to `'succeeded'`, `'failed'`, or
 * `'rejected'` — see `resume-human-task.ts`'s doc comment for exactly
 * what "resume" means for this binding type and why that transition is
 * honest, not fabricated. `'running'` exists only for the same
 * forward-compatibility reason `CompilationStatus`'s `'running'` does
 * (P0.4) — this milestone's resume is still synchronous; nothing ever
 * observably persists in that state.
 */
export type ExecutionStatus = 'succeeded' | 'failed' | 'waiting_for_human' | 'rejected' | 'running';

export type HumanTaskDecision = 'approve' | 'reject';

/**
 * What actually happened when a resume was attempted for a resolved
 * human task.
 *
 *   - `'succeeded'` / `'rejected'`: a REAL resume genuinely ran — see
 *     `resume-human-task.ts`'s doc comment for what "ran" means for the
 *     one binding type (`ActionEscalationBindingResolver`) this
 *     codebase's production capabilities actually use, versus what a
 *     binding that branches on the human's decision (this milestone's
 *     test-only fixture) can do differently.
 *   - `'failed'`: resume was genuinely attempted and a real error
 *     occurred (permission re-check failed, binding no longer resolves,
 *     the runtime call itself threw, decision data failed validation).
 *   - `'unsupported'`: the narrow residual case — see
 *     `resume-human-task.ts` for exactly when this remains reachable
 *     after P0.7 (it is NOT the default outcome anymore, unlike P0.6 —
 *     only when the persisted continuation context itself is missing or
 *     corrupt, e.g. the owning compilation was deleted).
 */
export type HumanTaskResumeOutcome =
  | { readonly kind: 'succeeded'; readonly output: unknown }
  | { readonly kind: 'rejected'; readonly output: unknown }
  | { readonly kind: 'failed'; readonly errorCode: string; readonly errorMessage: string }
  | { readonly kind: 'unsupported'; readonly errorCode: string; readonly errorMessage: string };

/**
 * Present on an `ExecutionRecord` exactly when that execution's
 * `status` ever became `'waiting_for_human'` — i.e. this IS the human
 * task, not a separate entity with its own id (unchanged design
 * decision from P0.6: extending the existing execution record, not a
 * second store). `escalation` isn't duplicated here — it's already
 * `ExecutionRecord.output` as it stood at the moment of escalation; the
 * ORIGINAL escalation is preserved verbatim in `resumeOutcome`'s own
 * `output` shape for the "human_confirmed"/"human_rejected" cases (see
 * `resume-human-task.ts`) so nothing about what the runtime originally
 * reported is lost even after resolution.
 */
export interface HumanTaskInfo {
  readonly status: 'pending' | 'resolved';
  readonly decision?: HumanTaskDecision;
  /** Bounded, human-supplied data — validated against the capability's own decision-data schema when the resolved binding's declaration carries one, otherwise bounded to a small plain JSON object (see `human-task-routes.ts`/`execute-capability.ts`'s validation). Never unconstrained/executable payloads. */
  readonly decisionData?: Readonly<Record<string, unknown>>;
  readonly resolvedAt?: string;
  /** Always `req.identity.identityId` at resolution time — never client-supplied (same discipline as `ApprovalRecord.approverIdentityId`). */
  readonly resolverIdentityId?: string;
  /** P1.0 M1 — the authenticated principal that resolved the task. Distinct from `ExecutionRecord.initiator`: resolving never replaces the initiator. */
  readonly resolver?: Principal;
  readonly resumeOutcome?: HumanTaskResumeOutcome;
}

export interface ExecutionRecord {
  readonly executionId: string;
  readonly workspaceId: string;
  readonly identityId: string;
  /** P1.0 M1 — immutable attribution snapshot of the authenticated principal that initiated this execution (`identityId` above equals `initiator.id`). Set once at creation from `req.principal`, never changed by `complete()` or a human-task resolution — a resolver is recorded separately in `humanTask.resolver`. Absent on records written before M1 (never back-filled or guessed). Attribution only: not proof of authorization. */
  readonly initiator?: Principal;
  readonly compilationId: string;
  readonly capabilityId: string;
  /**
   * `RuntimeCapabilityExecutionResult.contractId`/`bindingId`/`sourceXoirNodeIds`
   * — present only when the runtime actually populated them. This is
   * ALSO, as of P0.7, the entirety of the "continuation context" a
   * resume needs beyond what's already here: `compilationId` (to
   * re-fetch the compiled graph — never a fresh recompile) +
   * `capabilityId` + `input` (below) are sufficient to re-derive the
   * exact same contract/binding a resume re-checks against. No separate
   * continuation-context field or store was needed — see this
   * milestone's completion report's "architecture" section for the full
   * reasoning.
   */
  readonly contractId?: string;
  readonly bindingId?: string;
  readonly sourceXoirNodeIds?: readonly string[];
  /** P0.9B — copied from the runtime result: the executed graph's `XoirGraph.contentHash()` and the executed contract's `computeContractContentHash`. Absent on records written before P0.9B. */
  readonly graphHash?: string;
  readonly contractContentHash?: string;
  readonly status: ExecutionStatus;
  readonly requestedAt: string;
  /** The moment `status` most recently became terminal-for-this-phase: originally, the moment of `succeeded`/`failed`/`waiting_for_human`; after a resume, `humanTask.resolvedAt` is the more precise "when did this finally conclude" timestamp — this field is left as originally set (the "waiting since" moment) rather than overwritten, so both timestamps remain independently inspectable. */
  readonly completedAt?: string;
  /** The exact input the caller supplied — small by construction (a capability's structured input, never raw source bytes) — safe to store verbatim rather than a separate reference. */
  readonly input: unknown;
  /** The runtime's actual output. Updated in place when a human task resolves to `succeeded`/`rejected`/`failed` — see `HumanTaskResumeOutcome`'s doc comment for what that new output actually represents for each binding type. */
  readonly output?: unknown;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  /** Present iff `status` ever became `'waiting_for_human'`. See `HumanTaskInfo`'s own doc comment. */
  readonly humanTask?: HumanTaskInfo;
}

export interface CreateExecutionInput {
  readonly compilationId: string;
  readonly capabilityId: string;
  readonly input: unknown;
}

export type ExecutionOutcomeInput =
  | { readonly status: 'succeeded'; readonly output: unknown; readonly contractId?: string; readonly bindingId?: string; readonly sourceXoirNodeIds?: readonly string[]; readonly graphHash?: string; readonly contractContentHash?: string }
  | { readonly status: 'waiting_for_human'; readonly output: unknown; readonly contractId?: string; readonly bindingId?: string; readonly sourceXoirNodeIds?: readonly string[]; readonly graphHash?: string; readonly contractContentHash?: string }
  | { readonly status: 'failed'; readonly errorCode: string; readonly errorMessage: string };

export interface ResolveHumanTaskInput {
  readonly decision: HumanTaskDecision;
  readonly decisionData?: Readonly<Record<string, unknown>>;
  readonly resolverIdentityId: string;
  readonly resolver: Principal;
  readonly resumeOutcome: HumanTaskResumeOutcome;
}

/**
 * Distinguishes "this execution was never a human task at all" (no
 * `humanTask` field ever set — a precondition problem, mapped to 400 by
 * the route) from "it was, but is already resolved" (a state conflict,
 * mapped to 409) — see `human-task-routes.ts`.
 */
export type ResolveHumanTaskFailure = { readonly kind: 'not_a_human_task' } | { readonly kind: 'already_resolved'; readonly record: ExecutionRecord };

/** Scoped to exactly one workspace by construction — see `ApprovalStore`'s identical doc comment. */
export interface ExecutionStore {
  create(workspaceId: string, principal: AuthenticatedPrincipal, input: CreateExecutionInput): Promise<Result<ExecutionRecord, XoError>>;
  complete(executionId: string, outcome: ExecutionOutcomeInput): Promise<Result<ExecutionRecord, XoError>>;
  get(executionId: string): Promise<Result<ExecutionRecord, NotFoundError>>;
  list(): Promise<Result<readonly ExecutionRecord[], XoError>>;
  /**
   * Records a human decision exactly once, and — as of P0.7 — updates
   * the execution's own top-level `status`/`output`/`errorCode`/
   * `errorMessage` in the SAME write to reflect the real resume outcome
   * (never a separate, later write — there is exactly one file, one
   * `put`, per resolution). On a second call for an already-resolved
   * task, returns `ok({kind: 'already_resolved', record})` with the
   * ORIGINAL record completely unchanged — never overwrites the first
   * decision or its outcome. This method alone is not sufficient for
   * cross-request race safety (a plain read-then-write has a TOCTOU
   * gap) — callers MUST additionally serialize concurrent calls for the
   * same `executionId` via `withExecutionLock` (`execution-lock.ts`);
   * this store method only guarantees the single-writer, no-lock-held
   * case is correct.
   */
  resolveHumanTask(executionId: string, input: ResolveHumanTaskInput): Promise<Result<ExecutionRecord | ResolveHumanTaskFailure, NotFoundError>>;
}

const EXECUTION_ID_PATTERN = /^exe_[0-9a-f]{32}$/;

export function isValidExecutionId(value: string): boolean {
  return EXECUTION_ID_PATTERN.test(value);
}
