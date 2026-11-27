import { useState } from 'react';
import { runtimeRunWords, tidyName } from '../domain/work';
import { useQuery, wsKey } from '../platform/query';
import type { WorkspaceRole } from '../platform/wire';
import type { WorkspaceRunView } from '../platform/wire-workflows';
import { Button } from './kit';
import { Badge, EmptyState, formatWhen, loadedValue, ProblemNotice, Section, Skeleton } from './primitives';
import { RunResults } from './RunResults';
import { useSession } from './session';

const PAGE = 50;

/**
 * One run on its own address. The run is found among the recent runs the platform lists (there is no single-run read in the API),
 * paging earlier when it is not on the first page; if it is still not found, the page says so rather than guessing.
 */
export function RunPage(props: {
  workspaceId: string;
  runId: string;
  role: WorkspaceRole | undefined;
  onBack: () => void;
  onOpenTasks: () => void;
}) {
  const { client, mode } = useSession();
  const first = useQuery(wsKey(props.workspaceId, `runtime-runs?limit=${PAGE}`), () =>
    client.listWorkspaceRuns(props.workspaceId, { limit: PAGE }),
  );
  const [extra, setExtra] = useState<{ runs: readonly WorkspaceRunView[]; cursor: string | undefined; used: boolean }>({
    runs: [],
    cursor: undefined,
    used: false,
  });
  const [loading, setLoading] = useState(false);
  const page = loadedValue(first.state);
  const all = [...(page?.runs ?? []), ...extra.runs];
  const run = all.find((r) => r.runId === props.runId);
  const cursor = extra.used ? extra.cursor : page?.nextCursor;

  const loadEarlier = () => {
    if (cursor === undefined || loading) return;
    setLoading(true);
    void client.listWorkspaceRuns(props.workspaceId, { limit: PAGE, cursor }).then((r) => {
      setLoading(false);
      if (r.ok) setExtra((e) => ({ runs: [...e.runs, ...r.value.runs], cursor: r.value.nextCursor, used: true }));
    });
  };

  return (
    <Section id="run-h" title={run !== undefined ? tidyName(run.name) : 'Run'} lede="One run of a workflow.">
      <p>
        <button type="button" className="crumb-link" onClick={props.onBack}>
          Back to Activity
        </button>
      </p>
      {first.state.phase === 'loading' ? <Skeleton label="Loading the run" rows={3} /> : null}
      {first.state.phase === 'error' && page === undefined ? <ProblemNotice problem={first.state.problem} onRetry={first.reload} /> : null}
      {run !== undefined ? (
        <>
          <p>
            <Badge tone="neutral">{runtimeRunWords(run)}</Badge>
          </p>
          <p className="muted small">
            Started {formatWhen(run.startedAt)}
            {run.startedBy !== undefined ? ` by ${run.startedBy}` : ''}
            {mode === 'builder' ? <span className="mono"> · {run.runId}</span> : null}
          </p>
          {run.pendingApprovals > 0 ? (
            <div className="row">
              <Button variant="secondary" onClick={props.onOpenTasks}>
                Open in the Inbox
              </Button>
            </div>
          ) : null}
          <RunResults workspaceId={props.workspaceId} definitionId={run.definitionId} runId={run.runId} role={props.role} defaultOpen />
        </>
      ) : page !== undefined ? (
        <EmptyState title="This run is not among the recent ones">
          XO could not find it in the runs loaded so far. It may be older, or the address may be wrong.
          {cursor !== undefined ? (
            <div className="row">
              <Button variant="secondary" loading={loading} onClick={loadEarlier}>
                Look at earlier runs
              </Button>
            </div>
          ) : null}
        </EmptyState>
      ) : null}
    </Section>
  );
}
