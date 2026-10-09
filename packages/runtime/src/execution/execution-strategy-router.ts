import { err, ok, type Result } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import type { CapabilityExecutionMode } from '@xo/types';

/**
 * R4: the generalized execution-strategy router.
 *
 * This is deliberately a *routing* generalization, not a *taxonomy*
 * widening — `ExecutionStrategyName` mirrors `CapabilityExecutionMode`
 * (`@xo/types`'s `xo-capability.ts`) exactly, member for member; keeping
 * these two in sync is a manual convention (as it already was for R4),
 * not a compiler-enforced one — `execution-strategy-router.test.ts`
 * exists in part to catch drift here the same way it already does for
 * R4's two-member set. This router does
 * not execute anything itself: `CapabilityExecutor` (the `'model'`
 * strategy), `RuntimeCapabilityExecutor` (the `'deterministic_rule'`
 * strategy), and — as of R5 — `HybridExecutionExecutor` (the `'hybrid'`
 * strategy) remain the sole executors, unmodified and uncalled from
 * here. `resolve()` only answers "which registered strategy does this
 * mode name, if any" — so that `ExecutionPipeline`'s R1/R4 dispatch
 * point becomes a lookup against an explicit, independently-testable
 * registration list instead of an inline `if/else` whose implicit `else`
 * branch would treat *every* unrecognized value as `'model'`.
 *
 * `undefined` (an absent `execution` field on `CapabilityDeclaration`, true
 * of every `.xo` package compiled before R1) resolves to `'model'` — the
 * exact R1-established default, unchanged.
 *
 * `'hybrid'` (R5) is a *third*, independently-executed strategy, not a
 * variant of `'model'` or `'deterministic_rule'` — resolving it is the
 * full extent of this router's involvement in R5; sequencing a hybrid
 * capability's steps is `HybridExecutionExecutor`'s job entirely (see
 * `hybrid/hybrid-execution-executor.ts`), invoked from
 * `ExecutionPipeline`'s existing single dispatch point, never from here.
 *
 * `'human_in_the_loop'` (Human-in-the-Loop Execution Class Lowering
 * milestone) is a *fourth*, registered strategy — not a new executor,
 * but the same `RuntimeCapabilityExecutor` `'deterministic_rule'`
 * already uses: `@xo/runtime`'s capability-authority registration path
 * (`capability-binding-registration.ts`) already registers a
 * `human_in_the_loop` binding's `evaluate` identically to a
 * `deterministic_rule` one's, per that file's own doc comment ("same
 * wrapping, same confidence/permission enforcement at execution time —
 * the only difference is what `evaluate` itself returns"). This router
 * resolving `'human_in_the_loop'` to a registered strategy is therefore
 * exactly as far as this file's responsibility goes — see
 * `ExecutionPipeline`'s dispatch point for where that strategy name maps
 * to the (unchanged) `RuntimeCapabilityExecutor` call.
 *
 * Any mode string outside `REGISTERED_STRATEGIES` — unreachable today via
 * the closed `CapabilityExecutionMode` union from ordinary
 * TypeScript-checked code, but exactly the shape a future widened union
 * (`workflow`, `external_tool` — explicitly out of scope here, same as
 * they were for R4/R5) would produce for an older runtime binary that
 * doesn't yet know how to run it — resolves to an explicit failure
 * carrying `RUNTIME_UNSUPPORTED_EXECUTION_MODE`, never a silent default
 * to `'model'`. This generalizes the same fail-closed reasoning R1
 * already applies to "known mode, missing executor"
 * (`RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED`) to "mode not known at
 * all".
 */
export type ExecutionStrategyName = 'deterministic_rule' | 'model' | 'hybrid' | 'human_in_the_loop';

const REGISTERED_STRATEGIES: ReadonlySet<ExecutionStrategyName> = new Set<ExecutionStrategyName>(['deterministic_rule', 'model', 'hybrid', 'human_in_the_loop']);

export class ExecutionStrategyRouter {
  /**
   * Resolves a capability's declared `execution.mode` (or `undefined`, for
   * a capability with no `execution` field at all) to one of the
   * strategies this runtime currently has an executor for. Never throws;
   * an unrecognized mode is a `Result` failure, not an exception, matching
   * every other gate in `ExecutionPipeline.prepare()`.
   */
  resolve(mode: CapabilityExecutionMode | undefined): Result<ExecutionStrategyName, RuntimeError> {
    if (mode === undefined) return ok('model');
    if (REGISTERED_STRATEGIES.has(mode as ExecutionStrategyName)) return ok(mode as ExecutionStrategyName);

    return err(
      new RuntimeError(
        ErrorCode.RUNTIME_UNSUPPORTED_EXECUTION_MODE,
        `Capability execution mode "${String(mode)}" is not a strategy this runtime's ExecutionStrategyRouter has registered (known: ${[...REGISTERED_STRATEGIES].join(', ')}) — refusing to default to the model path for an unrecognized strategy`,
      ),
    );
  }
}
