import type { Progress } from '../domain/review';
import { findActiveRun, startReadiness, tidyName } from '../domain/work';
import type { Capability, Compilation, Workflow, WorkflowRun } from '../platform/wire';
import { describeRun, pendingTasks, isActiveRun, recoverableRuns } from '../domain/work';
import { runTitle } from './RunCard';
import { startActions, type StartTarget } from '../domain/start';
import { Badge, Button, formatWhen, Section } from './primitives';
import { StartWork } from './StartWork';

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
  /** Runs/workflows failed to load: do not present an empty Home as "nothing to do". */
  incomplete: boolean;
  workspaceName: string;
  sourceCount: number;
  analysisCount: number;
  readyForReview: number;
  goTo: (target: StartTarget) => void;
  goToActivity: () => void;
}) {
  const goToTasks = () => props.goTo('tasks');
  const goToWork = () => props.goTo('workflows');
  const goToSetup = () => props.goTo('rules');
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
  // Finished work, newest first, straight from the platform's run records. A failure among the latest is surfaced, not buried.
  const recent = props.runs
    .filter((r) => !isActiveRun(r))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 3);
  const recentFailed = recent.filter((r) => r.status === 'failed');

  return (
    <Section id="home-h" title="Home" lede={`You are working in ${props.workspaceName}. Here is what needs you and what you can start.`}>
      <StartWork
        actions={startActions({
          sources: props.sourceCount,
          succeededCompilations: props.analysisCount,
          readyForReview: props.readyForReview,
          readyWorkflows: ready.length,
          waitingDecisions: waitingCount + interrupted.length,
          incomplete: props.incomplete,
        })}
        onChoose={props.goTo}
      />

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
              <Button variant="primary" onClick={goToTasks}>
                {waitingCount === 1 ? 'Review this decision' : `Review ${waitingCount} decisions`}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {recentFailed.length > 0 ? (
        <div className="card">
          <div className="card-main">
            <div className="row between">
              <h3>Did not complete</h3>
              <Badge tone="danger">{recentFailed.length}</Badge>
            </div>
            <ul className="plain">
              {recentFailed.map((r) => (
                <li key={r.workflowExecutionId} className="small">
                  {runTitle(r)} — <span className="muted">{describeRun(r).summary}</span>
                </li>
              ))}
            </ul>
            <div className="row">
              <Button variant="secondary" onClick={props.goToActivity}>
                See what happened
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
              <Button variant="primary" onClick={goToTasks}>
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
              <Button variant="secondary" onClick={goToWork}>
                Open Workflows
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
              <Button variant="secondary" onClick={goToSetup}>
                Review rules
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {recent.length > 0 ? (
        <section className="card" aria-labelledby="recent-h">
          <div className="card-main">
            <h3 id="recent-h">Recent work</h3>
            <ul className="plain">
              {recent.map((r) => {
                const v = describeRun(r);
                return (
                  <li key={r.workflowExecutionId} className="small">
                    {runTitle(r)} <Badge tone={v.tone}>{v.label}</Badge> <span className="muted">{formatWhen(r.updatedAt)}</span>
                  </li>
                );
              })}
            </ul>
            <div className="row">
              <Button variant="quiet" onClick={props.goToActivity}>
                See all history
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {props.next.step !== 'done' && !props.incomplete ? <GetStarted next={props.next} /> : null}
    </Section>
  );
}

const GS_STEPS: readonly { readonly key: Progress['step']; readonly title: string; readonly detail: string }[] = [
  { key: 'context', title: 'Add a document', detail: 'A procedure, guideline or rulebook your team already uses.' },
  { key: 'analyze', title: 'Let XO read it', detail: 'XO lists the rules it finds and shows where each one came from.' },
  { key: 'review', title: 'Check the rules', detail: 'You approve what is right. XO never acts on anything you have not approved.' },
  { key: 'run', title: 'Start a process', detail: 'Run it, and step in whenever a person needs to decide.' },
];

/**
 * First-run guide. The current step comes from what the platform actually holds (documents, analyses,
 * approvals, runs) via `nextStep`; nothing here is a stored "onboarding" flag or a made-up figure.
 */
function GetStarted(props: { next: Progress }) {
  const current = GS_STEPS.findIndex((x) => x.key === props.next.step);
  return (
    <section className="getstarted" aria-labelledby="gs-h">
      <div className="stack">
        <h3 id="gs-h">Get started in four steps</h3>
        <p className="muted small">
          XO turns the documents you already have into processes your team can follow, with a person always in charge.
        </p>
      </div>
      <ol>
        {GS_STEPS.map((x, i) => {
          const state = i < current ? 'done' : i === current ? 'current' : 'todo';
          return (
            <li key={x.key} className="gs-step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="gs-dot" aria-hidden="true">
                {state === 'done' ? '✓' : i + 1}
              </span>
              <div>
                <p className="gs-title">
                  {x.title}
                  {state === 'done' ? <span className="visually-hidden"> (done)</span> : null}
                </p>
                <p className="muted small">{x.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
