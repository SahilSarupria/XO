import type { Workflow } from '../platform/wire';
import { Badge, EmptyState, loadedValue, ProblemNotice, Section, Spinner, type LoadState } from './primitives';

/**
 * Builder Mode, read-only. Workflows are composed by the platform from discovered capabilities.
 * Studio shows what the platform says about each one — including why it cannot run — and does
 * not offer to start them in this milestone.
 */
export function ProcessesSection(props: { state: LoadState<Workflow[]>; reload: () => void }) {
  // The parent already loads the workflows; this view renders that same state instead of asking the platform again.
  const { state, reload } = props;
  const shown = loadedValue(state);

  return (
    <Section
      id="processes-h"
      title="Processes"
      lede="Technical view of the processes XO composed from what it found. Start them from Work."
    >
      {state.phase === 'loading' ? <Spinner label="Loading processes" /> : null}
      {state.phase === 'error' && state.stale === undefined ? <ProblemNotice problem={state.problem} onRetry={reload} /> : null}
      {shown !== undefined && shown.length === 0 ? (
        <EmptyState title="No processes yet">Analyse a document to see candidate workflows.</EmptyState>
      ) : null}
      {shown !== undefined ? (
        <ul className="list">
          {shown.map((w) => (
            <li key={w.workflowId} className="card">
              <div className="card-main">
                <div className="row between">
                  <h3>{w.name}</h3>
                  <Badge tone={w.executable ? 'success' : 'warning'}>{w.executable ? 'Can run' : 'Cannot run yet'}</Badge>
                </div>
                <p className="muted small">{w.description}</p>
                <p className="mono small">
                  {w.workflowId} · {w.status} · {w.stepCount} step(s) · {w.gapCount} gap(s) · confidence {Math.round(w.confidence * 100)}%
                  {w.requiresHumanDecision ? ' · needs a human decision' : ''}
                </p>
                {w.notExecutableReasons.length > 0 ? (
                  <details>
                    <summary>Why it cannot run ({w.notExecutableReasons.length})</summary>
                    <ul className="plain">
                      {w.notExecutableReasons.slice(0, 20).map((r, i) => (
                        <li key={i} className="mono small">
                          {r}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
