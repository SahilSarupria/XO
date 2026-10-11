import { useEffect, useMemo, useRef, useState } from 'react';
import {
  currentStep,
  describeResumeProblem,
  pendingTasks,
  recoverableRuns,
  standaloneExecutions,
  tidyName,
  type WorkProblemView,
} from '../domain/work';
import type { ApiProblem } from '../platform/client';
import type { Capability, Execution, WorkflowRun } from '../platform/wire';
import { EmptyState, formatWhen, ProblemNotice, Section } from './primitives';
import { Button } from './primitives';
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
      {tasks.length === 0 && single.length === 0 && interrupted.length === 0 ? (
        <EmptyState title="Nothing is waiting for you">When a process needs a decision, it will appear here.</EmptyState>
      ) : null}
      <ul className="list">
        {tasks.map((r) => (
          <li key={r.workflowExecutionId} className="card">
            <DecisionCard
              workspaceId={props.workspaceId}
              run={r}
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
                    <RunSummary run={r} />
                  </div>
                </li>
              ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}

const SETTLE_MS = 700;

type Notice = { readonly view: WorkProblemView } | { readonly info: string } | { readonly problem: ApiProblem };

function isAmbiguous(p: ApiProblem): boolean {
  return p.kind === 'network' || p.kind === 'server' || p.kind === 'malformed';
}

export function DecisionCard(props: {
  workspaceId: string;
  run: WorkflowRun;
  onChanged: () => void;
  onFinished?: (run: WorkflowRun) => void;
}) {
  const { client } = useSession();
  const [run, setRun] = useState(props.run);
  const [notice, setNotice] = useState<Notice | undefined>();
  const [busy, setBusy] = useState(false);
  // After a decision lands, the same buttons would instantly mean a different step. Hold them briefly so one
  // physical double click can never decide two steps.
  const [settling, setSettling] = useState(false);
  // A ref, not state: two clicks in the same tick must not both pass the check.
  const inFlight = useRef(false);

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

  async function decide(decision: 'approve' | 'reject') {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      // 1. Authoritative state first. Never act on a copy the person may have been looking at for a while.
      const fresh = await client.getWorkflowRun(props.workspaceId, run.workflowExecutionId);
      if (!fresh.ok) {
        setNotice({ problem: fresh.problem });
        return;
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
        return;
      }
      // 2. Send the decision with the identifiers from that fresh record.
      const r = await client.resumeWorkflowRun(props.workspaceId, f.workflowExecutionId, {
        decision,
        expectedStepExecutionId: f.currentStepExecutionId!,
        expectedRevision: f.revision,
      });
      if (r.ok) {
        setRun(r.value);
        if (r.value.status !== 'waiting_for_human') props.onFinished?.(r.value);
        setSettling(true);
        setTimeout(() => setSettling(false), SETTLE_MS);
        props.onChanged();
        return;
      }
      // 3. Failure. Never resend. Re-read the truth and say what is known.
      const known = describeResumeProblem(r.problem);
      if (known !== undefined) {
        setNotice({ view: known });
        await refresh();
        props.onChanged();
      } else if (isAmbiguous(r.problem)) {
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
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

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
          <div className="row">
            <Button variant="primary" disabled={busy || settling} onClick={() => void decide('approve')}>
              Approve this step
            </Button>
            <Button variant="danger" disabled={busy || settling} onClick={() => void decide('reject')}>
              Reject and stop
            </Button>
          </div>
        </div>
      ) : null}
      {notice !== undefined && 'view' in notice ? (
        <div className="notice notice-warning" role="alert">
          <strong>{notice.view.title}</strong>
          <p>{notice.view.body}</p>
        </div>
      ) : null}
      {notice !== undefined && 'info' in notice ? (
        <p className="notice notice-warning" role="alert">
          {notice.info}
        </p>
      ) : null}
      {notice !== undefined && 'problem' in notice ? <ProblemNotice problem={notice.problem} /> : null}
      <RunSummary run={run} />
    </div>
  );
}
