import { useMemo, useState } from 'react';
import { can, whyNot } from '../domain/access';
import { mergeInputContracts } from '../domain/draftRun';
import { MAX_DRAFT_NAME } from '../domain/workflowDraft';
import { buildInputFromContract } from '../domain/review';
import type { Capability, WorkspaceRole } from '../platform/wire';
import { ContractFields } from './ContractFields';
import { Button, formatWhen, ProblemNotice } from './primitives';
import { useRunDraft } from './useRunDraft';
import type { DraftController } from './useWorkflowDraft';

/**
 * The saved copy of this process. Validation text is the platform's. "Run draft" is enabled only when the platform's
 * analysis says the draft is runnable AND it is saved at its current revision; the run itself is the platform's, with
 * its approval gate, human tasks and refusals shown verbatim. Role and approval hints never replace its answer.
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
  const runner = useRunDraft(d, props.workspaceId, props.onChanged);
  const plan = d.analysis?.plan;
  const runnable = d.analysis?.runnable === true;
  const stepCaps = useMemo(
    () => (plan?.steps ?? []).map((st) => props.caps?.find((c) => c.capabilityId === st.capabilityId)),
    [plan, props.caps],
  );
  const contract = useMemo(() => (plan === undefined ? undefined : mergeInputContracts(stepCaps)), [plan, stepCaps]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [json, setJson] = useState('{}');
  const [jsonError, setJsonError] = useState<string | undefined>();
  const mayRun = can(props.role, 'author');
  const reason = !runnable
    ? undefined
    : d.definitionId === undefined || d.dirty
      ? 'Save the draft first: a run uses the saved revision, not unsaved edits.'
      : !mayRun
        ? whyNot(props.role, 'author', 'running workflows')
        : undefined;
  const start = () => {
    let input: Record<string, unknown>;
    if (contract !== undefined) {
      const built = buildInputFromContract(contract, values);
      if (!built.ok) {
        setFieldErrors({ ...built.errors });
        return;
      }
      setFieldErrors({});
      input = { ...built.input };
    } else {
      try {
        const v: unknown = JSON.parse(json);
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
        input = v as Record<string, unknown>;
        setJsonError(undefined);
      } catch {
        setJsonError('The input must be a JSON object, for example {"claim_amount": 1200}.');
        return;
      }
    }
    void runner.run(input);
  };
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

      <h3 className="chat-label">Run this draft</h3>
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
          {unapproved.length > 0 ? (
            <p className="muted small">
              Not approved yet: {unapproved.map((st) => st.name).join(', ')}. The platform will refuse the run until each is approved.
            </p>
          ) : null}
          {contract !== undefined ? (
            <ContractFields
              contract={contract}
              idPrefix="wf-run"
              values={values}
              errors={fieldErrors}
              onChange={(n, v) => setValues((cur) => ({ ...cur, [n]: v }))}
            />
          ) : (
            <>
              <label htmlFor="wf-run-json">Input (JSON object)</label>
              <textarea
                id="wf-run-json"
                rows={3}
                value={json}
                onChange={(e) => setJson(e.target.value)}
                aria-invalid={jsonError !== undefined}
              />
              {jsonError !== undefined ? (
                <p className="danger-text small" role="alert">
                  {jsonError}
                </p>
              ) : null}
            </>
          )}
        </>
      )}
      <Button
        variant="primary"
        disabled={!runnable || reason !== undefined || runner.busy}
        pending={runner.busy}
        aria-describedby="wf-run-why"
        onClick={start}
      >
        Run draft
      </Button>
      <p id="wf-run-why" className="muted small">
        {reason ?? ''}
      </p>
      {runner.problem !== undefined ? (
        <>
          <ProblemNotice problem={runner.problem} />
          <p className="small" aria-label="What the platform said">
            The platform said: “{runner.problem.message}”
          </p>
        </>
      ) : null}
      {runner.unconfirmed ? (
        <p className="notice notice-info small" role="status">
          The platform did not confirm whether the run started. Retrying is safe: the same request returns the original run if it did.
          Activity shows what exists.
        </p>
      ) : null}
      {runner.started !== undefined ? (
        <div className="notice notice-info small" role="status">
          <p>Run started: {runner.started.status.replace(/_/g, ' ')}.</p>
          <Button variant="secondary" onClick={runner.started.status === 'waiting_for_human' ? props.goToTasks : props.goToActivity}>
            {runner.started.status === 'waiting_for_human' ? 'Open the task in Inbox' : 'See the run in Activity'}
          </Button>
        </div>
      ) : null}

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
