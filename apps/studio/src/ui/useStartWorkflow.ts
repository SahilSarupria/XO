import { useMemo, useRef, useState } from 'react';
import {
  describeStartProblem,
  findActiveRun,
  isAmbiguousFailure,
  newIdempotencyKey,
  startReadiness,
  type StartReadiness,
} from '../domain/work';
import type { Capability, Workflow, WorkflowRun } from '../platform/wire';
import { useGuardedAction, type ActionNotice } from './actions';
import { useSession } from './session';

/**
 * Starting a process, guarded in the browser only: the platform is asked for an existing active run immediately before a
 * start is sent, the control is locked while the request is in flight, and after an unclear failure the platform's state
 * is re-read. That reduces accidental duplicates. It does NOT guarantee exactly-once: two tabs, two people or a retry
 * outside Studio can still create two runs. Shared by the Workflows list and the workflow graph so both behave the same.
 */
export function useStartWorkflow(args: {
  workspaceId: string;
  workflow: Workflow;
  caps: readonly Capability[] | undefined;
  runs: readonly WorkflowRun[];
  onChanged: () => void;
  goToTasks: () => void;
  goToActivity: () => void;
}): {
  start: () => void;
  busy: boolean;
  notice: ActionNotice | undefined;
  ready: StartReadiness;
  active: WorkflowRun | undefined;
} {
  const { client } = useSession();
  const w = args.workflow;
  const [notice, setNotice] = useState<ActionNotice | undefined>();
  const { run: guard, busy } = useGuardedAction();
  // One key per start INTENT. It is reused only to retry after an unclear failure, so the platform can hand back
  // the original run instead of creating a second; it is dropped as soon as the outcome is known.
  const intentKey = useRef<string | undefined>(undefined);
  const active = findActiveRun(args.runs, w.workflowId, w.compilationId);
  const ready = useMemo(() => startReadiness(w, args.caps), [w, args.caps]);

  function start() {
    void guard(async () => {
      setNotice(undefined);
      // Re-read the platform's runs right before starting; the list on screen may be stale.
      const before = await client.listWorkflowRuns(args.workspaceId);
      if (!before.ok) {
        setNotice({ problem: before.problem });
        return;
      }
      const existing = findActiveRun(before.value, w.workflowId, w.compilationId);
      if (existing !== undefined) {
        setNotice({ info: 'This process is already in progress, so a second one was not started. You can continue it instead.' });
        args.onChanged();
        return;
      }
      intentKey.current ??= newIdempotencyKey();
      const r = await client.startWorkflow(args.workspaceId, w.workflowId, w.compilationId, intentKey.current);
      if (r.ok) {
        intentKey.current = undefined;
        args.onChanged();
        if (r.value.status === 'waiting_for_human') args.goToTasks();
        else args.goToActivity();
        return;
      }
      const known = describeStartProblem(r.problem, w);
      if (known !== undefined) {
        intentKey.current = undefined; // a definite refusal: nothing was created, the next start is a new intent
        setNotice({ view: known });
        args.onChanged();
      } else if (isAmbiguousFailure(r.problem)) {
        // The request may or may not have reached the platform. Ask it, rather than guessing or resending.
        const after = await client.listWorkflowRuns(args.workspaceId);
        const found = after.ok ? findActiveRun(after.value, w.workflowId, w.compilationId) : undefined;
        args.onChanged();
        setNotice({
          info: !after.ok
            ? 'XO did not confirm whether this started, and Studio could not check. Look in Activity before starting again.'
            : found !== undefined
              ? 'The process did start. XO’s records show it in progress.'
              : 'XO did not confirm whether this started. Studio checked and found no run yet. You can try again: the retry carries the same request key, so XO will hand back the original run if the first attempt did arrive instead of creating a second.',
        });
      } else {
        setNotice({ problem: r.problem });
      }
    });
  }

  return { start, busy, notice, ready, active };
}
