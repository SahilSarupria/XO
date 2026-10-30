import type { CapabilityLayer, ExecuteResult, XoExecutor } from '@xo/capability-layer';
import { PermanentError, type WorkflowDefinition, type WorkflowOutcome } from './engine.js';
import type { Trigger, TriggerEvent } from './triggers.js';

export interface XoWorkflowOptions {
  readonly id: string;
  readonly triggers: readonly Trigger[];
  readonly executor: XoExecutor;
  /** Pulls the free text and (optional) structured facts out of a trigger payload. Throw {@link PermanentError} if the payload is unusable. */
  readonly parse: (payload: unknown) => { readonly text: string; readonly facts?: Record<string, unknown>; readonly caseId?: string };
  /** Maps the executor's output to an outbox lane and disposition. */
  readonly route: (output: Record<string, unknown>) => { readonly lane: string; readonly disposition: WorkflowOutcome['disposition'] };
  readonly maxAttempts?: number;
  readonly maxRunsPerMinute?: number;
}

/**
 * Wraps an {@link XoExecutor} as an unattended workflow: router-first (cache →
 * local decision tree → model), safety gate on every output, and — crucially —
 * *fail-closed to a human*: if the executor cannot produce a valid, gated
 * output (no route, model error, budget exhausted, unparseable reply) the case
 * is handed to a person via the `needs-review` lane instead of guessing.
 */
export function xoWorkflow(o: XoWorkflowOptions): WorkflowDefinition {
  return {
    id: o.id,
    triggers: o.triggers,
    ...(o.maxAttempts !== undefined ? { maxAttempts: o.maxAttempts } : {}),
    ...(o.maxRunsPerMinute !== undefined ? { maxRunsPerMinute: o.maxRunsPerMinute } : {}),
    run: async (event: TriggerEvent): Promise<WorkflowOutcome> => {
      const { text, facts, caseId } = o.parse(event.payload);
      const r: ExecuteResult = await o.executor.execute({ text, ...(facts !== undefined ? { facts } : {}) });
      const meta = {
        caseId: caseId ?? null,
        path: r.path,
        modelCalls: r.modelCalls,
        tokens: r.usage,
        overridden: r.overridden,
        safety: r.safety?.violations ?? [],
        ruleTrace: r.ruleTrace,
      };
      if (r.output === null || r.error !== undefined) {
        if (r.error !== undefined && /budget|no deterministic route/.test(r.error)) {
          return {
            lane: 'needs-review',
            disposition: 'needs_human',
            summary: `no automated route: ${r.error}`,
            output: { ...meta, error: r.error, input: text },
          };
        }
        // transient-looking failures (provider error) are retried by the engine
        if (r.error !== undefined && r.path === 'model' && r.output === null) throw new Error(r.error);
        throw new PermanentError(r.error ?? 'executor produced no output');
      }
      const routed = o.route(r.output);
      return {
        lane: routed.lane,
        disposition: routed.disposition,
        summary: `${String(r.output['decision'] ?? 'result')} via ${r.path}${r.overridden ? ' (safety override)' : ''}`,
        output: { ...meta, result: r.output },
      };
    },
  };
}

export type { CapabilityLayer };
