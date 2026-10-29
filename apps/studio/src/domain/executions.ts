import type { Execution, WorkflowRun, WorkflowRunStep } from '../platform/wire';
import { describeRun } from './work';
import { tidyName } from './work';

/**
 * The Executions screen's facts, all taken from the platform's own records: a run's status, its start and completion
 * times, and for each step the execution it produced (input, output, timestamps, a person's decision). Nothing is
 * estimated: a duration appears only when both timestamps were recorded.
 */
export function runsOf(runs: readonly WorkflowRun[], workflowId: string, compilationId?: string): WorkflowRun[] {
  return (
    runs
      // Runs started from a saved draft of the same compilation belong in the same history (their workflow id is `draft:<id>`).
      .filter(
        (r) =>
          (r.workflowId === workflowId || (r.draft !== undefined && compilationId !== undefined)) &&
          (compilationId === undefined || r.compilationId === compilationId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );
}

/** The platform's run ids are long and opaque; the last characters are enough to tell runs apart. */
export function shortRunId(id: string): string {
  const bare = id.replace(/^wfx_/, '');
  return bare.length <= 6 ? bare : bare.slice(-6);
}

export function durationMs(startIso: string, endIso: string | undefined): number | undefined {
  if (endIso === undefined) return undefined;
  const ms = Date.parse(endIso) - Date.parse(startIso);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export interface RunRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly tone: 'success' | 'warning' | 'danger' | 'neutral';
  readonly duration: string | undefined;
}

export function runRow(run: WorkflowRun): RunRow {
  const v = describeRun(run);
  const failedAt = run.status === 'failed' ? run.steps.find((s) => s.status === 'failed') : undefined;
  const d = durationMs(run.createdAt, run.completedAt);
  return {
    id: run.workflowExecutionId,
    title: `Run ${shortRunId(run.workflowExecutionId)}`,
    status: failedAt !== undefined ? `${v.label} at ${tidyName(failedAt.capabilityName, 24)}` : v.label,
    tone: v.tone,
    duration: d === undefined ? undefined : formatMs(d),
  };
}

export interface StepRecord {
  readonly step: WorkflowRunStep;
  readonly execution: Execution | undefined;
  /** Request to completion of the step's execution. For a step a person decides, this includes the time they took. */
  readonly durationMs: number | undefined;
  readonly events: readonly { readonly label: string; readonly at: string | undefined }[];
}

export function stepRecord(run: WorkflowRun, stepId: string, executions: readonly Execution[]): StepRecord | undefined {
  const step = run.steps.find((s) => s.stepId === stepId);
  if (step === undefined) return undefined;
  const execution = step.executionId === undefined ? undefined : executions.find((e) => e.executionId === step.executionId);
  const events: { label: string; at: string | undefined }[] = [];
  if (execution !== undefined) {
    events.push({ label: 'Requested', at: execution.requestedAt });
    const t = execution.humanTask;
    if (t !== undefined) {
      events.push(
        t.status === 'pending'
          ? { label: 'Waiting for a person', at: undefined }
          : { label: `A person ${t.decision === 'approve' ? 'approved' : 'rejected'} this step`, at: t.resolvedAt },
      );
      if (t.decisionNote !== undefined && t.decisionNote !== '') events.push({ label: `Note: ${t.decisionNote}`, at: undefined });
    }
    if (execution.completedAt !== undefined)
      events.push({ label: `Ended as ${execution.status.replace(/_/g, ' ')}`, at: execution.completedAt });
    if (execution.errorMessage !== undefined) events.push({ label: execution.errorMessage, at: undefined });
  }
  return {
    step,
    execution,
    durationMs: execution === undefined ? undefined : durationMs(execution.requestedAt, execution.completedAt),
    events,
  };
}
