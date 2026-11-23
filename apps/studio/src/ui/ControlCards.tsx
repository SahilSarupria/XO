import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import type { ApiProblem } from '../platform/client';
import type { WorkspaceRole } from '../platform/wire';
import type { BatchPreviewView, InboxAttention, InboxBatch, InboxStep, PreviewItemState } from '../platform/wire-control';
import { useGuardedAction } from './actions';
import { Button, formatWhen, loadedValue, ProblemNotice, useLoad } from './primitives';
import { EvidenceView } from './EvidenceView';
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

/** Which run, in words. Run ids appear only in Builder mode (plan 5.6): to a person they are noise, and they never repeat. */
const runLabel = (x: { runId: string; parentRunId?: string; item?: number }, builder: boolean): string =>
  builder
    ? x.item !== undefined
      ? `item ${x.item + 1} of run ${x.parentRunId ?? x.runId}`
      : `run ${x.runId}`
    : x.item !== undefined
      ? `item ${x.item + 1} of this run`
      : 'this run';

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
  const { client, mode } = useSession();
  const b = props.batch;
  const [page, setPage] = useState(1);
  const [exceptionsOnly, setExceptionsOnly] = useState(b.counts.stops + b.counts.not_exact > 0);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [approvedId, setApprovedId] = useState<string | undefined>();
  // UW-16a: the steps a person does for each item are decided by this approval only if the approver ticks them. Unticked by default.
  const [ticked, setTicked] = useState<readonly string[]>([]);
  const { run, busy } = useGuardedAction();
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
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
      const r = await client.approveBatchPreview(props.workspaceId, b.definitionId, shown.previewId, shown.root, ticked);
      setConfirming(false);
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      setApprovedId(r.value.approval?.approvalId);
      setNote('Approved. It is recorded as your signed decision; someone who can start work can start it now.');
      props.onChanged();
    });
  // UW-12b: a reviewer who is not ready to approve asks for changes with a reason; the batch then cannot be approved until it is prepared again.
  const requestChanges = () =>
    void run(async () => {
      setProblem(undefined);
      const r = await client.requestBatchChanges(props.workspaceId, b.definitionId, b.previewId, comment.trim());
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      setAsking(false);
      setDone('Changes requested. The batch cannot be approved until it is prepared again.');
      props.onChanged('Changes requested. The batch cannot be approved until it is prepared again.');
    });
  const start = (approvalId: string) =>
    void run(async () => {
      setProblem(undefined);
      const r = await client.startApprovedBatch(props.workspaceId, b.definitionId, b.certificateId, approvalId);
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      const which = mode === 'builder' ? ` (run ${r.value.runId})` : '';
      const message =
        r.value.pendingApprovals.length > 0
          ? `Started${which}. It is waiting for a person: ${r.value.pendingApprovals[0]!.summary}`
          : `Started${which}: ${r.value.state}.`;
      setDone(message);
      props.onChanged(message);
    });

  return (
    <div className="ib-card cc-batch" aria-label="Batch to approve">
      <p className="cc-lead">{countsLine(b.counts, b.total)}</p>
      {(p?.changesRequested ?? b.changesRequested) !== undefined ? (
        <p className="notice notice-warning small" role="status">
          Changes were requested by {(p?.changesRequested ?? b.changesRequested)!.by}:{' '}
          {(p?.changesRequested ?? b.changesRequested)!.comment}
        </p>
      ) : null}
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
      {done === undefined && approvalId === undefined && p !== undefined && p.stepsToApprove.length > 0 ? (
        <fieldset className="cc-steps" aria-label="Steps a person does for each item">
          <legend className="small">Steps a person does for each item</legend>
          <p className="muted small">
            Each of these waits for a person in every item unless you decide it here, with this approval. Tick only the ones you want
            decided for all the items above.
          </p>
          {p.stepsToApprove.map((x) => (
            <label key={x.step} className="small cc-step-choice">
              <input
                type="checkbox"
                checked={ticked.includes(x.step)}
                onChange={(e) => setTicked(e.target.checked ? [...ticked, x.step] : ticked.filter((t) => t !== x.step))}
              />{' '}
              {x.summary} ({x.items} {x.items === 1 ? 'item' : 'items'})
            </label>
          ))}
        </fieldset>
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
                  : p.changesRequested !== undefined
                    ? 'Changes were requested, so this batch cannot be approved until it is prepared again.'
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
                You approve exactly the {b.total} {b.total === 1 ? 'item' : 'items'} above. It is recorded as your signed decision.{' '}
                {ticked.length === 0
                  ? 'Each step a person does is still asked in every item.'
                  : `You also decide, for every item: ${p.stepsToApprove
                      .filter((x) => ticked.includes(x.step))
                      .map((x) => x.summary)
                      .join('; ')}.`}
              </p>
              <Button variant="primary" onClick={() => approve(p)} pending={busy}>
                Yes, approve {b.total} {b.total === 1 ? 'item' : 'items'}
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
                Not now
              </Button>
            </div>
          )}
          {!confirming && !asking ? (
            <Button
              onClick={() => setAsking(true)}
              disabled={!reviewer || p.changesRequested !== undefined}
              title={reviewer ? undefined : whyNot(props.role, 'review', 'asking for changes')}
            >
              Request changes
            </Button>
          ) : null}
          {asking ? (
            <div className="cc-confirm" role="group" aria-label="Request changes">
              <label className="small">
                What needs to change?
                <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} />
              </label>
              <Button variant="primary" onClick={requestChanges} disabled={comment.trim() === ''} pending={busy}>
                Send request
              </Button>
              <Button variant="quiet" onClick={() => setAsking(false)} disabled={busy}>
                Not now
              </Button>
            </div>
          ) : null}
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
  const { client, mode } = useSession();
  const s = props.step;
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const { run, busy } = useGuardedAction();
  const [delegating, setDelegating] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [to, setTo] = useState('');
  const [why, setWhy] = useState('');
  // UW-12b: a step handed to someone else can only be decided by them. The platform enforces it; this says so before a click is wasted.
  const elsewhere = s.assignedTo !== undefined && s.assignedToYou !== true;
  const reviewer = can(props.role, 'review') && !elsewhere;
  const delegate = () =>
    void run(async () => {
      setProblem(undefined);
      const r = await client.delegateStep(props.workspaceId, s.definitionId, s.runId, s.approvalId, to, why.trim());
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      setDelegating(false);
      setDone('Handed over. Only they can decide this step now.');
      props.onChanged('Handed over. Only they can decide this step now.');
    });
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
        {s.workflowName}, {runLabel(s, mode === 'builder')}. Asked {formatWhen(s.requestedAt)}; it times out {formatWhen(s.expiresAt)}.
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
      {elsewhere ? (
        <p className="notice notice-warning small" role="status">
          This step was handed to {s.assignedTo}. Only they can decide it.
        </p>
      ) : s.assignedToYou === true ? (
        <p className="muted small">This step was handed to you.</p>
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
            title={elsewhere ? `Handed to ${s.assignedTo}` : reviewer ? undefined : whyNot(props.role, 'review', 'deciding a step')}
          >
            Approve
          </Button>
          <Button
            onClick={() => decide('reject')}
            disabled={!reviewer}
            pending={busy}
            title={elsewhere ? `Handed to ${s.assignedTo}` : reviewer ? undefined : whyNot(props.role, 'review', 'deciding a step')}
          >
            Reject
          </Button>
          {!delegating ? (
            <Button onClick={() => setDelegating(true)} disabled={!reviewer}>
              Hand to someone else
            </Button>
          ) : null}
          <Button variant="quiet" onClick={() => setShowEvidence(!showEvidence)}>
            Why XO is asking
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
      {delegating && done === undefined ? (
        <div className="cc-confirm" role="group" aria-label="Hand to someone else">
          <label className="small">
            Who should decide it?
            <ReviewerSelect workspaceId={props.workspaceId} value={to} onChange={setTo} />
          </label>
          <label className="small">
            Why?
            <input value={why} onChange={(e) => setWhy(e.target.value)} />
          </label>
          <Button variant="primary" onClick={delegate} disabled={to === '' || why.trim() === ''} pending={busy}>
            Hand over
          </Button>
          <Button variant="quiet" onClick={() => setDelegating(false)} disabled={busy}>
            Not now
          </Button>
        </div>
      ) : null}
      {showEvidence ? <EvidenceView workspaceId={props.workspaceId} definitionId={s.definitionId} runId={s.runId} /> : null}
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
  const { client, mode } = useSession();
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
        {a.workflowName}, {runLabel(a, mode === 'builder')}, started {formatWhen(a.intentAt)}. XO will not send it again on its own. Check{' '}
        {a.connector} and record what you find.
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

/** Reviewers of the workspace, by display name (never by email address). */
function ReviewerSelect(props: { workspaceId: string; value: string; onChange: (id: string) => void }) {
  const { client } = useSession();
  const members = useLoad(() => client.listMembers(props.workspaceId), [client, props.workspaceId]);
  const reviewers = (loadedValue(members.state)?.members ?? []).filter((m) => can(m.role, 'review'));
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      <option value="">Choose a reviewer</option>
      {reviewers.map((m) => (
        <option key={m.identityId} value={m.identityId}>
          {m.displayName ?? m.identityId}
        </option>
      ))}
    </select>
  );
}
