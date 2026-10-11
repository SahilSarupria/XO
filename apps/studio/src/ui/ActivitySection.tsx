import { useMemo } from 'react';
import type { Capability, Execution } from '../platform/wire';
import { EmptyState, formatWhen, Section } from './primitives';
import { ExecutionOutcome } from './runs';
import { useSession } from './session';

/** Run history as the platform reports it. Nothing is added: no synthetic metrics, no invented audit trail. */
export function ActivitySection(props: {
  workspaceId: string;
  executions: Execution[];
  caps: Capability[];
  activeCompilationId: string | undefined;
  onChanged: () => void;
}) {
  const { mode } = useSession();
  const names = useMemo(() => new Map(props.caps.map((c) => [c.capabilityId, c.name])), [props.caps]);
  const sorted = [...props.executions].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  const pending = sorted.filter((e) => e.status === 'waiting_for_human' && e.humanTask?.status === 'pending');

  return (
    <Section id="activity-h" title="Activity" lede="Everything that has been run in this workspace, newest first.">
      <p className="notice notice-info small">
        This is the platform&rsquo;s execution history. Durable, tamper-evident audit logging is planned (P1.0) and is not available yet, so
        this list is not an audit record.
      </p>
      {pending.length > 0 ? (
        <p className="notice notice-warning" role="status">
          {pending.length} {pending.length === 1 ? 'step is' : 'steps are'} waiting for a person to decide.
        </p>
      ) : null}
      {sorted.length === 0 ? (
        <EmptyState title="Nothing has been run yet">Approve a rule in Review, then run it to see the result here.</EmptyState>
      ) : null}
      <ul className="list">
        {sorted.map((e) => (
          <li key={e.executionId} className="card">
            <div className="card-main">
              <h3>{names.get(e.capabilityId) ?? 'A rule from an earlier analysis'}</h3>
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
