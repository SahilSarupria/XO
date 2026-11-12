import { useEffect, useMemo, useState } from 'react';
import {
  currentStep,
  describeResumeProblem,
  isAmbiguousFailure,
  normalizeNote,
  pendingTasks,
  recoverableRuns,
  standaloneExecutions,
  tidyName,
  type RecordedNote,
} from '../domain/work';
import type { Capability, Execution, WorkflowRun } from '../platform/wire';
import { ActionNoticeView, Confirmation, useGuardedAction, type ActionNotice } from './actions';
import { can, whyNot } from '../domain/access';
import type { WorkspaceRole } from '../platform/wire';
import { Badge, Button, EmptyState, formatWhen, loadedValue, useLoad } from './primitives';
import { DoneList, InfoThread, NotificationsPanel } from './InboxExtras';
import { NoteField } from './NoteField';
import { RecoveryCard } from './RecoveryCard';
import { RunSummary, runTitle } from './RunCard';
import { ExecutionOutcome } from './runs';
import { useSession } from './session';
import '../styles/inbox.css';

/**
 * Everything waiting for a person. Workflow decisions go through the platform's resume contract:
 * the decision is sent with the step execution and revision of the *freshly fetched* run, so a
 * decision can never land on a step the person did not see.
 */
export function TasksSection(props: {
  workspaceId: string;
  runs: readonly WorkflowRun[];
  executions: readonly Execution[];
  caps: readonly Capability[];
  notes: ReadonlyMap<string, RecordedNote>;
  /** The runs or executions list failed to load: do not claim that nothing is waiting. */
  incomplete: boolean;
  onOpenActivity?: () => void;
  onChanged: () => void;
  /** The caller's role, used only to decide what to offer; the platform enforces every action. */
  role?: WorkspaceRole;
}) {
  const { client } = useSession();
  const [tab, setTab] = useState<'needs' | 'done'>('needs');
  const [pickedDone, setPickedDone] = useState<string | undefined>();
  // The platform's view of the same human tasks: open questions per item and the Done list. If it cannot be loaded (an older
  // platform, or a failure) the screen simply works without those extras rather than claiming anything about them.
  const inbox = useLoad(() => client.listInbox(props.workspaceId), [client, props.workspaceId, props.runs, props.executions]);
  const meta = loadedValue(inbox.state);
  const openQuestions = new Map((meta?.items ?? []).map((i) => [i.executionId, i.openInfoRequests]));
  const doneItems = (meta?.items ?? []).filter((i) => i.state === 'done');
  const tasks = pendingTasks(props.runs);
  const interrupted = recoverableRuns(props.runs);
  const single = useMemo(
    () =>
      standaloneExecutions(props.executions, props.runs).filter(
        (e) => e.status === 'waiting_for_human' && e.humanTask?.status === 'pending',
      ),
    [props.executions, props.runs],
  );
  const names = useMemo(() => new Map(props.caps.map((c) => [c.capabilityId, c.name])), [props.caps]);
  // A run that has just been decided to its end stops being "waiting" and would vanish from this list.
  // Keep what the platform returned so the person sees the outcome of what they just did.
  const [finished, setFinished] = useState<WorkflowRun[]>([]);
  const [banner, setBanner] = useState<string | undefined>();
  const [picked, setPicked] = useState<string | undefined>();

  /** One list for everything waiting on a person. The detail pane always shows the platform's own record for the chosen item. */
  const items: InboxItem[] = [
    ...tasks.map((r): InboxItem => ({
      key: `run:${r.workflowExecutionId}`,
      title: runTitle(r),
      sub: `${r.workflowName} \u00b7 step ${(r.currentStepIndex ?? 0) + 1} of ${r.steps.length}`,
      badge: `Step ${(r.currentStepIndex ?? 0) + 1} of ${r.steps.length}`,
      run: r,
      ...(r.currentStepExecutionId !== undefined ? { executionId: r.currentStepExecutionId } : {}),
    })),
    ...interrupted.map((r): InboxItem => ({
      key: `stopped:${r.workflowExecutionId}`,
      title: runTitle(r),
      sub: `${r.workflowName} \u00b7 stopped`,
      badge: 'Stopped',
      stopped: r,
    })),
    ...single.map((e): InboxItem => {
      const title = tidyName(names.get(e.capabilityId) ?? 'A rule from an earlier analysis');
      return {
        key: `rule:${e.executionId}`,
        title,
        sub: `Started ${formatWhen(e.requestedAt)}`,
        badge: 'Needs a decision',
        execution: e,
        executionId: e.executionId,
      };
    }),
  ];
  const selected = items.find((i) => i.key === picked) ?? items[0];
  const justDecided = finished.filter((f) => !tasks.some((t) => t.workflowExecutionId === f.workflowExecutionId));

  return (
    <div className="ib" role="region" aria-label="Inbox">
      <div className="ib-list">
        <p className="ib-title">Inbox</p>
        <div className="ib-chips" role="group" aria-label="Inbox view">
          <button type="button" className="ib-chip" aria-pressed={tab === 'needs'} onClick={() => setTab('needs')}>
            Needs review {items.length}
          </button>
          {meta !== undefined ? (
            <button type="button" className="ib-chip" aria-pressed={tab === 'done'} onClick={() => setTab('done')}>
              Done {meta.counts.done}
            </button>
          ) : null}
        </div>
        {banner !== undefined ? (
          <p className="notice notice-warning" role="alert">
            {banner}
          </p>
        ) : null}
        {tab === 'done' ? <DoneList items={doneItems} picked={pickedDone ?? doneItems[0]?.executionId} onPick={setPickedDone} /> : null}
        {tab === 'needs' && items.length > 0 ? (
          <ul className="ib-rows" aria-label="Waiting for a person">
            {items.map((i) => (
              <li key={i.key}>
                <button
                  type="button"
                  className="ib-row"
                  aria-current={selected?.key === i.key ? 'true' : undefined}
                  onClick={() => setPicked(i.key)}
                >
                  <span className="ib-row-title">{i.title}</span>
                  <span className="ib-row-sub">
                    {i.sub}
                    {i.executionId !== undefined && (openQuestions.get(i.executionId) ?? 0) > 0
                      ? ` · ${openQuestions.get(i.executionId)} open ${openQuestions.get(i.executionId) === 1 ? 'question' : 'questions'}`
                      : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {tab === 'needs' && justDecided.length > 0 ? (
          <>
            <h2 className="ib-sub">Just decided</h2>
            <ul className="ib-rows">
              {justDecided.map((r) => (
                <li key={r.workflowExecutionId} className="ib-decided">
                  <span className="ib-row-title">{runTitle(r)}</span>
                  <RunSummary run={r} notes={props.notes} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <NotificationsPanel workspaceId={props.workspaceId} />
      </div>
      <div className="ib-detail">
        {tab === 'done' ? (
          <DoneDetail
            workspaceId={props.workspaceId}
            role={props.role}
            item={doneItems.find((d) => d.executionId === (pickedDone ?? doneItems[0]?.executionId))}
          />
        ) : selected === undefined ? (
          props.incomplete ? (
            <p className="notice notice-warning small" role="status">
              Decisions could not be loaded, so XO cannot tell whether anything is waiting. Use Retry above.
            </p>
          ) : (
            <EmptyState title="Nothing is waiting for you">
              When a process needs a decision, it will appear here.
              {props.onOpenActivity !== undefined ? (
                <>
                  {' '}
                  <button type="button" className="crumb-link" onClick={props.onOpenActivity}>
                    See past activity
                  </button>
                </>
              ) : null}
            </EmptyState>
          )
        ) : (
          <>
            <div className="ib-head">
              <h2>{selected.title}</h2>
              <Badge tone="warning">{selected.badge}</Badge>
            </div>
            {selected.run !== undefined ? (
              <DecisionCard
                key={selected.key}
                inbox
                workspaceId={props.workspaceId}
                run={selected.run}
                role={props.role}
                notes={props.notes}
                onChanged={props.onChanged}
                onFinished={(done) => setFinished((f) => [done, ...f.filter((x) => x.workflowExecutionId !== done.workflowExecutionId)])}
              />
            ) : null}
            {selected.stopped !== undefined ? (
              <div className="ib-card">
                <RecoveryCard workspaceId={props.workspaceId} run={selected.stopped} onChanged={props.onChanged} onInfo={setBanner} />
              </div>
            ) : null}
            {selected.execution !== undefined ? (
              <div className="ib-card">
                <ExecutionOutcome
                  workspaceId={props.workspaceId}
                  execution={selected.execution}
                  role={props.role}
                  onChanged={props.onChanged}
                />
              </div>
            ) : null}
            {selected.executionId !== undefined ? (
              <InfoThread
                key={selected.executionId}
                workspaceId={props.workspaceId}
                executionId={selected.executionId}
                role={props.role}
                onChanged={inbox.reload}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

interface InboxItem {
  readonly key: string;
  readonly title: string;
  readonly sub: string;
  readonly badge: string;
  readonly run?: WorkflowRun;
  readonly stopped?: WorkflowRun;
  readonly execution?: Execution;
  /** The platform's human-task id for this item, when it has one (what questions are attached to). */
  readonly executionId?: string;
}

export function DecisionCard(props: {
  workspaceId: string;
  run: WorkflowRun;
  notes?: ReadonlyMap<string, RecordedNote>;
  onChanged: () => void;
  onFinished?: (run: WorkflowRun) => void;
  /** Inbox layout: the title is shown by the pane header, and the buttons read Approve / Reject (same accessible names). */
  inbox?: boolean;
  role?: WorkspaceRole;
}) {
  const { client } = useSession();
  const [run, setRun] = useState(props.run);
  const [notice, setNotice] = useState<ActionNotice | undefined>();
  const [confirmed, setConfirmed] = useState<string | undefined>();
  // Kept through a conflict or an unclear failure so nothing the person typed is lost; cleared only once the platform accepted the decision.
  const [noteText, setNoteText] = useState('');
  const { run: guard, busy, settling } = useGuardedAction();

  useEffect(() => {
    if (props.run.revision > run.revision) setRun(props.run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.run]);

  const step = currentStep(run);
  const waiting = run.status === 'waiting_for_human' && run.pendingHumanTask !== undefined && run.currentStepExecutionId !== undefined;

  async function refresh(): Promise<WorkflowRun | undefined> {
    const r = await client.getWorkflowRun(props.workspaceId, run.workflowExecutionId);
    if (r.ok) {
      setRun(r.value);
      return r.value;
    }
    setNotice({ problem: r.problem });
    return undefined;
  }

  function decide(decision: 'approve' | 'reject') {
    const n = normalizeNote(noteText);
    if (n.error !== undefined) {
      setNotice({ info: n.error });
      return;
    }
    void guard(async () => {
      setNotice(undefined);
      setConfirmed(undefined);
      // 1. Authoritative state first. Never act on a copy the person may have been looking at for a while.
      const fresh = await client.getWorkflowRun(props.workspaceId, run.workflowExecutionId);
      if (!fresh.ok) {
        setNotice({ problem: fresh.problem });
        return undefined;
      }
      const f = fresh.value;
      setRun(f);
      const stillSame =
        f.status === 'waiting_for_human' &&
        f.currentStepExecutionId !== undefined &&
        f.currentStepExecutionId === run.currentStepExecutionId;
      if (!stillSame) {
        setNotice({
          info:
            f.status === 'waiting_for_human'
              ? 'This process moved to a different step since you opened it. Your decision was not sent. Review the current step and choose again.'
              : 'This process is no longer waiting for a decision, so yours was not sent.',
        });
        props.onChanged();
        return undefined;
      }
      // 2. Send the decision with the identifiers from that fresh record.
      const r = await client.resumeWorkflowRun(props.workspaceId, f.workflowExecutionId, {
        decision,
        expectedStepExecutionId: f.currentStepExecutionId!,
        expectedRevision: f.revision,
        ...(n.note !== undefined ? { note: n.note } : {}),
      });
      if (r.ok) {
        setRun(r.value);
        setNoteText('');
        setConfirmed('Decision recorded.');
        if (r.value.status !== 'waiting_for_human') props.onFinished?.(r.value);
        props.onChanged();
        return { settle: true };
      }
      // 3. Failure. Never resend. Re-read the truth and say what is known.
      const known = describeResumeProblem(r.problem);
      if (known !== undefined) {
        setNotice({ view: known });
        await refresh();
        props.onChanged();
      } else if (isAmbiguousFailure(r.problem)) {
        const after = await refresh();
        setNotice({
          info:
            after !== undefined && after.revision !== f.revision
              ? 'XO did not confirm your decision, but its records show this process has since moved on. Check the steps below before doing anything else.'
              : 'XO did not confirm your decision. Nothing was resent. Its latest records are shown below; choose again only if the step is still waiting.',
        });
        props.onChanged();
      } else {
        setNotice({ problem: r.problem });
      }
      return undefined;
    });
  }

  const pending = busy || settling;
  const canDecide = can(props.role, 'review');
  const decideHint = canDecide ? undefined : whyNot(props.role, 'review', 'approving or rejecting');
  return (
    <div className={props.inbox === true ? 'ib-card' : 'card-main'}>
      {props.inbox === true ? null : <h3>{runTitle(run)}</h3>}
      {waiting && step !== undefined ? (
        <div className="decision">
          <p>
            <strong>
              Step {(run.currentStepIndex ?? 0) + 1} of {run.steps.length}: {tidyName(step.capabilityName)}
            </strong>
          </p>
          <p className="muted small">
            A person needs to decide whether this step is done correctly. Approving lets the process continue; rejecting stops it.
          </p>
          <NoteField value={noteText} onChange={setNoteText} disabled={busy} />
          <div className="row">
            <Button
              variant="primary"
              pending={pending}
              disabled={!canDecide}
              title={decideHint}
              aria-label="Approve this step"
              onClick={() => decide('approve')}
            >
              {props.inbox === true ? 'Approve' : 'Approve this step'}
            </Button>
            <Button
              variant="danger"
              pending={pending}
              disabled={!canDecide}
              title={decideHint}
              aria-label="Reject and stop"
              onClick={() => decide('reject')}
            >
              {props.inbox === true ? 'Reject' : 'Reject and stop'}
            </Button>
          </div>
        </div>
      ) : null}
      <Confirmation message={confirmed} />
      <ActionNoticeView notice={notice} />
      <RunSummary run={run} {...(props.notes !== undefined ? { notes: props.notes } : {})} />
    </div>
  );
}

function DoneDetail(props: {
  workspaceId: string;
  role: WorkspaceRole | undefined;
  item: import('../platform/wire-studio').InboxItem | undefined;
}) {
  const i = props.item;
  if (i === undefined)
    return <EmptyState title="Nothing has been decided yet">Decisions you and your team make will be listed here.</EmptyState>;
  return (
    <>
      <div className="ib-head">
        <h2>{i.title}</h2>
        <Badge tone={i.decision === 'approve' ? 'success' : i.decision === 'reject' ? 'danger' : 'neutral'}>
          {i.decision === 'approve' ? 'Approved' : i.decision === 'reject' ? 'Rejected' : 'Decided'}
        </Badge>
      </div>
      <div className="ib-card">
        <p className="small">
          {i.resolverIdentityId !== undefined ? `Decided by ${i.resolverIdentityId}` : 'Decided'}
          {i.resolvedAt !== undefined ? ` · ${formatWhen(i.resolvedAt)}` : ''}
        </p>
        {i.sourceFilename !== undefined ? <p className="muted small">From {i.sourceFilename}</p> : null}
        {i.confidence !== undefined ? <p className="muted small">XO&apos;s confidence in this rule when it asked: {i.confidence}</p> : null}
      </div>
      <InfoThread key={i.executionId} workspaceId={props.workspaceId} executionId={i.executionId} role={props.role} resolved />
    </>
  );
}
