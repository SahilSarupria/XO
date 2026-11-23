import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import { boundsLines, periodWord, reasonsSentence, standingRefusalWords, statusWords } from '../domain/standing';
import type { ApiProblem } from '../platform/client';
import type { WorkspaceRole } from '../platform/wire';
import type { InboxBatch, StandingPeriod, StandingView } from '../platform/wire-control';
import { useGuardedAction } from './actions';
import { argLines } from './ControlCards';
import { Badge, Button, formatWhen, loadedValue, ProblemNotice, useLoad } from './primitives';
import { useSession } from './session';

/**
 * UW-16c (ADR 0051) — standing approvals. One person asks, once, for runs to go ahead without a per-batch approval inside bounds; someone
 * else approves exactly the policy shown (named by its digest). Studio shows what the platform says and sends decisions back: the platform
 * checks the role, the recent sign-in, that the approver is a person and not the one who asked, and the digest. Values (recipients and the
 * like) are never in the policy view; the sample below shows what today's items would do.
 */

const standingProblem = (p: ApiProblem): { title: string; body: string } | undefined => {
  if (p.code !== 'XO_STANDING_APPROVAL_REFUSED') return undefined;
  return { title: 'XO did not accept this', body: standingRefusalWords(p.reason) ?? `${p.message}.` };
};

function Problem(props: { problem: ApiProblem }) {
  const s = standingProblem(props.problem);
  if (s === undefined) return <ProblemNotice problem={props.problem} />;
  return (
    <div className="notice notice-danger" role="alert">
      <strong>{s.title}</strong>
      <p>{s.body}</p>
    </div>
  );
}

function Bounds(props: { s: StandingView }) {
  return (
    <ul className="cc-args sa-bounds" aria-label="What it allows">
      {boundsLines(props.s).map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

/** What today's items would do under it: the sample the proposer was shown, read-only (it is not itself a batch to approve). */
function Sample(props: { workspaceId: string; s: StandingView }) {
  const { client } = useSession();
  const preview = useLoad(
    () => client.getBatchPreview(props.workspaceId, props.s.definitionId, props.s.sample.previewId),
    [client, props.workspaceId, props.s.definitionId, props.s.sample.previewId],
  );
  const p = loadedValue(preview.state);
  if (preview.state.phase === 'error' && p === undefined) return <ProblemNotice problem={preview.state.problem} onRetry={preview.reload} />;
  if (p === undefined) return null;
  return (
    <details className="sa-sample">
      <summary>
        The sample it was asked with ({props.s.sample.items} {props.s.sample.items === 1 ? 'item' : 'items'})
      </summary>
      <ol className="cc-items" aria-label="What each sample item would do">
        {p.items.slice(0, 20).map((it) => (
          <li key={it.index} data-state={it.state} className="cc-item">
            <span className="cc-item-no">#{it.index + 1}</span>
            {it.actions.map((a, j) => (
              <ul key={`${a.step}-${j}`} className="cc-args">
                {argLines(a.args).map((l, k) => (
                  <li key={k}>{l}</li>
                ))}
              </ul>
            ))}
          </li>
        ))}
      </ol>
      {p.total > 20 ? <p className="muted small">The first 20 of {p.total} items.</p> : null}
    </details>
  );
}

/** The Inbox card for a standing approval waiting for a decision. */
export function StandingCard(props: {
  workspaceId: string;
  standingApprovalId: string;
  role: WorkspaceRole | undefined;
  preparedByYou: boolean;
  onChanged: (message?: string) => void;
}) {
  const { client } = useSession();
  const load = useLoad(
    () => client.getStandingApproval(props.workspaceId, props.standingApprovalId),
    [client, props.workspaceId, props.standingApprovalId],
  );
  const s = loadedValue(load.state);
  const [confirming, setConfirming] = useState(false);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const { run, busy } = useGuardedAction();
  const reviewer = can(props.role, 'review');

  const approve = (shown: StandingView) =>
    void run(async () => {
      setProblem(undefined);
      // The digest of the policy on screen: if it changed since it was loaded, the platform refuses this digest.
      const r = await client.approveStandingApproval(props.workspaceId, shown.standingApprovalId, shown.policyDigest);
      setConfirming(false);
      if (!r.ok) return setProblem(r.problem);
      const message = 'Approved. It is recorded as your signed decision; runs inside these bounds can now start without asking each time.';
      setDone(message);
      props.onChanged(message);
    });
  const askForChanges = (shown: StandingView) =>
    void run(async () => {
      setProblem(undefined);
      const r = await client.requestStandingChanges(props.workspaceId, shown.standingApprovalId, comment.trim());
      if (!r.ok) return setProblem(r.problem);
      const message = 'Sent back with your comment. Nothing runs under it.';
      setDone(message);
      props.onChanged(message);
    });

  if (load.state.phase === 'error' && s === undefined) return <ProblemNotice problem={load.state.problem} onRetry={load.reload} />;
  if (s === undefined) return null;
  return (
    <div className="ib-card cc-batch sa-card" aria-label="Standing approval to decide">
      <p className="cc-lead">Let this run without asking each time</p>
      <p className="small">
        Asked by {props.preparedByYou ? 'you' : s.proposedBy} {formatWhen(s.proposedAt)}
        {s.note !== undefined ? `: ${s.note}` : '.'}
      </p>
      <Bounds s={s} />
      <p className="muted small">
        If you approve, it is valid until {formatWhen(s.expiresAt)}. Each run still gets its own preview and its own approval, and anything
        outside these bounds waits for a person here. You can revoke it at any moment.
      </p>
      <Sample workspaceId={props.workspaceId} s={s} />
      {problem !== undefined ? <Problem problem={problem} /> : null}
      {done !== undefined ? (
        <p className="notice notice-success" role="status">
          {done}
        </p>
      ) : null}
      {done === undefined && s.status === 'proposed' ? (
        <div className="cc-actions">
          {props.preparedByYou ? (
            <p className="muted small">
              You asked for this. Someone other than you, and other than the person it runs as, must approve it.
            </p>
          ) : null}
          {!confirming && !asking ? (
            <>
              <Button
                variant="primary"
                onClick={() => setConfirming(true)}
                disabled={!reviewer}
                title={!reviewer ? whyNot(props.role, 'review', 'approving a standing approval') : undefined}
              >
                Approve
              </Button>
              <Button variant="secondary" onClick={() => setAsking(true)} disabled={!reviewer}>
                Ask for changes
              </Button>
            </>
          ) : null}
          {confirming ? (
            <div className="cc-confirm" role="group" aria-label="Confirm approval">
              <p className="small">
                You approve these bounds until {formatWhen(s.expiresAt)}: {boundsLines(s).join(' ')} It is recorded as your signed decision.
              </p>
              <Button variant="primary" onClick={() => approve(s)} pending={busy}>
                Yes, approve
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
                Not now
              </Button>
            </div>
          ) : null}
          {asking ? (
            <div className="cc-confirm" role="group" aria-label="Ask for changes">
              <label className="small" htmlFor={`sa-comment-${s.standingApprovalId}`}>
                What should change?
              </label>
              <textarea id={`sa-comment-${s.standingApprovalId}`} value={comment} onChange={(e) => setComment(e.target.value)} rows={3} />
              <Button variant="primary" onClick={() => askForChanges(s)} pending={busy} disabled={comment.trim() === ''}>
                Send back
              </Button>
              <Button variant="quiet" onClick={() => setAsking(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Why a batch is in the Inbox when it came from a run under a standing approval. */
export function FallbackNote(props: { batch: InboxBatch }) {
  const f = props.batch.standingFallback;
  if (f === undefined) return null;
  return (
    <p className="notice notice-warning small" role="note" aria-label="Why this needs your approval">
      This run needs your approval because: {reasonsSentence(f.reasons)}.
    </p>
  );
}

/** Revoke an approved batch that has not been used. */
export function RevokeBatchApproval(props: {
  workspaceId: string;
  batch: InboxBatch;
  role: WorkspaceRole | undefined;
  onChanged: (message?: string) => void;
}) {
  const { client } = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const { run, busy } = useGuardedAction();
  if (props.batch.approval === undefined || props.batch.approval.usedBy !== undefined) return null;
  const reviewer = can(props.role, 'review');
  return (
    <div className="cc-actions">
      {!open ? (
        <Button
          variant="secondary"
          onClick={() => setOpen(true)}
          disabled={!reviewer}
          title={!reviewer ? whyNot(props.role, 'review', 'revoking an approval') : undefined}
        >
          Revoke approval
        </Button>
      ) : (
        <div className="cc-confirm" role="group" aria-label="Revoke approval">
          <label className="small" htmlFor="sa-batch-revoke">
            Why?
          </label>
          <input id="sa-batch-revoke" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button
            variant="danger"
            pending={busy}
            disabled={reason.trim() === ''}
            onClick={() =>
              void run(async () => {
                setProblem(undefined);
                const r = await client.revokeBatchApproval(
                  props.workspaceId,
                  props.batch.definitionId,
                  props.batch.previewId,
                  reason.trim(),
                );
                if (!r.ok) return setProblem(r.problem);
                props.onChanged('Approval revoked. Nothing starts with it.');
              })
            }
          >
            Revoke it
          </Button>
          <Button variant="quiet" onClick={() => setOpen(false)} disabled={busy}>
            Keep it
          </Button>
        </div>
      )}
      {problem !== undefined ? <Problem problem={problem} /> : null}
    </div>
  );
}

const TONE = { proposed: 'warning', changes_requested: 'warning', active: 'success', expired: 'neutral', revoked: 'danger' } as const;

/** Settings → Standing approvals: every one, its use in the current period against its limits, and revoke. */
export function StandingApprovalsList(props: { workspaceId: string; role: WorkspaceRole | undefined }) {
  const { client } = useSession();
  const load = useLoad(() => client.listStandingApprovals(props.workspaceId), [client, props.workspaceId]);
  const list = loadedValue(load.state);
  const [revoking, setRevoking] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const { run, busy } = useGuardedAction();
  const author = can(props.role, 'author');

  return (
    <section className="xoi-card sa-list" aria-labelledby="sa-h">
      <h3 id="sa-h">Standing approvals</h3>
      <p className="muted small">
        Runs inside these bounds start without asking each time. Revoking stops new runs at once and any further send of a run already
        started.
      </p>
      {load.state.phase === 'error' && list === undefined ? <ProblemNotice problem={load.state.problem} onRetry={load.reload} /> : null}
      {list !== undefined && list.length === 0 ? <p className="muted">None yet. Ask for one from a workflow's page.</p> : null}
      {problem !== undefined ? <Problem problem={problem} /> : null}
      <ul className="sa-items">
        {(list ?? []).map((s) => (
          <li key={s.standingApprovalId} className="sa-item" data-status={s.status}>
            <div className="cc-item-head">
              <strong>{s.standingApprovalId}</strong>
              <Badge tone={TONE[s.status]}>{statusWords(s.status)}</Badge>
            </div>
            {s.usage !== undefined ? (
              <p className="small">
                This {periodWord(s.usage.period)}: {s.usage.runs} of {s.limits.maxRunsPerPeriod} runs, {s.usage.items} of{' '}
                {s.limits.maxItemsPerPeriod} items.
              </p>
            ) : null}
            <p className="muted small">
              Valid until {formatWhen(s.expiresAt)}.
              {s.approvedBy !== undefined
                ? ` Approved by ${s.approvedBy}${s.selfApproved === true ? ' (self-approved: nobody else could)' : ''} ${formatWhen(s.approvedAt ?? '')}.`
                : ''}
              {s.revoked !== undefined ? ` Revoked ${formatWhen(s.revoked.at)}: ${s.revoked.reason}.` : ''}
              {s.changesRequested !== undefined ? ` Sent back: ${s.changesRequested.comment}` : ''}
            </p>
            {s.status === 'active' || s.status === 'proposed' ? (
              revoking === s.standingApprovalId ? (
                <div className="cc-confirm" role="group" aria-label="Revoke standing approval">
                  <label className="small" htmlFor={`sa-rv-${s.standingApprovalId}`}>
                    Why?
                  </label>
                  <input id={`sa-rv-${s.standingApprovalId}`} value={reason} onChange={(e) => setReason(e.target.value)} />
                  {!confirm ? (
                    <Button variant="danger" disabled={reason.trim() === ''} onClick={() => setConfirm(true)}>
                      Revoke
                    </Button>
                  ) : (
                    <>
                      <p className="small">Revoke {s.standingApprovalId}? Nothing starts under it from now on.</p>
                      <Button
                        variant="danger"
                        pending={busy}
                        onClick={() =>
                          void run(async () => {
                            setProblem(undefined);
                            const r = await client.revokeStandingApproval(props.workspaceId, s.standingApprovalId, reason.trim());
                            setConfirm(false);
                            if (!r.ok) return setProblem(r.problem);
                            setRevoking(undefined);
                            setReason('');
                            load.reload();
                          })
                        }
                      >
                        Yes, revoke it
                      </Button>
                    </>
                  )}
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setRevoking(undefined);
                      setConfirm(false);
                    }}
                    disabled={busy}
                  >
                    Keep it
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => setRevoking(s.standingApprovalId)}
                  disabled={!author}
                  title={!author ? whyNot(props.role, 'author', 'revoking') : undefined}
                >
                  Revoke
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

const PERIODS: readonly StandingPeriod[] = ['day', 'week', 'month'];

/** On a workflow's page, after the pre-start check: ask for it to run without asking each time. */
export function ProposeStandingForm(props: {
  workspaceId: string;
  definitionId: string;
  certificateId: string;
  role: WorkspaceRole | undefined;
}) {
  const { client } = useSession();
  const sources = useLoad(() => client.itemSources(props.workspaceId, props.definitionId), [client, props.workspaceId, props.definitionId]);
  const src = loadedValue(sources.state);
  const usable = (src?.sources ?? []).filter((x) => x.usable);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | undefined>();
  const [perRun, setPerRun] = useState<number | undefined>();
  const [period, setPeriod] = useState<StandingPeriod>('week');
  const [excluded, setExcluded] = useState(0);
  const [manual, setManual] = useState(true);
  const [schedule, setSchedule] = useState(false);
  const [days, setDays] = useState(30);
  const [note, setNote] = useState('');
  const [vary, setVary] = useState<readonly string[]>([]);
  const [proposed, setProposed] = useState<StandingView | undefined>();
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const { run, busy } = useGuardedAction();
  const author = can(props.role, 'author');
  const chosen = usable.find((x) => `${x.connectionId}/${x.proposalId}` === picked);
  const n = perRun ?? chosen?.items ?? 1;

  const submit = () =>
    void run(async () => {
      setProblem(undefined);
      if (chosen === undefined) return;
      const triggers = [...(manual ? (['manual'] as const) : []), ...(schedule ? (['schedule'] as const) : [])];
      const r = await client.proposeStandingApproval(props.workspaceId, {
        definitionId: props.definitionId,
        certificateId: props.certificateId,
        items: { connectionId: chosen.connectionId, proposalId: chosen.proposalId },
        limits: { maxItemsPerRun: n, maxItemsPerPeriod: n, maxRunsPerPeriod: 1, period, maxExcludedRows: excluded },
        // Every value is fixed to the sample unless the person says it may change (and the platform refuses to let all of an irreversible step vary).
        mayVary: vary.map((v) => {
          const [step, argument] = v.split('\u0000');
          return { step: step!, argument: argument! };
        }),
        triggers,
        expiresInDays: days,
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      });
      if (!r.ok) return setProblem(r.problem);
      setProposed(r.value);
    });

  if (!author) return null;
  if (src !== undefined && !src.forEach) return null;
  return (
    <section className="wr sa-propose" aria-label="Let this run without asking each time">
      <div className="wp-head">
        <h3>Let this run without asking each time</h3>
      </div>
      {!open ? (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Set this up
        </Button>
      ) : proposed !== undefined ? (
        <div role="status">
          <p className="notice notice-success">Waiting for someone else to approve ({proposed.standingApprovalId}).</p>
          <Bounds s={proposed} />
          {proposed.pinned.length > 0 ? (
            <fieldset className="cc-steps" aria-label="Values that may change">
              <legend className="small">Which values may change?</legend>
              <p className="muted small">
                By default every value is fixed to the sample. A step that cannot be undone keeps at least one fixed.
              </p>
              {proposed.pinned.map((p) => (
                <label key={`${p.step}/${p.argument}`} className="small cc-step-choice">
                  <input
                    type="checkbox"
                    checked={vary.includes(`${p.step}\u0000${p.argument}`)}
                    onChange={(e) =>
                      setVary(
                        e.target.checked
                          ? [...vary, `${p.step}\u0000${p.argument}`]
                          : vary.filter((x) => x !== `${p.step}\u0000${p.argument}`),
                      )
                    }
                  />{' '}
                  "{p.argument}" may change
                </label>
              ))}
              <Button variant="secondary" onClick={submit} pending={busy}>
                Ask again with these changes
              </Button>
            </fieldset>
          ) : null}
          {problem !== undefined ? <Problem problem={problem} /> : null}
        </div>
      ) : (
        <div className="sa-form">
          {sources.state.phase === 'error' && src === undefined ? (
            <ProblemNotice problem={sources.state.problem} onRetry={sources.reload} />
          ) : null}
          <fieldset aria-label="Where the items come from">
            <legend className="small">Where the items come from</legend>
            {usable.length === 0 ? (
              <p className="muted small">No confirmed list or pairing fits this workflow yet. Confirm one in Sources first.</p>
            ) : null}
            {usable.map((x) => (
              <label key={`${x.connectionId}/${x.proposalId}`} className="small cc-radio">
                <input
                  type="radio"
                  name="sa-source"
                  checked={picked === `${x.connectionId}/${x.proposalId}`}
                  onChange={() => setPicked(`${x.connectionId}/${x.proposalId}`)}
                />{' '}
                {x.label} in {x.connectionName} ({x.items} {x.items === 1 ? 'item' : 'items'})
              </label>
            ))}
          </fieldset>
          <label className="small" htmlFor="sa-per-run">
            At most this many in one run
          </label>
          <input id="sa-per-run" type="number" min={1} value={n} onChange={(e) => setPerRun(Math.max(1, Number(e.target.value) || 1))} />
          <label className="small" htmlFor="sa-period">
            Per
          </label>
          <select id="sa-period" value={period} onChange={(e) => setPeriod(e.target.value as StandingPeriod)}>
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <label className="small" htmlFor="sa-excluded">
            Rows that may be left out
          </label>
          <input
            id="sa-excluded"
            type="number"
            min={0}
            value={excluded}
            onChange={(e) => setExcluded(Math.max(0, Number(e.target.value) || 0))}
          />
          <fieldset aria-label="When it may run">
            <legend className="small">When it may run</legend>
            <label className="small">
              <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} /> By hand
            </label>
            <label className="small">
              <input type="checkbox" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} /> On a schedule
            </label>
          </fieldset>
          <label className="small" htmlFor="sa-days">
            How long (days, up to 90)
          </label>
          <input
            id="sa-days"
            type="number"
            min={1}
            max={90}
            value={days}
            onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 1)))}
          />
          <label className="small" htmlFor="sa-note">
            Note for the approver
          </label>
          <input id="sa-note" value={note} onChange={(e) => setNote(e.target.value)} />
          {problem !== undefined ? <Problem problem={problem} /> : null}
          <div className="cc-actions">
            <Button variant="primary" onClick={submit} pending={busy} disabled={chosen === undefined || (!manual && !schedule)}>
              Ask for approval
            </Button>
            <Button variant="quiet" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
