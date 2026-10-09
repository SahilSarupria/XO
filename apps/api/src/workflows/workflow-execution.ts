import type { Result } from '@xo/types';
import { ErrorCode, XoError, type NotFoundError } from '@xo/errors';

/**
 * P0.8 — persistent, step-aware workflow execution.
 *
 * A `WorkflowExecutionRecord` is the API-level, durable source of truth
 * for one run of one `CandidateWorkflow` (from `@xo/workflow-composer`,
 * unmodified) against one stored compilation. It deliberately holds
 * REFERENCES to the underlying capability executions (P0.5's
 * `ExecutionRecord`, one per step, identified by `executionId`) rather
 * than copying their inputs/outputs — the `ExecutionRecord` remains the
 * single source of truth for what a step was given, what it returned,
 * and (for HITL steps) the human task itself (P0.6/P0.7).
 *
 * Never persisted: any client-supplied step definition, capability id
 * list, binding, runtime declaration, or storage key. The ordered `steps`
 * are always derived server-side from the stored compilation's graph.
 */

export type WorkflowExecutionStatus = 'created' | 'running' | 'waiting_for_human' | 'succeeded' | 'failed' | 'rejected' | 'interrupted';

export type WorkflowStepStatus = 'pending' | 'running' | 'waiting_for_human' | 'succeeded' | 'failed' | 'rejected' | 'skipped' | 'interrupted';

export const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowExecutionStatus> = new Set<WorkflowExecutionStatus>(['succeeded', 'failed', 'rejected']);

export interface WorkflowStepError {
  readonly code: string;
  readonly message: string;
}

export interface WorkflowStepState {
  /** `CandidateWorkflowStep.id` (`<capabilityId>#<order>`), verbatim. */
  readonly stepId: string;
  /** `CandidateWorkflowStep.order` — equal to this step's index in `steps`. */
  readonly order: number;
  /** The XOIR capability node id — resolved from the stored compilation, never client-supplied. */
  readonly capabilityId: string;
  readonly capabilityName: string;
  /** `SemanticCapabilityContract.id`, once the step's binding has been resolved for an execution attempt. */
  readonly contractId?: string;
  readonly bindingId?: string;
  readonly executionClass?: 'deterministic_rule' | 'human_in_the_loop';
  readonly status: WorkflowStepStatus;
  /** The underlying P0.5 `ExecutionRecord` id for this step's CURRENT attempt. Present from the moment the step starts running. */
  readonly executionId?: string;
  /** Executions of earlier attempts that were `interrupted` (process disappeared mid-step) and superseded by an explicit recovery `resume` — kept for auditability, never re-used. */
  readonly supersededExecutionIds?: readonly string[];
  readonly startedAt?: string;
  readonly completedAt?: string;
  /** Present when `status === 'succeeded'`: the capability's actual output (a copy of `ExecutionRecord.output`, kept only so the workflow's `finalResult` is self-contained — the `ExecutionRecord` remains authoritative). */
  readonly result?: unknown;
  /** Present when `status` is `'failed'`. For `'rejected'`, see `WorkflowExecutionRecord.rejection`. */
  readonly error?: WorkflowStepError;
}

export interface WorkflowRejection {
  readonly stepIndex: number;
  readonly executionId: string;
  readonly decision: 'reject';
  readonly resolvedAt?: string;
  readonly resolverIdentityId?: string;
}

/** Present iff `status === 'waiting_for_human'` — see `WorkflowExecutionRecord.pendingHumanTask`. */
export interface PendingWorkflowHumanTask {
  readonly stepIndex: number;
  /** The step's underlying capability execution id, which IS the human task id (P0.6 design: no separate task entity). */
  readonly executionId: string;
}

export interface WorkflowFinalResult {
  readonly outcome: 'completed';
  readonly stepResults: readonly { readonly order: number; readonly capabilityId: string; readonly executionId: string; readonly output: unknown }[];
}

export interface WorkflowExecutionRecord {
  readonly workflowExecutionId: string;
  readonly workspaceId: string;
  readonly identityId: string;
  readonly compilationId: string;
  readonly workflowId: string;
  readonly workflowName: string;
  /**
   * Optimistic-concurrency counter. A freshly created record has
   * `revision: 0`; every persisted update requires the caller's
   * `expectedRevision` to equal the stored revision and stores
   * `expectedRevision + 1`. A stale expected revision fails
   * deterministically (`StaleWorkflowRevisionError`) instead of
   * overwriting newer state. Not a distributed transaction — see
   * `FsWorkflowExecutionStore.save`.
   */
  readonly revision: number;
  readonly status: WorkflowExecutionStatus;
  /** The workflow-level trigger payload — merged, unmodified, into every step's structured input exactly as `apps/cli`'s `workflow-pipeline.ts` does. Bounded plain JSON object. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly steps: readonly WorkflowStepState[];
  /** Index of the step currently running / waiting for a human / next to run. `null` once the workflow is terminal. */
  readonly currentStepIndex: number | null;
  readonly currentStepExecutionId?: string;
  readonly pendingHumanTask?: PendingWorkflowHumanTask;
  /** Ids of the underlying capability executions of every step that reached `succeeded`, in execution order. */
  readonly completedStepExecutionIds: readonly string[];
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly finalResult?: WorkflowFinalResult;
  readonly rejection?: WorkflowRejection;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  /** Provenance references — everything needed to trace this run back to its authoritative sources without copying them. */
  readonly provenance: {
    readonly compilationId: string;
    readonly sourceId?: string;
    readonly sourceDigestSha256?: string;
    readonly workflowId: string;
    /** P0.9B — see `CreateWorkflowExecutionInput.graphHash`'s doc comment. */
    readonly graphHash?: string;
    /** Per-step trace: capability node -> contract/binding -> underlying capability execution. Populated as steps run. */
    readonly steps: readonly { readonly order: number; readonly capabilityId: string; readonly contractId?: string; readonly bindingId?: string; readonly sourceXoirNodeIds?: readonly string[]; readonly executionId?: string }[];
  };
}

export interface CreateWorkflowExecutionInput {
  readonly workflowExecutionId: string;
  readonly compilationId: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly steps: readonly Pick<WorkflowStepState, 'stepId' | 'order' | 'capabilityId' | 'capabilityName'>[];
  readonly sourceId?: string;
  readonly sourceDigestSha256?: string;
  /**
   * P0.9B — the compiled `XoirGraph`'s own content-addressable identity
   * (`XoirGraph.contentHash()`, cached at compile time on
   * `XoirManifest.graphHash` — see `@xo/xoir`'s `manifest.ts`), copied
   * forward from the graph this workflow was composed against
   * (`WorkflowRuntimeContext.graph`, `workflow-runner.ts`). Not a new
   * identity: a workflow execution's steps all share exactly one
   * compiled graph, so this is recorded once, at the top level of
   * `provenance`, rather than duplicated per step.
   */
  readonly graphHash?: string;
}

/**
 * The deterministic "you are acting on stale workflow state" conflict.
 * Returned as a `Result` error by `WorkflowExecutionStore.save` when the
 * stored revision no longer equals the caller's expected revision, and
 * reused (with a different `reason`) by the resume route for every
 * other 409-class refusal (wrong `expectedStepExecutionId`, terminal
 * workflow, resume already in flight). Deliberately built from the
 * existing `RUNTIME_SESSION_INVALID_STATE` code ("the thing you are
 * operating on is not in a state that permits this operation", already
 * mapped to 409) rather than a new `@xo/errors` code — see the P0.8
 * completion report.
 */
export class WorkflowConflictError extends XoError {
  constructor(message: string, readonly reason: WorkflowConflictReason, context: Readonly<Record<string, unknown>> = {}) {
    super(ErrorCode.RUNTIME_SESSION_INVALID_STATE, message, { context: { reason, ...context } });
    this.name = 'WorkflowConflictError';
  }
}

export type WorkflowConflictReason = 'stale_revision' | 'stale_step_execution' | 'step_execution_id_required' | 'not_resumable' | 'terminal' | 'in_flight';

export class StaleWorkflowRevisionError extends WorkflowConflictError {
  constructor(workflowExecutionId: string, readonly expectedRevision: number, readonly actualRevision: number) {
    super(`workflow execution "${workflowExecutionId}" was modified concurrently: expected revision ${expectedRevision}, stored revision is ${actualRevision}`, 'stale_revision', { workflowExecutionId, expectedRevision, actualRevision });
    this.name = 'StaleWorkflowRevisionError';
  }
}

/** Scoped to exactly one workspace by construction — same design as `ExecutionStore`. */
export interface WorkflowExecutionStore {
  create(workspaceId: string, identityId: string, input: CreateWorkflowExecutionInput): Promise<Result<WorkflowExecutionRecord, XoError>>;
  get(workflowExecutionId: string): Promise<Result<WorkflowExecutionRecord, NotFoundError>>;
  list(): Promise<Result<readonly WorkflowExecutionRecord[], XoError>>;
  /**
   * Compare-and-swap update: persists `next` (whose `revision` MUST equal
   * `expectedRevision + 1`) only if the stored record's revision still
   * equals `expectedRevision`. Returns the stale error otherwise, leaving
   * the stored record untouched. Callers MUST additionally serialize via
   * `withExecutionLock` — the read-check-write inside the store is not
   * atomic across processes.
   */
  save(next: WorkflowExecutionRecord, expectedRevision: number): Promise<Result<WorkflowExecutionRecord, XoError>>;
}

const WORKFLOW_EXECUTION_ID_PATTERN = /^wfx_[0-9a-f]{32}$/;

export function isValidWorkflowExecutionId(value: string): boolean {
  return WORKFLOW_EXECUTION_ID_PATTERN.test(value);
}
