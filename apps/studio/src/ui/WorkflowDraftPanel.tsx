import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import { MAX_DRAFT_NAME } from '../domain/workflowDraft';
import type { Capability, WorkspaceRole } from '../platform/wire';
import { Button, formatWhen, ProblemNotice } from './primitives';
import type { DraftController } from './useWorkflowDraft';

/**
 * The saved copy of this process. Validation text is the platform's. ADR 0052: a draft is no longer run from here (the composed
 * runner was removed); the panel says what the platform's analysis found and where a start happens.
 */
export function WorkflowDraftPanel(props: {
  draft: DraftController;
  role: WorkspaceRole | undefined;
  workspaceId: string;
  caps: readonly Capability[] | undefined;
  onChanged: () => void;
  goToTasks: () => void;
  goToActivity: () => void;
}) {
  const d = props.draft;
  const [confirming, setConfirming] = useState<string | undefined>();
  const canSave = can(props.role, 'author');
  const errors = d.analysis?.errors ?? [];
  const blockers = d.analysis?.blockers ?? [];
  const plan = d.analysis?.plan;
  const runnable = d.analysis?.runnable === true;
  const unapproved = (plan?.steps ?? []).filter((st) => !st.approved);
  return (
    <section className="wf-draft" aria-label="Draft">
      <h2 className="wf-group">Draft</h2>
      <p className="muted small">
        A draft is a saved copy of this process that you can edit. The platform checks every change, and runs a saved draft only when its
        own analysis says it can.
      </p>
      <label htmlFor="wf-draft-name">Draft name</label>
      <input id="wf-draft-name" maxLength={MAX_DRAFT_NAME} value={d.name} disabled={!canSave} onChange={(e) => d.setName(e.target.value)} />
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
      {d.checkProblem !== undefined ? (
        <>
          <ProblemNotice problem={d.checkProblem} />
          <p className="small" aria-label="What the platform said about checking">
            The platform said: “{d.checkProblem.message}”
          </p>
        </>
      ) : null}

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

      <h3 className="chat-label">What this draft would do</h3>
      {!runnable ? (
        <div id="wf-draft-why">
          <p className="small">The platform says this draft cannot run yet.</p>
          {blockers.length === 0 && errors.length === 0 ? (
            <p className="muted small">
              {d.analysis === undefined ? 'The platform has not checked it yet.' : 'The platform reported no reason.'}
            </p>
          ) : (
            <ul aria-label="Reasons this draft cannot run">
              {[...errors, ...blockers].map((b, i) => (
                <li key={i}>{b.message}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <p className="small" role="status">
            The platform says this draft can run. It follows: {(plan?.steps ?? []).map((st) => st.name).join(' → ')}
            {(plan?.branches ?? [])
              .map((b) => ` (branch ${b.nodeId} goes ${b.taken === 'gte' ? 'at or above' : 'below'} ${b.threshold})`)
              .join('')}
            .
          </p>
          {unapproved.length > 0 ? <p className="muted small">Not approved yet: {unapproved.map((st) => st.name).join(', ')}.</p> : null}
        </>
      )}
      <p className="muted small">
        A draft is not started from here: the old draft runner was removed. Generate the workflow from its compilation, get its readiness
        certificate, and start it from Workflows.
      </p>

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
