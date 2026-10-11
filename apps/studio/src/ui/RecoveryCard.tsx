import { useEffect, useRef, useState } from 'react';
import { currentStep, describeRecoveryProblem, tidyName, type WorkProblemView } from '../domain/work';
import type { ApiProblem } from '../platform/client';
import type { WorkflowRun } from '../platform/wire';
import { Button, ProblemNotice } from './primitives';
import { RunSummary, runTitle } from './RunCard';
import { useSession } from './session';

const SETTLE_MS = 700;
type Notice = { readonly view: WorkProblemView } | { readonly problem: ApiProblem };

/**
 * Continue an interrupted process. This is the platform's own resume operation (no decision, only the
 * revision), not a new run: the same process, the same earlier steps, the interrupted step run again as a
 * new attempt. Studio reads the run first, only continues one that is still interrupted, sends the revision
 * it just read, and never resends after a conflict or an unclear failure.
 */
export function RecoveryCard(props: {
  workspaceId: string;
  run: WorkflowRun;
  onChanged: () => void;
  /** Said outside the card, because a run that changes state leaves this list and would take the message with it. */
  onInfo: (message: string) => void;
}) {
  const { client } = useSession();
  const [run, setRun] = useState(props.run);
  const [notice, setNotice] = useState<Notice | undefined>();
  const [busy, setBusy] = useState(false);
  const [settling, setSettling] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (props.run.revision > run.revision) setRun(props.run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.run]);

  const step = currentStep(run);
  const interrupted = run.status === 'interrupted';

  async function refresh(): Promise<WorkflowRun | undefined> {
    const r = await client.getWorkflowRun(props.workspaceId, run.workflowExecutionId);
    if (r.ok) {
      setRun(r.value);
      return r.value;
    }
    setNotice({ problem: r.problem });
    return undefined;
  }

  async function recover() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const fresh = await client.getWorkflowRun(props.workspaceId, run.workflowExecutionId);
      if (!fresh.ok) {
        setNotice({ problem: fresh.problem });
        return;
      }
      const f = fresh.value;
      setRun(f);
      if (f.status !== 'interrupted') {
        props.onInfo('A process was no longer interrupted, so nothing was continued. Its current state is shown in Tasks.');
        props.onChanged();
        return;
      }
      const r = await client.recoverWorkflowRun(props.workspaceId, f.workflowExecutionId, { expectedRevision: f.revision });
      if (r.ok) {
        setRun(r.value);
        setSettling(true);
        setTimeout(() => setSettling(false), SETTLE_MS);
        props.onChanged();
        return;
      }
      const known = describeRecoveryProblem(r.problem);
      if (known !== undefined) {
        setNotice({ view: known });
        await refresh();
        props.onChanged();
      } else if (r.problem.kind === 'network' || r.problem.kind === 'server' || r.problem.kind === 'malformed') {
        const after = await refresh();
        props.onInfo(
          after !== undefined && after.revision !== f.revision
            ? 'XO did not confirm the request to continue, but its records show the process has since moved on. Check its steps before doing anything else.'
            : 'XO did not confirm the request to continue. Nothing was resent. Its latest records are shown; continue again only if the process is still interrupted.',
        );
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
      {interrupted ? (
        <div className="decision">
          <p>
            <strong>
              Interrupted
              {step !== undefined
                ? ` at step ${(run.currentStepIndex ?? 0) + 1} of ${run.steps.length}: ${tidyName(step.capabilityName)}`
                : ''}
            </strong>
          </p>
          <p className="muted small">
            The service stopped while this was running. Continuing keeps the steps already finished and runs the interrupted step again as a
            new attempt; the earlier attempt stays on record. XO cannot tell whether that step had any effect outside XO before it stopped,
            so check first if it does.
          </p>
          <div className="row">
            <Button variant="primary" disabled={busy || settling} onClick={() => void recover()}>
              {busy ? 'Continuing…' : 'Continue this process'}
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
      {notice !== undefined && 'problem' in notice ? <ProblemNotice problem={notice.problem} /> : null}
      <RunSummary run={run} />
    </div>
  );
}
