import { useMemo } from 'react';
import { standaloneExecutions, tidyName } from '../domain/work';
import type { Capability, Execution, WorkflowRun } from '../platform/wire';
import { EmptyState, formatWhen, Section } from './primitives';
import { RunSummary, runTitle } from './RunCard';
import { ExecutionOutcome } from './runs';
import { useSession } from './session';

/** Run history as the platform reports it. Nothing is added: no synthetic metrics, no invented audit trail. */
export function ActivitySection(props: {
  workspaceId: string;
  executions: Execution[];
  runs: readonly WorkflowRun[];
  caps: Capability[];
  activeCompilationId: string | undefined;
  onChanged: () => void;
}) {
  const { mode } = useSession();
  const names = useMemo(() => new Map(props.caps.map((c) => [c.capabilityId, c.name])), [props.caps]);
  const sorted = standaloneExecutions(props.executions, props.runs).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  const sortedRuns = [...props.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pending = sorted.filter((e) => e.status === 'waiting_for_human' && e.humanTask?.status === 'pending');
  const pendingRuns = sortedRuns.filter((r) => r.status === 'waiting_for_human').length;

  return (
    <Section id="activity-h" title="Activity" lede="Everything that has been run in this workspace, newest first.">
      <p className="notice notice-info small">
        This is the platform&rsquo;s execution history. Durable, tamper-evident audit logging is planned (P1.0) and is not available yet, so
        this list is not an audit record.
      </p>
      {pending.length + pendingRuns > 0 ? (
        <p className="notice notice-warning" role="status">
          {pending.length + pendingRuns} {pending.length + pendingRuns === 1 ? 'item is' : 'items are'} waiting for a person to decide. Open
          Tasks to decide.
        </p>
      ) : null}
      {sortedRuns.length > 0 ? (
        <>
          <h3 className="subhead">Processes</h3>
          <ul className="list">
            {sortedRuns.map((r) => (
              <li key={r.workflowExecutionId} className="card">
                <div className="card-main">
                  <h3>{runTitle(r)}</h3>
                  <RunSummary run={r} />
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {sortedRuns.length > 0 && sorted.length > 0 ? <h3 className="subhead">Individual rules run</h3> : null}
      {sorted.length === 0 && sortedRuns.length === 0 ? (
        <EmptyState title="Nothing has been run yet">Approve a rule in Review, then run it to see the result here.</EmptyState>
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
