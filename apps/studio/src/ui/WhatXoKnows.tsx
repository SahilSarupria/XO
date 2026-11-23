import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import type { ApiProblem } from '../platform/client';
import type { WorkspaceRole } from '../platform/wire';
import type { ChangeSetView } from '../platform/wire-xo-knowledge';
import { useGuardedAction } from './actions';
import { Badge, Button, EmptyState, formatWhen, loadedValue, ProblemNotice, Skeleton, useLoad } from './primitives';
import { useSession } from './session';

/**
 * UW-12b (ADR 0052) — what XO knows about this workspace. Approved knowledge only changes through a change set that a reviewer
 * approves; this screen shows what is known, what disagrees, which packs give it meaning, what is waiting for review (with what it
 * would change and which workflows it touches) and the history, from which a person can propose going back. Nothing here changes
 * what XO knows by itself: approving, rejecting and rolling back are the platform's own checked decisions.
 */
export function WhatXoKnows(props: { workspaceId: string; role?: WorkspaceRole }) {
  const { client } = useSession();
  const ws = props.workspaceId;
  const head = useLoad(() => client.xoKnowledgeState(ws), [client, ws]);
  const records = useLoad(() => client.xoKnowledgeRecords(ws), [client, ws]);
  const conflicts = useLoad(() => client.xoKnowledgeConflicts(ws), [client, ws]);
  const packs = useLoad(() => client.xoKnowledgePacks(ws), [client, ws]);
  const proposed = useLoad(() => client.xoKnowledgeChangeSets(ws, 'proposed'), [client, ws]);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState<string | undefined>();
  const h = loadedValue(head.state);
  const recordRows = loadedValue(records.state) ?? [];
  const conflictRows = loadedValue(conflicts.state) ?? [];
  const packRows = loadedValue(packs.state) ?? [];
  const [outcome, setOutcome] = useState<string | undefined>();
  const reloadAll = (message?: string) => {
    if (message !== undefined) setOutcome(message);
    head.reload();
    records.reload();
    conflicts.reload();
    proposed.reload();
  };
  return (
    <section className="section wk" aria-labelledby="wk-h">
      <h2 id="wk-h">What XO knows</h2>
      {head.state.phase === 'error' && h === undefined ? <ProblemNotice problem={head.state.problem} onRetry={head.reload} /> : null}
      {h === undefined && head.state.phase !== 'error' ? <Skeleton label="Loading what XO knows" /> : null}
      {h !== undefined ? (
        <p className="cc-lead" aria-label="Summary">
          {h.records.entity} {h.records.entity === 1 ? 'thing' : 'things'}, {h.records.claim} {h.records.claim === 1 ? 'fact' : 'facts'} and{' '}
          {h.records.relationship} {h.records.relationship === 1 ? 'link' : 'links'} are known.{' '}
          {h.conflicts.open === 0
            ? 'Nothing disagrees.'
            : `${h.conflicts.open} ${h.conflicts.open === 1 ? 'disagreement needs' : 'disagreements need'} a decision.`}
        </p>
      ) : null}

      <form
        className="cc-toolbar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim() !== '') setSearched(query.trim());
        }}
      >
        <label className="small">
          Search what XO knows
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Button type="submit" disabled={query.trim() === ''}>
          Search
        </Button>
      </form>
      {searched !== undefined ? <SearchResults key={searched} workspaceId={ws} q={searched} /> : null}

      {outcome !== undefined ? (
        <p className="notice notice-success" role="status">
          {outcome}
        </p>
      ) : null}

      <h3>Known</h3>
      {recordRows.length === 0 ? (
        records.state.phase === 'error' ? (
          <ProblemNotice problem={records.state.problem} onRetry={records.reload} />
        ) : (
          <p className="muted small">Nothing has been approved yet.</p>
        )
      ) : (
        <ul className="cc-args" aria-label="Known records">
          {recordRows.slice(0, 50).map((r) => (
            <li key={r.recordId}>
              {r.label}{' '}
              <span className="muted small">
                ({r.kind}, {r.evidence} {r.evidence === 1 ? 'source' : 'sources'})
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>Disagreements</h3>
      {conflictRows.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        <ul className="cc-args" aria-label="Disagreements">
          {conflictRows.map((c) => (
            <li key={c.id}>
              {c.reason}{' '}
              <Badge tone={c.status === 'unresolved' ? 'warning' : 'neutral'}>{c.status === 'unresolved' ? 'Open' : 'Settled'}</Badge>
            </li>
          ))}
        </ul>
      )}

      <h3>Knowledge packs</h3>
      {packRows.length === 0 ? (
        <p className="muted small">No pack is installed. XO keeps what it knows but does not interpret it.</p>
      ) : (
        <ul className="cc-args" aria-label="Installed packs">
          {packRows.map((p) => (
            <li key={p.namespace}>
              {p.packId} {p.version} <span className="muted small">({p.namespace})</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Waiting for review</h3>
      {(loadedValue(proposed.state) ?? []).length === 0 ? (
        <p className="muted small">No change is waiting.</p>
      ) : (
        <ul className="ib-rows" aria-label="Changes waiting for review">
          {(loadedValue(proposed.state) ?? []).map((c) => (
            <li key={c.changeSetId}>
              <ChangeSetCard workspaceId={ws} role={props.role} changeSet={c} onChanged={reloadAll} />
            </li>
          ))}
        </ul>
      )}

      <History workspaceId={ws} role={props.role} onChanged={() => reloadAll()} />
    </section>
  );
}

const originWords = (origin: string): string => {
  switch (origin) {
    case 'run-outcome':
      return 'Proposed from what happened in a run';
    case 'rollback':
      return 'Proposed to go back to an earlier state';
    case 'xoir-reconciliation':
      return 'Proposed from a compiled workflow';
    case 'model-derivation':
      return 'Read from a source by a model, checked against it';
    case 'import':
      return 'Imported';
    default:
      return 'Proposed by a person';
  }
};

function ChangeSetCard(props: {
  workspaceId: string;
  role?: WorkspaceRole;
  changeSet: ChangeSetView;
  onChanged: (message?: string) => void;
}) {
  const { client } = useSession();
  const c = props.changeSet;
  const preview = useLoad(
    () => client.xoKnowledgeChangeSetPreview(props.workspaceId, c.changeSetId),
    [client, props.workspaceId, c.changeSetId],
  );
  const p = loadedValue(preview.state);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const { run, busy } = useGuardedAction();
  const reviewer = can(props.role, 'review');
  const decide = (action: 'approve' | 'reject') =>
    void run(async () => {
      setProblem(undefined);
      const r = await client.decideKnowledgeChangeSet(props.workspaceId, c.changeSetId, action, reason.trim());
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      const message = action === 'approve' ? 'Approved. XO now knows this.' : 'Rejected. XO knowledge is unchanged.';
      setDone(message);
      props.onChanged(message);
    });
  return (
    <div className="ib-card" aria-label="A change waiting for review">
      <p className="cc-lead">{originWords(c.origin)}</p>
      <p className="muted small">
        By {c.proposedBy} {formatWhen(c.proposedAt)}; {c.operations} {c.operations === 1 ? 'change' : 'changes'}.
      </p>
      {preview.state.phase === 'error' && p === undefined ? (
        <ProblemNotice problem={preview.state.problem} onRetry={preview.reload} />
      ) : null}
      {p !== undefined ? (
        <>
          <ul className="cc-args" aria-label="What it would change">
            {p.diff.added > 0 ? <li>{p.diff.added} added</li> : null}
            {p.diff.superseded > 0 ? <li>{p.diff.superseded} replaced by newer facts</li> : null}
            {p.diff.retired > 0 ? <li>{p.diff.retired} retired</li> : null}
            {p.diff.restored > 0 ? <li>{p.diff.restored} restored</li> : null}
            {p.diff.conflictsOpened > 0 ? <li>{p.diff.conflictsOpened} new disagreements</li> : null}
          </ul>
          <p className="small" aria-label="Workflows it touches">
            {p.affected.count === 0
              ? 'No certified workflow uses this knowledge.'
              : `It touches ${p.affected.count} certified ${p.affected.count === 1 ? 'workflow' : 'workflows'}, which will need certifying again if their knowledge changes.`}
          </p>
          {p.stale ? (
            <p className="notice notice-warning small">
              What XO knows has changed since this was proposed. It cannot be approved as it is.
            </p>
          ) : null}
          {p.findings.map((f) => (
            <p key={f.message} className="small muted">
              {f.message}
            </p>
          ))}
        </>
      ) : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {done !== undefined ? (
        <p className="notice notice-success" role="status">
          {done}
        </p>
      ) : (
        <div className="cc-actions">
          <label className="small">
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button
            variant="primary"
            onClick={() => decide('approve')}
            disabled={!reviewer || reason.trim() === '' || p?.stale === true}
            pending={busy}
            title={reviewer ? undefined : whyNot(props.role, 'review', 'approving knowledge')}
          >
            Approve
          </Button>
          <Button onClick={() => decide('reject')} disabled={!reviewer || reason.trim() === ''} pending={busy}>
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

function History(props: { workspaceId: string; role?: WorkspaceRole; onChanged: () => void }) {
  const { client } = useSession();
  const states = useLoad(() => client.xoKnowledgeStates(props.workspaceId), [client, props.workspaceId]);
  const list = loadedValue(states.state);
  const [target, setTarget] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const { run, busy } = useGuardedAction();
  const reviewer = can(props.role, 'review');
  const rollback = () =>
    void run(async () => {
      if (target === undefined) return;
      setProblem(undefined);
      const r = await client.proposeKnowledgeRollback(props.workspaceId, target, reason.trim());
      if (!r.ok) {
        setProblem(r.problem);
        return;
      }
      setNote('Proposed. Someone else has to approve it before XO goes back.');
      setTarget(undefined);
      setReason('');
      props.onChanged();
    });
  const verify = (stateId: string) =>
    void run(async () => {
      const r = await client.verifyKnowledgeState(props.workspaceId, stateId);
      setNote(r.ok ? (r.value.verified ? 'Checked: nothing was altered.' : `Checked: ${r.value.findings} problems found.`) : undefined);
      if (!r.ok) setProblem(r.problem);
    });
  if (list === undefined)
    return states.state.phase === 'error' ? <ProblemNotice problem={states.state.problem} onRetry={states.reload} /> : null;
  return (
    <>
      <h3>History</h3>
      {list.states.length === 0 ? <EmptyState title="No history yet">Each approved change appears here.</EmptyState> : null}
      <ol className="cc-items" aria-label="Earlier states of what XO knows">
        {list.states.map((s, i) => (
          <li key={s.stateId} className="cc-item">
            <span className="small">
              {i === 0 ? 'Now' : formatWhen(s.createdAt)} <span className="muted">({s.stateId.slice(0, 12)})</span>
            </span>{' '}
            <Button variant="quiet" onClick={() => verify(s.stateId)} disabled={busy}>
              Check it
            </Button>
            {i > 0 ? (
              <Button
                variant="quiet"
                onClick={() => setTarget(s.stateId)}
                disabled={!reviewer}
                title={reviewer ? undefined : whyNot(props.role, 'review', 'going back')}
              >
                Go back to this
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
      {target !== undefined ? (
        <div className="cc-confirm" role="group" aria-label="Go back">
          <p className="small">
            This proposes going back to state {target.slice(0, 12)}. Everything approved since is set aside, not deleted, and someone else
            has to approve the change.
          </p>
          <label className="small">
            Why?
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button variant="primary" onClick={rollback} disabled={reason.trim() === ''} pending={busy}>
            Propose going back
          </Button>
          <Button variant="quiet" onClick={() => setTarget(undefined)}>
            Not now
          </Button>
        </div>
      ) : null}
      {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      {note !== undefined ? (
        <p className="notice notice-success" role="status">
          {note}
        </p>
      ) : null}
    </>
  );
}

function SearchResults(props: { workspaceId: string; q: string }) {
  const { client } = useSession();
  const hits = useLoad(() => client.xoKnowledgeSearch(props.workspaceId, props.q), [client, props.workspaceId, props.q]);
  const list = loadedValue(hits.state);
  if (hits.state.phase === 'error' && list === undefined) return <ProblemNotice problem={hits.state.problem} onRetry={hits.reload} />;
  if (list === undefined) return <Skeleton label="Searching" />;
  if (list.length === 0)
    return (
      <p className="muted small" role="status">
        Nothing matches &ldquo;{props.q}&rdquo;.
      </p>
    );
  return (
    <ul className="cc-args" aria-label="Search results">
      {list.map((x) => (
        <li key={x.recordId}>
          {x.text}{' '}
          <span className="muted small">
            ({x.type}, {x.evidence} {x.evidence === 1 ? 'source' : 'sources'})
          </span>
        </li>
      ))}
    </ul>
  );
}
