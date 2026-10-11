import { useEffect, useMemo, useState } from 'react';
import { nextStep, summarize } from '../domain/review';
import { standaloneExecutions } from '../domain/work';
import type { Compilation, Workspace } from '../platform/wire';
import { ActivitySection } from './ActivitySection';
import { ContextSection } from './ContextSection';
import { HomeSection } from './HomeSection';
import { TasksSection } from './TasksSection';
import { WorkSection } from './WorkSection';
import { ProcessesSection } from './ProcessesSection';
import { ProblemNotice, Spinner, useLoad } from './primitives';
import { ReviewSection } from './ReviewSection';
import { useSession } from './session';

type View = 'home' | 'work' | 'tasks' | 'activity' | 'setup' | 'processes';
type SetupView = 'documents' | 'rules';

const GOAL_KEY = (ws: string) => `xo-studio:goal:${ws}`;

export function WorkspaceView(props: { workspace: Workspace }) {
  const { client, mode } = useSession();
  const ws = props.workspace.workspaceId;
  const [view, setView] = useState<View>('home');
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
    if (mode === 'user' && view === 'processes') setView('home');
  }, [mode, view]);

  function refreshAll() {
    sources.reload();
    compilations.reload();
    executions.reload();
    workflows.reload();
    runs.reload();
    caps.reload();
  }

  const summary = caps.state.phase === 'ready' ? summarize(caps.state.value) : undefined;
  const step = nextStep({
    sources: sources.state.phase === 'ready' ? sources.state.value.length : 0,
    succeededCompilations: succeeded.length,
    summary,
    executions: executions.state.phase === 'ready' ? executions.state.value.length : 0,
  });

  const runList = runs.state.phase === 'ready' ? runs.state.value : [];
  const execList = executions.state.phase === 'ready' ? executions.state.value : [];
  const workflowList = workflows.state.phase === 'ready' ? workflows.state.value : [];
  const capList = caps.state.phase === 'ready' ? caps.state.value : undefined;
  const standalonePending = standaloneExecutions(execList, runList).filter(
    (e) => e.status === 'waiting_for_human' && e.humanTask?.status === 'pending',
  ).length;
  const taskCount = runList.filter((r) => r.status === 'waiting_for_human' || r.status === 'interrupted').length + standalonePending;

  const firstError = [sources.state, compilations.state, workflows.state, runs.state].find((s) => s.phase === 'error');

  return (
    <main className="page">
      <header className="page-head">
        <h1>{props.workspace.name ?? 'Untitled workspace'}</h1>
      </header>

      <nav className="tabs" aria-label="Workspace sections">
        <TabButton current={view} id="home" onSelect={setView}>
          Home
        </TabButton>
        <TabButton current={view} id="work" onSelect={setView}>
          Work
        </TabButton>
        <TabButton current={view} id="tasks" onSelect={setView} count={taskCount} countLabel="need attention">
          Tasks
        </TabButton>
        <TabButton current={view} id="activity" onSelect={setView}>
          Activity
        </TabButton>
        <TabButton current={view} id="setup" onSelect={setView} count={summary?.readyForReview} countLabel="ready for review">
          Setup
        </TabButton>
        {mode === 'builder' ? (
          <TabButton current={view} id="processes" onSelect={setView}>
            Processes
          </TabButton>
        ) : null}
      </nav>

      {firstError?.phase === 'error' ? <ProblemNotice problem={firstError.problem} onRetry={refreshAll} /> : null}

      {view === 'home' ? (
        <HomeSection
          compilation={activeCompilation}
          workflows={workflowList}
          caps={capList}
          runs={runList}
          standalonePending={standalonePending}
          next={step}
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
        <TasksSection workspaceId={ws} runs={runList} executions={execList} caps={capList ?? []} onChanged={refreshAll} />
      ) : null}
      {view === 'activity' ? (
        executions.state.phase === 'loading' ? (
          <Spinner label="Loading activity" />
        ) : executions.state.phase === 'error' ? (
          <ProblemNotice problem={executions.state.problem} onRetry={executions.reload} />
        ) : (
          <ActivitySection
            workspaceId={ws}
            executions={executions.state.value}
            runs={runList}
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
      {view === 'processes' && mode === 'builder' ? <ProcessesSection workspaceId={ws} /> : null}
    </main>
  );
}

function TabButton(props: {
  current: View;
  id: View;
  onSelect: (v: View) => void;
  count?: number | undefined;
  countLabel?: string;
  children: string;
}) {
  const active = props.current === props.id;
  return (
    <button type="button" className="tab" aria-current={active ? 'page' : undefined} onClick={() => props.onSelect(props.id)}>
      {props.children}
      {props.count !== undefined && props.count > 0 ? (
        <span className="tab-count" aria-label={`${props.count} ${props.countLabel ?? ''}`.trim()}>
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
