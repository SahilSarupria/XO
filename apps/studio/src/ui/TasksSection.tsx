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
import { Button, EmptyState, formatWhen, Section } from './primitives';
import { NoteField } from './NoteField';
import { RecoveryCard } from './RecoveryCard';
import { RunSummary, runTitle } from './RunCard';
import { ExecutionOutcome } from './runs';
import { useSession } from './session';

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
}) {
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

  return (
    <Section id="tasks-h" title="Tasks" lede="Decisions waiting for a person, and processes that stopped and can be continued.">
      {banner !== undefined ? (
        <p className="notice notice-warning" role="alert">
          {banner}
        </p>
      ) : null}
      {!props.incomplete && tasks.length === 0 && single.length === 0 && interrupted.length === 0 ? (
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
      ) : null}
      {props.incomplete && tasks.length === 0 && single.length === 0 && interrupted.length === 0 ? (
        <p className="notice notice-warning small" role="status">
          Decisions could not be loaded, so XO cannot tell whether anything is waiting. Use Retry above.
        </p>
      ) : null}
      <ul className="list">
        {tasks.map((r) => (
          <li key={r.workflowExecutionId} className="card">
            <DecisionCard
              workspaceId={props.workspaceId}
              run={r}
              notes={props.notes}
              onChanged={props.onChanged}
              onFinished={(done) => setFinished((f) => [done, ...f.filter((x) => x.workflowExecutionId !== done.workflowExecutionId)])}
            />
          </li>
        ))}
        {interrupted.map((r) => (
          <li key={r.workflowExecutionId} className="card">
            <RecoveryCard workspaceId={props.workspaceId} run={r} onChanged={props.onChanged} onInfo={setBanner} />
          </li>
        ))}
        {single.map((e) => (
          <li key={e.executionId} className="card">
            <div className="card-main">
              <h3>{tidyName(names.get(e.capabilityId) ?? 'A rule from an earlier analysis')}</h3>
              <p className="muted small">Started {formatWhen(e.requestedAt)}</p>
              <ExecutionOutcome workspaceId={props.workspaceId} execution={e} onChanged={props.onChanged} />
            </div>
          </li>
        ))}
      </ul>
      {finished.length > 0 ? (
        <>
          <h3 className="subhead">Just decided</h3>
          <ul className="list">
            {finished
              .filter((f) => !tasks.some((t) => t.workflowExecutionId === f.workflowExecutionId))
              .map((r) => (
                <li key={r.workflowExecutionId} className="card">
                  <div className="card-main">
                    <h3>{runTitle(r)}</h3>
                    <RunSummary run={r} notes={props.notes} />
                  </div>
                </li>
              ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}

export function DecisionCard(props: {
  workspaceId: string;
  run: WorkflowRun;
  notes?: ReadonlyMap<string, RecordedNote>;
  onChanged: () => void;
  onFinished?: (run: WorkflowRun) => void;
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
  return (
    <div className="card-main">
      <h3>{runTitle(run)}</h3>
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
            <Button variant="primary" pending={pending} onClick={() => decide('approve')}>
              Approve this step
            </Button>
            <Button variant="danger" pending={pending} onClick={() => decide('reject')}>
              Reject and stop
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
