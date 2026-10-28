import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import type { WorkspaceRole } from '../platform/wire';
import { Button, formatWhen, ProblemNotice } from './primitives';
import type { DraftController } from './useWorkflowDraft';

/**
 * The saved copy of this process. Validation text is the platform's. "Execute draft" is permanently unavailable: the
 * server has no executor for user-authored graphs, and the reasons it gives are shown instead of a run.
 */
export function WorkflowDraftPanel(props: { draft: DraftController; role: WorkspaceRole | undefined }) {
  const d = props.draft;
  const [confirming, setConfirming] = useState<string | undefined>();
  const canSave = can(props.role, 'author');
  const errors = d.analysis?.errors ?? [];
  const blockers = d.analysis?.blockers ?? [];
  return (
    <section className="wf-draft" aria-label="Draft">
      <h2 className="wf-group">Draft</h2>
      <p className="muted small">
        A draft saves this process’s structure. The graph above stays read-only, and a saved draft cannot be run.
      </p>
      <label htmlFor="wf-draft-name">Draft name</label>
      <input id="wf-draft-name" value={d.name} disabled={!canSave} onChange={(e) => d.setName(e.target.value)} />
      <p className="small" role="status">
        {d.definitionId === undefined ? 'Not saved yet.' : `Saved · revision ${String(d.revision)}.`} {d.validating ? 'Checking…' : ''}
      </p>
      {!canSave ? <p className="muted small">{whyNot(props.role, 'author', 'saving workflows')}</p> : null}
      {d.name.trim() === '' ? <p className="small">Give the draft a name to check and save it.</p> : null}
      {d.note !== undefined ? (
        <p className="notice notice-info small" role="status">
          {d.note}
        </p>
      ) : null}
      {d.problem !== undefined ? <ProblemNotice problem={d.problem} /> : null}

      {errors.length > 0 ? (
        <>
          <h3 className="chat-label">Problems the platform found</h3>
          <ul aria-label="Problems with this draft">
            {errors.map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </>
      ) : null}
      {d.analysis?.wellFormed === true ? <p className="muted small">The platform found no structural problems.</p> : null}

      <Button variant="secondary" disabled aria-describedby="wf-draft-why">
        Execute draft
      </Button>
      <div id="wf-draft-why">
        <h3 className="chat-label">Why this draft cannot run</h3>
        {blockers.length === 0 ? (
          <p className="muted small">The platform has not reported why yet.</p>
        ) : (
          <ul aria-label="Reasons this draft cannot run">
            {blockers.map((b, i) => (
              <li key={i}>{b.message}</li>
            ))}
          </ul>
        )}
      </div>

      <h3 className="chat-label">Saved drafts</h3>
      {d.drafts === undefined ? null : d.drafts.length === 0 ? (
        <p className="muted small">No saved drafts yet.</p>
      ) : (
        <ul className="bare-list" aria-label="Saved drafts">
          {d.drafts.map((x) => (
            <li key={x.definitionId}>
              <button type="button" className="chat-link" onClick={() => void d.open(x.definitionId)}>
                {x.name}
              </button>{' '}
              <span className="muted small">
                revision {x.revision} · {x.nodeCount} nodes · {formatWhen(x.updatedAt)}
              </span>{' '}
              {confirming === x.definitionId ? (
                <>
                  <button
                    type="button"
                    className="chat-link"
                    onClick={() => {
                      setConfirming(undefined);
                      void d.remove(x.definitionId);
                    }}
                  >
                    Confirm delete
                  </button>
                  <button type="button" className="chat-link" onClick={() => setConfirming(undefined)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="chat-link"
                  aria-label={`Delete ${x.name}`}
                  disabled={!canSave}
                  onClick={() => setConfirming(x.definitionId)}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {d.definitionId !== undefined ? (
        <Button variant="quiet" onClick={d.startOver}>
          Start a new draft
        </Button>
      ) : null}
    </section>
  );
}
