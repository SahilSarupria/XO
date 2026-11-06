import { useState } from 'react';
import { can, whyNot } from '../domain/access';
import type { ApiProblem } from '../platform/client';
import type { WorkflowControls, WorkspaceRole } from '../platform/wire';
import { useGuardedAction } from './actions';
import { Button, formatWhen, ProblemNotice } from './primitives';
import { useSession } from './session';

/**
 * The kill switch. One calm line when all is well, a plain notice when everything is paused. Pausing asks first and says
 * exactly what stops; resuming is one click. The platform enforces it on every route that starts a run.
 */
export function WorkspacePause(props: {
  workspaceId: string;
  controls: WorkflowControls;
  role: WorkspaceRole | undefined;
  onChanged: () => void;
}) {
  const { client } = useSession();
  const { run, busy } = useGuardedAction();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const manage = can(props.role, 'manage');
  const c = props.controls;

  const change = (pause: boolean) =>
    void run(async () => {
      setProblem(undefined);
      const r = pause ? await client.pauseEverything(props.workspaceId, reason) : await client.resumeEverything(props.workspaceId);
      if (!r.ok) setProblem(r.problem);
      else {
        setAsking(false);
        setReason('');
        props.onChanged();
      }
    });

  if (c.paused) {
    return (
      <div className="wpause wpause-on" role="status">
        <div>
          <strong>Everything is paused.</strong> Nothing can start, by hand, by a webhook or schedule, or from a saved draft.
          {c.reason !== undefined ? ` Reason: ${c.reason}.` : ''}
          {c.pausedAt !== undefined ? ` Paused ${formatWhen(c.pausedAt)}.` : ''} Runs already waiting for a person can still be decided.
        </div>
        <Button
          variant="primary"
          disabled={busy || !manage}
          onClick={() => change(false)}
          title={manage ? undefined : whyNot(props.role, 'manage', 'resuming everything')}
        >
          Resume everything
        </Button>
        {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
      </div>
    );
  }

  return (
    <div className="wpause">
      {asking ? (
        <div className="wm-confirm" role="alertdialog" aria-labelledby="wpause-h" aria-describedby="wpause-d">
          <strong id="wpause-h">Pause everything?</strong>
          <p id="wpause-d">
            Nothing in this workspace will be able to start until you resume: not by hand, not by a webhook or schedule, and not from a
            saved draft. Runs that are already waiting for a person can still be decided. You can resume at any time.
          </p>
          <label>
            <span className="wm-lab">Why? (optional)</span>
            <input
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              placeholder="For example: checking a bad batch"
            />
          </label>
          <div className="wm-row">
            <Button variant="danger" disabled={busy} onClick={() => change(true)}>
              Pause everything
            </Button>
            <Button variant="quiet" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
          {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
        </div>
      ) : (
        <p className="wpause-line">
          <span className="wpause-dot" aria-hidden="true" /> Everything is running normally.{' '}
          <button
            type="button"
            className="wpause-link"
            disabled={!manage}
            title={manage ? undefined : whyNot(props.role, 'manage', 'pausing everything')}
            onClick={() => setAsking(true)}
          >
            Pause everything
          </button>
        </p>
      )}
    </div>
  );
}
