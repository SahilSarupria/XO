import type { Progress } from '../domain/review';
import type { ReactNode } from 'react';
import { HomeCommandBar, type HomeChip } from './HomeCommandBar';
import type { DockProps } from './AskDock';
import { StatusPill, type Status } from './kit';
import { workflowBusy, runtimeRunBucket, runtimeRunWords, startReadiness, tidyName } from '../domain/work';
import type { Capability, Compilation, Workflow, WorkflowRun } from '../platform/wire';
import type { WorkspaceRunView } from '../platform/wire-workflows';
import { describeRun, pendingTasks, isActiveRun, recoverableRuns } from '../domain/work';
import { runTitle } from './RunCard';
import { startActions, unavailableActions, type StartFacts, type StartTarget } from '../domain/start';
import { Button, formatWhen, Skeleton } from './primitives';
import { StartWork } from './StartWork';

/**
 * The landing view (S1-3). In order: the ask box; the one next step (Start work); what needs a person now, by kind, each linking
 * to where it is dealt with; what is running now; the last five results. It shows only things the platform reports, and no
 * metric tiles: when there is nothing, it says so and what to do next.
 */
/** "Monday, 19 Oct · Good evening", from the computer's clock. The app does not know the person's name, so it does not use one. */
export function greeting(now: Date): string {
  const weekday = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const day = `${weekday}, ${date}`;
  const h = now.getHours();
  return `${day} · Good ${h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'}`;
}

export function HomeSection(props: {
  compilation: Compilation | undefined;
  workflows: readonly Workflow[];
  caps: readonly Capability[] | undefined;
  runs: readonly WorkflowRun[];
  /** S1-0 (F1): runs on the workflow runtime, newest first, across the workspace's workflows. */
  runtimeRuns?: readonly WorkspaceRunView[];
  analyses: readonly Compilation[];
  standalonePending: number;
  next: Progress;
  /** Runs/workflows failed to load: do not present an empty Home as "nothing to do". */
  incomplete: boolean;
  /** First load still in progress: nothing may be claimed (no first-run prompts, no "nothing to do"). */
  loading: boolean;
  workspaceName: string;
  sourceCount: number;
  /** Name of the most recently added document, for the quick action; undefined when there is none. */
  latestDocument?: string | undefined;
  analysisCount: number;
  readyForReview: number;
  goTo: (target: StartTarget) => void;
  /** The Ask XO bar's state, shared with every other screen. */
  dock: DockProps;
  /** Opens one run on the Executions screen. */
  onOpenRun: (run: WorkflowRun) => void;
  goToActivity: () => void;
}) {
  const goToTasks = () => props.goTo('tasks');
  const goToSetup = () => props.goTo('rules');
  const rt = props.runtimeRuns ?? [];
  const rtWaiting = rt.filter((r) => r.pendingApprovals > 0);
  const rtActive = rt.filter((r) => runtimeRunBucket(r) === 'running');
  const rtFailed = rt.filter((r) => runtimeRunBucket(r) === 'failed').slice(0, 3);
  const rtFinished = rt.filter((r) => runtimeRunBucket(r) === 'finished' || runtimeRunBucket(r) === 'failed');
  const waiting = pendingTasks(props.runs);
  const waitingCount = waiting.length + props.standalonePending + rtWaiting.reduce((n, r) => n + r.pendingApprovals, 0);
  const interrupted = recoverableRuns(props.runs);
  const inProgress = props.runs.filter((r) => isActiveRun(r) && r.status !== 'waiting_for_human' && r.status !== 'interrupted');
  const here = props.workflows.filter((w) => props.compilation !== undefined && w.compilationId === props.compilation.compilationId);
  // A workflow with a run under way, on either runner, is never "ready to start" (S1-3: Home said so while a run of it waited).
  const busy = (w: Workflow) => workflowBusy(w, props.runs, rt);
  const ready = here.filter((w) => startReadiness(w, props.caps).canStart && !busy(w));
  const blockedOnApproval = here.filter((w) => w.executable && startReadiness(w, props.caps).needApproval.length > 0 && !busy(w));
  // Finished work, newest first, straight from the platform's run records. A failure among the latest is surfaced, not buried.
  const recentLegacy = props.runs.filter((r) => !isActiveRun(r)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const recentFailed = recentLegacy.slice(0, 3).filter((r) => r.status === 'failed');
  const recent: RecentItem[] = [
    ...rtFinished.map((r): RecentItem => ({
      key: r.runId,
      title: tidyName(r.name, 70),
      status: runtimeRunBucket(r) === 'failed' ? 'failed' : r.cancelled === true || r.state === 'cancelled' ? 'cancelled' : 'done',
      words: runtimeRunWords(r),
      when: r.startedAt,
    })),
    ...recentLegacy.map((r): RecentItem => {
      const v = describeRun(r);
      return {
        key: r.workflowExecutionId,
        title: runTitle(r),
        status: r.status === 'failed' ? 'failed' : r.status === 'succeeded' ? 'done' : 'cancelled',
        words: v.label,
        when: r.updatedAt,
        run: r,
      };
    }),
  ]
    .sort((a, b) => b.when.localeCompare(a.when))
    .slice(0, 5);

  const facts: StartFacts = {
    sources: props.sourceCount,
    succeededCompilations: props.analysisCount,
    readyForReview: props.readyForReview,
    readyWorkflows: ready.length,
    waitingDecisions: waitingCount + interrupted.length,
    blockedWorkflows: blockedOnApproval.length,
    activeRuns: inProgress.length + rtActive.length,
    incomplete: props.incomplete,
  };

  const chips: HomeChip[] = [
    props.latestDocument !== undefined
      ? { label: `Analyse ${props.latestDocument}`, target: 'documents' }
      : { label: 'Add a document', target: 'documents' },
    ...(ready[0] !== undefined
      ? [{ label: `Run ${tidyName(ready[0].steps[0]?.name ?? ready[0].name, 32)}`, target: 'workflows' as const }]
      : []),
    { label: 'Describe a new workflow', target: 'create' },
    ...(here[0] !== undefined ? [{ label: 'Open last workflow', target: 'graph' as const }] : []),
  ];

  if (props.loading) {
    return (
      <section className="section" aria-labelledby="home-h">
        <h2 id="home-h" className="visually-hidden">
          Home
        </h2>
        <Skeleton label="Loading your workspace" />
      </section>
    );
  }

  const running = inProgress.length + rtActive.length;
  const needs = waitingCount + interrupted.length + recentFailed.length + rtFailed.length + blockedOnApproval.length;
  const empty = props.runs.length === 0 && rt.length === 0 && props.sourceCount === 0;

  return (
    <section className="section home" aria-labelledby="home-h">
      <h2 id="home-h" className="visually-hidden">
        Home
      </h2>
      <div className="home-top">
        <p className="home-greeting">{greeting(new Date())}</p>
        {!props.incomplete && running + waitingCount + interrupted.length > 0 ? (
          <p className="home-pills" aria-label="Right now">
            {running > 0 ? <StatusPill status="running" label={`${running} running`} /> : null}
            {waitingCount + interrupted.length > 0 ? (
              <StatusPill status="waiting" label={`${waitingCount + interrupted.length} awaiting review`} />
            ) : null}
          </p>
        ) : null}
      </div>
      <HomeCommandBar dock={props.dock} chips={chips} onChip={props.goTo} />
      {props.incomplete ? (
        <p className="notice notice-warning small" role="status">
          Part of this workspace&rsquo;s activity could not be loaded. Home may not show everything that needs you: use Retry above, or open
          Activity.
        </p>
      ) : null}
      <div className="home-grid">
        <div className="home-main">
          {!props.incomplete && empty ? <FirstRun /> : null}
          <StartWork
            actions={startActions(facts)}
            unavailable={unavailableActions(facts)}
            incomplete={props.incomplete}
            onChoose={props.goTo}
          />

          {props.incomplete ? null : (
            <section className="home-block" aria-labelledby="needs-h">
              <div className="home-block-head">
                <h3 id="needs-h">What needs you now</h3>
                {needs > 0 ? <span className="home-count">{needs}</span> : null}
              </div>
              {needs === 0 ? (
                <p className="muted small home-calm">Nothing needs you right now. XO will put anything that does in your Inbox.</p>
              ) : (
                <div className="home-needs">
                  {waitingCount > 0 ? (
                    <NeedCard title="Waiting for you" status="waiting" count={waitingCount}>
                      <ul className="plain">
                        {rtWaiting.slice(0, 3).map((r) => (
                          <li key={r.runId} className="small">
                            {tidyName(r.name, 70)} <span className="muted">· {runtimeRunWords(r)}</span>
                          </li>
                        ))}
                        {waiting.slice(0, Math.max(0, 3 - rtWaiting.length)).map((r) => (
                          <li key={r.workflowExecutionId} className="small">
                            {runTitle(r)} <span className="muted">· {describeRun(r).summary}</span>
                          </li>
                        ))}
                      </ul>
                      <Button variant="secondary" onClick={goToTasks}>
                        {waitingCount === 1 ? 'Review this decision' : `Review ${waitingCount} decisions`}
                      </Button>
                    </NeedCard>
                  ) : null}
                  {interrupted.length > 0 ? (
                    <NeedCard title="Stopped — can be continued" status="paused" count={interrupted.length}>
                      <ul className="plain">
                        {interrupted.slice(0, 3).map((r) => (
                          <li key={r.workflowExecutionId} className="small">
                            {runTitle(r)} <span className="muted">· {describeRun(r).summary}</span>
                          </li>
                        ))}
                      </ul>
                      <Button variant="secondary" onClick={goToTasks}>
                        Review in Inbox
                      </Button>
                    </NeedCard>
                  ) : null}
                  {recentFailed.length + rtFailed.length > 0 ? (
                    <NeedCard title="Did not complete" status="failed" count={recentFailed.length + rtFailed.length}>
                      <ul className="plain">
                        {rtFailed.map((r) => (
                          <li key={r.runId} className="small">
                            {tidyName(r.name, 70)} <span className="muted">· {runtimeRunWords(r)}</span>
                          </li>
                        ))}
                        {recentFailed.map((r) => (
                          <li key={r.workflowExecutionId} className="small">
                            {runTitle(r)} <span className="muted">· {describeRun(r).summary}</span>
                          </li>
                        ))}
                      </ul>
                      <Button variant="secondary" onClick={props.goToActivity}>
                        See what happened
                      </Button>
                    </NeedCard>
                  ) : null}
                  {blockedOnApproval.length > 0 ? (
                    <NeedCard title="Needs your approval first" status="attention" count={blockedOnApproval.length}>
                      <p className="muted small">
                        {blockedOnApproval.length === 1 ? 'A workflow has' : `${blockedOnApproval.length} workflows have`} steps XO will not
                        run until you approve them.
                      </p>
                      <Button variant="secondary" onClick={goToSetup}>
                        Review rules
                      </Button>
                    </NeedCard>
                  ) : null}
                </div>
              )}
            </section>
          )}

          {!props.incomplete && running > 0 ? (
            <section className="home-block" aria-labelledby="running-h">
              <div className="home-block-head">
                <h3 id="running-h">Running now</h3>
                <Button variant="quiet" onClick={props.goToActivity}>
                  See progress
                </Button>
              </div>
              <ul className="plain home-list">
                {rtActive.map((r) => (
                  <li key={r.runId}>
                    <span className="home-list-title">{tidyName(r.name, 70)}</span>
                    <StatusPill status="running" label={runtimeRunWords(r)} />
                  </li>
                ))}
                {inProgress.map((r) => (
                  <li key={r.workflowExecutionId}>
                    <button type="button" className="k-link home-list-title" onClick={() => props.onOpenRun(r)}>
                      {runTitle(r)}
                    </button>
                    <StatusPill status="running" label={describeRun(r).label} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {!props.incomplete && recent.length > 0 ? (
            <section className="home-block" aria-labelledby="recent-h">
              <div className="home-block-head">
                <h3 id="recent-h">Recent results</h3>
                <Button variant="quiet" onClick={props.goToActivity}>
                  See all history
                </Button>
              </div>
              <ul className="plain home-list">
                {recent.map((r) => (
                  <li key={r.key}>
                    {r.run !== undefined ? (
                      <button type="button" className="k-link home-list-title" onClick={() => props.onOpenRun(r.run!)}>
                        {r.title}
                      </button>
                    ) : (
                      <span className="home-list-title">{r.title}</span>
                    )}
                    <StatusPill status={r.status} label={r.words} />
                    <span className="muted small home-list-when">{formatWhen(r.when)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
        {props.next.step !== 'done' && !props.incomplete ? (
          <aside className="home-side" aria-label="Getting started">
            <GetStarted next={props.next} />
          </aside>
        ) : null}
      </div>
    </section>
  );
}

interface RecentItem {
  readonly key: string;
  readonly title: string;
  readonly status: 'done' | 'failed' | 'cancelled';
  readonly words: string;
  readonly when: string;
  readonly run?: WorkflowRun;
}

/** One kind of thing that needs a person, with its count in words and shape. */
function NeedCard(props: { title: string; status: Status; count: number; children: ReactNode }) {
  return (
    <div className="k-card home-need" data-status={props.status}>
      <div className="home-need-head">
        <h4>{props.title}</h4>
        <StatusPill status={props.status} label={String(props.count)} />
      </div>
      {props.children}
    </div>
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

/**
 * The empty workspace's welcome (S1-0, F3): what XO does, in one sentence, above the one real next step (Start work) and the four
 * steps below it. No template grid: a template appears only when a library entry exists for it, and nothing here names an industry.
 */
function FirstRun() {
  return (
    <section className="firstrun" aria-labelledby="firstrun-h">
      <h3 id="firstrun-h" className="hero-title">
        Start with how your team already works
      </h3>
      <p className="muted">
        Add a document that describes a piece of work, such as a procedure, a checklist or a policy. XO shows you the steps it found and who
        does each one, and a person approves anything that matters before it runs.
      </p>
    </section>
  );
}
