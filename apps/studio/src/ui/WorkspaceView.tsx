import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { nextStep, summarize } from '../domain/review';
import { recordedNotes, standaloneExecutions } from '../domain/work';
import type { Compilation, Workspace } from '../platform/wire';
import { ActivitySection } from './ActivitySection';
import { ContextSection } from './ContextSection';
import { HomeSection } from './HomeSection';
import { TasksSection } from './TasksSection';
import { WorkSection } from './WorkSection';
import { ProcessesSection } from './ProcessesSection';
import { ProblemNotice, Spinner, useLoad, loadedValue } from './primitives';
import { ReviewSection } from './ReviewSection';
import { useSession } from './session';
import { useSectionRoute, type Section } from './sectionRoute';
import { Icon, type IconName } from './icons';

type View = Section;
type SetupView = 'documents' | 'rules';

const GOAL_KEY = (ws: string) => `xo-studio:goal:${ws}`;

export function WorkspaceView(props: { workspace: Workspace; frame: (nav: ReactNode, content: ReactNode) => ReactNode }) {
  const { client, mode } = useSession();
  const ws = props.workspace.workspaceId;
  const [view, setView, replaceView] = useSectionRoute();
  const [setupView, setSetupView] = useState<SetupView>('documents');
  const [pickedCompilation, setPickedCompilation] = useState<string | undefined>();

  const sources = useLoad(() => client.listSources(ws), [client, ws]);
  const compilations = useLoad(() => client.listCompilations(ws), [client, ws]);
  const executions = useLoad(() => client.listExecutions(ws), [client, ws]);
  const workflows = useLoad(() => client.listWorkflows(ws), [client, ws]);
  const runs = useLoad(() => client.listWorkflowRuns(ws), [client, ws]);

  const succeeded: Compilation[] = useMemo(
    () =>
      compilations.state.phase === 'ready'
        ? compilations.state.value.filter((c) => c.status === 'succeeded').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [],
    [compilations.state],
  );
  const activeCompilation = succeeded.find((c) => c.compilationId === pickedCompilation) ?? succeeded[0];

  const caps = useLoad(
    () =>
      activeCompilation === undefined
        ? Promise.resolve({ ok: true as const, value: [] })
        : client.getCapabilities(ws, activeCompilation.compilationId),
    [client, ws, activeCompilation?.compilationId],
  );

  useEffect(() => {
    if (mode === 'user' && view === 'processes') replaceView('home');
  }, [mode, view, replaceView]);

  function refreshAll() {
    sources.reload();
    compilations.reload();
    executions.reload();
    workflows.reload();
    runs.reload();
    caps.reload();
  }

  // Render the fresh value, or the last good one after a failed refresh. A failure is never turned into "empty".
  const capList = loadedValue(caps.state);
  const summary = capList !== undefined ? summarize(capList) : undefined;
  const runList = loadedValue(runs.state) ?? [];
  const execList = loadedValue(executions.state) ?? [];
  const workflowList = loadedValue(workflows.state) ?? [];
  const step = nextStep({
    sources: loadedValue(sources.state)?.length ?? 0,
    succeededCompilations: succeeded.length,
    summary,
    executions: execList.length,
  });
  const notes = recordedNotes(execList);
  const standalonePending = standaloneExecutions(execList, runList).filter(
    (e) => e.status === 'waiting_for_human' && e.humanTask?.status === 'pending',
  ).length;
  const taskCount = runList.filter((r) => r.status === 'waiting_for_human' || r.status === 'interrupted').length + standalonePending;

  const firstError = [sources.state, compilations.state, workflows.state, runs.state, executions.state, caps.state].find(
    (s) => s.phase === 'error',
  );
  // Emptiness may only be claimed when the lists it depends on actually loaded.
  const decisionsUnknown = runs.state.phase === 'error' || executions.state.phase === 'error';
  const capsFailed = caps.state.phase === 'error' && caps.state.stale === undefined;

  const nav = (
    <nav className="nav" aria-label="Workspace sections">
      <NavItem current={view} id="home" icon="home" hint="What needs you today" onSelect={setView}>
        Home
      </NavItem>
      <NavItem current={view} id="work" icon="work" hint="Start a process" onSelect={setView}>
        Work
      </NavItem>
      <NavItem
        current={view}
        id="tasks"
        icon="tasks"
        hint="Decisions for you to make"
        onSelect={setView}
        count={taskCount}
        countLabel="need attention"
      >
        Tasks
      </NavItem>
      <NavItem current={view} id="activity" icon="activity" hint="What has happened" onSelect={setView}>
        Activity
      </NavItem>
      <NavItem
        current={view}
        id="setup"
        icon="setup"
        hint="Your documents and rules"
        onSelect={setView}
        count={summary?.readyForReview}
        countLabel="ready for review"
      >
        Setup
      </NavItem>
      {mode === 'builder' ? (
        <NavItem current={view} id="processes" icon="processes" hint="Technical view" onSelect={setView}>
          Processes
        </NavItem>
      ) : null}
    </nav>
  );

  const content = (
    <main className="page">
      <header className="page-head">
        <h1>{props.workspace.name ?? 'Untitled workspace'}</h1>
      </header>

      {firstError?.phase === 'error' ? (
        <>
          <ProblemNotice problem={firstError.problem} onRetry={refreshAll} />
          {firstError.stale !== undefined ? <p className="muted small">Showing what was loaded earlier.</p> : null}
        </>
      ) : null}

      {view === 'home' ? (
        <HomeSection
          compilation={activeCompilation}
          workflows={workflowList}
          caps={capList}
          runs={runList}
          standalonePending={standalonePending}
          next={step}
          incomplete={decisionsUnknown}
          goToWork={() => setView('work')}
          goToTasks={() => setView('tasks')}
          goToActivity={() => setView('activity')}
          goToSetup={() => setView('setup')}
        />
      ) : null}
      {view === 'work' ? (
        <WorkSection
          workspaceId={ws}
          compilation={activeCompilation}
          workflows={workflowList}
          caps={capList}
          capsFailed={capsFailed}
          runs={runList}
          onChanged={refreshAll}
          goToSetup={() => {
            setSetupView('rules');
            setView('setup');
          }}
          goToTasks={() => setView('tasks')}
          goToActivity={() => setView('activity')}
        />
      ) : null}
      {view === 'tasks' ? (
        <TasksSection
          workspaceId={ws}
          runs={runList}
          executions={execList}
          caps={capList ?? []}
          notes={notes}
          incomplete={decisionsUnknown}
          onChanged={refreshAll}
        />
      ) : null}
      {view === 'activity' ? (
        executions.state.phase === 'loading' ? (
          <Spinner label="Loading activity" />
        ) : executions.state.phase === 'error' && executions.state.stale === undefined ? null : (
          <ActivitySection
            workspaceId={ws}
            executions={execList}
            runs={runList}
            notes={notes}
            caps={capList ?? []}
            activeCompilationId={activeCompilation?.compilationId}
            onChanged={refreshAll}
          />
        )
      ) : null}
      {view === 'setup' ? (
        <>
          <GoalNote workspaceId={ws} />
          <div className="segmented" role="group" aria-label="Setup sections">
            <button type="button" className="tab" aria-pressed={setupView === 'documents'} onClick={() => setSetupView('documents')}>
              Documents
            </button>
            <button type="button" className="tab" aria-pressed={setupView === 'rules'} onClick={() => setSetupView('rules')}>
              Rules
              {summary !== undefined && summary.readyForReview > 0 ? (
                <span className="tab-count" aria-label={`${summary.readyForReview} ready for review`}>
                  {summary.readyForReview}
                </span>
              ) : null}
            </button>
          </div>
          {setupView === 'documents' ? (
            <ContextSection
              workspaceId={ws}
              sources={sources.state}
              compilations={compilations.state.phase === 'ready' ? compilations.state.value : []}
              onChanged={refreshAll}
              onAnalysed={(c) => {
                setPickedCompilation(c.compilationId);
                refreshAll();
                setSetupView('rules');
              }}
            />
          ) : (
            <ReviewSection
              workspaceId={ws}
              compilation={activeCompilation}
              compilations={succeeded}
              onPickCompilation={setPickedCompilation}
              caps={caps.state}
              executions={execList}
              onChanged={refreshAll}
              goToContext={() => setSetupView('documents')}
            />
          )}
        </>
      ) : null}
      {view === 'processes' && mode === 'builder' ? <ProcessesSection state={workflows.state} reload={workflows.reload} /> : null}
    </main>
  );
  return <>{props.frame(nav, content)}</>;
}

function NavItem(props: {
  current: View;
  id: View;
  icon: IconName;
  hint: string;
  onSelect: (v: View) => void;
  count?: number | undefined;
  countLabel?: string;
  children: string;
}) {
  const active = props.current === props.id;
  const counted = props.count !== undefined && props.count > 0;
  const label = counted ? `${props.children}, ${props.count} ${props.countLabel ?? ''}`.trim() : props.children;
  return (
    <button
      type="button"
      className="nav-item"
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      aria-describedby={`nav-hint-${props.id}`}
      onClick={() => props.onSelect(props.id)}
    >
      <Icon name={props.icon} />
      <span className="nav-text" aria-hidden="true">
        <span className="nav-label">{props.children}</span>
        <span id={`nav-hint-${props.id}`} className="nav-hint">
          {props.hint}
        </span>
      </span>
      {counted ? (
        <span className="nav-count" aria-hidden="true">
          {props.count}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The goal is a personal note. XO has no "goal" concept in the platform today, so this is
 * stored in this browser only and is NOT sent anywhere. It is labelled as such rather than
 * implying XO is using it.
 */
function GoalNote(props: { workspaceId: string }) {
  const [goal, setGoal] = useState(() => {
    try {
      return window.localStorage.getItem(GOAL_KEY(props.workspaceId)) ?? '';
    } catch {
      return '';
    }
  });
  function save(v: string) {
    setGoal(v);
    try {
      window.localStorage.setItem(GOAL_KEY(props.workspaceId), v);
    } catch {
      /* not saving a note is not an error */
    }
  }
  return (
    <div className="goal">
      <label htmlFor="goal">What are you trying to achieve?</label>
      <input
        id="goal"
        value={goal}
        onChange={(e) => save(e.target.value)}
        placeholder="e.g. Check every new request against our approval rules"
        maxLength={200}
        aria-describedby="goal-help"
      />
      <p id="goal-help" className="muted small">
        A note for you and your team. Saved in this browser only — XO does not receive it yet.
      </p>
    </div>
  );
}
