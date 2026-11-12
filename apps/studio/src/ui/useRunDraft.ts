import { useRef, useState } from 'react';
import { isAmbiguousFailure } from '../domain/work';
import type { ApiProblem } from '../platform/client';
import type { WorkflowRun } from '../platform/wire';
import { useSession } from './session';
import type { DraftController } from './useWorkflowDraft';

export interface RunDraftState {
  readonly busy: boolean;
  readonly problem: ApiProblem | undefined;
  /** A retry could not be confirmed either way; Activity shows whether the run exists. */
  readonly unconfirmed: boolean;
  readonly started: WorkflowRun | undefined;
  readonly run: (input: Record<string, unknown>) => Promise<void>;
  readonly dismiss: () => void;
}

/**
 * Starts the SAVED draft at its current revision. The platform decides everything: it re-analyses the draft (501 with
 * the reasons when it cannot run), applies the same approval gate and input checks as any run (403/400), and answers a
 * stale revision with 409. Every refusal is shown as the platform worded it. An idempotency key makes a retry after an
 * unknown outcome return the original run instead of starting a second one.
 */
export function useRunDraft(draft: DraftController, workspaceId: string, onChanged: () => void): RunDraftState {
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [started, setStarted] = useState<WorkflowRun | undefined>();
  const key = useRef<string | undefined>(undefined);
  return {
    busy,
    problem,
    unconfirmed,
    started,
    dismiss: () => {
      setProblem(undefined);
      setStarted(undefined);
      setUnconfirmed(false);
    },
    run: async (input) => {
      if (draft.definitionId === undefined || busy) return;
      setBusy(true);
      setProblem(undefined);
      setStarted(undefined);
      key.current ??= crypto.randomUUID();
      const r = await client.runDraft(workspaceId, draft.definitionId, { input, expectedRevision: draft.revision }, key.current);
      setBusy(false);
      if (r.ok) {
        key.current = undefined;
        setUnconfirmed(false);
        setStarted(r.value);
        onChanged();
        return;
      }
      setProblem(r.problem);
      if (isAmbiguousFailure(r.problem)) setUnconfirmed(true);
      else {
        key.current = undefined;
        setUnconfirmed(false);
      }
    },
  };
}
