import { useMemo, useRef, useState } from 'react';
import {
  describeRun,
  describeStartProblem,
  findActiveRun,
  humanStepCount,
  newIdempotencyKey,
  startReadiness,
  tidyName,
  workflowTitle,
  type WorkProblemView,
} from '../domain/work';
import type { ApiProblem } from '../platform/client';
import type { Capability, Compilation, Workflow, WorkflowRun } from '../platform/wire';
import { Badge, Button, EmptyState, ProblemNotice, Section } from './primitives';
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
  runs: readonly WorkflowRun[];
  onChanged: () => void;
  goToSetup: () => void;
  goToTasks: () => void;
  goToActivity: () => void;
}) {
  const here = props.workflows.filter((w) => props.compilation !== undefined && w.compilationId === props.compilation.compilationId);

  return (
    <Section id="work-h" title="Work" lede="Processes XO found in your documents. Start one, or pick up where you left off.">
      {props.compilation === undefined ? (
        <EmptyState title="No processes yet">
          Add a document and let XO analyse it. Processes it can carry out will appear here.{' '}
          <Button variant="quiet" onClick={props.goToSetup}>
            Go to Setup
          </Button>
        </EmptyState>
      ) : here.length === 0 ? (
        <EmptyState title="XO did not find a process in this document">
          It found rules, but could not put them in a sequence. You can still review the individual rules in Setup.
        </EmptyState>
      ) : (
        <ul className="list">
          {here.map((w) => (
            <li key={w.workflowId} className="card">
              <WorkflowCard
                workspaceId={props.workspaceId}
                workflow={w}
                caps={props.caps}
                runs={props.runs}
                onChanged={props.onChanged}
                goToSetup={props.goToSetup}
                goToTasks={props.goToTasks}
                goToActivity={props.goToActivity}
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

type Notice = { readonly view: WorkProblemView } | { readonly info: string } | { readonly problem: ApiProblem };

function WorkflowCard(props: {
  workspaceId: string;
  workflow: Workflow;
  caps: readonly Capability[] | undefined;
  runs: readonly WorkflowRun[];
  onChanged: () => void;
  goToSetup: () => void;
  goToTasks: () => void;
  goToActivity: () => void;
}) {
  const { client, mode } = useSession();
  const w = props.workflow;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>();
  const inFlight = useRef(false);
  // One key per start INTENT. It is reused only to retry after an unclear failure, so the platform can hand back
  // the original run instead of creating a second; it is dropped as soon as the outcome is known.
  const intentKey = useRef<string | undefined>(undefined);

  const active = findActiveRun(props.runs, w.workflowId, w.compilationId);
  const ready = useMemo(() => startReadiness(w, props.caps), [w, props.caps]);
  const human = humanStepCount(w, props.caps);

  async function start() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      // Re-read the platform's runs right before starting; the list on screen may be stale.
      const before = await client.listWorkflowRuns(props.workspaceId);
      if (!before.ok) {
        setNotice({ problem: before.problem });
        return;
      }
      const existing = findActiveRun(before.value, w.workflowId, w.compilationId);
      if (existing !== undefined) {
        setNotice({ info: 'This process is already in progress, so a second one was not started. You can continue it instead.' });
        props.onChanged();
        return;
      }
      intentKey.current ??= newIdempotencyKey();
      const r = await client.startWorkflow(props.workspaceId, w.workflowId, w.compilationId, intentKey.current);
      if (r.ok) {
        intentKey.current = undefined;
        props.onChanged();
        if (r.value.status === 'waiting_for_human') props.goToTasks();
        else props.goToActivity();
        return;
      }
      const known = describeStartProblem(r.problem, w);
      if (known !== undefined) {
        intentKey.current = undefined; // a definite refusal: nothing was created, the next start is a new intent
        setNotice({ view: known });
        props.onChanged();
      } else if (r.problem.kind === 'network' || r.problem.kind === 'server' || r.problem.kind === 'malformed') {
        // The request may or may not have reached the platform. Ask it, rather than guessing or resending.
        const after = await client.listWorkflowRuns(props.workspaceId);
        const found = after.ok ? findActiveRun(after.value, w.workflowId, w.compilationId) : undefined;
        props.onChanged();
        setNotice({
          info: !after.ok
            ? 'XO did not confirm whether this started, and Studio could not check. Look in Activity before starting again.'
            : found !== undefined
              ? 'The process did start. XO\u2019s records show it in progress.'
              : 'XO did not confirm whether this started. Studio checked and found no run yet. You can try again: the retry carries the same request key, so XO will hand back the original run if the first attempt did arrive instead of creating a second.',
        });
      } else {
        setNotice({ problem: r.problem });
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

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

      <ol className="steps" aria-label="Steps in this process">
        {w.steps.map((s) => (
          <li key={s.capabilityId} className="step">
            <span className="step-name">{tidyName(s.name)}</span>
          </li>
        ))}
      </ol>

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
            disabled={busy || !ready.canStart}
            onClick={() => void start()}
            aria-describedby={`why-${w.workflowId}`}
          >
            {busy ? 'Starting…' : 'Start this process'}
          </Button>
          {!ready.canStart && ready.needApproval.length > 0 ? (
            <Button variant="secondary" onClick={props.goToSetup}>
              Review rules in Setup
            </Button>
          ) : null}
        </div>
      )}

      {active === undefined && !ready.canStart && ready.reason !== undefined ? (
        <p id={`why-${w.workflowId}`} className="muted small">
          {ready.reason}
        </p>
      ) : null}
      {active === undefined && ready.needApproval.length > 0 ? (
        <ul className="plain small muted">
          {ready.needApproval.map((n) => (
            <li key={n}>Needs approval: {n}</li>
          ))}
        </ul>
      ) : null}

      {notice !== undefined && 'view' in notice ? (
        <div className="notice notice-warning" role="alert">
          <strong>{notice.view.title}</strong>
          <p>{notice.view.body}</p>
          {notice.view.items.length > 0 ? (
            <ul className="plain">
              {notice.view.items.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          {notice.view.kind === 'needs_approval' ? (
            <Button variant="secondary" onClick={props.goToSetup}>
              Review rules in Setup
            </Button>
          ) : null}
        </div>
      ) : null}
      {notice !== undefined && 'info' in notice ? (
        <p className="notice notice-warning" role="alert">
          {notice.info}
        </p>
      ) : null}
      {notice !== undefined && 'problem' in notice ? <ProblemNotice problem={notice.problem} /> : null}

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
