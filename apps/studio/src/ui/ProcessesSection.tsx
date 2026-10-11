import { Badge, EmptyState, ProblemNotice, Section, Spinner, useLoad } from './primitives';
import { useSession } from './session';

/**
 * Builder Mode, read-only. Workflows are composed by the platform from discovered capabilities.
 * Studio shows what the platform says about each one — including why it cannot run — and does
 * not offer to start them in this milestone.
 */
export function ProcessesSection(props: { workspaceId: string }) {
  const { client } = useSession();
  const { state, reload } = useLoad(() => client.listWorkflows(props.workspaceId), [client, props.workspaceId]);

  return (
    <Section id="processes-h" title="Processes" lede="Candidate workflows XO composed from what it found. Read-only for now.">
      {state.phase === 'loading' ? <Spinner label="Loading processes" /> : null}
      {state.phase === 'error' ? <ProblemNotice problem={state.problem} onRetry={reload} /> : null}
      {state.phase === 'ready' && state.value.length === 0 ? (
        <EmptyState title="No processes yet">Analyse a document to see candidate workflows.</EmptyState>
      ) : null}
      {state.phase === 'ready' ? (
        <ul className="list">
          {state.value.map((w) => (
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
      <p className="muted small">
        Starting a process from Studio is a later work package. Executing a workflow needs its own review of step-by-step approval and
        resume behaviour.
      </p>
    </Section>
  );
}
