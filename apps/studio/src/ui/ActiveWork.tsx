import { isActiveRun } from '../domain/work';
import type { Compilation, WorkflowRun } from '../platform/wire';
import { Badge, formatWhen } from './primitives';
import { runTitle } from './RunCard';

const PILL: Record<string, { text: string; tone: 'accent' | 'warning' | 'neutral' }> = {
  running: { text: 'Running', tone: 'accent' },
  created: { text: 'Starting', tone: 'accent' },
  waiting_for_human: { text: 'Needs review', tone: 'warning' },
  interrupted: { text: 'Stopped', tone: 'warning' },
};

/** Home: the processes under way (left) and the XOs built from this workspace's analyses (right). Real records only. */
export function ActiveWork(props: {
  runs: readonly WorkflowRun[];
  analyses: readonly Compilation[];
  onOpenRun: (r: WorkflowRun) => void;
  onCreateXo: () => void;
}) {
  const active = props.runs.filter(isActiveRun).slice(0, 4);
  return (
    <div className="two">
      <section className="panel" aria-labelledby="active-h">
        <h3 id="active-h">Active workflows</h3>
        {active.length === 0 ? <p className="muted small">Nothing is running right now.</p> : null}
        {active.map((r) => {
          const pill = PILL[r.status] ?? { text: r.status, tone: 'neutral' as const };
          const at = r.currentStepIndex === null ? undefined : r.currentStepIndex + 1;
          return (
            <button
              key={r.workflowExecutionId}
              type="button"
              className="active-row"
              onClick={() => props.onOpenRun(r)}
              aria-label={`Open ${runTitle(r)}`}
            >
              <span className="active-main">
                <span className="active-name">{runTitle(r)}</span>
                <span className="mono muted small">
                  {at === undefined ? `${r.steps.length} steps` : `Step ${at} of ${r.steps.length}`} · started {formatWhen(r.createdAt)}
                </span>
              </span>
              <svg className="dots" width={Math.max(r.steps.length, 2) * 22} height="16" aria-hidden="true">
                {r.steps.map((s, i) => (
                  <circle
                    key={s.stepId}
                    cx={8 + i * 22}
                    cy="8"
                    r="4"
                    data-s={
                      s.status === 'succeeded'
                        ? 'done'
                        : s.status === 'pending'
                          ? 'todo'
                          : s.status === 'failed' || s.status === 'rejected'
                            ? 'bad'
                            : 'now'
                    }
                  />
                ))}
              </svg>
              <Badge tone={pill.tone}>{pill.text}</Badge>
            </button>
          );
        })}
      </section>
      <section className="panel" aria-labelledby="xos-panel-h">
        <h3 id="xos-panel-h">Your XOs</h3>
        {props.analyses.length === 0 ? <p className="muted small">None yet. An XO is built from an analysed document.</p> : null}
        {[...props.analyses]
          .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt))
          .slice(0, 3)
          .map((c) => (
            <div key={c.compilationId} className="pill-row">
              <span className="dot" aria-hidden="true" />
              Analysis of your documents
              <span className="mono muted small">{formatWhen(c.completedAt ?? c.createdAt)}</span>
            </div>
          ))}
        <button type="button" className="pill-row pill-add" onClick={props.onCreateXo}>
          + Create your own XO
        </button>
      </section>
    </div>
  );
}
