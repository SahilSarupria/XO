import { describeRun, runStepsTitle, stepStatusLabel, tidyName } from '../domain/work';
import type { WorkflowRun, WorkflowRunStep } from '../platform/wire';
import { Badge, formatWhen } from './primitives';
import { useSession } from './session';

const STEP_TONE: Record<WorkflowRunStep['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  pending: 'neutral',
  running: 'neutral',
  waiting_for_human: 'warning',
  succeeded: 'success',
  failed: 'danger',
  rejected: 'neutral',
  skipped: 'neutral',
  interrupted: 'warning',
};

/** Title for a run in plain words: what it covers, from the real step names. */
export function runTitle(run: WorkflowRun): string {
  return runStepsTitle(
    run.steps.map((s) => ({ name: s.capabilityName })),
    run.workflowName,
  );
}

/** Where a run stands: overall state first, then each step. Technical identifiers only in Builder Mode. */
export function RunSummary(props: { run: WorkflowRun }) {
  const { mode } = useSession();
  const r = props.run;
  const v = describeRun(r);
  return (
    <div className="outcome">
      <p>
        <Badge tone={v.tone}>{v.label}</Badge> <span className="muted small">Started {formatWhen(r.createdAt)}</span>
      </p>
      <p className={v.tone === 'danger' ? 'outcome-detail danger-text' : 'outcome-detail'}>{v.summary}</p>
      <ol className="steps" aria-label="Steps">
        {r.steps.map((s) => (
          <li key={s.stepId} className="step" aria-current={r.currentStepIndex === s.order ? 'step' : undefined}>
            <span className="step-name">{tidyName(s.capabilityName)}</span>
            <Badge tone={STEP_TONE[s.status]}>{stepStatusLabel(s.status)}</Badge>
            {s.errorMessage !== undefined ? <span className="danger-text small"> {s.errorMessage}</span> : null}
          </li>
        ))}
      </ol>
      {mode === 'builder' ? (
        <details>
          <summary>Workflow record</summary>
          <p className="mono small">
            {r.workflowExecutionId} · revision {r.revision} · {r.status}
            {r.currentStepExecutionId !== undefined ? ` · current step execution ${r.currentStepExecutionId}` : ''}
          </p>
          <pre className="code">{JSON.stringify(r.raw, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}
