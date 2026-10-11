import { useEffect, useMemo, useState } from 'react';
import { nextStep, summarize } from '../domain/review';
import type { Compilation, Workspace } from '../platform/wire';
import { ActivitySection } from './ActivitySection';
import { ContextSection } from './ContextSection';
import { ProcessesSection } from './ProcessesSection';
import { ProblemNotice, Spinner, useLoad } from './primitives';
import { ReviewSection } from './ReviewSection';
import { useSession } from './session';

type View = 'context' | 'review' | 'activity' | 'processes';

const GOAL_KEY = (ws: string) => `xo-studio:goal:${ws}`;

export function WorkspaceView(props: { workspace: Workspace }) {
  const { client, mode } = useSession();
  const ws = props.workspace.workspaceId;
  const [view, setView] = useState<View>('context');
  const [pickedCompilation, setPickedCompilation] = useState<string | undefined>();

  const sources = useLoad(() => client.listSources(ws), [client, ws]);
  const compilations = useLoad(() => client.listCompilations(ws), [client, ws]);
  const executions = useLoad(() => client.listExecutions(ws), [client, ws]);

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
    if (mode === 'user' && view === 'processes') setView('context');
  }, [mode, view]);

  function refreshAll() {
    sources.reload();
    compilations.reload();
    executions.reload();
    caps.reload();
  }

  const summary = caps.state.phase === 'ready' ? summarize(caps.state.value) : undefined;
  const step = nextStep({
    sources: sources.state.phase === 'ready' ? sources.state.value.length : 0,
    succeededCompilations: succeeded.length,
    summary,
    executions: executions.state.phase === 'ready' ? executions.state.value.length : 0,
  });

  const firstError = [sources.state, compilations.state].find((s) => s.phase === 'error');

  return (
    <main className="page">
      <header className="page-head">
        <h1>{props.workspace.name ?? 'Untitled workspace'}</h1>
        <GoalNote workspaceId={ws} />
      </header>

      <div className="next-step" aria-live="polite">
        <span className="next-step-label">Next</span>
        <div>
          <strong>{step.headline}</strong>
          <span className="muted"> — {step.hint}</span>
        </div>
      </div>

      <nav className="tabs" aria-label="Workspace sections">
        <TabButton current={view} id="context" onSelect={setView}>
          Context
        </TabButton>
        <TabButton current={view} id="review" onSelect={setView} count={summary?.readyForReview}>
          Review
        </TabButton>
        <TabButton current={view} id="activity" onSelect={setView}>
          Activity
        </TabButton>
        {mode === 'builder' ? (
          <TabButton current={view} id="processes" onSelect={setView}>
            Processes
          </TabButton>
        ) : null}
      </nav>

      {firstError?.phase === 'error' ? <ProblemNotice problem={firstError.problem} onRetry={refreshAll} /> : null}

      {view === 'context' ? (
        <ContextSection
          workspaceId={ws}
          sources={sources.state}
          compilations={compilations.state.phase === 'ready' ? compilations.state.value : []}
          onChanged={refreshAll}
          onAnalysed={(c) => {
            setPickedCompilation(c.compilationId);
            refreshAll();
            setView('review');
          }}
        />
      ) : null}
      {view === 'review' ? (
        <ReviewSection
          workspaceId={ws}
          compilation={activeCompilation}
          compilations={succeeded}
          onPickCompilation={setPickedCompilation}
          caps={caps.state}
          executions={executions.state.phase === 'ready' ? executions.state.value : []}
          onChanged={refreshAll}
          goToContext={() => setView('context')}
        />
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
            caps={caps.state.phase === 'ready' ? caps.state.value : []}
            activeCompilationId={activeCompilation?.compilationId}
            onChanged={refreshAll}
          />
        )
      ) : null}
      {view === 'processes' && mode === 'builder' ? <ProcessesSection workspaceId={ws} /> : null}
    </main>
  );
}

function TabButton(props: { current: View; id: View; onSelect: (v: View) => void; count?: number | undefined; children: string }) {
  const active = props.current === props.id;
  return (
    <button type="button" className="tab" aria-current={active ? 'page' : undefined} onClick={() => props.onSelect(props.id)}>
      {props.children}
      {props.count !== undefined && props.count > 0 ? (
        <span className="tab-count" aria-label={`${props.count} ready for review`}>
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
        placeholder="e.g. Check late-notification claims against policy section 4"
        maxLength={200}
        aria-describedby="goal-help"
      />
      <p id="goal-help" className="muted small">
        A note for you and your team. Saved in this browser only — XO does not receive it yet.
      </p>
    </div>
  );
}
