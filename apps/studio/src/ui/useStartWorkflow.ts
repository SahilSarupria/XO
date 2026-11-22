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
      let r = await client.startWorkflow(args.workspaceId, w.workflowId, w.compilationId, intentKey.current);
      if (!r.ok && r.problem.code === 'XO_READINESS_CERTIFICATE_REQUIRED') {
        // The workspace requires proof before a start. Ask the platform for this workflow's certificate (it recomputes
        // every gate) and start with it only when it is READY; otherwise say what stands in the way. Nothing was created.
        const cert = await client.certifyWorkflow(args.workspaceId, w.compilationId, w.workflowId, w.name);
        if (!cert.ok) {
          intentKey.current = undefined;
          setNotice({ problem: cert.problem });
          return;
        }
        if (cert.value.status !== 'READY' && cert.value.status !== 'READY_WITH_CONDITIONS') {
          intentKey.current = undefined;
          const reasons = [...cert.value.blockers, ...cert.value.reviewItems].slice(0, 3);
          setNotice({
            info: `This process is not ready to start (${cert.value.status.replace(/_/g, ' ').toLowerCase()}).${reasons.length > 0 ? ` ${reasons.join(' ')}` : ''} Open its readiness check for the full list.`,
          });
          return;
        }
        r = await client.startWorkflow(args.workspaceId, w.workflowId, w.compilationId, intentKey.current, cert.value.certificateId);
        const definitionId = cert.value.scope.definitionId;
        if (!r.ok && r.problem.code === 'XO_WORKFLOW_REQUIRES_IR_RUNTIME' && definitionId !== undefined) {
          // ADR 0031: this workflow acts on other systems, waits, branches or repeats, which only the workflow runtime does.
          // It starts there, under the same certificate; its progress and its approvals are in the pre-start check panel.
          const ir = await client.startGeneratedRun(args.workspaceId, definitionId, cert.value.certificateId, {}, intentKey.current);
          if (ir.ok) {
            intentKey.current = undefined;
            args.onChanged();
            setNotice({
              info:
                ir.value.pendingApprovals.length > 0
                  ? `Started on the workflow runtime. It is waiting for a person: ${ir.value.pendingApprovals[0]!.summary}`
                  : `Started on the workflow runtime (${ir.value.state}).`,
            });
          } else if (ir.problem.code === 'XO_BATCH_APPROVAL_REQUIRED') {
            // UW-8/UW-12b: in production, work that sends or changes things starts only from a batch a reviewer approved. Prepare
            // the preview now (nothing is sent); it waits in the Inbox for a reviewer, and starts from there once approved.
            intentKey.current = undefined;
            const p = await client.prepareBatchPreview(args.workspaceId, definitionId, cert.value.certificateId);
            if (!p.ok) {
              setNotice({ problem: p.problem });
              return;
            }
            args.onChanged();
            const exceptions = p.value.counts.stops + p.value.counts.not_exact;
            setNotice({
              info:
                p.value.counts.not_exact > 0
                  ? `XO prepared a preview of ${p.value.total} items, but ${p.value.counts.not_exact} cannot be shown exactly, so it cannot be approved as a batch. Nothing was sent.`
                  : `Nothing was sent yet. XO prepared a preview of exactly what this would do (${p.value.total} ${p.value.total === 1 ? 'item' : 'items'}${exceptions > 0 ? `, ${exceptions} needing attention` : ''}). A reviewer approves it in the Inbox, and it starts from there.`,
            });
          } else {
            intentKey.current = undefined;
            setNotice({ problem: ir.problem });
          }
          return;
        }
      }
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
