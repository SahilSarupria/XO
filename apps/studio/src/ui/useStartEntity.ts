import { useRef, useState } from 'react';
import { isAmbiguousFailure, newIdempotencyKey } from '../domain/work';
import type { ItemSourceView } from '../platform/wire-control';
import { useGuardedAction, type ActionNotice } from './actions';
import { useSession } from './session';
import { chooseItemSource } from './useStartWorkflow';

/**
 * S1-5: starting a workflow through its own route (`POST /workflow-entities/{id}/runs`). The platform recomputes the workflow's
 * certificate (every gate) and starts only when it is READY. Work that sends or changes things starts from a batch a reviewer
 * approved, so a start that needs one prepares the preview instead (nothing is sent). Browser-side guards only reduce accidental
 * duplicates; the platform's run lease and request key do the real work.
 */
export function useStartEntity(args: { workspaceId: string; workflowId: string; definitionId: string; onChanged: () => void }) {
  const { client } = useSession();
  const [notice, setNotice] = useState<ActionNotice | undefined>();
  const [pending, setPending] = useState<{ certificateId: string; sources: readonly ItemSourceView[] } | undefined>();
  const { run: guard, busy: inFlight, settling } = useGuardedAction();
  const intentKey = useRef<string | undefined>(undefined);
  const busy = inFlight || settling;

  async function prepare(certificateId: string, source: ItemSourceView | undefined) {
    const p = await client.prepareBatchPreview(
      args.workspaceId,
      args.definitionId,
      certificateId,
      {},
      source !== undefined ? { connectionId: source.connectionId, proposalId: source.proposalId } : undefined,
    );
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
          : `Nothing was sent yet. XO prepared a preview of exactly what this would do (${p.value.total} ${p.value.total === 1 ? 'item' : 'items'}${exceptions > 0 ? `, ${exceptions} needing attention` : ''}${p.value.itemsSource !== undefined ? `, from ${p.value.itemsSource.label} in ${p.value.itemsSource.connectionName}${p.value.itemsSource.excludedRows > 0 ? `; ${p.value.itemsSource.excludedRows} left out` : ''}` : ''}). A reviewer approves it in the Inbox, and it starts from there.`,
    });
  }

  function chooseSource(source: ItemSourceView) {
    const chosen = pending;
    if (chosen === undefined) return;
    void guard(async () => {
      setNotice(undefined);
      setPending(undefined);
      await prepare(chosen.certificateId, source);
    });
  }

  function start() {
    void guard(async () => {
      setNotice(undefined);
      intentKey.current ??= newIdempotencyKey();
      const cert = await client.certifyWorkflowEntity(args.workspaceId, args.workflowId);
      if (!cert.ok) {
        intentKey.current = undefined;
        setNotice({ problem: cert.problem });
        return undefined;
      }
      if (cert.value.status !== 'READY' && cert.value.status !== 'READY_WITH_CONDITIONS') {
        intentKey.current = undefined;
        const reasons = [...cert.value.blockers, ...cert.value.reviewItems].slice(0, 3);
        setNotice({
          info: `This workflow is not ready to start (${cert.value.status.replace(/_/g, ' ').toLowerCase()}).${reasons.length > 0 ? ` ${reasons.join(' ')}` : ''} Open "Check before starting" for the full list.`,
        });
        return undefined;
      }
      const r = await client.startWorkflowEntityRun(args.workspaceId, args.workflowId, {}, intentKey.current);
      if (r.ok) {
        intentKey.current = undefined;
        args.onChanged();
        setNotice({
          info:
            r.value.pendingApprovals.length > 0
              ? `Started. It is waiting for a person: ${r.value.pendingApprovals[0]!.summary}`
              : 'Started. Progress shows below and in Activity.',
        });
        return { settle: true };
      }
      if (r.problem.code === 'XO_BATCH_APPROVAL_REQUIRED') {
        intentKey.current = undefined;
        const sources = await client.itemSources(args.workspaceId, args.definitionId);
        if (!sources.ok) {
          setNotice({ problem: sources.problem });
          return undefined;
        }
        const choice = chooseItemSource(sources.value);
        if (choice.kind === 'none' || choice.kind === 'several') {
          setNotice({ info: choice.message });
          if (choice.kind === 'several')
            setPending({ certificateId: cert.value.certificateId, sources: sources.value.sources.filter((x) => x.usable) });
          return undefined;
        }
        await prepare(cert.value.certificateId, choice.kind === 'one' ? choice.source : undefined);
        return undefined;
      }
      if (isAmbiguousFailure(r.problem)) {
        args.onChanged();
        setNotice({
          info: 'XO did not confirm whether this started. Look in Activity before starting again; a retry carries the same request key, so XO hands back the original run if the first attempt did arrive.',
        });
      } else {
        intentKey.current = undefined;
        setNotice({ problem: r.problem });
      }
      return undefined;
    });
  }

  return { start, busy, notice, choices: pending?.sources, chooseSource, cancelChoice: () => setPending(undefined) };
}
