import { ErrorCode } from '@xo/errors';
import type { ExecutionRecord } from '../executions/execution.js';
import type { WorkflowExecutionRecord, WorkflowStepState } from './workflow-execution.js';

/**
 * The workflow state machine, as PURE functions over
 * `WorkflowExecutionRecord` — no I/O, no clock reads (callers pass `now`),
 * no revision bump (that is `RecordHolder.update`'s job in
 * `workflow-runner.ts`, so exactly one place ever mutates `revision`).
 *
 *   created ──► running ──► step execution
 *                              ├─ succeeded ──► next step … ──► workflow succeeded
 *                              ├─ waiting_for_human ──► workflow waiting_for_human
 *                              │      └─ human resolution ─┬─ approve ─► step succeeded ─► next step …
 *                              │                           ├─ reject ──► step rejected, later steps skipped, workflow rejected
 *                              │                           └─ resume failed ─► workflow failed
 *                              └─ failed ──► later steps skipped, workflow failed
 *   running/created + process gone ──► interrupted ──(explicit resume)──► running
 *
 * "workflow succeeded" is reached ONLY when every step is `succeeded`
 * (`allStepsSucceeded` below) — never inferred from "the engine ran
 * without throwing".
 */

function replaceStep(steps: readonly WorkflowStepState[], index: number, next: WorkflowStepState): readonly WorkflowStepState[] {
  return steps.map((s, i) => (i === index ? next : s));
}

function skipPendingAfter(steps: readonly WorkflowStepState[], index: number): readonly WorkflowStepState[] {
  return steps.map((s, i) => (i > index && s.status === 'pending' ? { ...s, status: 'skipped' as const } : s));
}

function withoutKeys<T extends object>(value: T, keys: readonly string[]): T {
  const copy = { ...value } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as T;
}

function updateProvenance(record: WorkflowExecutionRecord, index: number, patch: { contractId?: string | undefined; bindingId?: string | undefined; sourceXoirNodeIds?: readonly string[] | undefined; executionId?: string | undefined }): WorkflowExecutionRecord['provenance'] {
  return {
    ...record.provenance,
    steps: record.provenance.steps.map((p) =>
      p.order === index
        ? {
            ...p,
            ...(patch.contractId !== undefined ? { contractId: patch.contractId } : {}),
            ...(patch.bindingId !== undefined ? { bindingId: patch.bindingId } : {}),
            ...(patch.sourceXoirNodeIds !== undefined ? { sourceXoirNodeIds: patch.sourceXoirNodeIds } : {}),
            ...(patch.executionId !== undefined ? { executionId: patch.executionId } : {}),
          }
        : p,
    ),
  };
}

/** Index of the first step that has not yet succeeded and is runnable (`pending` or `interrupted`); `-1` when there is none. */
export function firstRunnableStepIndex(record: WorkflowExecutionRecord): number {
  return record.steps.findIndex((s) => s.status === 'pending' || s.status === 'interrupted');
}

export function allStepsSucceeded(record: WorkflowExecutionRecord): boolean {
  return record.steps.length > 0 && record.steps.every((s) => s.status === 'succeeded');
}

export function withRunning(record: WorkflowExecutionRecord, now: string): WorkflowExecutionRecord {
  const index = firstRunnableStepIndex(record);
  return {
    ...withoutKeys(record, ['pendingHumanTask']),
    status: 'running',
    startedAt: record.startedAt ?? now,
    currentStepIndex: index >= 0 ? index : record.currentStepIndex,
  };
}

export interface StepStartInfo {
  readonly executionId: string;
  readonly contractId?: string;
  readonly bindingId?: string;
  readonly executionClass?: 'deterministic_rule' | 'human_in_the_loop';
}

export function withStepStarted(record: WorkflowExecutionRecord, index: number, info: StepStartInfo, now: string): WorkflowExecutionRecord {
  const prior = record.steps[index]!;
  const superseded = prior.executionId !== undefined && prior.status === 'interrupted' ? [...(prior.supersededExecutionIds ?? []), prior.executionId] : prior.supersededExecutionIds;
  const next: WorkflowStepState = {
    ...withoutKeys(prior, ['completedAt', 'result', 'error']),
    status: 'running',
    executionId: info.executionId,
    startedAt: now,
    ...(info.contractId !== undefined ? { contractId: info.contractId } : {}),
    ...(info.bindingId !== undefined ? { bindingId: info.bindingId } : {}),
    ...(info.executionClass !== undefined ? { executionClass: info.executionClass } : {}),
    ...(superseded !== undefined ? { supersededExecutionIds: superseded } : {}),
  };
  return {
    ...withoutKeys(record, ['pendingHumanTask']),
    status: 'running',
    steps: replaceStep(record.steps, index, next),
    currentStepIndex: index,
    currentStepExecutionId: info.executionId,
    provenance: updateProvenance(record, index, { contractId: info.contractId, bindingId: info.bindingId, executionId: info.executionId }),
  };
}

export type StepOutcome =
  | { readonly kind: 'succeeded'; readonly output: unknown; readonly sourceXoirNodeIds?: readonly string[] }
  | { readonly kind: 'waiting_for_human' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

function finishSucceeded(record: WorkflowExecutionRecord, index: number, output: unknown, sourceXoirNodeIds: readonly string[] | undefined, now: string): WorkflowExecutionRecord {
  const step = record.steps[index]!;
  const nextStep: WorkflowStepState = { ...step, status: 'succeeded', completedAt: now, result: output };
  const steps = replaceStep(record.steps, index, nextStep);
  const completedStepExecutionIds = step.executionId !== undefined ? [...record.completedStepExecutionIds, step.executionId] : record.completedStepExecutionIds;
  const base = { ...withoutKeys(record, ['pendingHumanTask', 'currentStepExecutionId']), steps, completedStepExecutionIds, provenance: updateProvenance(record, index, { sourceXoirNodeIds }) };
  const candidate: WorkflowExecutionRecord = base;
  if (allStepsSucceeded(candidate)) {
    return {
      ...candidate,
      status: 'succeeded',
      currentStepIndex: null,
      completedAt: now,
      finalResult: {
        outcome: 'completed',
        stepResults: steps.map((s) => ({ order: s.order, capabilityId: s.capabilityId, executionId: s.executionId!, output: s.result })),
      },
    };
  }
  return { ...candidate, status: 'running', currentStepIndex: firstRunnableStepIndex(candidate) };
}

function finishFailed(record: WorkflowExecutionRecord, index: number, code: string, message: string, now: string): WorkflowExecutionRecord {
  const step = record.steps[index]!;
  const nextStep: WorkflowStepState = { ...step, status: 'failed', completedAt: now, error: { code, message } };
  return {
    ...withoutKeys(record, ['pendingHumanTask', 'currentStepExecutionId']),
    steps: skipPendingAfter(replaceStep(record.steps, index, nextStep), index),
    status: 'failed',
    currentStepIndex: null,
    completedAt: now,
    errorCode: code,
    errorMessage: message,
  };
}

/** Applies the outcome of one step's capability execution (P0.5 semantics) to the workflow record. */
export function withStepOutcome(record: WorkflowExecutionRecord, index: number, outcome: StepOutcome, now: string): WorkflowExecutionRecord {
  switch (outcome.kind) {
    case 'succeeded':
      return finishSucceeded(record, index, outcome.output, outcome.sourceXoirNodeIds, now);
    case 'failed':
      return finishFailed(record, index, outcome.code, outcome.message, now);
    case 'waiting_for_human': {
      const step = record.steps[index]!;
      return {
        ...record,
        steps: replaceStep(record.steps, index, { ...step, status: 'waiting_for_human' }),
        status: 'waiting_for_human',
        currentStepIndex: index,
        ...(step.executionId !== undefined ? { currentStepExecutionId: step.executionId, pendingHumanTask: { stepIndex: index, executionId: step.executionId } } : {}),
      };
    }
  }
}

/**
 * Applies the RESOLVED human task's underlying `ExecutionRecord` (as
 * P0.7's `resolveHumanTaskExecution` left it) to the workflow: the step's
 * fate is exactly the capability execution's fate — `succeeded` ->
 * step succeeded (workflow continues), `rejected` -> step rejected and
 * every later step skipped, `failed` -> step/workflow failed. The
 * residual P0.7 `'unsupported'` outcome (execution left
 * `waiting_for_human`, `humanTask.resumeOutcome.kind === 'unsupported'`)
 * cannot be continued honestly and fails the workflow with
 * `HITL_RESUME_UNSUPPORTED`.
 */
export function withHumanResolution(record: WorkflowExecutionRecord, index: number, execution: ExecutionRecord, now: string): WorkflowExecutionRecord {
  switch (execution.status) {
    case 'succeeded':
      return finishSucceeded(record, index, execution.output, execution.sourceXoirNodeIds, now);
    case 'rejected': {
      const step = record.steps[index]!;
      const resolvedAt = execution.humanTask?.resolvedAt ?? now;
      return {
        ...withoutKeys(record, ['pendingHumanTask', 'currentStepExecutionId']),
        steps: skipPendingAfter(replaceStep(record.steps, index, { ...step, status: 'rejected', completedAt: resolvedAt }), index),
        status: 'rejected',
        currentStepIndex: null,
        completedAt: resolvedAt,
        rejection: {
          stepIndex: index,
          executionId: execution.executionId,
          decision: 'reject',
          resolvedAt,
          ...(execution.humanTask?.resolverIdentityId !== undefined ? { resolverIdentityId: execution.humanTask.resolverIdentityId } : {}),
        },
      };
    }
    case 'failed':
      return finishFailed(record, index, execution.errorCode ?? ErrorCode.UNKNOWN, execution.errorMessage ?? 'human task resume failed', now);
    default: {
      const outcome = execution.humanTask?.resumeOutcome;
      const message = outcome !== undefined && (outcome.kind === 'unsupported' || outcome.kind === 'failed') ? outcome.errorMessage : `execution "${execution.executionId}" is still ${execution.status} after its human task was resolved`;
      return finishFailed(record, index, ErrorCode.HITL_RESUME_UNSUPPORTED, message, now);
    }
  }
}

/** Workflow-level failure not attributable to one step's capability execution (e.g. the persisted graph no longer resolves, or the engine itself errored). Marks the current runnable step, if any, `failed` too so no step is left looking `running`/`pending` on a failed workflow. */
export function withWorkflowFailure(record: WorkflowExecutionRecord, code: string, message: string, now: string): WorkflowExecutionRecord {
  const index = record.steps.findIndex((s) => s.status === 'running' || s.status === 'interrupted' || s.status === 'pending');
  if (index >= 0) return finishFailed(record, index, code, message, now);
  return { ...withoutKeys(record, ['pendingHumanTask', 'currentStepExecutionId']), status: 'failed', currentStepIndex: null, completedAt: now, errorCode: code, errorMessage: message };
}

/** The process that was driving this workflow is gone (or never got to start a step). The running step, if any, is `interrupted` — NOT assumed succeeded or failed. */
export function withInterrupted(record: WorkflowExecutionRecord): WorkflowExecutionRecord {
  const steps = record.steps.map((s) => (s.status === 'running' ? { ...s, status: 'interrupted' as const } : s));
  const candidate: WorkflowExecutionRecord = { ...withoutKeys(record, ['pendingHumanTask']), steps, status: 'interrupted' };
  const index = firstRunnableStepIndex(candidate);
  return { ...candidate, currentStepIndex: index >= 0 ? index : record.currentStepIndex };
}
