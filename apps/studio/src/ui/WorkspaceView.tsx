import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { nextStep, summarize } from '../domain/review';
import type { StartTarget } from '../domain/start';
import { recordedNotes, standaloneExecutions } from '../domain/work';
import type { Compilation, Workspace } from '../platform/wire';
import { HomeSection } from './HomeSection';
import {
  ActivitySection,
  ConnectSection,
  WhatXoKnows,
  KnowledgeSection,
  ContextSection,
  TasksSection,
  WorkSection,
  ProcessesSection,
  ContractsSection,
  PlatformSection,
  WorkspacesSection,
  ReviewSection,
  XosSection,
  LibraryScreen,
  AuditScreen,
  ChatScreen,
  CreateXo,
  XoInspector,
  SettingsScreen,
  WorkflowEditor,
} from './screens';
import { preloadScreens } from './lazyScreen';
import { Badge, Button, EmptyState, formatWhen, ProblemNotice, Section as PageSection, Skeleton, SubNav, loadedValue } from './primitives';
import { useSession } from './session';
import { BUILDER_SECTIONS, isBuilderSection, useSectionRoute, workflowRouteOf, type Section } from './sectionRoute';
import { WorkflowPage } from './WorkflowPage';
import { Icon, type IconName } from './icons';
import { ErrorBoundary } from './ErrorBoundary';
import { useReporter } from './reporter';
import { useQuery, useQueryCache, wsKey } from '../platform/query';
import { StopBanner } from './StopBanner';
import { useInboxWatch } from './useInboxWatch';
import { PLACES, placeOf, viewsOf, type Place } from './places';
import { Tabs, tabPanelProps } from './kit';
import type { Tab as SettingsTab } from './SettingsScreen';
import { roleLabel } from '../domain/access';
import { useChat } from './useChat';
import { xoItems, type XoSubject } from '../domain/xo';
import { CommandPalette, isPaletteShortcut, type PaletteCommand } from './CommandPalette';
import { appliedTheme, useTheme } from './theme';
import { AskDock, type DockProps } from './AskDock';
import type { AskActions } from './AskTurns';
import { askPlaceholder, PLACE_SECTION } from '../domain/ask';
import type { AskPlace } from '../platform/wire-ask';
import { WorkspaceMenu } from './WorkspaceMenu';
import type { FrameLayout } from './AppChrome';

type View = Section;

const PLACE_ICON: Readonly<Record<Place, IconName>> = {
  home: 'home',
  inbox: 'inbox',
  work: 'work',
  sources: 'xos',
  knowledge: 'search',
  activity: 'activity',
  settings: 'settings',
};
type SetupView = 'xos' | 'documents' | 'rules';

const PAGE_LABEL: Record<View, string> = {
  home: 'Home',
  chat: 'Chat',
  workflow: 'Workflow',
  graph: 'Workflow',
  executions: 'Executions',
  create: 'Create XO',
  xo: 'XO',
  workspaces: 'Workspaces',
  work: 'Workflows',
  tasks: 'Inbox',
  activity: 'Activity',
  setup: 'My XOs',
  processes: 'Processes',
  contracts: 'Contracts',
  platform: 'Platform',
  library: 'Library',
  connect: 'Connect',
  knowledge: 'Knowledge',
  whatxoknows: 'What XO knows',
  audit: 'Audit log',
  settings: 'Settings',
};

export function WorkspaceView(props: {
  workspace: Workspace;
  workspaces: readonly Workspace[];
  onSelectWorkspace: (workspaceId: string) => void;
  onNewWorkspace: () => void;
  frame: (parts: {
    nav: ReactNode;
    rail: ReactNode;
    content: ReactNode;
    layout: FrameLayout;
    bottomBar?: (more: { open: boolean; toggle: () => void }) => ReactNode;
  }) => ReactNode;
}) {
  const { client, mode, setMode, signOut } = useSession();
  const ws = props.workspace.workspaceId;
  const [view, setView, replaceView, openWorkflow] = useSectionRoute(ws);
  const [setupView, setSetupView] = useState<SetupView>('documents');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('General');
  const [pickedCompilation, setPickedCompilation] = useState<string | undefined>();
  /** A Builder-only screen that was asked for in User mode: explained on Home instead of silently dropped. */
  const [blocked, setBlocked] = useState<Section | undefined>();
  const [focusedCapability, setFocusedCapability] = useState<string | undefined>();
  const previousMode = useRef(mode);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | undefined>();
  const [wfSettings, setWfSettings] = useState(false);
  const [xoSubject, setXoSubject] = useState<XoSubject | undefined>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const askFocus = () => {
    setDrawerOpen(true);
    setFocusTick((n) => n + 1);
  };
  const [theme, setThemeChoice] = useTheme();
  const reporter = useReporter();
  // S1-3: the other places' chunks load when the browser is idle after the first screen, so moving between places does not wait.
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const run = () => void preloadScreens().catch(() => undefined);
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(run);
    else setTimeout(run, 1500);
  }, []);
  const queries = useQueryCache();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteShortcut(e)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key.toLowerCase() === 'j' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setDrawerOpen((o) => !o);
        setFocusTick((n) => n + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [selectedRun, setSelectedRun] = useState<string | undefined>();

  // S1-3: every read goes through the session's cache (platform/query.ts), keyed under `ws/<id>/`, so screens that show the same
  // thing share one request and one answer, and a change anywhere refreshes them all (refreshAll invalidates the prefix).
  const sources = useQuery(wsKey(ws, 'sources'), () => client.listSources(ws));
  const compilations = useQuery(wsKey(ws, 'compilations'), () => client.listCompilations(ws));
  const executions = useQuery(wsKey(ws, 'executions'), () => client.listExecutions(ws));
  const workflows = useQuery(wsKey(ws, 'workflows'), () => client.listWorkflows(ws));
  const runs = useQuery(wsKey(ws, 'runs'), () => client.listWorkflowRuns(ws));
  // S1-0 (F1): runs on the workflow runtime, across workflows, for Home and Activity; and what waits for a person there, for the
  // Inbox count. Optional reads: a failure leaves them out and Home says it is partial.
  const runtimeRuns = useQuery(wsKey(ws, 'runtime-runs?limit=50'), () => client.listWorkspaceRuns(ws, { limit: 50 }));
  const controlInbox = useQuery(wsKey(ws, 'control-inbox'), () => client.controlInbox(ws));
  // Mode, triggers, limit, sign-off and the workspace pause. Optional: a platform that does not report them, or a failed read, leaves the page as it was.
  const controls = useQuery(wsKey(ws, 'controls'), () => client.getWorkflowControls(ws));
  const entities = useQuery(wsKey(ws, 'workflow-entities'), () => client.listWorkflowEntities(ws, { limit: 50 }));
  // One long request per workspace watches the inbox; a change refreshes every screen showing it (paused while the tab is hidden).
  useInboxWatch(ws, loadedValue(controlInbox.state)?.etag);

  const succeeded: Compilation[] = useMemo(
    () =>
      compilations.state.phase === 'ready'
        ? compilations.state.value.filter((c) => c.status === 'succeeded').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [],
    [compilations.state],
  );
  const activeCompilation = succeeded.find((c) => c.compilationId === pickedCompilation) ?? succeeded[0];

  const caps = useQuery(wsKey(ws, `capabilities/${activeCompilation?.compilationId ?? 'none'}`), () =>
    activeCompilation === undefined
      ? Promise.resolve({ ok: true as const, value: [] })
      : client.getCapabilities(ws, activeCompilation.compilationId),
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

  // Run history is what the Executions screen is for, so opening it re-reads the platform's records. A failed refresh keeps
  // the last good list (see platform/query.ts), so the screen never goes blank.
  useEffect(() => {
    if (view !== 'executions') return;
    runs.reload();
    executions.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on arrival at the screen only
  }, [view]);

  /** Start work / Home shortcuts. They only select a screen; the API decides what is permitted there. */
  function goToTarget(target: StartTarget) {
    if (target === 'documents' || target === 'rules') {
      setSetupView(target);
      setView('setup');
    } else if (target === 'graph' || target === 'executions' || target === 'create') setView(target);
    else setView(target === 'workflows' ? 'work' : 'tasks');
  }

  function openModelSettings() {
    setDrawerOpen(false);
    setSettingsTab('Models and runtime');
    setView('settings');
  }
  const latestDocument = [...(loadedValue(sources.state) ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    ?.originalFilename;
  const xoList = xoItems(succeeded, loadedValue(sources.state) ?? []);

  /** After any change: everything this workspace shows is read again, on every screen at once. */
  function refreshAll() {
    if (queries !== undefined) queries.invalidate(wsKey(ws, ''));
    else [sources, compilations, executions, workflows, runs, runtimeRuns, controlInbox, caps, controls].forEach((q) => q.reload());
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
  const runtimeRunList = loadedValue(runtimeRuns.state)?.runs ?? [];
  const control = loadedValue(controlInbox.state);
  const runtimeWaiting =
    control === undefined
      ? 0
      : control.batches.length +
        control.steps.length +
        control.attention.length +
        control.standing.proposals.filter((p) => !p.preparedByYou).length;
  const taskCount =
    runList.filter((r) => r.status === 'waiting_for_human' || r.status === 'interrupted').length + standalonePending + runtimeWaiting;

  const firstError = [sources.state, compilations.state, workflows.state, runs.state, executions.state, caps.state].find(
    (s) => s.phase === 'error',
  );
  // Emptiness may only be claimed when the lists it depends on actually loaded.
  const decisionsUnknown = runs.state.phase === 'error' || executions.state.phase === 'error';
  const allStates = [sources.state, compilations.state, workflows.state, runs.state, executions.state, caps.state, runtimeRuns.state];
  // Home summarises all of them: until each has answered, nothing may be claimed; if one failed, Home says it is partial.
  const homeLoading = allStates.some((s) => s.phase === 'loading');
  const homeIncomplete = allStates.some((s) => s.phase === 'error');
  const capsFailed = caps.state.phase === 'error' && caps.state.stale === undefined;

  // S1-3: seven places; Builder mode adds views inside them (tabs), never places.
  const place = placeOf(view);
  const placeTabs = viewsOf(place, mode);
  const countFor = (p: Place): { count?: number; countLabel?: string } =>
    p === 'inbox'
      ? { count: taskCount, countLabel: 'need attention' }
      : p === 'sources'
        ? { count: summary?.readyForReview, countLabel: 'ready for review' }
        : {};
  const nav = (
    <nav className="nav" aria-label="Workspace sections">
      {PLACES.map((p) => (
        <NavItem
          key={p.id}
          current={place.id}
          id={p.id}
          icon={PLACE_ICON[p.id]}
          hint={p.hint}
          onSelect={() => setView(p.views[0]!.section)}
          {...countFor(p.id)}
        >
          {p.label}
        </NavItem>
      ))}
      <div className="nav-spacer" />
      <WorkspaceMenu
        name={props.workspace.name ?? 'Untitled workspace'}
        workspaces={props.workspaces.map((w) => ({
          id: w.workspaceId,
          name: w.name ?? 'Untitled workspace',
          ...(w.role !== undefined ? { role: roleLabel(w.role) } : {}),
        }))}
        activeId={ws}
        mode={mode}
        settingsCurrent={view === 'settings'}
        onSelectWorkspace={(id) => {
          props.onSelectWorkspace(id);
          setView('home');
        }}
        onManage={() => setView('workspaces')}
        onNew={props.onNewWorkspace}
        onSettings={() => setView('settings')}
        onMode={setMode}
        onSignOut={signOut}
      />
    </nav>
  );

  // S1-3: on a phone, the four places used most, and More for the rest (the drawer, with Sources, Knowledge, Settings and the
  // workspace menu). Counts come with words, as in the sidebar.
  const BOTTOM: readonly Place[] = ['home', 'inbox', 'work', 'activity'];
  const bottomBar = (more: { open: boolean; toggle: () => void }) => (
    <nav className="bottom-bar" aria-label="Main places">
      {BOTTOM.map((id) => {
        const p = PLACES.find((x) => x.id === id)!;
        const c = countFor(id);
        return (
          <button
            key={id}
            type="button"
            className="bottom-item"
            aria-current={place.id === id && !more.open ? 'page' : undefined}
            onClick={() => setView(p.views[0]!.section)}
          >
            <Icon name={PLACE_ICON[id]} />
            <span className="bottom-label">{p.label}</span>
            {c.count !== undefined && c.count > 0 ? (
              <span className="bottom-count">
                {c.count}
                <span className="visually-hidden"> {c.countLabel}</span>
              </span>
            ) : null}
          </button>
        );
      })}
      <button
        type="button"
        className="bottom-item"
        aria-expanded={more.open}
        aria-controls="sidebar"
        aria-current={!more.open && !BOTTOM.includes(place.id) ? 'page' : undefined}
        onClick={more.toggle}
      >
        <Icon name="menu" />
        <span className="bottom-label">More</span>
      </button>
    </nav>
  );

  const rail = (
    <>
      <RailButton current={place.id === 'home'} label="Home" icon="home" onSelect={() => setView('home')} />
      <RailButton current={place.id === 'work'} label="Work" icon="work" onSelect={() => setView('work')} />
      <RailButton current={place.id === 'sources'} label="Sources" icon="xos" onSelect={() => setView('setup')} />
    </>
  );

  // S1-3b: the Ask box knows where the person is, so "this workflow" means the one on screen.
  const onWorkflowPage = view === 'graph' || view === 'executions';
  const askedWorkflow = onWorkflowPage ? workflowList.find((w) => w.workflowId === selectedWorkflow) : undefined;
  const chat = useChat(
    ws,
    view === 'chat' || drawerOpen,
    {
      place: place.id,
      ...(askedWorkflow !== undefined ? { workflowId: askedWorkflow.workflowId } : {}),
      ...(view === 'executions' && selectedRun !== undefined ? { runId: selectedRun } : {}),
    },
    (answer) => {
      if (answer.kind === 'analyse') refreshAll();
    },
  );
  const askActions: AskActions = {
    onGo: (target) => {
      setDrawerOpen(false);
      if (target.workflowId !== undefined) {
        setSelectedWorkflow(target.workflowId);
        if (target.runId !== undefined) setSelectedRun(target.runId);
        setView(target.runId !== undefined ? 'executions' : 'graph');
      } else setView(PLACE_SECTION[target.place as AskPlace] ?? 'home');
    },
    onCreateWorkflow: async (goal, compilationId) => {
      const made = await client.createWorkflowFromGoal(ws, { goal, compilationId });
      if (!made.ok || made.value === null) return false;
      refreshAll();
      setSelectedWorkflow(made.value.workflowId);
      setDrawerOpen(false);
      setView('graph');
      return true;
    },
  };

  const dock: DockProps = {
    placeholder: askPlaceholder(place.id, askedWorkflow?.name),
    actions: askActions,
    open: drawerOpen && view !== 'chat',
    onOpenChange: setDrawerOpen,
    focusTick,
    chat,
    xos: chat.attachable,
    onOpenSettings: openModelSettings,
  };

  // One line on every screen when something is stopped (S1-8). Wraps every frame so no screen can miss it.
  const stoppedNames = new Map((loadedValue(entities.state)?.workflows ?? []).map((w) => [w.workflowId, w.name] as const));
  const frame: typeof props.frame = (parts) =>
    props.frame({
      ...parts,
      content: (
        <>
          <StopBanner
            workspaceId={ws}
            names={stoppedNames}
            onOpen={() => {
              setSettingsTab('Operations');
              setView('settings');
            }}
          />
          {parts.content}
        </>
      ),
    });

  if (view === 'graph' || view === 'executions') {
    const wf =
      workflowList.find((w) => w.workflowId === selectedWorkflow) ??
      workflowList.find((w) => w.compilationId === activeCompilation?.compilationId) ??
      workflowList[0];
    return (
      <>
        {frame({
          nav,
          rail,
          layout: 'bare',
          content: (
            <main className="immersive">
              <Suspense fallback={<Skeleton label="Loading" />}>
                {wf === undefined ? (
                  <div className="page narrow">
                    {workflows.state.phase === 'loading' ? (
                      <Skeleton label="Loading workflows" />
                    ) : (
                      <EmptyState title="No workflow to show yet">
                        Add a document and let XO analyse it. The processes it finds can be opened here.
                      </EmptyState>
                    )}
                    <div className="row">
                      <Button variant="secondary" onClick={() => setView('work')}>
                        Back to Workflows
                      </Button>
                    </div>
                  </div>
                ) : (
                  <WorkflowEditor
                    key={wf.workflowId}
                    workspaceId={ws}
                    role={props.workspace.role}
                    workflows={workflowList}
                    workflow={wf}
                    onSelectWorkflow={setSelectedWorkflow}
                    caps={capList}
                    executions={execList}
                    runs={runList}
                    xos={xoList}
                    tab={view === 'executions' ? 'executions' : wfSettings ? 'settings' : 'editor'}
                    initialRunId={selectedRun}
                    onTab={(t) => {
                      if (t === 'executions') setView('executions');
                      else {
                        setWfSettings(t === 'settings');
                        setView('graph');
                      }
                    }}
                    onBack={() => setView('work')}
                    onChanged={refreshAll}
                    goToTasks={() => setView('tasks')}
                    goToActivity={() => setView('activity')}
                  />
                )}
              </Suspense>
            </main>
          ),
        })}
        <AskDock variant="floating" {...dock} />
        {drawerOpen ? null : (
          <button type="button" className="askdock-launch" aria-label="Ask XO" onClick={askFocus}>
            Ask XO <kbd className="cmdbar-kbd">⌘J</kbd>
          </button>
        )}
      </>
    );
  }

  if (view === 'chat') {
    return (
      <>
        {frame({
          nav,
          rail,
          layout: 'rail',
          content: (
            <main className="immersive">
              <Suspense fallback={<Skeleton label="Loading" />}>
                <ChatScreen chat={chat} xos={chat.attachable} onOpenSettings={openModelSettings} />
              </Suspense>
            </main>
          ),
        })}
      </>
    );
  }

  const content = (
    <main className="page">
      <header className="page-head">
        {/* S1-3: the page is named for the place; the workspace's name is on the sidebar card. */}
        <h1>{place.label}</h1>
        {view === 'home' ? null : <AskDock variant="bar" {...dock} />}
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

      {placeTabs.length > 0 ? (
        <Tabs
          label={place.label}
          idBase="place"
          items={placeTabs.map((v) => ({ id: v.section, label: v.label }))}
          current={placeTabs.some((v) => v.section === view) ? view : placeTabs[0]!.section}
          onSelect={(id) => setView(id as Section)}
        />
      ) : null}
      <div
        className="place-panel"
        {...(placeTabs.length > 0 ? tabPanelProps('place', placeTabs.some((v) => v.section === view) ? view : placeTabs[0]!.section) : {})}
      >
        <ErrorBoundary resetKey={view} onError={(e, c) => reporter?.report('render', e, c)} onHome={() => setView('home')}>
          <Suspense fallback={<Skeleton label="Loading" />}>
            {view === 'home' ? (
              <HomeSection
                compilation={activeCompilation}
                workflows={workflowList}
                caps={capList}
                runs={runList}
                runtimeRuns={runtimeRunList}
                analyses={succeeded}
                standalonePending={standalonePending}
                next={step}
                incomplete={homeIncomplete}
                loading={homeLoading}
                workspaceName={props.workspace.name ?? 'Untitled workspace'}
                sourceCount={loadedValue(sources.state)?.length ?? 0}
                latestDocument={latestDocument}
                analysisCount={succeeded.length}
                readyForReview={summary?.readyForReview ?? 0}
                goTo={goToTarget}
                dock={dock}
                onOpenRun={(r) => {
                  setSelectedWorkflow(r.workflowId);
                  setSelectedRun(r.workflowExecutionId);
                  setView('executions');
                }}
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
            {view === 'workflow' && workflowRouteOf(window.location.pathname) !== undefined ? (
              <WorkflowPage
                key={workflowRouteOf(window.location.pathname)!.workflowId}
                workspaceId={ws}
                workflowId={workflowRouteOf(window.location.pathname)!.workflowId}
                tab={workflowRouteOf(window.location.pathname)!.tab}
                onTab={(t) => openWorkflow(workflowRouteOf(window.location.pathname)!.workflowId, t)}
                role={props.workspace.role}
                caps={capList}
                onBack={() => setView('work')}
                onChanged={refreshAll}
                goToInbox={() => setView('tasks')}
                goToActivity={() => setView('activity')}
                goToSources={() => setView('setup')}
              />
            ) : null}
            {view === 'work' ? (
              <WorkSection
                entities={loadedValue(entities.state)?.workflows}
                onOpenWorkflowPage={(id) => openWorkflow(id)}
                workspaceId={ws}
                compilation={activeCompilation}
                workflows={workflowList}
                caps={capList}
                capsFailed={capsFailed}
                runs={runList}
                runtimeRuns={runtimeRunList}
                controls={loadedValue(controls.state)}
                role={props.workspace.role}
                onChanged={refreshAll}
                goToSetup={() => {
                  setSetupView('rules');
                  setView('setup');
                }}
                goToTasks={() => setView('tasks')}
                goToActivity={() => setView('activity')}
                onOpenGraph={(id) => {
                  setSelectedWorkflow(id);
                  setWfSettings(false);
                  setView('graph');
                }}
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
                role={props.workspace.role}
                onOpenActivity={() => setView('activity')}
                onChanged={refreshAll}
              />
            ) : null}
            {view === 'connect' ? (
              <ConnectSection workspaceId={ws} {...(props.workspace.role !== undefined ? { role: props.workspace.role } : {})} />
            ) : null}
            {view === 'knowledge' ? <KnowledgeSection /> : null}
            {view === 'whatxoknows' ? (
              <WhatXoKnows workspaceId={ws} {...(props.workspace.role !== undefined ? { role: props.workspace.role } : {})} />
            ) : null}
            {view === 'activity' ? (
              executions.state.phase === 'loading' ? (
                <Skeleton label="Loading activity" />
              ) : executions.state.phase === 'error' && executions.state.stale === undefined ? null : (
                <ActivitySection
                  workspaceId={ws}
                  role={props.workspace.role}
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
                    { id: 'xos', label: 'XOs', onSelect: () => setSetupView('xos') },
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
                    Documents are what you gave XO. Rules are what XO worked out from them, shown with the evidence. Only you can approve a
                    rule.
                  </p>
                ) : null}
                {setupView === 'xos' ? (
                  <PageSection
                    id="xos-list-h"
                    title="My XOs"
                    lede="XOs built from your documents."
                    actions={
                      <Button variant="primary" onClick={() => setView('create')}>
                        + Create XO
                      </Button>
                    }
                  >
                    {xoList.length === 0 ? (
                      <EmptyState title="No XOs yet">Analyse a document to make your first XO.</EmptyState>
                    ) : (
                      <ul className="list">
                        {xoList.map((x) => (
                          <li key={x.id} className="card">
                            <div className="card-main">
                              <h3>{x.label}</h3>
                              <p className="muted small">Analysed {formatWhen(x.at)}</p>
                            </div>
                            <div className="card-actions">
                              <Button
                                variant="secondary"
                                aria-label={`Open ${x.label}`}
                                onClick={() => {
                                  setXoSubject({ kind: 'analysis', id: x.id });
                                  setView('xo');
                                }}
                              >
                                Open
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </PageSection>
                ) : setupView === 'documents' ? (
                  <ContextSection
                    workspaceId={ws}
                    role={props.workspace.role}
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
                workspaceId={ws}
                compilationId={activeCompilation?.compilationId}
                role={props.workspace.role}
                onChanged={refreshAll}
                workflows={workflowList}
                focus={focusedCapability}
                goToSources={() => goToTarget('rules')}
                goToProcesses={() => setView('processes')}
              />
            ) : null}
            {view === 'create' ? (
              <CreateXo
                workspaceId={ws}
                role={props.workspace.role}
                sources={sources.state}
                compilations={succeeded}
                onChanged={refreshAll}
                goTo={goToTarget}
                onTestInChat={askFocus}
                onOpenXo={(id) => {
                  setXoSubject({ kind: 'analysis', id });
                  setView('xo');
                }}
              />
            ) : null}
            {view === 'xo' ? (
              xoSubject === undefined ? (
                <EmptyState title="No XO selected">
                  <Button variant="secondary" onClick={() => setView('setup')}>
                    Back to My XOs
                  </Button>
                </EmptyState>
              ) : (
                <XoInspector
                  workspaceId={ws}
                  subject={xoSubject}
                  compilations={succeeded}
                  sources={loadedValue(sources.state) ?? []}
                  onBack={() => {
                    setSetupView('xos');
                    setView('setup');
                  }}
                  goTo={goToTarget}
                />
              )
            ) : null}
            {view === 'library' ? (
              <LibraryScreen
                workspace={props.workspace}
                goTo={goToTarget}
                onOpenPackage={(id) => {
                  setXoSubject({ kind: 'package', id });
                  setView('xo');
                }}
                mine={xoList}
                onOpenMine={(id) => {
                  setXoSubject({ kind: 'analysis', id });
                  setView('xo');
                }}
              />
            ) : null}
            {view === 'audit' ? (
              <AuditScreen
                workspace={props.workspace}
                onManageMembers={() => {
                  setSettingsTab('Members');
                  setView('settings');
                }}
              />
            ) : null}
            {view === 'settings' ? <SettingsScreen key={settingsTab} workspace={props.workspace} initialTab={settingsTab} /> : null}
            {view === 'platform' && mode === 'builder' ? (
              <>
                <XosSection
                  analyses={succeeded}
                  sourceCount={loadedValue(sources.state)?.length ?? 0}
                  summary={summary}
                  next={step}
                  goTo={goToTarget}
                />
                <PlatformSection />
              </>
            ) : null}
          </Suspense>
        </ErrorBoundary>
      </div>
    </main>
  );
  const commands: PaletteCommand[] = [
    { id: 'home', label: 'Go to Home', run: () => setView('home') },
    { id: 'ask', label: 'Ask XO', hint: '⌘J', run: askFocus },
    { id: 'chat', label: 'Open full chat', run: () => setView('chat') },
    { id: 'work', label: 'Go to Workflows', run: () => setView('work') },
    { id: 'setup', label: 'Go to Sources', run: () => setView('setup') },
    { id: 'knowledge', label: 'Go to Knowledge', run: () => setView('whatxoknows') },
    { id: 'create', label: 'Create XO', run: () => setView('create') },
    { id: 'tasks', label: 'Go to Inbox', run: () => setView('tasks') },
    { id: 'executions', label: 'Go to Executions', run: () => setView('executions') },
    { id: 'library', label: 'Go to Library', run: () => setView('library') },
    { id: 'activity', label: 'Go to Activity', run: () => setView('activity') },
    { id: 'audit', label: 'Go to Audit log', hint: 'Preview', run: () => setView('audit') },
    { id: 'settings', label: 'Go to Settings', run: () => setView('settings') },
    {
      id: 'theme',
      label: appliedTheme(theme) === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      run: () => setThemeChoice(appliedTheme(theme) === 'dark' ? 'light' : 'dark'),
    },
  ];
  return (
    <>
      {frame({ nav, rail, content, layout: 'standard', bottomBar })}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </>
  );
}

function NavItem(props: {
  current: Place;
  id: Place;
  icon: IconName;
  hint: string;
  onSelect: () => void;
  count?: number | undefined;
  countLabel?: string;
  children: string;
}) {
  const active = props.current === props.id;
  const counted = props.count !== undefined && props.count > 0;
  // The name is the visible label, then the count in words (WCAG 2.5.3: the visible text is part of the name); the hint is the description.
  return (
    <button
      type="button"
      className="nav-item"
      aria-current={active ? 'page' : undefined}
      aria-describedby={`nav-hint-${props.id}`}
      onClick={props.onSelect}
    >
      <Icon name={props.icon} />
      <span className="nav-text">
        <span className="nav-label">{props.children}</span>
        <span id={`nav-hint-${props.id}`} className="nav-hint" aria-hidden="true">
          {props.hint}
        </span>
      </span>
      {counted ? (
        <span className="nav-count">
          {props.count}
          <span className="visually-hidden"> {props.countLabel ?? 'need attention'}</span>
        </span>
      ) : null}
    </button>
  );
}

function RailButton(props: { current: boolean; label: string; icon: IconName; onSelect: () => void }) {
  return (
    <button
      type="button"
      className="rail-btn"
      aria-label={props.label}
      title={props.label}
      aria-current={props.current ? 'page' : undefined}
      onClick={props.onSelect}
    >
      <Icon name={props.icon} />
    </button>
  );
}
