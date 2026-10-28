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
import {
  Badge,
  Button,
  EmptyState,
  formatWhen,
  ProblemNotice,
  Section as PageSection,
  Skeleton,
  SubNav,
  useLoad,
  loadedValue,
} from './primitives';
import { WorkspacesSection } from './WorkspacesSection';
import { ReviewSection } from './ReviewSection';
import { useSession } from './session';
import { BUILDER_SECTIONS, isBuilderSection, useSectionRoute, type Section } from './sectionRoute';
import { Icon, type IconName } from './icons';
import { XosSection } from './XosSection';
import { LibraryScreen } from './LibraryScreen';
import { AuditScreen } from './AuditScreen';
import { SettingsScreen, type Tab as SettingsTab } from './SettingsScreen';
import { ChatScreen } from './ChatScreen';
import { WorkflowEditor } from './WorkflowScreen';
import { roleLabel } from '../domain/access';
import { useChat } from './useChat';
import { xoItems, type XoSubject } from '../domain/xo';
import { CreateXo } from './CreateXo';
import { CommandPalette, isPaletteShortcut, type PaletteCommand } from './CommandPalette';
import { useTheme } from './theme';
import { AskDock, type DockProps } from './AskDock';
import { WorkspaceMenu } from './WorkspaceMenu';
import { XoInspector } from './XoInspector';
import type { FrameLayout } from './AppChrome';

type View = Section;
type SetupView = 'xos' | 'documents' | 'rules';

const PAGE_LABEL: Record<View, string> = {
  home: 'Home',
  chat: 'Chat',
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
  audit: 'Audit log',
  settings: 'Settings',
};

export function WorkspaceView(props: {
  workspace: Workspace;
  workspaces: readonly Workspace[];
  onSelectWorkspace: (workspaceId: string) => void;
  onNewWorkspace: () => void;
  frame: (parts: { nav: ReactNode; rail: ReactNode; content: ReactNode; layout: FrameLayout }) => ReactNode;
}) {
  const { client, mode, setMode, signOut } = useSession();
  const ws = props.workspace.workspaceId;
  const [view, setView, replaceView] = useSectionRoute();
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
  const chat = useChat(ws, view === 'chat' || drawerOpen);

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

  // Run history is what the Executions screen is for, so opening it re-reads the platform's records. A failed refresh keeps
  // the last good list (see useLoad), so the screen never goes blank.
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

  const navCurrent: View =
    view === 'chat' ? 'home' : view === 'graph' || view === 'executions' ? 'work' : view === 'create' || view === 'xo' ? 'setup' : view;
  const nav = (
    <nav className="nav" aria-label="Workspace sections">
      <NavItem current={navCurrent} id="home" icon="home" hint="What needs you today" onSelect={setView}>
        Home
      </NavItem>
      <NavItem current={navCurrent} id="work" icon="work" hint="Start a process" onSelect={setView}>
        Workflows
      </NavItem>
      <NavItem
        current={navCurrent}
        id="setup"
        icon="xos"
        hint="Your documents and rules"
        onSelect={setView}
        count={summary?.readyForReview}
        countLabel="ready for review"
      >
        My XOs
      </NavItem>
      <NavItem
        current={navCurrent}
        id="tasks"
        icon="inbox"
        hint="Decisions that need you"
        onSelect={setView}
        count={taskCount}
        countLabel="need attention"
      >
        Inbox
      </NavItem>
      <NavItem current={navCurrent} id="library" icon="library" hint="Browse XOs" onSelect={setView}>
        Library
      </NavItem>
      <NavItem current={navCurrent} id="activity" icon="activity" hint="What has been run" onSelect={setView}>
        Activity
      </NavItem>
      <NavItem current={navCurrent} id="audit" icon="audit" hint="Who ran what" onSelect={setView}>
        Audit log
      </NavItem>
      {mode === 'builder' ? (
        <div className="nav-group" role="group" aria-label="Builder tools">
          <p className="nav-group-label">Builder tools</p>
          <NavItem current={navCurrent} id="contracts" icon="contracts" hint="Rule inputs and sources" onSelect={setView}>
            Contracts
          </NavItem>
          <NavItem current={navCurrent} id="processes" icon="processes" hint="Steps and readiness" onSelect={setView}>
            Processes
          </NavItem>
          <NavItem current={navCurrent} id="platform" icon="platform" hint="Service and API" onSelect={setView}>
            Platform
          </NavItem>
        </div>
      ) : null}
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

  const rail = (
    <>
      <RailButton current={navCurrent === 'home'} label="Home" icon="home" onSelect={() => setView('home')} />
      <RailButton current={navCurrent === 'work'} label="Workflows" icon="work" onSelect={() => setView('work')} />
      <RailButton current={navCurrent === 'setup'} label="My XOs" icon="xos" onSelect={() => setView('setup')} />
    </>
  );

  const dock: DockProps = {
    open: drawerOpen && view !== 'chat',
    onOpenChange: setDrawerOpen,
    focusTick,
    chat,
    xos: chat.attachable,
    onOpenSettings: openModelSettings,
  };

  if (view === 'graph' || view === 'executions') {
    const wf =
      workflowList.find((w) => w.workflowId === selectedWorkflow) ??
      workflowList.find((w) => w.compilationId === activeCompilation?.compilationId) ??
      workflowList[0];
    return (
      <>
        {props.frame({
          nav,
          rail,
          layout: 'bare',
          content: (
            <main className="immersive">
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
        {props.frame({
          nav,
          rail,
          layout: 'rail',
          content: (
            <main className="immersive">
              <ChatScreen chat={chat} xos={chat.attachable} onOpenSettings={openModelSettings} />
            </main>
          ),
        })}
      </>
    );
  }

  const content = (
    <main className="page">
      <header className="page-head">
        <h1>{props.workspace.name ?? 'Untitled workspace'}</h1>
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

      {view === 'home' ? (
        <HomeSection
          compilation={activeCompilation}
          workflows={workflowList}
          caps={capList}
          runs={runList}
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
              Documents are what you gave XO. Rules are what XO worked out from them, shown with the evidence. Only you can approve a rule.
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
    </main>
  );
  const commands: PaletteCommand[] = [
    { id: 'home', label: 'Go to Home', run: () => setView('home') },
    { id: 'ask', label: 'Ask XO', hint: '⌘J', run: askFocus },
    { id: 'chat', label: 'Open full chat', run: () => setView('chat') },
    { id: 'work', label: 'Go to Workflows', run: () => setView('work') },
    { id: 'setup', label: 'Go to My XOs', run: () => setView('setup') },
    { id: 'create', label: 'Create XO', run: () => setView('create') },
    { id: 'tasks', label: 'Go to Inbox', run: () => setView('tasks') },
    { id: 'executions', label: 'Go to Executions', run: () => setView('executions') },
    { id: 'library', label: 'Go to Library', run: () => setView('library') },
    { id: 'activity', label: 'Go to Activity', run: () => setView('activity') },
    { id: 'audit', label: 'Go to Audit log', hint: 'Preview', run: () => setView('audit') },
    { id: 'settings', label: 'Go to Settings', run: () => setView('settings') },
    {
      id: 'theme',
      label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      run: () => setThemeChoice(theme === 'dark' ? 'light' : 'dark'),
    },
  ];
  return (
    <>
      {props.frame({ nav, rail, content, layout: 'standard' })}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </>
  );
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
