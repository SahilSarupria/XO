import { useEffect, useState } from 'react';
import { currentStep, describeRecoveryProblem, isAmbiguousFailure, tidyName } from '../domain/work';
import type { WorkflowRun } from '../platform/wire';
import { ActionNoticeView, Confirmation, useGuardedAction, type ActionNotice } from './actions';
import { Button } from './primitives';
import { RunSummary, runTitle } from './RunCard';
import { useSession } from './session';

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
  const [notice, setNotice] = useState<ActionNotice | undefined>();
  const [confirmed, setConfirmed] = useState<string | undefined>();
  const { run: guard, busy, settling } = useGuardedAction();

  useEffect(() => {
    if (props.run.revision > run.revision) setRun(props.run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.run]);

  const step = currentStep(run);

  async function refresh(): Promise<WorkflowRun | undefined> {
    const r = await client.getWorkflowRun(props.workspaceId, run.workflowExecutionId);
    if (r.ok) {
      setRun(r.value);
      return r.value;
    }
    setNotice({ problem: r.problem });
    return undefined;
  }

  function recover() {
    void guard(async () => {
      setNotice(undefined);
      setConfirmed(undefined);
      const fresh = await client.getWorkflowRun(props.workspaceId, run.workflowExecutionId);
      if (!fresh.ok) {
        setNotice({ problem: fresh.problem });
        return undefined;
      }
      const f = fresh.value;
      setRun(f);
      if (f.status !== 'interrupted') {
        props.onInfo('A process was no longer interrupted, so nothing was continued. Its current state is shown in Tasks.');
        props.onChanged();
        return undefined;
      }
      const r = await client.recoverWorkflowRun(props.workspaceId, f.workflowExecutionId, { expectedRevision: f.revision });
      if (r.ok) {
        setRun(r.value);
        setConfirmed('Process continued.');
        props.onChanged();
        return { settle: true };
      }
      const known = describeRecoveryProblem(r.problem);
      if (known !== undefined) {
        setNotice({ view: known });
        await refresh();
        props.onChanged();
      } else if (isAmbiguousFailure(r.problem)) {
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
      return undefined;
    });
  }

  return (
    <div className="card-main">
      <h3>{runTitle(run)}</h3>
      {run.status === 'interrupted' ? (
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
            <Button variant="primary" pending={busy || settling} onClick={recover}>
              {busy ? 'Continuing…' : 'Continue this process'}
            </Button>
          </div>
        </div>
      ) : null}
      <Confirmation message={confirmed} />
      <ActionNoticeView notice={notice} />
      <RunSummary run={run} />
    </div>
  );
}
