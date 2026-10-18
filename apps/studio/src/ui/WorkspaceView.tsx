import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { ContractsSection } from './ContractsSection';
import { PlatformSection } from './PlatformSection';
import { Badge, Breadcrumbs, Button, ProblemNotice, Skeleton, SubNav, useLoad, loadedValue } from './primitives';
import { WorkspacesSection } from './WorkspacesSection';
import { ReviewSection } from './ReviewSection';
import { useSession } from './session';
import { BUILDER_SECTIONS, isBuilderSection, useSectionRoute, type Section } from './sectionRoute';
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
  contracts: 'Contracts',
  platform: 'Platform',
};

export function WorkspaceView(props: {
  workspace: Workspace;
  workspaces: readonly Workspace[];
  onSelectWorkspace: (workspaceId: string) => void;
  onNewWorkspace: () => void;
  frame: (nav: ReactNode, content: ReactNode) => ReactNode;
}) {
  const { client, mode, setMode } = useSession();
  const ws = props.workspace.workspaceId;
  const [view, setView, replaceView] = useSectionRoute();
  const [setupView, setSetupView] = useState<SetupView>('documents');
  const [pickedCompilation, setPickedCompilation] = useState<string | undefined>();
  /** A Builder-only screen that was asked for in User mode: explained on Home instead of silently dropped. */
  const [blocked, setBlocked] = useState<Section | undefined>();
  const [focusedCapability, setFocusedCapability] = useState<string | undefined>();
  const previousMode = useRef(mode);

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

  // Mode is presentation. The workspace is never touched; only a screen that does not exist in the new mode is replaced.
  useEffect(() => {
    const was = previousMode.current;
    previousMode.current = mode;
    if (mode === 'builder') setBlocked(undefined);
    if (mode === 'user' && isBuilderSection(view)) {
      if (was === 'builder') replaceView(BUILDER_SECTIONS[view] ?? 'home');
      else {
        setBlocked(view);
        replaceView('home');
      }
    }
  }, [mode, view, replaceView]);
  useEffect(() => {
    if (blocked !== undefined && view !== 'home' && view !== blocked) setBlocked(undefined);
  }, [view, blocked]);

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
  const allStates = [sources.state, compilations.state, workflows.state, runs.state, executions.state, caps.state];
  // Home summarises all of them: until each has answered, nothing may be claimed; if one failed, Home says it is partial.
  const homeLoading = allStates.some((s) => s.phase === 'loading');
  const homeIncomplete = allStates.some((s) => s.phase === 'error');
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
        <div className="nav-group" role="group" aria-label="Builder tools">
          <p className="nav-group-label">Builder tools</p>
          <NavItem current={view} id="contracts" icon="contracts" hint="Rule inputs and sources" onSelect={setView}>
            Contracts
          </NavItem>
          <NavItem current={view} id="processes" icon="processes" hint="Steps and readiness" onSelect={setView}>
            Processes
          </NavItem>
          <NavItem current={view} id="platform" icon="platform" hint="Service and API" onSelect={setView}>
            Platform
          </NavItem>
        </div>
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
        <div className="row between page-head-top">
          <Breadcrumbs
            items={[
              { label: 'Workspaces', onSelect: () => setView('workspaces') },
              ...(view === 'workspaces'
                ? [{ label: props.workspace.name ?? 'Untitled workspace' }]
                : [
                    { label: props.workspace.name ?? 'Untitled workspace', onSelect: () => setView('home'), low: true },
                    { label: PAGE_LABEL[view] },
                  ]),
            ]}
          />
          <Badge tone={mode === 'builder' ? 'accent' : 'neutral'}>{mode === 'builder' ? 'Builder mode' : 'User mode'}</Badge>
        </div>
        <h1>{props.workspace.name ?? 'Untitled workspace'}</h1>
      </header>

      {firstError?.phase === 'error' ? (
        <>
          <ProblemNotice problem={firstError.problem} onRetry={refreshAll} />
          {firstError.stale !== undefined ? <p className="muted small">Showing what was loaded earlier.</p> : null}
        </>
      ) : null}

      {blocked !== undefined && mode === 'user' ? (
        <div className="notice notice-info" role="status">
          <p>
            {PAGE_LABEL[blocked]} is part of Builder mode, so you are on Home. Builder mode adds technical views; it does not change what
            you are allowed to do.
          </p>
          <div className="row">
            <Button
              variant="secondary"
              onClick={() => {
                const target = blocked;
                setMode('builder');
                setBlocked(undefined);
                replaceView(target);
              }}
            >
              Switch to Builder mode
            </Button>
            <Button variant="quiet" onClick={() => setBlocked(undefined)}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      {view === 'home' ? (
        <HomeSection
          compilation={activeCompilation}
          workflows={workflowList}
          caps={capList}
          runs={runList}
          standalonePending={standalonePending}
          next={step}
          incomplete={homeIncomplete}
          loading={homeLoading}
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
          onOpenActivity={() => setView('activity')}
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
            incomplete={decisionsUnknown}
            onOpenTasks={() => setView('tasks')}
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
          {mode === 'user' ? (
            <p className="muted small">
              Documents are what you gave XO. Rules are what XO worked out from them, shown with the evidence. Only you can approve a rule.
            </p>
          ) : null}
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
      {view === 'processes' && mode === 'builder' ? (
        <ProcessesSection
          state={workflows.state}
          reload={workflows.reload}
          onOpenContract={(id) => {
            setFocusedCapability(id);
            setView('contracts');
          }}
        />
      ) : null}
      {view === 'contracts' && mode === 'builder' ? (
        <ContractsSection
          caps={caps.state}
          workflows={workflowList}
          focus={focusedCapability}
          goToSources={() => goToTarget('rules')}
          goToProcesses={() => setView('processes')}
        />
      ) : null}
      {view === 'platform' && mode === 'builder' ? <PlatformSection /> : null}
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
