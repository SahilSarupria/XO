import { useMemo, useState } from 'react';
import { runBucket, standaloneExecutions, tidyName, type RecordedNote, type RunBucket } from '../domain/work';
import type { Capability, Execution, WorkflowRun } from '../platform/wire';
import { Button, EmptyState, formatWhen, Section, SubNav } from './primitives';
import { RunSummary, runTitle } from './RunCard';
import { RunReplay } from './RunReplay';
import { ExecutionOutcome } from './runs';
import { useSession } from './session';

/** Run history as the platform reports it. Nothing is added: no synthetic metrics, no invented audit trail. */
export function ActivitySection(props: {
  workspaceId: string;
  executions: Execution[];
  runs: readonly WorkflowRun[];
  notes: ReadonlyMap<string, RecordedNote>;
  caps: Capability[];
  activeCompilationId: string | undefined;
  /** The runs or executions list failed to load: do not claim that nothing has been run. */
  incomplete: boolean;
  onOpenTasks: () => void;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<RunBucket | 'all'>('all');
  const { mode } = useSession();
  const names = useMemo(() => new Map(props.caps.map((c) => [c.capabilityId, c.name])), [props.caps]);
  const sorted = standaloneExecutions(props.executions, props.runs).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  const sortedRuns = [...props.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pending = sorted.filter((e) => e.status === 'waiting_for_human' && e.humanTask?.status === 'pending');
  const pendingRuns = sortedRuns.filter((r) => r.status === 'waiting_for_human').length;
  const count = (b: RunBucket) => sortedRuns.filter((r) => runBucket(r) === b).length;
  const shownRuns = filter === 'all' ? sortedRuns : sortedRuns.filter((r) => runBucket(r) === filter);
  const filterItems: { id: RunBucket | 'all'; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'attention', label: 'Needs attention' },
    { id: 'running', label: 'Running' },
    { id: 'failed', label: 'Did not complete' },
    { id: 'finished', label: 'Finished' },
  ];

  return (
    <Section id="activity-h" title="Activity" lede="Everything that has been run in this workspace, newest first.">
      <p className="notice notice-info small">
        This is the platform&rsquo;s execution history. Durable, tamper-evident audit logging is planned (P1.0) and is not available yet, so
        this list is not an audit record.
      </p>
      {pending.length + pendingRuns > 0 ? (
        <p className="notice notice-warning" role="status">
          {pending.length + pendingRuns} {pending.length + pendingRuns === 1 ? 'item is' : 'items are'} waiting for a person to decide.{' '}
          <button type="button" className="crumb-link" onClick={props.onOpenTasks}>
            Open Tasks to decide
          </button>
        </p>
      ) : null}
      {sortedRuns.length > 0 ? (
        <>
          <h3 className="subhead">Processes</h3>
          <SubNav
            label="Filter processes"
            variant="chips"
            current={filter}
            items={filterItems.map((f) => ({
              id: f.id,
              label: f.label,
              ...(f.id !== 'all' ? { count: count(f.id), countLabel: 'processes' } : {}),
              onSelect: () => setFilter(f.id),
            }))}
          />
          {shownRuns.length === 0 ? <p className="muted small">No processes in this group.</p> : null}
          <ul className="list">
            {shownRuns.map((r) => (
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
                  {runBucket(r) === 'attention' ? (
                    <div className="row">
                      <Button variant="secondary" aria-label={`Open ${runTitle(r)} in Tasks`} onClick={props.onOpenTasks}>
                        Open in Tasks
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {sortedRuns.length > 0 && sorted.length > 0 ? <h3 className="subhead">Individual rules run</h3> : null}
      {sorted.length === 0 && sortedRuns.length === 0 && props.incomplete ? (
        <p className="notice notice-warning small" role="status">
          Run history could not be loaded, so XO cannot tell whether anything has been run. Use Retry above.
        </p>
      ) : null}
      {sorted.length === 0 && sortedRuns.length === 0 && !props.incomplete ? (
        <EmptyState title="Nothing has been run yet">
          Approve the rules XO found in Sources, then start a process from Workflows. Its result will appear here.
        </EmptyState>
      ) : null}
      <ul className="list">
        {sorted.map((e) => (
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
