import { useEffect, useMemo, useRef, useState } from 'react';
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
import { RunSummary, runTitle } from './RunCard';
import { ExecutionOutcome } from './runs';
import { BatchCard, ReconcileCard, RuntimeStepCard } from './ControlCards';
import { FallbackNote, RevokeBatchApproval, StandingCard } from './StandingApprovals';
import type { InboxAttention, InboxBatch, InboxStep, StandingInbox } from '../platform/wire-control';

type StandingInboxProposal = StandingInbox['proposals'][number];
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
  // UW-12b: work on the workflow runtime that waits for a person (batches, steps, unknown outcomes). An older platform without
  // this read, or a failure, leaves these out; the rest of the inbox still works.
  const control = useLoad(() => client.controlInbox(props.workspaceId), [client, props.workspaceId, props.runs]);
  const runtime = loadedValue(control.state);
  // UW-12b (ADR 0052): keep the inbox live. A long request waits on the platform until the inbox differs from what is shown, then the
  // list reloads. It stops when the inbox closes (the loop ends and a late answer is ignored) and backs off after a failure.
  const etagRef = useRef<string | undefined>(undefined);
  etagRef.current = runtime?.etag;
  const reloadControl = useRef(control.reload);
  reloadControl.current = control.reload;
  const live = runtime?.etag !== undefined;
  useEffect(() => {
    if (!live) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
    void (async () => {
      while (!stopped) {
        const tag = etagRef.current;
        if (tag === undefined) {
          await sleep(200);
          continue;
        }
        const r = await client.inboxChanges(props.workspaceId, tag, 25);
        if (stopped) return;
        if (!r.ok) {
          await sleep(5000);
          continue;
        }
        if (r.value.changed && r.value.etag !== etagRef.current) {
          etagRef.current = r.value.etag;
          reloadControl.current();
        }
      }
    })();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, props.workspaceId, live]);
  // What the person just did on a runtime item; the item itself may leave the list on the reload, so the outcome is kept here.
  const [outcome, setOutcome] = useState<string | undefined>();
  const changed = (message?: string) => {
    if (message !== undefined) setOutcome(message);
    control.reload();
    props.onChanged();
  };
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
    ...(runtime?.standing.proposals ?? []).map((sp): InboxItem => ({
      key: `standing:${sp.standingApprovalId}`,
      title: 'Let a workflow run without asking each time',
      sub: sp.preparedByYou
        ? 'Asked by you \u00b7 waiting for someone else'
        : `${sp.items} ${sp.items === 1 ? 'item' : 'items'} in the sample \u00b7 waiting for your approval`,
      badge: 'Approve a standing approval',
      standing: sp,
    })),
    ...(runtime?.batches ?? []).map((b): InboxItem => ({
      key: `batch:${b.previewId}`,
      title: `${tidyName(b.workflowName)}: ${b.total} ${b.total === 1 ? 'item' : 'items'}`,
      sub:
        b.state === 'ready_to_start'
          ? `Approved by ${b.approval?.reviewerId ?? 'a reviewer'} \u00b7 ready to start`
          : b.preparedByYou
            ? 'Prepared by you \u00b7 waiting for a reviewer'
            : `Prepared by ${b.createdBy} \u00b7 waiting for your approval`,
      badge: b.state === 'ready_to_start' ? 'Ready to start' : 'Approve the batch',
      batch: b,
    })),
    ...(runtime?.steps ?? []).map((st): InboxItem => ({
      key: `rstep:${st.runId}:${st.approvalId}`,
      title: tidyName(st.workflowName),
      sub: `${st.summary}${st.item !== undefined ? ` \u00b7 item ${st.item + 1}` : ''}`,
      badge: 'Needs a decision',
      runtimeStep: st,
    })),
    ...(runtime?.attention ?? []).map((a): InboxItem => ({
      key: `effect:${a.runId}:${a.step}`,
      title: tidyName(a.workflowName),
      sub: `Outcome unknown \u00b7 ${a.connector}${a.item !== undefined ? ` \u00b7 item ${a.item + 1}` : ''}`,
      badge: 'Check what happened',
      attention: a,
    })),
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
        {outcome !== undefined ? (
          <p className="notice notice-success" role="status">
            {outcome}
          </p>
        ) : null}
        {runtime?.truncated === true ? (
          <p className="muted small" role="status">
            More is waiting on the workflow runtime than is shown here; deal with these first.
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
            {selected.batch !== undefined ? (
              <>
                <FallbackNote batch={selected.batch} />
                <BatchCard
                  key={selected.key}
                  workspaceId={props.workspaceId}
                  batch={selected.batch}
                  role={props.role}
                  onChanged={changed}
                />
                <RevokeBatchApproval workspaceId={props.workspaceId} batch={selected.batch} role={props.role} onChanged={changed} />
              </>
            ) : null}
            {selected.standing !== undefined ? (
              <StandingCard
                key={selected.key}
                workspaceId={props.workspaceId}
                standingApprovalId={selected.standing.standingApprovalId}
                role={props.role}
                preparedByYou={selected.standing.preparedByYou}
                onChanged={changed}
              />
            ) : null}
            {selected.runtimeStep !== undefined ? (
              <RuntimeStepCard
                key={selected.key}
                workspaceId={props.workspaceId}
                step={selected.runtimeStep}
                role={props.role}
                onChanged={changed}
              />
            ) : null}
            {selected.attention !== undefined ? (
              <ReconcileCard
                key={selected.key}
                workspaceId={props.workspaceId}
                attention={selected.attention}
                role={props.role}
                onChanged={changed}
              />
            ) : null}
            {selected.stopped !== undefined ? (
              <div className="ib-card">
                <p className="small">
                  This process was started by the old runner and stopped before it finished. That runner was removed, so it cannot be
                  continued; its steps are kept for reference.
                </p>
                <RunSummary run={selected.stopped} />
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
  /** UW-12b: work on the workflow runtime. */
  readonly batch?: InboxBatch;
  readonly standing?: StandingInboxProposal;
  readonly runtimeStep?: InboxStep;
  readonly attention?: InboxAttention;
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

  const pending = busy || settling;
  // ADR 0052: a process started by the removed composed runner can no longer be decided or continued; it is kept for reference.
  const canDecide = false;
  const decideHint =
    'This process was started by the old runner, which was removed. It is kept for reference and can no longer be decided.';
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
              onClick={() => undefined}
            >
              {props.inbox === true ? 'Approve' : 'Approve this step'}
            </Button>
            <Button
              variant="danger"
              pending={pending}
              disabled={!canDecide}
              title={decideHint}
              aria-label="Reject and stop"
              onClick={() => undefined}
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
