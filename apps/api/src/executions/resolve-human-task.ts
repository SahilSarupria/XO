import type { NotFoundError, XoError } from '@xo/errors';
import type { CompilationStore } from '../compilations/compilation.js';
import type { ExecutionRecord, ExecutionStore, HumanTaskDecision } from './execution.js';
import { withExecutionLock } from './execution-lock.js';
import { attemptResume } from './resume-human-task.js';

/**
 * The single implementation of "resolve one human task" — extracted
 * verbatim from `routes/human-task-routes.ts`'s `resolveHumanTask`
 * handler (P0.7) so that P0.8's `POST .../workflow-executions/:id/resume`
 * reuses the EXACT SAME lock + pre-check + `attemptResume` +
 * `ExecutionStore.resolveHumanTask` sequence rather than re-implementing
 * it. Behavior-preserving: `human-task-routes.ts` now delegates here and
 * its existing tests (`human-task-routes.test.ts`,
 * `human-task-resume.test.ts`) are the regression net.
 *
 * Serialized per `executionId` via `withExecutionLock` — see
 * `execution-lock.ts` for exactly what that does and does not guarantee.
 */
export type ResolveHumanTaskOutcome =
  | { readonly kind: 'not_found'; readonly error: NotFoundError }
  | { readonly kind: 'not_a_human_task' }
  | { readonly kind: 'already_resolved'; readonly record: ExecutionRecord }
  | { readonly kind: 'error'; readonly error: XoError }
  | { readonly kind: 'resolved'; readonly record: ExecutionRecord };

export async function resolveHumanTaskExecution(
  executionStore: ExecutionStore,
  compilationStore: CompilationStore,
  executionId: string,
  decision: HumanTaskDecision,
  data: Readonly<Record<string, unknown>> | undefined,
  resolverIdentityId: string,
): Promise<ResolveHumanTaskOutcome> {
  return withExecutionLock(executionId, async (): Promise<ResolveHumanTaskOutcome> => {
    const preCheck = await executionStore.get(executionId);
    if (!preCheck.ok) return { kind: 'not_found', error: preCheck.error };
    if (preCheck.value.humanTask === undefined) return { kind: 'not_a_human_task' };
    if (preCheck.value.humanTask.status === 'resolved') return { kind: 'already_resolved', record: preCheck.value };

    // "Invoke the existing runtime resume mechanism" — re-derives the
    // contract/binding from the PERSISTED compiled graph (never the
    // client, never a fresh recompile) and genuinely re-checks authorization.
    const resumeOutcome = await attemptResume(compilationStore, preCheck.value.compilationId, preCheck.value.capabilityId, preCheck.value.input, decision, data);

    const resolved = await executionStore.resolveHumanTask(executionId, {
      decision,
      ...(data !== undefined ? { decisionData: data } : {}),
      resolverIdentityId,
      resumeOutcome,
    });
    if (!resolved.ok) return { kind: 'error', error: resolved.error };
    if ('kind' in resolved.value) {
      // Someone else resolved it inside this same lock window between
      // our preCheck and the store call — vanishingly unlikely given
      // the lock, but handled honestly rather than assumed impossible.
      return resolved.value.kind === 'already_resolved' ? { kind: 'already_resolved', record: resolved.value.record } : { kind: 'not_a_human_task' };
    }
    return { kind: 'resolved', record: resolved.value };
  });
}
