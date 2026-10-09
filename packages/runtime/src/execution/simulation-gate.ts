import type { ModelProvider, ProviderRequest, ProviderResponse, ProviderStreamEvent } from '@xo/ai-core';
import type { HybridExecutionStep } from '@xo/types';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { CapabilityExecutor } from '../ai/capability-executor.js';

/**
 * R6 simulation semantics — see the R6 pre-implementation design's §5
 * for the full contract. Summary, restated here because it is
 * load-bearing for everything in this file:
 *
 *   - `'model'` IS simulatable: the provider call is skipped entirely
 *     and replaced with an explicit, clearly-marked placeholder — never
 *     a fabricated model answer. {@link buildSimulatedProviderResponse}
 *     is the one place that placeholder is constructed.
 *   - `'deterministic_rule'` is NOT simulatable in this R6 pass: there
 *     is no authoritative signal on `RuntimeCapabilityDeclaration`/
 *     `CapabilityBinding` saying a given handler is free of side
 *     effects, so simulation refuses outright rather than either
 *     fabricating output or risking a real call. (A future,
 *     explicitly-approved `simulationSafe` declaration field could
 *     relax this — R6 deliberately does not add it; see the delivery
 *     report.)
 *   - `'hybrid'` is simulatable only when every declared step is
 *     `'model'` — the instant any step is `'deterministic_rule'`, the
 *     whole hybrid invocation refuses, before any step (including an
 *     earlier, otherwise-safe `'model'` step) runs.
 */

const SIMULATED_MARKER_TEXT = '[simulated execution: provider call skipped, no live model call was made]';

/** Never calls a live provider — the marker text is fixed and clearly non-fabricated (it never resembles a genuine model answer). */
export function buildSimulatedProviderResponse(request: ProviderRequest): ProviderResponse {
  return { text: SIMULATED_MARKER_TEXT, usage: { inputTokens: 0, outputTokens: 0 }, modelUsed: request.model, finishReason: 'stop' };
}

/**
 * A `ModelProvider` that must never actually be called — passed to
 * `CapabilityExecutor`'s constructor only because that constructor
 * requires one; `SimulatingCapabilityExecutor` overrides every method
 * that would reach it, so `complete`/`completeStream` throwing here is
 * a deliberate tripwire (an actual live call during simulation is a
 * bug, not a degraded mode) rather than something a caller could ever
 * observe in a passing test.
 */
const unreachableProvider: ModelProvider = {
  id: 'xo-runtime-simulation-unreachable-provider',
  describeCapabilities: () => ({ providerId: 'xo-runtime-simulation-unreachable-provider', models: [], supportsStreaming: false, supportsStructuredOutput: false, supportsVision: false, maxContextTokens: 0 }),
  complete: () => {
    throw new Error('SimulatingCapabilityExecutor: a live provider call was attempted during simulation — this is a bug, simulation must never reach a real ModelProvider');
  },
};

/**
 * Drop-in replacement for the real `CapabilityExecutor` used only when
 * `ExecutionRequest.simulate === true` and the strategy being run is
 * `'model'` (directly, or as a hybrid step — see
 * `checkHybridSimulationSafety`). Never touches `unreachableProvider`.
 */
export class SimulatingCapabilityExecutor extends CapabilityExecutor {
  constructor() {
    super(unreachableProvider);
  }

  override async execute(request: ProviderRequest): Promise<Result<ProviderResponse, RuntimeError>> {
    return ok(buildSimulatedProviderResponse(request));
  }

  override async *stream(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent, void, void> {
    const response = buildSimulatedProviderResponse(request);
    yield { type: 'text_delta', delta: response.text };
    yield { type: 'done', usage: response.usage, finishReason: response.finishReason };
  }
}

/**
 * Pre-flight check for a hybrid invocation requested under
 * `simulate: true`. Refuses the *whole* invocation before any step runs
 * if even one declared step is `'deterministic_rule'` — this is a
 * decision made purely from the capability's own static declaration
 * (`execution.hybridSteps`), never from runtime telemetry, so it can
 * run safely before `HybridExecutionExecutor.execute` is ever invoked.
 */
export function checkHybridSimulationSafety(steps: readonly HybridExecutionStep[]): Result<void, RuntimeError> {
  const unsafeStep = steps.find((step) => step.strategy !== 'model');
  if (unsafeStep) {
    return err(
      new RuntimeError(
        ErrorCode.RUNTIME_SIMULATION_UNSUPPORTED_FOR_STRATEGY,
        `Simulation was requested for a hybrid capability containing step "${unsafeStep.stepId}" (strategy "${unsafeStep.strategy}") — only hybrid capabilities whose every step is "model" can be simulated; refusing before any step runs rather than partially simulating or guessing at a deterministic step's output`,
      ),
    );
  }
  return ok(undefined);
}

/** Builds the standard refusal for a `'deterministic_rule'` capability requested under `simulate: true`. Always fails closed — see this file's top doc comment. */
export function deterministicSimulationRefusal(capabilityId: string): RuntimeError {
  return new RuntimeError(
    ErrorCode.RUNTIME_SIMULATION_UNSUPPORTED_FOR_STRATEGY,
    `Simulation was requested for capability "${capabilityId}", whose execution.mode is "deterministic_rule" — this runtime has no authoritative signal that any deterministic_rule handler is free of side effects, so simulation refuses rather than either calling the live handler or fabricating an output`,
  );
}

/**
 * Builds the standard refusal for a `'human_in_the_loop'` capability
 * requested under `simulate: true`. Same fail-closed posture as
 * {@link deterministicSimulationRefusal} and for the same underlying
 * reason — this file's top doc comment's rule for `'deterministic_rule'`
 * applies identically here, since a `human_in_the_loop` binding's
 * `evaluate` is registered and executed through the exact same
 * `RuntimeCapabilityExecutor` path (see `capability-binding-registration.ts`).
 * A distinct function (rather than reusing the other one with a
 * different string) so the error text never claims a capability declared
 * `human_in_the_loop` when its actual declared mode was
 * `deterministic_rule`, or vice versa.
 */
export function humanInTheLoopSimulationRefusal(capabilityId: string): RuntimeError {
  return new RuntimeError(
    ErrorCode.RUNTIME_SIMULATION_UNSUPPORTED_FOR_STRATEGY,
    `Simulation was requested for capability "${capabilityId}", whose execution.mode is "human_in_the_loop" — this runtime has no authoritative signal that any human_in_the_loop handler is free of side effects, so simulation refuses rather than either calling the live handler or fabricating an output`,
  );
}
