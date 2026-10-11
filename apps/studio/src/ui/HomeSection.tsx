import type { Progress } from '../domain/review';
import { findActiveRun, startReadiness, tidyName } from '../domain/work';
import type { Capability, Compilation, Workflow, WorkflowRun } from '../platform/wire';
import { describeRun, pendingTasks, isActiveRun, recoverableRuns } from '../domain/work';
import { runTitle } from './RunCard';
import { Badge, Button, Section } from './primitives';

/**
 * The landing view. It shows only things the platform reports: decisions waiting, processes under way,
 * processes ready to start. When there is none of that it says what to do next instead of showing
 * empty cards or placeholder numbers.
 */
export function HomeSection(props: {
  compilation: Compilation | undefined;
  workflows: readonly Workflow[];
  caps: readonly Capability[] | undefined;
  runs: readonly WorkflowRun[];
  standalonePending: number;
  next: Progress;
  goToWork: () => void;
  goToTasks: () => void;
  goToActivity: () => void;
  goToSetup: () => void;
}) {
  const waiting = pendingTasks(props.runs);
  const waitingCount = waiting.length + props.standalonePending;
  const interrupted = recoverableRuns(props.runs);
  const inProgress = props.runs.filter((r) => isActiveRun(r) && r.status !== 'waiting_for_human' && r.status !== 'interrupted');
  const here = props.workflows.filter((w) => props.compilation !== undefined && w.compilationId === props.compilation.compilationId);
  const ready = here.filter(
    (w) => startReadiness(w, props.caps).canStart && findActiveRun(props.runs, w.workflowId, w.compilationId) === undefined,
  );
  const blockedOnApproval = here.filter(
    (w) =>
      w.executable &&
      startReadiness(w, props.caps).needApproval.length > 0 &&
      findActiveRun(props.runs, w.workflowId, w.compilationId) === undefined,
  );
  const anything = waitingCount > 0 || interrupted.length > 0 || inProgress.length > 0 || ready.length > 0 || blockedOnApproval.length > 0;

  return (
    <Section id="home-h" title="Home" lede="What needs you, what is under way, and what you can start.">
      {waitingCount > 0 ? (
        <div className="card">
          <div className="card-main">
            <div className="row between">
              <h3>Waiting for you</h3>
              <Badge tone="warning">{waitingCount}</Badge>
            </div>
            <ul className="plain">
              {waiting.slice(0, 3).map((r) => (
                <li key={r.workflowExecutionId} className="small">
                  {runTitle(r)} — <span className="muted">{describeRun(r).summary}</span>
                </li>
              ))}
            </ul>
            <div className="row">
              <Button variant="primary" onClick={props.goToTasks}>
                {waitingCount === 1 ? 'Review this decision' : `Review ${waitingCount} decisions`}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {interrupted.length > 0 ? (
        <div className="card">
          <div className="card-main">
            <div className="row between">
              <h3>Stopped — can be continued</h3>
              <Badge tone="warning">{interrupted.length}</Badge>
            </div>
            <ul className="plain">
              {interrupted.slice(0, 3).map((r) => (
                <li key={r.workflowExecutionId} className="small">
                  {runTitle(r)} — <span className="muted">{describeRun(r).summary}</span>
                </li>
              ))}
            </ul>
            <div className="row">
              <Button variant="primary" onClick={props.goToTasks}>
                Review in Tasks
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {inProgress.length > 0 ? (
        <div className="card">
          <div className="card-main">
            <h3>In progress</h3>
            <ul className="plain">
              {inProgress.map((r) => (
                <li key={r.workflowExecutionId} className="small">
                  {runTitle(r)} — <span className="muted">{describeRun(r).label}</span>
                </li>
              ))}
            </ul>
            <div className="row">
              <Button variant="secondary" onClick={props.goToActivity}>
                See progress
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {ready.length > 0 ? (
        <div className="card">
          <div className="card-main">
            <h3>Ready to start</h3>
            <ul className="plain">
              {ready.slice(0, 3).map((w) => (
                <li key={w.workflowId} className="small">
                  {tidyName(w.steps[0]?.name ?? w.name, 70)}
                  <span className="muted">
                    {' '}
                    — {w.stepCount} {w.stepCount === 1 ? 'step' : 'steps'}
                  </span>
                </li>
              ))}
            </ul>
            <div className="row">
              <Button variant="secondary" onClick={props.goToWork}>
                Open Work
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {blockedOnApproval.length > 0 ? (
        <div className="card">
          <div className="card-main">
            <h3>Needs your approval first</h3>
            <p className="muted small">
              {blockedOnApproval.length} {blockedOnApproval.length === 1 ? 'process has' : 'processes have'} steps XO will not run until you
              approve them.
            </p>
            <div className="row">
              <Button variant="secondary" onClick={props.goToSetup}>
                Review rules
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {!anything ? (
        <div className="next-step" aria-live="polite">
          <span className="next-step-label">Next</span>
          <div>
            <strong>{props.next.headline}</strong>
            <span className="muted"> — {props.next.hint}</span>
          </div>
          <Button variant="primary" onClick={props.goToSetup}>
            Open Setup
          </Button>
        </div>
      ) : null}
    </Section>
  );
}
