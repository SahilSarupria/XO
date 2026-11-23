import { useMemo, useState } from 'react';
import { useQuery, wsKey } from '../platform/query';
import {
  runBucket,
  runtimeRunBucket,
  runtimeRunWords,
  standaloneExecutions,
  tidyName,
  type RecordedNote,
  type RunBucket,
} from '../domain/work';
import type { Capability, Execution, WorkflowRun, WorkspaceRole } from '../platform/wire';
import type { WorkspaceRunView } from '../platform/wire-workflows';
import { Badge, Button, EmptyState, formatWhen, loadedValue, ProblemNotice, Section, Skeleton, SubNav } from './primitives';
import { RunSummary, runTitle } from './RunCard';
import { RunReplay } from './RunReplay';
import { RunResults } from './RunResults';
import { ExecutionOutcome } from './runs';
import { useSession } from './session';

const PAGE = 50;
/** The badge tone for a run: colour repeats what the words say, it never carries the state alone. */
function toneOf(r: WorkspaceRunView): 'warning' | 'accent' | 'danger' | 'neutral' | 'success' {
  if (r.cancelled === true || r.state === 'cancelled' || r.state === 'compensated') return 'neutral';
  const b = runtimeRunBucket(r);
  return b === 'attention' ? 'warning' : b === 'running' ? 'accent' : b === 'failed' ? 'danger' : 'success';
}

/**
 * Run history as the platform reports it, newest first: every run on the workflow runtime across the workspace's workflows (S1-0),
 * then any history of the earlier engine and single rules run on their own. Nothing is added: no synthetic metrics, and an empty
 * list is never claimed while a list is loading or failed to load.
 */
export function ActivitySection(props: {
  workspaceId: string;
  role: WorkspaceRole | undefined;
  executions: Execution[];
  runs: readonly WorkflowRun[];
  notes: ReadonlyMap<string, RecordedNote>;
  caps: Capability[];
  activeCompilationId: string | undefined;
  /** The earlier history or single-rule list failed to load: do not claim that nothing has been run. */
  incomplete: boolean;
  onOpenTasks: () => void;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<RunBucket | 'all'>('all');
  const [more, setMore] = useState<{ runs: readonly WorkspaceRunView[]; cursor: string | undefined }>({ runs: [], cursor: undefined });
  const [moreProblem, setMoreProblem] = useState<Parameters<typeof ProblemNotice>[0]['problem'] | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const { client, mode } = useSession();
  const runtime = useQuery(wsKey(props.workspaceId, `runtime-runs?limit=${PAGE}`), () =>
    client.listWorkspaceRuns(props.workspaceId, { limit: PAGE }),
  );
  const firstPage = loadedValue(runtime.state);
  const names = useMemo(() => new Map(props.caps.map((c) => [c.capabilityId, c.name])), [props.caps]);

  const live: readonly WorkspaceRunView[] = firstPage === undefined ? [] : [...firstPage.runs, ...more.runs];
  const nextCursor = more.cursor ?? (more.runs.length === 0 ? firstPage?.nextCursor : undefined);
  const earlier = [...props.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const single = standaloneExecutions(props.executions, props.runs).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));

  const bucketOf = (r: WorkspaceRunView) => runtimeRunBucket(r);
  const count = (b: RunBucket) => live.filter((r) => bucketOf(r) === b).length + earlier.filter((r) => runBucket(r) === b).length;
  const shownLive = filter === 'all' ? live : live.filter((r) => bucketOf(r) === filter);
  const shownEarlier = filter === 'all' ? earlier : earlier.filter((r) => runBucket(r) === filter);
  const waiting =
    live.reduce((n, r) => n + r.pendingApprovals, 0) +
    earlier.filter((r) => r.status === 'waiting_for_human').length +
    single.filter((e) => e.status === 'waiting_for_human' && e.humanTask?.status === 'pending').length;

  const runtimeLoading = runtime.state.phase === 'loading';
  const runtimeFailed = runtime.state.phase === 'error' && firstPage === undefined;
  const nothingAtAll = !runtimeLoading && !runtimeFailed && !props.incomplete && live.length + earlier.length + single.length === 0;
  const filterItems: { id: RunBucket | 'all'; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'attention', label: 'Needs attention' },
    { id: 'running', label: 'Running' },
    { id: 'failed', label: 'Did not complete' },
    { id: 'finished', label: 'Finished' },
  ];

  const loadMore = () => {
    if (nextCursor === undefined || loadingMore) return;
    setLoadingMore(true);
    setMoreProblem(undefined);
    void client.listWorkspaceRuns(props.workspaceId, { limit: PAGE, cursor: nextCursor }).then((r) => {
      setLoadingMore(false);
      if (r.ok) setMore((m) => ({ runs: [...m.runs, ...r.value.runs], cursor: r.value.nextCursor }));
      else setMoreProblem(r.problem);
    });
  };

  return (
    <Section id="activity-h" title="Activity" lede="Everything that has been run in this workspace, newest first.">
      {waiting > 0 ? (
        <p className="notice notice-warning" role="status">
          {waiting} {waiting === 1 ? 'decision is' : 'decisions are'} waiting for a person.{' '}
          <button type="button" className="crumb-link" onClick={props.onOpenTasks}>
            Open the Inbox to decide
          </button>
        </p>
      ) : null}
      {runtimeLoading ? <Skeleton label="Loading the runs" rows={3} /> : null}
      {runtimeFailed && runtime.state.phase === 'error' ? (
        <>
          <p className="notice notice-warning small" role="status">
            The list of runs could not be loaded, so XO cannot tell whether anything has been run.
          </p>
          <ProblemNotice problem={runtime.state.problem} onRetry={runtime.reload} />
        </>
      ) : null}
      {!runtimeFailed && runtime.state.phase === 'error' ? (
        // S1-3: the list shown was loaded earlier (the read cache); the refresh failed, and the person is told so.
        <>
          <ProblemNotice problem={runtime.state.problem} onRetry={runtime.reload} />
          <p className="muted small">The runs below were loaded earlier and may be out of date.</p>
        </>
      ) : null}
      {live.length + earlier.length > 0 ? (
        <>
          <h3 className="subhead">Runs</h3>
          <SubNav
            label="Filter runs"
            variant="chips"
            current={filter}
            items={filterItems.map((f) => ({
              id: f.id,
              label: f.label,
              ...(f.id !== 'all' ? { count: count(f.id), countLabel: 'runs' } : {}),
              onSelect: () => setFilter(f.id),
            }))}
          />
          {shownLive.length + shownEarlier.length === 0 ? <p className="muted small">No runs in this group.</p> : null}
          <ul className="list" aria-label="Runs">
            {shownLive.map((r) => (
              <li key={r.runId} className="card" data-run-state={r.state}>
                <div className="card-main">
                  <h3>{tidyName(r.name)}</h3>
                  <p>
                    <Badge tone={toneOf(r)}>{runtimeRunWords(r)}</Badge>
                  </p>
                  <p className="muted small">
                    Started {formatWhen(r.startedAt)}
                    {r.startedBy !== undefined ? ` by ${r.startedBy}` : ''}
                    {mode === 'builder' ? <span className="mono"> · {r.runId}</span> : null}
                  </p>
                  {r.pendingApprovals > 0 ? (
                    <div className="row">
                      <Button variant="secondary" aria-label={`Open in the Inbox: ${tidyName(r.name)}`} onClick={props.onOpenTasks}>
                        Open in the Inbox
                      </Button>
                    </div>
                  ) : null}
                  <RunResults workspaceId={props.workspaceId} definitionId={r.definitionId} runId={r.runId} role={props.role} />
                </div>
              </li>
            ))}
            {shownEarlier.map((r) => (
              <li key={r.workflowExecutionId} className="card">
                <div className="card-main">
                  <h3>{runTitle(r)}</h3>
                  <RunSummary run={r} notes={props.notes} />
                  {r.steps.length > 0 ? (
                    <details className="replay-disclosure">
                      <summary>Review steps</summary>
                      <RunReplay run={r} />
                    </details>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {nextCursor !== undefined ? (
            <div className="row">
              <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Show earlier runs'}
              </Button>
            </div>
          ) : null}
          {moreProblem !== undefined ? <ProblemNotice problem={moreProblem} onRetry={loadMore} /> : null}
        </>
      ) : null}
      {single.length > 0 ? <h3 className="subhead">Single rules run</h3> : null}
      {props.incomplete && single.length === 0 && earlier.length === 0 && !runtimeFailed ? (
        <p className="notice notice-warning small" role="status">
          Part of the run history could not be loaded, so this list may be incomplete. Use Retry above.
        </p>
      ) : null}
      {nothingAtAll ? (
        <EmptyState title="Nothing has been run yet">
          When a workflow runs, it appears here with what it did, who started it and what it produced.
        </EmptyState>
      ) : null}
      <ul className="list">
        {single.map((e) => (
          <li key={e.executionId} className="card">
            <div className="card-main">
              <h3>{tidyName(names.get(e.capabilityId) ?? 'A rule from an earlier analysis')}</h3>
              <p className="muted small">
                Started {formatWhen(e.requestedAt)}
                {e.initiator !== undefined ? ` by ${e.initiator.id}` : ''}
                {mode === 'builder' ? (
                  <span className="mono">
                    {' '}
                    · {e.executionId} · {e.capabilityId}
                  </span>
                ) : null}
              </p>
              <ExecutionOutcome workspaceId={props.workspaceId} execution={e} onChanged={props.onChanged} />
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
