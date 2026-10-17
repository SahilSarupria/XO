import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { nextStep, summarize } from '../domain/review';
import type { StartTarget } from '../domain/start';
import { recordedNotes, standaloneExecutions } from '../domain/work';
import type { Compilation, Workspace } from '../platform/wire';
import { ActivitySection } from './ActivitySection';
import { ContextSection } from './ContextSection';
import { HomeSection } from './HomeSection';
import { TasksSection } from './TasksSection';
import { WorkSection } from './WorkSection';
import { ProcessesSection } from './ProcessesSection';
import { Breadcrumbs, ProblemNotice, Skeleton, SubNav, useLoad, loadedValue } from './primitives';
import { WorkspacesSection } from './WorkspacesSection';
import { ReviewSection } from './ReviewSection';
import { useSession } from './session';
import { useSectionRoute, type Section } from './sectionRoute';
import { Icon, type IconName } from './icons';

type View = Section;
type SetupView = 'documents' | 'rules';

const PAGE_LABEL: Record<View, string> = {
  home: 'Home',
  workspaces: 'Workspaces',
  work: 'Workflows',
  tasks: 'Runs & History',
  activity: 'Runs & History',
  setup: 'Sources',
  processes: 'Processes',
};

export function WorkspaceView(props: {
  workspace: Workspace;
  workspaces: readonly Workspace[];
  onSelectWorkspace: (workspaceId: string) => void;
  onNewWorkspace: () => void;
  frame: (nav: ReactNode, content: ReactNode) => ReactNode;
}) {
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

  /** Start work / Home shortcuts. They only select a screen; the API decides what is permitted there. */
  function goToTarget(target: StartTarget) {
    if (target === 'documents' || target === 'rules') {
      setSetupView(target);
      setView('setup');
    } else setView(target === 'workflows' ? 'work' : 'tasks');
  }

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

  const runsView = view === 'tasks' || view === 'activity';
  const nav = (
    <nav className="nav" aria-label="Workspace sections">
      <NavItem current={view} id="home" icon="home" hint="What needs you today" onSelect={setView}>
        Home
      </NavItem>
      <NavItem current={view} id="workspaces" icon="workspaces" hint="Switch or create" onSelect={setView}>
        Workspaces
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
        Sources
      </NavItem>
      <NavItem current={view} id="work" icon="work" hint="Start a process" onSelect={setView}>
        Workflows
      </NavItem>
      <NavItem
        current={runsView ? 'tasks' : view}
        id="tasks"
        icon="tasks"
        hint="Decisions and what has happened"
        onSelect={setView}
        count={taskCount}
        countLabel="need attention"
      >
        Runs &amp; History
      </NavItem>
      {mode === 'builder' ? (
        <NavItem current={view} id="processes" icon="processes" hint="Technical view" onSelect={setView}>
          Processes
        </NavItem>
      ) : null}
    </nav>
  );

  const runsTabs = (
    <SubNav
      label="Runs and history views"
      current={view}
      items={[
        { id: 'tasks', label: 'Tasks', count: taskCount, onSelect: () => setView('tasks') },
        { id: 'activity', label: 'Activity', onSelect: () => setView('activity') },
      ]}
    />
  );

  const content = (
    <main className="page">
      <header className="page-head">
        <Breadcrumbs
          items={[
            { label: 'Workspaces', onSelect: () => setView('workspaces') },
            ...(view === 'workspaces'
              ? [{ label: props.workspace.name ?? 'Untitled workspace' }]
              : [{ label: props.workspace.name ?? 'Untitled workspace', onSelect: () => setView('home') }, { label: PAGE_LABEL[view] }]),
          ]}
        />
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
          workspaceName={props.workspace.name ?? 'Untitled workspace'}
          sourceCount={loadedValue(sources.state)?.length ?? 0}
          analysisCount={succeeded.length}
          readyForReview={summary?.readyForReview ?? 0}
          goTo={goToTarget}
          goToActivity={() => setView('activity')}
        />
      ) : null}
      {view === 'workspaces' ? (
        <WorkspacesSection
          workspaces={props.workspaces}
          activeId={ws}
          onSelect={(id) => {
            props.onSelectWorkspace(id);
            setView('home');
          }}
          onNew={props.onNewWorkspace}
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
      {runsView ? runsTabs : null}
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
          <Skeleton label="Loading activity" />
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
          <SubNav
            label="Sources views"
            current={setupView}
            items={[
              { id: 'documents', label: 'Documents', onSelect: () => setSetupView('documents') },
              {
                id: 'rules',
                label: 'Rules',
                count: summary?.readyForReview,
                countLabel: 'ready for review',
                onSelect: () => setSetupView('rules'),
              },
            ]}
          />
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
