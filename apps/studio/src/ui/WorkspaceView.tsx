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
import { Badge, Breadcrumbs, Button, EmptyState, ProblemNotice, Skeleton, SubNav, useLoad, loadedValue } from './primitives';
import { WorkspacesSection } from './WorkspacesSection';
import { ReviewSection } from './ReviewSection';
import { useSession } from './session';
import { BUILDER_SECTIONS, isBuilderSection, useSectionRoute, type Section } from './sectionRoute';
import { Icon, type IconName } from './icons';
import { XosSection } from './XosSection';
import { AuditSection, LibrarySection, SettingsSection } from './DesignSections';
import { ChatScreen } from './ChatScreen';
import { WorkflowEditor } from './WorkflowScreen';
import { chatReply, threadTitle, type ChatFacts, type ChatThread } from '../domain/chat';
import { xoItems } from '../domain/xo';
import type { FrameLayout } from './AppChrome';

type View = Section;
type SetupView = 'documents' | 'rules';

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
  const { client, mode, setMode } = useSession();
  const ws = props.workspace.workspaceId;
  const [view, setView, replaceView] = useSectionRoute();
  const [setupView, setSetupView] = useState<SetupView>('documents');
  const [pickedCompilation, setPickedCompilation] = useState<string | undefined>();
  /** A Builder-only screen that was asked for in User mode: explained on Home instead of silently dropped. */
  const [blocked, setBlocked] = useState<Section | undefined>();
  const [focusedCapability, setFocusedCapability] = useState<string | undefined>();
  const previousMode = useRef(mode);
  const [threads, setThreads] = useState<readonly ChatThread[]>([]);
  const [activeThread, setActiveThread] = useState<string | undefined>();
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | undefined>();
  const [wfSettings, setWfSettings] = useState(false);
  const threadSeq = useRef(1);
  const messageSeq = useRef(1);

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
    } else if (target === 'graph' || target === 'executions' || target === 'create') setView(target);
    else setView(target === 'workflows' ? 'work' : 'tasks');
  }

  const chatFacts: ChatFacts = {
    documents: loadedValue(sources.state)?.length,
    analyses: compilations.state.phase === 'loading' ? undefined : succeeded.length,
    processes: loadedValue(workflows.state)?.length,
    runs: loadedValue(runs.state)?.length,
  };
  function newChat() {
    setActiveThread(undefined);
    setView('chat');
  }
  /** Adds one question and its fixed reply to a conversation, creating the conversation on the first message. */
  function sendChat(text: string, attached: readonly string[] = []) {
    const reply = chatReply(text, chatFacts, attached);
    const id = messageSeq.current;
    messageSeq.current += 2;
    const pair = [
      { id, from: 'you' as const, text, ...(attached.length > 0 ? { attached } : {}) },
      { id: id + 1, from: 'xo' as const, text: reply.text, ...(reply.action !== undefined ? { action: reply.action } : {}) },
    ];
    if (activeThread === undefined) {
      const tid = `t${threadSeq.current++}`;
      setThreads((t) => [...t, { id: tid, title: threadTitle(text), messages: pair }]);
      setActiveThread(tid);
    } else {
      setThreads((t) => t.map((x) => (x.id === activeThread ? { ...x, messages: [...x.messages, ...pair] } : x)));
    }
    setView('chat');
  }
  const latestDocument = [...(loadedValue(sources.state) ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.originalFilename;
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
      <NavItem current={navCurrent} id="settings" icon="settings" hint="Detail level and runtime" onSelect={setView}>
        Settings
      </NavItem>
      <button
        type="button"
        className="ws-card"
        aria-label="Workspaces"
        aria-current={view === 'workspaces' ? 'page' : undefined}
        onClick={() => setView('workspaces')}
      >
        <span className="ws-name">{props.workspace.name ?? 'Untitled workspace'}</span>
        <span className="ws-status">
          <span className="dot" aria-hidden="true" /> Connected
        </span>
      </button>
    </nav>
  );

  const rail = (
    <>
      <RailButton current={navCurrent === 'home'} label="Home" icon="home" onSelect={() => setView('home')} />
      <RailButton current={navCurrent === 'work'} label="Workflows" icon="work" onSelect={() => setView('work')} />
      <RailButton current={navCurrent === 'setup'} label="My XOs" icon="xos" onSelect={() => setView('setup')} />
    </>
  );

  if (view === 'graph') {
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
                    <EmptyState title="No workflow to show yet">Add a document and let XO analyse it. The processes it finds can be opened here.</EmptyState>
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
                  workflows={workflowList}
                  workflow={wf}
                  onSelectWorkflow={setSelectedWorkflow}
                  caps={capList}
                  executions={execList}
                  runs={runList}
                  xos={xoList}
                  tab={wfSettings ? 'settings' : 'editor'}
                  onTab={(t) => {
                    if (t === 'executions') setView('activity');
                    else setWfSettings(t === 'settings');
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
              <ChatScreen
                threads={threads}
                activeId={activeThread}
                onSelect={setActiveThread}
                onNew={newChat}
                onSend={sendChat}
                xos={xoList}
                goTo={goToTarget}
              />
            </main>
          ),
        })}
      </>
    );
  }

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
          onAsk={sendChat}
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
      {view === 'library' ? <LibrarySection goTo={goToTarget} /> : null}
      {view === 'audit' ? <AuditSection runs={runList} incomplete={decisionsUnknown} /> : null}
      {view === 'settings' ? <SettingsSection workspaceName={props.workspace.name ?? 'Untitled workspace'} /> : null}
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
  return <>{props.frame({ nav, rail, content, layout: 'standard' })}</>;
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
    <button type="button" className="rail-btn" aria-label={props.label} title={props.label} aria-current={props.current ? 'page' : undefined} onClick={props.onSelect}>
      <Icon name={props.icon} />
    </button>
  );
}
