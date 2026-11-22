import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import type { ApiProblem } from '../platform/client';
import type { WorkspaceRole } from '../platform/wire';
import type { BatchPreviewView, InboxAttention, InboxBatch, InboxStep, PreviewItemState } from '../platform/wire-control';
import { useGuardedAction } from './actions';
import { Button, formatWhen, loadedValue, ProblemNotice, useLoad } from './primitives';
import { useSession } from './session';

/**
 * UW-12b (ADR 0047) — the control surface for work on the workflow runtime: approve a batch preview, start an approved batch,
 * decide a waiting step, cancel a run, and record what happened to a call whose outcome is unknown. Studio shows what the platform
 * says and sends a person's decision back; role, recent sign-in, separation of duties and the root the person saw are all checked
 * again by the platform, whose refusal is shown in plain words.
 */

const ITEM_LABEL: Record<PreviewItemState, string> = {
  sends: 'Sends',
  no_effect: 'Changes nothing',
  stops: 'Stops for a person',
  not_exact: 'Cannot be shown exactly',
};

/** One readable line per argument: text as written, an attachment by name and content hash, anything else compact. */
export function argLines(args: Readonly<Record<string, unknown>>): string[] {
  const one = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const name = o['filename'] ?? o['name'];
      const hash = o['sha256'] ?? o['digest'];
      if (typeof name === 'string' && typeof hash === 'string') return `${name} (content ${hash.replace(/^sha256[:-]/, '').slice(0, 12)})`;
    }
    const s = JSON.stringify(v) ?? '';
    return s.length > 200 ? `${s.slice(0, 199)}…` : s;
  };
  return Object.entries(args).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map(one).join(', ') : one(v)}`);
}

const LEFT_OUT: Readonly<Record<string, string>> = {
  no_document: 'no document found',
  several_documents: 'more than one document',
  name_on_several_rows: 'the same name on several rows',
  no_name: 'no name',
  blank: 'an empty row',
};

/** V1-1 (ADR 0049): where a batch's items came from, and what was left out and why. */
export function itemsSourceLine(src: NonNullable<BatchPreviewView['itemsSource']>): string {
  const why = Object.entries(src.reasons)
    .map(([r, n]) => `${LEFT_OUT[r] ?? r.replace(/_/g, ' ')} (${n})`)
    .join(', ');
  return [
    `Items from ${src.label} in ${src.connectionName}.`,
    src.excludedRows > 0 ? `${src.excludedRows} ${src.excludedRows === 1 ? 'row was' : 'rows were'} left out: ${why}.` : '',
    src.loose > 0 ? `${src.loose} matched only by another spelling, a short name or initials; check them below.` : '',
    src.changedSinceConfirmation ? 'The files changed since this pairing was confirmed.' : '',
  ]
    .filter((x) => x !== '')
    .join(' ');
}

export function countsLine(c: BatchPreviewView['counts'], total: number): string {
  const parts = [`${c.sends} would send`];
  if (c.no_effect > 0) parts.push(`${c.no_effect} change nothing`);
  if (c.stops > 0) parts.push(`${c.stops} stop for a person`);
  if (c.not_exact > 0) parts.push(`${c.not_exact} cannot be shown exactly`);
  return `${total} ${total === 1 ? 'item' : 'items'}: ${parts.join(', ')}.`;
}

const runLabel = (x: { runId: string; parentRunId?: string; item?: number }): string =>
  x.item !== undefined ? `item ${x.item + 1} of run ${x.parentRunId ?? x.runId}` : `run ${x.runId}`;

/**
 * A batch: what it would do, item by item (exceptions first), and the one decision it waits for. A reviewer approves the preview
 * shown here, named by its root; once approved, someone who can start work starts it with that approval.
 */
export function BatchCard(props: {
  workspaceId: string;
  batch: InboxBatch;
  role: WorkspaceRole | undefined;
  onChanged: (message?: string) => void;
}) {
  const { client } = useSession();
  const b = props.batch;
  const [page, setPage] = useState(1);
  const [exceptionsOnly, setExceptionsOnly] = useState(b.counts.stops + b.counts.not_exact > 0);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [approvedId, setApprovedId] = useState<string | undefined>();
  const { run, busy } = useGuardedAction();
  const approvalId = b.approval?.approvalId ?? approvedId;
  const preview = useLoad(
    () => client.getBatchPreview(props.workspaceId, b.definitionId, b.previewId, { page, exceptionsOnly }),
    [client, props.workspaceId, b.definitionId, b.previewId, page, exceptionsOnly],
  );
  const p = loadedValue(preview.state);
  const reviewer = can(props.role, 'review');
  const author = can(props.role, 'author');

  const approve = (shown: BatchPreviewView) =>
    void run(async () => {
      setProblem(undefined);
      // The root of the preview on screen: if the batch changed since it was loaded, the platform refuses this root.
      const r = await client.approveBatchPreview(props.workspaceId, b.definitionId, shown.previewId, shown.root);
      setConfirming(false);
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      setApprovedId(r.value.approval?.approvalId);
      setNote('Approved. It is recorded as your signed decision; someone who can start work can start it now.');
      props.onChanged();
    });
  const start = (approvalId: string) =>
    void run(async () => {
      setProblem(undefined);
      const r = await client.startApprovedBatch(props.workspaceId, b.definitionId, b.certificateId, approvalId);
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      const message =
        r.value.pendingApprovals.length > 0
          ? `Started (run ${r.value.runId}). It is waiting for a person: ${r.value.pendingApprovals[0]!.summary}`
          : `Started (run ${r.value.runId}): ${r.value.state}.`;
      setDone(message);
      props.onChanged(message);
    });

  return (
    <div className="ib-card cc-batch" aria-label="Batch to approve">
      <p className="cc-lead">{countsLine(b.counts, b.total)}</p>
      {b.senders.length > 0 ? (
        <p className="small">
          Sent from{' '}
          {b.senders.map((s, i) => (
            <span key={`${s.connector}-${i}`}>
              {i > 0 ? ', ' : ''}
              <strong>{s.account ?? s.connector}</strong>
              {s.account !== undefined ? ` (${s.connector})` : ''}
            </span>
          ))}
          .
        </p>
      ) : null}
      {p?.itemsSource !== undefined ? (
        <p className="small" aria-label="Where the items came from">
          {itemsSourceLine(p.itemsSource)}
        </p>
      ) : null}
      {p?.senders.some((x) => x.tierExplanation !== undefined) ? (
        <ul className="cc-args" aria-label="How it is sent">
          {p.senders
            .filter((x) => x.tierExplanation !== undefined)
            .map((x, i) => (
              <li key={`${x.connector}-${i}`} data-tier={x.tier}>
                {x.tierExplanation}
              </li>
            ))}
        </ul>
      ) : null}
      <p className="muted small">
        Prepared by {b.preparedByYou ? 'you' : b.createdBy} {formatWhen(b.createdAt)}.{' '}
        {b.state === 'awaiting_approval' ? `The preview expires ${formatWhen(b.expiresAt)}.` : null}
        {b.approval !== undefined
          ? `Approved by ${b.approval.reviewerId} ${formatWhen(b.approval.approvedAt)}; the approval expires ${formatWhen(b.approval.expiresAt)} and can be used once.`
          : null}
      </p>
      <p className="muted small">
        If anything changes before the start (a recipient, an attachment, a message or the sending account), the start is refused and
        nothing is sent. Immediately before each send, XO checks it is exactly what was approved.
      </p>

      <div className="cc-toolbar" role="group" aria-label="Which items">
        <button
          type="button"
          className="ib-chip"
          aria-pressed={!exceptionsOnly}
          onClick={() => {
            setExceptionsOnly(false);
            setPage(1);
          }}
        >
          All items
        </button>
        <button
          type="button"
          className="ib-chip"
          aria-pressed={exceptionsOnly}
          onClick={() => {
            setExceptionsOnly(true);
            setPage(1);
          }}
        >
          Only exceptions {b.counts.stops + b.counts.not_exact}
        </button>
      </div>
      {preview.state.phase === 'error' && p === undefined ? (
        <ProblemNotice problem={preview.state.problem} onRetry={preview.reload} />
      ) : null}
      {p !== undefined ? (
        <>
          {p.items.length === 0 ? <p className="muted small">No exceptions: every item goes through as shown.</p> : null}
          <ol className="cc-items" aria-label="What each item would do">
            {p.items.map((it) => (
              <li key={it.index} data-state={it.state} className="cc-item">
                <div className="cc-item-head">
                  <span className="cc-item-no">#{it.index + 1}</span>
                  <span className="cc-item-state">{ITEM_LABEL[it.state]}</span>
                </div>
                {it.reason !== undefined ? <p className="small">{it.reason}</p> : null}
                {it.actions.map((a, j) => (
                  <div key={`${a.step}-${j}`} className="cc-action">
                    <span className="muted small">
                      {a.connector} · {a.operation}
                      {a.sideEffect === 'irreversible' ? ' · cannot be undone' : ''}
                    </span>
                    <ul className="cc-args">
                      {argLines(a.args).map((l, k) => (
                        <li key={k}>{l}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </li>
            ))}
          </ol>
          {p.pages > 1 ? (
            <div className="cc-pager" role="group" aria-label="Pages">
              <Button onClick={() => setPage(Math.max(1, p.page - 1))} disabled={p.page <= 1}>
                Previous
              </Button>
              <span className="small">
                Page {p.page} of {p.pages}
              </span>
              <Button onClick={() => setPage(Math.min(p.pages, p.page + 1))} disabled={p.page >= p.pages}>
                Next
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {done !== undefined || note !== undefined ? (
        <p className="notice notice-success" role="status">
          {done ?? note}
        </p>
      ) : null}
      {done === undefined && approvalId === undefined && p !== undefined ? (
        <div className="cc-actions">
          {b.preparedByYou ? (
            <p className="muted small">You prepared this batch. Where approvals are separated, another reviewer approves it.</p>
          ) : null}
          {!confirming ? (
            <Button
              variant="primary"
              onClick={() => setConfirming(true)}
              disabled={!reviewer || !p.approvable}
              pending={busy}
              title={
                !reviewer
                  ? whyNot(props.role, 'review', 'approving a batch')
                  : !p.approvable
                    ? 'This preview cannot be approved.'
                    : undefined
              }
            >
              Approve this batch
            </Button>
          ) : (
            <div className="cc-confirm" role="group" aria-label="Confirm approval">
              <p className="small">
                You approve exactly the {b.total} {b.total === 1 ? 'item' : 'items'} above. It is recorded as your signed decision.
              </p>
              <Button variant="primary" onClick={() => approve(p)} pending={busy}>
                Yes, approve {b.total} {b.total === 1 ? 'item' : 'items'}
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
                Not now
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {done === undefined && approvalId !== undefined ? (
        <div className="cc-actions">
          <Button
            variant="primary"
            onClick={() => start(approvalId)}
            disabled={!author}
            pending={busy}
            title={author ? undefined : whyNot(props.role, 'author', 'starting work')}
          >
            Start the approved batch
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A step of a run on the workflow runtime that waits for a reviewer. Deciding it is a signed decision in the reviewer's name. */
export function RuntimeStepCard(props: {
  workspaceId: string;
  step: InboxStep;
  role: WorkspaceRole | undefined;
  onChanged: (message?: string) => void;
}) {
  const { client } = useSession();
  const s = props.step;
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const { run, busy } = useGuardedAction();
  const reviewer = can(props.role, 'review');
  const decide = (action: 'approve' | 'reject') =>
    void run(async () => {
      setProblem(undefined);
      const r = await client.decideGeneratedApproval(props.workspaceId, s.definitionId, s.runId, s.approvalId, action);
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      const message =
        action === 'approve' ? `Done as instructed. The run is now ${r.value.state}.` : `Rejected. The run is now ${r.value.state}.`;
      setDone(message);
      props.onChanged(message);
    });
  return (
    <div className="ib-card" aria-label="Step waiting for a person">
      <p className="cc-lead">{s.summary}</p>
      <p className="muted small">
        {s.workflowName}, {runLabel(s)}. Asked {formatWhen(s.requestedAt)}; it times out {formatWhen(s.expiresAt)}.
      </p>
      {s.proposedActions.length > 0 ? (
        <>
          <p className="small">If you approve, this follows:</p>
          <ul className="cc-args">
            {s.proposedActions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </>
      ) : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {done !== undefined ? (
        <p className="notice notice-success" role="status">
          {done}
        </p>
      ) : (
        <div className="cc-actions">
          <Button
            variant="primary"
            onClick={() => decide('approve')}
            disabled={!reviewer}
            pending={busy}
            title={reviewer ? undefined : whyNot(props.role, 'review', 'deciding a step')}
          >
            Approve
          </Button>
          <Button
            onClick={() => decide('reject')}
            disabled={!reviewer}
            pending={busy}
            title={reviewer ? undefined : whyNot(props.role, 'review', 'deciding a step')}
          >
            Reject
          </Button>
          <CancelRun
            workspaceId={props.workspaceId}
            definitionId={s.definitionId}
            runId={s.parentRunId ?? s.runId}
            batch={s.parentRunId !== undefined}
            role={props.role}
            onChanged={props.onChanged}
          />
        </div>
      )}
    </div>
  );
}

const DECISIONS = [
  { value: 'confirmed_success', label: 'It happened', hint: 'You found it at the destination (for example, the email is in Sent).' },
  { value: 'confirmed_failure_no_effect', label: 'It did not happen', hint: 'You checked and nothing arrived or changed.' },
  { value: 'unresolved', label: 'I cannot tell yet', hint: 'It stays blocked; you or someone else can record it later.' },
] as const;

/**
 * A call XO made but never heard back from. Only a person can say what happened; nothing is sent, re-sent or undone by recording
 * it. The reason (what was checked and found) is required, and it is kept with the run.
 */
export function ReconcileCard(props: {
  workspaceId: string;
  attention: InboxAttention;
  role: WorkspaceRole | undefined;
  onChanged: (message?: string) => void;
}) {
  const { client } = useSession();
  const a = props.attention;
  const [decision, setDecision] = useState<(typeof DECISIONS)[number]['value'] | undefined>();
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const { run, busy } = useGuardedAction();
  const reviewer = can(props.role, 'review');
  const submit = () =>
    void run(async () => {
      if (decision === undefined || reason.trim() === '') return;
      setProblem(undefined);
      const r = await client.reconcileGeneratedEffect(props.workspaceId, a.definitionId, a.runId, a.step, {
        decision,
        reason: reason.trim(),
        ...(evidence.trim() !== '' ? { evidenceExamined: evidence.trim() } : {}),
      });
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      const message = 'Recorded. Nothing was sent again.';
      setDone(message);
      props.onChanged(message);
    });
  return (
    <div className="ib-card" aria-label="Call with an unknown outcome">
      <p className="cc-lead">
        XO made a call to {a.connector} ({a.operation}) and never heard back, so it does not know whether it happened.
      </p>
      <p className="muted small">
        {a.workflowName}, {runLabel(a)}, started {formatWhen(a.intentAt)}. XO will not send it again on its own. Check {a.connector} and
        record what you find.
      </p>
      {a.detail !== '' ? <p className="small mono">{a.detail}</p> : null}
      {done !== undefined ? (
        <p className="notice notice-success" role="status">
          {done}
        </p>
      ) : (
        <form
          className="cc-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <fieldset>
            <legend>What happened?</legend>
            {DECISIONS.map((d) => (
              <label key={d.value} className="cc-radio">
                <input
                  type="radio"
                  name={`decision-${a.runId}-${a.step}`}
                  value={d.value}
                  checked={decision === d.value}
                  onChange={() => setDecision(d.value)}
                />
                <span>
                  {d.label}
                  <span className="muted small"> — {d.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="cc-field">
            What you checked and found (required)
            <textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} rows={3} />
          </label>
          <label className="cc-field">
            Where you looked (optional)
            <input type="text" value={evidence} maxLength={1000} onChange={(e) => setEvidence(e.target.value)} />
          </label>
          {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
          <div className="cc-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!reviewer || decision === undefined || reason.trim() === '' || busy}
              title={reviewer ? undefined : whyNot(props.role, 'review', 'recording what happened')}
            >
              Record what happened
            </button>
            <CancelRun
              workspaceId={props.workspaceId}
              definitionId={a.definitionId}
              runId={a.parentRunId ?? a.runId}
              batch={a.parentRunId !== undefined}
              role={props.role}
              onChanged={props.onChanged}
            />
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * Cancels a run or a whole batch, after a confirmation. The platform records the cancel before anything else: no call starts after
 * it, what already finished stands, and a call in flight becomes an unknown outcome for a person.
 */
export function CancelRun(props: {
  workspaceId: string;
  definitionId: string;
  runId: string;
  batch: boolean;
  role: WorkspaceRole | undefined;
  onChanged: (message?: string) => void;
}) {
  const { client } = useSession();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const { run, busy } = useGuardedAction();
  const author = can(props.role, 'author');
  const what = props.batch ? 'the whole batch' : 'this run';
  const cancel = () =>
    void run(async () => {
      setProblem(undefined);
      const r = await client.cancelGeneratedRun(props.workspaceId, props.definitionId, props.runId);
      setConfirming(false);
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      const message = `Cancelled ${what}. Nothing starts after this; what already finished stands.`;
      setDone(message);
      props.onChanged(message);
    });
  if (done !== undefined)
    return (
      <p className="notice notice-success" role="status">
        {done}
      </p>
    );
  return (
    <>
      {!confirming ? (
        <Button
          variant="danger"
          onClick={() => setConfirming(true)}
          disabled={!author}
          title={author ? undefined : whyNot(props.role, 'author', 'cancelling work')}
        >
          {props.batch ? 'Cancel the batch' : 'Cancel the run'}
        </Button>
      ) : (
        <span className="cc-confirm" role="group" aria-label="Confirm cancel">
          <span className="small">Cancel {what}? Nothing starts after this; what already finished stands.</span>
          <Button variant="danger" onClick={cancel} pending={busy}>
            Yes, cancel
          </Button>
          <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
            Keep it running
          </Button>
        </span>
      )}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
    </>
  );
}
