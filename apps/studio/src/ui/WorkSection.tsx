import { describeRun, humanStepCount, tidyName, workflowTitle } from '../domain/work';
import type { Capability, Compilation, Workflow, WorkflowRun } from '../platform/wire';
import { ActionNoticeView } from './actions';
import { useStartWorkflow } from './useStartWorkflow';
import { Badge, Button, EmptyState, Section } from './primitives';
import { useSession } from './session';

/**
 * Processes that can be started, and the ones already underway.
 *
 * Starting is guarded in the browser only: this tab checks the platform for an existing active run
 * immediately before it sends a start, locks the button while the request is in flight, and after an
 * unclear failure re-reads the platform's state. That reduces accidental duplicates. It does NOT
 * guarantee exactly-once: the platform has no idempotency key, so two tabs, two people or a retry
 * outside Studio can still create two runs.
 */
export function WorkSection(props: {
  workspaceId: string;
  compilation: Compilation | undefined;
  workflows: readonly Workflow[];
  caps: readonly Capability[] | undefined;
  /** The capability list failed to load, so approvals cannot be checked. Distinct from "still loading". */
  capsFailed: boolean;
  runs: readonly WorkflowRun[];
  onChanged: () => void;
  goToSetup: () => void;
  goToTasks: () => void;
  goToActivity: () => void;
  onOpenGraph: (workflowId: string) => void;
}) {
  const here = props.workflows.filter((w) => props.compilation !== undefined && w.compilationId === props.compilation.compilationId);

  return (
    <Section id="work-h" title="Workflows" lede="Processes XO found in your documents. Start one, or pick up where you left off.">
      {props.compilation === undefined ? (
        <EmptyState title="No processes yet">
          Add a document and let XO analyse it. Processes it can carry out will appear here.{' '}
          <Button variant="quiet" onClick={props.goToSetup}>
            Go to Sources
          </Button>
        </EmptyState>
      ) : here.length === 0 ? (
        <EmptyState title="XO did not find a process in this document">
          It found rules, but could not put them in a sequence. You can still review the individual rules in Sources.
        </EmptyState>
      ) : (
        <ul className="list">
          {here.map((w) => (
            <li key={w.workflowId} className="card">
              <WorkflowCard
                workspaceId={props.workspaceId}
                workflow={w}
                caps={props.caps}
                capsFailed={props.capsFailed}
                runs={props.runs}
                onChanged={props.onChanged}
                goToSetup={props.goToSetup}
                goToTasks={props.goToTasks}
                goToActivity={props.goToActivity}
                onOpenGraph={props.onOpenGraph}
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function WorkflowCard(props: {
  workspaceId: string;
  workflow: Workflow;
  caps: readonly Capability[] | undefined;
  capsFailed: boolean;
  runs: readonly WorkflowRun[];
  onChanged: () => void;
  goToSetup: () => void;
  goToTasks: () => void;
  goToActivity: () => void;
  onOpenGraph: (workflowId: string) => void;
}) {
  const { mode } = useSession();
  const w = props.workflow;
  const { start, busy, notice, ready, active } = useStartWorkflow(props);
  const human = humanStepCount(w, props.caps);

  const runView = active === undefined ? undefined : describeRun(active);

  return (
    <div className="card-main">
      <div className="row between">
        <h3>{workflowTitle(w)}</h3>
        {active !== undefined && runView !== undefined ? (
          <Badge tone={runView.tone}>{runView.label}</Badge>
        ) : (
          <Badge tone={ready.canStart ? 'success' : 'warning'}>
            {!w.executable
              ? 'Cannot run yet'
              : props.capsFailed && props.caps === undefined
                ? 'Unavailable'
                : ready.needApproval.length > 0
                  ? 'Needs approval'
                  : ready.canStart
                    ? 'Ready to start'
                    : 'Checking…'}
          </Badge>
        )}
      </div>

      <p className="muted small">
        {w.stepCount} {w.stepCount === 1 ? 'step' : 'steps'}
        {human !== undefined && human > 0 ? ` · ${human} ${human === 1 ? 'needs' : 'need'} a person to decide` : ''}
        {w.gapCount > 0 ? ` · XO flagged ${w.gapCount} ${w.gapCount === 1 ? 'uncertainty' : 'uncertainties'} about the order` : ''}
      </p>

      <ol className="flow" aria-label="Steps in this process">
        {w.steps.map((s, i) => {
          const person = props.caps?.find((c) => c.capabilityId === s.capabilityId)?.executionClass === 'human_in_the_loop';
          return (
            <li key={s.capabilityId} className="flow-step" data-who={person ? 'person' : 'xo'}>
              <span className="flow-dot" aria-hidden="true">
                {i + 1}
              </span>
              <div className="flow-body">
                <span className="step-name">{tidyName(s.name)}</span>
                {props.caps !== undefined ? (
                  <span className="flow-who">{person ? 'A person decides here' : 'XO carries this out'}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="row">
        <Button variant="quiet" onClick={() => props.onOpenGraph(w.workflowId)} aria-label={`View graph of ${workflowTitle(w)}`}>
          View graph
        </Button>
      </div>

      <details>
        <summary>What each step is based on</summary>
        <ul className="plain">
          {w.steps.map((s) => (
            <li key={s.capabilityId} className="small muted">
              <strong>{tidyName(s.name, 60)}</strong>
              {s.description.length > 0 ? ` — ${s.description}` : ''}
            </li>
          ))}
        </ul>
      </details>

      {active !== undefined && runView !== undefined ? (
        <div className="decision">
          <p>{runView.summary}</p>
          <div className="row">
            <Button
              variant="primary"
              onClick={active.status === 'waiting_for_human' || active.status === 'interrupted' ? props.goToTasks : props.goToActivity}
            >
              {active.status === 'waiting_for_human' || active.status === 'interrupted' ? 'Continue in Tasks' : 'See progress'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="row">
          <Button
            variant="primary"
            className="btn-lg"
            disabled={busy || !ready.canStart}
            onClick={start}
            aria-describedby={`why-${w.workflowId}`}
          >
            {busy ? 'Starting…' : 'Start this process'}
          </Button>
          {!ready.canStart && ready.needApproval.length > 0 ? (
            <Button variant="secondary" onClick={props.goToSetup}>
              Review rules in Sources
            </Button>
          ) : null}
        </div>
      )}

      {active === undefined && !ready.canStart && ready.reason !== undefined ? (
        <p id={`why-${w.workflowId}`} className="muted small">
          {props.capsFailed && props.caps === undefined
            ? 'XO could not check approvals just now, so this cannot be started. Use Try again above.'
            : ready.reason}
        </p>
      ) : null}
      {active === undefined && ready.needApproval.length > 0 ? (
        <ul className="plain small muted">
          {ready.needApproval.map((n) => (
            <li key={n}>Needs approval: {n}</li>
          ))}
        </ul>
      ) : null}

      <ActionNoticeView
        notice={notice}
        action={
          notice !== undefined && 'view' in notice && notice.view.kind === 'needs_approval' ? (
            <Button variant="secondary" onClick={props.goToSetup}>
              Review rules in Sources
            </Button>
          ) : undefined
        }
      />

      {mode === 'builder' ? (
        <details>
          <summary>Technical details</summary>
          <p className="mono small">
            {w.workflowId} · {w.status} · confidence {Math.round(w.confidence * 100)}%
          </p>
          {w.notExecutableReasons.length > 0 ? (
            <ul className="plain">
              {w.notExecutableReasons.slice(0, 20).map((r, i) => (
                <li key={i} className="mono small">
                  {r}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
